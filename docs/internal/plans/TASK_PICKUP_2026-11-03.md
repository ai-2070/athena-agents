# Tasks board: assigned agents and teams pick up their tasks

3 November 2026. Plan for `LZL0/task-board` (PR #115), extending the [Tasks board](../../guide.md) and building on
[automatic work completion](WORK_COMPLETION_2026-11-01.md). Not built yet.

## What we want

When you move a task to **In progress** and it is assigned to an agent or a team, that agent or team picks it up. It
works on it in its own chat, replies on the task as comments, and moves it on: to **In review** when it is done, to
**Blocked** with a reason when it can't be done. Teams work from day one, not later. Files go both ways: what you
attach to a task or a comment reaches the agent or team, and the files they produce come back attached to their
comment.

## Decisions

These are the defaults this plan builds. The open questions at the end can change some of them.

1. **What starts it:** your own move to In progress (board drag, keys, card menu, the task page's Status), or assigning an
   agent or team to a task that is already In progress. A **Start** button on the task page does the same, and
   **Start again** after it is stopped or blocked. The Brain's and the agents' own moves never start it: the Brain hands
   out work itself, and a worker moving its own task must not restart it.
2. **To do does not start it.** New tasks land in To do, so starting there would launch work on every task you add
   and assign. To do means "not yet". (Open question 1.)
3. **One piece of work per task at a time.** While one runs, the task shows who is working and a Stop button. Moving
   it again, or a second Start, does nothing until it ends.
4. **Agents and teams are supervised the same way the Brain supervises work it hands out.** A completion brief with a
   new origin, `board`, checks the result after each turn, continues unfinished work, and settles as delivered or
   blocked. This gives teams a "finished" signal they don't have today, and gives every engine the same rules,
   including Hermes and OpenClaw, which get no dashboard tools.
5. **The worker moves the card itself, and the check is the backstop.** Agents get board tools for their task.
   `board_status` moves it to In review or Blocked straight away, so you see it happen. When the turn ends, the
   completion check runs anyway:
   - **Delivered:** the card goes to In review, if it isn't there already, with the check's summary as a comment.
   - **Blocked or stuck:** the card goes to Blocked with the reason, and the question appears in Needs you.
   - **Unfinished,** even though the worker said In review: the card goes back to In progress with a comment saying
     what is missing, and the Brain follows up as it does today.
6. **Nobody but you moves a task to Done.** The tool refuses Done, and so does the check. This is the rule the Brain
   already follows for board tasks.
7. **Your comments reach the worker while it works.** A comment you add, with its files, is queued into the agent's
   chat or the team thread as your message. It doesn't stop the work in progress. Comments from the Brain or
   from agents don't do this.
8. **Moving the task away stops the work, after asking.** Moving a working task to To do, Blocked or Done, giving it to
   someone else, or removing it first asks "Writer is working on #4. Stop it?" and then stops the run (or the team's
   turns). Reassigning then starts the new assignee if the task is still In progress.
9. **Always on.** Starting shows a message ("Writer started on #4", with a Stop button), so starting by mistake is one
   click to undo. (Open question 2.)

## How it works

### Data (`shared/types.ts`)

```ts
/** A file on a task or a comment: in the task's project's uploads folder (path relative to it). */
interface TaskFile { path: string; name: string; size: number; by: string; at: number }

/** The work an agent or team is doing on a task (one at a time; the last one stays for its history). */
interface TaskWork {
  by: string;                 // agent:<id> | team:<id>
  briefId: string;            // the completion brief (origin 'board')
  chatId?: string;            // an agent's chat for this task
  messageId?: string;         // a team: the message that handed it the task
  startedAt: number;
  endedAt?: number;
  state: 'working' | 'waiting' | 'review' | 'blocked' | 'stopped' | 'failed';
}

ProjectTask  += { files?: TaskFile[]; work?: TaskWork }
TaskComment  += { files?: TaskFile[] }
BrainBrief   += { origin?: 'chat' | 'board'; boardTask?: { projectId: string; taskId: string } }
```

`BoardTask` (what the page gets) adds `work` with the worker's name and mark, and `waiting: true` while a run of it
waits for an approval or a question. `restoredBoard()` checks the new fields the way it checks the others.

**Files are stored relative to the project's uploads folder,** not as absolute paths like chat attachments. That
way a cloned or restored project points at its own copy. For tasks in "All projects", files always go to the task's own
project.

### Files from you (in)

- **Uploading:** the New task window, the description editor and the comment box get the app's attachment tray
  (`attachTray`: paperclip, drag and drop, paste). The tray uploads to the open project's uploads folder.
  `POST /api/task-board/...` and `PUT` take `files: string[]` (uploaded paths). The server checks them with
  `cleanAttachments` and, **when the task is in another project, copies them** into that project's uploads folder
  under `tasks/<taskId>/`. This gets round the "active project" trap: uploads and `/api/file` only allow the open
  project's folder.
- **Viewing:** `GET /api/task-board/:projectId/:id/files/:path` serves a task's file. It looks the file up in that
  task's `files`, or its comments' `files`, inside `withProject(p)`, and sends it with `sendFileSafely`. So a task's
  files show even when another project is open, without widening `/api/file`.
- **Showing:** chips and image previews under the description and on each comment, reusing `attachmentChips` /
  `Previews`, with a paperclip and count on the card.
- **Handing on:** the task's files plus every comment's files go to the worker as attachments. For an agent that
  means `startRun(..., { attachments })`; for a team, `postUserMessage(..., { attachments })`. Absolute paths are made
  in the task's project. A queued comment (decision 7) carries its own files.

### Starting the work (`server/taskpickup.ts`, new)

- **The hook:** `PUT /api/task-board/:projectId/:id` (`server/index.ts:523`) calls `pickUp()` after
  `changeBoardTask` when the change came from you and meets decision 1. The Brain's `board_update` calls
  `changeBoardTask` directly, so it never triggers a start. The Start button is
  `POST /api/task-board/:projectId/:id/start`.
- **What the worker is told** is one message:
  - the task's number, title, priority and project, and its description;
  - the last 20 comments, with who wrote them and the names of their files;
  - the rules: "Work on this task. Comment on it with `board_comment` (attach what you made). When it is done, move it
    to In review with `board_status`; if you can't finish it, move it to Blocked and say why. Never move it to
    Done."
  - For Hermes and OpenClaw, the same rules say to write the result and the reason in the final reply instead.
- **Agent:**
  - In `withProject(p)`: `chats.create(agentId, '#12 Title')`, then a brief through a new
    `sendBoardBrief()` in `server/irc.ts`, next to `sendNow`. It uses the same `addBrief` + `runForBrief` path,
    with `origin: 'board'` and `from: 'Tasks board'`.
  - Setting `from` matters: without it, the run looks like your own message and `userWorkHook` would open a second
    brief.
  - A fresh chat per task means the agent being busy elsewhere doesn't block it (runs are limited per chat, not per
    agent).
  - `boardTask.work` gets `{ by, briefId, chatId, state: 'working' }` and the board is told.
- **Team:**
  - In `withProject(p)`: `postUserMessage(teamId, text, { attachments, route: pickMember })`, with a brief
    `{ kind: 'team', origin: 'board', messageId }`.
  - The team's lead or `pickMember` takes it, as with any message. Teams already hand work on by @mention and report
    back to the lead.
  - The team's existing idle check (`teamIdle` in `irc.ts`) reviews the thread since that message, so a team gets the
    same delivered/blocked verdict as an agent. No second "idle" listener is needed; the slot in `setBrainHandlers`
    is already irc's.
- **Always supervised:** board briefs are kept even when the Brain's follow-ups setting is off, the way an explicit
  `/goal` is. Without that, a team would never report back.

### The worker's tools (`server/boardtools.ts`, new)

These are in a `board` tool group, given only to runs working on a board task. They are added per run through
`workAccess: { toolGroups: ['board'] }`, as `askAgent` does, so they never show up in ordinary chats. The tool finds its
task from the run: `runInfo(ctx.runId)`, then the chat's (or team's) open brief with `origin: 'board'`, then
`brief.boardTask`. That is the pattern `inContext()` in `server/tasktools.ts` uses, and it works for team members
too.

