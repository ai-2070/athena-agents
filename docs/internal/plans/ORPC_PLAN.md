# Typed API routes with oRPC

*Plan, 2026-11-05. Nothing is built yet; a throwaway prototype ran (see "What the prototype showed").*

Goal: every JSON route says what it takes and what it gives back, in one place both sides read. The server
checks what comes in before a handler sees it, and the page gets typed calls (`rpc.taskBoard.addTag({ … })`)
instead of `POST<{ tag: BoardTag }>('/task-board-tags/…', body)`, where the type is a guess.

Nothing changes for the person using the app, and the URLs and answers stay the same: routes move one area
at a time, side by side with the old router, and every step ships.

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
  path prefixes).
- **When the JSON routes are all moved**, `get`/`post`/`put`/`del` remain only for what stays on the old
  router (above).
- **AGENTS.md** gets the new rule ("JSON routes are contracts in `shared/api/`, implemented in `server/api/`")
  and the layout table rows, once the pilot is accepted. The README doesn't change: nothing a user sees changes.
- **Later, if useful**: `@orpc/openapi`'s generator can write an OpenAPI document from the contracts, for
  agents or the MCP bridge to read.

## Open questions

- **Procedure names**: `taskBoard.addTag` or `taskBoard.tags.add`? Nested reads better as areas grow; pick
  one in the pilot and keep it.
- **Output checks in tests**: should `rpc.test.ts` check answers against schemas, to catch an answer drifting
  from its type? That needs output schemas for some shapes, which `type<T>()` avoids.
- **v2**: when it ships stable, read its migration notes before starting the next area, not halfway through one.
