# AGENTS.md

Guidance for AI coding agents working in this repo. For what the app does, read `README.md` (`docs/guide.md` is the
long version).

## What this is

**Athena Agents** (formerly Blacksite; the server still finds project and backup folders made under that name): a
local, login-free command center for AI agents. A Bun + TypeScript server (`server/`) on `127.0.0.1:4800` and a browser
app (`web/`) bundled into `public/dist`. User state is plain JSON under `data/` (git-ignored). Mainly used on Windows;
CI also runs on Linux.

## Commands

```powershell
bun install
bun run dev          # Vite hot reload for the page, server restarts on change; --no-hot: the bundle only
bun run typecheck    # tsc for server/ and web/ (two tsconfigs)
bun run lint         # Biome; lint:fix applies safe fixes
bun run format       # bun fmt; format:check only reports
bun run test         # Vitest, server + web projects
bun run check        # typecheck + lint + format:check + test: run before you call a change done
bun run build        # bundle web/ and its Tailwind CSS into public/dist
bun run icons        # regenerate web/icons.ts after adding names in scripts/build-icons.ts
bun server/index.ts --port 4900 --no-open   # a second instance
bun scripts/try-agent.ts <agentId> "message" [--port 4800] [--approve]
bun run desktop:dev  # desktop app (needs Rust); desktop:build makes installers
bun scripts/build-desktop.ts && bun run desktop:smoke   # run the bundled server like the app does
```

Single test file: `bunx vitest run tests/server/skills.test.ts`. CI (`.github/workflows/ci.yml`) runs typecheck, lint,
format check, test and build on ubuntu and windows, plus a desktop job (stage, smoke test, Rust check) and the skill
scripts' tests (`python -m pytest tests/skills`, Python 3.10). `.github/workflows/desktop.yml` builds installers.

## Layout

- `server/index.ts`: HTTP server: security checks, oRPC routes, then non-JSON routes (files, uploads, OAuth callbacks,
  MCP bridge internals), WebSocket, static files.
- `shared/api/` (contracts), `server/api/` (handlers), `server/rpc.ts`: every JSON route and the chats' AI SDK streams,
  on oRPC (`docs/internal/plans/ORPC_PLAN.md`). `tests/server/rpc-moved.test.ts` lists the routes `index.ts` keeps.
  `server/api/refuse.ts` refuses with a status; `rpcAt(at)` in `web/client/rpc.ts` calls into a project that isn't open.
- `server/store.ts`: JSON storage: settings, secrets, projects, `collection<T>()`, chats, the event `bus` / `emit()`.
- `server/engines/`: engines that run agents (`claude.ts`, `codex.ts`, `hermes.ts`, `eve.ts`); `index.ts` starts runs.
  `server/eve/`, `runtime/eve/`, `runtime/eve-world/`: Eve bindings, worker and Workflow store.
- `server/tools.ts`: built-in agent tools, each with a `Risk` (`none` / `low` / `high`) that decides approval.
- `server/documents.ts`, `server/pdfworker.ts`: text of PDF and Office files. The PDF worker imports nothing of the
  app's and is its own entry in `scripts/build-desktop.ts`.
- `server/mcp-bridge.ts`: gives the dashboard tools to Claude Code and Codex over MCP.
- `server/brain.ts`, `overseer.ts`, `teams.ts`, `learning.ts`: the Brain, approvals review, team chats, self-improvement.
- `server/projectsync.ts`, `backup.ts`, `versions.ts`: auto-save into `<project>/.dashboard`, backups, version history.
- `server/voxel/`, `web/voxel/`, `shared/voxel.ts`: the voxel world (`docs/internal/plans/VOXEL_WORLD_PLAN.md`).
- `shared/`: code both sides import; `types.ts` is the source of truth for data shapes.
- `web/`: the browser app, almost all React on Base UI. Pages are in `web/views/`; `station.ts` (the three.js map) and
  the page shell `app.ts` still build plain DOM with `h()` from `web/core.ts`. Agent chats are `web/chat/*.tsx`.
- `web/ui/`: Base UI pieces. `overlays.tsx` draws dialogs and toasts (`modal()`, `confirmBox()`, `toast()` in
  `web/core.ts`); every React root comes from `createAppRoot` in `root.tsx` (a test checks).
- `web/client/`: the page's only way to the server (`rpc`, `api`, uploads, sockets). A test fails if other code
  writes `/api/`, `fetch(` or `new WebSocket(`.
- `web/styles/`: Tailwind CSS 4 (`app.css` entry, `base.css`, `components.css`).
- `web/theme.ts`, `web/look.ts`: light/dark (`isDark()`, `onThemeChange()`, `themeColor()`) and the accents.
- `public/`: `index.html`. `public/dist` is build output, never edit it.
- `scripts/dev.ts`, `scripts/vite-dev.ts`, `server/devpage.ts`: `bun run dev`. Production and desktop never use Vite.
- `skills/`: bundled skills. `athena` is the dashboard's own; the others are copied unchanged from GitHub (each
  `README.md` says from where). `BUNDLED` and `BUILTIN` in `server/skills.ts` list them.
- `library/athena-agents/`: the Agent library, one Markdown file per agent; its `README.md` is the format, checked by
  `tests/server/library.test.ts`.
- `src-tauri/`: the desktop app (Tauri 2), see `docs/desktop.md`. `scripts/build-desktop.ts` fills `src-tauri/app/`
  and `src-tauri/binaries/`.
