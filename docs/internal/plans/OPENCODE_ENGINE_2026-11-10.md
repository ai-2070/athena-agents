# Run agents on opencode

_Plan, 10 November 2026; progress 11 November. Targets opencode 2.x (2.2.7 is current and is installed on the dev PC
at `~/.bun/bin/opencode.exe`). opencode 1.x is not supported._

## Progress

- **Step 1 (done): the engine.** `server/engines/opencode.ts`: one `opencode serve --stdio --port 0` per run, its
  config file (the `athena` agent, the brief by `{file:}`, permission rules from autonomy, the dashboard bridge and
  the agent's MCP servers), sessions under our own `ses_` ids, the event reader, questions to approvals (with
  Always allow), Stop, steering through opencode's inbox, models, effort as the model's variant, the terminal.
  Registered everywhere the server names engines. 22 tests against a fake server.
- **Step 2 (done): the page.** Settings › General card (with "needs an update" for 1.x), the model picker's tab,
  the agent editor, the status line, the Station's engine tiles, Programs, Terminals, the approval label, the mark.
- **Step 3 (done): docs and a live check.** README and `docs/guide.md`. A throwaway dashboard (its own data
  folder and project folder) ran an "Ask first" opencode agent on a cheap OpenRouter model: it read a file with its
  own tool and called dashboard tools through the bridge; a file change and a command came to Needs you; a No went
  back as its reason; a second message resumed the session; a message sent mid-turn showed as read while it worked
  and changed the answer; Stop interrupted a 60-second command within about two seconds. Not checked live: the
  interactive terminal.
- **Found by the live check:** refusing one question makes opencode refuse every question still open in that
  session. The others then stayed in Needs you, answering nothing. `withdrawApprovals` (`server/approvals.ts`) now
  takes those back when `permission.replied` names a question we didn't answer.

### What the live probes settled (10–11 November, opencode 2.2.7)

Probed by hand against the real server, with free models and then a cheap OpenRouter model (well under one cent in all):

- A server is ready in about 0.25–0.5 s and ends in about 0.3 s once its stdin closes, so one per run is fine.
  `--port 0` gives each its own port (without it, it takes 4096 and a second run would collide).
- Session ids must start with `ses`; prompt ids with `msg_`, and are unique across **all** sessions (a reused one
  answers 409). `POST /api/session` with an id that exists answers that session (no error). A missing session
  answers 404 `SessionNotFoundError`. A session made by one server is resumed by the next one.
- The config file adds to the user's: our `athena` agent, `{file:}` for its system text, `default_agent` and our
  MCP servers all work. **Our agent's permission rules beat a project `opencode.json` that allows everything.**
  `dashboard_*` works as a wildcard action. A read outside the workspace asks `external_directory` with the folder
  as `C:/…/folder/*`; a `.env` read asks `read` with the relative name `.env`.
- MCP tools are named `<server>_<tool>` (`dashboard_ping`), get their `environment`, and with `codemode: false` show
  as plain tool calls.
- Tool names come from `session.tool.input.started` (`session.tool.called` has only the input).
- A steered message's `session.inbox.delivered` carries the id we gave it: that is "it read it". An unread one can
  be taken back with `DELETE /api/session/{id}/inbox/{inboxID}`.
- `POST …/interrupt` stops a running shell at once (`session.tool.failed` "aborted", then
  `session.execution.interrupted` with reason `user`).
- Refusing a question with a message: the model reads the message and carries on.
- `session.step.ended`'s `input` excludes the cached part (`cache.read`); `reasoning` is separate from `output`.
- The free models share one quota: once it's used up, every run fails with `provider.free-limit` (429) until it
  refills. The engine shows that message as the run's error.
- The TUI has no `--agent` flag: our config's `default_agent` picks the athena agent.
- `opencode auth list --format json` lists providers with their connections, but plain commands may start the
  shared service, so the status doesn't call it (free models work without signing in anyway).

## What we want

An agent's engine can be **opencode**, next to Claude Code, Codex, Hermes, pi, oh-my-pi and OpenClaw. An
opencode agent:

- chats in the dashboard like the other CLI agents: text streams in, tool calls show, Stop stops it, the
  chat continues the same opencode session next time;
