# A first inpaint, step by step: a new sky

For a user who asks how to repaint part of a photo in ComfyUI: a new sky, a removed object, a changed shirt. The steps
run from free to costly (what's installed, then a built-in template, then downloads, each asked for with its size), and
hand-wiring comes last. The user can click every step; where the agent reaches ComfyUI, it can check, upload and run
for them. Checked in November 2026 against ComfyUI 0.44, its frontend 1.57 and templates 0.11.101. Templates come and
go with updates, so search the browser rather than trust a name from here.

## 1. What's there already (free)

- The status tool shows the graphics card and its memory. A model much bigger than that memory runs slowly or stops
  with an out-of-memory error: weigh that before a large download.
- Installed models: the lists on the Load Checkpoint and Load Diffusion Model nodes, or `GET /models/checkpoints` and
  `GET /models/diffusion_models`. A file with "inpaint" or "fill" in its name is likely an inpainting model already,
  which may save a download: ask the user what it is before building on it.

## 2. A built-in template (free to open)

The Templates button in ComfyUI's left sidebar opens the template browser; search for "inpaint". Templates marked
"Partner API" run on paid services and spend Comfy credits, so they're the user's call; the rest run on this computer.
Opening a template costs nothing, and ComfyUI then lists the model files it lacks, with their sizes ("Missing models"
in `references/setup-and-deps.md`). For photos, start from **Flux.1 Inpaint**:

| File | Folder under `models` | Size |
|---|---|---|
| `flux1-fill-dev.safetensors` | `diffusion_models` | 23.8 GB |
| `t5xxl_fp16.safetensors` | `text_encoders` | 9.8 GB |
| `clip_l.safetensors` | `text_encoders` | 0.25 GB |
| `ae.safetensors` | `vae` | 0.34 GB |

About 34 GB in all, as Hugging Face counts; Windows shows each file a little smaller. `t5xxl_fp8_e4m3fn.safetensors`
(4.9 GB, from huggingface.co/comfyanonymous/flux_text_encoders, where the template's own text encoders come from) can
stand in for the 9.8 GB one: download it instead and pick it in the template node's `clip_name2`. The fill model comes
under the FLUX.1 [dev] Non-Commercial licence: if the pictures are for work, the user reads it first. Of the other
templates in November 2026, Flux.1 Dev OneReward uses a half-size fill model (about 22 GB in all, licence CC BY-NC
4.0), the Qwen-Image one needs about 36 GB, and Anima's is for anime.

**The light route**, for a smaller card or disk: `512-inpainting-ema.safetensors` (5.2 GB, into `models/checkpoints`,
from huggingface.co/Comfy-Org/stable_diffusion_2.1_repackaged), an inpainting model that works at 512 × 512. Its
results are softer, which a sky forgives. Its workflow is in step 8, or on docs.comfy.org/tutorials/basic/inpaint
(drag the workflow picture there onto ComfyUI's canvas).

Ask before each download, naming the file and its size. How to download is in `references/setup-and-deps.md`.

## 3. Get the photo in

- Look for it in the workspace; if it isn't there, ask the user where it is. Don't search their home folder.
- In ComfyUI the user drags the photo file onto the template's Load Image node, or uses the node's "choose file to
  upload". That copies it into ComfyUI's input folder and leaves the original where it was. Where the agent reaches
  ComfyUI, it can upload the photo itself (`scripts/comfy_upload.py`) and tell the user which name to pick in the
  node's list.
- A phone photo is many times the size these models work at, which makes the run slow or run out of memory and the
  result worse. Add a **Scale Image to Total Pixels** node: Load Image's IMAGE into its `image`, and its IMAGE into the
  template node's `pixels` (VAE Encode (for Inpainting)'s on the light route) in place of the link from Load Image.
  Set `megapixels` to 1.0 for Flux (0.25 for the 512 model: 512 × 512's worth), and under its advanced inputs
  `resolution_steps` to 8, so both sides come out as multiples of 8, the unit these models work in. The mask stays
  linked from Load Image; the inpainting nodes resize it. The result then comes out at the smaller size, until step 6
  puts it back at full size.

## 4. Paint the mask

Right-click the Load Image node, then Open in Mask Editor.

- The colour-select tool, the last of the tools down the left side, picks pixels of a similar colour and covers a
  clear sky in a click or two; raise its Tolerance (in the settings on the right) until the sky is covered, then tidy
  up with the brush and the eraser.
- Let the mask run a little over the skyline onto roofs and trees. Stopping short leaves a line of old sky.
- Save. ComfyUI keeps the masked copy in its input folder, under `clipspace`, and the node now uses it; the photo
  itself isn't changed.

## 5. Prompt, settings, run

- The prompt describes the new sky and its light in a few plain phrases. On the light route, the second text box is
  the negative prompt; "text, watermark" is enough.
- Leave the template's other settings as they ship (Flux.1 Inpaint: 20 steps, cfg 1, denoise 1.0). The seed changes
  on every run; fix it to compare two prompts.
- On the light route the sampler's `denoise` stays at 1.0: VAE Encode (for Inpainting) fills the masked area with flat
  grey, and anything lower keeps some of that grey. To change less, mask less.
- Run (the Run button, or Ctrl+Enter). The result shows on the Save Image node and is saved in ComfyUI's output folder;
  tell the user its name and that the photo itself is untouched.

## 6. Look along the edges, and fix what shows

- **A line of old sky along roofs and trees**: the mask stopped short. Paint it a little further over the edge; on the
  light route, raising VAE Encode (for Inpainting)'s `grow_mask_by` widens the repainted band without a new mask. Bare
  branches can't be traced with a brush: the colour-select tool follows them better, or mask round them and accept a
  little old sky inside.
- **The rest of the photo came out softer or shifted in colour**: the whole picture goes through the model, not just
  the sky. Paste only the new sky onto the original with an **Image Composite Masked** node: `destination` from Load
  Image's IMAGE, `source` from the template node's IMAGE (VAE Decode's on the light route), `mask` from Load Image's
  MASK, `x` and `y` 0, `resize_source` on. Its IMAGE goes to Save Image in place of the old link. The foreground is
  then the photo's own pixels at full size, and only the sky was scaled up, which a sky hides well. The step 8 file
  has this built in.

## 7. When the light doesn't match

A sky that doesn't match the light on the land looks pasted on. The model sees the rest of the photo, but it follows
the prompt:

- Ask for a sky the photo's light already suits: where the shadows point, how warm the light is, how hazy the
  distance looks ("late afternoon, warm sun from the left, hazy near the horizon").
- Take a strip of the horizon (distant hills, haze) into the mask, so the model joins sky and land itself instead of
  meeting a hard line.
- A real change of time of day, such as a sunset over a midday street, means relighting the land as well: a separate
  pass over the whole picture with an image-edit or relight template (search the browser for "relight"). It changes
  every pixel, so offer it and let the user decide.

## 8. A workflow file to drag in

When the agent can't reach the user's ComfyUI, or wiring by hand would be a chore, it writes the graph into the
workspace as an API-format file (`new-sky.json`, say). The user drags it onto ComfyUI's canvas (ComfyUI opens API
files as well as its own), drags the photo onto its Load Image node, and carries on from step 4. This is the light
route with the scaling and the composite built in; for Flux, start from the template instead. Change the prompt text
to the sky the user wants. Saved from ComfyUI (File › Save), it shows in the dashboard's workflow list too.

```json
{
  "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "512-inpainting-ema.safetensors"}},
  "2": {"class_type": "LoadImage", "inputs": {"image": "photo.png"}},
  "3": {"class_type": "ImageScaleToTotalPixels", "inputs": {"image": ["2", 0], "upscale_method": "lanczos", "megapixels": 0.25, "resolution_steps": 8}},
  "4": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["1", 1], "text": "clear blue sky with a few high white clouds, bright afternoon light"}},
  "5": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["1", 1], "text": "text, watermark"}},
  "6": {"class_type": "VAEEncodeForInpaint", "inputs": {"pixels": ["3", 0], "vae": ["1", 2], "mask": ["2", 1], "grow_mask_by": 6}},
  "7": {"class_type": "KSampler", "inputs": {"model": ["1", 0], "positive": ["4", 0], "negative": ["5", 0], "latent_image": ["6", 0], "seed": 1, "steps": 20, "cfg": 8.0, "sampler_name": "uni_pc_bh2", "scheduler": "normal", "denoise": 1.0}},
  "8": {"class_type": "VAEDecode", "inputs": {"samples": ["7", 0], "vae": ["1", 2]}},
  "9": {"class_type": "ImageCompositeMasked", "inputs": {"destination": ["2", 0], "source": ["8", 0], "mask": ["2", 1], "x": 0, "y": 0, "resize_source": true}},
  "10": {"class_type": "SaveImage", "inputs": {"images": ["9", 0], "filename_prefix": "new_sky"}}
}
```

The sampler settings are those of Comfy's own example for this model. The same graph in words, for wiring it by hand:

- Load Checkpoint: MODEL to KSampler's `model`; CLIP to both CLIP Text Encode nodes; VAE to both VAE Encode (for
  Inpainting) and VAE Decode.
- Load Image: IMAGE to Scale Image to Total Pixels and to Image Composite Masked's `destination`; MASK to VAE Encode
  (for Inpainting)'s `mask` and to Image Composite Masked's `mask`.
- Scale Image to Total Pixels: IMAGE to VAE Encode (for Inpainting)'s `pixels`.
- The sky's CLIP Text Encode to KSampler's `positive`; the other one to `negative`.
- VAE Encode (for Inpainting): LATENT to KSampler's `latent_image`. KSampler: LATENT to VAE Decode's `samples`.
- VAE Decode: IMAGE to Image Composite Masked's `source`. Image Composite Masked: IMAGE to Save Image.
- Settings: Scale Image to Total Pixels at 0.25 megapixels, `resolution_steps` 8; `grow_mask_by` 6; KSampler 20 steps,
  cfg 8, `uni_pc_bh2`, `normal`, denoise 1.0; Image Composite Masked `x` and `y` 0, `resize_source` on.
