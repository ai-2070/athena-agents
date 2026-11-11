# Tasks board: assigned agents and teams pick up their tasks

3 November 2026. Plan for the Tasks board, which is on `main` since PR #121.

## Status (3 November, later)

Built on `LZL0/task-pickup`: `LZL0/gateways` (`80fc566`) with `main` merged in. The merge hides the board from a
private conversation's Brain. Agents, teams, files both ways, Stop / Start / Check saved work, the Work box and card
marks, Brain scoping and backups are done, with tests (`tests/server/boardwork.test.ts`, `taskboard.test.ts`,
`api.test.ts`, `tests/web/tasks-board.test.tsx`).

Where it differs from the plan below:

- **Gateway files are untouched.** `LZL0/gateways` still gets new commits every few hours, so nothing was taken out of
  it yet. `server/boardwork.ts` has its own completion reader, written like `gateways/execution.ts`.
  `server/boardfiles.ts` has its own copy of the gateway file checks. Moving both into shared modules
  (`assignments.ts`, `deliverables.ts`) is a follow-up once #112 lands.
- **Two tools, not three**, and in the `core` group like the gateway file tools: `board_task` (read) and
  `board_reply { text, files, status, reason }`. They check at run time that the run's conversation is the task's.
  That avoids per-run tool groups, which team members' runs don't get.
- **The latest brief in the task's conversation** settles it, not one fixed revision. Your comments reach the worker
  as new messages and open a new revision, and the conversation belongs to that task only.
- **A team starts in the background.** Picking a member can ask a model, so the card says Starting until the message
  is posted. Comments passed on to a worker don't hold up the request either.
- **No limits of the board's own**: no cap on files per task or comment, file size, text length, comments or tasks, and the
  worker gets every comment in full. Backups take as many task files as the backup file can still hold (it unpacks to
  at most 512 MB in all).
- **Not built:**
  - the card going back to In progress when the check finds the work unfinished after the worker said In review;
  - "started working" entries between the comments (the Work box and the started message say it);
  - the Brain as an assignee (open question 3). Built since (8 November): `ask()` in the task's conversation, then
    the board follows the agent's chat or team's thread it handed the work to (`TaskWork.handedTo`), or settles from
    the Brain's own answer.

