# Overview branch review — 2026-11-03

## Scope

Reviewed branch `LZL0/overview` against `main` (`main...HEAD`, HEAD `51993d0`), which covers the Overview commits on this branch. No source files were changed.

Findings 1–6 are bugs; 7–10 are cleanup, speed and convention items. Each finding states how far it was checked: **confirmed** means the code path was read and the problem holds; **likely** means the code path was read but the event volume was not measured; **unchecked** means it comes from the review pass and has not been re-checked.

## 1. Ctrl+Alt shortcuts swallow characters typed with AltGr

**Location:** [web/views/overview.tsx:661](../../../web/views/overview.tsx#L661) · **Status:** confirmed

### Problem

The Overview's Ctrl+Alt shortcuts listen on the whole page, don't skip text fields and call `preventDefault`. Windows reports AltGr as Ctrl+Alt, so these shortcuts catch characters typed with AltGr. Windows is the app's main platform.

### Failure

On a German layout, typing `[` `]` `{` `}` `\` in a chat box on the Overview (AltGr+8/9/7/0/ß) jumps to pane 8, 9 or 7, evens out the columns or changes columns per view, and the character never appears. On a Polish layout, AltGr+O (ó) opens VS Code, AltGr+S (ś) stacks the pane and AltGr+N (ń) jumps to the next item that needs you.

### Suggested change

Ignore the event when it comes from an input, textarea or contenteditable element. Also ignore it when `e.getModifierState('AltGraph')` is true.

## 2. A new terminal pane is removed before the reload arrives

**Location:** [web/views/overview.tsx:162](../../../web/views/overview.tsx#L162) · **Related:** `newTerminal` at [web/views/overview.tsx:189](../../../web/views/overview.tsx#L189) · **Status:** confirmed

### Problem

The prune effect runs on every layout change against whatever Overview data is loaded at that moment. A pane opened for something the server hasn't reported yet is removed straight away.

### Failure

Click "New terminal in <project>". `newTerminal` POSTs, calls `change(openPane(...))` and only then `load()`. The effect on `[data, layout]` runs with the old data, which doesn't have the new terminal, so `prune()` drops the pane. The same happens when BrainPane's "Open" targets an agent or team the Brain just hired.

### Suggested change

Prune only when `data` changes, not `layout`, or keep newly opened panes until data newer than the open has loaded.

## 3. The Overview doesn't refresh while an agent is streaming

**Location:** [web/views/overview.tsx:144](../../../web/views/overview.tsx#L144) · **Status:** likely

### Problem

The refresh runs only after 300 ms without events, and every event restarts that wait. `run` is in `CHANGES`, and a run sends a `run` event for each text delta, so the refresh keeps being pushed back. The 60-second tick goes through the same timer and gets pushed back too.

### Failure

Agent A streams a long answer while agent B asks for an approval. The sidebar, the "Needs you" count and the panels stay stale until A's stream pauses for 300 ms.

### Suggested change

Cap how long a refresh can wait (for example, reload at most every 1–2 s while events keep coming), or don't let a pending reload be reset.

## 4. Other projects' tool images and workspace files fail to load

**Location:** [web/client/connection.ts:65](../../../web/client/connection.ts#L65) · **Related:** [server/toolimages.ts:86](../../../server/toolimages.ts#L86) · **Status:** unchecked

### Problem

`filesAt()` finds a file's project only by checking whether the path is inside a project's folder. Files of a project that isn't open, if they live under `data/projects/<id>/tool-images` or in agent workspaces outside the project folder, are sent to the open project, which refuses them.

### Failure

A pane of another project shows a tool call that returned images (`/api/file?path=…/data/projects/<other>/tool-images/…`). `filesAt` returns `''`, the open project handles the request, its `viewRoots()` doesn't include that folder, and the images come back as 403 (broken). Previews of files in the other project's agent workspaces fail the same way.

### Suggested change

Have the pane pass its own project id when it builds file links, instead of guessing it from the path.

## 5. Another project's questions can't be answered from its pane

**Location:** [web/chat/parts.tsx:121](../../../web/chat/parts.tsx#L121) · **Related:** `projectOfQuestion` at [server/questions.ts:125](../../../server/questions.ts#L125) · **Status:** unchecked

### Problem

The `ask_user` answer card matches questions from the app state, which holds only the open project's questions. A question from another project can't be answered from its Overview pane. `projectOfQuestion` is never reached from the browser, and because it looks questions up by id, ids can collide in copied projects.

### Failure

The Overview shows "Needs you · Question: …" for project B's agent. Opening the pane shows the `ask_user` call with no answer card, because B's questions aren't in the app state. In a copied project whose question ids match the open project's, the open project's waiting question shows in the copy's pane instead, and the answer goes to the open project.

### Suggested change

Load questions per project for each pane, match them by project and id, and send answers to that project's scoped route.

## 6. `emit()` labels events with the open project when no project is given

**Location:** [server/store.ts:17](../../../server/store.ts#L17) · **Related:** [server/eve/coordinator.ts:156](../../../server/eve/coordinator.ts#L156) · **Status:** unchecked

### Problem

When the caller leaves out `projectId`, `emit()` fills in `activeProject()`. Events sent outside a `withProject` context get the open project's id, and ChatView and team chats now drop events whose project doesn't match their own.

### Failure

`server/eve/coordinator.ts:156` emits `run` ("Reconnecting to Eve…") without a `projectId`, from the stream loop and outside the run's `withProject`. For a run of project B while A is open, the event is labelled A. B's pane drops it, and a pane of A's copy with the same agent and chat ids shows it.

### Suggested change

Pass the run's project explicitly at that call site, and look for other `emit` calls made outside `withProject`.

## 7. The server recomputes global lists and reads every chat file on each Overview refresh

**Location:** [server/overview.ts:264](../../../server/overview.ts#L264) · **Status:** unchecked

### Problem

`activeRuns()`, `listApprovals()` and `listTerminals()` are recomputed for every project. `newestChat` runs `statSync` on every chat file of every agent in every project. All of this repeats on each Overview refresh, which follows every chat, run, team and other change event.

### Failure

With 10 projects × 10 agents × hundreds of chats, each refresh blocks the server with thousands of `statSync` calls, and each global list is rebuilt 10 times.

### Suggested change

Compute runs, approvals and terminals once in `overview()` and pass them in. Record the newest chat time when a chat is saved instead of stat-ing every file.

## 8. Duplicate agent fetches on every `agents` event

**Location:** [web/projectagents.ts:909](../../../web/projectagents.ts#L909) · **Status:** unchecked

### Problem

Every component that uses `useProjectAgents` (AgentChatPane, TaskList, TeamChat) refetches its project's agents on each `agents` event, and requests already in progress aren't shared. Every one of them, including callers that pass `undefined`, re-renders whenever any project's agents load.

### Failure

With five panes of project B open, one `agents` event from any project sends about 10–15 identical `GET /api/p/B/agents` requests, and each response triggers `notify()`, which re-renders every TaskList on the page.

### Suggested change

Keep one in-flight promise and one event listener per project, and notify only the subscribers of the project that loaded.

## 9. The `/p/` project prefix is built by hand instead of with `projectAt()`

**Location:** [web/views/overview.tsx:71](../../../web/views/overview.tsx#L71), [web/views/overview.tsx:538](../../../web/views/overview.tsx#L538) · **Related:** [web/attach.tsx:226](../../../web/attach.tsx#L226) · **Status:** unchecked

### Problem

`openInVSCode` and `FilesPanel` build `` `/p/${encodeURIComponent(id)}` `` by hand instead of calling `projectAt()` from `web/client/connection.ts`, which this branch adds for that purpose.

### Failure

The prefix is now written in several places (`connection.ts`, `attach.tsx` and `overview.tsx` twice). If it changes and one copy is missed, Open in VS Code or the Files panel breaks.

### Suggested change

Use `projectAt()` everywhere.

## 10. Plain styled `<button>`s instead of the Button components

**Location:** [web/views/overview.tsx:303](../../../web/views/overview.tsx#L303) · **Status:** unchecked

### Problem

AGENTS.md says "Controls are components, not class strings". The Overview draws raw `<button type="button" className="…">` controls with their own styling: the status line button (303), the panel toggles (314), the project header (346), the breadcrumbs (548, 552), the file rows (566), the minimap (590) and the rail buttons (696).

### Failure

These buttons don't follow changes to the shared control styles in `web/ui/classes.ts`, and they repeat their own focus, hover and disabled styling.

### Suggested change

Use `Button` / `IconButton` from `web/ui/button.tsx`, or `buttonClass(...)` where a plain element is needed.

## Fixed

Every finding is fixed on the branch, with a test that fails without the fix (except 9 and 10, which change no behavior).

1. `b4817a4`: a Ctrl+Alt key that types something other than its plain character is left alone (Windows and Linux; on a Mac ⌃⌥ types nothing). Not `getModifierState('AltGraph')`: browsers report it for a plain Ctrl+Alt too.
2. `eea1266`: each pane remembers the newest overview request when it opened; only data asked for after that can prune it.
3. `c56ef4a`: the wait is capped at 2 s from the first change, so a streaming reply can't keep putting the reload off.
4. `768f703`: done in the browser, not the server, because `api.test.ts` checks that the open project's `/api/file` refuses another project's files. A chat knows its project (`web/chat/project.ts`): `filesAt()` falls back to it for paths outside every project folder, and `fileSrc()` sends a tool's `/api/file?` image to `/api/p/<project>/file`.
5. `b01f124`: `/api/p/<project>/questions` (and `…/answer`, `…/dismiss`) are scoped routes; a pane's chat reads its project's questions and answers there.
6. `c83cb46`: the event carries its binding's project. The other events of this kind that leave the project out were checked; they are sent inside the run's `withProject`.
7. `771f621`: runs, approvals and terminals are read once per overview; each agent's newest chat is cached and kept current by the `chats` events, and read from the files again after 5 minutes.
8. `365c7ac`: `web/projectlist.ts`, one listener and one request in flight per project.
9. `095fdf1`: `projectAt()` in `overview.tsx` and `attach.tsx`.
10. `4a36fda`: the status line's "needs you" action and the panel switches are `Button`s. The session rows, breadcrumbs, file rows, minimap ticks and rail marks stay plain buttons: they are rows and marks, as on the task board and in the Station panel.
