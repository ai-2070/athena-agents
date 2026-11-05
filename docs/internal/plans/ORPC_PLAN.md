# Typed API routes with oRPC

*Plan, 2026-11-05. The pilot (the Tasks board) is built on `LZL0/orpc`: see "Status" below.*

Goal: every JSON route says what it takes and what it gives back, in one place both sides read. The server
checks what comes in before a handler sees it, and the page gets typed calls (`rpc.taskBoard.addTag({ … })`)
instead of `POST<{ tag: BoardTag }>('/task-board-tags/…', body)`, where the type is a guess.

Nothing changes for the person using the app, and the URLs and answers stay the same: routes move one area
at a time, side by side with the old router, and every step ships.

## Status (2026-11-05)

The Tasks board's 18 JSON routes are on oRPC, one commit per step. All four checks in "Decision after the pilot"
hold, so the next area can start. Where the build differs from the plan below:

- **Names are nested**: `rpc.taskBoard.tags.add`, `rpc.taskBoard.comments.change` (the open question).
- **The board keeps its `unknown` input types** (`BoardInput`, `TagInput` in `server/taskboard.ts`). Agents' tools
  call the same functions with whatever a model sent, so the board still checks every field itself. The schemas
  mirror its words ("rank must be a number.") so a wrong type is answered the same either way.
- **Startup stayed the same size.** Importing the contract put zod in a 101 KB chunk that `app.js` loaded at once
  (before, zod loaded only with the chats). The page's bundle now gets `shared/api/index.ts` as routes only
  (`scripts/api-routes.ts`, swapped in by `scripts/build-web.ts`), and a test fails if code outside `web/client/`
  imports anything but types from `shared/api/`.
- **Errors are answered `no-store` too**: that header is set in `rootInterceptors`, since error answers are
  written outside `interceptors`.
- **The client reads `{ error }` whatever the content type**, as `api()` does (a test's fake server sent JSON as text).
- **Tags may be sent as a list or as "a, b"**, as the old route took them.
- **Small wording changes**: a project that doesn't exist is "That project is unavailable." (was "Not found"); a JSON
  array as the body is answered with the schema's first message instead of "Body must be a JSON object".

Measured:

| | Before | After |
|---|---|---|
| `app.js` | 1,393,697 bytes (406,704 gzipped) | 1,422,468 (416,963): +28.8 KB, +10.3 KB gzipped |
| Chunks `app.js` loads at start | 15 | 15 (no zod) |
| `GET /api/task-board`, 30 tasks (median) | 0.15 ms | 0.18 ms |
| `GET /api/about`, a route that didn't move | 0.05 ms | 0.05 ms |
| `server/index.ts` | 1,750 lines | 1,716 |

The board's page and server tests passed unchanged, and so did the desktop smoke test. The built page, loaded in
headless Chrome, showed all 30 cards and their tags. Typing the page's save helpers (`BoardChange` instead of
`Record<string, unknown>`) compiled at once, so the page and the server agreed on every field the board sends.

### Projects (2026-11-05)

20 of the 23 project routes moved; the three that send a file (a project's logo, background and 3D model) stay in
`server/index.ts`. Two steps:

- **The shapes moved to `shared/types.ts`** (`ProjectWithMedia`, `ProjectsOverview`, `SaveStatus`, `RestoreResult`,
  `BackupResult`, `BackupRestoreResult` and the rest), since the contract can't import from `server/`. The page's own
  copies, which had drifted (its `BackupSummary` lacks `libraryPrefabs`), use them now where the page reads an answer.
- **State two routes shared left `server/index.ts`**: the start screen (`startScreenPending` / `startScreenDone` in
  `projects.ts`) and the one-at-a-time lock for restoring and copying (`oneAtATime` in `backup.ts`), since restoring
  a backup takes a file and stays on the old router.

What the move turned up:
- **The Station panel's description save had no project id to name** as far as the types could tell (`proj.id` is
  optional there; it was checked, but outside the call). It names it now.
