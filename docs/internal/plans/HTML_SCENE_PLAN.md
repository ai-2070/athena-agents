# Scene look: plan

A third look for the Station, next to the classic map and the voxel world: a **scene**, an HTML page that draws the
whole Station in its own way (three.js, WebGPU, a 2D canvas, anything a browser runs). The Brain's orb, the teams and
the agents become part of that page: coral reefs and fish in an underwater garden, planets around a sun, desks in a
cyberpunk loft. Athena sends the page the Station's state and live events; the page sends back what the user clicked.

Agents write the scene, like they build the voxel world: the user asks "make the Station an underwater garden" and a
builder writes the page, looks at a picture of it, and fixes it.

Status: plan, nothing built yet. Written 17 November 2026.

Inspiration: [abyssal-garden](https://github.com/Noniv/abyssal-garden) (see §10).

## Decisions

- **No approvals for scene changes.** A builder changes a scene many times in one go, and the scene runs sandboxed
  (§4), so asking each time only gets in the way. The scene tools are risk `none`. This is a deliberate exception to
  "anything that runs code is `high`" in `AGENTS.md`; the tool definitions say why in a comment.
- **The real danger is a broken scene that is hard to put back**, so every change is kept as a version, the Station
  never shows a broken scene in place of a working one, and going back is one click or one tool call (§3).

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
- Versions: `<project>/.dashboard/scene-history/` (§3).
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

- **When a version is taken.** Agents can change the files without our tools: Claude Code and Codex edit
  `.dashboard/scene/` with their own file tools, and the user can edit it in an editor. So versions don't depend on
  `scene_write` alone:
  - `scene_write` and `scene_restore` take a version right after the change, tagged with who made it.
  - The server watches the folder (`fs.watch`, recursive, debounced 1.5 s) while the project is open, and takes a
    version whenever the folder differs from the newest version, tagged `outside` (with the agent and run when one of
    its runs in that project was writing at the time). A tool write leaves nothing new to see, so it isn't taken
    twice. No watching outside open projects.
  - On start and when a project opens: if the folder differs from the newest version, take one ("Changed while Athena
    was closed").
  - The first time a project has a scene and no history: take one ("As found").
- **Grouped by run.** Versions carry `runId`, so the list reads "Coral garden builder, 14 changes, 3:05 pm" and can go
  back to before a whole run.
- **Keeping.** The last 200 versions; the newest version that loads, of each of the last 30 days; every pinned
  version; and always the newest version that loads. Blobs no version uses are deleted when pruning. Over 200 MB, the
  oldest unpinned versions go first.
- **Where.** In the project folder, so it moves with the project. Auto-save (`server/projectsync.ts`) doesn't touch it.
  Backups take the current scene, the newest version that loads, pinned versions and the last 20 (within the backup's
  limits). If the dashboard writes a `.gitignore` into `.dashboard`, `scene-history/` goes in it.

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

- **For builders** (risk `none`, §6): `scene_versions` lists versions (when, who, files changed, loads or broken, its
  error, pinned). `scene_restore { version, path? }` brings back a whole version or one file. `scene_diff { version,
path }` shows a file's changes against now, so a builder can see what it broke.
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

In `server/scene/tools.ts`, wired up like `server/voxel/tools.ts`: given where the `world_*` tools are given, with a
prompt part (like `worldPrompt`) that explains the protocol in short. None of them asks for approval (see Decisions).

| Tool             | What it does                                                                                                                                 |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `scene_list`     | the scene's files, sizes, when they changed                                                                                                  |
| `scene_read`     | one file's text (of now, or of a version)                                                                                                    |
| `scene_write`    | writes or replaces one file (text, or base64 for images), within the limits; `delete: true` removes one; then waits for how it loads (below) |
| `scene_look`     | a picture of the scene as the open Station shows it (§6a)                                                                                    |
| `scene_logs`     | the scene's last errors and logs (the last 200, from the open tab), and whether a tab is showing it                                          |
| `scene_versions` | the scene's versions (§3d)                                                                                                                   |
| `scene_restore`  | brings back a version, or one file of it (§3d)                                                                                               |
| `scene_diff`     | what changed in a file between a version and now                                                                                             |
| `scene_use`      | turns the scene look on or off (`StationLook`, a setting for every project): only when the user asks, like `station_look`                    |

Writes go through `store.ts` helpers into the project folder; each one takes a version (§3a), bumps `sceneAt` and
emits `scene`, so open tabs load the new version.

Guards in `scene_write`: no removing `index.html` and no empty `index.html`; text files must be valid UTF-8; the size
limits of §2.

**A write answers with how it loads.** When a tab shows the scene, `scene_write` waits (up to 12 s, like `world_look`)
for the load report of §3b and returns it: "Loads fine", or "Doesn't load: TypeError: … (index.html:212). The Station
shows the version from 3:05 pm instead; fix it, or scene_restore". With no tab showing it, it says so. A builder
writing several files in a row can pass `wait: false` on all but the last.

The Brain gets the same tools. Today it has JSON actions (`server/overseer.ts`: `station_look`, `background`); the
Brain-on-agent-tools change (`BRAIN_ON_AGENT_TOOLS_2026-11-16.md`) turns those into tools. Whichever is in `main` when
this is built: `station_look` takes `"scene"`, and the Brain gets `scene_*` the way agents do.

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
`localStorage`, draw everything from `state`, keep ids, read what `scene_write` says about loading and fix or restore
before moving on), and a checklist (handles empty projects, many agents, light and dark, reduced motion, pause).

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
  - history: a write takes a version; an edit from outside is picked up by the watcher, once; a change while the
    server was off is found on start; blobs are shared between versions; pruning keeps pinned versions and the newest
    one that loads, and deletes unused blobs; a restore is a new version and can be undone;
  - serving: the CSP (with `sandbox` and `connect-src 'none'`); unknown tokens and versions get 404; a version serves
    its own bytes after the folder changed; paths not in the version get 404; the token is not the project id;
  - shared: the schemas accept good messages and drop bad ones (wrong types, long text, unknown ids);
  - web: the host builds `SceneState` from Station data; ignores messages from other windows; turns `pick` into
    `choose()`; with a broken newest version it shows the newest one that loads, and the bar.
- Docs: `README.md` and `docs/guide.md` (the Scene look and its versions, in plain words).

### Phase 2: agents make scenes

- `scene_list`, `scene_read`, `scene_write` (with the load result), `scene_look`, `scene_logs`, `scene_versions`,
  `scene_restore`, `scene_diff`, `scene_use`, and their prompt part.
- The Brain: `station_look` `"scene"` and the scene tools.
- `events`: `run-start`/`run-end`, `tool`, `handoff`, `message`, `needs`, `brain`.
- Backups take the scene and its history (§3a).
- The `athena` skill's scene page.
- Tests: tool limits and refusals; `scene_write` reports "loads" and "doesn't load" from a tab, and says when no tab
  shows the scene; `scene_look` with and without an open tab; the logs ring buffer; backup round trip with history.

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

- **History in the project folder or in `data/`.** In the project folder (the plan) it moves with the project and
  survives a reinstall, but it makes the folder bigger and could end up in the user's git repo. In `data/` it stays on
  this computer. Leaning project folder, with a `.gitignore` entry.
- **Labels.** Phase 1 lets the scene draw everything, names included. If scenes end up with labels that are hard to
  read, `anchors` moves up to Phase 2.
- **One scene per project, or a shared library of scenes** a project picks from (like a world can be shared between
  projects)? Start with one per project; a library can come later.
- **Audio.** Scenes like abyssal-garden make sound. Muted by default, with a toggle in the Station's header?
