# AGENTS.md

Guidance for AI coding agents working in this repo. For what the app does from a user's point of
view, read `README.md`; `docs/guide.md` is the long version of it.

## What this is

**Athena Agents** (called Blacksite until the redesign; the server still finds project and backup folders made under that name): a local, login-free command center for AI agents. A Bun + TypeScript server
(`server/`) on `127.0.0.1:4800` and a browser app (`web/`) bundled into `public/dist`. All user
state is plain JSON under `data/` (git-ignored). Mainly used on Windows; CI also runs on Linux.

## Commands

```powershell
bun install
bun run dev          # hot reload for the page (Vite), restart the server on change; --no-hot: the bundle only
bun run typecheck    # tsc for server/ and web/ (two separate tsconfigs)
bun run lint         # Biome (lint only, the formatter is off); lint:fix applies its safe fixes
bun run test         # Vitest, server + web projects
bun run check        # typecheck + lint + test: run this before you call a change done
bun run build        # bundle web/ (and its Tailwind CSS) into public/dist
bun run icons        # regenerate web/icons.ts after adding names in scripts/build-icons.ts
bun server/index.ts --port 4900 --no-open   # a second instance that won't open a browser
bun scripts/try-agent.ts <agentId> "message" [--port 4800] [--approve]
bun run desktop:dev    # the desktop app (needs Rust); desktop:build makes installers
bun scripts/build-desktop.ts && bun run desktop:smoke   # run the bundled server the way the app does
```

Single test file: `bunx vitest run tests/server/skills.test.ts`.
CI (`.github/workflows/ci.yml`) runs typecheck, lint, test and build on ubuntu and windows. All four must pass.
Its "Desktop app" job also stages the desktop app, runs the smoke test and checks the Rust code, and its "Skill scripts"
job runs the tests of the scripts that come with the skills (`python -m pytest tests/skills`, Python 3.10, after
`pip install -r tests/skills/requirements.txt`).
`.github/workflows/desktop.yml` builds the installers (on `v*` tags, or by hand).

## Layout

