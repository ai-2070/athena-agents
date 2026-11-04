# ComfyUI's HTTP API

For talking to a ComfyUI server without the dashboard's tools: following up a run that timed out or failed, submitting
a workflow the tools can't (an API file outside the workflow folders), or cancelling a job. Checked against ComfyUI
0.44's `server.py` (November 2026).

The address is the one the status tool reports (`http://127.0.0.1:8188` unless set otherwise). A local server has no
sign-in. Every route below also answers with an `/api` prefix (`/api/prompt`), which is what the web page itself uses.

## Routes

| Route | What it does |
|---|---|
| `GET /system_stats` | ComfyUI and Python versions, OS (`system.os`), each device's `vram_total` and `vram_free` in bytes |
| `GET /object_info`, `GET /object_info/<class>` | Every node type's inputs and outputs. A dropdown is `[[choices], {...}]` or `["COMBO", {"options": [...]}]`; upload inputs carry `image_upload`, `video_upload` or `audio_upload` |
| `GET /models`, `GET /models/<folder>` | The models folders, and the files in one. An unknown folder gives 404, and that includes the old names `unet` and `clip` on a current server |
| `GET /embeddings` | Embedding names, without file extensions |
| `POST /upload/image` | Multipart form: `image` (the file), `type` (`input`), `subfolder`, `overwrite` (`true`). Answers `{"name", "subfolder", "type"}`; the name is the one to use |
| `POST /upload/mask` | As above plus `original_ref` (JSON: `filename`, `subfolder`, `type`): saves a copy of that image with the uploaded mask's alpha as its alpha |
| `POST /prompt` | Queues a workflow (below) |
| `GET /history/<prompt_id>`, `GET /history?max_items=1` | One job's result, or the newest job's |
| `GET /api/jobs/<prompt_id>` | One job in a simpler shape, with `status` one of `pending`, `in_progress`, `completed`, `failed`, `cancelled` |
| `POST /api/jobs/<prompt_id>/cancel` | Cancels that one job, waiting or running (ComfyUI 0.26 and newer). Answers `{"cancelled": true}`, or `false` when it had already finished or the id is unknown |
| `GET /view?filename=&subfolder=&type=` | A file's bytes; `type` is `output`, `input` or `temp` |
| `GET /queue` | `queue_running` and `queue_pending`, each job a list whose second item is its prompt id |
| `POST /queue` | `{"delete": ["<prompt_id>"]}` takes waiting jobs off; `{"clear": true}` empties the queue |
| `POST /interrupt` | `{"prompt_id": "<id>"}` stops that job if it's the one running. With no body it stops whatever is running, which may be someone else's |
| `POST /free` | `{"unload_models": true, "free_memory": true}` unloads models from GPU memory |
| `GET /ws?clientId=<id>` | WebSocket of progress events (`execution_start`, `executing`, `progress`, `executed`, `execution_success`, `execution_error`, `execution_interrupted`); a job's events go to the socket whose `clientId` it was submitted with |

The run tool uploads input pictures and masks itself; for other uploads and for the dependency check there are
scripts (`scripts/comfy_upload.py`, `scripts/comfy_check.py`). Use those rather than hand-made multipart requests.

## Submitting a workflow

The body goes in a file, because PowerShell 5.1 strips quotes inside arguments. `body.json`:

```json
{"prompt": {"3": {"class_type": "KSampler", "inputs": {"seed": 815, "...": "..."}}, "...": "..."}, "client_id": "athena-1"}
```

`prompt` is the whole workflow in API format. Then, in PowerShell (the quotes around `@body.json` matter there, since
`@` starts a splat):

```powershell
curl.exe -s -X POST http://127.0.0.1:8188/prompt -H "Content-Type: application/json" --data-binary "@body.json"
```

and in bash or zsh:

```bash
curl -s -X POST http://127.0.0.1:8188/prompt -H 'Content-Type: application/json' --data-binary @body.json
```

The answer is `{"prompt_id": "...", "number": 7, "node_errors": {}}`. A non-empty `node_errors` in a 200 answer means
some outputs failed validation and were dropped while the rest run. A 400 answer is `{"error": {...}, "node_errors":
{...}}` and nothing runs; `references/workflow-format.md` explains how to read it.

Submit once. If the request times out, or you lose track of a job, look for it in `/queue` and `/history` before
sending anything again: a second POST queues a second copy, which then holds the GPU for as long again. (The body may
carry your own `prompt_id`, a lowercase UUID, which makes the job easy to find later.)

## Getting results

Poll `GET /history/<prompt_id>` every few seconds; it stays `{}` until the job finishes. A finished entry:

```json
{"<prompt_id>": {
  "prompt": ["..."],
  "outputs": {"9": {"images": [{"filename": "lighthouse_00001_.png", "subfolder": "", "type": "output"}]}},
  "status": {"status_str": "success", "completed": true, "messages": [["execution_start", {}], ["execution_success", {}]]}
}}
```

Outputs are listed by the node that made them: under `images` (ComfyUI's own video nodes too, marked `animated`),
`audio`, `3d`, or a custom node's own key such as `gifs`. The old Preview 3D node gives a path in the output folder as
`result[0]` instead. The dashboard's run tool returns all of these, `gifs` and `videos` included. Fetch each with `/view`, quoting the URL in PowerShell
because of the `&`:

```powershell
curl.exe -s -o lighthouse.png "http://127.0.0.1:8188/view?filename=lighthouse_00001_.png&subfolder=&type=output"
```

Save files into the workspace or where the user asked. The originals stay in ComfyUI's output folder anyway.

When `status_str` is `error`, the `execution_error` message in `messages` names the failing `node_id` and `node_type`
and carries `exception_message`, `exception_type` and the `traceback`. The dashboard's run tool reports only the
message; `GET /history?max_items=1` finds the rest for the newest job.

## Cancelling

On ComfyUI 0.26 and newer, one call cancels one job whether it's waiting or running, and touches no one else's:

```powershell
curl.exe -s -X POST http://127.0.0.1:8188/api/jobs/<prompt_id>/cancel
```

(`curl -s -X POST ...` in bash or zsh.) `{"cancelled": false}` means there was nothing to cancel: the job had already
finished, or the id is wrong. `/system_stats` gives the version.

On an older server it takes two calls: `POST /queue` with `{"delete": ["<id>"]}` while the job waits, and
`POST /interrupt` with `{"prompt_id": "<id>"}` while it runs. Some older versions ignore the prompt id and stop
whatever is running, so check `/queue` first that the running job is the one you mean.

## Comfy Cloud is different

Use it only after the user has chosen it (it spends credits), and preferably through the dashboard's Comfy Cloud MCP
server or comfy-cli's `--where cloud` (`references/setup-and-deps.md`), which deal with the details. For direct calls,
from docs.comfy.org:

- Base `https://cloud.comfy.org`. API access needs a paid subscription and an API key from platform.comfy.org; the
  key comes from the user and goes in an environment variable, never in a file or a command you show.
- The first Cloud API (`X-API-Key` header, local-style paths under `/api/`) is deprecated in favour of Comfy API v2
  (`Authorization: Bearer <key>`, paths under `/api/v2/`). Write new calls against v2.
- A 429 on Cloud can mean the subscription is inactive, not a rate limit: retrying won't help, so tell the user.
- Result downloads answer with a redirect (302) to a signed storage URL that carries its own authorization. Follow it
  without the key: curl sends `-H` headers to every host when it follows redirects with `-L`, which would hand the
  key to the storage host. Fetch the `Location` URL in a second request without the header instead.
