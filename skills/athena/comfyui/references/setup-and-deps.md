# Setting up ComfyUI, and installing what a workflow needs

Everything here installs, downloads or spends something, so each step starts with the user's yes. Checked in November
2026 against ComfyUI 0.44, the new Comfy Desktop, comfy-cli 1.25 and docs.comfy.org; versions move fast, so check a
command's `--help` before relying on a flag.

## The first question: this computer, or Comfy Cloud?

Ask before installing anything, and let the user choose:

- **On this computer**: free to run, works offline, the user's own models and nodes. It needs a capable GPU (an NVIDIA
  card is the usual choice on Windows; AMD, Intel and Apple Silicon work too) and disk space for models, which run to
  several GB each. Once ComfyUI runs, the dashboard's status tool shows the GPU and its memory.
- **Comfy Cloud**: Comfy's GPUs, nothing to install, common models already there. It costs money: runs spend Comfy
  credits, and API access needs a paid subscription. Use it only after the user agrees, knowing that.

Don't decide for them from guessed hardware rules. If a model turns out too big for their GPU, the run says so (out of
memory), and that's the time to talk about a smaller model or Cloud.

## On Windows

**Comfy Desktop** (the new app from mid-2026; the earlier one is now called Legacy Desktop) suits most people: an
installer from comfy.org (guide: docs.comfy.org/installation/desktop/windows) that manages one or more ComfyUI installs
and a Comfy Cloud card. What matters to an agent:

- Each install's ComfyUI listens on 8188 unless its launch arguments say otherwise, and by default Desktop moves it to
  the next free port when 8188 is taken. Installs carried over from Legacy Desktop keep that app's port, 8000. The
  dashboard tries both; any other port goes into Settings › ComfyUI address.
- Desktop starts nothing on its own unless "Auto-launch on startup" names an install ("Last used instance" works),
  and only after its first-run setup is done. The dashboard's start tool reads those settings and says what the user
  needs to do when no ComfyUI will come up. Opening Desktop while it's open only brings its window forward.
- Installs live under `%LOCALAPPDATA%\Comfy-Desktop\ComfyUI-Installs` (older ones under
  `%USERPROFILE%\ComfyUI-Installs`, and under `<drive>:\Comfy-Desktop` when Desktop itself is installed on another
  drive), each with its workflows in `<install>\ComfyUI\user\default\workflows`. The shared models, input and output
  folders are in `ComfyUI-Shared` next to it; an install can keep its own instead. Desktop's settings, its list of
  installs (`installations.json`) and its `logs\app.log` are in `%APPDATA%\Comfy Desktop`; each install's own log is
  `<install>\logs\comfyui.log`, and its console is in its Manage panel, on the Terminal tab. The dashboard finds the
  workflows and results of every install that list names.
- By default it starts ComfyUI with ComfyUI-Manager turned on (`--enable-manager`), so missing node packs can be
  installed from inside ComfyUI.

**The portable build** is a 7z archive from ComfyUI's GitHub releases (guide:
docs.comfy.org/installation/comfyui_portable_windows), unpacked anywhere: `ComfyUI_windows_portable_nvidia.7z` for
current NVIDIA cards, `..._nvidia_cu126.7z` for older ones, `..._amd.7z`, `..._intel.7z`. It starts with
`run_nvidia_gpu.bat` (or `run_amd_gpu.bat`, `run_intel_gpu.bat`, `run_cpu.bat`), whose console window has to stay
open, on port 8188. Its Python is `python_embeded\python.exe`: packages go in with
`.\python_embeded\python.exe -m pip install <package>`. It updates with `update\update_comfyui_stable.bat`.

**comfy-cli** is Comfy's own command line, for people happy in a terminal and for headless machines. It needs Python
3.10 or newer: `python -m pip install comfy-cli` (or `pipx install comfy-cli`). Then:

```
comfy --skip-prompt install --nvidia        # or --amd, --intel-arc, --m-series, --cpu; goes to <home>\comfy
comfy launch --background                   # serves on 8188; comfy stop ends it
comfy which                                 # which install the commands act on
```

`--workspace <path>` points a command at a particular install. `COMFY_LOCAL_URL` (for example
`http://127.0.0.1:8000`) points every command at a ComfyUI it didn't start, such as a Desktop one. `comfy setup` and
`comfy cloud login` are interactive (a wizard, a browser sign-in): those are for the user to run themselves.

From the dashboard's shell, anything long goes in the background: `comfy launch --background`, or `Start-Process` for a
`.bat`. The shell stops a command after 300 seconds by default.

## On macOS and Linux

Comfy Desktop also comes for macOS 13 or newer on Apple Silicon, and for Linux as a `.deb` or an AppImage. There its
installs go in `~/ComfyUI-Installs` and the shared folders in `~/ComfyUI-Shared`; its settings and list of installs
are in `~/Library/Application Support/Comfy Desktop` on a Mac, `~/.config/comfyui-desktop-2` and
`~/.local/share/comfyui-desktop-2` on Linux. comfy-cli works the same way (`comfy --skip-prompt install --m-series` on Apple Silicon). Installing by hand from the GitHub repo
(git clone, then its requirements into a virtual environment) is for developers; docs.comfy.org/installation has the
current steps for each GPU.

## Where things go