- **Four calls didn't encode the project id in the address**; typed calls always do.
- **`api()` reads an answer as JSON whatever its content type says**, and the page's tests rely on that (their fake
  servers send JSON as text). The client does the same now, in one place (`send()` in `web/client/rpc.ts`).
- **A call with no input sends no body** (the old `POST()` sent `{}`). The server takes both; one page test that
  checked for `{}` checks the method and address instead.
- The project functions mostly refuse with a plain `Error` (no status), so those are 500s with their message, as
  before. Only a field of the wrong kind is a 400 now, in the functions' own words.

`app.js` grew by 1.8 KB for these 20 routes; `server/index.ts` is 1,603 lines.

### Agents (2026-11-05)

30 of the 32 agent routes moved, in two commits: the agents themselves (making, changing, copying, deleting, their
knowledge and their harness's / commands), then their chats (messages, the queue, `/loop`, `/goal`, `/learn`,
resend, resume, stop, memory). A chat's run streams (`…/chats/{chatId}/stream`, POST and GET) stay in
`server/index.ts`: they write a UI message stream for the AI SDK, not JSON.

- **`rpcAt(at)`** in `web/client/rpc.ts` makes the same calls inside a project that isn't open (`at` is
  `projectAt(projectId)`, as before), so the Overview's panes and team chats use typed calls too.
- **A save no longer keeps a field of the wrong kind.** `PUT /api/agents/{id}` copied whatever it was sent for its
  23 fields; an engine, autonomy or temperature it can't use is refused now, in words. An unknown effort is still
  saved as the default (`.catch('')`), as a test asks.
- **Agents' fields come from one list** (`agentFields` in `shared/api/agents.ts`), so making one and changing one
  take the same things. A new agent still can't pick its own id.
- **`deleteAgent` moved to `server/api/agents.ts`**: deleting a team deletes its agents with it.
- **Removing knowledge that names neither a file nor a folder** is a 400 that says so (it was a 500).
- **`/resend`, `/resume` and `/goal` are a call each** in the chat view, instead of one address built from the
  command's name.
- `AgentDetail` and `HarnessCommand` moved to `shared/types.ts`.
- In headless Chrome, a chat made through the API opened in the agent's chat page with its title and the agent.

`server/index.ts` is 1,461 lines (1,750 before the pilot); `app.js` is about the size it was before the pilot,
since code moved between chunks.

### Team chats (2026-11-05)

All 16 `/api/teams/{id}/…` routes moved: the thread, messages, the held queue, steering while it works, `/resend`,
`/resume`, `/learn`, `/loop`, `/goal`, stop and clear. The teams themselves (making, changing, running them) are
`/api/workflows`, the next area. As with agents, `/resend`, `/resume` and `/goal` are a call each in the team chat
instead of one address built from the command's name, and a message's `replyTo` must name a message.

### Teams (2026-11-05)

13 of the 14 `/api/workflows…` routes moved: the list, making, changing, copying, running and deleting a team, its
picture or 3D model, the starter teams (`/api/workflow-templates`) and the runs of old step lists
(`/api/workflow-runs`, `/api/workflow-active`). The picture itself (GET `…/mark`) stays in `server/index.ts`. The
contract keeps the old addresses, so it is `workflows` (`rpc.workflows.change(…)`), beside `teams` for their chats.

- **A save keeps only a team's own fields.** The page sends back the whole team as it got it (with `state`, `last`,
  the Station's own fields); those were written into the team's file before and are dropped now. A field of the
  wrong kind is refused in words; a step keeps its other fields, since a tool step carries its tool's settings.
- **`access` with one list left out** saves the other as empty (a test sends only `toolGroups`).
- **A picture that isn't one** is a 400 in its own words (it was a 500), and an unknown starter team a 404.
- `WorkflowRun`, `RunSummary` and `WorkflowTemplateInfo` moved to `shared/types.ts`.
- **The guard test** from "After the pilot" is in: `tests/server/rpc-moved.test.ts` fails if `server/index.ts` gains a
  route in an area that has moved. Its list grows with each area.

`server/index.ts` is 1,381 lines.

### Brain (2026-11-05)