- runs on any model opencode is signed in to (`provider/model`), picked in the model picker;
- gets the dashboard tools and the agent's MCP servers;
- honours the agent's autonomy (Ask first / Auto / Full), with opencode's own permission questions coming to
  the dashboard's approvals (and so to the Brain) instead of being refused;
- takes a message sent while it works into the turn (steering);
- opens in a terminal like the other CLI agents;
- reports tokens, cost and how full its context is.

## opencode 2.x in short

What matters here (from its docs, its OpenAPI file and its source, checked 10 November):

- **Install:** `npm i -g @opencode/cli` (or `bun install -g --trust @opencode/cli`). The command is
  `opencode`; `opencode --version` prints `opencode v2.2.7`. The old 1.x package (`opencode-ai`) installs the
  same `opencode` command, so the version decides whether we can use it. No winget/scoop/choco.
- **Two ways to drive it headless:**
  - `opencode run --format json`: one prompt, NDJSON out (`text`, `reasoning`, `tool_use`, `step_start`,
    `step_finish` with cost and tokens, `retry`, `error`, `background_wait`). Its permission questions are
    either all approved (`--auto`) or all refused. No way in for a message sent while it works.
  - `opencode serve --stdio`: a server on 127.0.0.1 that prints one line, `{"url":"http://…"}`, and stays up
    until its stdin closes. HTTP Basic auth (user `opencode`, password from `OPENCODE_PASSWORD`). JSON
    routes under `/api` answer `{ data }`. The ones we need:
    - `POST /api/session` `{ id?, agent?, model?: { providerID, id, variant? }, location?: { directory }, permissions? }`
    - `POST /api/session/{id}/prompt` `{ text, files?: [{ uri, name? }], delivery?: 'steer' | 'queue' }`
      — returns at once; the work shows on the event stream
    - `POST /api/session/{id}/interrupt`
    - `GET /api/session/{id}/message`, `GET /api/model`, `GET /api/info`
    - `POST /api/session/{id}/permission/{requestID}/reply` `{ decision: 'once' | 'always' | 'reject', message? }`
    - `GET /api/event?types=…`: server-sent events, live only (no replay; a slow reader is dropped). Each is
      `{ id, created, type, location, data }`. The ones we read: `session.text.delta`,
      `session.tool.called|success|failed`, `session.step.ended` (`cost`, `tokens: { input, output,
reasoning, cache: { read, write } }`), `session.execution.started|succeeded|failed|interrupted`,
      `session.status`, `session.idle`, `session.compaction.started|ended|failed`, `permission.asked`.
- **The shared background service is a trap.** Plain `opencode …` commands find or start one shared service
  that does **not** see the caller's environment (config, keys). We always run our own server
  (`serve --stdio`) and give the terminal `--standalone`.
- **Config:** `opencode.json(c)` from `~/.config/opencode`, the project tree and `.opencode/` folders, plus
  `OPENCODE_CONFIG` (a file) and `OPENCODE_CONFIG_CONTENT` (inline JSON, with `{file:…}` / `{env:…}`
  substitution). 2.x keys: `permissions` (an ordered list of `{ action, resource, effect: allow | ask | deny }`,
  last match wins, no match means ask), `mcp.servers` (`{ type: 'local', command: [...], environment }` or
  `{ type: 'remote', url, headers }`), `agents` (`{ mode, description, model, system, permissions, steps }`),
  `providers`, `instructions`, `skills`, `compaction`. Permission actions: `read, edit, glob, grep, shell,
subagent, skill, webfetch, websearch, external_directory, question, execute`, and MCP tools as
  `<server>_<tool>`.
- **Logins live in its SQLite database** (`~/.local/share/opencode/opencode.db`, also on Windows), with its
  sessions. `opencode auth login` needs a terminal. A saved login beats an API key in the environment.
- **Instructions and skills:** it reads `AGENTS.md` (not `CLAUDE.md`) up from the workspace, and skills from
  `.opencode/skills`, `.claude/skills`, `.agents/skills` and their home-folder twins.
- **Compaction is its own** (automatic near the limit, events tell us). We don't manage its memory, the same
  as Claude Code.
