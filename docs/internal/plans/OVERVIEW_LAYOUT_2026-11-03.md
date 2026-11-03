# Overview: one project or all of them, in one view

3 November 2026. Plan. **Step 2 is built too**: the strip for the open project, with terminals
(`web/overviewlayout.ts` for the layout, `web/terminalview.tsx` shared with the Terminals page, `Terminal.projectId`).
Columns per view, pinning, stacking, dragging, resizing, the rail, the minimap, the Ctrl+Alt keys and the saved layout
are in. A pane's header shows its status; Open folder in VS Code comes with step 4.

**Step 1 is built** (`LZL0/overview`): `GET /api/overview` (`server/overview.ts`), the page
(`web/views/overview.tsx`) with the sidebar, Needs you and Working now, and the status line. Approvals now say their
project. The old hidden Overview page (`#/home`) is called Home. Not in step 1 yet: dragging your own order, and events
that carry `projectId` (the page reads the overview again, a moment after any change that matters).

**Decided (3 November):**
- It's called **Overview**, and it's an additional page. The Station stays the start page.
- Terminals open as panes from the first strip step.
- Git changes and pull requests aren't built now. The side panels are made so they can be added later without changing
  the page.
- Kanso's Cmd keys for the desktop app are in the plan, but come after everything else (see Keys).