Inside a ComfyUI folder (or Desktop's shared folder, for models, input and output):

| Folder | What goes there |
|---|---|
| `models/checkpoints` | Full checkpoints (model, text encoder and VAE in one file) |
| `models/diffusion_models` | Diffusion models on their own; older ComfyUI calls it `models/unet`, and both are read |
| `models/text_encoders` | Text encoders (CLIP, T5 and so on); older name `models/clip`, both read |
| `models/vae`, `models/loras`, `models/controlnet`, `models/clip_vision`, `models/upscale_models`, `models/embeddings` | What they say |
| `custom_nodes/` | Node packs, one folder each |
| `input/`, `output/` | Files for Load Image and the like; results |
| `user/default/workflows/` | The workflows ComfyUI saves |

`GET /models` on the server lists every models folder it knows, custom nodes' included, and `scripts/comfy_check.py`
names the folder for each missing model. To share model folders with another install or app, ComfyUI reads
`extra_model_paths.yaml` (there's an example file in its folder); Desktop has its own Settings › Storage for that.

## Missing node packs

1. Run `scripts/comfy_check.py` on the workflow. `missing_nodes[].provided_by` gives the pack: from the workflow's own
   record (`hint_from: workflow`), or from ComfyUI-Manager's list on the server (`hint_from: comfyui-manager`). When
   more than one pack declares a node, choose with the user. A node from `comfy-core` means ComfyUI itself is too old:
   update ComfyUI rather than installing anything.
2. Look for a way round first. ComfyUI offers a built-in replacement for some missing nodes (a Replace button where
   it does; that changes the workflow, so save a copy first), and a workflow from the web often pulls in a whole pack
   for one small node that a core node can stand in for.
3. Ask the user about each pack on its own: its name, its repository, what the workflow uses it for, and who maintains
   it and how recently (its GitHub page shows both). A node pack is Python that runs with their rights, so a workflow
   from the web gets its packs vetted one by one, never all at once with ComfyUI's "Install All" or a command that
   installs everything the workflow lists.
4. Install the one pack the user agreed to:
   - In ComfyUI: the missing-nodes dialog that opens with the workflow, or the Node Manager, lists the packs; install
     just that one. Easiest for the user.
   - comfy-cli, for someone who already uses it: `comfy node install <pack id>` (a registry id from `provided_by`).
   - By hand: `git clone <repo>` into `custom_nodes`, then the pack's `requirements.txt` into ComfyUI's own Python
     (on the portable build, from its folder:
     `.\python_embeded\python.exe -m pip install -r ComfyUI\custom_nodes\<pack>\requirements.txt`).
5. Restart ComfyUI, then run the check again. A pack that fails to load shows its error in ComfyUI's console at start.

Updating: Desktop updates itself; the portable build runs `update\update_comfyui_stable.bat`; comfy-cli has
`comfy update` (ComfyUI), `comfy update all` (and every node pack) and `comfy node update <pack>`.

## Missing models

- **Where from**: the URL the workflow recorded (templates do; the check passes it on as `url`), the model's own page
  on Hugging Face, or the link the workflow's author gave. Prefer `.safetensors`, which holds only weights; `.ckpt`,
  `.pt` and `.bin` files are Python pickles, which can carry code.
- **From ComfyUI itself**: when a template, or another workflow that recorded its models, opens with files missing,
  ComfyUI says so and lists each file with its folder, its size and a Download button ("Download all" shows the
  total). In Comfy Desktop the files go straight into the right folder; in a browser they land in Downloads and have to
  be moved into the folder listed. The user clicks, after deciding on the size.
- **Ask first**, with the file name, its size (the download page shows it) and the folder it goes in. Some models need
  the user to accept a licence on Hugging Face, or a token; that's theirs to do.
- **Download** into the folder the check named, keeping the exact file name the workflow uses, with comfy-cli where
  it's installed:

  ```
  comfy model download --url "<url>" --relative-path models/<folder> --background
  comfy model download-status <id>
  ```

  or with curl: `curl.exe -L -o "<ComfyUI>\models\<folder>\<file>" "<url>"` in PowerShell (`curl -L -o ...` elsewhere).
  A big file takes longer than the shell's default 300 seconds: use comfy-cli's `--background`, or start curl with
  `Start-Process`, and check the file's size afterwards. comfy-cli reads Hugging Face and Civitai tokens from
  `HF_API_TOKEN` and `CIVITAI_API_TOKEN` when the user has set them.
- ComfyUI notices a new model file without a restart; the editor's lists catch up after Edit › Refresh Node
  Definitions.

## Comfy Cloud

Only after the user has chosen it, knowing it spends credits. Three routes:

- Comfy Desktop's Comfy Cloud card, for the user to work in themselves.
- The dashboard's MCP page can add the Comfy Cloud server (Comfy's own); the user signs in there, and agents with it
  can run workflows on Cloud.
- comfy-cli: after the user has run `comfy cloud login` themselves, commands take `--where cloud`:
  `comfy run --workflow wf.json --where cloud --wait`, `comfy jobs status <id> --where cloud`,
  `comfy download <id> --where cloud -o <folder>`. Cloud has its own models and nodes, so check against it with
  `comfy models search --where cloud` and `comfy nodes ls --where cloud`; `comfy cloud status` shows the credit balance.

`scripts/comfy_check.py` and `scripts/comfy_upload.py` talk to a ComfyUI server directly and don't do Cloud. Cloud's
own API differs from a local server's: see the end of `references/api.md`.
