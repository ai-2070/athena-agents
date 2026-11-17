# Scene look: plan

A third look for the Station, next to the classic map and the voxel world: a **scene**, an HTML page that draws the
whole Station in its own way (three.js, WebGPU, a 2D canvas, anything a browser runs). The Brain's orb, the teams and
the agents become part of that page: coral reefs and fish in an underwater garden, planets around a sun, desks in a
cyberpunk loft. Athena sends the page the Station's state and live events; the page sends back what the user clicked.

Agents write the scene, like they build the voxel world: the user asks "make the Station an underwater garden" and a
builder writes the page, looks at a picture of it, and fixes it.

Status: Phase 1 built (see As built). Written 17 November 2026; the same day, agents moved to editing the files directly
(§6, §6c) and the versions moved out of the project folder (§3a).

## As built

- **Phase 1** (a scene you can see, and nothing lost). Where it differs from the plan below:
  - The folder is looked at once a second (paths, sizes, times), not watched with `fs.watch`: the same on every
    system, it sees the folder being made, and it is cheap for a folder of at most 400 files.
  - The scene's policy allows `connect-src` to its own files and the scene library (and `data:`/`blob:`), not
    `'none'`: three.js loads models and textures with `fetch`. Every directive names the scene's own address
    (`http://<host>/scene/<token>/`) and `/scene-lib/`, so nothing else on this server or anywhere else is reachable.
  - The helper also stands in for `localStorage`/`sessionStorage` when it can (so scenes like abyssal-garden that
    use it don't throw), besides `Athena.store`.
  - A new version takes the shown one's place when it says `ready`; the old one stays loaded, out of sight, for the
    5 seconds in which an uncaught error still counts as "doesn't load", and comes back if the new one breaks.
  - The bar sits at the top left (the side panel covers the right, and "Ask the Brain" the bottom). The map's zoom
    buttons are hidden in the scene look.

Inspiration: [abyssal-garden](https://github.com/Noniv/abyssal-garden) (see §10).

## Decisions

- **Agents edit the scene's files directly**, with the file tools they already have (Claude Code's Read/Edit/Write,
  Codex's patches, the built-in `read_file`/`edit_file`/`write_file`). They are better at that than at any tool we'd
  add: small edits, several files, grep. The scene tools only do what file tools can't: pictures, load checks, versions
  (§6).
- **No approvals for scene changes.** A builder changes a scene many times in one go, and the scene runs sandboxed
  (§4), so asking each time only gets in the way. File writes inside the scene folder and the scene tools never ask
  (§6c). This is a deliberate exception to "anything that runs code is `high`" in `AGENTS.md`; the code says why in a
  comment.
- **The real danger is a broken scene that is hard to put back**, so every change is kept as a version (taken by
  watching the folder, whoever wrote to it), the Station never shows a broken scene in place of a working one, and
  going back is one click or one tool call (§3). The versions live where agents' file tools can't reach them.

---

## 1. Goals and non-goals

Goals:

- `StationLook` gets a third value, `'scene'`. Each project has its own scene (like its background and its world).
- The scene shows the Station live: who is working, who needs you, team handoffs, the Brain thinking.
- Clicking or right-clicking something in the scene opens the same side panel and menu as on the map.
- Agents (and the Brain) can write, look at and debug a scene with tools, without approvals.
- Nothing is lost: any earlier version of a scene can be brought back, whoever or whatever changed it.
- A scene runs **fully sandboxed**: it can't reach the API, the user's files, secrets or the network.

Non-goals (for now):

- Mixing a scene with the classic map or the voxel world in one picture. In the scene look, the scene draws
  everything 3D.
- Scenes from the internet. A scene is files in the project folder; the user or an agent puts them there.
- Running a scene outside the Station page (its own window, the remote app).

---

## 2. Where it lives

- Files: `<project>/.dashboard/scene/`, with `index.html` as the entry and any assets next to it (JS, CSS, images,
  models, fonts, audio). Size limits per file and in total (start at 8 MB a file and 32 MB in all, like the
  background's own limit).
- Versions: in the data folder, `projectData(<project>, 'scene-history')`, not in the project folder (§3a).
- Backups (`server/backup.ts`) take the scene and part of its history (§3a). Restoring a backup brings the scene back
  as a new version; `BackupRestoreResult` gets `scene: boolean`.
- `Project` gets `sceneAt?: number | null` (when the scene last changed; null = none), added by the server like
  `backgroundAt`, so open tabs reload the scene when it changes.
- Settings › Appearance › Station look: "Classic", "World", "Scene". "Scene" without a scene in this project shows the
  starter (§7) with a note on how to make one.

---

## 3. Versions and recovery

In `server/scene/history.ts`. The same idea as `server/versions.ts` for agents and teams, but for a folder of files.

### 3a. Every change is kept

- **Store.** `scene-history/blobs/<sha256>` holds each file's content once; `scene-history/versions/<id>.json` is one
  version:

  ```ts
  interface SceneVersion {
    id: string;
    at: number;
    /** who changed it: an agent or the Brain (with its run), the user restoring, or something outside Athena */
    by: { kind: 'agent' | 'brain' | 'user' | 'outside' | 'backup'; id?: string; name?: string; runId?: string };
    note?: string; // "Restored the version from 3:05 pm", "Changed while Athena was closed"
    files: Record<string, { hash: string; size: number }>;
    /** how it loaded in the Station (§3b); missing: not loaded yet */
    loads?: 'ok' | 'broken';
    error?: string;
    pinned?: boolean;
  }
  ```

  A version that changes one file costs only that file. Taking a version means hashing the folder (32 MB at most).

- **When a version is taken.** Agents write the files with their own file tools, and the user can edit them in an
  editor, so versions come from watching the folder, not from a tool:
  - The server watches `.dashboard/scene/` (`fs.watch`, recursive, debounced 1.5 s) while the project is open, and
    takes a version whenever the folder differs from the newest version. The debounce turns an agent's quick run of
    edits into one version; a version caught half-way through is harmless, because a broken version never takes over
    the Station (§3c). No watching outside open projects.
  - `scene_restore` and the user's "Go back to this" take one at once (no wait for the watcher).
  - On start and when a project opens: if the folder differs from the newest version, take one ("Changed while Athena
    was closed").
  - The first time a project has a scene and no history: take one ("As found").
  - `scene_check` (§6) takes one at once if the folder changed since the newest, so a builder never waits for the
    debounce.
- **Who made it.** A file write by a built-in tool is known exactly (the tool tells the history which agent and run
  wrote which file). An edit by Claude Code, Codex or the user is seen only as a change in the folder; it is put on the
  runs going on in that project at the time (`by.kind: 'agent'` with the run when there is exactly one, else
  `'outside'` with the runs listed in `note`).
- **Grouped by run.** Versions carry `runId`, so the list reads "Coral garden builder, 14 changes, 3:05 pm" and can go
  back to before a whole run.
- **Keeping.** The last 200 versions; the newest version that loads, of each of the last 30 days; every pinned
  version; and always the newest version that loads. Blobs no version uses are deleted when pruning. Over 200 MB, the
  oldest unpinned versions go first.
- **Where.** In the data folder (`projectData(<project>, 'scene-history')`), through `store.ts`. Not in the project
  folder: an agent whose workspace is the project's folder may write anywhere in it, `.dashboard/` included, so a
  history there could be damaged by the same careless edit it is meant to undo. It also stays out of the user's git
  repo. Backups take the current scene, the newest version that loads, pinned versions and the last 20 (within the
  backup's limits), so a project moved to another computer through a backup keeps them. The project folder's auto-save
  (`server/projectsync.ts`) carries only the scene itself.

### 3b. Knowing which versions work

- **The iframe loads a version, never the live folder.** The URL is `/scene/<token>/v/<version id>/index.html`, and
  the files come from that version's blobs (immutable, cached). So a tab knows exactly what it loaded, a write in the
  middle of a load can't mix two versions, and any old version can be shown at once.
- The tab reports how each version loaded: `rpc.scene.loaded({ project, version, loads, error })`.
  - `ok`: the scene sent `ready` and had no uncaught error in its first 5 seconds.
  - `broken`: no `ready` within 10 seconds, or an uncaught error before `ready`. `error` is the first error, with its
    file and line.
  - Errors after that don't mark a version broken; they go to the logs (§6b).
- The first answer wins; the server stores it on the version and emits `scene` so other tabs know.

### 3c. A broken scene never takes over the Station

- When the newest version is broken, the Station shows **the newest version that loads** instead, with a quiet bar:
  "The latest change to this scene doesn't load, so you're seeing the last version that worked. [Show the latest
  anyway] [Versions]". The files stay as they are: the builder may be in the middle of fixing it.
- No version has ever loaded: the starter (§7), with the same bar.
- A version that loads but then freezes the tab is the one thing this doesn't catch on its own. The tab watches for
  it (no `fps` message for 15 s while visible and not paused): it marks the version broken and falls back the same way.

### 3d. Going back

- **For builders** (§6): `scene_versions` lists versions (when, who, files changed, loads or broken, its error,
  pinned). `scene_restore { version, path? }` writes a whole version, or one file of it, back into the folder.
  `scene_versions { version, path }` gives that file's text as it was, so a builder can compare it with its own file
  tools and see what it broke.
- **For the user:** a "Scene versions" list, opened from the bar in §3c and from Settings › Appearance when Scene is
  chosen. Each version shows who and when, a green or red dot (loads / doesn't load), and buttons: "Go back to this",
  "Keep" (pin). Runs are grouped, with "Go back to before this".
- A restore is itself a new version, so a restore can be undone. Restoring never deletes later versions.
- If the history folder is lost or damaged, the scene itself still works; history starts again from "As found".

---

## 4. Security

The scene is code an agent wrote. The concern here is less a malicious scene than a careless one, but the boundary is
cheap and keeps it that way. If a scene ran in the app's origin, its JavaScript would be same-origin: it could send
`x-dash: 1`, pass the `Sec-Fetch-Site` check and call every route. So:

1. **Sandboxed iframe, opaque origin.** `<iframe sandbox="allow-scripts">`, **never** `allow-same-origin`,
   `allow-top-navigation`, `allow-popups`, `allow-forms` or `allow-modals`. The scene gets an opaque origin (`null`).
2. **Its own route and policy.** The scene is served from `/scene/<token>/v/<version>/...` (a non-JSON route in
   `server/index.ts`, handler in `server/scene/serve.ts`) with:

   ```
   content-security-policy: sandbox allow-scripts; default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval';
     style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:;
     connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'
   ```

   The `sandbox` in the header means the page is sandboxed even if someone opens its URL directly.
   `connect-src 'none'`: no fetch, XHR, WebSocket or EventSource, so nothing can be sent out or asked of the API.
   Assets load as images, scripts and styles, which `'self'` allows. (Inline scripts are allowed: scenes are often
   one file, and the sandbox, not the CSP, is what keeps the scene in.)

3. **An unguessable token in the path.** Module scripts loaded from an opaque origin are cross-origin requests, so the
   scene's files need `access-control-allow-origin: *`. That would let any website the user visits read them by
   guessing the URL, so the path carries a random token instead of the project id: the page asks
   `rpc.scene.open({ project })` for one, the server maps it to that project's history and forgets it when the server
   restarts. The token gives read access to that one project's scene versions only.
4. **Only files of the version.** Paths are looked up in the version's file list, never on disk, so `..`, absolute
   paths and symlinks can't reach anything. Only known file types, served with their real content type and `nosniff`.
   (When taking a version, the folder is read without following symlinks out of it.)
5. **Messages from the scene are untrusted.** Every message is checked with zod (`shared/scene.ts`), ids must be ones
   the host sent, text is capped, and messages are rate-limited (e.g. 60 a second; `log` 20 a second). Anything else
   is dropped.
6. **What the scene is sent is the least it needs** (§5): names, emoji, colours, statuses and the short "now" text
   the map already shows. No chat text, no file contents, no settings, no tokens.

Leftover risk to note in the docs: CSP doesn't block WebRTC in every browser, so in theory a scene could send data
over a peer connection. It only has what §5 sends it, and the user or their agent put it there. Check whether the
`webrtc 'block'` directive is supported in WebView2 and Chrome when building, and add it if so.

To check while building: WebGPU inside a sandboxed, opaque-origin iframe served from `127.0.0.1` (Chrome, Edge,
WebView2 in the desktop app). `localStorage` throws in an opaque origin: the helper (§7) gives scenes a small
in-memory store instead, and the docs say so.

---

## 5. The protocol (`postMessage`, versioned)

Types and zod schemas in `shared/scene.ts` (ES2023, no DOM types). Every message is `{ athena: 1, type, ... }`.
The host posts to `iframe.contentWindow` with target origin `'*'` (an opaque origin can't be named) and only reads
messages whose `event.source` is that iframe's window.

### Athena → scene

| Message  | When                                    | What it carries                                                                                          |
| -------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `hello`  | once, after `ready`                     | protocol version, theme (`light`/`dark`), accent colour, reduced motion, quality (`low`/`medium`/`high`) |
| `state`  | after `hello`, then whenever it changes | the whole snapshot below (debounced, at most 4 a second)                                                 |
| `event`  | live                                    | one thing that happened, for animation (below)                                                           |
| `theme`  | when it changes                         | same fields as in `hello`                                                                                |
| `select` | when the side panel opens or closes     | what it shows (`{ kind, id }` or null), so the scene can highlight it                                    |
| `pause`  | Station hidden, tab hidden              | scene should stop its loop; `resume` starts it again                                                     |
| `look`   | a builder asked for a picture (§6a)     | a request id and size; the scene answers with `capture`                                                  |

The snapshot:

```ts
interface SceneState {
  project: { id: string; name: string };
  brain: { status: 'idle' | 'thinking' | 'needs'; name: string };
  teams: {
    id: string;
    name: string;
    color: string; // #rrggbb
    emoji?: string;
    members: string[]; // agent ids, in order
    lead?: string;
    working: string[];
    queued: string[];
  }[];
  agents: {
    id: string;
    name: string;
    emoji: string;
    color: string;
    engine: string; // 'claude', 'codex'… for a mark, never for logic
    status: 'idle' | 'working' | 'needs';
    now: string; // "Reading files…", what nowText() gives the map, capped at 120 characters
    teams: string[];
  }[];
  needsYou: number; // the Needs you count
}
```

Events (each with `at`, a timestamp):

- `run-start` / `run-end` `{ agentId, ok? }`
- `tool` `{ agentId, label }`: the `describeTool` text, not the arguments
- `handoff` `{ teamId, from, to }`: what `pulseHandoff` draws today
- `message` `{ teamId, from }`: someone said something in a team chat (no text)
- `needs` `{ agentId | 'brain' }`: an approval is waiting
- `brain` `{ status }`

### Scene → Athena

| Message   | What Athena does                                                                                         |
| --------- | -------------------------------------------------------------------------------------------------------- |
| `ready`   | sends `hello` and `state`; starts the 5-second check of §3b                                              |
| `pick`    | `{ kind: 'agent' \| 'team' \| 'brain', id? }`: opens the side panel through `choose()` (`MapPick`)       |
| `menu`    | the same plus `x`, `y` in the iframe: opens `openMenu()` at that point                                   |
| `hover`   | `{ kind, id } \| null`: lights the header's connections, like hovering the map                           |
| `capture` | `{ request, image }`: the answer to `look`, a PNG/JPEG data: URL (capped at 6 MB like `world_look`)      |
| `log`     | `{ level: 'error' \| 'warn' \| 'info', text }`: kept for `scene_logs` (§6b)                              |
| `fps`     | a number, every few seconds: the freeze check of §3c, and a lower quality is suggested when it stays low |

Later (§9): `anchors`, the scene's on-screen positions of things, so Athena can draw its own labels over it.

Unknown types are ignored, so scenes made for a newer protocol still mostly work.

---

## 6. Tools

Agents read and write the scene's files with their own file tools (§6c). The scene tools, in `server/scene/tools.ts`,
do only what file tools can't. They are wired up like `server/voxel/tools.ts`: given where the `world_*` tools are
given, with a prompt part (like `worldPrompt`) that says, in short:

> This project's scene is the folder `<absolute path>/.dashboard/scene/` (entry: `index.html`). Change it with your
> file tools. After a change, call `scene_check` and fix what it reports before you go on. Every change is kept:
> `scene_versions` and `scene_restore` bring back an earlier one. The protocol and the helper: (short version of §5
> and §7).

| Tool             | What it does                                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `scene_check`    | takes a version of the folder now if it changed, waits for an open tab to load it, and says how it went (below)           |
| `scene_look`     | a picture of the scene as the open Station shows it (§6a)                                                                 |
| `scene_logs`     | the scene's last errors and logs (the last 200, from the open tab), and whether a tab is showing it (§6b)                 |
| `scene_versions` | the scene's versions (§3d); with `version` and `path`, that file's text as it was then                                    |
| `scene_restore`  | writes a version, or one file of it, back into the folder (§3d)                                                           |
| `scene_use`      | turns the scene look on or off (`StationLook`, a setting for every project): only when the user asks, like `station_look` |

None of them asks for approval (see Decisions).

**`scene_check` answers with how it loads.** When a tab shows the scene, it waits (up to 12 s, like `world_look`) for
the load report of §3b and returns it: "Loads fine", or "Doesn't load: TypeError: … (index.html:212). The Station
shows the version from 3:05 pm instead; fix it, or scene_restore". It also says what it found wrong in the folder
without loading it: no `index.html`, an empty one, files over the limits of §2, file types the scene route won't serve.
With no tab showing the scene it says so (and still checks the folder).

The folder has no guards of its own: anything can be written there. The limits are kept by what Athena does with it.
The watcher doesn't take a version of a folder over the limits (it logs why, and `scene_check` says so), and the
scene route serves only the file types it knows.

### 6a. Pictures (`scene_look`)

The same way as `world_look` (`server/voxel/look.ts`): the server emits `scene-look` with a request id; a tab that
shows that project's scene sends `look` to its iframe; the helper renders a frame and answers `capture`; the tab posts
it to `rpc.scene.snapshot`. Tabs that don't show the scene answer "not shown here" so the server needn't wait. The
host can't capture the iframe itself (it's cross-origin), which is why the scene does it. When the Station is showing
an older version because the newest is broken (§3c), the picture says which version it is.

### 6b. Logs (`scene_logs`)

The helper forwards `window.onerror`, unhandled rejections and `console.error`/`warn` as `log`. The tab sends them on
to the server (`rpc.scene.log`, batched, rate-limited), which keeps a ring buffer per project in memory, each line
with the version it came from. A scene that sends no `ready` within 10 seconds gets a line saying so (most often: an
import failed).

### 6c. Reaching the folder, without approvals

Each engine gets the scene folder of the run's project (`withProject()`, never the active one), for agents that have
the scene tools. Only `.dashboard/scene/`, not the rest of `.dashboard/` (`project.json` and the other saved files):

- **Built-in tools** (`server/tools.ts`): `allowedRoots` gets the scene folder for reading and writing. `write_file`
  and `edit_file` (and deleting a file there) take their risk from their arguments (`RiskOf`, like `board_tags`):
  `none` inside a scene folder, `low` elsewhere as today. They also tell the history who wrote (§3a).
- **Claude Code** (`server/engines/claude.ts`): `--add-dir <scene folder>` when it isn't inside the workspace, and
  allow rules for it in `--allowedTools` (`Read`, `Edit`, `Write` on `<scene folder>/**`), so its "default" and
  "auto" modes don't send scene edits to the permission prompt. To check while building: the rule syntax for an
  absolute Windows path (Claude Code writes absolute paths in rules as `//c/Users/...`), and that a rule in
  `--allowedTools` is enough for edits outside the working directory.
- **Codex** (`server/engines/codex.ts`): in "auto" (workspace-write) the scene folder becomes a writable root
  (`-c sandbox_workspace_write.writable_roots=[…]`). "Ask first" runs Codex read-only today, so it can't write
  anywhere, the scene included. To check while building: whether "Ask first" can become workspace-write with only the
  scene folder writable, or whether Codex agents on "Ask first" just can't build scenes (and the prompt says so).
- **Other engines** (Hermes, Eve, opencode, pi) with their own file tools: the same, through each engine's way of
  adding a folder and allowing writes in it. An engine that can't be given one gets a short note in the prompt instead
  of the scene tools.
- **"Full"** agents already write anywhere; nothing changes for them.

**The Brain** only reads files on Claude Code and Codex ("changes go through its own tools", `server/engines/claude.ts`),
and that stays. It gets `scene_use`, `scene_look`, `scene_check`, `scene_versions` and `scene_restore`, and hands the
building to an agent: the Agent library gets a "Scene builder" agent. Today the Brain has JSON actions
(`server/overseer.ts`: `station_look`, `background`); the Brain-on-agent-tools change
(`BRAIN_ON_AGENT_TOOLS_2026-11-16.md`) turns those into tools. Whichever is in `main` when this is built:
`station_look` takes `"scene"`, and the Brain gets its scene tools the same way.

---

## 7. The helper, three.js and the starter

Served from `/scene-lib/` (public, the same for everyone, `access-control-allow-origin: *`):

- `three.module.min.js` and `addons/` at the exact version the app uses (copied from `node_modules/three` by
  `scripts/build-web.ts` into `public/dist/scene-lib/`; the desktop app gets it with `public/`). No CDN: the app works
  offline, and the scene's CSP wouldn't allow one anyway.
- `athena-scene.js`, the helper. A scene can talk the protocol by hand, but with the helper it is:

  ```js
  import { Athena } from '/scene-lib/athena-scene.js';
  Athena.onState((s) => {
    /* build or update teams and agents */
  });
  Athena.onEvent((e) => {
    /* animate a handoff, a tool call */
  });
  Athena.onTheme((t) => {
    /* light or dark */
  });
  Athena.setCapture(() => {
    renderer.render(scene, camera);
    return renderer.domElement.toDataURL('image/png');
  });
  // on click:
  Athena.pick('agent', id);
  Athena.ready();
  ```

  It also: forwards errors (§6b), handles `pause`/`resume` (`Athena.paused`, `Athena.onPause`), offers an in-memory
  `Athena.store` instead of `localStorage`, and reports `fps` from its own frame counter. A scene that doesn't use
  the helper must send `ready` and `fps` itself, or it counts as broken (§3b, §3c).

- A **starter scene** (`server/scene/starter/`), shown when a project has none (or none that loads) and copied in when
  an agent starts one: the Brain as an orb in the middle, a ring per team, a figure per agent at its desk, green when
  working, amber when it needs you, a pulse along the ring for handoffs, light and dark. About 300 lines, readable,
  commented, so agents learn the pattern from it.

The `athena` skill (`skills/athena/`) gets a page on scenes: the protocol, the helper, the rules (no network, no
`localStorage`, draw everything from `state`, keep ids, call `scene_check` after a change and fix or restore before
moving on), and a checklist (handles empty projects, many agents, light and dark, reduced motion, pause).

---

## 8. The Station in the scene look

In `web/views/station.ts` the change is small; the rest goes in a new `web/scene/host.ts`:

- `applyStationLook()` gets the `'scene'` branch: stop the three.js loop and hide its canvas (don't dispose it, so
  going back is instant), hide the map's labels and wires, and mount the iframe in `S.host` under the HUD.
- `host.ts` owns the iframe: gets the token, picks the version to show (§3c), builds `SceneState` from what the
  Station already has (`state.data`, `S.workflows`, `S.teamState`, `nowText()`), turns `onEvent` into `event`
  messages, listens for messages, reports how versions load (§3b), and calls back into the Station for `pick`, `menu`
  and `hover`.
- The header, feed, side panel, right-click menu, Needs you and the floor switcher stay the same.
- The background picture and its opacity don't apply in the scene look (the scene owns the whole picture). The
  Appearance panel says so.
- Pointer: the iframe takes clicks and the wheel itself; the Station's own map controls are off.
- Switching projects (the floor) loads that project's scene.
- A new version loads into a second, hidden iframe and takes the place of the shown one only once it has loaded
  (§3b). A broken version never replaces a working one on screen, not even for a moment.

---

## 9. Phases

### Phase 1: a scene you can see, and nothing lost

- `StationLook` `'scene'`, the setting (`shared/api/settings.ts` enum and its error text), the Appearance option.
- `server/scene/history.ts`: versions, blobs, the folder watcher, the checks on start and on opening a project,
  pruning, restore. (In Phase 1 already, because agents can edit the folder with their own file tools before the scene
  tools exist.)
- `server/scene/serve.ts`: the token route serving versions, the CSP, the CORS header. `rpc.scene.open`,
  `rpc.scene.loaded`, `rpc.scene.versions`, `rpc.scene.restore`, `rpc.scene.pin`.
- `/scene-lib/` with three.js and the helper; the starter scene.
- `shared/scene.ts`: the protocol types and schemas; `SceneVersion` in `shared/types.ts`.
- `web/scene/host.ts` and the Station's scene branch: `hello`, `state`, `theme`, `pause`, `pick`, `menu`, `hover`;
  load reports, the fallback bar, the swap through a hidden iframe; the Scene versions list.
- `sceneAt` on projects, the `scene` event, reloading.
- Tests:
  - history: a change in the folder is picked up by the watcher, once, and a quick run of edits makes one version; a
    folder over the limits makes no version; a change while the server was off is found on start; blobs are shared between versions; pruning keeps pinned versions and the newest
    one that loads, and deletes unused blobs; a restore is a new version and can be undone;
  - serving: the CSP (with `sandbox` and `connect-src 'none'`); unknown tokens and versions get 404; a version serves
    its own bytes after the folder changed; paths not in the version get 404; the token is not the project id;
  - shared: the schemas accept good messages and drop bad ones (wrong types, long text, unknown ids);
  - web: the host builds `SceneState` from Station data; ignores messages from other windows; turns `pick` into
    `choose()`; with a broken newest version it shows the newest one that loads, and the bar.
- Docs: `README.md` and `docs/guide.md` (the Scene look and its versions, in plain words).

### Phase 2: agents make scenes

- Reaching the folder without approvals, per engine (§6c): `allowedRoots` and the arguments-based risk of the
  built-in file tools; Claude Code's `--add-dir` and allow rules; Codex's writable root; the other engines.
- `scene_check`, `scene_look`, `scene_logs`, `scene_versions`, `scene_restore`, `scene_use`, and their prompt part
  with the folder's path.
- The Brain: `station_look` `"scene"`, its scene tools, and a "Scene builder" agent in the Agent library.
- `events`: `run-start`/`run-end`, `tool`, `handoff`, `message`, `needs`, `brain`.
- Backups take the scene and its history (§3a).
- The `athena` skill's scene page.
- Tests:
  - reach: an agent with the scene tools can read and write its run's project's scene folder (not another project's,
    and not the rest of `.dashboard/`); `write_file`/`edit_file` there are risk `none`, elsewhere `low`; the Claude
    Code and Codex arguments carry the folder and its rules;
  - history: a built-in tool's write is put on its agent and run; with one run going on, a change from outside is put
    on it;
  - `scene_check` reports "loads" and "doesn't load" from a tab, the folder's problems, and says when no tab shows
    the scene; `scene_look` with and without an open tab; the logs ring buffer; backup round trip with history.

### Phase 3: better scenes

- `anchors`: the scene reports where things are on screen, and Athena draws its own labels and hover cards over it
  (the same look as the map).
- A small picture of each version that loads (one `capture` after the first good load), shown in the versions list.
- `fps` → suggest a lower quality.
- Sample scenes in the Agent library or as templates: an underwater garden (teams as reefs, agents as fish that swim
  faster while working and rise with an amber light when they need you, the Brain as a glowing jellyfish), a solar
  system, a night city.
- Possibly a fork of abyssal-garden as one of them (§10).

---

## 10. About abyssal-garden

What it is (read 17 November 2026): a procedural underwater world in **raw WebGPU, not three.js**; no images, models
or sound files, everything made in code (terrain, ~2 million kelp leaves, rocks, corals, a sunken ship, manta rays,
fish, caustics, fog, synthesized audio). It ships as one minified `index.html` (~96 KB); the readable source is in
`source/src/` (`main.js`, `world.js`, `shaders.js`, `quality.js`, `audio.js`). MIT licence.

It has no way to be driven from outside: no `message` listener, no URL parameters, no globals. To use it as a scene:

- fork the source (keep the MIT notice), build it, and add the helper: draw teams, agents and the Brain as its own
  kind of creatures and places, and drive them from `state` and `event`;
- wrap its `localStorage` use (it throws in the sandbox);
- point its free-fly camera at a few set views, and make clicks pick things instead of locking the pointer;
- it needs WebGPU: fine in Chrome, Edge and the Windows desktop app; not in Firefox or on Linux desktop (WebKitGTK).
  The scene should say so instead of showing a black screen.

It's a good test of the protocol, because nothing in it was made for us. It shouldn't be part of Phase 1.

---

## 11. Open questions

- **Codex on "Ask first".** It runs read-only today, so it can't build scenes. Make an exception (workspace-write
  with only the scene folder writable, if Codex allows that), or leave it and say so in the prompt?
- **Labels.** Phase 1 lets the scene draw everything, names included. If scenes end up with labels that are hard to
  read, `anchors` moves up to Phase 2.
- **One scene per project, or a shared library of scenes** a project picks from (like a world can be shared between
  projects)? Start with one per project; a library can come later.
- **Audio.** Scenes like abyssal-garden make sound. Muted by default, with a toggle in the Station's header?