A new page, **Overview** (`#/overview`), modelled on [Kanso](https://github.com/jlopezlira/herdr-kanso), a layout for
the Herdr terminal app. It shows every project's agents, teams and chats in one sidebar, opens them side by side on a
strip where each keeps its width, and says at a glance what needs you. It works for the open project or for all of them.

## What Kanso does, and what we take

Kanso has four parts:
1. **One sidebar for every repository**, with its worktrees and sessions (agents, shells, dev servers) under it. Each
   session has a status dot. You can sort by **Needs you first**, last update, kind, as on screen, or your own order
   (drag), and pin the important ones.
2. **A strip of panes that keep their width.** It shows 1 to 8 columns per view and slides sideways instead of
   squeezing everything into a grid. A pane can be pinned so it stays in view while the rest slides, or stacked, two in
   one column (a server above a test agent). A rail at the edge shows what is off screen, and a small minimap shows
   where you are.
3. **Side panels next to the strip:** Files, Changes (diff and commit), pull requests, and an Open with editor key.
4. **A status line:** "1 agent needs you · 4 of 7 working", the machine and the branch.

It also stays light: a panel exists only while it is open, and panes off screen aren't drawn.

| Kanso | Athena |
|---|---|
| Repository | **Project** (its letter mark or logo, its name, how many are working) |
| Worktree with its branch | An agent's own **workspace folder**, with its Git branch when it is a repository (a later step) |
| Session: agent, shell, dev server | **Agent chat**, **team thread**, **the Brain**, **terminal**; and a task's work (`board-<taskId>`) |
| Needs you | **Approvals**, **questions** in the Outbox, **blocked completion checks**, board tasks waiting for your OK |
| Pane | A chat, made by the same components as today (`renderAgentChat`, `renderTeamChat`, the Brain's chat view, a terminal) |
| Files and Changes panels | **Files** (the project folder, with the previews we already have). Changes and pull requests come later |
| Open with (Cmd+Shift+O) | **Open in VS Code** (the folder action we have), and the desktop app's open-with |
| Status line | "2 need you · 4 of 7 working · 3 projects", and the open project's folder save |

**Left out:** Kanso's theme (we use our own tokens and look), its native window captures, and Spend and Specs.

## The page

```
┌ Overview ──────────────────────────────────────────────────────────────────────────────┐
│ [This project ▾]  ⇅  ⌕  │ ‹ Writer · Bakery ● working ┃ Thumbs team · Bakery ● Needs you ┃ … ›│ Tasks │
│ ● Bakery        2 work… │                              ┃                                  │ Needs │
│   ✳ Writer        ●     │  (the agent chat, as today)  ┃  (the team thread, as today)     │ Files │
│   ◎ Photographer  !     │                              ┃                                  │       │
│   ⧉ Thumbs team   !     │                              ┃──────────────────────────────────│       │
│   ✦ The Brain           │                              ┃  Terminal: dev server (stacked)  │       │
│ ○ Podcast       idle    │                              ┃                                  │       │
│   …                     │                              ┃                                  │       │
├─────────────────────────┴──────────────────────────────┴──────────────────────────────────┴───────┤
│ ● 2 need you   ● 4 of 7 working   3 projects                       ━ ━ ─ ─   columns: − 2 +      │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### The sidebar
- **Scope**, at the top: **This project**, **All projects**, or one project. It's remembered, like the board's choice.
- **Each project is a group:** its mark, its name, and "2 working" or "1 needs you". It folds. Under it come its
  sessions:
  - each agent's chats (the newest first, the rest under "More");
  - each team's thread;
  - the Brain;
  - terminals;
  - tasks being worked on, each named "#4 Write the menu".
- **Each session row:** its kind's icon or the agent's mark, its name, and a status:
  - a breathing dot while it works;
  - **!** in amber when it needs you;
  - a quiet dot when it changed since you last looked;
  - nothing when idle.
- **Sort** (the ⇅ menu): pinned ones first, then by **Needs you first** (the default), **Last update**, **Kind**,
  **As on screen**, or **Your order** (drag).
- **Pin** a session (hover it, click the pin) to keep it at the top of its project. Double-click to rename a chat.
- **Search** (⌕) narrows the rows by name and project.
- **Clicking a row** opens its pane, or slides to it when it's already open. **Alt-clicking** opens it in a chat window
  instead, as today.

### The strip
- **Panes keep their width.** Choose 1 to 8 columns per view (− and + in the status line). The view slides sideways
  and never squeezes.
- **A new pane** opens next to the one you're in, and the view glides to it (with `prefers-reduced-motion`, it jumps).
- **Pin** a pane to keep it in view at the left while the rest slides.
- **Stack** two or three panes in one column (a dev server's terminal above the agent working on it). Drag the line
  between them to resize.
- **Drag a pane** by its grip onto another: the left or right quarter puts it before or after, the middle stacks it.
- **The rail** at each edge shows the off-screen panes as small marks with their status, so one that needs you is seen
  even when it is out of view. Clicking a mark slides to it.
- **The minimap** in the status line: one dash per pane, the ones on screen brighter. Scrolling over it slides the view.
- **A pane's header:** its icon, name and project (in All projects), the agent's workspace branch (later), a status
  pill, and a menu with Pin, Stack, Open in a chat window, Open folder in VS Code, and Close.
- **Panes off screen keep their place** but aren't drawn. Their chat stays connected for status only, and is drawn
  again when it comes into view.
- **What's open is remembered** in this browser: panes, widths, pins, stacks and columns, for each scope.

### The side panels
On the right, one at a time, folding away:
- **Tasks:** the board in a column, for the scope;
- **Needs you:** approvals and questions, answered right there;
- **Files:** the project folder, opening with the previews we have.

**Changes** (Git diff and commit) and **Pull requests** are not built now. The panels are a small list (`id`, label,
icon, the component, and whether it shows in this scope), so adding them later means adding one entry, with no change
to the page.

### The status line
- "**2 need you**": click to open Needs you.
- "**4 of 7 working**": click to slide to the next one working.
- The number of projects, in All projects.
- The minimap and the columns control.
- In This project: the folder save ("auto-saved 2 min ago"), as the sidebar shows today.

## How it fits what exists
- **The Station stays the home and the start page.** Overview is an additional page, a new sidebar item next to Tasks.
  It replaces neither the Station nor the chat windows. A pane can go to a chat window and back (its menu, or dragging it onto the map later).
- **The chats are the same components**, so everything they do comes along: queued messages, approvals in the chat,
  /commands, @ pills, files.
- **Tasks with work** (the board pickup) appear as sessions under their project and open their private chat or thread.

## Terminals as panes

Terminals today belong to the PC, not a project. `server/terminals.ts` keeps each one's id, title, command and agent;
the Terminals page draws them with xterm over a WebSocket (`XTerm` in `web/views/terminals.tsx`).
- **Their own component.** `XTerm` moves to `web/terminalview.tsx`, exported, so the Terminals page and a pane draw the
  same thing. A pane keeps its terminal connected while it is open, also off screen (a terminal is cheap and its output
  must not be lost). It is fitted again when its width or stack height changes.
- **Which project.** A terminal saves the open project's id when it is made (`Terminal.projectId`), and shows under that
  project in the sidebar. Older ones, and ones made from the Terminals page with no project, go under **This PC** at the
  bottom of the sidebar, in every scope.
- **New terminal** in a project's group menu opens PowerShell (or the shell) in the project's folder, or a Claude Code or
  Hermes terminal for one of its agents, as the Terminals page does. It opens as a pane next to the current one.
- **Status:** a running terminal is "open", one that has ended shows its exit code. Terminals don't need you, so they
  never sort first under Needs you first.
- **Stacking** suits them: a dev server's terminal above the agent working on that code.
- Closing a pane doesn't end its terminal. **End terminal** in the pane's menu does, after asking.

## What has to change underneath

The app opens one project at a time. The server keeps the open project globally (`activeProject()`), the page's state
holds that project's agents only, and a change made for any other project is refused (the `x-dash-project` guard). Only
the board names its project in its addresses. "All projects" needs three things:

1. **Project-scoped addresses: `/api/p/<projectId>/…`.** The router takes the prefix off, finds the project, runs the
   usual route inside `withProject(project)`, and lets that request past the open-project guard (it names its project,
   as the board's routes do).
   - Routes that only make sense globally (projects, settings, accounts, backups, gateways) refuse the prefix.
   - The routes the panes use first: agent chats (read, send, stop, queue), team threads (read, post, stop), the
     Brain's chat (`ask` already takes a project), approvals, questions, terminals, files.
   - Audit the code those routes reach for anything that reads the open project outside `withProject`'s pin. Most code
     already uses `activeProject()`, which follows the pin.
2. **An overview of every project: `GET /api/overview`.** For each project:
   - its agents and teams, with names and marks;
   - its chats (title, last update);
   - what is running (the engine's run list is already global and has `projectId`);
   - what needs you;
   - the board's open count.
   It is read once, then kept current from events, and kept small: no chat contents.
3. **Events say their project.** `run`, `team`, `chat`, `brief`, `approvals` and `questions` events carry `projectId`
   where they don't yet, so the page updates the right project without reloading everything. Audit every `emit` these
   panes listen to.

On the page:
- **`web/client`** gets `scoped(projectId)`: the same `GET`/`POST`/… with the prefix, used when a pane's project isn't
  the open one.
- **The chat components** take a `projectId` and a data source for that project's agents and teams
  (`useProjectData(projectId)`), instead of reading the open project's `state.data`. This is the largest change:
  `ChatView`, `teamchat.tsx` and the Brain's chat each read `state.data` in several places.
- The **Overview page** (`web/views/overview.tsx`, React) has:
  - the sidebar, the strip and the status line;
  - the panes' layout as a small store (`web/overviewlayout.ts`) saved in `localStorage`.

## Keys

A browser takes Cmd+W, Cmd+D and Cmd+1…9 (close tab, bookmark, switch tab). On a Mac, Alt plus a key types a
character in a text box (Alt+P is π), so Alt alone would get in the way while you write. The page uses **Ctrl+Alt**
(⌃⌥ on a Mac), as the chat windows already do. The desktop app adds Kanso's Cmd keys later (below).

| Keys (⌃⌥ on a Mac) | What they do |
|---|---|
| Ctrl+Alt+1 … 9 | Go to pane 1 to 9 |
| Ctrl+Alt+[ and Ctrl+Alt+] | Previous and next pane (the view glides to it) |
| Ctrl+Alt+Shift+[ and ] | Move the pane left and right |
| Ctrl+Alt+− and Ctrl+Alt+= | Fewer or more columns per view |
| Ctrl+Alt+P | Pin the pane |
| Ctrl+Alt+S | Stack the pane onto the one before it |
| Ctrl+Alt+W | Close the pane |
| Ctrl+Alt+O | Open the pane's folder in VS Code |
| Ctrl+Alt+N | Jump to the next session that needs you |

They're listed in the shortcuts help. The chat windows' Ctrl+Alt keys are the arrows, so none of these clash with them.

**Later: Kanso's Cmd keys in the desktop app.** The desktop app can take Cmd keys a browser keeps, so it can offer
Kanso's as well (Ctrl+Alt still works there). Only while Overview is shown, and only after the rest is built.

| Keys (desktop app, macOS) | What they do |
|---|---|
| Cmd+1 … Cmd+9 | Go to pane 1 to 9 |
| Cmd+[ and Cmd+] | Previous and next pane |
| Cmd+D, Cmd+Alt+D, Cmd+Shift+D | New pane right, left, below (stacked): asks what to open |
| Cmd+Alt+Up and Cmd+Alt+Down | Move the focus within a stack |
| Cmd+W | Close the pane |
| Cmd+Shift+[ and Cmd+Shift+] | Move the pane left and right |
| Cmd+Shift+− and Cmd+Shift+= | Fewer or more columns per view |
| Cmd+Shift+0 | Even the panes out |
| Cmd+Shift+O | Open the pane's folder in VS Code |
| Cmd+Alt+P | Pin the pane |

On Windows the desktop app keeps Ctrl+Alt only: Ctrl+W, Ctrl+D and Ctrl+1…9 are too common there.

## Look

"Linear, but white" as everywhere: quiet surfaces, hairline borders, one accent, Geist.
- Pane headers are `bg-panel` with a hairline. The focused pane gets the accent's thin border.
- Needs you uses amber (`text-amber`), and a pill in the pane header.
- Working is the breathing dot the board uses.
- Light and dark come from the tokens.
- No new CSS beyond what utilities can't reach: the strip's snap scrolling and the minimap.

## Building it, in order

Each step ships on its own and is useful by itself.

1. **Overview, read-only, all projects.**
   - Build: `GET /api/overview`, events with `projectId`, the page's sidebar (scope, groups, status, sort, pin,
     search) and the status line.
   - Clicking a session in the open project opens it in the existing chat window. In another project, it asks "Open
     <project>?" and switches, as the project menu does.
   - This alone gives the cross-project "what needs me" view.
2. **The strip, for the open project, with terminals.**
   - Panes with the existing chat components and terminals (`web/terminalview.tsx`, `Terminal.projectId`); columns,
     pin, stack, drag, the rail, the minimap, the keys, saving the layout.
   - Panes off screen not drawn.
3. **Project-scoped addresses and panes from any project.**
   - Build: `/api/p/<projectId>/…`, `scoped()`, the chat components with `projectId` and `useProjectData`.
   - In All projects, panes from different projects sit side by side and you can write to each.
4. **Side panels:** Tasks, Needs you, Files; Open in VS Code from a pane.
5. **Later, when wanted** (the panel list makes room for them):
   - Changes (Git status, diff and commit for a project or an agent's workspace) and Pull requests (`gh`, as Kanso
     does), with "Ask the agent to address the feedback".
   - Branches on sessions, from agents' workspace folders.
   - Kanso's Cmd keys in the desktop app (see Keys).

## Tests
- **Server:**
  - `/api/p/<id>/…` runs in that project: reading and sending in an agent chat of a project that isn't open, a team
    post, Stop.
  - Global routes refuse the prefix, the open-project guard still refuses unscoped changes, and a missing project gives
    404.
  - `GET /api/overview` counts working and needs you per project and has no chat contents.
  - Events carry `projectId`.
  - A new terminal saves the open project; older ones without it are listed under This PC.
- **Web (happy-dom):**
  - the sidebar's scope, sorting (Needs you first, your order), pinning and search;
  - opening, sliding to, pinning, stacking and closing panes, and the layout coming back after a reload;
  - the rail showing an off-screen pane that needs you;
  - a terminal pane: it connects, is fitted again when resized or stacked, and closing the pane leaves the terminal
    running while End terminal ends it;
  - the keys;
  - a pane from another project sending through the scoped address.
- **Desktop:** `bun run check`, the desktop smoke, and a look in the macOS app, where WebKit differs (focus and
  selection, as the mention editor showed).

## Open questions
None left: the five from the first draft are answered at the top.
