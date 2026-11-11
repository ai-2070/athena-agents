// Running a ComfyUI workflow against a fake ComfyUI: input pictures and masks go up first and into the right Load Image
// node, nodes ComfyUI leaves out are reported, 3D files come back like the others, and prompts are found in SDXL, Flux
// and SD3 graphs.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { findPromptNodes, runWorkflow, saveApiWorkflow } from '../../server/comfyui.ts';
import type { ApiWorkflow, ComfyNodeError } from '../../server/comfyui.ts';
import { decodePng } from '../../server/png.ts';
import { saveSettings } from '../../server/store.ts';
import { callTool, riskOf } from '../../server/tools.ts';
import type { ToolAgent } from '../../server/tools.ts';

// ---------- a fake ComfyUI ----------
interface Upload {
  route: string;
  filename: string;
  fields: Record<string, string>;
  bytes: Buffer;
}
const uploads: Upload[] = [];
const prompts: { prompt: ApiWorkflow }[] = [];
let nodeErrors: Record<string, ComfyNodeError> = {};
let outputs: Record<string, unknown> = {};
// what ComfyUI calls an upload: it renames one rather than replace a different file of the same name
const renamed: Record<string, string> = { 'photo.png': 'photo (1).png' };

const OBJECT_INFO = {
  LoadImage: { input: { required: { image: [['example.png'], { image_upload: true }] } } },
  LoadImageMask: {
    input: {
      required: { image: [['example.png'], { image_upload: true }], channel: [['alpha', 'red', 'green', 'blue'], {}] },
    },
  },
  LoadImageOutput: { input: { required: { image: ['COMBO', { image_upload: true, image_folder: 'output' }] } } },
  LoadVideo: { input: { required: { file: [['clip.mp4'], { video_upload: true }] } } },
};

let server: http.Server;
let base = '';
beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const json = (v: unknown, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(v));
    };
    const route = new URL(req.url || '/', 'http://x').pathname;
    if (route === '/system_stats') return json({ system: {}, devices: [] });
    if (route === '/object_info') return json(OBJECT_INFO);
    if (route === '/upload/image' || route === '/upload/mask') {
      const form = await new Response(body, {
        headers: { 'content-type': String(req.headers['content-type']) },
      }).formData();
      const file = form.get('image');
      if (!file || typeof file === 'string') return json({ error: 'no image' }, 400);
      const fields: Record<string, string> = {};
      form.forEach((v, k) => {
        if (typeof v === 'string') fields[k] = v;
      });
      uploads.push({ route, filename: file.name, fields, bytes: Buffer.from(await file.arrayBuffer()) });
      return json({ name: renamed[file.name] || file.name, subfolder: fields.subfolder || '', type: 'input' });
    }
    if (route === '/prompt') {
      prompts.push(JSON.parse(body.toString()) as { prompt: ApiWorkflow });
      return json({ prompt_id: 'job-1', number: 1, node_errors: nodeErrors });
    }
    if (route === '/history/job-1')
      return json({ 'job-1': { status: { status_str: 'success', completed: true }, outputs } });
    if (route === '/queue') return json({ queue_running: [], queue_pending: [] });
    json({}, 404);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  saveSettings({ comfyui: { url: base } });
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  uploads.length = 0;
  prompts.length = 0;
  nodeErrors = {};
  outputs = { '9': { images: [{ filename: 'out_00001_.png', subfolder: '', type: 'output' }] } };
});

// ---------- workflows ----------
const node = (class_type: string, inputs: Record<string, unknown>) => ({ class_type, inputs });
const IMG2IMG: ApiWorkflow = {
  '4': node('CheckpointLoaderSimple', { ckpt_name: 'sdxl.safetensors' }),
  '6': node('CLIPTextEncode', { text: 'a cat', clip: ['4', 1] }),
  '7': node('CLIPTextEncode', { text: 'blurry', clip: ['4', 1] }),
  '10': node('LoadImage', { image: 'example.png' }),
  '11': node('VAEEncode', { pixels: ['10', 0], vae: ['4', 2] }),
  '3': node('KSampler', {
    seed: 1,
    steps: 20,
    model: ['4', 0],
    positive: ['6', 0],
    negative: ['7', 0],
    latent_image: ['11', 0],
  }),
  '8': node('VAEDecode', { samples: ['3', 0], vae: ['4', 2] }),
  '9': node('SaveImage', { images: ['8', 0], filename_prefix: 'out' }),
};
const WITH_MASK_NODE: ApiWorkflow = {
  ...IMG2IMG,
  '12': node('LoadImageMask', { image: 'example.png', channel: 'red' }),
};
saveApiWorkflow('img2img', IMG2IMG);
saveApiWorkflow('two-loaders', WITH_MASK_NODE);