| Tool | What it does | Risk |
|---|---|---|
| `board_task` | Reads its task: title, description, comments, file names and paths. | none |
| `board_comment { text, files?: string[] }` | Comments as `agent:<id>`. Each file must be readable by this agent (inside its allowed folders, `insideRoots`, no links out) and is copied into the task's project under `uploads/tasks/<taskId>/`. At most 20 files per comment, 500 MB each. | none |
| `board_status { status: 'in_review' \| 'blocked', reason? }` | Moves its own task. Blocked needs a reason. Done is refused. | none |

The risk is `none` because these only change this dashboard's board, like the task tools. They don't send anything
outside, delete anything or run code. Copying a file is limited to files the agent can already read.

**When no tool is used** (Hermes, OpenClaw, or an agent that forgot), the turn's final reply becomes the comment.
Absolute paths in it that the agent can read are attached the same way: the server-side match of
`findFileMentions`.

### Settling (`server/irc.ts`)

`report()` and `needsUser()` already decide where the Brain's words about a brief go. A `board` brief goes to its task:

- **Delivered** (`settle` → done): comment "Done: summary" as the Brain, card to In review, `work.state = 'review'`.
- **Blocked or stuck** (`needsUser`): comment with what is missing, card to Blocked with the reason (300 characters),
  `work.state = 'blocked'`, and the usual Needs you question with its `briefId`. Answering the question, or
  commenting on the task, reopens the brief (`resumeBrief`), and the card goes back to In progress.
