# Workflow files, and changing one safely

Checked against ComfyUI 0.44 and its current frontend (November 2026).

## Two formats

| | Editor format | API format |
|---|---|---|
| Made by | File › Save in ComfyUI (the files in `user/default/workflows`), and the `workflow` text inside PNGs ComfyUI saves | File › Export (API), and the `prompt` text inside those PNGs |
| Shape | `nodes` and `links` lists, plus `groups`, `definitions.subgraphs` and `models` | An object keyed by node id; each node has `class_type` and `inputs`, maybe `_meta.title` |
| Settings | `widgets_values`, a list in widget order (or an object, for some custom nodes) | Named: `"steps": 30` |
| Runs as is | No: it has to be converted using the server's node list | Yes: it's what `POST /prompt` takes |

The dashboard converts editor files itself when describing or running them, the way ComfyUI's editor does: values
by name in files saved since July 2026 (`widgets_values_named`), else in widget order; the dotted inputs below;
subgraphs, whose inner nodes become `<instance id>:<inner id>` (`"12:5"`, nested `"12:7:3"`); bypassed nodes passed
through by type. It can't convert old-style group nodes (named `workflow>...`) or a subgraph whose definition is
missing, and says so; nodes whose widgets come from a node pack's own JavaScript may come out wrong. The editor picks
one option from `{a|b}` choices in a prompt before sending it; the dashboard sends the text as it is. When the
conversion warns, export from ComfyUI itself, or try comfy-cli's converter: `comfy run --workflow wf.json
--print-prompt` prints the API form without running it (it needs a reachable ComfyUI). To read an editor file, the nodes' `properties` are worth a look: `cnr_id` and `ver` name the node pack and
version that made each node (`comfy-core` is ComfyUI itself), `aux_id` a GitHub repo, and `models` the files a
template expects, each with `name`, `url` and `directory`.

An API file holds only nodes. A top-level key that isn't a node (a `_comment`, notes, metadata) makes `/prompt`
reject the whole thing, so keep notes elsewhere. A saved `/prompt` request body (`{"prompt": {...}, "client_id": ...}`)
is not a workflow file either: its `prompt` is.

## Links and values

```json
"3": {
  "class_type": "KSampler",
  "inputs": {
    "seed": 815, "steps": 28, "cfg": 5.5, "sampler_name": "dpmpp_2m", "scheduler": "karras", "denoise": 1.0,
    "model": ["4", 0], "positive": ["6", 0], "negative": ["7", 0], "latent_image": ["5", 0]
  }
}
```

`["4", 0]` is a link: output 0 of node 4. Outputs count from 0 in the order the node lists them (a Load Checkpoint's
are MODEL, CLIP, VAE, so its VAE is `["4", 2]`). A link is wiring: replacing it with a plain value disconnects the
node, and pointing it at the wrong slot gives `return_type_mismatch`. To rewire, link to another node's output of the
same type. Everything else (numbers, text, dropdown choices) is a value you can change, within the limits
`/object_info` gives for that input (`min`, `max`, the dropdown's list).

## Finding the parts that matter

- **Prompts**: start at the sampler and follow links back. `KSampler` takes `positive` and `negative`;
  `SamplerCustomAdvanced` takes a `guider`, which is a `CFGGuider` (with `positive` and `negative`) or a `BasicGuider`
  (one `conditioning`, as in some Flux workflows). Conditioning can pass through helper nodes (Flux guidance,
  ControlNet apply, zero-out) before reaching the text node. The text sits in `text` on `CLIPTextEncode`, in `text_g`
  and `text_l` on `CLIPTextEncodeSDXL`, in `clip_l` and `t5xxl` on `CLIPTextEncodeFlux`. If the text input is itself
  linked to a string node (`PrimitiveStringMultiline` and similar), change that node's `value` instead. Titles such as
  "Positive prompt" are whatever someone typed, and are wrong often enough not to go by.
- **Seed**: `seed` on `KSampler`, `noise_seed` on `KSamplerAdvanced` and on `RandomNoise` (which feeds
  `SamplerCustomAdvanced`).
- **Size and count**: `width`, `height` and `batch_size` on the empty-latent node (`EmptyLatentImage`,
  `EmptySD3LatentImage` and the video ones, which also have `length`). In image-to-image, the size comes from the input
  picture instead.
- **How much changes**: `denoise` on the sampler (or the scheduler node). At 1.0 the sampler starts from pure noise;
  lower values keep more of the input latent, which is what image to image wants.
- **Inputs**: `LoadImage.image`, `LoadImageMask.image` and `channel`, `LoadVideo.file`, `LoadAudio.audio` name a file
  in ComfyUI's input folder (`subfolder/name` when it's in a subfolder). The run tool's `images` sends a file and sets
  that input; `scripts/comfy_upload.py` prints the value to set by hand.

## Dynamic inputs keep dotted names

Newer nodes grow inputs as you use them, and their API keys carry a dot: a math node's values are `values.a`,
`values.b`; a resize node's mode-specific settings are `resize_type.width`, `resize_type.height`, `resize_type.crop`.
Those strings are the real keys. Keep them as they are, never nested (`{"values": {"a": ...}}`) or cut down to
`width`. In the dashboard's run settings they become `"12.resize_type.width": 1024`. An editor file saves a dynamic
dropdown's value followed by the chosen option's settings (`["scale dimensions", 512, 512, "center", "area"]`), so a
different option means different keys: after changing `resize_type`, set the keys of the new option too.

## Nodes that exist only in the editor

- **Reroute** passes a link through to tidy the canvas. The server has no such node: in API form, whatever linked to
  the Reroute links straight to its source instead (with the source's own slot number).
- **PrimitiveNode** holds a value for the inputs it's wired to; in API form the value is written into those inputs.
- **Note** and **MarkdownNote** are comments and are dropped.
- **Muted** nodes (`mode` 2) and **bypassed** ones (`mode` 4, which pass their input through) don't run and aren't
  part of the API form. In a template, a branch for something the task doesn't use (an image input on a text-to-video
  run, say) is better bypassed than deleted: the rest of the graph may still expect it.
- **Subgraphs** appear as nodes whose `type` is an id from `definitions.subgraphs`; their inside nodes are listed
  there.

## When ComfyUI rejects a workflow

`POST /prompt` checks the whole graph before anything runs. A rejection looks like this:

```json
{
  "error": {"type": "prompt_outputs_failed_validation", "message": "Prompt outputs failed validation", "details": "..."},
  "node_errors": {
    "12": {
      "class_type": "ResizeImageMaskNode",
      "dependent_outputs": ["9"],
      "errors": [{"type": "required_input_missing", "message": "Required input is missing",
                  "details": "resize_type.width", "extra_info": {"input_name": "resize_type.width"}}]
    }
  }
}
```

The server is the authority on what it accepts: `extra_info.input_name` is the exact key it wants, dots and all. Fix
the named node and submit again, one round at a time; regenerating the workflow brings back the same mistakes and new
ones. The usual types:

| `type` | Meaning | Fix |
|---|---|---|
| `missing_node_type` | A class this ComfyUI doesn't have (comes back as `error`, with empty `node_errors`) | A custom node pack to install, or a newer ComfyUI: run the check |
| `value_not_in_list` | A dropdown value the server doesn't offer: usually a model file or a sampler name | Install the model, or pick from the server's list (`near_matches` in the check) |
| `required_input_missing` | An input with neither value nor link | Add it under the key in `input_name` |
| `return_type_mismatch` | A link from an output of the wrong type | Point it at the right output slot |
| `value_smaller_than_min`, `value_bigger_than_max` | Outside the input's range | Bring it into range |
| `invalid_input_type` | A value that can't be turned into the input's type (text where a number goes) | Fix the value |
| `prompt_no_outputs` | Nothing saves or previews a result | Keep (or add) a Save Image or similar node |

When only some outputs fail, ComfyUI runs the others and still answers 200, listing the failures in `node_errors`.
The dashboard's run tool lists those under "Left out by ComfyUI".

Errors while running come later, in the job's history (`references/api.md`): the failing node's id and type, the
exception and its traceback. ComfyUI adds its own hint to out-of-memory errors.

## Masks

What a mask means depends on the node that reads it:

- **Load Image's MASK output** comes from the picture's transparency: transparent pixels are the area to repaint
  (the node gives 1 where alpha is 0). ComfyUI's own inpainting example works this way, and so does its mask editor.
- **Load Image (as Mask)** with `channel` set to `red`, `green` or `blue` reads that channel of a black-and-white
  picture: white is the area to repaint. With `alpha`, it behaves like Load Image's MASK.
- **VAE Encode (for Inpainting)** fills the masked area with flat grey before encoding and treats the mask as on or
  off (values are rounded). The sampler's `denoise` stays at 1.0 with it: at anything lower the sampler starts from
  that grey, and some of it stays in the picture. Its `grow_mask_by` (default 6 pixels) widens the area the sampler may
  change beyond the grey, which blends the edge.
- **InpaintModelConditioning** (what the Flux inpainting templates use) hands an inpainting model the greyed picture
  and the mask beside the original, and its latent is the original's, so a lower `denoise` keeps more of what was
  there. **Set Latent Noise Mask** also keeps the original under the mask, suits smaller changes at lower `denoise`
  with any model, and keeps soft edges.
- `/upload/mask` (used by the run tool's `mask`, and `scripts/comfy_upload.py --mask-onto`) writes a copy of an
  uploaded image with the mask as its transparency. The two pictures have to be the same size there.

Grey levels in a mask blend the new and the old where the node keeps them, which hides the seam.

## Saving a changed workflow

Write a copy under a new name next to the original, so the user's version stays, unless they ask for it to be
replaced. Keep the format you started from: an API file stays nodes only; an editor file can be reopened in ComfyUI.