const workspace = fs.mkdtempSync(path.join(os.homedir(), 'comfy-ws-'));
const agent: ToolAgent = {
  id: 'comfy-agent',
  name: 'Artist',
  toolGroups: ['comfyui'],
  autonomy: 'full',
  workspace,
  knowledge: { folders: [] },
};

// A grey PNG whose rows use each of the five PNG row filters in turn (CRCs left at 0: nothing here checks them).
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}
function greyPng(w: number, h: number, grey: number[]): Buffer {
  const rows: Buffer[] = [];
  for (let y = 0; y < h; y++) {
    const filter = y % 5;
    const cur = grey.slice(y * w, (y + 1) * w);
    const prev = y ? grey.slice((y - 1) * w, y * w) : new Array<number>(w).fill(0);
    const out = cur.map((x, i) => {
      const a = i ? cur[i - 1] : 0;
      const c = i ? prev[i - 1] : 0;
      return (x - [0, a, prev[i], (a + prev[i]) >> 1, paeth(a, prev[i], c)][filter]) & 255;
    });
    rows.push(Buffer.from([filter, ...out]));
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  const chunk = (kind: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(kind, 4, 'latin1');
    return Buffer.concat([head, data, Buffer.alloc(4)]);
  };
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const W = 6;
const H = 5;
const photo = greyPng(W, H, new Array<number>(W * H).fill(128));
const maskGrey = Array.from({ length: W * H }, (_, i) => (i % W >= 3 ? 255 : i % 2 ? 40 : 0));
fs.writeFileSync(path.join(workspace, 'photo.png'), photo);
fs.writeFileSync(path.join(workspace, 'mask.png'), greyPng(W, H, maskGrey));
fs.writeFileSync(path.join(workspace, 'black.png'), greyPng(W, H, new Array<number>(W * H).fill(0)));
fs.writeFileSync(path.join(workspace, 'small-mask.png'), greyPng(3, 3, new Array<number>(9).fill(255)));

describe('sending input pictures with a run', () => {
  it('uploads a picture into the one Load Image node, under the name ComfyUI gives it', async () => {
    const r = await callTool(agent, 'comfyui_run', { workflow: 'img2img', images: [{ file: 'photo.png' }] });
    expect(r.isError, r.text).toBe(false);
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toMatchObject({ route: '/upload/image', filename: 'photo.png', fields: { type: 'input' } });
    expect(uploads[0].bytes.equals(photo)).toBe(true);
    expect(prompts[0].prompt['10'].inputs.image).toBe('photo (1).png');
    expect(r.text).toContain('photo.png as "photo (1).png" into 10.image');
  });

  it("puts a black-and-white mask into the picture's transparency, on a copy named after it", async () => {
    const r = await callTool(agent, 'comfyui_run', {
      workflow: 'img2img',
      images: [{ file: 'photo.png', mask: 'mask.png' }],
    });
    expect(r.isError, r.text).toBe(false);
    expect(uploads.map((u) => u.route)).toEqual(['/upload/image', '/upload/mask']);
    const mask = uploads[1];
    expect(mask.filename).toBe('photo (1)-mask.png');
    expect(mask.fields.type).toBe('input');
    expect(JSON.parse(mask.fields.original_ref)).toEqual({ filename: 'photo (1).png', subfolder: '', type: 'input' });
    // white (repaint) is fully transparent; Load Image's MASK output is 1 there
    const px = decodePng(mask.bytes);
    expect([px.width, px.height]).toEqual([W, H]);
    expect([...px.alpha]).toEqual(maskGrey.map((g) => 255 - g));
    expect(prompts[0].prompt['10'].inputs.image).toBe('photo (1)-mask.png');
  });

  it('asks which node each picture is for when there are several loaders, and sends nothing until then', async () => {
    const r = await callTool(agent, 'comfyui_run', { workflow: 'two-loaders', images: [{ file: 'photo.png' }] });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/2 Load Image nodes: 10 \(LoadImage\), 12 \(LoadImageMask\)/);
    expect(uploads).toEqual([]);
    const ok = await callTool(agent, 'comfyui_run', {
      workflow: 'two-loaders',
      images: [
        { file: 'photo.png', node: '10' },
        { file: 'mask.png', node: '12' },
      ],
    });
    expect(ok.isError, ok.text).toBe(false);
    expect(prompts[0].prompt['10'].inputs.image).toBe('photo (1).png');
    expect(prompts[0].prompt['12'].inputs.image).toBe('mask.png');
  });

  it("won't send a file from outside the agent's folders, or a mask that's wrong", async () => {
    const outside = fs.mkdtempSync(path.join(os.homedir(), 'comfy-outside-'));
    fs.writeFileSync(path.join(outside, 'secret.png'), photo);
    const far = await callTool(agent, 'comfyui_run', {
      workflow: 'img2img',
      images: [{ file: path.join(outside, 'secret.png') }],
    });
    expect(far.isError).toBe(true);
    expect(far.text).toMatch(/outside the folders/);
    const nothing = await callTool(agent, 'comfyui_run', {
      workflow: 'img2img',
      images: [{ file: 'photo.png', mask: 'black.png' }],
    });
    expect(nothing.text).toMatch(/marks nothing to repaint/);
    const size = await callTool(agent, 'comfyui_run', {
      workflow: 'img2img',
      images: [{ file: 'photo.png', mask: 'small-mask.png' }],
    });
    expect(size.text).toMatch(/3x3 but the picture is 6x5/);
    expect(uploads).toEqual([]);
    expect(prompts).toEqual([]);
  });

  it('asks first before sending pictures to a ComfyUI on another computer', () => {
    const args = { workflow: 'img2img', images: [{ file: 'photo.png' }] };
    expect(riskOf('comfyui_run', { workflow: 'img2img' })).toBe('low');
    expect(riskOf('comfyui_run', args)).toBe('low');
    saveSettings({ comfyui: { url: 'http://192.168.1.20:8188' } });
    try {
      expect(riskOf('comfyui_run', args)).toBe('high');
      expect(riskOf('comfyui_run', { workflow: 'img2img' })).toBe('low');
    } finally {
      saveSettings({ comfyui: { url: base } });
    }
  });
});

describe('what a run reports back', () => {
  it('lists the nodes ComfyUI left out of a run it accepted', async () => {
    nodeErrors = {
      '12': {
        class_type: 'ResizeImageMaskNode',
        dependent_outputs: ['15'],
        errors: [
          {
            type: 'required_input_missing',
            message: 'Required input is missing',
            details: 'resize_type.width',
            extra_info: { input_name: 'resize_type.width' },
          },
        ],
      },
    };
    const r = await callTool(agent, 'comfyui_run', { workflow: 'img2img' });
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toContain('Left out by ComfyUI (the rest ran):');
    expect(r.text).toContain(
      'node 12 (ResizeImageMaskNode) failed ComfyUI\'s checks, so output node 15 didn\'t run: required_input_missing: Required input is missing (resize_type.width) [input "resize_type.width"]',
    );
    const done = await runWorkflow({ workflow: 'img2img' });
    expect(done.nodeErrors).toEqual(nodeErrors);
  });

  it('returns 3D files like the others', async () => {
    outputs = {
      '9': { images: [{ filename: 'out_00001_.png', subfolder: '', type: 'output' }] },
      '20': {
        '3d': [{ filename: 'mesh_00001_.glb', subfolder: '3d', type: 'output' }],
        camera_info: [null],
        model_3d_info: [],
      },
      '21': { result: ['3d/preview3d_ab.glb', null, null] },
      '22': { text: ['not a file'] },
    };
    const r = await runWorkflow({ workflow: 'img2img' });
    expect(r.files.map((f) => [f.kind, f.filename, f.subfolder, f.type])).toEqual([
      ['images', 'out_00001_.png', '', 'output'],
      ['3d', 'mesh_00001_.glb', '3d', 'output'],
      ['3d', 'preview3d_ab.glb', '3d', 'output'],
    ]);
    expect(r.files[1].url).toBe('/api/comfyui/view?filename=mesh_00001_.glb&subfolder=3d&type=output');
  });
});

describe('finding the prompts', () => {
  it('fills both text fields of an SDXL text node, and keeps the old single-text case', async () => {
    const sdxl: ApiWorkflow = {
      ...IMG2IMG,
      '6': node('CLIPTextEncodeSDXL', { text_g: 'a cat', text_l: 'a cat', width: 1024, height: 1024, clip: ['4', 1] }),
      '7': node('CLIPTextEncodeSDXL', {
        text_g: 'blurry',
        text_l: 'blurry',
        width: 1024,
        height: 1024,
        clip: ['4', 1],
      }),
    };
    expect(findPromptNodes(sdxl)).toEqual({
      positive: '6',
      negative: '7',
      promptInputs: ['6.text_g', '6.text_l'],
      negativeInputs: ['7.text_g', '7.text_l'],
    });
    expect(findPromptNodes(IMG2IMG)).toEqual({
      positive: '6',
      negative: '7',
      promptInputs: ['6.text'],
      negativeInputs: ['7.text'],
    });
    saveApiWorkflow('sdxl', sdxl);
    await runWorkflow({ workflow: 'sdxl', prompt: 'a lighthouse', negative: 'fog' });
    const sent = prompts[0].prompt;
    expect([
      sent['6'].inputs.text_g,
      sent['6'].inputs.text_l,
      sent['7'].inputs.text_g,
      sent['7'].inputs.text_l,
    ]).toEqual(['a lighthouse', 'a lighthouse', 'fog', 'fog']);
  });

  it("follows a Flux guider's one conditioning, with no negative to set", async () => {
    const flux: ApiWorkflow = {
      '11': node('DualCLIPLoader', { clip_name1: 't5.safetensors', clip_name2: 'clip_l.safetensors', type: 'flux' }),
      '6': node('CLIPTextEncodeFlux', { clip_l: 'a cat', t5xxl: 'a cat', guidance: 3.5, clip: ['11', 0] }),
      '26': node('FluxGuidance', { guidance: 3.5, conditioning: ['6', 0] }),
      '22': node('BasicGuider', { model: ['12', 0], conditioning: ['26', 0] }),
      '12': node('UNETLoader', { unet_name: 'flux1-dev.safetensors', weight_dtype: 'default' }),
      '25': node('RandomNoise', { noise_seed: 5 }),
      '13': node('SamplerCustomAdvanced', {
        noise: ['25', 0],
        guider: ['22', 0],
        sampler: ['16', 0],
        sigmas: ['17', 0],
        latent_image: ['5', 0],
      }),
      '9': node('SaveImage', { images: ['8', 0], filename_prefix: 'flux' }),
    };
    expect(findPromptNodes(flux)).toEqual({
      positive: '6',
      negative: null,
      promptInputs: ['6.clip_l', '6.t5xxl'],
      negativeInputs: [],
    });
    saveApiWorkflow('flux', flux);
    const r = await runWorkflow({ workflow: 'flux', prompt: 'a lighthouse', negative: 'fog' });
    expect([prompts[0].prompt['6'].inputs.clip_l, prompts[0].prompt['6'].inputs.t5xxl]).toEqual([
      'a lighthouse',
      'a lighthouse',
    ]);
    expect(r.warnings.join(' ')).toMatch(/no negative prompt/);
  });

  it('never takes the prompt for the negative when the negative is the prompt zeroed out', () => {
    const zeroed: ApiWorkflow = {
      '6': node('CLIPTextEncode', { text: 'a cat', clip: ['4', 1] }),
      '35': node('FluxGuidance', { guidance: 3.5, conditioning: ['6', 0] }),
      '33': node('ConditioningZeroOut', { conditioning: ['6', 0] }),
      '3': node('KSampler', {
        seed: 1,
        positive: ['35', 0],
        negative: ['33', 0],
        model: ['4', 0],
        latent_image: ['5', 0],
      }),
    };
    expect(findPromptNodes(zeroed)).toEqual({
      positive: '6',
      negative: null,
      promptInputs: ['6.text'],
      negativeInputs: [],
    });
  });

  it("follows SD3's three text fields, a ControlNet in between, and a prompt held in a string node", () => {
    const sd3: ApiWorkflow = {
      '20': node('PrimitiveStringMultiline', { value: 'a cat' }),
      '6': node('CLIPTextEncodeSD3', {
        clip_l: ['20', 0],
        clip_g: ['20', 0],
        t5xxl: ['20', 0],
        empty_padding: 'none',
        clip: ['4', 1],
      }),
      '7': node('CLIPTextEncode', { text: 'blurry', clip: ['4', 1] }),
      '14': node('ControlNetApplyAdvanced', {
        positive: ['6', 0],
        negative: ['7', 0],
        control_net: ['15', 0],
        image: ['16', 0],
        strength: 0.8,
        start_percent: 0,
        end_percent: 1,
      }),
      '17': node('CFGGuider', { model: ['4', 0], positive: ['14', 0], negative: ['14', 1], cfg: 4 }),
      '13': node('SamplerCustomAdvanced', {
        noise: ['25', 0],
        guider: ['17', 0],
        sampler: ['16', 0],
        sigmas: ['18', 0],
        latent_image: ['5', 0],
      }),
    };
    expect(findPromptNodes(sd3)).toEqual({
      positive: '6',
      negative: '7',
      promptInputs: ['20.value'],
      negativeInputs: ['7.text'],
    });
  });
});