- **Windows:** its shell tool uses Git Bash or PowerShell 7. Known open issues: console windows flashing
  (#52266), an empty git repo resolving to `C:/` (#59889), and a malformed nested shell command linked to
  deletions outside the workspace (#63151). The last one is why Auto keeps `external_directory` on ask.

## The approach: one `opencode serve --stdio` per run

We drive opencode through its server, not `opencode run`. Only the server gives us steering, permission
questions we can answer, a clean interrupt and structured usage. Each run starts its own server, like pi
starts one `pi --mode rpc` per message:

- the run's config (the agent's brief, the bridge with the run's id, the agent's MCP servers, the autonomy
  rules) lives only in that process, so two agents never share it;
- closing its stdin ends it, so a crashed dashboard leaves nothing behind;
- the session lives in opencode's own database, so the next run resumes it by id.

Startup cost was the risk: measured on Windows, a server is ready in under half a second, so one per run it is.

We keep opencode's own database (we don't set `OPENCODE_DB`): its logins are in there, and the user can open
the dashboard's sessions in their own opencode.

## How a run goes

1. Check `opencode` exists and is 2.x. If it's 1.x: "This is opencode 1.x. Update it to 2.x:
   npm i -g @opencode/cli".
2. Write the run's config file and the brief to `dataPath('runtime', <agentId>)` as `opencode-<runId>.json`
   and `.md` (see below).
3. Spawn `opencode serve --stdio --port 0` in the agent's workspace with `OPENCODE_CONFIG=<that file>` and
   `OPENCODE_PASSWORD=<random>`. Read the `{"url"}` line (fail after 30 s with the end of its stderr).
4. Open `GET /api/event` **before** prompting (its first event is `server.connected`), and keep only events for
   this session.
5. If the agent names a model or an effort, read `GET /api/model` once: the variant nearest the effort, and the
   model's context window. New chat: `POST /api/session` with our own `ses_…` id (saved on the chat at once),
   `agent: 'athena'`, the model and `location.directory`. A chat with a session: `GET` it; gone (or not an
   opencode id): clear `chat.sessionId`, set `chat.reseed` and throw `SessionGone`. A session on another model
   moves with `POST /api/session/{id}/model`.
6. `POST /api/session/{id}/prompt` with a new `msg_…` id and the text (attachments are named in the text, as
   for the other CLI engines).
7. Turn events into `RunEvent`s until `session.execution.succeeded | failed | interrupted`:
   - `session.text.delta` → `text` (and the answer); a new text part starts a new paragraph, as pi does;
     `session.text.ended` without deltas gives the whole text;
   - `session.tool.input.started` names a tool, `session.tool.called` → `tool`, `success | failed` →
     `tool_result` (with `data:image/…` pictures);
   - `session.step.ended` → the run's tokens, cache reads and cost; the last step's total is the context;
   - `session.compaction.*` → a status and `compacted`; `session.retry.scheduled` → "Trying again";
   - `permission.asked` → an approval (below);
   - `session.execution.failed` → the run's error.