**Rewritten the same day to build on [Gateways](CHAT_GATEWAYS_2026-11-01.md) (`LZL0/gateways`, PR #112).** Gateways
already hands a piece of outside work (a Telegram, Slack or Discord message) to the Brain, an agent or a team, gives it a
conversation of its own, follows it until it is finished, and takes files in and out with strict checks. A board task
handed to its assignee is the same job with a different source, so this plan reuses those parts instead of building a
second copy. **Build it on a new branch from `main` after PR #112 lands.**

Last checked against `LZL0/gateways` at `c24e0f3` (3 November, 09:05). The newer commits add WhatsApp, turn Discord
on and add review screens for lost Discord and WhatsApp messages. None of the parts in the table below changed. What
changed around them is in [Since the last check](#since-the-last-check).

## What we want

When you move a task to **In progress** and it is assigned to an agent or a team, that agent or team picks it up. It
works on it in a conversation of its own, replies on the task as comments, and moves it on: to **In review** when it is
done, to **Blocked** with a reason when it can't be done. Teams work from day one, not later. Files go both ways: what
you attach to a task or a comment reaches the agent or team, and the files they produce come back attached to their
comment.

## What Gateways gives us

| Gateways piece                                                                                                                                                                                                                                                                                                              | Where (PR #112)                                                                                         | What the board uses it for                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Private conversations**: a conversation id gets its own agent chat (`privateAgentChat`) or its own copy of a team (`privateTeamId`). The copy uses the team's own turns, queue and recovery, but keeps a separate thread.                                                                                                 | `server/private-conversations.ts`, `chats.create(..., conversationId)`, `RunInfo.conversationId`        | **Each task is a conversation**, `board-<taskId>`. An agent works on it in a chat of its own. A team works on it in a private thread, not in its main chat, so two tasks given to one team don't mix. Starting again later continues the same conversation, so the worker sees earlier attempts. |
| **Scoped Brain and tools**: the Brain's snapshot, briefs, approvals, conversation search and task lists only show what belongs to that conversation. Cross-team relays are off in private threads.                                                                                                                          | `overseer.ts snapshot({conversationId})`, `conversations.ts`, `tasks.ts`, `teams.ts`                    | A worker on task #4 can't read or be steered by task #7's conversation.                                                                                                                                                                                                                          |
| **Ids fixed before work starts**: `startRun(..., { reservedRunId, from, userInitiated })` and `postUserMessage(..., { messageId, sender })` take an id chosen in advance.                                                                                                                                                   | `server/engines/index.ts`, `server/teams.ts`                                                            | The task saves the id first and then starts. After a restart the board checks that id instead of starting the work twice.                                                                                                                                                                        |
| **The normal completion brief**: `userInitiated: true` on a run with a `from`, or a user message with a `sender` on a team, opens the automatic brief, with checks, follow-ups, and Needs you when blocked. For a private conversation, `report()` writes the Brain's verdict into that chat or thread, not the Brain chat. | `server/irc.ts` (`report`, `onUserWork` with `messageId`)                                               | No new brief kind and no changes to `settle`/`needsUser`. The board reads each brief's outcome.                                                                                                                                                                                                  |
| **Completion checks**: `agentCompletion`, `teamCompletion`, `briefFor`, `checkBrief`. They also wait for delegates and background work, and recognise a changed brief.                                                                                                                                                      | `server/gateways/execution.ts`                                                                          | Knowing when an agent's or a team's work on a task is finished, delivered or blocked, and with what answer.                                                                                                                                                                                      |
| **Approval waiting**: `approvalPending()` finds an approval for a run in this conversation.                                                                                                                                                                                                                                 | `server/gateways/execution.ts`                                                                          | The card's **Needs you**.                                                                                                                                                                                                                                                                        |
| **The dispatcher**: wakes on `run`/`team`/`brief`/`approvals` events plus a 1-second timer, runs at most 4 at once, and never waits on a model call.                                                                                                                                                                        | `server/gateways/dispatch.ts`                                                                           | The same loop drives board work: start, follow, settle.                                                                                                                                                                                                                                          |
| **File hand-in checks**: only the run's own workspace and the project's uploads are allowed. Credentials, `.git`, `.dashboard`, data folders, other projects, links and hard links are refused. The file is read once and its size and hash saved, and the check also confirms the run that made it.                        | `server/gateways/deliverables.ts`, `server/gateways/outgoing.ts` (`checkedPath`, `readGatewayDocument`) | Checking the files a worker attaches to its comment.                                                                                                                                                                                                                                             |
| **One safe file writer**: `receiveSource()` writes from any stream with a size limit, into a fresh batch.                                                                                                                                                                                                                   | `server/uploads.ts`                                                                                     | Copying files into a task's project (files you attach in "All projects", and files a worker hands in).                                                                                                                                                                                           |
| **Brain as a target**: `ask(text, { conversationId, operationId, from, attachments })` keeps a private Brain history per conversation.                                                                                                                                                                                      | `server/overseer.ts`                                                                                    | Tasks assigned to **The Brain** can be picked up too (open question 3).                                                                                                                                                                                                                          |

## What changes from the first draft

- **No board-specific brief.** The automatic brief and private-conversation reporting already do it. The board only
  reads outcomes, as the gateway dispatcher does.
- **No new "run ended" or "team idle" listener.** Both are single-slot hooks owned by `irc.ts`, and Gateways shows we
  don't need them: completion is read from runs, threads and briefs.
- **Teams come for free with private threads.** Their turns, queue, recovery, member chats and task lists already work
  with private team ids.
- **Files out reuse the gateway checks**, with one board tool. Its risk is `none`, because the files stay in this
  dashboard; sending a file out of a gateway is `high`.
- **Restarts and crashes:** the operation id is saved before work starts, and a run or message that can't be
  confirmed puts the task in **Needs review** instead of starting it again (the gateway inbox's rule).

## Since the last check

- **The board is on `main`, Gateways isn't.** PR #121 merged the board (up to `b7af798`). This plan's rewrite is only on
  `LZL0/task-board`; it ships with the build branch.
- **PR #112 now conflicts with `main`** in four files. `README.md`, `package.json` and `bun.lock` keep both sides: new
  sections and dependency updates. `server/overseer.ts` needs a decision, in `snapshot()`:
  - Gateways hides **SAVED TASKS** in a private conversation (`(not included in private conversation snapshots)`), like
    approvals, questions, activity and memory. `main` added a **TASK BOARD** line next to it.
  - Resolve it the same way: hide the board in private conversations. A Brain answering a Telegram, Slack or Discord
    message then doesn't see the user's whole board.
  - The board build later adds one exception: a `board-<taskId>` conversation sees that one task (see [The Brain](#the-brain)).
- **The Brain's actions aren't scoped by conversation.** `applyActions(actions, p, { seenSkills, userWords })` isn't told
  the conversation, so a Brain in a gateway chat can still use `board_add`, `board_update`, `board_comment` and
  `board_remove` if it knows a task's number. The board build passes `conversationId` into `applyActions`:
  - in a `board-<taskId>` conversation, the board actions only touch that task;
  - in any other private conversation, they're refused with "The Tasks board isn't available in this conversation."
  - (Open question 6.)
- **Discord is on**, next to Telegram and Slack. WhatsApp is built but stays off. The board needs nothing from either.
- **The review pattern to copy.** Discord's and WhatsApp's recovery screens send back the revision the user saw and
  refuse it if anything changed since. **Check saved work** does the same: the request carries the work's
  `operationId` and `briefRevision`, and the server refuses it if either changed ("This work changed meanwhile").

## Decisions

1. **What starts it:**
   - your own move to In progress (drag, keys, card menu, the task page's Status);
   - giving a task that is already In progress to an agent or team;
   - **Start** on the task page, or **Start again** after it was stopped, blocked or reviewed.
     The Brain's and the workers' own moves never start it.
2. **To do does not start it**: new tasks land in To do, so starting there would start every task you add and assign.
   (Open question 1.)
3. **One piece of work per task at a time.** While it runs, the card shows who is working, and the task page shows a
   Stop button. A second Start, or moving the card again, does nothing until the work ends.
4. **The worker moves the card itself, and the completion check is the backstop.** The worker uses `board_status`
   (In review, or Blocked with a reason), so you see it happen. When its turn ends, the brief's verdict settles it:
   - **Delivered:** the card goes to In review, if it isn't there already, and the summary becomes a comment.
   - **Blocked or stuck:** the card goes to Blocked with the reason, and the question appears in Needs you.
   - **Unfinished,** although the worker said In review: the card goes back to In progress, and the follow-up is sent.
5. **Nobody but you moves a task to Done.** The tool refuses it.
6. **Your comments reach the worker while it works**, with their files, as your message in its chat or thread. They're
   queued, not used to stop the work. A description you change while it works is passed on the same way, as
   "The description changed: …".
7. **Moving the task away stops the work, after asking.** That means moving it to To do, Blocked or Done, giving it to
   someone else, or removing it. It asks "Writer is working on #4. Stop it?" first. After a reassignment, the new
   assignee starts if the task is still In progress.
8. **Always on, with a way back:** "Writer started on #4" appears with a **Stop** button. (Open question 2.)

## How it works

### Data (`shared/types.ts`)

```ts
/** A file on a task or a comment, in the task's project's uploads folder (path relative to it). */
interface TaskFile { path: string; name: string; size: number; sha256?: string; by: string; at: number }

/** The work on a task: one at a time; the last one stays for its history and for restarts. */
interface TaskWork {
  operationId: string;        // saved before anything starts: the run id, team message id or Brain operation id
  conversationId: string;     // board-<taskId>
  local: LocalConversation;   // (Gateways' GatewayLocalConversation, renamed and shared) who, and which chat/thread
  startedAt: number;
  runId?: string; messageId?: string; briefId?: string; briefRevision?: number;
  state: 'starting' | 'working' | 'waiting' | 'review' | 'blocked' | 'stopped' | 'needs-review';
  endedAt?: number;
  answer?: string;            // the delivered answer, once settled
}

ProjectTask += { files?: TaskFile[]; work?: TaskWork }
TaskComment += { files?: TaskFile[] }
```

`BoardTask` (what the page gets) adds `work` with the worker's name and mark, and `waiting` from `approvalPending`.
`restoredBoard()` checks the new fields like the others. Paths are relative to the project's uploads folder so that a
cloned or restored project points at its own copy.

### Shared code taken out of Gateways (a small change to #112's files)

- **`server/assignments.ts`** gets `submit`, `completion`, `reconcile` and `approvalPending` from
  `server/gateways/execution.ts`. They're written against `{ operationId, local, runId?, messageId?, briefId?,
briefRevision?, startedAt }` instead of a gateway inbox event. `gatewayExecution` becomes a thin adapter over them,
  and its tests stay as they are. `GatewayLocalConversation` becomes `LocalConversation`.
- **`server/deliverables.ts`** gets the file checks from `server/gateways/outgoing.ts` (`checkedPath` and the bounded
  read). It checks a path against a run, a project and a conversation, and confirms the run that made the file.
  Gateways keeps its own limits and its high-risk send. The board uses the same checks with its own limits.

### Starting (`server/boardwork.ts`, new)

- **Hook:** the board's `PUT` route calls `requestWork()` when decision 1 applies. So do `POST .../start` and the
  reassignment. The Brain's `board_update` uses `changeBoardTask` directly, so it never starts work.
- **Save first:** inside `withProject(task's project)`, the board writes `work = { operationId: uid(), conversationId,
state: 'starting', startedAt }` and only then starts the work.
- **Agent:** `privateAgentChat('board-<taskId>', agentId)`, then `startRun(agent, chat, text, { reservedRunId:
operationId, from: 'Tasks board (you)', userInitiated: true, attachments })`.
- **Team:** `postUserMessage(privateTeamId('board-<taskId>', teamId), text, { messageId: operationId, sender:
'Tasks board (you)', route: pickMember, attachments })`. The team's lead or `pickMember` takes it, members hand work
  on by @mention, and the lead posts the result, all as in any team chat.
- **Brain** (if open question 3 is yes): `ask(text, { conversationId, operationId, from: 'Tasks board (you)', attachments })`.
- **What the worker is told** is one message:
  - the task's number, title, priority and project, and its description;
  - the last 20 comments, with who wrote them and their file names;
  - the rules: "Work on this task. Comment on it with `board_comment` and attach what you made. When it is done, move it
    to In review with `board_status`; if you can't finish it, move it to Blocked and say why. Never move it to Done."
  - For Hermes and OpenClaw, which have no dashboard tools, it says to put the result and the reason in the final reply.
- **Attachments** are the task's files plus every comment's files, made absolute in the task's project.
- **Recording what started:** `work.runId` / `messageId` / `briefId` are recorded, `state: 'working'`, and the board is
  told. If saving or starting fails, the task shows **Needs review** rather than retrying.

### Following and settling

A `BoardWork` loop, modelled on `GatewayDispatcher`, wakes on `run`, `team`, `brief`, `approvals` and `board` events
and every second. For each task whose work is `working` or `waiting`, it calls `assignments.completion()`:

- **pending:** `waiting` while `approvalPending()` is true, `working` otherwise.
- **completed, brief delivered:**
  - `answer` is saved;
  - a comment from the worker with the answer, unless it already commented after its last turn;
  - card to In review; `state: 'review'`.
- **brief blocked or stuck:**
  - card to Blocked, with the brief's `summary` as the reason (300 characters) and `userAction` as a comment;
  - `state: 'blocked'`.
  - Needs you already holds the question: the private conversation's brief raises it. Answering there, or commenting
    on the task, reopens the same brief (`resumeBrief`), and the card goes back to In progress.
- **needs-review** (a changed brief, missing evidence, an engine error): `state: 'needs-review'`, a comment saying
  what to check, and a **Check saved work** action that calls `assignments.reconcile()`. As in the gateway inbox, it
  never starts the work again; you choose Start again. The request carries the `operationId` and `briefRevision` the
  page showed, and is refused if either changed, as the gateway recovery screens do.
- **Unfinished after the worker said In review:** the brief stays open and the Brain follows up. The loop puts the card
  back to In progress with a comment.
- **On startup:** after `recoverWork()`, the loop goes through every project's board and reconciles `starting` and
  `working` tasks by their saved ids. `starting` work with no run or message is marked `needs-review`.

### The worker's tools (`server/boardtools.ts`, new)

These are in a `board` tool group, added per run through `workAccess: { toolGroups: ['board'] }`, so they never appear in
ordinary chats. Each tool finds its task from the run: `runInfo(ctx.runId).conversationId`, which must be
`board-<taskId>`, in the run's own project. That works the same for an agent's chat and for every member of a private
team thread.

| Tool                                                         | What it does                                                                                                                                                                                                                                                                                                                                                                           | Risk |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| `board_task`                                                 | Reads its task: title, description, comments, file names.                                                                                                                                                                                                                                                                                                                              | none |
| `board_comment { text, files?: string[] }`                   | Comments as `agent:<id>`. Each file passes `deliverables.ts`: the run's own workspace or project uploads, no credentials or data folders, no links or hard links, regular files only, at most 20 files and 500 MB each, and the run that made it confirmed. Files are copied into the task's project with `receiveSource()` under `uploads/tasks/<taskId>/`, with their size and hash. | none |
| `board_status { status: 'in_review' \| 'blocked', reason? }` | Moves its own task. Blocked needs a reason. Done is refused.                                                                                                                                                                                                                                                                                                                           | none |

The risk is `none` because nothing leaves this dashboard. It's the same reasoning the task tools use, and the files
pass the strictest file checks we have.

**When no tool is used** (Hermes, OpenClaw, or an agent that forgot), the delivered answer becomes the comment. Absolute
paths in it that pass the same checks are attached.

### Your files (in)

- **Attaching:** the New task window, the description editor and the comment box get the app's attachment tray
  (paperclip, drag and drop, paste). It uploads to the open project, as everywhere.
- **Saving:** `POST` / `PUT` on tasks and comments take `files: string[]`. The server checks them with
  `cleanAttachments` in the open project. When the task is in another project ("All projects"), it copies them into
  that project with `receiveSource()`. Uploads and `/api/file` only allow the open project, which is why the copy is
  needed.
- **Viewing:** `GET /api/task-board/:projectId/:id/files/:path` serves a file listed on that task or its comments,
  inside `withProject(p)`, through `sendFileSafely`. A task's files show whichever project is open, without widening
  `/api/file`.
- **Showing:** chips and image previews (`attachmentChips` / `Previews`) under the description and on comments, and a
  paperclip with a count on the card.

### Stop and steer

- **Stop** (`POST /api/task-board/:projectId/:id/stop`):
  - agent: `stopChat(chatId, projectId)`;
  - team: stopping the private team's turns and work (`stopTeamWork` / steer-stop);
  - Brain: the Brain's stop for that conversation.
    The brief becomes `stopped`, `state: 'stopped'`, and the comment says "Stopped by you".
- **Your comment while it works** (decision 6):
  - agent: `queueMessage(agent, chat, text, files, { from: 'Tasks board (you)' })`;
  - team: `queueUserMessage(privateTeamId, text, { attachments, sender })`.
    The brief takes in the change, as steering already does.

### On the page

- **Card:** the worker's mark with a small pulsing dot while working, amber **Needs you** while waiting, a **Check**
  mark for needs-review, and a paperclip with a count.
- **Task page, right side, a "Work" box:**
  - who has it, and the state ("Working", "Needs you", "Ready for review", "Blocked", "Stopped", "Needs review");
  - **Open chat**: the agent's private chat, or the private team thread;
  - **Stop**, **Start / Start again**, or **Check saved work**.
- **Activity:** "Writer started working" and "Stopped by you" between the comments; files on comments.
- **Starting:** the "Writer started on #4" message with **Stop**.

Gateways has no screen that opens a private chat or thread yet. Agent private chats are ordinary chat files, so
`#/agents/<id>/<chatId>` should open them. For teams, check that `openChat('team', privateTeamId)` loads a private team
(`getTeam` already resolves it) and hides cross-team actions. Add what is missing.

### The Brain

`boardLines()` adds `| working: Writer` and `| files: 2`. The Brain's own `board_update` still doesn't start work; it
hands work out with `delegate`. The Brain also doesn't see private task conversations in its main snapshot (Gateways'
scoping), which is right: the task's comments are where it reads them.

In private conversations:

- **Snapshot:** the board is hidden, as SAVED TASKS is. In a `board-<taskId>` conversation, the TASK BOARD line holds
  only that task.
- **Actions:** `applyActions` gets `conversationId`. Board actions in a `board-<taskId>` conversation act only on that
  task. In any other private conversation they're refused.

### Backups and project copies

Uploads are in neither `.dashbackup` nor `<project>/.dashboard` today.

- **`.dashbackup`** includes the files referenced by board tasks, up to 500 MB in total, and says what it left out.
- **`.dashboard`** keeps the paths only.
- A file that is missing shows as "File missing".
- Private conversation records and their chats and threads follow Gateways' storage, under the runtime data rather than
  the project. A restored project's tasks keep their history in comments.

## Security

- Every new route checks the `Host` header, `x-dash: 1` and `Sec-Fetch-Site`. The file route serves only paths
  listed on that task, inside that project's uploads, through `sendFileSafely`.
- Worker files pass Gateways' checks: the run's own workspace or uploads only; no credentials, `.git`, `.dashboard`,
  data or other projects; no links or hard links; read once, with size and hash; the run that made them confirmed.
  They are copied, never moved.
- Tools act only on the task their own run's conversation names, and are refused for stopped or missing runs or another
  agent's. A private conversation can't read or relay into another.
- The Brain in a gateway chat (Telegram, Slack, Discord) neither sees nor changes the board. In a task's own
  conversation it sees and changes only that task.
- Work happens in the task's own project (`withProject`), whichever is open. A deleted project, agent or team puts the
  work in needs-review, as Gateways does with a changed route.

## Building it, in order

Everything ships together. This is the order to build and review it in:

1. **Branch from `main`** once PR #112 has landed. The board is already there. When #112 is merged with `main`, its
   `snapshot()` conflict is resolved by hiding the board in private conversations.
2. **Take out the shared code:** `assignments.ts` and `deliverables.ts` from the gateway modules, and
   `LocalConversation`. Gateway tests must pass unchanged. Pass `conversationId` into `applyActions` and scope the board
   actions and the TASK BOARD line by it.
3. **Files in:** the data shape, copies into the task's project, the file route, the tray, chips and previews, and backups.
4. **Agents:** `boardwork.ts` (save first, start, the loop, settle, restart, reconcile), Stop, comments while working,
   the Work box, the card marks, and Open chat.
5. **Tools and files out:** `boardtools.ts` with per-run `workAccess`, worker files, and the answer fallback.
6. **Teams:** private threads, team Stop and queued comments, member tools, and opening the private thread.
7. **The Brain**, if open question 3 is yes.
8. **Docs:** README, `docs/guide.md` (Tasks), and the Brain's board instructions.

## Tests

- **Server:**
  - Starting: In progress (or reassigning, or Start) starts one agent run in the task's private chat with its files,
    and one private team thread message with them. To do, the Brain's moves and reordering start nothing. A second Start
    while working does nothing.
  - Ids: the operation id is saved before work starts. A crash between save and start leads to needs-review, never a
    second run. A restart reconciles working tasks by run or message id.
  - Settling, from the brief: delivered goes to In review with the answer as a comment; blocked to Blocked with the
    reason and Needs you; unfinished-after-In-review back to In progress; a changed brief to needs-review.
  - Tools: only their own task; Done refused; Blocked needs a reason. Files outside the run's workspace, credentials,
    links and hard links are refused, and accepted files are copied with their hash. The answer fallback attaches only
    files that pass the checks.
  - Scoping: two tasks on one team keep separate threads, and neither's worker can search the other.
  - Brain scoping: a gateway conversation's snapshot has no board and its board actions are refused; a
    `board-<taskId>` conversation sees and changes only that task. Check saved work with an old revision is refused.
  - Steering: your comment while working reaches the agent's chat or the team's private thread. Stop ends the work and
    marks it stopped.
  - Files in: a task in another project gets copies; the file route refuses paths not on the task; backups include
    task files.
  - The Gateways tests still pass after the shared code is taken out.
- **Web:** the tray in its three places, chips and previews, the Work box's states and actions, the card marks, the
  started message's Stop, and the stop-first dialog.
- `bun run check`, and the desktop smoke (`desktop:smoke`), for the file route and backup change.

## Open questions

1. **To do:** you asked for To do and In progress. Starting on To do would start every new task you assign. Keep In
   progress only, or also start on To do (perhaps only when you assign it, not when it is created)?
2. **Always on, or a switch?** The default here is always on, with Stop in the message. A per-project switch is easy.
3. **Tasks assigned to The Brain:** Gateways already routes work to the Brain with a private history, so the Brain
   could pick up its own tasks the same way. Include it?
4. **Backups:** include task files up to 500 MB (the plan), always, or never?
5. **Cost:** each finished turn adds one Brain model call for the completion check, the same as other supervised work.
6. **The board from a gateway chat:** the plan hides the board from a Brain answering Telegram, Slack or Discord, and
   refuses its board actions there, as Gateways does with saved tasks. Should someone you allow on Telegram be able to
   add a task ("add a task to fix the login page")? If so, allow `board_add` only, into the conversation's project.