| Path | What's in it |
|---|---|
| `server/index.ts` | The HTTP server: security checks, then the oRPC routes, then what isn't JSON (files, uploads, the OAuth callbacks, the MCP bridge's internal routes, with the `get`/`post`/`postFile` helpers), WebSocket, static files |
| `shared/api/`, `server/api/`, `server/rpc.ts` | Every JSON route, and the chats' AI SDK streams (event iterators of UI message chunks, `server/uistream.ts`), on oRPC (`docs/internal/plans/ORPC_PLAN.md`): each area's contract (zod for what comes in, `type<T>()` for what goes out), its handlers, and the handler `server/index.ts` asks first, after its security checks. Same addresses and `{ error }` answers as before. `tests/server/rpc-moved.test.ts` lists the routes `server/index.ts` keeps. `server/api/refuse.ts` refuses with a status (`refusing()` turns a domain function's plain errors into 400s); `rpcAt(at)` in `web/client/rpc.ts` calls inside a project that isn't open. A gateway's bodies go to `server/gateways/` as they came (`inputStructure: 'detailed'`): that code checks them itself |
| `server/store.ts` | JSON storage: settings, secrets, projects, `collection<T>()`, chats, the event `bus` / `emit()` |
| `server/engines/` | Engines that run agents: `claude.ts` (Claude Code CLI), `codex.ts`, `hermes.ts`, `eve.ts` (Eve with any OpenAI-compatible API); `index.ts` starts and stops runs |
| `server/eve/`, `runtime/eve/`, `runtime/eve-world/` | Eve bindings, input receipts, tool consent and event projection; the private Bun worker and its pinned local Workflow store. Eve owns the API loop and active compaction. `server/context.ts` estimates and admits full inputs; saved chat originals remain separate |
| `server/tools.ts` | Built-in agent tools, each with a `Risk` (`none` / `low` / `high`) that decides when approval is asked |
| `server/documents.ts`, `server/pdfworker.ts` | The text of PDF, Word, Excel and PowerPoint files for `read_file`, `read_document` and attached files (`uploads.ts`). Office files are unpacked within caps; a PDF is read by pdf.js (`unpdf`) in a thread of its own that is stopped when it runs too long. The worker imports nothing of the app's, and is its own entry in `scripts/build-desktop.ts` |
| `server/mcp-bridge.ts` | Gives the dashboard tools to Claude Code and Codex over MCP |
| `server/brain.ts`, `overseer.ts`, `teams.ts`, `learning.ts` | The Brain, approvals review, team chats, self-improvement |
| `server/projectsync.ts`, `backup.ts`, `versions.ts` | Auto-save into `<project>/.dashboard`, `.dashbackup` files, version history |
| `shared/` | Types and logic both sides import (`types.ts` is the source of truth for data shapes) |
| `web/` | Browser app. Every page in `web/views/` is React on Base UI (`reactPage()` in `web/ui/react.tsx`) except the Station's map and header (`station.ts`, three.js and plain DOM); its side panel (`stationpanel.tsx`) and right-click menu (`stationmenu.tsx`) are React, and `stationdata.ts` has what the map and panel share. The Brain chat, the floating chat window, its agent tabs and team chats are React too (`dock.tsx`, `chatwin.tsx`, `agentchat.tsx`, `teamchat.tsx`). The dialogs and the smaller pieces are React as well — the model picker (`models.tsx`), file previews (`filepreview.tsx`), the History and Backup windows, the MEMORY.md and schedule editors, the project windows (`projects.tsx`), the branch builder (`builder.tsx`), the attachment tray (`attach.tsx`) and the sidebar's Limits panel (`navlimits.tsx`) — and each gives plain-DOM callers the element it draws into. What still builds its own DOM with the `h()` helper in `web/core.ts` is the page shell (`app.ts`), the Station's map and header, and small helpers (`skillpick.ts`, `pastes.ts`, `chatcommands.ts`, `routinemention.ts`); a React page hosts one with `<DomNode>`. Agent chats are React (`web/chat/*.tsx`, Vercel AI SDK + OpenUI) |
| `web/ui/` | Base UI (`@base-ui/react`) pieces. `overlays.tsx` draws every dialog and toast: `modal()`, `confirmBox()`, `promptBox()` and `toast()` in `web/core.ts` call it with plain DOM. `react.tsx` mounts a React page (`mountReact`, `useAppState`, `Icon`); every React root comes from `createAppRoot` in `root.tsx` (a test checks), which puts a crash guard around it: a piece that throws while drawing shows a message with Try again instead of going blank; `controls.tsx` has `Tabs`, `Segmented` and `Chips` in the app's own classes; `dropdown.tsx` is the dropdown menu (ReUI's, on Base UI's Menu; the `.st-menu` classes in `components.css` are its look, and every floating menu shares them): the paperclip's menu (`web/attachmenu.tsx`) and the chat's "To" picker use it |
| `web/client/` | The page's only way to the server: addresses (`apiUrl`, `fileUrl`, `serverUrl`), typed calls (`rpc` in `rpc.ts`), file requests (`api`, uploads) and sockets. A test fails if other code writes `/api/`, `fetch(` or `new WebSocket(` |
| `web/views/` | One module per page (`station.ts` is the 3D map, three.js) |
| `server/voxel/` | The voxel world (`docs/internal/plans/VOXEL_WORLD_PLAN.md`): worlds on disk (`store.ts`), which world a project shows (`link.ts`), the build steps (`ops.ts`: shapes, shape and region tools, stamping and placing prefabs), building and undo (`build.ts`), prefabs and the prefab library (`prefabs.ts`), WORLD.md (`worldmd.ts`), the agents' tools (`tools.ts`), `world_script`'s sandbox (`script.ts`: QuickJS in WebAssembly, no files or network) |
| `web/voxel/`, `shared/voxel.ts`, `shared/worldenv.ts` | The world on the Station: voxel data and its encoding, times of day, the mesher and its worker (`mesh.worker.ts`, a second entry in `scripts/build-web.ts`), the voxel look's light and finishing passes (`view.ts`, `post.ts`), the world's objects on the map (`worldlayer.ts`). Loaded only when Settings › Appearance › Station look is "Voxel world" |
| `web/styles/` | Tailwind CSS 4. `app.css` is the entry (theme tokens, layers, keyframes), `base.css` styles bare elements and holds the dark-theme token overrides, `components.css` has the pieces used everywhere (`btn`, `card`, `pill`, `modal`, `md` for Markdown…). The build writes `public/dist/app.css` |
| `web/theme.ts`, `web/brand.ts`, `web/look.ts` | Light or dark (`isDark()`, `onThemeChange()`, `themeColor()`), the Athena helmet mark, and Settings › Appearance (the accents, each with a light and a dark tone) |
| `public/` | `index.html`. `public/dist` is build output, never edit it |
| `scripts/dev.ts`, `scripts/vite-dev.ts`, `server/devpage.ts` | `bun run dev`: a Vite dev server (on this machine, handing out only `web/`, `shared/` and `node_modules`) gives the page its code with hot reload, and the server, told by `--vite <address>` on its command line (not the environment, so nothing it starts inherits it), loads the page's code from it instead of `public/dist`. Production builds and the desktop app never use it; `scripts/build-web.ts` still rebuilds the bundle alongside. What swaps in place: files that export only React components, and the pages in `web/views/` (their router hooks, `render`, `title`…, change on the next reload; `web/dev/hot.ts`). Any other change reloads the page: plain modules, and files that export helpers next to components (move a helper out to make its components swap); a change in `shared/` reloads it once the restarted server answers again. A page that throws an uncaught error just after an update reloads itself |
| `skills/` | Skill folders that come with the dashboard. `athena` holds the dashboard's own, written to the standard in its `README.md` (their scripts' tests are in `tests/skills/`). `storytold`, `oomol`, `composio`, `orca`, `cua`, `claude-motion`, `anatomy`, `higgsfield` and `subagent-skills` are copied unchanged from GitHub (`anatomy` without its built example pages): each folder's `README.md` says from where, which commit and what was left out. `BUNDLED` in `server/skills.ts` lists them; `ensureBuiltinSkills` adds them to the library, and on a later start replaces a copy nobody changed with the new one (`data/skills/.builtin.json` keeps each copy's fingerprint, and the ids a skill of the user's already had). Skills the dashboard writes in code (Self-improvement, Start agents in Orca, Make videos with claude-motion, Build websites with taste-skill, which downloads a kit too big to ship) are in `BUILTIN` there instead |
| `library/athena-agents/` | The Agent library's agents: one Markdown file each, in one folder per group (`groups.json`). Its `README.md` is the standard every file follows (frontmatter, body, the rules) and records where the roles came from; `tests/server/library.test.ts` checks the format. `server/library.ts` reads the folder directly, and hiring copies a file's text, tools, skills and engine into a new agent |
| `tests/server`, `tests/web` | Vitest: server in Node, web in happy-dom |
| `src-tauri/` | The desktop app (Tauri 2, Rust): starts the bundled server with a bundled Bun and shows it. `docs/desktop.md` explains it |
| `scripts/build-desktop.ts` | Fills `src-tauri/app/` (server bundled with `Bun.build`, page, skills, library, node-pty) and `src-tauri/binaries/` (Bun) |
| `docs/internal/plans/` | Review notes and plans |

