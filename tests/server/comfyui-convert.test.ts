// Turning a workflow saved from ComfyUI's editor into what /prompt takes, the way ComfyUI's own frontend does: V3
// nodes' dotted inputs, the newer files' named values, subgraphs flattened, bypassed nodes passed through by type.
import { describe, expect, it } from 'vitest';
import { findPromptNodes, uiToApi } from '../../server/comfyui.ts';
import type { ObjectInfo, UiWorkflow } from '../../server/comfyui.ts';

const INFO: ObjectInfo = {
  CheckpointLoaderSimple: { input: { required: { ckpt_name: [['sdxl.safetensors'], {}] } } },
  CLIPTextEncode: { input: { required: { text: ['STRING', { multiline: true, dynamicPrompts: true }], clip: ['CLIP', {}] } } },
  KSampler: {
    input: {
      required: {
        model: ['MODEL', {}],
        seed: ['INT', { control_after_generate: true }],
        steps: ['INT', {}],
        cfg: ['FLOAT', {}],
        sampler_name: [['euler', 'dpmpp_2m'], {}],
        scheduler: [['normal', 'karras'], {}],
        positive: ['CONDITIONING', {}],
        negative: ['CONDITIONING', {}],
        latent_image: ['LATENT', {}],
        denoise: ['FLOAT', {}],
      },
    },
    input_order: { required: ['model', 'seed', 'steps', 'cfg', 'sampler_name', 'scheduler', 'positive', 'negative', 'latent_image', 'denoise'] },
  },
  // as ComfyUI 0.44 lists it (comfy_extras/nodes_post_processing.py), cut to two of its options
  ResizeImageMaskNode: {
    input: {
      required: {
        input: ['COMFY_MATCHTYPE_V3', {}],
        resize_type: [
          'COMFY_DYNAMICCOMBO_V3',
          {
            options: [
              { key: 'scale dimensions', inputs: { required: { width: ['INT', { default: 512 }], height: ['INT', { default: 512 }], crop: ['COMBO', { options: ['disabled', 'center'] }] } } },
              { key: 'scale by multiplier', inputs: { required: { multiplier: ['FLOAT', { default: 1 }] } } },
            ],
          },
        ],
        scale_method: ['COMBO', { options: ['nearest-exact', 'bilinear', 'area', 'lanczos'] }],
      },
    },
    input_order: { required: ['input', 'resize_type', 'scale_method'] },
  },
  ComfyMathExpression: { input: { required: { expression: ['STRING', {}], values: ['COMFY_AUTOGROW_V3', {}] } } },
  ImageScaleBy: { input: { required: { image: ['IMAGE', {}], upscale_method: [['nearest-exact', 'lanczos'], {}], scale_by: ['FLOAT', {}] } } },
  SaveImage: { input: { required: { images: ['IMAGE', {}], filename_prefix: ['STRING', {}] } } },
  LoadImage: { input: { required: { image: [['photo.png'], { image_upload: true }] } } },
  RandomPick: { input: { required: { mode: [['a', 'b'], { control_after_generate: true }], strength: ['FLOAT', {}] } } },
  OldStyle: { input: { required: { seed_in: ['INT', { forceInput: true }], steps: ['INT', {}] } } },
};
const wf = (w: Partial<UiWorkflow>): UiWorkflow => ({ nodes: [], links: [], ...w });

