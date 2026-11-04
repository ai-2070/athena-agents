---
name: ComfyUI
description: Use for running or fixing a ComfyUI workflow: missing nodes or models, errors from ComfyUI, img2img, inpaint or upscale with ComfyUI, which model a workflow needs, or installing ComfyUI. Builds on the dashboard's ComfyUI tools with a dependency check, masks and fixes.
---

ComfyUI runs image, video, audio and 3D models as a graph of nodes, and a saved graph is a workflow. The dashboard's
ComfyUI tools already do the everyday part: say whether ComfyUI is running (with its queue and GPU memory), start
ComfyUI Desktop and wait for it, list the user's saved workflows, describe one (its settings, keyed `nodeId.input`, and
where the prompts go), and run one with new prompt text, settings and input pictures (masks too), returning the
pictures, video, audio and 3D files. This skill adds what they leave out: checking that a workflow's nodes and models
are installed, reading ComfyUI's errors and fixing the workflow, the cases the run tool's uploads don't cover, and
setting ComfyUI up. Good work runs the user's own workflow with only the values the task needs changed, installs or
downloads nothing without a yes, and shows the results.

## Before you start

- **Is it running?** Ask the status tool. If not, the start tool opens ComfyUI Desktop and waits up to two minutes
  for it. Its answer says whether ComfyUI came up, or why not: the new Comfy Desktop (the multi-install app, since
  mid-2026) opens on its own dashboard and starts nothing unless its "Auto-launch on startup" setting names an install,
  and opening it again while it's open only brings its window forward. Pass on what the answer asks of the user
  (press Launch there, or set that option to "Last used instance"), then ask the status tool again.
- **The address.** The dashboard uses Settings › ComfyUI address, else tries `127.0.0.1:8188`, `:8000`, and any port
  Comfy Desktop moved an install to because 8188 was taken. ComfyUI and the new Comfy Desktop listen on 8188; the old
  ComfyUI Desktop, and installs carried over from it, use 8000. Anything else goes into that setting.