- `docs/internal/plans/`: review notes and plans.

## Code rules

- **TypeScript, strict, no `any`.** Use `unknown` and narrow. `catch (e)` is `unknown`.
- `verbatimModuleSyntax` + `erasableSyntaxOnly`: `import type` for types; no `enum`, `namespace` or constructor
  parameter properties.
- Relative imports include the `.ts` / `.tsx` extension.
- **Server code must also run under Node 26** (Vitest): no `Bun.*` or `bun:` APIs in `server/` or `shared/`. Scripts
  in `scripts/` may use Bun.
- Server and Eve code target ES2025 (Node 26); web stays on ES2023 for browsers. `shared/` is checked by both, so it
  keeps to ES2023 and has no DOM or Node types.
- **A JSON route** goes in its area's contract (`shared/api/`) and `server/api/`, never `server/index.ts`; the page
  calls it with `rpc`. Word schema errors in plain words. Outside `web/client/`, the page imports only types from
  `shared/api/`.
- New data shapes go in `shared/types.ts`. Server state goes through `store.ts` helpers (`collection`,
  `readJSON`/`writeJSON`, `dataPath`/`projectData`), not ad-hoc `fs` writes. Tell open tabs with `emit(type, payload)`.
- Style with Tailwind utilities and theme tokens (`text-dim`, `bg-panel-2`, `rounded-box`), not new CSS. Write class
  names whole (never `` `bg-${x}` ``). Keep classes that code or tests look up as markers.
  `docs/internal/plans/tailwind.md` has details.
- Comments are short and plain; explain why, not what.
- Biome lint: silence a single finding with `// biome-ignore lint/<group>/<rule>: <why>`, never per file.
- Formatting is `bun fmt` (single quotes, 120 columns); run `bun run format` before committing.
- The desktop app runs the server bundled into one file: server imports must bundle with `Bun.build` (native modules go
  in `external`, like node-pty), files read relative to `ROOT` must be copied in `scripts/build-desktop.ts`, and the
  app folder is read-only: write under `DATA` only.
- Large files (`web/views/station.ts`, `server/index.ts`): edit the relevant part; don't reformat unrelated code.

## Look

"Linear, but white": quiet surfaces, hairline borders, one accent, Geist, roomy spacing. Light/dark comes from
`settings.look.theme` on `<html data-theme>`. `DESIGN.md` records the Brain chat's styling and motion.

- Colour comes from theme tokens (`bg-bg`, `bg-panel`, `border-line`, `text-ink`, `text-dim`, `text-accent`), never
  hard-coded hex for chrome. The accent is user-picked: don't assume a hue. Green "on", amber "waiting", red "failed".
- Canvases, three.js and the terminal can't use `var()`: read `isDark()` / `themeColor()`, restyle on `onThemeChange()`.
- Sentence case everywhere (except the sidebar menu); mono only for code, paths, ids and keys. No uppercase
  letter-spaced captions, coloured glows or gradient text. Controls `rounded-ctl`, cards `rounded-box`.
- **Controls are components, not class strings**: `Button`, `IconButton` (`web/ui/button.tsx`), `Pill`, `Badge`, `Dot`,
  `Chip` (`web/ui/marks.tsx`), `Plate` (`web/ui/surface.tsx`); plain DOM uses `dom*` from `web/ui/dom.ts`. Their look
  lives in `web/ui/classes.ts`: don't restyle them from outside. Old class names (`btn`, `pill ok`…) are bare markers.

## Security boundaries (don't weaken these)

- The server listens on `127.0.0.1` only and checks the `Host` header.
- Every non-GET `/api/` request needs `x-dash: 1`; cross-site requests are refused via `Sec-Fetch-Site` (only the
  X/Reddit OAuth callbacks are exempt). `/api/internal/` needs the `x-dash-internal` token.
- Secrets (`data/secrets.json`) and account tokens never go to the browser, `<project>/.dashboard` or backups.
- Agent file access is limited to allowed roots (`insideRoots` in `server/util.ts`). Don't follow symlinks out of the
  data folder.
- New tools need an honest `Risk`: anything that deletes, runs code, sends messages or posts is `high`.
- A run belongs to the project it started in: use `withProject()` / the run's project, not the active one.
- Skill installs from GitHub only come from links the user typed, unless the user opted in.

## Tests

- Server tests (`tests/server/setup.ts`) point `DASH_DATA`, `HOME` and `USERPROFILE` at a throwaway folder. Never bypass
  this or touch the real `data/` or home folder.
- Add or update tests with every behavior change: server in `tests/server`, DOM and React pieces in `tests/web`.
- Paths differ on Windows (long/short names, `\` vs `/`, case): compare resolved/real paths.

## User-facing text

UI copy, README and commit messages use short, plain words for non-technical users ("Needs you", "Back up this
project"). Keep `README.md` and `docs/guide.md` in step with behavior changes.

## Git

- Commit subjects: `Area: what changed, in plain words` (e.g. `Skills: ...`, `Test: ...`, `Review fixes (server): ...`).
- `bun.lock` is committed and CI uses `--frozen-lockfile`: update it with dependency changes.
- Never commit `data/`, `public/dist/`, `src-tauri/app/`, `src-tauri/binaries/`, logs or keys. `src-tauri/Cargo.lock`
  is committed.