14 of the 15 `/api/brain…` routes moved: a look inside its folder, a note, git pull, opening it, asking it,
steering, `/stop` and `/resume`, its history, clearing it, the snapshot, the pulse and its skills. Its streamed
answer (POST `/api/brain/stream`) stays in `server/index.ts`, like the agent chat streams. The `/api/assist…` routes
(designing an agent or a branch) are an area of their own, for later.

- **`/stop` still always stops.** The chats and teams it is sent are lists of the wrong kind sometimes (a test sends
  one); those count as none (`.catch([])`) instead of being refused.
- **A note or a question of the wrong kind** is refused in words; before, a number was written as its text.
- `BrainChatMessage`, `BrainInfo` (with `BrainEntry`, `BrainGit`, `ProjectSummary`) and `BrainPulse` moved to
  `shared/types.ts`. The page's own copies (`BrainHistoryEntry` in `dock.tsx`, `BrainInfo` in `stationpanel.tsx`)
  are gone.

`server/index.ts` is 1,349 lines.

### What waits for you, a chat's tasks, routines and runs (2026-11-05)

All 22 routes of five small areas moved: questions agents asked (`/api/questions`), permission requests
(`/api/approvals`), the step lists agents keep in their chats (`/api/tasks`), routines and their runs (`/api/routines`,
`/api/routine-runs`) and the agents' runs going now (`/api/runs`).

- **A chat's tasks are still checked by `server/tasks.ts`**, in the words the agents' tools get. The contract only
  checks the shape; its task list status is one of the statuses (`Invalid task status.`, as before).
- **`projectList()`** (`web/projectlist.ts`, the lists of a project that isn't open) takes a typed call now, not an
  address: `projectList((at) => rpcAt(at).agents.list(), ['agents'])`.
- A missing task or routine says so ("That task is unavailable.", 404) instead of "Not found".

The Outbox waits for the gateways: three of its routes run deliveries through the gateway supervisor in
`server/index.ts`, and the gateway code checks approvals strictly. Both move together, last.

`server/index.ts` is 1,316 lines.

### Skills, version history, presets and the Agent library (2026-11-05)

All 20 routes moved: the skills (`/api/skills`, with importing from `~/.claude/skills` and installing from GitHub),
version history (`/api/versions`), presets (`/api/presets`) and the Agent library (`/api/library`). Drafting a skill
from plain words is `/api/assist/skill`, with the other `/api/assist` routes for later.

- **`refusing(fn, status)`** in `server/api/refuse.ts`: the domain functions here refuse with a plain `Error` whose
  words say what to change ("Give the skill a name.") or that a thing isn't there ("No such preset."). Those were
  500s; through `refusing()` they are a 400 (or 404) with the same words.
- **Hiring from the library takes the agents' own fields** for its overrides (`agentPatch` from `shared/api/agents.ts`).
- The presets' types (`AgentPreset`, `TeamPreset`, their templates), `HermesProfile`, `ClaudeSubagentListing` and
  `LibraryIndex` moved to `shared/types.ts`; the library page's copies are gone.

`server/index.ts` is 1,266 lines.

### Settings, keys, accounts and the dashboard's status (2026-11-05)

All 26 routes moved: the settings (`/api/settings`, with testing a key), the API keys (`/api/secrets`), the X and
Reddit accounts (`/api/accounts`), and what the page shows about the dashboard: the app state (`/api/state`), the
activity feed, the header's meters (`/api/headbar`), the sidebar's plan limits (`/api/usage-limits`), the Overview,
the built-in tools and their use, the models and providers, and About.

- **Saving settings checks every field now.** `PUT /api/settings` merged whatever JSON it was sent into
  `settings.json`; a field of the wrong kind (a folder list that isn't a list, a theme that doesn't exist, a number
  left empty) is refused in words, and nothing of that change is saved. Fields the page never sets here
  (`activeProject`, `defaultWorld`, which have their own routes) are dropped.
- **`SettingsPatch` is partial at every depth**, as `saveSettings()` always merged: the settings page saves one field
  of a provider (`providers.custom.baseUrl`) without the others.
- **The gateway supervisor is made in `server/gateways/live.ts`**, so routes outside `server/index.ts` (the app state
  now, the gateways later) reach the same one. Making it starts nothing; `server/index.ts` still starts it.
- `appState()`, the header's meters and `usageLimits()` moved to `server/api/status.ts` (the Codex limit reset, still
  in `server/index.ts`, uses `usageLimits()` from there).