## Code rules

- **TypeScript, strict, no `any`.** Use `unknown` and narrow. `catch (e)` is `unknown`.
- `verbatimModuleSyntax` + `erasableSyntaxOnly`: use `import type` for types, and no `enum`,
  `namespace` or constructor parameter properties.
- Relative imports include the `.ts` / `.tsx` extension (`import { x } from './util.ts'`).
- **Server code must also run under Node**: Vitest imports server modules in Node, so don't use
  `Bun.*` or `bun:` APIs in `server/` or `shared/`. (Scripts in `scripts/` may use Bun.)
- Server `tsconfig` has no DOM types and web has no Node types: keep `shared/` free of both.
- **A JSON route** goes in its area's contract (`shared/api/`) and `server/api/`, never `server/index.ts`, and the page
  calls it with `rpc` (there is no untyped `GET`/`POST` any more). Word a schema's errors in the area's own plain words.
  Outside `web/client/`, the page imports only types from `shared/api/`: its bundle gets the routes without the schemas.
- New data shapes go in `shared/types.ts`. New server state goes through `store.ts` helpers
  (`collection`, `readJSON`/`writeJSON`, `dataPath`/`projectData`), not ad-hoc `fs` writes.
- Tell open tabs about changes with `emit(type, payload)` from `store.ts`.
- Style with Tailwind utilities in the markup, using the theme's tokens (`text-dim`, `bg-panel-2`,
  `rounded-box`, `max-md:`), not new CSS. Reuse the pieces in `web/styles/components.css`; add to it only
  for something used in several places or that utilities can't reach. Write class names whole (Tailwind
  reads the source; never `` `bg-${x}` ``), and in plain DOM put them in attrs: `h('div', { class: 'flex gap-2' })`.
  Classes that code or tests look up stay as markers. `docs/internal/plans/tailwind.md` has the details.
- Comments are short and in plain words; explain why, not what. Match the existing style.
- Lint is Biome (`biome.json`): its recommended rules, minus the ones that fight this code's style (`!`, comma
  expressions, assignments in conditions). Silence a single finding with `// biome-ignore lint/<group>/<rule>: <why>`
  (in JSX, `{/* … */}`), never by turning a rule off for one file. React hook dependencies aren't checked yet.
- The desktop app runs the server bundled into one file. Server imports must bundle with `Bun.build`
  (native modules go in `external` and get copied, like node-pty), and files read relative to `ROOT` must be
  copied in `scripts/build-desktop.ts`. The installed app folder is read-only: write under `DATA` only.
- Large files exist (`web/views/station.ts`, `server/index.ts`). Edit the relevant part; don't
  reformat or reorganize unrelated code.

## Look

"Linear, but white": quiet white surfaces, hairline borders, one accent, Geist, roomy spacing. Light or dark is
`settings.look.theme` (Settings › Appearance › Colour scheme: System, Light, Dark), written onto `<html data-theme>` — by the
server as it serves the page, so the first paint is already right, and by `web/theme.ts` when it changes. System leaves
the attribute off, and `base.css` then swaps the `--color-*` tokens under `prefers-color-scheme: dark`.