- **Out of reach** (ComfyUI on another computer, or one the status tool can't find): don't turn the task into network
  setup. Give the user the steps in ComfyUI, and where it saves them work, write a workflow file into the workspace
  for them to drag onto ComfyUI's canvas. Opening ComfyUI to the network (`--listen`) is their call, and comes with a
  warning first: ComfyUI has no login, so anyone who can reach it can run jobs and read and add files in its folders.
- **No workflows listed, or one missing?** The tools read the `user\default\workflows` folder of every install Comfy
  Desktop lists, of the Legacy Desktop's, and of installs in their default places, plus Settings › Extra ComfyUI
  workflow folders. Only that folder itself, not folders inside it. For a ComfyUI elsewhere, ask where it's installed
  and have the user add `<install>\ComfyUI\user\default\workflows` there.
- **The scripts** need Python 3.10 or newer (`python <skill folder>/scripts/<name>.py`); the upload script needs
  Pillow for masks (`python -m pip install pillow`, with the user's OK).
- **No ComfyUI at all**: setting it up is the user's call. Ask first whether they want it on this computer or on Comfy
  Cloud (paid), then follow `references/setup-and-deps.md`.

## How to do it well

### Start from the user's workflow

- Pick the saved workflow whose job matches (text to image, image to image, inpaint, upscale, video) by its name and
  what describe shows. A workflow's model, sampler, steps, size and LoRAs were tuned together; change the prompt,
  seed, size or input file the task calls for and leave the rest. That goes double for Comfy's official templates:
  removing nodes that look unused to "simplify" one usually breaks it.
- Describe before you run, and change only keys from its list. A key that isn't listed is usually a link
  (`["4", 1]`, an output of another node); setting a value over it cuts the graph, and the run tool won't stop you.
- The describe tool finds the prompts by following each sampler's or guider's conditioning (`positive` and
  `negative`, or a `BasicGuider`'s one `conditioning`) back through helper nodes to the text node, which beats
  trusting titles like "Positive". Its `promptInputs` and `negativeInputs` are the exact inputs the run's prompt and
  negative fill: every text field of the node (SDXL's `text_g` and `text_l`, Flux's `clip_l` and `t5xxl`, SD3's
  three), or the string node a text input is linked to. To give those fields different text, set them in the run's
  settings instead. A graph with one conditioning, or a negative made by zeroing the prompt, has no negative to set,
  and the run says so. When `promptInputs` is empty, trace the links yourself and set `"<id>.<field>"`.
- Inputs of newer nodes can have dotted names (`12.resize_type.width`, `7.values.a`). They are the real names: write
  them as they are, never flattened.
- Seeds are new on every run unless you set them. To compare two settings, or to redo a picture, fix the seed.
- `references/workflow-format.md` has the details: the two file formats, links, where prompts, seeds and sizes live,
  editor-only nodes, and how masks are read.

### When the user asks how

A beginner asking "how do I…" wants concrete steps, cheapest first: what's installed, then a built-in template (free
to open), then downloads, each asked for with its size. Hand-wiring comes last, and any wiring given is complete, every
required input linked. For inpainting (a new sky, a removed object), follow `references/first-inpaint.md`. With any
user, say what a step does ("a check that lists everything the workflow is missing"), not script names, JSON keys or
node class ids.

### Check a workflow before relying on it

A workflow from the web, a template, or one that failed with "not found" or "not in list" gets checked against the
running ComfyUI first. The check only reads; the file can be API format, editor format or a PNG ComfyUI made:

```
python <skill folder>/scripts/comfy_check.py "<workflow.json>"
python <skill folder>/scripts/comfy_check.py "<picture.png>" --server http://127.0.0.1:8000 --timeout 120
```

`--server` is ComfyUI's address (default: try `http://127.0.0.1:8188`, then `:8000`), `--timeout` the seconds to wait
for each answer (default 60). The JSON lists `missing_nodes` (with `provided_by`, the node pack, when the workflow or
ComfyUI-Manager knows it), `missing_models` (with the folder under `models/`, and the download link a template
recorded), `missing_embeddings`, `missing_inputs` (files a Load Image node names that aren't in the input folder),
`near_matches` (a name the server spells differently, often `\` against `/`: change the value to its `server_name`),
`unknown_values` (choices this ComfyUI doesn't offer, often from a newer version) and `problems` in the file itself.
Exit status: 0 nothing missing, 1 something missing or to fix, 2 the check couldn't run (why, on stderr). Missing
embeddings matter more than they look: ComfyUI skips them with only a console warning, so the picture comes out
different and nothing says why.

### Input images and masks

Image to image, inpainting, upscaling and ControlNet read a file from ComfyUI's input folder. Look for the user's file
in the workspace or the folders they allowed; if it isn't there, ask for it, or have them drag it onto the Load Image
node in ComfyUI themselves. Don't search their home folder. The run tool sends it: give `images`, each with its `file`
and, when the workflow has more than one Load Image node, the `node` it goes into (`"10"`; a Load Video or Load Audio
node takes its file the same way). The run's answer lists the name ComfyUI gave each file: it renames an upload rather
than replace a different file, so the name can differ.

A picture's `mask` (a PNG of the same size) goes into the picture's transparency, which is what Load Image's MASK
output reads: with `mask_kind` white (the default) white marks the area to repaint, with `transparent` the mask's
transparent pixels do. The masked copy is a new file named after the picture with `-mask` added; the picture itself
stays as it was. Other nodes read masks differently (`references/workflow-format.md`): a Load Image (as Mask) node
takes a black-and-white mask as a picture of its own. With no mask yet, the user can paint one in ComfyUI's mask editor
(right-click a Load Image node), or `photocraft` can make one from a selection when it's set up. Sending files to a
ComfyUI on another computer is a step the user is asked about first, unless the agent's autonomy is Full.

The upload script covers what the run tool doesn't: a mask that isn't a PNG, uploads into a folder inside the input
folder or over a file of the same name, and files the user will pick in ComfyUI themselves, without a run. It prints
each file's `value`, which goes into the node's input (`{"10.image": "photo (1).png"}`):

```
python <skill folder>/scripts/comfy_upload.py "<photo.png>" "<street.jpg>" --subfolder shoot
python <skill folder>/scripts/comfy_upload.py "<mask.jpg>" --mask-onto "<value of the photo>" --mask-kind white
```

It takes images, masks, video or audio, several at once. `--overwrite` replaces a file of the same name, but never
the image a mask goes onto: the masked copy takes the mask file's name, so a mask named like the image is refused.
`--mask-onto` and `--mask-kind` work as the run tool's mask does. `--server` and `--timeout` work as for the check
(default 120 seconds). Exit status 0 when every upload worked; 2 when one didn't, with the reason in one line on stderr
and the JSON listing any that went up before it.

### When ComfyUI says no

- **Rejected before running.** The run tool's error carries ComfyUI's `node_errors`: for each failing node, the error
  `type`, `message`, `details`, and `extra_info.input_name`, the exact input key it wants. Fix that node and run again;
  rebuilding a workflow from scratch brings in new mistakes. A node "not found", or `value_not_in_list` on a model
  input, means something isn't installed: check the workflow.
- **Failed while running.** The message is the failing node's own error. Out of GPU memory: smaller size or batch,
  then a lighter model, with the user. To see which node failed, look at the newest job's history (`references/api.md`).
- **Timed out.** The job is probably still running (the status tool shows the queue). Look it up by the prompt id in
  the message (`references/api.md`); running it again queues a second copy.
- **Left out.** ComfyUI drops outputs whose branch fails its checks and runs the rest. The run's answer lists each
  failing node under "Left out by ComfyUI", with the same `type`, message and input name as a rejection: fix those
  nodes and run again.
- **Saved editor files** are converted by the dashboard using the server's node list, the way ComfyUI's own editor
  does it: subgraphs, newer nodes' dotted inputs and bypassed nodes included. Its warnings name what it can't convert:
  old-style group nodes, a subgraph whose definition isn't in the file, inputs it places by assumption. Then, or when
  ComfyUI rejects the converted graph in a way the file doesn't explain, ask the user to use File › Export (API) in
  ComfyUI and save the result next to their workflows, then run that.

### Installing is the user's call

Custom nodes are Python that runs with the user's rights, so a workflow that needs them is code to vet. Before
installing a node pack, downloading a model (often several GB) or using Comfy Cloud (it spends credits), ask: name it,
say where it comes from and how big it is. Packs go in one at a time, each vetted and agreed to; a workflow from the
web never gets ComfyUI's "Install All" or a command that installs every pack it lists. Prefer the pack the workflow
recorded or ComfyUI-Manager lists, and `.safetensors` model files. `references/setup-and-deps.md` has the ways to
install. ComfyUI needs a restart after new nodes; new model files show up without one. Comfy Cloud can be added on the
dashboard's MCP page.

## Steps for a run

1. Status; start ComfyUI if needed.
2. List, pick and describe the workflow.
3. New to this ComfyUI, or it failed before: check it, and settle what's missing with the user.
4. Run with the prompt, settings, input pictures and masks; look at the pictures it returns before offering them,
   and read what it left out.

## Done means

- The run finished and the returned pictures show what was asked: look at them. Tell the user the workflow, the
  prompt, the seed and where the files are (ComfyUI's output folder; the run's result names them).
- For a fixed workflow: the check says ready, or says exactly what's left and why, and a test run worked.
- Nothing installed, downloaded, uploaded to a cloud or paid for without the user's yes.

## Watch out for

- Model names are exact, including their subfolder and its slash: `SDXL\model.safetensors` from a Windows machine is a
  different name on Linux.
- An API-format file holds nodes only. Any other top-level key (a `_comment`, say) makes ComfyUI reject it.
- Overwriting the user's workflow file. Save a changed copy under a new name, unless they ask otherwise.
- Long jobs and downloads from the shell: the dashboard's shell stops a command after 300 seconds by default. Start
  them in the background and check on them.
- JSON for ComfyUI goes in a file (`--data-binary "@body.json"`); PowerShell 5.1 strips quotes inside arguments.
- Commands for the user to run themselves: only programs they have, in their own shell. A Windows beginner gets one
  PowerShell line per command (no `\` line breaks, `curl.exe`), or better, the clicks in ComfyUI that do the same.

## Files

- `references/workflow-format.md`: API and editor formats, links, finding prompts, seeds and sizes, dynamic inputs,
  editor-only nodes, reading `node_errors`, masks. Open it before editing a workflow file or fixing a rejected one.
- `references/setup-and-deps.md`: local or Cloud, Comfy Desktop, the portable build and comfy-cli on Windows, macOS and
  Linux, the folders, installing node packs, downloading models. Open it to install anything.
- `references/api.md`: ComfyUI's HTTP routes (submit, history, files, queue, cancel), error shapes, and Comfy Cloud's
  differences. Open it to talk to ComfyUI without the dashboard's tools, or to follow up, or cancel, a run.
- `references/first-inpaint.md`: a first inpaint (a new sky) step by step: template, model sizes, mask, settings,
  halos, light, and a workflow file to drag in. Open it when someone asks how to repaint part of a picture.
- `scripts/comfy_check.py`: reports the node types, models, embeddings and input files a workflow needs that the
  running ComfyUI lacks (JSON; only reads).
- `scripts/comfy_upload.py`: uploads files into the running ComfyUI's input folder (into a folder there, over a file,
  or without a run), or puts a mask in any picture format onto an uploaded image, and prints the names to use in a
  workflow (JSON).