- The header's, the model picker's, the key tests' and X posts' types (`HeadbarInfo`, `ClaudeUsage`, `Connector`,
  `ModelListing`, `OpenRouterKeyInfo`, `XPost`, `ToolListing`, `ToolStats`) moved to `shared/types.ts`; the page's
  copies are gone.

`server/index.ts` is 1,134 lines.

### MCP servers, the engines' setup, programs and ComfyUI (2026-11-05)

All 25 routes moved: MCP servers (`/api/mcp`, `/api/mcp-preset`, `/api/mcp-import`, `/api/mcp-bridge`), setting up
Codex, Hermes, pi and OpenClaw (`/api/codex/…`, `/api/hermes/…`, `/api/pi/add-bridge`, `/api/openclaw/agents`), the
programs on this PC (`/api/programs`) and ComfyUI (`/api/comfyui`). ComfyUI's file proxy (`/api/comfyui/view`) is
answered before the routes, as before.

- **Plain errors of `server/mcp.ts`, `programs.ts` and `comfyui.ts`** ("Give the server a name.", "No ComfyUI
  workflow called …") are 400s through `refusing()`; they were 500s.
- **The Home page showed `p.icon` for a program without an app icon**, a field the server never sent: that spot was
  always empty. It still is, now on purpose, and the page uses the shared `Program`.
- The MCP types (`McpServerConfig`, `McpServerInput`, `McpPreset`, `ImportableServer`, `BridgeServerConfig`, with
  `McpPresetListing` and `McpOverview` for `GET /api/mcp`), `OpenClawAgent`, `Program`, `StartMenuApp` and ComfyUI's
  results moved to `shared/types.ts`; the MCP and Programs pages' copies are gone.

`server/index.ts` is 1,027 lines.

Next: files, uploads, MEMORY.md, artifacts, the map's layout and terminals.

## Why

- **Nothing checks requests or answers today.** The router trusts each body to match the type its route names
  (`server/index.ts`, "the JSON is trusted to match it here"). On the page, `GET<Agent[]>('/agents')` is only an
  assertion. When a route's shape changes, nothing fails until it breaks in use.
- **Each handler re-checks `unknown` input by hand** (`BoardInput` is all `unknown` fields, `body?.text`,
  `typeof body?.text === 'string'`). A schema says it once.
- **`server/index.ts` is 1,750 lines with 323 routes in it.** Moving routes into per-area files makes it smaller
  as a side effect.

## What this is not

- **Not oRPC v2.** On 2026-11-05 npm has `latest` 1.16.1 and `beta` 2.0.0-beta.48. We use 1.16.1 and move to
  v2 once it ships stable. With the contracts in one place (below), that upgrade touches a handful of files.
- **Not nRPC.** nRPC (`REMOTE_APP_PLAN.md`, part C) is how a phone reaches the server: a pass-through service
  that hands requests to the same `/api` routes. This plan keeps those URLs as they are, so the two don't touch.
  Later, native nRPC services (handoff between computers, sync) could reuse the same zod schemas.
- **Not a change to the security checks.** The Host check, `Sec-Fetch-Site`, `x-dash`, the internal token, the
  409 when another project was opened meanwhile, and `/api/p/<project>/…` all stay where they are, in front of
  both routers.

## Where things stand

- 323 routes in `server/index.ts`, through `get` / `post` / `put` / `del` / `postFile`. Biggest areas: gateways
  (48), agents (32), world (24), projects (23), the Tasks board (19, counting `task-board-*`), teams (16),
  brain (15), outbox (13).
- The page reaches the server only through `web/client/` (`api`, `GET`/`POST`/`PUT`/`DEL`, `upload`), with
  a test that fails otherwise (`tests/server/web-client-boundary.test.ts`). About 325 calls in 45 files.
- `zod` 4.6.7 is already a dependency (gateways use it on the server), and it is already in the page bundle,
  in the chat's lazily loaded chunks (not in `app.js`).
- Errors: anything thrown with a `status` from 400 to 599 is answered with that status and
  `{ "error": "<its message>" }`; anything else is a 500 with its message. `api()` turns that back into an
  `Error` with `status`, and callers check `e.status === 404`.

## What the prototype showed

A throwaway prototype (oRPC 1.16.1, zod 4.6.7) ran under Bun 1.4.4 and Node 24, with the Tasks board's tag
routes and Node's `http` server like ours. It showed:

- **URLs can stay as they are.** oRPC's OpenAPI handler serves a procedure at a path we give it
  (`POST /task-board-tags/{projectId}`). The client sent exactly today's requests: `POST
  /api/task-board-tags/p%201` with body `{"name":"Bug"}` (the path's fields are left out of the body),
  `GET /api/task-board?project=all`, `DELETE /api/task-board-tags/p1/t1`. So the page's tests, which stub
  `fetch` and check URLs and bodies, should pass unchanged.
- **The two routers sit side by side.** A request oRPC doesn't match comes back with `matched: false` and its
  body unread, so the old router reads it as before.
- **`/api/p/<project>/…` works** by passing that prefix instead of `/api`.
- **Our error shape can stay.** `customErrorResponseBodyEncoder` answers `{ "error": "…" }`. oRPC's client
  then doesn't recognize the error (it accepts only its own exact keys) and gives a generic "Not Found", so our
  client wrapper reads `error` back out: the page got `404 That tag is gone.` and `400 Give the tag a name.`
- **A plain `Error` becomes `500 Internal server error`** unless we map it. Ours carry a `status` (`fail()` in
  `taskboard.ts`, `HttpError`), so a middleware has to turn them into oRPC errors (below).
- **Size:** oRPC's client is about 27 KB minified (9 KB gzipped) on top of zod (about 80 KB, 23 KB gzipped,
  already in the chat chunks). The server bundles with `Bun.build`; it is plain JavaScript, no native modules.

## Design

### Packages

`@orpc/contract`, `@orpc/server`, `@orpc/openapi`, `@orpc/client`, `@orpc/openapi-client`, all pinned at
`1.16.1` (exact, like the rest of `package.json`). `bun.lock` updated. No adapters beyond Node's.

### Contracts in `shared/api/`

The page's tsconfig can't read `server/` (no Node types), and the server's has no DOM, so the contract can't
be "the type of the server's router". It lives in `shared/`, which both read; `zod` and `@orpc/contract` use
neither Node nor the DOM.

```ts
// shared/api/taskboard.ts
import { oc, type } from '@orpc/contract';
import { z } from 'zod';
import type { BoardTag, BoardTagUse, BoardTask, TaskBoardData } from '../types.ts';

const inProject = z.object({ projectId: z.string().min(1) });
const tag = z.object({ name: z.string().optional(), emoji: z.string().optional() });

export const taskBoard = {
  board: oc.route({ method: 'GET', path: '/task-board' })
    .input(z.object({ project: z.string().default('all') }))
    .output(type<TaskBoardData>()),
  tags: oc.route({ method: 'GET', path: '/task-board-tags/{projectId}' })
    .input(inProject)
    .output(type<{ tags: BoardTagUse[] }>()),
  addTag: oc.route({ method: 'POST', path: '/task-board-tags/{projectId}' })
    .input(inProject.extend(tag.shape))
    .output(type<{ tag: BoardTag }>()),
  // …
};

// shared/api/index.ts
export const contract = { taskBoard };
```

- **Inputs are zod**: the server checks them. **Outputs are `type<T>()`**: the type from `shared/types.ts`,
  not checked at run time (the server wrote it; checking every answer costs time for little).
  `shared/types.ts` stays the source of truth for data shapes.
- **Schemas give the shape; the area keeps its rules.** "1–32 characters, unique in the project, one emoji"
  stays in `taskboard.ts` with its plain-word messages. A schema that can fail on its own (a missing name) gets
  a plain-word message too (`'Give the tag a name.'`), never zod's default ("Invalid input: expected string").
- **zod objects drop unknown keys.** A schema must list every field its handler reads, or that field
  silently disappears. The route's existing server tests catch this; review each schema against its handler.
- **Query values arrive as strings**: numbers in a GET use `z.coerce.number()` (`offset`, `limit` on
  `/api/tasks`, later).
- Input types like `taskBoard.TagInput` move into the schema (`z.input<typeof tag>`) when their area moves.

### Server

- **`server/rpc.ts`**: `implement(contract).$context<RpcContext>()`, one error middleware, and the
  `OpenAPIHandler` built from every area's router. `RpcContext` is small: `{ req, scope?: Project }`. Handlers
  that need the run's project use `store.withProject()` as today (the scope is already applied around them).
- **Areas in their own files**: `server/api/taskboard.ts` implements `contract.taskBoard` and calls the same
  functions the old routes call (`taskBoard.addBoardTag(projectId, input, 'you')`). `server/index.ts` loses
  those lines.
- **Errors, the same as today.** A middleware catches what a handler throws: anything with a `status` from 400
  to 599 becomes an oRPC error with that status and message; anything else is logged and becomes a 500 with its
  message. A failed input check becomes a 400 with the first issue's message. The handler's
  `customErrorResponseBodyEncoder` answers `{ error: message }`, so every route, old or new, answers errors the
  same way.
- **Mounted inside the `/api/` branch, after every guard**, before the old route loop:

  ```ts
  res.setHeader('cache-control', 'no-store');
  const prefix = scope ? `/api/p/${encodeURIComponent(scope.project.id)}` : '/api';
  const { matched } = await inScope(() => rpc.handle(req, res, { prefix, context: { req, scope: scope?.project } }));
  if (matched) return;
  // …the old routes, unchanged
  ```

  `cache-control: no-store` is what every JSON answer has today. Scoped routes still pass `SCOPED` first.
- **The 25 MB body limit stays**, with oRPC's `BodyLimitPlugin`. No `CORSPlugin`: we never allow cross-site
  requests, and the guards in front already refuse them.

### Page

- **`web/client/rpc.ts`**: the one client.

  ```ts
  export const rpc: ContractRouterClient<typeof contract> = createORPCClient(new OpenAPILink(contract, {
    url: () => apiUrl(''),       // follows the connection (a paired phone's proxy, later)
    headers: requestHeaders,     // x-dash, x-dash-project
    interceptors: [/* ORPCError → Error with the server's `error` and `status`, as api() throws */],
  }));
  ```

  It is inside `web/client/`, so the boundary test still holds. A caller sees the same errors as before.
- **Callers change as their area moves**: `GET<TaskBoardData>(\`/task-board?project=${…}\`)` becomes
  `rpc.taskBoard.board({ project })`. No hand-written paths, no `encodeURIComponent`, no guessed types.
- **Bundle**: importing the contract puts its zod schemas in `app.js`. If that shows in the pilot's size
  check, the build writes `minifyContractRouter(contract)` (paths and methods only, no schemas) to JSON, and the
  page's link uses that. The prototype used both.

### What stays on the old router

Routes that aren't "JSON in, JSON out" stay as they are; nothing forces them over:
- file answers (`sendFileSafely`, PDFs, `task-board-file`), and the 9 handlers that write `res` themselves
- uploads (`/api/uploads/…`, `postFile` backups) and the ComfyUI proxy
- the AI SDK chat streams, OAuth, and the WebSockets
- `/api/internal/` (the MCP bridge) until there is a reason to move it

oRPC's event iterators could carry some streams later. That's not part of this plan.

## Pilot: the Tasks board

The board is recent, has good tests on both sides, and its 19 routes cover the cases: GET with a query, path
params, POST/PUT/DELETE, async handlers (`startWork`), uploads passed by reference (`files`), and one file answer.
It moves 18 routes; `GET /api/task-board-file/…` (a file) stays.

| Procedure | Route |
|---|---|
| `taskBoard.board` | `GET /task-board?project=` |
| `taskBoard.people` | `GET /task-board-people/{projectId}` |
| `taskBoard.tags`, `addTag`, `changeTag`, `removeTag` | `/task-board-tags/{projectId}[/{tagId}]` |
| `taskBoard.add`, `get`, `change`, `remove` | `/task-board/{projectId}[/{id}]` |
| `taskBoard.start`, `stop`, `check` | `POST /task-board/{projectId}/{id}/start\|stop\|check` |
| `taskBoard.addComment`, `changeComment`, `removeComment` | `/task-board/{projectId}/{id}/comments[/{cid}]` |
| `taskBoard.rerank` | `PUT /task-board-ranks` |
| `taskBoard.draft` | `POST /task-board-draft` |

Callers: `web/views/tasks.tsx`, `web/taskboard.tsx`, `web/tasktags.tsx`, `web/views/overview.tsx`.

### Steps (one commit each)

1. Packages, `shared/api/`, `server/rpc.ts`, the mount in `server/index.ts`, `web/client/rpc.ts`. No routes yet.
   Tests for the error mapping, the scoped prefix, a non-matching POST reaching the old router with its body,
   and `no-store`.
2. Tags (4 routes) and their callers in `web/tasktags.tsx`.
3. The rest of the board (14 routes) and their callers.
4. Size and speed check, then the decision below.

### Tests

- **`tests/server/api.test.ts` doesn't change for the board.** It hits the real server with raw `fetch`
  (403 without `x-dash`, 400 on a bad emoji, 404 deleting a tag twice). Passing unchanged is the proof that
  nothing changed for callers.
- **New `tests/server/rpc.test.ts`**: the cases in step 1, plus calls through `createRouterClient` (no HTTP)
  for each board procedure's input check: a missing field, a wrong type, an unknown key dropped.
- **`tests/web`**: `web/client/rpc.ts` turns errors into `Error` with `status` and the server's words. The
  board's page tests (`tasks-board.test.tsx`, `tasktags.test.tsx`, `overview.test.tsx`, `dock.test.tsx`)
  pass unchanged, since the requests are the same.
- `bun run check`, `bun run build`, and `bun scripts/build-desktop.ts && bun run desktop:smoke` (the desktop
  app runs the server as one bundled file).

### Decision after the pilot

Carry on only if all of these hold:
- the board's page and server tests passed unchanged, and the desktop smoke test passes
- `app.js` grows by less than about 40 KB minified (with the minified contract if needed)
- the area reads better: `server/index.ts` shorter, handlers without hand-written `unknown` checks, callers
  without paths
- no measurable slowdown on `GET /api/task-board` (compare 200 calls before and after)

If it doesn't pay off, the fallback is smaller: an optional zod schema argument on the existing
`post`/`put` helpers, plus typed client functions per area in `web/client/` (`REMOTE_APP_PLAN.md`, part A,
step 4).

## After the pilot

- **One area per PR**, in this order: projects (23), agents (32), teams (16), brain (15), outbox (13),
  workflows (10), then the rest. Gateways (48) and world (24) last: they're big and change often.
- **A guard test**: once an area has moved, `server/index.ts` can't gain a JSON route in it (a list of moved
  path prefixes). Done: `tests/server/rpc-moved.test.ts`.
- **When the JSON routes are all moved**, `get`/`post`/`put`/`del` remain only for what stays on the old
  router (above).
- **AGENTS.md** gets the new rule ("JSON routes are contracts in `shared/api/`, implemented in `server/api/`")
  and the layout table rows, once the pilot is accepted. The README doesn't change: nothing a user sees changes.
- **Later, if useful**: `@orpc/openapi`'s generator can write an OpenAPI document from the contracts, for
  agents or the MCP bridge to read.

## Open questions

- ~~**Procedure names**~~: nested (`taskBoard.tags.add`), decided in the pilot.
- **Output checks in tests**: should `rpc.test.ts` check answers against schemas, to catch an answer drifting
  from its type? That needs output schemas for some shapes, which `type<T>()` avoids.
- **v2**: when it ships stable, read its migration notes before starting the next area, not halfway through one.
