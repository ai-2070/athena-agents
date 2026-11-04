// Running a ComfyUI workflow against a fake ComfyUI: the prompt lands in the right node (never the
// negative over the prompt), a negative with nowhere to go is mentioned, and the seeds used are reported.
// (comfyui-run.test.ts has input pictures, left-out nodes and the SDXL, Flux and SD3 prompt inputs)
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { describeWorkflow, runWorkflow, saveApiWorkflow } from '../../server/comfyui.ts';
import type { ApiWorkflow } from '../../server/comfyui.ts';
import { saveSettings } from '../../server/store.ts';
import { callTool } from '../../server/tools.ts';
import type { ToolAgent } from '../../server/tools.ts';

const sent: ApiWorkflow[] = [];
let server: http.Server;
beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    res.setHeader('content-type', 'application/json');
    if (req.url === '/system_stats') return res.end(JSON.stringify({ devices: [] }));
    if (req.method === 'POST' && req.url === '/prompt') {
      sent.push((JSON.parse(body) as { prompt: ApiWorkflow }).prompt);
      return res.end(JSON.stringify({ prompt_id: `p${sent.length}` }));
    }
    const h = /^\/history\/(\w+)$/.exec(req.url || '');
    if (h) return res.end(JSON.stringify({ [h[1]]: { status: { completed: true }, outputs: { 9: { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] } } } }));
    res.end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  saveSettings({ comfyui: { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, workflowDirs: [] } });
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const text = (t: string) => ({ class_type: 'CLIPTextEncode', inputs: { text: t, clip: ['4', 1] } });
const sampler = (negative: [string, number], seed = 1) => ({ class_type: 'KSampler', inputs: { seed, steps: 20, model: ['4', 0], positive: ['6', 0], negative, latent_image: ['5', 0] } });

saveApiWorkflow('zero-out', { 3: sampler(['7', 0]), 6: text('a cat'), 7: { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['6', 0] } } });
saveApiWorkflow('same-node', { 3: sampler(['6', 0]), 6: text('a cat') });
saveApiWorkflow('plain', { 3: sampler(['8', 0], 42), 6: text('a cat'), 8: text('blurry') });
// a ControlNet apply node passes both sides on: the negative goes back along its own side
saveApiWorkflow('controlnet', {
  3: { class_type: 'KSampler', inputs: { seed: 1, positive: ['10', 0], negative: ['10', 1] } },
  6: text('a cat'),
  8: text('blurry'),
  10: { class_type: 'ControlNetApplyAdvanced', inputs: { positive: ['6', 0], negative: ['8', 0], control_net: ['11', 0], image: ['12', 0], strength: 1 } },
  20: { class_type: 'RandomNoise', inputs: { noise_seed: 5 } },
});

describe('which nodes hold the prompts', () => {
  it('a negative made with ConditioningZeroOut, or one that is the prompt node itself, is no negative node', async () => {
    expect((await describeWorkflow('zero-out')).prompts).toMatchObject({ positive: '6', negative: null, negativeInputs: [] });
    expect((await describeWorkflow('same-node')).prompts).toMatchObject({ positive: '6', negative: null, negativeInputs: [] });
    expect((await describeWorkflow('plain')).prompts).toMatchObject({ positive: '6', negative: '8', negativeInputs: ['8.text'] });
    expect((await describeWorkflow('controlnet')).prompts).toMatchObject({ positive: '6', negative: '8', negativeInputs: ['8.text'] });
  });
});

describe('running a workflow', () => {
  it("never writes the negative over the prompt, and says the negative wasn't used", async () => {
    const r = await runWorkflow({ workflow: 'zero-out', prompt: 'a dog', negative: 'ugly', randomizeSeed: false });
    expect(sent.at(-1)?.['6'].inputs.text).toBe('a dog');
    expect(r.warnings.join('\n')).toMatch(/no negative prompt to set/);
    // no negative given: nothing to say
    expect((await runWorkflow({ workflow: 'zero-out', prompt: 'a dog', randomizeSeed: false })).warnings).toEqual([]);
  });

  it('writes the negative where there is a negative node', async () => {
    const r = await runWorkflow({ workflow: 'controlnet', prompt: 'a dog', negative: 'ugly', randomizeSeed: false });
    expect(sent.at(-1)?.['6'].inputs.text).toBe('a dog');
    expect(sent.at(-1)?.['8'].inputs.text).toBe('ugly');
    expect(r.warnings).toEqual([]);
  });

  it('reports the seed each node used, as sent', async () => {
    const r = await runWorkflow({ workflow: 'controlnet', randomizeSeed: false });
    expect(r.seeds).toEqual([
      { node: '3', title: 'KSampler', input: 'seed', value: 1 },
      { node: '20', title: 'RandomNoise', input: 'noise_seed', value: 5 },
    ]);
    const random = await runWorkflow({ workflow: 'plain' });
    expect(random.seeds[0].value).toBe(sent.at(-1)?.['3'].inputs.seed);
  });

  it('comfyui_run puts the seeds and the unused negative in its result', async () => {
    const agent: ToolAgent = { id: 'comfy-agent', name: 'Artist', toolGroups: ['comfyui'], autonomy: 'auto', knowledge: { folders: [] } };
    const r = await callTool(agent, 'comfyui_run', { workflow: 'zero-out', prompt: 'a dog', negative: 'ugly', inputs: { '3.seed': 777 } });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('3.seed = 777 (KSampler)');
    expect(r.text).toContain('{"3.seed":777}');
    expect(r.text).toMatch(/no negative prompt to set .*so the negative text was not used/);
    expect(sent.at(-1)?.['6'].inputs.text).toBe('a dog');
  });
});