- **Unfinished:** the Brain's follow-up is sent as today. If the worker had moved the card to In review, it goes back to
  In progress with a comment.
- **Stopped** (Stop, or decision 8): `work.state = 'stopped'`, comment "Stopped by you". The card stays where you put it.
- **Run failed** (an error, the engine missing): `work.state = 'failed'`, card to Blocked with the error.
- **Restarts:** after the dashboard restarts, `recoverWork()` resumes open board briefs as it does other briefs.

### Stop and steer

- **Stop** (`POST /api/task-board/:projectId/:id/stop`): for an agent, `stopChat(chatId, projectId)`; for a team,
  `stopTeamWork` plus stopping its turns. The brief becomes `stopped`. The card's and task page's Stop buttons use this.
- **Your comment while it works** (decision 7):
  - agent: `queueMessage(agent, chat, text, files, { from: 'you' })`;
  - team: `queueUserMessage(teamId, text, { attachments })`.
  - The brief takes the change into account, as steering already does.
- **Approvals and questions** work as they do now. The card shows **Needs you** (amber) while
  `listApprovals()` or a waiting question has the run's id.

### On the page

- **Card:** the worker's mark with a small pulsing dot while working, amber **Needs you** while waiting, and a paperclip
  with a count when there are files.
- **Task page, right side, a "Work" box:**
  - who has it, and the state ("Working", "Needs you", "Ready for review", "Blocked", "Stopped");
  - **Open chat**: the agent's chat (`#/agents/<id>/<chatId>`), or the team chat (`openChat('team', id)`);
  - **Stop** while working, **Start** / **Start again** otherwise.
- **Files:**
  - the description shows its files, with "Attach files" in its editor;
  - the comment box has the paperclip;
  - comments show their files as chips and image previews.
- **Activity:** "Writer started working · 2m ago" and "Stopped by you" as entries between comments, taken from
  `work`.