8. Stop: `POST /api/session/{id}/interrupt`; the stream is closed a few seconds later either way.
9. Always: close stdin (killed after 5 s if it doesn't go), delete the two files.

The stream ending before the turn does (the server died) is an error with the end of its stderr.

## The run's config

One JSON file, layered on top of the user's own opencode config:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "agents": {
    "athena": {
      "mode": "primary",
      "description": "<agent name> from Athena Agents",
      "system": "{file:<runId>-brief.md}",
      "permissions": [ /* from autonomy, below */ ]
    }
  },
  "default_agent": "athena",
  "mcp": {
    "servers": {
      "dashboard": { "type": "local", "command": ["<bun or node>", "<BRIDGE_SCRIPT>"],
                     "environment": { "DASH_PORT": "<PORT>", "DASH_DATA": "<DATA>", "DASH_AGENT": "<agentId>", "DASH_RUN": "<runId>" },
                     "codemode": false, "timeout": { "execution": 3600000 } },
      "<agent's other servers>": { … }
    }
  }
}
```

- The internal token is **not** in the file or the environment: the bridge reads `.internal-token` from
  `DASH_DATA` itself when `DASH_TOKEN` is unset (as pi's and Codex's bridges already do).
- Secrets of the agent's MCP servers (headers, env) go only in this file (in `DATA`, removed after the run),
  never in opencode's environment: its shell tool would hand that environment to every command it runs.
- `codemode: false` for the dashboard bridge so the dashboard's tools show as plain tools with their own
  names in the chat. To check: whether code mode is better for the agent's other servers.

### Autonomy → permissions

Rules are in order, last match wins:

| Autonomy  | Rules                                                                                                                                                          |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full      | allow `*`; deny `question`                                                                                                                                     |
| Auto      | allow `*`; ask `external_directory`; ask `read` of `.env*`; allow `external_directory` for the uploads folder and the agent's knowledge roots; deny `question` |
| Ask first | allow `read`, `glob`, `grep`, `skill`; ask `edit`, `shell`, `execute`, `webfetch`, `websearch`, `subagent`, `external_directory`; deny `question`              |

All three allow `dashboard_*`: the dashboard asks for its own tools itself. Ask first leaves the agent's other
MCP servers on ask, as Claude Code's `--allowedTools` does. `question` (opencode asking the user mid-turn) is
denied the way Claude Code's `AskUserQuestion` is: the dashboard's `ask_user` tool does that job.

### Its questions come to the dashboard

`permission.asked` (`{ id, action, resources, message }`) becomes `requestApproval({ kind: 'opencode', title,
detail, agentId, agentName, data })`. The title says what it wants in plain words ("Coder wants to run a
command", "… work outside its folder") and the detail shows the command or paths. Yes replies `once`; No replies
`reject` with the reason, so the model carries on without it. Always allow keeps `opencode:<action>` in the
agent's `alwaysAllow` (the dashboard, not opencode's saved permissions, remembers it). The Brain reviews these
like any other tool approval.

## Steering

A message sent while it works goes in with `POST …/prompt { id, delivery: 'steer' }` (`saysWhenRead: true`):
`session.inbox.delivered` with that id shows it in the chat where it was read. One sent before the run's own
message is in goes the ordinary way. When the turn ends, the engine stops taking messages and takes each unread
one back out of opencode's inbox (`DELETE …/inbox/{id}`): it then goes next, the ordinary way. One opencode had
already taken in (the delete fails) starts its next turn, and the run follows that turn to its end too (for up to
30 s waiting for it to start).

## Models and effort

- The models tab lists `GET /api/model` (with a short-lived server, cached a minute like pi's list), shown as
  `provider/model`, with the context size from each model's limit. Empty model means opencode's own default.
- Effort maps to a model variant only when the model has one with that name (`low`, `medium`, `high`…);
  otherwise it's left out. `shared/effort.ts` gets `opencode` with the levels its variants usually have.
- `server/context.ts`: an overhead of about 10k tokens; the window comes from the model's limit, 128k when
  unknown.

## The terminal

`opencode --standalone` in the workspace, with `OPENCODE_CONFIG` pointing at a terminal config file (same shape,
no run id, kept while the terminal is open); `default_agent` picks athena (the TUI has no `--agent`).
`--standalone` matters: without it the TUI would talk to the shared service, which never sees our config.

## Settings and status

- `EngineStatus['opencode']`: `{ installed, path, version, tooOld }` — `cliStatus('opencode')` with the
  version's `v` stripped, `tooOld` below 2.0.0. No sign-in check: its free models work without one, and
  `opencode auth list` may start the shared service.
- Settings › General gets an opencode card next to pi's: "npm install -g @opencode/cli", then "Its free models
  work right away. To use your own accounts, run opencode auth login in a terminal." A 1.x install shows
  "needs an update".
- The engine list: _opencode — The opencode agent on this PC: coding, shell and files on its free models or any
  provider you signed in to, plus the dashboard tools. Asks before risky steps unless the agent runs on Full._

## Everything else that names engines

From where `omp` and `openclaw` appear today:

- `shared/types.ts` (`EngineId`, `EngineStatus`), `shared/api/agents.ts` and `shared/api/settings.ts` (the enum
  and the "Choose an engine" wording), `shared/effort.ts`
- `server/engines/index.ts` (`ENGINES`, `ENGINE_LIST`, `engineStatus()`), `capabilities.ts` (native),
  `server/library.ts`, `server/models.ts` (provider, own default, install check, list, overseer wording),
  `server/overseer.ts`, `server/context.ts`, `server/terminals.ts`, `server/programs.ts`,
  `server/api/status.ts` (the Orca skill's table of agents is left alone: Orca's id for opencode isn't known)
- `web/core.ts` (`ENGINE_LABEL`), `web/agentstats.ts`, `web/engineavailability.ts`, `web/models.tsx` (tab and
  body), `web/views/agents.tsx`, `settings.tsx`, `setup.tsx`, `programs.tsx`, `terminals.tsx`, `station.ts`
  (the engine palette), `web/app.ts` (the status line), `web/brandimages.ts` + `web/programicons.ts`
- `public/brand/engines/opencode.svg` (and a dark one if needed), with its source in that folder's README
- `library/athena-agents/README.md` if the engine list is written there

## Files

| File                                         | What                                                                                                                 |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `server/engines/opencode.ts` (new)           | status, the run's config, the server's start and end, the event reader, permissions, steering, models, terminal args |
| `tests/server/opencode-engine.test.ts` (new) | below, with its fake `opencode serve --stdio` (a small HTTP server speaking the routes and events we use)            |

No new dependency: the routes we need are few, and `@opencode/client` would tie us to its release pace. If the
API keeps moving (its API page still calls it experimental), we revisit.

## Tests

With a fake server (spawned in place of `opencode` the way `pi-engine.test.ts` fakes pi):

- the config per autonomy: the rules, the brief by `{file:}`, the bridge without a token, the agent's MCP
  secrets in the file and not in the environment;
- a run: text, a gap after a tool, tool calls and results with images, usage and cost, context, the answer;
- a new chat's session under our id; a missing session (or another engine's id) clears it and reseeds; a
  session on another model moves;
- a `permission.asked` goes to approvals; yes replies `once`, no replies `reject` with the reason, Always allow
  isn't asked again;
- Stop interrupts, then the server ends;
- a steer goes in with `delivery: 'steer'` and shows when read; one unread at the end comes back out of the inbox;
  one already taken in is followed into the next turn;
- the version parses from `opencode v2.2.7`; the files are removed after a run;
- the existing lists of engines (`library`, `effort`, `brain-models`, `rpc-agents`' error text, `tool-scope`,
  `groupD-pickers`, `settings-general`, `brand`, `programicons`).

Then a live check on the dev PC (opencode 2.2.7) with `scripts/try-agent.ts`: a plain answer, a file edit on
Ask first (approve and refuse), a dashboard tool, Stop mid-command, a steer, a second message resuming the
session. No paid model needed if opencode's free models are available; otherwise one cheap model.

## Building it, in order

The live probes answered the open questions before any code was written, so the engine went in as one piece:

1. **The engine** (server side, registered everywhere the server names engines), with its tests.
2. **The page**: Settings, the model picker, the agent editor, the status line, the Station, Programs,
   Terminals, the approval label, the mark.
3. **Docs and the live check**: README and `docs/guide.md`, a run with `scripts/try-agent.ts`, `bun run check`.

Each step is its own commit, and the whole is one PR.

## Left open

- Attachments go as paths in the text (as for pi); sending pictures as `files` (file URIs) would let a vision
  model see them directly.
- Whether code mode suits the agent's other MCP servers better (they keep opencode's default).
- A `.opencode/` folder in the workspace with its own _agent_ named `athena` would meet ours; not handled.
- `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS` is left unset: an opencode agent sees `~/.claude/skills` as Claude Code
  agents do.

## Decisions

- **2.x only.** 1.x has a different API, config and storage; supporting both doubles the work for a version
  that's on its way out.
- **Its own server per run, not `opencode run`.** Only the server gives us steering and real approvals.
- **Never the shared service.** It doesn't see our config or keys.
- **The user's opencode database.** Their logins are there; a separate one would mean signing in twice.
- **No SDK dependency.** A handful of routes, read with `fetch`.