- Colour comes from the theme tokens (`bg-bg`, `bg-panel`, `border-line`, `text-ink`, `text-dim`, `text-accent`…), never a
  hard-coded hex for chrome. Per-agent and per-brand colours are data and stay; make sure they read on white and on near-black.
- The accent is picked in Settings › Appearance and has two tones (`ACCENTS` in `web/look.ts`): don't assume a hue. Green means "on"
  (`text-ok`), amber "waiting", red "failed".
- Canvases, three.js and the terminal can't use `var()`: read `isDark()` / `themeColor()` and restyle on `onThemeChange()`.
- The sidebar and About page wordmarks and the Station's clock use Cinzel (`font-brand`); other page text keeps Geist.
- Labels, tabs, buttons and captions are sentence case in Geist; mono is for code, paths, URLs, ids and keys. The one
  exception is the sidebar's own menu, whose items read in capitals (CSS `uppercase`; the text stays as written). No
  uppercase letter-spaced captions, no coloured glows, no gradient text. Controls are `rounded-ctl`, cards
  `rounded-box`; depth is `shadow-card`, `shadow-lift`, `shadow-raised` (what buttons, chips, pills and badges lift
  with) and `shadow-pop`.
- **Controls are components, not class strings.** Use `Button`, `ButtonLink`, `IconButton` (`web/ui/button.tsx`), `Pill`,
  `Badge`, `Dot`, `Chip` (`web/ui/marks.tsx`) and `Plate`, `PlateSection`, `PlateLink` (`web/ui/surface.tsx`). A page that
  still builds its own DOM uses `domButton`, `domButtonLink`, `domIconButton`, `domPill`, `domBadge`, `domDot`, `domChip`
  from `web/ui/dom.ts`; a Base UI trigger takes `buttonClass(...)` / `iconButtonClass(...)`. Their look lives in
  `web/ui/classes.ts` as utilities — don't restyle a control from the outside or add a `.btn`-style rule.
  The old names (`btn ghost small`, `pill ok`, `dot busy`, `chip`, `badge`, `icon-btn`) stay on the elements as bare
  markers for tests and lookups; nothing styles them.
- Markdown, the chat messages and tool calls, the Station and the glass material (`web/styles/components.css`) stay CSS:
  they are document and canvas styling, not controls.

`DESIGN.md` records the Brain chat's styling and motion (the glass material, the dropdown, the composer, every animation with its timing) and why each choice was made.

## Security boundaries (don't weaken these)

- The server listens on `127.0.0.1` only and checks the `Host` header (DNS rebinding).
- Every non-GET `/api/` request needs the `x-dash: 1` header (`web/client/` sends it).
  Cross-site requests are refused via `Sec-Fetch-Site`; only the X/Reddit OAuth callbacks are exempt.
- `/api/internal/` routes need the `x-dash-internal` token (used by the MCP bridge).
- Secrets (`data/secrets.json`) and account tokens never go to the browser and never go into
  `<project>/.dashboard` or backups.
- File access by agents is limited to allowed roots (`insideRoots` in `server/util.ts`).
  Don't follow symlinks out of the data folder.
- New tools need an honest `Risk`: anything that deletes, runs code, sends messages or posts is `high`.
- A run belongs to the project it started in. Use `withProject()` / the run's own project rather
  than the globally active project when writing chats or files from a run.
- Skill installs from GitHub only come from links the user typed, unless the user opted in.

## Tests

- Server tests (`tests/server/setup.ts`) point `DASH_DATA`, `HOME` and `USERPROFILE` at a throwaway
  folder and abort if that fails. Never bypass this or touch the real `data/` or home folder.
- `tests/server/api.test.ts` starts the real server with Bun on a free port the system hands out, and checks it is talking to its own server (its data folder).
- Add or update tests with every behavior change: server logic in `tests/server`, DOM helpers and
  React chat pieces in `tests/web`.
- Paths differ on Windows (long vs short names, `\` vs `/`, case). Compare resolved/real paths.

## User-facing text

UI copy, README and commit messages use short, plain words for non-technical users
("Needs you", "Back up this project"), not jargon. Keep the README's feature descriptions — and
`docs/guide.md`'s — in step with behavior changes you make.

## Git

- Commit subjects: `Area: what changed, in plain words`, e.g.
  `Skills: write a new one or change one in plain words`, `Test: ...`, `Review fixes (server): ...`.
- `bun.lock` is committed; CI installs with `--frozen-lockfile`, so update it when you change
  dependencies. Renovate handles routine upgrades.
- Never commit `data/`, `public/dist/`, `src-tauri/app/`, `src-tauri/binaries/`, logs or keys.
  `src-tauri/Cargo.lock` is committed.