- **When it starts:** the message "Writer started on #4" with a **Stop** button.

### The Brain

`boardLines()` adds `| working: Writer` and `| files: 2`, so the Brain can say who is on what. The Brain's own
`board_update` still doesn't start work; it hands work out with `delegate` as now.

### Backups and project copies

Uploads are not in `.dashbackup` files or in `<project>/.dashboard` today, so a restored board would show files that
are gone.

- **`.dashbackup`** includes the files referenced by board tasks, up to 500 MB in total. Past that it leaves the rest out
  and says so in the backup's summary.
- **`<project>/.dashboard`** (the folder kept beside the project's own files) keeps the paths only. Big binary files
  don't belong in a project's working folder.
- A file that is missing shows as "File missing" rather than a broken link.

## Security

- Every new route checks the `Host` header, `x-dash: 1` and `Sec-Fetch-Site` as all routes do. The file route serves
  only paths listed on that task, inside that project's uploads folder, through `sendFileSafely`.
- Agents can attach only files they can already read (`insideRoots` over their allowed folders, links resolved, nothing
  outside the data folder followed). Files are copied, never moved, and secrets are never in reach.
- A run's board tools act on its own task only. They are refused when the run is gone, stopped, or belongs to another
  agent (`runInfo` checks, as in the task tools).
- Work happens in the task's own project (`withProject`), whichever project is open (the rule for runs).

## Building it, in order

Everything ships together. This is the order to build and review it in:

1. **Files in:** the data shape, uploads into the task's project, the file route, and the tray and chips on the New
   task window, the description and comments. Backups.
2. **Starting and settling for agents:** `taskpickup.ts`, `sendBoardBrief`, the `board` origin in `report`/`needsUser`/
   `settle`, Stop, comments while working, `work` on the card and the Work box.
3. **The worker's tools and files out:** `boardtools.ts` with per-run `workAccess`, copying the agent's files, and the
   final-reply fallback.
4. **Teams:** the brief's message, `teamIdle` settling, team Stop, queued comments, team members' tools through the
   team brief.
5. **Docs:** README and `docs/guide.md` (the Tasks section), and the Brain's board instructions.

## Tests

- **Server:**
  - Moving to In progress starts an agent's run in its own chat with the task's files, and a team's message with them.
    Moves to To do, the Brain's moves and reordering don't.
  - A second Start while working does nothing. Stop ends it and marks it stopped.
  - The board tools act on their own task only. Done is refused, Blocked needs a reason, files outside the agent's
    folders are refused, and files are copied into `uploads/tasks/<id>/`.
  - Settling: delivered goes to In review, blocked to Blocked with the reason and a Needs you question, unfinished back
    to In progress. A failed run goes to Blocked.
  - The final-reply fallback comments and attaches paths it can read.
  - Your comment while working reaches the agent's chat or the team.
  - A task in another project gets copies of the files. The file route refuses paths not on the task.
  - Restart recovery. Backups include task files.
- **Web:** the tray on the three places, chips and previews, the Work box states and its Stop and Start, the card's
  working and Needs you marks, the started message's Stop, and the stop-first dialog when moving a working task.
- `bun run check`, and the desktop smoke (`desktop:smoke`), because the file route and backup change touch bundling.

## Open questions

1. **To do:** you asked for To do and In progress. Starting on To do would also start every new task you assign. Keep
   In progress only, or start on To do too (perhaps only when you assign it, not when it is created)?
2. **Always on, or a switch?** Default here is always on, with a Stop in the message. A per-project switch
   ("Assigned agents and teams start their tasks") is easy to add.
3. **Needs you:** a blocked task already shows on the board. Keep the Needs you question too (the plan does, so blocked
   work is in one place), or only the board?
4. **Backups:** include task files up to 500 MB (the plan), always, or never?
5. **Cost:** each finished turn adds one Brain model call for the completion check. That is the same as delegated work
   today. Fine as is?