describe('converting editor files', () => {
  it("reads V3 nodes' dotted inputs from the saved order, and their links over them", () => {
    // ResizeImageMaskNode as saved in ComfyUI's own Video Stitch blueprint: width and height linked
    const { api, warnings } = uiToApi(
      wf({
        nodes: [
          { id: 2, type: 'LoadImage', inputs: [], widgets_values: ['photo.png', 'image'] },
          { id: 5, type: 'PrimitiveNode', widgets_values: [768, 'fixed'] },
          {
            id: 97,
            type: 'ResizeImageMaskNode',
            inputs: [
              { name: 'input', type: 'IMAGE,MASK', link: 1 },
              { name: 'resize_type', type: 'COMFY_DYNAMICCOMBO_V3', widget: { name: 'resize_type' }, link: null },
              { name: 'resize_type.width', type: 'INT', widget: { name: 'resize_type.width' }, link: 2 },
              { name: 'resize_type.height', type: 'INT', widget: { name: 'resize_type.height' }, link: null },
              { name: 'resize_type.crop', type: 'COMBO', widget: { name: 'resize_type.crop' }, link: null },
              { name: 'scale_method', type: 'COMBO', widget: { name: 'scale_method' }, link: null },
            ],
            widgets_values: ['scale dimensions', 512, 512, 'center', 'area'],
          },
        ],
        links: [
          [1, 2, 0, 97, 0, 'IMAGE'],
          [2, 5, 0, 97, 2, 'INT'],
        ],
      }),
      INFO,
    );
    expect(warnings).toEqual([]);
    expect(api['97'].inputs).toEqual({ input: ['2', 0], resize_type: 'scale dimensions', 'resize_type.width': 768, 'resize_type.height': 512, 'resize_type.crop': 'center', scale_method: 'area' });
    expect(api['2'].inputs).toEqual({ image: 'photo.png' });
  });

  it('uses the named values newer files carry, and sends no control widgets', () => {
    const { api } = uiToApi(
      wf({
        nodes: [
          {
            id: 9,
            type: 'ResizeImageMaskNode',
            widgets_values: ['scale by multiplier', 1.5, 'lanczos'],
            widgets_values_named: { resize_type: 'scale by multiplier', 'resize_type.multiplier': 1.5, scale_method: 'lanczos', control_after_generate: 'fixed' },
          },
          { id: 3, type: 'KSampler', widgets_values_named: { seed: 7, control_after_generate: 'randomize', steps: 30, cfg: 5, sampler_name: 'euler', scheduler: 'karras', denoise: 1 } },
        ],
      }),
      INFO,
    );
    expect(api['9'].inputs).toEqual({ resize_type: 'scale by multiplier', 'resize_type.multiplier': 1.5, scale_method: 'lanczos' });
    expect(api['3'].inputs).toEqual({ seed: 7, steps: 30, cfg: 5, sampler_name: 'euler', scheduler: 'karras', denoise: 1 });
  });

  it("skips a seed's control value, a dropdown's two, and an old file's placeholder for a socket", () => {
    const { api } = uiToApi(
      wf({
        nodes: [
          { id: 3, type: 'KSampler', widgets_values: [42, 'randomize', 20, 7, 'dpmpp_2m', 'karras', 0.6] },
          { id: 4, type: 'RandomPick', widgets_values: ['b', 'increment', '', 0.3] },
          { id: 6, type: 'OldStyle', widgets_values: [0, 12] },
          { id: 7, type: 'ComfyMathExpression', inputs: [{ name: 'values.a', type: '*', link: 3 }], widgets_values: ['a * 2'] },
          { id: 8, type: 'OldStyle', widgets_values: [12] },
        ],
        links: [[3, 3, 0, 7, 0, 'INT']],
      }),
      INFO,
    );
    expect(api['3'].inputs).toEqual({ seed: 42, steps: 20, cfg: 7, sampler_name: 'dpmpp_2m', scheduler: 'karras', denoise: 0.6 });
    expect(api['4'].inputs).toEqual({ mode: 'b', strength: 0.3 });
    expect(api['6'].inputs).toEqual({ steps: 12 });
    expect(api['8'].inputs).toEqual({ steps: 12 });
    // an Autogrow input exists only as a socket, under its dotted name
    expect(api['7'].inputs).toEqual({ expression: 'a * 2', 'values.a': ['3', 0] });
  });

  it('passes a bypassed node by the type of what it gives, and drops what a muted one gave', () => {
    const { api } = uiToApi(
      wf({
        nodes: [
          { id: 1, type: 'LoadImage', widgets_values: ['photo.png', 'image'] },
          { id: 5, type: 'ImageScaleBy', mode: 4, inputs: [{ name: 'image', type: 'IMAGE', link: 10 }], outputs: [{ type: 'IMAGE' }], widgets_values: ['lanczos', 2] },
          { id: 6, type: 'SaveImage', inputs: [{ name: 'images', type: 'IMAGE', link: 11 }], widgets_values: ['out'] },
          { id: 7, type: 'ImageScaleBy', mode: 2, inputs: [{ name: 'image', type: 'IMAGE', link: null }], widgets_values: ['lanczos', 2] },
          { id: 8, type: 'SaveImage', inputs: [{ name: 'images', type: 'IMAGE', link: 12 }], widgets_values: ['muted'] },
        ],
        links: [
          [10, 1, 0, 5, 0, 'IMAGE'],
          [11, 5, 0, 6, 0, 'IMAGE'],
          [12, 7, 0, 8, 0, 'IMAGE'],
        ],
      }),
      INFO,
    );
    expect(Object.keys(api).sort()).toEqual(['1', '6', '8']);
    expect(api['6'].inputs.images).toEqual(['1', 0]);
    expect(api['8'].inputs).toEqual({ filename_prefix: 'muted' });
  });

  it('flattens a subgraph, naming its nodes "<instance>:<id>", with the values the instance promotes', () => {
    const SUB = '6f0a4cd2-4c4e-4b8e-9d0b-0f6a1c2b3d4e';
    const file = (instanceValues?: unknown[]) =>
      wf({
        nodes: [
          { id: 4, type: 'CheckpointLoaderSimple', widgets_values: ['sdxl.safetensors'] },
          { id: 10, type: SUB, inputs: [{ name: 'clip', type: 'CLIP', link: 1 }, { name: 'text', type: 'STRING', widget: { name: 'text' }, link: null }], outputs: [{ name: 'CONDITIONING', type: 'CONDITIONING' }], widgets_values: instanceValues },
          { id: 3, type: 'KSampler', inputs: [{ name: 'model', type: 'MODEL', link: 3 }, { name: 'positive', type: 'CONDITIONING', link: 2 }], widgets_values: [1, 'fixed', 20, 7, 'euler', 'normal', 1] },
        ],
        links: [
          [1, 4, 1, 10, 0, 'CLIP'],
          [2, 10, 0, 3, 1, 'CONDITIONING'],
          [3, 4, 0, 3, 0, 'MODEL'],
        ],
        definitions: {
          subgraphs: [
            {
              id: SUB,
              inputs: [{ name: 'clip', type: 'CLIP' }, { name: 'text', type: 'STRING' }],
              outputs: [{ name: 'CONDITIONING', type: 'CONDITIONING' }],
              nodes: [{ id: 1, type: 'CLIPTextEncode', inputs: [{ name: 'clip', type: 'CLIP', link: 11 }, { name: 'text', type: 'STRING', widget: { name: 'text' }, link: 12 }], widgets_values: ['a cat'] }],
              links: [
                { id: 11, origin_id: -10, origin_slot: 0, target_id: 1, target_slot: 0, type: 'CLIP' },
                { id: 12, origin_id: -10, origin_slot: 1, target_id: 1, target_slot: 1, type: 'STRING' },
                { id: 13, origin_id: 1, origin_slot: 0, target_id: -20, target_slot: 0, type: 'CONDITIONING' },
              ],
            },
          ],
        },
      });
    const { api, warnings } = uiToApi(file(['a lighthouse']), INFO);
    expect(warnings).toEqual([]);
    expect(api['10:1']).toMatchObject({ class_type: 'CLIPTextEncode', inputs: { clip: ['4', 1], text: 'a lighthouse' } });
    expect(api['3'].inputs.positive).toEqual(['10:1', 0]);
    expect(api['10']).toBeUndefined();
    expect(findPromptNodes(api).promptInputs).toEqual(['10:1.text']);
    // without a value of its own, the instance leaves the inner widget's
    expect(uiToApi(file(), INFO).api['10:1'].inputs.text).toBe('a cat');
  });

  it("says plainly what it can't convert", () => {
    const { api, warnings } = uiToApi(
      wf({
        nodes: [
          { id: 1, type: 'workflow>My group', widgets_values: [] },
          { id: 2, type: '0f6a1c2b-3d4e-4b8e-9d0b-6f0a4cd24c4e', widgets_values: [] },
          { id: 3, type: 'SomeCustomNode', widgets_values: [] },
          { id: 4, type: 'SaveImage', inputs: [{ name: 'images', type: 'IMAGE', link: 1 }], widgets_values: ['x'] },
        ],
        links: [[1, 3, 0, 4, 0, 'IMAGE']],
      }),
      INFO,
    );
    expect(warnings).toEqual([
      expect.stringMatching(/^Node 1 \(workflow>My group\) is an old-style group node/),
      expect.stringMatching(/^Node 2 is a subgraph whose definition isn't in the file/),
      'Node 3 (SomeCustomNode) is not known to this ComfyUI.',
    ]);
    // nothing links to a node that isn't sent
    expect(api['4'].inputs).toEqual({ filename_prefix: 'x' });
  });
});
