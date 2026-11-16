# Bug hunt

Started: 2026-11-16. All twenty subagent reviews completed.

Investigation only: no application code changed. This is an accumulating concern log, not a claim of exhaustive coverage or patch-introduced regressions.

## Evidence and verification

- Source-confirmed means the relevant control/data flow was inspected, not that the behavior was reproduced.
- Candidates explicitly identify unresolved runtime or product-contract questions.
- No tests, builds, live app scenarios, provider calls, exploit payloads or large-memory reproductions were run.
- Reviewers inspected source, callers, guards, existing tests and installed dependency code where necessary. Language-server navigation was unavailable.
- Source references describe the reviewed tree; dependency line numbers are installation-specific.
- Recovery note: a disk-full append truncated this file. All findings were reconstructed from retained review results after the user authorized removal of the npm cache. That cleanup freed 50 GB. No project files or credentials were deleted.

## Review coverage

Completed reviews:

- StorageBugs: storage, project isolation, portable saves, backup/restore.
- TaskLifecycleBugs: board work, routines, workflows, cancellation and scheduling.
- ClientStateBugs: connections, chat/task actions, view lifecycle and project switching.
- FileBoundaryBugs: file tools, uploads, ZIP handling and routing boundaries.
- EngineExecutionBugs: subprocesses, sessions, cancellation, configuration and execution recovery.
- GatewayDeliveryBugs: intake, dispatch, outgoing delivery and recovery.
- ApprovalMcpBugs: consent identity, MCP access, cancellation and questions.
- EveRecoveryBugs: native admission, recovery, steering, projection and retention.
- SkillInstallBugs: install provenance, update/restore, version snapshots and limits.
- DesktopLifecycleBugs: startup/shutdown, tray, updater and packaging.
- BrainOrchestrationBugs: routing, handoffs, completion evidence and project ownership.
- SocialPostingBugs: OAuth, account refresh, Outbox publication, retry and lifecycle.
- KnowledgeDocumentBugs (completed): knowledge caching/access, document extraction and PDF worker lifecycle; fifteen concerns (BH-102–BH-116).
- TerminalCommandBugs (completed): terminal ownership, shell execution, timeouts and cleanup; ten concerns (BH-086–BH-095).
- VoxelWorldBugs (completed): world access, mutations, prefabs, transforms and import/export; thirteen concerns (BH-134–BH-146).
- ProviderSettingsBugs (completed): provider/model selection, cache identity, settings and keys; six concerns (BH-096–BH-101).
- ProgramLaunchBugs (completed): program discovery, launch identity, services and DCC execution; twelve new concerns (BH-155–BH-166) and independent confirmation of BH-120.
- ArtifactPreviewBugs (completed): artifact targets, file previews, attachment lifecycle and project binding; eight concerns (BH-147–BH-154).
- ComfyWorkflowBugs (completed): workflow conversion, image inputs, masks, job lifecycle and results; eleven concerns (BH-117–BH-127).
- TeamDispatchBugs (completed): team routing, queued delivery, turn ownership and thread switching; six concerns (BH-128–BH-133).
- Parent review: shared text/mention helpers, archive search, memory persistence and selected finding traces.

## Findings

### BH-001 — Bare links outside the short TLD list get the wrong post length

- Severity: medium. Status: source-confirmed contract mismatch; current X recognition of the example domain untested.
- Sources: `shared/xtext.ts:25-30,54-65`; `server/social.ts:499-504,627-632,699-704`; `web/views/outbox.tsx:23-25,360-361`.
- Trigger/evidence: use a bare valid domain such as `example.museum` near the post limit. Its ending is absent from `TLDS`, so it counts as letters rather than 23 characters; explicitly prefixed URLs take a different branch.
- Impact/expected: counter and draft/publish checks can admit over-limit text or reject text that fits. Detected URLs should receive X's fixed weight.
- Limits: regex and enforcement paths inspected; no X request. Existing URL tests cover listed endings only (`tests/server/xtext.test.ts:39-45`). Reference: [X counting rules](https://docs.x.com/fundamentals/counting-characters).
- Fixed: bare links are recognised with many more endings (older and newer generic ones such as .museum, .shop, .app). Still a list, not every ending X knows; country endings stay the listed ones. Test in `tests/server/xtext.test.ts`.

### BH-002 — Non-emoji joiners make ordinary script text count as emoji

- Severity: medium. Status: source-confirmed classification defect; service rejection untested.
- Sources: `shared/xtext.ts:21-23,44-49`; `server/social.ts:499-504,627-632,699-704`.
- Trigger/evidence: ordinary script graphemes containing U+200D, such as an Indic conjunct `क्‍ष`, match `EMOJI` solely because of the joiner. The entire segment costs 2 instead of its ordinary code-point weights.
- Impact/expected: repeated text can pass the shared limit while exceeding X's weighting. Emoji treatment should require an emoji sequence, not a bare joiner.
- Limits: segmentation may differ between runtimes. Existing tests cover emoji joiners, not ordinary-script joiners (`tests/server/xtext.test.ts:22-32`); no runtime reproduction.
- Fixed: a joiner makes a grapheme an emoji only right after an emoji; ordinary script text with one weighs by its letters. Test in `tests/server/xtext.test.ts`.

### BH-003 — Failed upload cleanup can delete an outside file

- Reporter: FileBoundaryBugs. Severity: high. Status: source-confirmed race-dependent unsafe cleanup.
- Sources: `server/uploads.ts:148-170`.
- Trigger/evidence: while streaming `sub/victim.txt`, replace ancestor `sub` with a symlink/junction to an outside directory containing another `victim.txt`. Post-stream checks reject it, but catch cleanup still removes `tmp` and `target` through those unsafe pathnames.
- Impact/expected: rejection can delete a server-writable outside file. Cleanup must stay within the reservation.
- Limits: requires concurrent filesystem control, link rights and destination permissions; not unauthenticated cross-site HTTP access. OS timing untested.
- Fixed: cleanup removes the temporary file and the reservation only while their folder is still inside uploads/ and the name still points at the file this upload created (same device and inode). Test in `tests/server/uploads.test.ts` (skipped on Windows, which cannot move a folder with an open file).

### BH-004 — Batch creation follows a dangling uploads `.gitignore` link

- Reporter: FileBoundaryBugs. Severity: medium. Status: source-confirmed outside write path.
- Sources: `server/uploads.ts:50-70`; `server/util.ts:110-116`.
- Trigger/evidence: a Git-backed Brain folder has `uploads/.gitignore` linked to a nonexistent outside file. `exists()` follows the link and returns false; `writeFileSync()` then creates its target without checking that child.
- Impact/expected: fixed ignore-all contents can be created outside uploads, including in another repository's missing `.gitignore`. Child writes should respect containment.
- Limits: crafted local project, working file symlinks and write permission required. Straightforward trigger does not overwrite an existing target; not reproduced.
- Fixed: the uploads `.gitignore` is created with `wx`, so nothing is written where any entry is, a dangling link included. Tests in `tests/server/uploads.test.ts` (the link case skipped on Windows).

### BH-005 — Refused uploads can create outside directories

- Reporter: FileBoundaryBugs. Severity: low. Status: source-confirmed ordering defect.
- Sources: `server/uploads.ts:139-147`.
- Trigger/evidence: plant `escape` as a link/junction in an existing batch, then upload `escape/new/sub/file.txt`. Recursive directory creation runs before containment validation.
- Impact/expected: a refused request creates outside directory trees; refusal should precede filesystem effects.
- Limits: known batch, planted link, accepted upload and target permissions required. Random batch names constrain advance planting; later validation prevents ordinary file-content writes. Not reproduced.

### BH-006 — Stored ZIP entries evade the unpacked-size limit

- Reporter: FileBoundaryBugs. Severity: medium. Status: source-confirmed metadata/allocation mismatch.
- Sources: `server/unzip.ts:39-64`; callers `server/assets.ts:251-253`, `server/tools.ts:1283-1311`.
- Trigger/evidence: stored entries declare zero uncompressed bytes while referencing a large body, possibly reusing that body. The 4 GB counter trusts declarations while `Buffer.from(raw)` copies actual bodies into retained buffers.
- Impact/expected: memory exhaustion can exceed the limit without equally large unique input. Actual output length should be validated and bounded.
- Limits: malicious/corrupt content must reach ambientCG's host-restricted asset flow. Ordinary uploaded ZIPs do not use this extractor; no archive executed or current asset alleged malicious.
- Fixed: `readZip()` refuses a stored entry whose body is not the size it claims, so the 4 GB count is of real bytes. Test in `tests/server/assets.test.ts`.

### BH-007 — File-search regexes can block beyond the search timeout

- Reporter: FileBoundaryBugs. Severity: medium. Status: source-confirmed guard bypass and blocking path.
- Sources: `server/filetools.ts:154-198`; caller `server/tools.ts:2192-2211`.
- Trigger/evidence: search a long `a` run with a nonmatching suffix using `(a|aa)+$`. The nested-quantifier heuristic misses overlapping alternation; synchronous matching cannot be interrupted by the between-file time check.
- Impact/expected: the shared event loop can freeze despite the eight-second budget. Search should bound individual matching work.
- Limits: needs Files tools and suitable allowed content; `search_files` has risk `none`. Existing coverage catches `(a+)+$`, not this variant. No costly payload executed.
- Fixed: a repeated group that repeats, chooses or is optional inside, and back-references, are searched as plain text, and each line is tested up to 4,000 characters. A heuristic, not a guarantee: a regex still cannot be interrupted once it runs. Test in `tests/server/file-tools-parts.test.ts`.

### BH-008 — Different projects can overwrite the same portable save

- Reporter: StorageBugs. Severity: high. Status: source-confirmed destination collision.
- Sources: `server/projects.ts:80-83,105-118`; `server/projectsync.ts:198-204,228-254,715-717`.
- Trigger/evidence: open an already-registered folder again or create projects with the same default folder name. Ordinary creation lacks an ownership guard; both save/prune the same `.dashboard` destination.
- Impact/expected: last save replaces the other recovery copy of agents, chats, knowledge or world state. Independent projects should not own one snapshot destination.
- Limits: source trace only. Backup restoration already rejects ownership collisions (`server/backup.ts:904-912`).
- Fixed: `createProject()` refuses a folder another project already has (`sameFolder()`, now in `util.ts`), numbers default folders of same-named projects (`-2`), `updateProject()` refuses moving onto another project's folder, and `saveProject()` lets only the first of two older duplicates save. Tests in `tests/server/projectsync.test.ts`.

### BH-009 — Copied folders retain the original engine conversation

- Reporter: StorageBugs. Severity: high. Status: source-confirmed session forwarding.
- Sources: `server/projectsync.ts:351,599-611`; `server/engines/index.ts:915-919,944-949`; `server/engines/codex.ts:299-302`.
- Trigger/evidence: copy a saved Brain folder with a matching Codex `sessionEngine`/`sessionId`, then open it as another project. Restore retains the external ID and Codex resumes it.
- Impact/expected: separate local chats share external conversation state, potentially mixing project context. Copies should start independent sessions.
- Limits: no engine call. Reopening the original folder intentionally preserves sessions; backup cloning already clears them and reseeds (`server/backup.ts:995-1001`).
- Fixed: `restoreInto()` treats a folder as a copy when the folder it was saved from is still there, and its chats start new engine sessions (`sessionId: null`, `reseed`); a moved or reopened folder keeps them. Test in `tests/server/projectsync.test.ts`.

### BH-010 — Restored teams lose uploaded reference documents

- Reporter: StorageBugs. Severity: medium. Status: source-confirmed rejection and backup omission.
- Sources: `server/projectsync.ts:351-353`; `server/backup.ts:459-472,972-990`; `server/teams.ts:1152-1163`; `server/uploads.ts:207-220`.
- Trigger/evidence: attach team references, then restore a copied folder or backup/clone. Absolute team `files` still point to the old Brain folder and fail the new project's upload admission. Backups pack board-task upload bytes, not ordinary team/chat attachments.
- Impact/expected: teams silently lose references. Copies need relocated references; backups also need the corresponding bytes.
- Limits: source producer/consumer trace only; no restore executed.

### BH-011 — An empty world's first WORLD.md can abort restore

- Reporter: StorageBugs. Severity: medium. Status: source-confirmed filesystem ordering.
- Sources: `server/projectsync.ts:348,651-668`; `server/voxel/store.ts:22-25`; `server/voxel/worldmd.ts:109-120`.
- Trigger/evidence: restore a world with no objects/prefabs and its first WORLD.md into a profile without it. Empty trees create no destination; `copyFileSync()` precedes the `writeJSON()` that would create the directory.
- Impact/expected: ENOENT interrupts a partially imported project. Imported agents can make retry hit the nonempty-agent guard. Restore should create the destination first.
- Limits: first WORLD.md creates no version tree, so this is an ordinary state. Source-only.
- Fixed: restoring a world from files makes its folder before WORLD.md is copied in, so a world with nothing built yet comes back. Test in `tests/server/voxel-world.test.ts`.

### BH-012 — Removing the open project omits the switch event

- Reporter: StorageBugs. Severity: medium. Status: source-confirmed fallback/event mismatch.
- Sources: `server/projects.ts:171-175`; `server/store.ts:299-302`; `web/views/outbox.tsx:52-68,124-127`; `web/views/artifacts.tsx:41-46`; `web/views/station.ts:5476-5480`.
- Trigger/evidence: remove the active project with another remaining. Saving the list happens before `activeProject()` checks; lookup has already fallen back, so `setActiveProject()` is not called.
- Impact/expected: global state changes without `project`, leaving component-local lists/chats stale. Emit the actual transition.
- Limits: generic `projects` refresh does not replace consumers' switch event. No UI scenario run.
- Fixed: removing the open project reads which one was open before the list changes, so the switch is made and told (`project` event). Test in `tests/server/store.test.ts`.

### BH-013 — Metadata and world-link updates miss portable autosave

- Reporter: StorageBugs. Severity: medium. Status: source-confirmed unmatched event routing.
- Sources: `server/projects.ts:131-165`; `server/store.ts:267-269`; `server/projectsync.ts:682-713`; `server/voxel/link.ts:30-37`.
- Trigger/evidence: change metadata or a world link without another watched change, especially on an inactive project. Autosave ignores `projects`; link events lack the `world` field its world branch requires.
- Impact/expected: central JSON updates but portable copies remain stale; inactive changes can stay unsaved for the session. Relevant changes should schedule their own save.
- Limits: periodic fallback saves only the active project. No runtime scenario.
- Fixed: autosave also saves a project whose world link changed (the `world` event names it), and each project shortly after the project list changes (a rename, description, skills or look). No test of its own: no test starts the autosave watcher.

### BH-014 — Preserved timestamps can make autosave skip changed contents

- Reporter: StorageBugs. Severity: medium. Status: source-confirmed skip predicate.
- Sources: `server/projectsync.ts:174-179,249-263`.
- Trigger/evidence: replace an authoritative knowledge/chat/skill file with different equal-length contents and an equal/older mtime than its saved copy. `copyTree()` skips without comparing content.
- Impact/expected: successful autosave retains obsolete recovery data. Equal size/newer destination timestamp is not proof of equal contents.
- Limits: timestamp-preserving restores can trigger it; ordinary strictly increasing mtimes do not. Not reproduced.
- Fixed: autosave gives each copy its file's time and skips a file only when the size and time are the same, not when the copy is merely newer. Copies saved before this are written once more. Test in `tests/server/projectsync.test.ts`.

### BH-015 — Aggregate backups can exceed their decoder's limit

- Reporter: StorageBugs. Severity: medium. Status: candidate; incompatible bounds confirmed.
- Sources: `server/backup.ts:71-87,458,479-481,626`.
- Trigger/evidence: separately allowed categories such as 290 MiB of world data plus 100 MiB of marks exceed the 512 MiB decoded limit after base64. Remaining-room accounting constrains only later task files.
- Impact/expected: serialization can fail or packing can create a backup its decoder rejects; cloning shares the path. Aggregate output must fit the accepted format.
- Limits: exact runtime string/memory failure point untested; no large allocation attempted.
- Fixed: a backup (or copy) whose parts together unpack to more than its reader accepts is refused when made, saying so, instead of written unreadable. The kinds are not yet shrunk to fit. No test of its own (it needs over 512 MB).

### BH-016 — Backups/clones omit the uploaded Brain model

- Reporter: StorageBugs. Severity: medium. Status: candidate; omission confirmed, intended exclusion unclear.
- Sources: `server/projects.ts:510-566`; `server/backup.ts:133-179,350-351,435-436`.
- Trigger/evidence: upload `brain-model.<ext>`, then clone or restore. The file is in `.dashboard`, but backup shape/packing/restoration cover logo/background, not that model.
- Impact/expected: copied/restored projects lose their custom model if appearance assets are meant to be preserved.
- Limits: no explicit exclusion found and no restore executed; confirm backup contract.
- Fixed: backups (and so clones) carry the Brain's uploaded 3D model (`brainModel`), checked as a model again when restored. Test in `tests/server/backup.test.ts`.

### BH-017 — Manual Start leaves tasks To do or Blocked

- Reporter: TaskLifecycleBugs. Severity: medium. Status: source-confirmed lifecycle mismatch.
- Sources: `server/boardwork.ts:114-125,437-438`; `server/api/taskboard.ts:40`; `web/views/tasks.tsx:889-901,967-972`.
- Trigger/evidence: start an assigned To do/Blocked task from its page. Work starts without changing status/blocked reason; automatic settlement advances only In progress cards.
- Impact/expected: board and execution disagree, including after success. Explicit Start should transition into execution state.
- Limits: static caller-to-settlement trace; no task launched.
- Fixed: Start on a task in To do or Blocked moves it to In progress (and clears its blocked reason) as the work is claimed. Test in `tests/server/boardwork.test.ts`.

### BH-018 — Superseded workers can overwrite task state after file copying

- Reporter: TaskLifecycleBugs. Severity: medium. Status: source-confirmed asynchronous guard gap.
- Sources: `server/boardwork.ts:535-556,592-605`; `server/boardfiles.ts:54-70`.
- Trigger/evidence: while `board_reply` awaits file copying, stop/reassign the task or move it to Done. Ownership is checked only before the await, then comments/tags/status are unconditionally changed.
- Impact/expected: an old worker can undo newer decisions, including Done. Revalidate cancellation and operation ownership before committing.
- Limits: real filesystem await traced; timing untested.
- Fixed: `board_reply` checks again, after copying its files, that the run still works on the task with the same work, and saves nothing otherwise (the copied files stay in uploads). Test in `tests/server/boardwork.test.ts`.

### BH-019 — Agent-only workflows discard saved step prompts

- Reporter: TaskLifecycleBugs. Severity: medium. Status: source-confirmed dispatch mismatch.
- Sources: `server/api/workflows.ts:55-58`; `shared/teams.ts:5-6`; `server/workflows.ts:142,340-350`; `web/views/workflows.tsx:180-236,404-424`.
- Trigger/evidence: run an authored all-agent workflow, including Prompt to image. `isStepList()` is false, so dispatch sends only input/“Go ahead.” to team chat instead of rendering saved steps.
- Impact/expected: custom prompts, ordering and output substitutions are silently lost. Authored step semantics should survive dispatch.
- Limits: editor reachability and producer/consumer paths inspected; no model call.
- Fixed: `isStepList()` also counts an agent step with its own prompt, so an all-agent workflow you wrote (Prompt to image) runs its steps instead of going to the team chat; a team's bare steps stay a team. Test in `tests/server/groupB-teams.test.ts`.

### BH-020 — Workflow events can alter another project's indicator

- Reporter: TaskLifecycleBugs. Severity: medium. Status: source-confirmed ownership omission.
- Sources: `server/workflows.ts:126-128`; `server/store.ts:35-40`; `server/index.ts:688-691`; `web/core.ts:93-106`; `web/views/station.ts:5513-5531`.
- Trigger/evidence: A runs a workflow, user opens cloned B with the same workflow ID. Events have no project identity and Station matches by workflow ID alone.
- Impact/expected: A can light or clear B's workflow state. Origin ownership must accompany/filter progress.
- Limits: full event path traced; no browser scenario.
- Fixed: `workflow-run` events carry the project they come from, and the map ignores another project's. Test in `tests/server/store.test.ts` (the map's check itself has no test).

### BH-021 — Schedules ignore projects that are not open

- Reporter: TaskLifecycleBugs. Severity: medium. Status: candidate; behavior confirmed, intended policy unclear.
- Sources: `server/workflows.ts:291-307`; `server/routines.ts:287-295`; `server/store.ts:325-326,364-390`.
- Trigger/evidence: enable A's schedule and leave B open past its time. Schedulers enumerate active-project collections only; daily work can pass the one-hour catch-up window.
- Impact/expected: background schedules are skipped if they are intended to be project-independent.
- Limits: no documented open-project-only rule found; source trace, not runtime.
- Fixed: routine and workflow schedules are checked in every project (each run in its own project), not only the open one; the guide says so. Test in `tests/server/routines.test.ts`.

### BH-022 — Entirely unsuccessful routines can be Done

- Reporter: TaskLifecycleBugs. Severity: medium. Status: candidate; aggregation confirmed, mixed-state policy unclear.
- Sources: `server/routines.ts:218-237`.
- Trigger/evidence: one target stops and another fails. Neither all-stopped nor all-failed matches, so aggregate status is `done`.
- Impact/expected: a run with no successful targets looks completed successfully; define appropriate mixed terminal-state precedence.
- Limits: no routine executed.
- Fixed: a routine run is done only when a target finished (`routineStatus()`); none finished and one failed is failed, else stopped. Test in `tests/server/routines.test.ts`.

### BH-023 — Deleted workflows can continue outstanding actions

- Reporter: TaskLifecycleBugs. Severity: medium. Status: candidate; continuation confirmed, deletion semantics unclear.
- Sources: `server/api/workflows.ts:38-42`; `server/workflows.ts:55,81-101`.
- Trigger/evidence: delete a workflow waiting at approval, then approve. Definition removal cancels neither active controls nor checkpoints; execution retains its object.
- Impact/expected: deleted work can perform subsequent actions if deletion is expected to cancel it.
- Limits: explicit stop handling exists but deletion does not invoke it; no action executed.
- Fixed: deleting a workflow stops its runs going in that project first (`stopRunsOf()`), which also cancels a checkpoint waiting for approval. Test in `tests/server/workflow-stop.test.ts`.

### BH-024 — Full chat shows the old project while sending to the new one

- Reporter: ClientStateBugs. Severity: high. Status: source-confirmed view/transport binding mismatch.
- Sources: `web/chat/ChatView.tsx:94-98`; `web/views/chat.tsx:389-390`; `web/core.ts:73-74`; `web/app.ts:337-363`; `server/backup.ts:991-1001`.
- Trigger/evidence: open A's chat, switch to cloned B and send without navigation. Transcript/agent stay loaded from A, but unscoped transport uses B's refreshed project header and preserved IDs.
- Impact/expected: instructions run in B while A's conversation is visible. Rebind/remount or explicitly pin the page.
- Limits: stale guard accepts B's current header; no browser or agent run.
- Fixed: the full chat page follows the open project: when another one opens it drops what it shows at once and loads the agent and chat again from the new project (`ChatScreen` is keyed by the project). Test in `tests/web/chat-page.test.tsx`.

### BH-025 — Floating chats can select private task/gateway conversations

- Reporter: ClientStateBugs. Severity: medium. Status: source-confirmed inconsistent selection filter.
- Sources: `web/agentchat.tsx:62,99`; `server/store.ts:486-500`; `server/private-conversations.ts:59-82`.
- Trigger/evidence: a private conversation is the newest agent chat. Initial selection excludes team sessions but not `conversationId`, unlike its own history list.
- Impact/expected: an ordinary tab shows/sends into another workflow's private conversation. Apply consistent private-chat exclusion.
- Limits: static list/selection trace only.
- Fixed: a floating agent chat opens the latest chat that is neither a team session nor a private conversation, the same rule as its list. Test in `tests/web/agentchat.test.ts`.

### BH-026 — Reconnection does not catch up open chat history

- Reporter: ClientStateBugs. Severity: medium. Status: source-confirmed missing refresh/follow path.
- Sources: `web/chat/ChatView.tsx:240-249`; `web/core.ts:111-116`; `server/api/status.ts:32-60`.
- Trigger/evidence: miss run events during socket outage, then reconnect. Global state refresh contains no transcript; ChatView neither handles reconnect nor reruns initial history/follow when runs change.
- Impact/expected: replies, queue/loop updates or live streams remain missing until another event/reopen. Reconnection should catch up.
- Limits: no outage simulated.
- Fixed: an open chat loads its saved chat again, and follows a run going in it, when live events come back after they dropped (`onReconnect`). No test of its own.

### BH-027 — Empty-queue loops can lose overlapping run starts

- Reporter: ClientStateBugs. Severity: medium. Status: source-confirmed ordering-dependent catch-up gap.
- Sources: `web/chat/ChatView.tsx:272-278`; `server/engines/index.ts:1110-1127,1618-1622,1751-1794`.
- Trigger/evidence: `/loop 2x review the work` starts its next turn before the preceding client stream ends, with no queued messages. Overlapping starts are retained only for nonempty queues.
- Impact/expected: later loop turns stop streaming live; reload gives only a snapshot. Relevant starts should survive independent of queue contents.
- Limits: source ordering traced; delivery timing untested.
- Fixed: a run that starts while the view still streams the last turn is followed afterwards when a /loop is going too, not only when messages are queued. No test of its own.

### BH-028 — Obsolete chat loads update the parent after unmount

- Reporter: ClientStateBugs. Severity: medium. Status: source-confirmed stale callback path.
- Sources: `web/chat/ChatView.tsx:196-203`; `web/agentchat.tsx:107-110,150-158`.
- Trigger/evidence: delay C1's load, switch/load C2, then finish C1. Unmounted C1's unchanged ID still passes its check and calls the surviving parent's `onChat`.
- Impact/expected: Full page/history selection can target C1 while C2 is visible. Ignore obsolete view/request responses.
- Limits: no delay injected.
- Fixed: a chat view keeps only the answer to its latest load while it is still open, so an older one coming back late never tells the page about the wrong chat. No test of its own.

### BH-029 — Chat reconnect ignores cancellation

- Reporter: ClientStateBugs. Severity: medium. Status: source-confirmed missing signal propagation.
- Sources: `web/chat/transport.ts:36-38`; `web/chat/ChatView.tsx:303-308`; installed `ai/dist/index.js:21847-21858,22030-22037`.
- Trigger/evidence: delay reconnect before headers, then steer/close. `reconnectToStream` ignores the SDK's abort signal while steering waits for `followDone`.
- Impact/expected: steering blocks until request settlement/timeout and closed views leave requests outstanding. Forward cancellation.
- Limits: installed SDK inspected; network timing untested.
- Fixed: a chat's reconnect passes the AI SDK's abort signal on to its request. Test in `tests/web/chat-transport.test.ts`.

### BH-030 — Non-ASCII suffixes turn longer words into team mentions

- Reporter: parent. Severity: medium. Status: source-confirmed parser/routing mismatch.
- Sources: `shared/teams.ts:34-48`; `server/teams.ts:527-528,700-715,1283-1286`; `tests/server/crossteam.test.ts:64-80`.
- Trigger/evidence: with team `Café`, write `#Caféé`. ASCII `\w` treats the suffix as a boundary; non-ASCII preceding letters likewise permit in-word matches.
- Impact/expected: ordinary longer words unexpectedly relay work/messages. Exact-name boundaries should include Unicode letters/marks/numbers, as routines already do (`shared/routines.ts:5-10`).
- Limits: tests cover ASCII longer words; no relay executed.
- Fixed: #Team mentions count letters, marks and digits of any script as part of a word on both sides, as routine mentions do. Test in `tests/server/crossteam.test.ts`.

### BH-031 — Telegram sends documents after their source request changes

- Reporter: GatewayDeliveryBugs. Severity: medium. Status: source-confirmed asynchronous authorization gap.
- Sources: `server/gateways/telegram.ts:212-240`; `replies.ts:90,106-107`; `inbox.ts:1283-1299,2637-2647`; `outgoing.ts:110-124` (all under `server/gateways`).
- Trigger/evidence: edit/add an album part while claimed document verification awaits I/O. Source holds affect pending files only; the file is already sending and Telegram does not compare delivery versions afterward.
- Impact/expected: superseded output is delivered instead of held for review. Slack/Discord have version guards (`slack.ts:565,582,596`; `discord.ts:618,703`).
- Limits: existing test edits before claiming (`tests/server/gateway-outgoing.test.ts:239-253`); no platform/race execution.

### BH-032 — Startup download drain can starve unrelated gateway work

- Reporter: GatewayDeliveryBugs. Severity: medium. Status: source-confirmed dependency; sustained starvation timing-dependent.
- Sources: `server/gateways/worker.ts:203-225`; `server/gateways/files.ts:69-88,106-120`.
- Trigger/evidence: recovery has pending downloads and ongoing arrivals keep the drain busy. Worker awaits that evolving drain before starting dispatcher/replies.
- Impact/expected: unrelated text and saved native/Outbox replies wait indefinitely. Independent consumers should not await a continuously replenished backlog.
- Limits: startup/drain inspected; no backlog run.

### BH-033 — Codex starts after Stop during status lookup

- Reporter: EngineExecutionBugs. Severity: high. Status: source-confirmed cancellation window.
- Sources: `server/engines/codex.ts:298-309`; `server/engines/index.ts:921-963,1810-1820`.
- Trigger/evidence: Stop while `checkedStatus()` awaits. Adapter then spawns/submits and attaches its listener without rechecking; already-aborted signals do not notify newly attached listeners.
- Impact/expected: tools/model work run despite Stop. Recheck cancellation and handle aborted-at-registration.
- Limits: no Codex process started.
- Fixed: Codex checks Stop after its version lookup and starts nothing; Codex, Claude Code, Hermes and `pipeLines()` also stop a child at once when the signal was aborted before their listener was attached. Test in `tests/server/codex-stop.test.ts`.

### BH-034 — OpenCode initialization has a Stop-handling gap

- Reporter: EngineExecutionBugs. Severity: high. Status: source-confirmed cancellation gap.
- Sources: `server/engines/opencode.ts:342-344,660-781`.
- Trigger/evidence: Stop after server startup while events/model/session setup awaits. Startup listener is removed; turn listener appears only at line 779 before unconditional post.
- Impact/expected: stopped work can still call models/tools, and stalled initialization cannot be interrupted through that signal. Cancellation ownership must remain continuous.
- Limits: no server/model call.
- Fixed: Stop while opencode sets up ends the event wait at once, its setup calls take the run's signal, and Stop is checked before each setup step and right before the turn's own handling takes over. Test in `tests/server/opencode-engine.test.ts`.

### BH-035 — Pi/OMP crashes return partial text as success

- Reporter: EngineExecutionBugs. Severity: medium. Status: source-confirmed completion-classification gap.
- Sources: `server/engines/pi.ts:118-129,193-208,452-468`; `server/engines/index.ts:1029-1030`.
- Trigger/evidence: subprocess emits text then crashes without turn completion/error frame. Nonempty answers are accepted without requiring completed state or successful exit.
- Impact/expected: unfinished work is marked completed for users/delegates. Require a valid completed outcome.
- Limits: no subprocess crash induced.
- Fixed: a pi or oh-my-pi run that exits with a failure code before its run ended is an error, even after some text (the text stays in the chat). A clean exit without an end frame is still taken as done. Test in `tests/server/pi-engine.test.ts`.

### BH-036 — OpenCode quick queries hide errors after preliminary text

- Reporter: EngineExecutionBugs. Severity: medium. Status: source-confirmed failure suppression.
- Sources: `server/engines/opencode.ts:1012,1025-1035`; `server/brain.ts:389-390`; `server/irc.ts:628-643`.
- Trigger/evidence: quick query emits text then errors, exits unsuccessfully or times out. Failure is examined only when answer is empty.
- Impact/expected: Brain can publish preliminary commentary as success. Execution errors must not be hidden by partial output.
- Limits: no command/timeout executed.
- Fixed: an opencode quick query that reports an error, exits with a failure or runs out of time fails, even after some text. Test in `tests/server/brain-opencode.test.ts`.

### BH-037 — Codex corrupts backslashes in arbitrary MCP arguments

- Reporter: EngineExecutionBugs. Severity: medium. Status: source-confirmed transformation.
- Sources: `server/engines/codex.ts:172,237,298`; `server/mcp.ts:1119-1124`; `server/terminals.ts:104-110`.
- Trigger/evidence: stdio arguments contain scripts, escapes or regex backslashes. `tstr()` replaces all backslashes with `/`, including non-path arguments.
- Impact/expected: commands fail or change behavior in runs/terminals. Encode general strings without path normalization.
- Limits: transformation inspected; downstream effect depends on the command.
- Fixed: Codex settings encode strings with their backslashes (JSON escapes are TOML's); only paths (commands, the bridge script, the brief file) are written with forward slashes. Test in `tests/server/groupC-engines-status.test.ts`.

### BH-038 — Codex MCP secret variable names collide

- Reporter: EngineExecutionBugs. Severity: high. Status: source-confirmed credential routing collision.
- Sources: `server/engines/codex.ts:257-260,306`; `server/mcp.ts:1101-1104`.
- Trigger/evidence: HTTP servers `work-mail` and `work_mail` have different credentials at the same header index on environment-header-capable Codex. Both use `ATHENA_MCP_SECRET_WORK_MAIL_0`; later value wins.
- Impact/expected: authentication fails or a credential goes to another endpoint/account. Secret names must be unique.
- Limits: supported-version branch only; no credential transmitted.
- Fixed: header key variables now count up (`_2`, `_3`) until the name is free; test in `tests/server/groupC-engines-status.test.ts`.

### BH-039 — Claude acknowledges unrelated steers by substring

- Reporter: EngineExecutionBugs. Severity: medium. Status: source-confirmed ambiguous acknowledgement.
- Sources: `server/engines/claude.ts:342-344`; `server/engines/cli.ts:220-225`; `server/engines/index.ts:840-843,1358-1386`.
- Trigger/evidence: unread “write a summary” and “summary”; replay echoes only the first UUID. Text fallback marks both read and removes both pending deliveries.
- Impact/expected: an unconsumed instruction appears consumed and can be lost to recovery. Combined replay acknowledgement needs unambiguous identity.
- Limits: separate-message replay source trace; no process run.
- Fixed: a Claude echo marks another waiting message read only when that message is a whole line-bounded part of it, so "summary" is not read by "write a summary". Test in `tests/server/claude-steer.test.ts`.

### BH-040 — CLI recovery omits pending terminal memory reset

- Reporter: EngineExecutionBugs. Severity: medium. Status: source-confirmed recovery omission.
- Sources: `server/engines/index.ts:619,624-635,1494-1503`; `tests/server/eve-coordinator.test.ts:150-163`.
- Trigger/evidence: clear memory during a CLI turn, receive more output, crash before finalization. Saved `clearMemoryOnEnd` is not applied by non-native recovery before reseeding/settling.
- Impact/expected: post-reset material can reenter the new session's context. Apply the terminal reset as normal/native finalizers do.
- Limits: native tests express intended behavior; no restart scenario.
- Fixed: recovery of an interrupted (non-native) run applies a saved Clear memory, as the normal and native endings do. Test in `tests/server/execution.test.ts`.

### BH-041 — A crash erases a steer between queue and transcript writes

- Reporter: EngineExecutionBugs. Severity: medium. Status: source-confirmed cross-file durability window.
- Sources: `server/engines/index.ts:842-846,1494-1499`.
- Trigger/evidence: crash after acknowledgement durably unqueues but before saving its transcript receipt. Execution contains only initial input; recovery discards interrupted CLI sessions and reseeds from saved chat.
- Impact/expected: acknowledged instructions vanish from both pending work and history. Keep a recoverable receipt across that write boundary.
- Limits: no crash induced.
- Fixed: a message the engine read is saved in the chat before it leaves the queue, and recovery drops a queued copy the chat already shows as read, so a crash in between neither loses nor repeats it. Test in `tests/server/execution.test.ts` (the crash itself was not run).

### BH-042 — Team search ignores archived conversations

- Reporter: parent. Severity: medium. Status: candidate; omission confirmed, intended search breadth unclear.
- Sources: `server/conversations.ts:85-94,133-138`; `server/teams.ts:192-203,1784-1800,1821-1829`; `docs/guide.md:302`; `server/tools.ts:408-450`.
- Trigger/evidence: preserve a decision with New chat, then search/read an earlier result. Archives move to `past-chats`; search/read inspect only active `teamMessages()`. References identify team, not thread.
- Impact/expected: retained decisions disappear from search and old references fail until reopening, if advertised earlier-conversation search includes archived team history.
- Limits: no archive exclusion documented; source/test inspection only.

### BH-043 — Always-allow consent follows unstable MCP aliases

- Reporter: ApprovalMcpBugs. Severity: high. Status: source-confirmed consent-identity defect.
- Sources: `server/apitools.ts:15-23,40-47`; `server/tools.ts:2426-2428,2479-2482`; `server/eve/bridge.ts:152-159,312-319`.
- Trigger/evidence: permanently allow one colliding sanitized/truncated tool name, then remove/reorder tools. Listing-order suffixes change and another server/tool inherits the granted alias.
- Impact/expected: a different destructive tool can bypass consent. Persist grants against stable server/tool identity.
- Limits: Eve origin checks protect replay, not new calls inheriting old grants. Existing collision tests check simultaneous uniqueness only (`tests/server/mcp-copies.test.ts:263-273`); no bypass run.
- Fixed: API-model (Eve) agents now remember MCP grants as `mcp:<server>:<tool>` (`mcpGrant()`), not the model-facing alias; `gate()` takes a `grantName`. Older alias grants simply ask again. Test in `tests/server/mcp-grants.test.ts`.

### BH-044 — Renaming one MCP server transfers another's consent

- Reporter: ApprovalMcpBugs. Severity: high. Status: source-confirmed ambiguous rewrite.
- Sources: `server/mcp.ts:1101-1104,1369-1397,1452-1476`; `server/tools.ts:2426-2428`.
- Trigger/evidence: servers `a`, `a__b`, `c__b`; Eve grant `a__b__send`; rename `a` to `c`. Allowed delimiters make prefix replacement rewrite the unrelated grant to `c__b__send`, across every agent.
- Impact/expected: permissions transfer across endpoints/accounts; removal can revoke unrelated grants. Rewrite exact ownership, not ambiguous prefixes.
- Limits: deterministic source flow; Brain's separately stored server/tool grants are unaffected. Not executed.
- Fixed: `renamedGrant()` gives a grant to the longest server name it starts with, so renaming or removing `a` leaves `a__b`'s grants alone; new `mcp:<server>:<tool>` grants are exact. Test in `tests/server/mcp-grants.test.ts`.

### BH-045 — Brain tools Off during discovery still permits dispatch

- Reporter: ApprovalMcpBugs. Severity: medium. Status: source-confirmed revocation gap.
- Sources: `server/brainmcp.ts:130-135,168-174,233-244`; `server/api/settings.ts:16`.
- Trigger/evidence: set Off while `listTools()` awaits. The initial Off guard has passed; afterward only `ask` is special, so current `off` falls through. Settings do not cancel the turn.
- Impact/expected: mutations can dispatch after access is disabled. Recheck mode before dispatch.
- Limits: proceed checks conversation/project/Stop, not mode; disabled-server guards still work. Timing untested.
- Fixed: a Brain MCP call reads the tools setting again after the tools are listed and after an approval, and runs nothing once it is Off. Test in `tests/server/brain-mcp-tools.test.ts`.

### BH-046 — Stale run-bound bridges silently become unbound

- Reporter: ApprovalMcpBugs. Severity: medium. Status: source-confirmed fail-open context.
- Sources: `server/mcp-bridge.ts:40-41,97-104`; `server/index.ts:325-374`; `server/engines/index.ts:563-579,1082-1084`; `server/tools.ts:480-500,2547-2549`.
- Trigger/evidence: delayed/surviving bridge calls carry a finished/stopped `DASH_RUN`, possibly after a switch. Null lookup is treated as intentionally unbound, selecting open project with no cancellation.
- Impact/expected: post-run mutations, including risk-none `save_artifact`, can hit another project. Reject supplied-but-unavailable run ownership.
- Limits: internal token required; not unauthenticated HTTP access. Valid live runs are pinned; no timing scenario.
- Fixed: a bridge call or tool listing that names a run which has ended is refused (410) instead of running unbound in the open project. Test in `tests/server/api.test.ts`.

### BH-047 — MCP cancellation does not reach forwarded operations

- Reporter: ApprovalMcpBugs. Severity: medium. Status: source-confirmed missing propagation.
- Sources: `server/mcp-bridge.ts:45-79,97-104`; `server/index.ts:361-374`; installed SDK `@modelcontextprotocol/sdk/dist/esm/shared/protocol.js:173-180,338-343,395-400`.
- Trigger/evidence: external client cancels while approval waits, keeps connection open, then approval is granted. Bridge ignores SDK handler signal; HTTP work stays pending without a run signal.
- Impact/expected: cancelled requests can execute later effects despite suppressed responses. Propagate cancellation before consent/dispatch.
- Limits: cannot undo dispatched effects; Dashboard Stop still handles valid run-bound calls. No cancellation scenario.
- Fixed: the bridge passes the MCP client's cancel on to its request; the server aborts the call when that request goes away, `gate()` takes back a question still waiting in Needs you, and nothing runs after a stop, whatever the answer. Test in `tests/server/api.test.ts`.

### BH-048 — An old connection failure deletes its replacement's cache entry

- Reporter: ApprovalMcpBugs. Severity: medium. Status: source-confirmed asynchronous bookkeeping defect.
- Sources: `server/mcp.ts:1135-1137,1493-1495,1565-1569,1623-1642`.
- Trigger/evidence: A starts, settings disconnect it, B starts, then A rejects. Its unconditional `clients.delete(name)` removes B; close-event handling already checks promise identity.
- Impact/expected: untracked live connections/processes and extra replacements; later cleanup cannot reliably close B. Only remove the failing entry.
- Limits: no race/process-count measurement.
- Fixed: a connection that fails removes its cache entry only if the entry is still its own. Test in `tests/server/mcp-connect.test.ts`.

### BH-049 — Paginated MCP lists lose later-page tools

- Reporter: ApprovalMcpBugs. Severity: medium. Status: source-confirmed pagination omission.
- Sources: `server/mcp.ts:1671-1695`; `server/apitools.ts:40-47`; `server/brainmcp.ts:99-100,130-132`; installed SDK client `index.js:554-558`.
- Trigger/evidence: `tools/list` returns `nextCursor`. SDK performs one request; wrapper caches only tools and never follows it.
- Impact/expected: Eve lacks later tools and Brain says they do not exist; refresh repeats page one. Consume pagination.
- Limits: existing fixtures have no cursor; no live server contacted.
- Fixed: `listTools()` follows `nextCursor` page by page (up to 50 pages, stopping on a repeated cursor). Test in `tests/server/mcp-connect.test.ts`.

### BH-050 — Question removal loses resolved project ownership

- Reporter: ApprovalMcpBugs. Severity: low. Status: source-confirmed scope mismatch.
- Sources: `server/questions.ts:159-167,245-260`; `server/api/needs.ts:22`; `server/store.ts:402-417`.
- Trigger/evidence: A's question is removed through an accepted unscoped request with B open. Dismissal enters A, returns, then collection removal resolves in B.
- Impact/expected: success is reported but A retains the dismissed record. Keep ownership through deletion.
- Limits: stale A headers are rejected; this is current-project/no-header path. Answer/dismissal themselves preserve ownership; not reproduced.

### BH-051 — In-flight answers overwrite question closure/deletion

- Reporter: ApprovalMcpBugs. Severity: medium. Status: candidate; missing revalidation confirmed, Stop precedence unclear.
- Sources: `server/questions.ts:110-133,175-240,250-260`; `server/engines/index.ts:1806-1817`.
- Trigger/evidence: stop/remove during answer delivery's import/team await. Final save uses the original waiting record without rereading; `answering` does not guard closure or subsequent deletion.
- Impact/expected: removed records can reappear; answers may be lost or create work after Stop. Reconcile ownership/status before committing.
- Limits: resurrection follows writes; accepted-answer versus Stop policy and run-finalization timing need confirmation. No race run.
- Fixed: an answer checks again that its question is still waiting after each load before sending it on, and its final save uses the question as it is then; a removed one is not brought back. Test in `tests/server/questions.test.ts`.

### BH-052 — Agent comments masquerade as user-approved skill links

- Reporter: SkillInstallBugs. Severity: high. Status: source-confirmed provenance bypass conditional on Brain output.
- Sources: `server/boardwork.ts:74-84,133-135,190-195,592-600`; `server/overseer.ts:2888-2903,3217-3221`.
- Trigger/evidence: agent places a repository in `board_reply`; later task assignment to Brain embeds that comment in `userWords`. `prepareInstalls()` treats its repository as user-provided even with `brainAnyGitHub` off.
- Impact/expected: a generated install action can install agent-suggested instructions against the explicit user-link restriction. Preserve authorship boundaries.
- Limits: requires Brain to emit the action; no model response/install/request executed.
- Fixed: a board task's message to the Brain carries `ownWords` (the task when you made it, and your own comments); GitHub installs and MCP settings are checked against those, not against agents' comments. Test in `tests/server/boardwork.test.ts`.

### BH-053 — Skill restore fails when an old file became a directory

- Reporter: SkillInstallBugs. Severity: medium. Status: source-confirmed shape mismatch.
- Sources: `server/skills.ts:481-486,541-544`; `server/history.ts:334`.
- Trigger/evidence: old `references/example` file becomes `references/example/detail.md`; restore old version. Current files are removed but directories remain, so copying the old file onto the directory fails.
- Impact/expected: SKILL.md and extras are partially restored. Remove obsolete structure or stage a complete replacement.
- Limits: no filesystem reproduction.
- Fixed: restoring a version with files clears everything in the skill but SKILL.md, folders too, before copying the kept files back. Test in `tests/server/skillinstall.test.ts`.

### BH-054 — Failed GitHub update destroys the live installation

- Reporter: SkillInstallBugs. Severity: medium. Status: source-confirmed destructive ordering.
- Sources: `server/skillinstall.ts:274-285`; contrast `server/skills.ts:1024-1031`.
- Trigger/evidence: partial removal or subsequent rename fails, for example under Windows locking. Old installation is removed before new rename; failure skips the skill and cleans staged files without rollback.
- Impact/expected: failed update leaves a damaged/missing skill, not the original. Preserve live state until replacement succeeds.
- Limits: History may allow manual recovery; bundled updates already attempt rollback. No fault injected.
- Fixed: a GitHub update moves the installed skill aside instead of deleting it, and puts it back if the new copy cannot be moved into place. Test in `tests/server/skillinstall.test.ts`.

### BH-055 — Coalesced skill edits lose old extra-file snapshots

- Reporter: SkillInstallBugs. Severity: medium. Status: source-confirmed version/snapshot gap.
- Sources: `server/skills.ts:328-330,529,542-544`; `server/versions.ts:130-137`; `server/skillinstall.ts:267-275`.
- Trigger/evidence: text-edit then GitHub Update within three minutes. Text-only version can coalesce with direct API install, returning null; installer snapshots old extras only when a new version is returned.
- Impact/expected: changed extras disappear from History and old text restore keeps new files. Combined changes must retain complete rollback data.
- Limits: coalescing itself is intentional; no update run.
- Fixed: a skill update that changes its extra files is always a version of its own (`keepVersion(..., { apart })`), kept with the files it had, even right after an edit of its text. Test in `tests/server/skillinstall.test.ts`.

### BH-056 — Mutable refs mix install revisions and evade aggregate limits

- Reporter: SkillInstallBugs. Severity: medium. Status: source-confirmed ref race.
- Sources: `server/skillinstall.ts:126-145,160-169,224-235`.
- Trigger/evidence: branch advances between tree metadata and independent per-file downloads, which use the branch rather than immutable revision/blob IDs.
- Impact/expected: files can mix commits; listed-small files can grow below individual 2 MB limits but exceed the aggregate 10 MB cap. Use one immutable revision.
- Limits: no requests or branch changes exercised.
- Fixed: an install pins the commit its branch is at, reads the tree and downloads every file from that commit (the origin keeps the branch, for updates), and counts the bytes that really come down against the 10 MB limit. Test in `tests/server/skillinstall.test.ts`.

### BH-057 — Encoded skill paths produce broken Update origins

- Reporter: SkillInstallBugs. Severity: medium. Status: source-confirmed URL round-trip mismatch.
- Sources: `server/skillinstall.ts:56,239-245`; `web/views/skills.tsx:217,266`.
- Trigger/evidence: encoded branch/folder contains `#`, `?` or literal percent escape. Parser decodes, but origin interpolation does not re-encode; Update reparses it.
- Impact/expected: fragment/query truncation or double-decoding breaks updates or selects another folder. Preserve segment encoding.
- Limits: no repository accessed.
- Fixed: a skill's origin link encodes each part of its branch and folder, so reading it back for Update gives the same place. Test in `tests/server/skillinstall.test.ts`.

### BH-058 — Missing GitHub CLI credentials stay cached after sign-in

- Reporter: SkillInstallBugs. Severity: medium. Status: source-confirmed negative caching.
- Sources: `server/skillinstall.ts:75-85`; `web/skilldialogs.tsx:296-298`.
- Trigger/evidence: private install before authentication caches null; user follows `gh auth login` then immediately retries, without `GITHUB_TOKEN`.
- Impact/expected: retries remain unauthenticated for ten minutes/restart, also after installing missing CLI. Refresh negative credential discovery on retry.
- Limits: no CLI/authentication run.
- Fixed: a missing GitHub CLI sign-in is remembered for 15 s, not ten minutes, so signing in with `gh auth login` counts on the next try. No test of its own.

### BH-059 — Eve recovery resumes runs with a saved Stop intent

- Reporter: EveRecoveryBugs. Severity: high. Status: source-confirmed cross-file recovery gap.
- Sources: `server/eve/recovery.ts:289-292,325`; `server/eve/admission.ts:128-138`; `server/engines/index.ts:299-324,1811`; `server/eve/bridge.ts:45-53`.
- Trigger/evidence: crash after journal `stopRequested: true` but before native abort persists. Accepted session/delivery identities bypass `validAdmission()`; root `canResume()` accepts, and restored native run does not reject that intent.
- Impact/expected: tools/model calls continue despite durable Stop. Reconcile Stop before resumption.
- Limits: existing tests cover native stopped state, not this persistence gap; no crash run.
- Fixed: `prepareEveRecovery()` stops (never resumes) a run whose journal receipt has `stopRequested`: it is marked stopped, its approvals, questions and operations are settled and its session retired, so `recoverEveRuns()` ends it at the worker. Test in `tests/server/eve-lifecycle.test.ts`.

### BH-060 — Ambiguous Eve steers can be delivered twice

- Reporter: EveRecoveryBugs. Severity: high. Status: source-confirmed double-submission path; timing untested.
- Sources: `server/eve/steer.ts:62-64`; `server/engines/index.ts:1195-1220,1315-1330,1806-1818`; `server/eve/state.ts:92-116`; `server/eve/bridge.ts:69-80`.
- Trigger/evidence: Eve accepts a steer as prior turn finishes but receipt is lost; old run completes before fallback. Fallback marks dropped and resubmits; `stopRun(oldId)` cannot retire the removed run's reusable binding.
- Impact/expected: different idempotency keys (`athena:steer:<id>` / `athena:<newRunId>`) allow repeated instructions/effects. Retire/reconcile ambiguous delivery before retry.
- Limits: accepted old turn can use fallback active-run configuration; no transport race executed.
- Fixed: when a steer may have reached Eve but its answer was lost (a transport error, a timeout, a 5xx or a bad receipt), `sendSteer()` retires the session and ends it at the worker before the caller sends the message again, so a turn Eve started with it cannot run beside the resend; a sure refusal (4xx) keeps the session. Tests in `tests/server/eve-steer.test.ts`.

### BH-061 — Eve steering bypasses intact-current-input budgeting

- Reporter: EveRecoveryBugs. Severity: medium. Status: source-confirmed missing validation.
- Sources: `server/eve/steer.ts:37-43`; `server/eve/admission.ts:264-279`; `server/api/agents.ts:91-98`; `server/api/said.ts:12-23`; installed Eve `harness/compaction/engine.js:1,3`.
- Trigger/evidence: oversized unrestricted steer reaches compaction. Steering calls `eveMessage()` without ordinary `messageTokens()`/`currentLimit` validation; compaction uses the capped tail budget and cuts its middle.
- Impact/expected: chat accepts intact instructions that model memory later shortens. Apply ordinary admission budget to steers.
- Limits: ordinary limit is `min(20000, remainingThreshold / 2)`; existing coverage addresses ordinary input, not this steer edge. No compaction run.

### BH-062 — Retention deletes native results before application settlement

- Reporter: EveRecoveryBugs. Severity: medium. Status: source-confirmed recovery/retention ordering.
- Sources: `server/eve/retention.ts:29-31,54`; `coordinator.ts:44,145-147,168-170`; `runtime.ts:91-100` (under `server/eve`); `server/index.ts:716-722`; `server/execution.ts:108-126`.
- Trigger/evidence: crash after final projection but before application completion, restart over 30 days later. Startup tidies first; fully projected native record is removed without checking unsettled execution receipt.
- Impact/expected: success becomes interrupted, losing successful handoff/callback outcome although answer remains visible. Retain receipts until application completion is reconciled.
- Limits: existing retention tests omit unsettled execution receipts; no long-retention restart run.

### BH-063 — Saved Eve steers without delivery receipts are never reconciled

- Reporter: EveRecoveryBugs. Severity: medium. Status: durability candidate; recovery omission confirmed.
- Sources: `server/eve/steer.ts:43-45`; `server/eve/state.ts:515-519`; `server/engines/index.ts:1284-1289`.
- Trigger/evidence: crash after persisting steer with `deliveryId: null`, before POST reaches Eve. Chat already contains it; recovery ignores saved steers and `lateSteers()` excludes missing delivery IDs.
- Impact/expected: a visible persisted instruction stays permanently unsent. Preserve resend eligibility or explicitly expose unresolved delivery.
- Limits: interrupted-pre-ack durability policy needs confirmation; exact encoded attachment bytes are not persisted. No crash run.

### BH-064 — Failed Windows installer launch leaves desktop ownership dismantled

- Reporter: DesktopLifecycleBugs. Severity: medium. Status: source-confirmed conditional recovery defect.
- Sources: `src-tauri/src/updater.rs:134-143`; locked `tauri-plugin-updater-2.14.1/src/updater.rs:1017-1047`; `tauri-2.12.5/src/app.rs:1128-1138`.
- Trigger/evidence: update download/extraction succeeds but Windows refuses installer launch. Tauri cleanup precedes `ShellExecuteW`, hiding windows, dropping tray/resources and releasing single-instance ownership.
- Impact/expected: app restarts its server/warns but does not rebuild/show resources; hidden app has no tray while `HAS_TRAY` stays true, and another instance can start. Failure should leave the old app usable.
- Limits: locked dependencies inspected; Windows failure path not executed.

### BH-065 — Desktop readiness can navigate to another process's port

- Reporter: DesktopLifecycleBugs. Severity: medium. Status: runtime/race candidate; sequence confirmed.
- Sources: `src-tauri/src/main.rs:324-336,372-380`; `server/index.ts:743-750`.
- Trigger/evidence: another process claims the chosen port after temporary listener closes but before child binds. Readiness accepts any successful TCP connection and navigates without child ownership proof.
- Impact/expected: another service/dashboard's data can appear and be interacted with before child-exit watcher replaces it with an error. Verify owned service readiness.
- Limits: interleaving not reproduced.

### BH-066 — Login-shell PATH timeout leaks the shell process

- Reporter: DesktopLifecycleBugs. Severity: medium. Status: source-confirmed conditional process leak.
- Sources: `src-tauri/src/main.rs:433-448,353-370`.
- Trigger/evidence: macOS/Linux interactive login profile blocks beyond five seconds. `recv_timeout()` abandons receiver, while detached thread remains in `Command::output()` without terminating shell/children.
- Impact/expected: retries can accumulate processes surviving app quit; dashboard child ownership does not cover them. Timeout should bound subprocess lifetime.
- Limits: no blocking shell launched; documented trayless/Linux and other packaging limitations were not classified as bugs.
- Fixed: the login shell asked for PATH runs as its own process group and is killed with what it started when it takes over 5 s, instead of being left running. Compiled for Linux in a standalone check of the function; not run, and the full desktop crate was not built here.

### BH-067 — Delegation from private conversations creates incorrectly owned chats

- Reporter: BrainOrchestrationBugs. Severity: high. Status: source-confirmed producer/guard mismatch.
- Sources: `server/handoffs.ts:30-48`; `server/engines/index.ts:1899-1907`; `server/store.ts:520-530`; `server/tools.ts:1883-1887`.
- Trigger/evidence: gateway/board-private agent calls `ask_agent`. Handoff creates ordinary chat without `conversationId`, then passes it with private parent; ownership guard rejects before start.
- Impact/expected: private agents cannot delegate, leaving failed handle and empty ordinary chat. Helper chat should inherit private ownership.
- Limits: ordinary handoff tests miss this boundary; no helper run.
- Fixed: `startHandoff()` creates the helper's chat in the asker's private conversation (`conversationOfRun()`, shared with `askAgent()`). Test in `tests/server/project-isolation.test.ts`.

### BH-068 — Private runs can collect unrelated handoff results

- Reporter: BrainOrchestrationBugs. Severity: high. Status: source-confirmed authorization gap.
- Sources: `server/handoffs.ts:94-102,153-161,194-204`; `server/tools.ts:1917-1927,2402-2411`; `shared/types.ts:884-897`.
- Trigger/evidence: same agent has dashboard handoffs and a private gateway run. `await_agent` without handles lists agent/project handoffs and excerpts; a listed handle retrieves the answer.
- Impact/expected: private conversations access unrelated delegated instructions/results. Records/collection need asker-conversation ownership, absent from schema and checks.
- Limits: tools remain available in private scopes; no disclosure executed.
- Fixed: handoffs record the asker's `conversationId`; `await_agent` lists and collects only handoffs of the run's own conversation (ordinary chats see none of the private ones). Test in `tests/server/project-isolation.test.ts`.

### BH-069 — Brain activity includes other projects' runs

- Reporter: BrainOrchestrationBugs. Severity: medium. Status: source-confirmed snapshot ownership omission.
- Sources: `server/overseer.ts:505-527,3387-3395`; `server/engines/index.ts:552-562`.
- Trigger/evidence: A works while B's Brain is inspected. Ordinary snapshot accepts global `liveActivity()`; matches local agents by ID only. Clones preserve those IDs.
- Impact/expected: A's task/response can be attributed to B's agent; running count/pulse includes unrelated work even without ID collision. Filter project before matching.
- Limits: private branch does check ownership; no simultaneous-project run.
- Fixed: `liveActivity(projectId)` keeps to one project; the Brain's snapshot and pulse pass theirs, so a run is matched to an agent only in its own project. (The activity log in the snapshot stays global.) Test in `tests/server/project-isolation.test.ts`.

### BH-070 — Brain snapshots mix projects across asynchronous Git inspection

- Reporter: BrainOrchestrationBugs. Severity: medium. Status: source-confirmed pinning gap.
- Sources: `server/overseer.ts:498-506,2941-2942,3009-3043,3060-3079`; `server/projects.ts:222-230`; `server/index.ts:602-604,633-636`.
- Trigger/evidence: unscoped Brain request begins in A, switch to B during awaited Git inspection. Ordinary requests lack private requests' `withProject()`; subsequent collections read B while captured folder/project remain A.
- Impact/expected: mixed context is sent to the model before stale guard, which prevents later actions but not disclosure/call. Pin construction or reject before sending.
- Limits: scheduling window untested.

### BH-071 — Brain steering submits corrections before saving the original question

- Reporter: BrainOrchestrationBugs. Severity: medium. Status: source-confirmed history-ordering race.
- Sources: `server/overseer.ts:742-745,2950-2962,3009-3018,3070,3171-3185`; `server/uistream.ts:214-268`; `web/dock.tsx:1422-1444`.
- Trigger/evidence: while first request thinks, steer “Use PostgreSQL instead.” Stop counter changes but original question saves only after old `think()` returns; client cancels reader and immediately submits correction.
- Impact/expected: correction lacks its original context, and interrupted exchange can appear after replacement answer. Persist original before acknowledging steer.
- Limits: reader cancellation does not finish model call; existing test waits for old answer, missing overlap. No race run.

### BH-072 — Restart loses background helper completion evidence

- Reporter: BrainOrchestrationBugs. Severity: medium. Status: source-confirmed consumer recovery asymmetry.
- Sources: `server/irc.ts:477,541-561,783-825,846-864`; `server/engines/index.ts:310-313,1092-1111`; `server/index.ts:723-737`.
- Trigger/evidence: parent finishes while native helper continues; restart before helper completion. `waitingParents`/`endedChildren` are memory-only and not rebuilt; owner fallback reviews parent chat without appending helper `e.answer`.
- Impact/expected: supervision judges without completed delegated evidence and can request it again. Recover completion linkage/evidence as in uninterrupted flow.
- Limits: distinct from native execution recovery; no restart run.

### BH-073 — Brain API treats unterminated SSE text as a completed answer

- Reporter: BrainOrchestrationBugs. Severity: medium. Status: candidate; acceptance confirmed, provider EOF behavior unverified.
- Sources: `server/brain.ts:229-267`; `server/overseer.ts:1049-1051,3070,3240-3243`; `tests/server/brain-stream.test.ts:11-62`.
- Trigger/evidence: OpenRouter/Venice SSE cleanly closes after preliminary text without `[DONE]`/terminal choice. Parser tracks no completion marker and returns text; plain prose is accepted, and a preceding complete action fence can apply.
- Impact/expected: incomplete replies/actions appear successful, or delegation silently disappears. Detect unterminated generation.
- Limits: tests cover explicit length finish, not absent completion; no provider/proxy request.
- Fixed: a streamed Brain answer counts as finished only with `[DONE]` or a finish reason; one that just stops is an error. An answer that comes whole as JSON, though a stream was asked for, is read as JSON. Test in `tests/server/brain-stream.test.ts`.

### BH-074 — Saved thread edits corrupt the already-published prefix

- Reporter: SocialPostingBugs. Severity: medium. Status: source-confirmed edit/retry mismatch.
- Sources: `server/social.ts:368-384,685-694,829`; `server/api/outbox.ts:33`.
- Trigger/evidence: `[A,B,C]` fails after A posts; save edits `[B,C]`. Complete replacement leaves one `postIds` receipt, so retry skips B. Editing A without removing it also changes local transcript but not public text.
- Impact/expected: retries omit intended parts or history misrepresents published content. Preserve the immutable prefix as approval already does.
- Limits: no provider call.
- Fixed: editing a thread keeps the parts already posted as they were (`editedParts()`, as approval did). Test in `tests/server/social-posting.test.ts`.

### BH-075 — Publishing overwrites concurrent edit/reject/remove decisions

- Reporter: SocialPostingBugs. Severity: medium. Status: source-confirmed competing mutation gap.
- Sources: `server/social.ts:683-684,696-714,742,792-798,816-838`; `server/gateways/outbox-posts.ts:62-65`; `server/store.ts:387-403`; `web/views/outbox.tsx:437-446`.
- Trigger/evidence: mutate X/Reddit card during pending provider request. Only approvals use `publishing`; gateway-only mutation guard returns for social. Publisher later saves its stale object.
- Impact/expected: edits/rejection vanish or removed cards reappear. Refuse/reconcile competing lifecycle mutations.
- Limits: UI exposes Remove during posting; timing untested.
- Fixed: while an X or Reddit post is being published or sent back, editing, rejecting, removing or approving it again is refused (`assertNotBusy()`). Test in `tests/server/social-posting.test.ts`.

### BH-076 — Stale approval still publishes rejected/returned drafts

- Reporter: SocialPostingBugs. Severity: medium. Status: source-confirmed missing status admission.
- Sources: `server/social.ts:678-684,696-729`; `server/api/outbox.ts:34`; `web/views/outbox.tsx:208,379-408`.
- Trigger/evidence: another tab's stale approval arrives after rejection/return. Approval short-circuits only `posted`, without requiring pending/failed.
- Impact/expected: externally sends content after a terminal user decision. Revalidate allowed lifecycle state.
- Limits: no provider call or race execution.
- Fixed: approval only posts a draft that is pending or failed; a rejected or sent-back one is refused. Test in `tests/server/social-posting.test.ts`.

### BH-077 — Asynchronous return does not claim the draft

- Reporter: SocialPostingBugs. Severity: medium. Status: source-confirmed lifecycle race.
- Sources: `server/social.ts:763-769,786-789`; `server/api/outbox.ts:35-38`; `server/teams.ts:570-578`; `server/brain.ts:584-591`.
- Trigger/evidence: returning feedback awaits team routing while draft remains pending; approval publishes meanwhile. Return saves stale `returned` object, overwriting status/receipts. Concurrent returns also duplicate feedback.
- Impact/expected: contradictory publication records or duplicate feedback. Claim/revalidate across asynchronous delivery.
- Limits: route may await member choice; no model/platform call.
- Fixed: sending a draft back claims it until the team has been told, so it cannot be approved or sent back twice meanwhile. Test in `tests/server/social-posting.test.ts`.

### BH-078 — Empty X approval reports a nonexistent post as published

- Reporter: SocialPostingBugs. Severity: medium. Status: source-confirmed missing invariant.
- Sources: `shared/api/outbox.ts:16`; `server/social.ts:370-385,688-704,718`; `web/views/outbox.tsx:348-354`.
- Trigger/evidence: clear every textarea and approve. Filtering leaves no parts; length check succeeds, publish loops zero times and returns `/status/undefined`.
- Impact/expected: card becomes posted though no tweet/image was sent. Reject empty approval as drafting already does.
- Limits: source trace only; no publication.
- Fixed: an X post or DM with nothing left in it is refused before anything is marked posting. Test in `tests/server/social-posting.test.ts`.

### BH-079 — Reddit link edits publish the old URL

- Reporter: SocialPostingBugs. Severity: medium. Status: source-confirmed duplicated-field mismatch.
- Sources: `server/social.ts:560-566,688-694,829-831`; `server/reddit.ts:368-375`; `web/views/outbox.tsx:237,348-354`.
- Trigger/evidence: edit visible URL on a link draft. Editor changes `parts`, while publisher prefers unchanged `reddit.link`.
- Impact/expected: original URL is published although saved/displayed parts show replacement. Synchronize link state or do not expose misleading edits.
- Limits: no Reddit request.
- Fixed: editing a Reddit link post's text changes the link that is posted (and must be one web address). Test in `tests/server/social-posting.test.ts`.

### BH-080 — Interrupted social publications remain stranded in Posting

- Reporter: SocialPostingBugs. Severity: medium. Status: source-confirmed missing startup recovery.
- Sources: `server/social.ts:663,696-697,711-714`; `server/index.ts:714-752`; `web/views/outbox.tsx:71-72,208,437-446`.
- Trigger/evidence: interrupt process after durable `posting`. In-memory lock disappears, startup never reconciles social Outbox, and only pending/failed cards show approval/retry.
- Impact/expected: partial threads with saved continuation receipts remain in Waiting with Remove rather than actionable recovery. Classify unfinished/uncertain posting without blindly resending.
- Limits: no process interruption or provider interaction.
- Fixed: a post left "posting" with nothing sending it becomes failed when listed or acted on, saying how many X parts are posted (approving continues from there) or that a Reddit post or DM may have gone out. Test in `tests/server/social-posting.test.ts`.

### BH-081 — Old X refresh responses overwrite a new sign-in

- Reporter: SocialPostingBugs. Severity: medium. Status: source-confirmed credential generation race.
- Sources: `server/social.ts:238-286,452-459`.
- Trigger/evidence: old refresh awaits while account disconnects/reconnects; response arrives after new credentials save. Refresh serialization excludes reconnect, then assigns old response into the fresh account.
- Impact/expected: new authorization/scopes are replaced with old credentials. Validate connection generation/token before persistence.
- Limits: removal alone does not resurrect an account: assigning into missing entry throws. No account requests.
- Fixed: an X (and Reddit) refresh saves its answer only if the account still has the tokens it refreshed; a sign-in made meanwhile is kept and used, and a disconnected account stays gone. Test in `tests/server/social-posting.test.ts`.

### BH-082 — Outbox requests can change projects during body parsing

- Reporter: SocialPostingBugs. Severity: medium. Status: source-confirmed admission-time ownership gap.
- Sources: `server/index.ts:139-147,602-618,628-630`; `server/rpc.ts:50-66,74-79,108-114`; `server/api/outbox.ts:30-34`; `server/social.ts:555,637,666-668`.
- Trigger/evidence: A's ordinary request passes project-header guard, awaits body, then B opens before handler. Only explicitly scoped routes are pinned; Outbox is not among them. Draft/approval captures current project too late.
- Impact/expected: A's request saves/operates in B. Retain admitted ownership or revalidate after parsing.
- Limits: source scheduling window only; no HTTP scenario.
- Fixed: every JSON route checks the page's project again once its body has been read, and refuses (409) a change for a project that is no longer open, as `index.ts` already did when the request arrived. Under Bun the server seems to receive the whole body first, so the in-process Node test in `tests/server/rpc.test.ts` is what shows it.

### BH-083 — Reddit refresh accepts HTTP-success error documents

- Reporter: SocialPostingBugs. Severity: medium. Status: response-contract candidate.
- Sources: `server/reddit.ts:18-24,132,161-178`; `server/util.ts:518-541`.
- Trigger/evidence: refresh receives an HTTP-success document containing OAuth `error`. Callback checks `tok.error`, refresh does not; it can persist undefined token with future expiry.
- Impact/expected: later calls send `Bearer undefined` instead of exposing refresh failure. Validate the token/error response before saving.
- Limits: discrepancy/control flow confirmed; whether current Reddit refresh failures use this response shape is unverified. No provider request.
- Fixed: a Reddit refresh whose answer has an error, or no token, is refused and nothing is saved. Test in `tests/server/social-posting.test.ts`.

### BH-084 — Memory reads and writes miss ancestor symlink escapes

- Reporter: parent. Severity: medium. Status: source-confirmed containment omission; no filesystem payload executed.
- Sources: `server/memory.ts:34-40,51-65,97-128,178-194`; `server/engines/index.ts:660`; `server/overseer.ts:3045`.
- Trigger/evidence: replace a memory owner directory with a junction/symlink to an outside directory containing MEMORY.md. `plainFile()` checks only the final file, so reads accept it through the linked ancestor. For writes, link the enclosing `memory` directory instead: immediate owner/file checks do not inspect that ancestor.
- Impact/expected: outside contents can enter agent/Brain instructions, and writes can replace an outside MEMORY.md. Resolve and validate the complete destination against the intended data root, not only final components.
- Limits: requires filesystem control over the data-tree link and destination permissions; not an unauthenticated remote attack. Ordinary leaf-link coverage (`tests/server/memory.test.ts:125-133`) does not cover ancestor links. No read/write scenario run.
- Fixed: memory reads, writes and imports go only to a MEMORY.md with no link anywhere between the data folder and it (`noLinksBelow()` in `util.ts`). Test in `tests/server/memory.test.ts` (a junction, so it runs on Windows too).

### BH-085 — Memory import writes through an existing file symlink

- Reporter: parent. Severity: medium. Status: source-confirmed import/write mismatch; not reproduced.
- Sources: `server/memory.ts:155-161`; `server/projectsync.ts:500`; `server/backup.ts:1012`; contrasting ordinary write guard `server/memory.ts:110-115`.
- Trigger/evidence: a restore destination has a plain owner directory but MEMORY.md itself is a symlink to an outside file. `putMemory()` checks only the directory, then `writeFileSync()` follows the file link. Its folder/backup callers use that helper.
- Impact/expected: import can overwrite the outside target with restored memory despite the ordinary editor rejecting that link. Apply equivalent destination safety to import.
- Limits: requires an already-planted destination link (or concurrent filesystem control over a new restore destination) plus target write permission. This does not claim that a backup archive alone can create the link; no restore or symlink executed.
- Fixed: `putMemory()` checks the whole path for links and replaces the file through a new temporary file instead of writing through what is there. Test in `tests/server/memory.test.ts` (skipped on Windows).

### BH-086 — Agent terminals send Dashboard tool calls to the currently open project

- Reporter: TerminalCommandBugs. Severity: high. Status: source-confirmed missing terminal ownership propagation.
- Sources: `server/terminals.ts:95-123,150`; `server/engines/cli.ts:112-115`; `server/mcp.ts:1810-1820`; `server/index.ts:325-336,361-374`; `server/engines/index.ts:563-578`.
- Trigger/evidence: open an agent terminal in A, switch to B and call a Dashboard MCP tool. Launch supplies an agent ID without run/project identity; dispatch resolves the agent and data in the open project. Stored terminal `projectId` never reaches it.
- Impact/expected: a terminal working in A can read/change B, using B's corresponding cloned agent settings or external-client fallback. Preserve terminal project ownership for tool calls.
- Limits: no terminal or tool executed. Unlike BH-046, these terminals never receive ownership rather than losing an expired run binding.
- Fixed: every agent bridge (terminals included) carries `DASH_PROJECT`, the project it was opened in; `/api/internal/tools` and `/tools/call` work there when there is no run, and refuse (410) a project that is gone. Tests in `tests/server/api.test.ts` and `tests/server/groupC-engines-status.test.ts`.

### BH-087 — Generic command Stop and timeout leave descendant processes running

- Reporter: TerminalCommandBugs. Severity: high. Status: source-confirmed incomplete process-tree termination.
- Sources: `server/util.ts:397-405,420-440`; `server/tools.ts:2251-2263`.
- Trigger/evidence: on Linux/macOS, cancel/time out a shell sequence while an external child runs. `killTree()` sends SIGTERM only to the immediate child, with no escalation. Descendants can retain inherited output pipes.
- Impact/expected: work/filesystem effects continue after Stop, and `run()` can await `close` beyond its timeout. Terminate owned descendants and bound settlement.
- Limits: no process scenario executed; this concerns generic command execution, not adapter-specific cancellation gaps.
- Fixed: `run()` starts commands in their own process group off Windows; `killTree()` ends the whole group with SIGTERM, then SIGKILL after 3 s, and `run()` stops waiting 5 s after Stop or the time limit. Checked on Linux in Docker (returns in about 1 s, was 30 s); tests in `tests/server/util.test.ts` (skipped on Windows, where `taskkill /t` already ends the tree).

### BH-088 — Windows terminal wrappers misparse literal arguments for `.cmd` shims

- Reporter: TerminalCommandBugs. Severity: medium. Status: source-confirmed quoting-layer mismatch.
- Sources: `server/terminals.ts:63-68`; installed `@lydell/node-pty-win32-x64/lib/windowsPtyAgent.js:287-338`.
- Trigger/evidence: an npm agent shim receives an argument/path containing a cmd metacharacter such as an ampersand without whitespace. Wrapper uses `cmd.exe /c`; PTY serialization applies argv quoting, not cmd-language escaping.
- Impact/expected: valid paths split into commands or reach the CLI truncated. Preserve literal arguments through the shell layer.
- Limits: no Windows command executed; distinct from MCP backslash rewriting.
- Fixed: on Windows a terminal for an npm shim starts its node and script directly (`ptyCommand()`, using `shimTarget()` as runs do), so its arguments go as they are; any other .cmd goes through cmd.exe and an argument with a character cmd.exe would read is refused. Test in `tests/server/terminal-command.test.ts` (Windows only).

### BH-089 — Terminal sockets never reconnect after ordinary connection loss

- Reporter: TerminalCommandBugs. Severity: medium. Status: source-confirmed missing reconnect/feedback.
- Sources: `web/terminalview.tsx:88-106,125`; comparison `web/core.ts:111-119`.
- Trigger/evidence: a terminal socket drops then connectivity returns. Its effect reconnects only when `id` changes, and close handles only terminal-gone code 4004. App events reconnect independently.
- Impact/expected: healthy dashboard contains a silently frozen terminal that drops keystrokes until reopening. Reconnect or clearly expose disconnection.
- Limits: no network outage simulated.
- Fixed: a terminal view connects again by itself when its socket drops (backing off up to 5 s), starting over from the screen the server sends, and stops when the terminal is gone (4004). Test in `tests/web/terminals.test.tsx`.

### BH-090 — Command result clipping loses the real output tail

- Reporter: TerminalCommandBugs. Severity: medium. Status: source-confirmed output-contract mismatch.
- Sources: `server/util.ts:412-416`; `server/tools.ts:2240,2262`.
- Trigger/evidence: stdout/stderr exceeds the default two-million-character collection cap. Collection keeps the beginning only; later `truncateMiddle()` preserves ends of that prefix, not the command's actual final output.
- Impact/expected: final compiler errors, summaries and completion diagnostics disappear despite the promise to preserve start/end. Retain the actual tail and disclose collection truncation.
- Limits: no large-output command run.
- Fixed: `run()` keeps the first and last halves of output over its limit, saying how much was left out, so a command's real final lines survive. Test in `tests/server/util.test.ts`.

### BH-091 — Hermes/OpenClaw terminals omit Dashboard agent instructions

- Reporter: TerminalCommandBugs. Severity: medium. Status: source-confirmed configuration omission.
- Sources: `server/terminals.ts:99-101,114-116`; `server/engines/hermes.ts:50-59,63-69`; `server/engines/openclaw.ts:117-123,194-199`; `web/views/terminals.tsx:205-208`.
- Trigger/evidence: open an agent whose Dashboard instructions differ from its CLI profile. Those terminal branches never build/deliver `buildSystemPrompt(agent)`, unlike ordinary Dashboard runs.
- Impact/expected: underlying profile starts without the advertised role/instructions/context. Terminal launch should supply them or accurately describe the limitation.
- Limits: external profiles may contain overlapping instructions; no CLI launched.

### BH-092 — OpenCode terminals omit the selected model and effort

- Reporter: TerminalCommandBugs. Severity: medium. Status: source-confirmed launch configuration omission.
- Sources: `server/terminals.ts:117-121`; `server/engines/opencode.ts:157-170,664-689,898-901`.
- Trigger/evidence: open an OpenCode agent with nondefault model/effort. Terminal args/config carry instructions, permissions and MCP, but not those choices; ordinary run dispatch explicitly translates both.
- Impact/expected: terminal can use another provider/model/reasoning default. Honor the Dashboard selection.
- Limits: exact fallback depends on installed OpenCode configuration; no provider call.

### BH-093 — Slow terminal viewers can accumulate unbounded queued output

- Reporter: TerminalCommandBugs. Severity: medium. Status: source-confirmed unbounded queuing path; memory effects unmeasured.
- Sources: `server/terminals.ts:152-155`; installed `ws/lib/websocket.js:141-144,476-505`; `ws/lib/sender.js:567-576`.
- Trigger/evidence: terminal produces output faster than a viewer receives. Scrollback is capped, but every chunk is sent without checking queued bytes/backpressure; the socket writable queue has no application cap.
- Impact/expected: shared-server memory can grow independently of `MAX_BUFFER`. Bound or backpressure slow-client output.
- Limits: no throughput test or observed memory exhaustion.
- Fixed: a viewer more than 4 MB behind is let go (4008) instead of queuing without limit; it connects again and gets the current screen. No test of its own.

### BH-094 — Closing an unready Windows terminal can defer killing indefinitely

- Reporter: TerminalCommandBugs. Severity: medium. Status: runtime candidate; deferred cancellation confirmed.
- Sources: `server/terminals.ts:199-208`; installed `@lydell/node-pty-win32-x64/lib/windowsTerminal.js:74-89,162-181`.
- Trigger/evidence: close before first output, especially a silent long-running command. PTY `kill()` queues until `_isReady`, set by first output; app removes the session and reports closed immediately.
- Impact/expected: if no initialization/output arrives, process remains alive untracked. Closing should actually cancel an unready process.
- Limits: whether ConPTY reliably emits initial data for silent commands is unverified; no process run.
- Fixed: closing a terminal on Windows also ends its process tree by process id (`taskkill /t /f`), so one that never printed anything is not left running. No test of its own (it needs a real Windows terminal).

### BH-095 — Terminal runtime files collide across projects and sessions

- Reporter: TerminalCommandBugs. Severity: medium. Status: source-confirmed overwrite; harmful consumption is a runtime candidate.
- Sources: `server/engines/claude.ts:149-155`; `codex.ts:180-183`; `pi.ts:208-210,479-483`; `opencode.ts:179-184,899-901` (under `server/engines`); `server/backup.ts:971`.
- Trigger/evidence: open corresponding original/cloned agent terminals, or reopen after configuration changes. Global `runtime/<agentId>` and fixed terminal filenames are reused without project/session identity.
- Impact/expected: later launch overwrites files referenced by the older terminal; delayed reads/rereads can consume another project's instructions/MCP settings. Keep per-terminal stable files.
- Limits: overwriting is deterministic; CLI read timing and cross-project consumption not reproduced.
- Fixed: each agent terminal writes its brief and settings under its own tag (`terminal-<id>`) for Claude Code, Codex, pi and opencode, and they are removed when it is closed. Test in `tests/server/groupC-engines-status.test.ts` (the per-file part only).

### BH-096 — Saving or removing a key discards unsaved settings

- Reporter: ProviderSettingsBugs. Severity: medium. Status: source-confirmed form lifetime defect.
- Sources: `web/views/settings.tsx:85-95,400-418,752-766`.
- Trigger/evidence: edit a provider URL or another setting, then save/remove a key. Key handling calls `reload()`, increments the form version and remounts GeneralForm, discarding its patch/input state—even when key saving fails.
- Impact/expected: unrelated edits silently disappear. A replacement key can remain configured against the old endpoint, which subsequent discovery/inference may contact. Refresh secret status without losing the draft.
- Limits: source trace only; no key or endpoint changed and no request made.
- Fixed: saving or removing a key refreshes only which keys are set; the form is no longer rebuilt, so other edits stay. Test in `tests/web/settings-general.test.tsx`.

### BH-097 — Successfully saved settings remain in the next patch

- Reporter: ProviderSettingsBugs. Severity: medium. Status: source-confirmed stale patch retention.
- Sources: `web/views/settings.tsx:93-98`; `server/store.ts:133-137`; `web/core.ts:71-87`.
- Trigger/evidence: A saves a field; B changes it; A saves an unrelated edit. Save never clears the successful entries from `patch.current`, and global refresh does not reset that ref.
- Impact/expected: A resubmits stale values and overwrites B's newer settings. Retire saved patch entries while preserving edits made during an in-flight save.
- Limits: cross-tab ordering inspected; no browser scenario.
- Fixed: a successful Save takes what it sent out of the pending changes (`retireSaved()`), keeping anything changed again while it was saving. Test in `tests/web/settings-general.test.tsx`.

### BH-098 — Provider key changes leave account-specific model catalogs cached

- Reporter: ProviderSettingsBugs. Severity: medium. Status: source-confirmed conditional cache identity defect.
- Sources: `server/models.ts:130-145,190,287-296`; `server/store.ts:146-151`; `server/apiproviders.ts:67-79`; `server/overseer.ts:1466-1476,2098-2104`.
- Trigger/evidence: cache a custom service's key-dependent `/models` list under A, then replace its key with B at the same address. Cache identity has no credential generation and `setSecret()` does not invalidate it.
- Impact/expected: for five minutes Brain discovery can list A's models and reject B-only IDs, while the separately fetched web picker shows B's actual catalog. Retire credential-specific entries and obsolete in-flight fetches.
- Limits: requires an account-scoped catalog; no claim that public OpenRouter/Venice lists vary by key. No credentials or calls touched.
- Fixed: kept model lists are dropped whenever settings or keys change (the `settings` event), and a list still on its way from before is not kept. Test in `tests/server/venice-models.test.ts`.

### BH-099 — Context measurements use inconsistent endpoint/effective-model identity

- Reporter: ProviderSettingsBugs. Severity: medium. Status: source-confirmed measurement/admission mismatch.
- Sources: `server/context.ts:74-77,94-98,110-123`; `server/eve/transcript.ts:79-94`; `server/eve/model.ts:13,43`; `server/eve/admission.ts:259-279`.
- Trigger/evidence: change endpoint while retaining model ID: old measured window still matches and wins before endpoint-aware lookup. Alternatively leave Eve model blank: transcript saves resolved-model identity while later comparison uses the blank agent model.
- Impact/expected: stale endpoint windows can admit oversized/reject fitting input; default-model chats ignore actual usage and show estimates. Use one identity based on resolved endpoint and effective model.
- Limits: persistence-to-admission source trace; no model/compaction run.
- Fixed: an API-model chat's measurement is named by its provider, the address it is asked at and the model it really uses (the default when none is set), the same for saving and comparing. Measurements saved before are taken as estimates once. Test in `tests/server/context.test.ts`.

### BH-100 — Invalid numeric settings are persisted before turns reject them

- Reporter: ProviderSettingsBugs. Severity: medium. Status: source-confirmed save-time validation omission.
- Sources: `shared/api/settings.ts:18,78-81`; `server/api/settings.ts:16`; `web/views/settings.tsx:316-340,351-362,463-466`; `server/eve/model.ts:21-26`; `server/context.ts:94-95`; `server/eve/admission.ts:259-279`.
- Trigger/evidence: save fractional/negative maximum tool steps, negative cost, or negative context window. Contract accepts arbitrary finite numbers and the standalone Save button does not enforce number-input constraints.
- Impact/expected: globally saved configuration breaks subsequent Eve turns or yields negative input budgets. Reject invalid limits at save time and retain usable settings.
- Limits: explicit source failure paths; no invalid settings written.
- Fixed: saving settings refuses a fractional or below-1 tool step limit, and a negative cost limit, context window or tool result size, in plain words. Test in `tests/server/rpc-settings.test.ts`.

### BH-101 — Post-reset Codex refresh can reuse pre-reset work

- Reporter: ProviderSettingsBugs. Severity: medium. Status: source-confirmed cache-ordering race.
- Sources: `server/codexlimits.ts:161-177,190-199`; `server/api/mcp.ts:116-119`; `web/navlimits.tsx:307-319`.
- Trigger/evidence: a limits read captures old values and is pending when a reset is consumed. Post-reset `force: true` bypasses completed cache but still returns `cache.running`.
- Impact/expected: reset response/UI install old usage and credit counts as fresh and may announce the wrong remaining resets. Order refresh after reset consumption.
- Limits: request overlap not executed; no Codex reset or process invoked.
- Fixed: a forced limits read (after a reset) waits for a read already going and then reads again, instead of returning that older read. No test of its own (there is no fake Codex app server).

### BH-102 — Handed-document access crosses private conversation boundaries

- Reporter: KnowledgeDocumentBugs. Severity: high. Status: source-confirmed attachment authorization omission.
- Sources: `server/tools.ts:244-257,2083-2087`; `server/conversations.ts:62-64,126-130`; `server/gateways/conversations.ts:32-39`.
- Trigger/evidence: one Eve agent without Files tools serves multiple private gateway conversations and requests a known document path attached elsewhere. `handedFiles()` collects all of that agent's chat attachments without filtering `conversationId`.
- Impact/expected: `read_document` discloses another private conversation's attachment although history tools reject equivalent access. Limit handed files to the requesting conversation.
- Limits: requires knowing the attachment path; path discovery and unauthenticated access are not established. Existing tests distinguish agents, not conversations; no read executed.
- Fixed: `read_document` hands an agent without Files tools only the attachments of the run's own conversation (ordinary chats see none of the private ones). Test in `tests/server/document-tools.test.ts`.

### BH-103 — Office stored entries evade actual unpacked allocation limits

- Reporter: KnowledgeDocumentBugs. Severity: medium. Status: source-confirmed metadata/allocation mismatch.
- Sources: `server/documents.ts:407-428`; installed `fflate/esm/index.mjs:177-184,2692-2706`.
- Trigger/evidence: an Office ZIP understates stored entries' `originalSize`. Filter accounts declarations while fflate copies compressed-length bodies; all parts allocate before individual actual-size checks, and actual aggregate size is never checked. Repeated central-directory references can amplify one body.
- Impact/expected: Office reading exceeds allocation/aggregate guards on the server thread. Bound actual allocation/output, not only declared sizes.
- Limits: distinct from asset extractor BH-006. Dependency path inspected; no hostile document or payload constructed.
- Fixed: Office unpacking counts each part as the larger of its claimed and stored sizes, and counts the unpacked parts again against the total. Test in `tests/server/documents.test.ts`.

### BH-104 — Knowledge character limits apply only after full-file decoding

- Reporter: KnowledgeDocumentBugs. Severity: medium. Status: source-confirmed unbounded transient read.
- Sources: `server/knowledge.ts:148-156,172,275`; `web/views/agents.tsx:1272-1276`.
- Trigger/evidence: link a large text file/log folder and read/search. `readFileSync(..., 'utf8')` decodes the entire file before slicing to the nominal limits; linked files bypass upload-size restrictions.
- Impact/expected: large references synchronously allocate/block the server; failures are swallowed as empty knowledge. Bound reads before decoding; cache limits do not bound transient work.
- Limits: no large file read executed.
- Fixed: knowledge reads only as many bytes as its character limit can take (`readHead()`), never a whole big file. No test of its own; the existing cache tests now watch the bounded reads.

### BH-105 — Duplicate knowledge labels open a different file from the search result

- Reporter: KnowledgeDocumentBugs. Severity: medium. Status: source-confirmed ambiguous identity.
- Sources: `server/knowledge.ts:69-75,271-275`; `server/tools.ts:1957-1971`.
- Trigger/evidence: link two README.md files or same-named docs folders with equal relative paths. Labels collide; search can return the second file but read selects the first matching label.
- Impact/expected: a valid result leads to unrelated references, and the later file has no unique reader identifier. Give files unambiguous stable identities.
- Limits: source trace only; inspected tests contain no collision fixture.
- Fixed: a second knowledge file with the same label is numbered (`README.md (2)`), so a search hit opens the file it came from. Test in `tests/server/knowledge.test.ts`.

### BH-106 — Stale knowledge sizes bypass the aggregate inline budget

- Reporter: KnowledgeDocumentBugs. Severity: medium. Status: source-confirmed cache/budget mismatch.
- Sources: `server/knowledge.ts:118-127,161-172,211-219`.
- Trigger/evidence: enlarge a linked file during the three-second listing cache. Inline eligibility uses old sizes while `textOf()` reads new contents, allowing up to 200,000 characters per file instead of the 24,000-byte small-knowledge threshold.
- Impact/expected: ordinary edits unexpectedly inflate system context or fail input admission. Enforce budget against current returned contents.
- Limits: cached listing interval is intentional; timing not reproduced.
- Fixed: knowledge goes into the instructions only if what the files hold when read still fits the small-knowledge limit. Test in `tests/server/knowledge.test.ts`.

### BH-107 — Office type detection mistakes embedded content for the outer package

- Reporter: KnowledgeDocumentBugs. Severity: medium. Status: source-confirmed byte-search classification defect.
- Sources: `server/documents.ts:120-124,194-201,489-492`.
- Trigger/evidence: workbook/deck contains stored embedded Office data or XML text with another format's identifying pathname. `documentKind()` searches arbitrary ZIP bytes, prioritizing Word then Excel, rather than top-level package entries.
- Impact/expected: valid outer documents are misclassified and fail extraction, with lasting failure cached. Identify the actual package entries.
- Limits: no real producer sample opened; the stored-content condition follows from the search.
- Fixed: an Office package is told by its own part names (its file list), not by a name found anywhere in its bytes. Test in `tests/server/documents.test.ts`.

### BH-108 — File/document tools drop cancellation before PDF reading

- Reporter: KnowledgeDocumentBugs. Severity: medium. Status: source-confirmed missing signal forwarding.
- Sources: `server/tools.ts:2054,2087,2550-2553`; `server/documents.ts:301-316,345,369-382`.
- Trigger/evidence: Stop during read_file/read_document PDF work or slot waiting. `callTool()` has the run signal, but both `readDocumentPart()` calls omit it.
- Impact/expected: stopped calls still occupy/wait for shared workers; multi-file loops can proceed to more files. Forward cancellation into the already-cancellable reader.
- Limits: existing cancellation tests call reader directly, not these consumers; no Stop scenario.
- Fixed: `read_file` and `read_document` pass the run's signal into the PDF reader, and a multi-file read stops before the next file. The test in `tests/server/document-tools.test.ts` checks the answer only: `callTool()` already answered "Stopped" before, so it does not show the worker being freed.

### BH-109 — PDF queue time is outside the attachment deadline

- Reporter: KnowledgeDocumentBugs. Severity: medium. Status: source-confirmed deadline accounting omission.
- Sources: `server/documents.ts:301-315,345-373`; `server/uploads.ts:344,369-381`.
- Trigger/evidence: both PDF workers and a backlog are occupied. Attachment rendering passes remaining sixty-second budget as `timeoutMs`, but `pdfText()` waits for a slot before starting that timer.
- Impact/expected: preparation exceeds its total budget by queue delay, blocking unrelated admission. Include waiting in the deadline.
- Limits: delay depends on concurrency; inspected tests cover sequential timeout/cancel, not backlog deadlines. No queue executed.
- Fixed: the time a PDF waits for a free thread counts against its time limit; what is left is the reading's limit. Test in `tests/server/documents.test.ts`.

### BH-110 — Failed knowledge URL fetches overwrite good references with error pages

- Reporter: KnowledgeDocumentBugs. Severity: medium. Status: source-confirmed response validation omission.
- Sources: `server/api/agents.ts:190-201`; `server/knowledge.ts:191-195`; `web/views/agents.tsx:1292-1296`.
- Trigger/evidence: save/refresh a URL returning an HTTP error, such as transient 500. Handler never checks `res.ok`, converts the response and saves under a deterministic filename.
- Impact/expected: error text becomes authoritative knowledge and can replace a useful file while reporting success. Reject unsuccessful responses before writing.
- Limits: no network request; inspected tests cover notes/folder links, not URL status.
- Fixed: a knowledge URL that answers with an error is refused (502) before anything is written, so a copy saved earlier stays. Test in `tests/server/rpc-agents.test.ts`.

### BH-111 — Knowledge search snippets can omit every matching term

- Reporter: KnowledgeDocumentBugs. Severity: medium. Status: source-confirmed scoring/excerpt mismatch.
- Sources: `server/knowledge.ts:240-257`; `server/tools.ts:1957-1960`.
- Trigger/evidence: match occurs past character 1,600 in a forty-line passage. Scoring uses the entire passage while output keeps only its prefix.
- Impact/expected: top “matching passages” contain no evidence and crowd visible matches out of six results. Return excerpts around matches.
- Limits: originals remain separately readable; existing truncation tests put keywords first. No search run.
- Fixed: a long search passage is shown from shortly before its first match. Test in `tests/server/knowledge.test.ts`.

### BH-112 — Knowledge pagination cannot access its silently cut-off tail

- Reporter: KnowledgeDocumentBugs. Severity: medium. Status: candidate; truncation confirmed, large-file contract unclear.
- Sources: `server/knowledge.ts:156,264-283`; `server/tools.ts:1966-1971`; `web/views/agents.tsx:1274-1276`.
- Trigger/evidence: linked reference exceeds five million characters. Every reader page first truncates that same prefix and computes total from it; search separately stops at two million.
- Impact/expected: agents without Files cannot reach later contents and totals imply completion. Preserve access or explicitly expose the cutoff.
- Limits: linking large files is suggested, but intended hard-cutoff policy was not documented; no large read executed.
- Fixed: `knowledge_read` says when a file goes on past the 5,000,000 characters it reads, and to use the Files tools for the rest. No test of its own.

### BH-113 — Partial PDF extraction is treated as complete attachment text

- Reporter: KnowledgeDocumentBugs. Severity: medium. Status: candidate; completeness mismatch confirmed, fallback policy unclear.
- Sources: `server/documents.ts:23,264`; `server/uploads.ts:382-386,442`; `server/eve/admission.ts:156-164`.
- Trigger/evidence: a PDF exceeds 300 pages, but sparse extracted pages fit inline. Omitted-page notes exist while `complete` becomes true from any nonempty text; Eve suppresses original PDF bytes.
- Impact/expected: provider gets no later-page contents and read_document has the same cap. Do not equate nonempty partial extraction with full coverage.
- Limits: confirm whether extraction cap intentionally forbids original-PDF fallback; no long PDF created.
- Fixed: a PDF read only in part (past 300 pages) is never counted as complete, so the file itself goes along too. `read_document` still reads 300 pages at most. Test in `tests/server/uploads.test.ts`.

### BH-114 — Equivalent Office XML namespace prefixes lose text or slide order

- Reporter: KnowledgeDocumentBugs. Severity: medium. Status: compatibility candidate; literal-prefix parser restriction confirmed.
- Sources: `server/documents.ts:451-456,492,615-625`; `tests/server/fixtures/documents.ts:67-82`.
- Trigger/evidence: valid Word/PowerPoint uses alternate/default namespaces rather than literal w/a/p/r prefixes. Text regexes require w:/a:, and ordering expects p:sldId/r:id.
- Impact/expected: extraction can silently return empty/incomplete text or filename-ordered slides. Honor namespace-equivalent package contents.
- Limits: Excel already supports/tests alternative prefixes; real Word/PowerPoint producer prevalence not checked.
- Fixed: Word and slide text, and a deck's slide order, use the prefix each part gives its namespace (`nsPrefix()`), a default namespace included, not only w:, a:, p: and r:. Test in `tests/server/documents.test.ts`.

### BH-115 — Office relationship URIs are not normalized before part lookup

- Reporter: KnowledgeDocumentBugs. Severity: medium. Status: compatibility candidate; lookup mismatch confirmed.
- Sources: `server/documents.ts:496-505,554-557,615-621`.
- Trigger/evidence: equivalent target uses dot segments such as `./worksheets/sheet1.xml` or URI-encoded part names. Concatenation omits normalization/decoding before exact map lookup.
- Impact/expected: Excel skips sheets; PowerPoint can omit/reorder slides despite successful-looking extraction. Resolve package-relative URIs correctly.
- Limits: standard fixture targets covered; actual producer prevalence unverified, no document opened.
- Fixed: relationship targets are %-decoded and normalized (`./`, `../`, from the root) before parts are looked up. Test in `tests/server/documents.test.ts`.

### BH-116 — Knowledge uploads silently turn binary documents into Markdown

- Reporter: KnowledgeDocumentBugs. Severity: medium. Status: supported-input candidate; binary-to-text conversion confirmed.
- Sources: `web/views/agents.tsx:1272-1278,1360-1366`; `server/knowledge.ts:191-195`.
- Trigger/evidence: select a small PDF/Office file in unrestricted Knowledge upload picker. Client uses `File.text()`; server appends .md to unsupported extensions and saves decoded bytes.
- Impact/expected: successful upload yields unusable reference material. If text-only is intentional, restrict/reject unsupported files rather than silently corrupting them.
- Limits: document support need not be assumed; no binary file selected or written.
- Fixed: adding a knowledge file refuses a document, picture or archive name, or content with NUL bytes, saying to link its folder or attach it instead (where its text is read). Test in `tests/server/knowledge.test.ts`.

### BH-117 — ComfyUI preparation submits work after Stop

- Reporter: ComfyWorkflowBugs. Severity: high. Status: source-confirmed cancellation gap.
- Sources: `server/comfyui.ts:673-676,697-715,860-874`; `server/tools.ts:881-888,2530-2549`.
- Trigger/evidence: Stop during workflow loading, metadata lookup or image upload. Preparation/upload/submission neither receive nor recheck cancellation; first check is in polling after POST /prompt.
- Impact/expected: remaining files transfer and GPU execution can begin despite Stop. Preserve cancellation through preparation, check before effects and reconcile accepted submission.
- Limits: initial tool guard covers only entry; no Stop/service scenario executed.
- Fixed: `runWorkflow()` checks Stop before each step (finding ComfyUI, loading the workflow, each upload, the submission), uploads take the run's signal, and a submission accepted while Stop came is taken back out of the queue at once (queued-only runs too). Tests in `tests/server/comfyui-run.test.ts`.

### BH-118 — Promoted subgraph widgets ignore supported named values

- Reporter: ComfyWorkflowBugs. Severity: medium. Status: source-confirmed conversion inconsistency.
- Sources: `server/comfyui.ts:387-391,419-424,445-449,483-489`; `tests/server/comfyui-convert.test.ts:126-171,248-318`.
- Trigger/evidence: subgraph instance stores promoted values in widgets_values_named or object-valued widgets_values. Ordinary-node conversion supports those representations, but promotion reads arrays only and falls back to inner defaults.
- Impact/expected: instance prompts, dimensions or settings silently run with wrong values. Apply named lookup before positional fallback.
- Limits: subgraph tests use arrays; no real editor export generated.
- Fixed: a subgraph instance's values kept by name (`widgets_values_named`, or an object) are read before the positional ones. Test in `tests/server/comfyui-convert.test.ts`.

### BH-119 — ComfyUI result references lose the producing server

- Reporter: ComfyWorkflowBugs. Severity: medium. Status: source-confirmed result identity omission.
- Sources: `server/comfyui.ts:756-758,967-969,984-993`; `server/toolimages.ts:150-153`; `web/chat/parts.tsx:211-214`.
- Trigger/evidence: generate on A, switch configured ComfyUI to B, reopen chat. Persisted relative references contain only file/subfolder/type; proxy/model reads resolve the currently selected server.
- Impact/expected: images disappear or display B's same-named output; changing during model capture can give the wrong image. Bind origin server or retain local bytes.
- Limits: later contents determine result; no image request/server change executed.

### BH-120 — ComfyUI discovery accepts unrelated servers returning 404

- Reporters: ComfyWorkflowBugs and ProgramLaunchBugs (independent confirmation). Severity: medium. Status: source-confirmed service identity omission.
- Sources: `server/programs.ts:354-365`; `server/util.ts:540-543`; `server/comfyui.ts:943-965,1048-1050`.
- Trigger/evidence: unrelated HTTP server answers on port 8000. ping accepts statuses below 500, including 404 for /system_stats, ahead of relocated Desktop ports.
- Impact/expected: status says ComfyUI runs, start refuses to launch it and jobs target another service. Validate successful ComfyUI-specific response structure.
- Limits: no HTTP/port reproduction.
- Fixed: ComfyUI is found only where `/system_stats` answers with ComfyUI's own fields (`system` or `devices`), not any status under 500. Test in `tests/server/comfyui-seeds.test.ts`.

### BH-121 — Non-image ComfyUI results lose download links before reaching users

- Reporter: ComfyWorkflowBugs. Severity: medium. Status: source-confirmed tool/UI output loss.
- Sources: `server/tools.ts:891,900-910`; `server/comfyui.ts:751-770`; `web/views/programs.tsx:285-289`; `web/chat/parts.tsx:258-282`.
- Trigger/evidence: workflow generates GIF/video/audio/3D. runWorkflow creates usable URLs, but tool returns URLs only for images; other outputs become filename/type text. Programs panel filters non-images too.
- Impact/expected: successful advertised output has no downloadable reference, particularly for remote servers. Carry and expose all result URLs.
- Limits: existing 3D tests stop at runWorkflow URLs, not end-user delivery; no generation executed.
- Fixed: `comfyui_run` lists a video, GIF, sound or 3D result with its download link (pictures still come back as pictures). The Programs panel still shows pictures only. Test in `tests/server/comfyui-run.test.ts`.

### BH-122 — ComfyUI API discards explicit empty prompt overrides

- Reporter: ComfyWorkflowBugs. Severity: medium. Status: source-confirmed optional-value mismatch.
- Sources: `server/api/programs.ts:35-36`; `shared/api/programs.ts:54-59`; `server/comfyui.ts:657-665`.
- Trigger/evidence: API caller supplies empty positive/negative text to clear saved content. Schema and runner distinguish empty from omitted, but API adapter converts empty strings to undefined.
- Impact/expected: saved prompt runs unchanged instead of being cleared. Forward optional strings without truthiness conversion.
- Limits: current Programs UI itself omits empty positive text; direct API consumers affected. No request executed.
- Fixed: the API passes an empty prompt or negative on as empty (it clears the saved text) instead of dropping it. No test of its own.

### BH-123 — ComfyUI cancellation POSTs are unbounded

- Reporter: ComfyWorkflowBugs. Severity: medium. Status: source-confirmed missing application timeout.
- Sources: `server/comfyui.ts:714-716,929-939`.
- Trigger/evidence: POST /queue stalls before headers. Cancellation awaits it before checking running job; POST /interrupt also has no bounded signal. Only intervening GET has a ten-second timeout.
- Impact/expected: GPU job and stopped tool can remain pending instead of reaching Stopped. Bound cancellation requests.
- Limits: network-dependent; no stalled connection and no assumption about runtime default fetch timeout.
- Fixed: cancelling a ComfyUI job gives each POST a 10 s limit. No test of its own.

### BH-124 — Combined conditioning traversal omits later branches

- Reporter: ComfyWorkflowBugs. Severity: medium. Status: candidate; traversal omission confirmed, override policy unclear.
- Sources: `server/comfyui.ts:580-588,610-615`.
- Trigger/evidence: sampler receives ConditioningCombine with two encoders. Traversal follows first matching input; both encoders are excluded as independent starts, so second branch is never updated.
- Impact/expected: replacement prompt mixes with saved text if top-level override should replace all conditioning branches.
- Limits: whether only first branch is intentional needs confirmation; tests cover linear helpers, no branching run.

### BH-125 — Linked seed inputs bypass randomization and reporting

- Reporter: ComfyWorkflowBugs. Severity: medium. Status: candidate; behavior confirmed, computed-seed policy unclear.
- Sources: `server/comfyui.ts:680-692`.
- Trigger/evidence: sampler seed is a node-output link. Randomization and seed reporting accept numeric literals only, so a linked constant stays fixed and absent from reported seeds.
- Impact/expected: repeated runs can contradict “Seeds are randomized unless set” and cannot report reproducibility state.
- Limits: computed/shared producers cannot safely be treated as literals; intended handling needs confirmation. No workflow run.
- Fixed: a sampler seed linked to another node (a primitive) is randomized and reported there. Test in `tests/server/comfyui-seeds.test.ts`.

### BH-126 — An unavailable explicit ComfyUI address silently falls back elsewhere

- Reporter: ComfyWorkflowBugs. Severity: medium. Status: candidate; fallback confirmed, intended policy unclear.
- Sources: `server/programs.ts:356-365`; `server/comfyui.ts:147-159`.
- Trigger/evidence: configured address is unavailable but another local candidate answers. Explicit address is merely first in discovery, followed by automatic fallbacks.
- Impact/expected: jobs can use another instance's models/inputs instead of failing explicitly. Interface describes probing as auto and comments describe fallback when no address is set.
- Limits: deliberate fallback policy needs confirmation; no service contacted.
- Fixed: an address set in Settings is the only one tried; the automatic ports are tried only when none is set. Test in `tests/server/comfyui-seeds.test.ts`.

### BH-127 — Legacy ComfyUI interrupt can stop a different job

- Reporter: ComfyWorkflowBugs. Severity: medium. Status: version/runtime candidate; check/use race confirmed.
- Sources: `server/comfyui.ts:933-938`.
- Trigger/evidence: checked running prompt finishes before interrupt POST, another starts, and server version ignores prompt_id. Global interrupt then hits that other job.
- Impact/expected: cancellation affects unrelated work despite the comment's safety claim. Do not claim identity is stable across separate requests.
- Limits: supported legacy versions ignoring prompt_id were not available; existing tests hold identity fixed. No race reproduced.

### BH-128 — Outstanding team steers survive Stop and conversation replacement

- Reporter: TeamDispatchBugs. Severity: high. Status: source-confirmed stale continuation.
- Sources: `server/teams.ts:507-523,1399-1407,1703-1704,1740-1759`; `server/api/teams.ts:33,45-58`.
- Trigger/evidence: Stop/Clear/switch while a steer awaits shutdown or joinChatTurn. Stop/replacement changes runtime epoch, but steering never rechecks it before postAndRoute; routing targets the now-open conversation and resets stopped=false.
- Impact/expected: replacement work starts after Stop or instructions enter another thread. Capture/revalidate epoch and thread ownership across awaits.
- Limits: no timing scenario executed.
- Fixed: a team steer remembers the team's epoch before it waits for the turns to end; if Stop, Clear or another conversation came meanwhile it is refused (409, "It was not sent.") instead of routed. Test in `tests/server/team-stop-race.test.ts`.

### BH-129 — Completed team turns post into replacement threads after missed-message waiting

- Reporter: TeamDispatchBugs. Severity: high. Status: source-confirmed post-await ownership gap.
- Sources: `server/teams.ts:1241-1264`; `server/engines/index.ts:1376-1386`; `server/eve/steer.ts:71-77`.
- Trigger/evidence: Stop/Clear/switch while completed turn awaits missedMessages. Epoch/stopped guard precedes that await; afterward old reply/session/handoff changes proceed unconditionally. Native acknowledgement can wait twenty seconds.
- Impact/expected: old output and missed input routing contaminate the new conversation or restart obsolete work. Revalidate current epoch/session before mutations.
- Limits: existing clear-during-model tests cover earlier guard, not this boundary; no race executed.
- Fixed: a finished team turn checks again for Stop, Clear or another conversation after waiting for its missed messages, and then posts and routes nothing. Test in `tests/server/team-stop-race.test.ts`.

### BH-130 — Team queues release before cross-team/background work finishes

- Reporter: TeamDispatchBugs. Severity: medium. Status: source-confirmed incomplete busy definition.
- Sources: `server/teams.ts:345-357,827-834,948-964,1416-1435,1483-1515`; `docs/guide.md:111`.
- Trigger/evidence: local member finishes while its other-team request is outstanding, then /queue or a held message is eligible. Queue idle/release checks only local running/queued/pending work, unlike isTeamBusy and relay completion.
- Impact/expected: later instructions overlap incomplete work despite “whole team is done” ordering. Include relay/delegate work in queue eligibility.
- Limits: no team/delegate execution.

### BH-131 — Team reconnect merges obsolete sessions over the refreshed conversation

- Reporter: TeamDispatchBugs. Severity: medium. Status: source-confirmed stale snapshot precedence.
- Sources: `web/teamchat.tsx:301-307,1107,1185-1187`; `web/chat/TurnView.tsx:32-64`; `server/teams.ts:1779-1800`.
- Trigger/evidence: miss a thread switch during outage; reconnect while same member works in new thread. Merge spreads refreshed sessions first, then old cached sessions, overwriting current ownership.
- Impact/expected: live view follows old conversation or omits actual work. Refreshed mapping should win except for events received during that request.
- Limits: normal connected switch clears mapping correctly; no outage run.

### BH-132 — Delayed team snapshots resurrect ended live turns

- Reporter: TeamDispatchBugs. Severity: medium. Status: source-confirmed load/event race.
- Sources: `web/teamchat.tsx:247-254,305-308,1107,1185-1187`.
- Trigger/evidence: GET captures working member; turn-end arrives before response is applied. Handler removes turning member, then snapshot re-adds stale working entries. early.state guards working list, not turning set.
- Impact/expected: finished turn appears live or duplicates its saved reply until another event/reload. Preserve intervening turn ends over older snapshots.
- Limits: existing tests cover stale state events, not delayed GET after turn end; no browser scenario.

### BH-133 — Open team chats retain outdated member/lead controls

- Reporter: TeamDispatchBugs. Severity: medium. Status: source-confirmed stale metadata binding.
- Sources: `web/teamchat.tsx:292,754-755,1108`; `server/api/workflows.ts:37`; `web/chatwin.tsx:1081-1091`.
- Trigger/evidence: edit membership/lead while chat stays open. C.team loads once; subscription handles no workflow update. App-state refresh retains chat contents and does not replace that object.
- Impact/expected: removed members remain mention targets, new ones are absent, and lead-model control edits former lead. Reconcile roster/lead on updates.
- Limits: server routing reads fresh members; no UI scenario run.

### BH-134 — Editing a nested prefab can exceed ancestors' render depth

- Reporter: VoxelWorldBugs. Severity: medium. Status: source-confirmed graph-depth validation gap.
- Sources: `server/voxel/build.ts:465-469,497`; `web/voxel/instances.ts:17,89`.
- Trigger/evidence: place a valid four-level prefab chain, then add a child to its existing leaf. Validation checks new child depth, not edited prefab's ancestors; drawnCheck counts work, not nesting.
- Impact/expected: successful persistent fifth-level geometry disappears because rendering stops at four. Validate resulting graph through holders.
- Limits: producer/render cutoff inspected; no scene built.

### BH-135 — Short path segments do not advance prefab placement spacing

- Reporter: VoxelWorldBugs. Severity: medium. Status: source-confirmed distance-accounting error.
- Sources: `server/voxel/ops.ts:1106-1133`; `tests/server/voxel-prefabs.test.ts:240-268`.
- Trigger/evidence: along-path segments are shorter than every/carry. carry updates only inside placement loop; skipped segments never subtract their length.
- Impact/expected: densely sampled curves can get only initial copy instead of regularly spaced fences/lamps. Carry distance across every segment.
- Limits: existing test uses one long segment; no operation run.

### BH-136 — Named prefab pivots ignore nested assembly geometry

- Reporter: VoxelWorldBugs. Severity: medium. Status: source-confirmed bounds/pivot mismatch.
- Sources: `server/voxel/build.ts:376-378,520-524`; `server/voxel/prefabs.ts:267-268`; `web/voxel/instances.ts:100-101`; `web/voxel/worldlayer.ts:249,467`.
- Trigger/evidence: prefab consists only of placed parts; choose top/center/bottom. Pivot calculation considers voxel volumes only, returning origin for empty volumes, although size later includes nested parts.
- Impact/expected: assemblies rotate/stand/hang around the wrong point and named changes may do nothing. Use complete bounds for named pivots.
- Limits: explicit-coordinate workaround exists; no rendering executed.

### BH-137 — Extracted prefabs bypass ordinary side-size limits

- Reporter: VoxelWorldBugs. Severity: medium. Status: source-confirmed entrypoint invariant mismatch.
- Sources: `server/voxel/prefabs.ts:169-187`; `server/voxel/build.ts:481-488`.
- Trigger/evidence: extract a 129-voxel-long valid object portion. Extraction checks count/nesting, not dimensions, whereas builder limits sides to 128; publication/import accept the result too.
- Impact/expected: users share prefabs ordinary edits then refuse, even material-only changes. Enforce consistent creation invariants.
- Limits: geometry must first shrink to become editable; no extraction run.

### BH-138 — Prefab pivot changes bypass affected-copy ownership approval

- Reporter: VoxelWorldBugs. Severity: medium. Status: source-confirmed alternate-entrypoint authorization gap.
- Sources: `server/voxel/tools.ts:269-273,287-290,616-628`; `server/voxel/prefabs.ts:266-270`.
- Trigger/evidence: B places A's prefab in B's object; A changes pivot under auto autonomy. Planner/executor check creator only, unlike rebuild copiesCheck, although pivot moves existing copies.
- Impact/expected: another builder's geometry changes without the established copy-owner approval. Apply copy reach/ownership checks to pivot mutations.
- Limits: not unrestricted full autonomy; no mutation executed.

### BH-139 — Prefab reach checks omit worn skins

- Reporter: VoxelWorldBugs. Severity: medium. Status: source-confirmed reach omission; delegated skin-edit policy needs clarification.
- Sources: `server/voxel/reach.ts:111-128`; `server/voxel/tools.ts:246-263`; `web/voxel/skins.ts:274-290,330-340`.
- Trigger/evidence: A's prefab becomes B's character/desk or shared team/Brain skin; A rebuilds it. Reach scans object/prefab instances only, not w.skins, despite direct skin changes requiring approval.
- Impact/expected: appearance/shared geometry changes bypass direct ownership boundary unless also referenced elsewhere. Account for affected skins or explicitly define delegated authority.
- Limits: rendering consumes prefab geometry/animation; no skin/build run.

### BH-140 — Object undo restores references to already-deleted prefabs

- Reporter: VoxelWorldBugs. Severity: medium. Status: source-confirmed missing dependency validation.
- Sources: `server/voxel/build.ts:756-760,870-874`; `web/voxel/instances.ts:92-93`; `web/voxel/worldlayer.ts:467`.
- Trigger/evidence: delete object with copies, delete now-unused prefab, undo object deletion. Undo checks later edits to object ID but not referenced prefab availability.
- Impact/expected: success restores invisible missing parts. Restore dependencies or refuse atomically.
- Limits: ordinary prefab deletion checks current uses, not undo history; no undo run.

### BH-141 — Undoing imports leaks their added palette slots

- Reporter: VoxelWorldBugs. Severity: medium. Status: source-confirmed undo metadata omission.
- Sources: `server/voxel/exchange.ts:58,104-110,132`; `server/voxel/prefabs.ts:529,555-561`; `server/voxel/build.ts:781,810-815`.
- Trigger/evidence: import colors then immediately undo. Import adds palette entries but omits history materials; undo reclaims additions only through mine.materials.
- Impact/expected: repeatedly trying/undoing models exhausts the 255-material palette despite geometry removal. Record/reclaim imported materials like ordinary builds.
- Limits: no import/undo executed.

### BH-142 — Finishing-pass inspections bypass voxel work budgets

- Reporter: VoxelWorldBugs. Severity: medium. Status: source-confirmed missing work accounting.
- Sources: `server/voxel/ops.ts:44-45,876-889,900-973`.
- Trigger/evidence: repeated no-change finishes, such as zero-chance weathering, scan chunks/occupied cells without tick(); only writes are budgeted. Allowed sparse reach can hold 32,768 chunks, about 134 million scanned cells per pass.
- Impact/expected: synchronous operations monopolize server beyond advertised 20-million-inspected-spots guard; script deadlines cannot interrupt a host operation. Budget inspections themselves.
- Limits: accounting/arithmetic inspected; duration/memory not measured.

### BH-143 — Linked world roots are rejected only after object writes/deletions

- Reporter: VoxelWorldBugs. Severity: medium. Status: source-confirmed destination-check ordering.
- Sources: `server/voxel/store.ts:55-58,80,110-115`; `server/util.ts:92-100`; `server/voxel/build.ts:508-537`.
- Trigger/evidence: replace linked project's world directory with a junction/symlink to a world-shaped outside directory. Metadata read checks final file; writeData checks immediate object directory/file; saveWorld rejects root after effects.
- Impact/expected: a refused build/delete can already change outside files or corrupt another world. Check full destination before any data mutation.
- Limits: pre-existing filesystem control/target permissions required; not unauthenticated HTTP. No link or operation executed.

### BH-144 — Voxel import allocates sparse chunks before rejecting spatial extent

- Reporter: VoxelWorldBugs. Severity: medium. Status: allocation candidate; order/arithmetic confirmed, OOM untested.
- Sources: `server/voxel/exchange.ts:50,64-84`; `server/voxel/vox.ts:204,243`; `shared/voxel.ts:40-45`.
- Trigger/evidence: allowed .vox scene spreads placements into distinct chunks ultimately outside reach. voxToGrid materializes first; one-million-voxel allowance can allocate roughly 4 GB in 4,096-byte chunks.
- Impact/expected: even 64 MB input guard cannot prevent memory exhaustion on an import that must fail. Validate extent/allocation before materialization.
- Limits: no import, large allocation or crash attempted.

### BH-145 — Voxel-file imports bypass the world prefab-count cap

- Reporter: VoxelWorldBugs. Severity: medium. Status: capacity candidate; guard mismatch confirmed.
- Sources: `server/voxel/exchange.ts:81-111`; `server/voxel/build.ts:410-412`; `server/voxel/prefabs.ts:517-518`.
- Trigger/evidence: import another .vox prefab after 300. Exchange omits WORLD_LIMITS.prefabs, unlike ordinary creation and library import.
- Impact/expected: capacity grows past the stated limit through one entrypoint while others refuse. Enforce one invariant.
- Limits: practical performance effects unmeasured; no import executed.

### BH-146 — Script-backed world builds ignore Stop during sandbox initialization

- Reporter: VoxelWorldBugs. Severity: medium. Status: cancellation candidate; missing post-await guard confirmed.
- Sources: `server/tools.ts:2549-2553`; `server/voxel/tools.ts:443-450`.
- Trigger/evidence: Stop a first script-backed build while loadSandbox() awaits. Tool's entry guard already passed, and build runs unconditionally when initialization finishes.
- Impact/expected: stopped request can execute/persist a world build. Recheck run cancellation after sandbox loading.
- Limits: initialization/Stop timing not exercised; no script executed.

### BH-147 — Late artifact responses replace the new project's list

- Reporter: ArtifactPreviewBugs. Severity: medium. Status: source-confirmed request ownership omission.
- Sources: `web/views/artifacts.tsx:44-46`; `server/api/files.ts:61-63`.
- Trigger/evidence: A's list request starts, switch to B, B finishes reload, then A arrives. All responses unconditionally setAll without project/request validation.
- Impact/expected: A's artifact list/previews/Open reappear under B. Ignore obsolete responses.
- Limits: response ordering not reproduced.
- Fixed: the Artifacts page keeps only the answer to its latest list request, so a late one from before another project opened is dropped. No test of its own.

### BH-148 — Same-named loose attachments collapse into one sent path

- Reporter: ArtifactPreviewBugs. Severity: medium. Status: source-confirmed item/path identity loss.
- Sources: `web/attach.tsx:200-205,239-256,555`; `server/uploads.ts:95-106,148,175-179`.
- Trigger/evidence: drop report.pdf from two folders. group merges loose files; server reserves distinct names, but item.path ||= saved.top retains only one response.
- Impact/expected: one uploaded document is silently omitted on send. Give loose files independent identities or retain all paths.
- Limits: clipboard renaming does not protect ordinary drops; no upload executed.
- Fixed: loose files are one chip each, so two of one name from different folders are both sent. Test in `tests/web/attach-tray.test.ts`.

### BH-149 — Attachment consumption removes files added after the send snapshot

- Reporter: ArtifactPreviewBugs. Severity: medium. Status: source-confirmed asynchronous snapshot mismatch.
- Sources: `web/attach.tsx:555,638-642`; `web/chat/ChatView.tsx:319,334-351`; `web/taskboard.tsx:618-630`.
- Trigger/evidence: ready snapshots A; add/finish B while first-chat/task creation awaits. take later removes every currently completed item, although request contained only A.
- Impact/expected: B disappears unsent and unavailable for next message. Consume precisely snapshot-owned items.
- Limits: both consumer awaits traced; no browser scenario.
- Fixed: `take()` takes the items the last `ready()` sent, so a file that finished while the message was on its way stays for the next one. Test in `tests/web/attach-tray.test.ts`.

### BH-150 — Closed drop zones keep processing folders and start abandoned uploads

- Reporter: ArtifactPreviewBugs. Severity: medium. Status: source-confirmed missing asynchronous disposal guard.
- Sources: `web/attach.tsx:604,612,619-626,653`; `web/agentchat.tsx:69-74`; `web/teamchat.tsx:1098-1104`.
- Trigger/evidence: close chat while filesFromDrop walks a folder. Cleanup discards current items/listeners, but promise later calls add and starts uploads.
- Impact/expected: files enter an abandoned tray without composer or later discard. Invalidate pending drop/paste processing when owner disposes.
- Limits: no folder walk/upload scenario executed.
- Fixed: files a drop or paste finds after its drop zone was closed are not added (nor uploaded). Test in `tests/web/attach-tray.test.ts`.

### BH-151 — Successfully consumed image attachments leak their object URLs

- Reporter: ArtifactPreviewBugs. Severity: medium. Status: source-confirmed missing release path.
- Sources: `web/attach.tsx:219-220,638-653`; `web/chat/ChatView.tsx:345-360`; `web/brainpane.tsx:123-158`.
- Trigger/evidence: repeatedly send images successfully. take removes items without revoking URLs; consumers never release them, and later clear/discard sees only remaining items.
- Impact/expected: registered Blobs persist until page unload. Release accepted-send resources while allowing failed-send restoration.
- Limits: browser memory not measured.
- Fixed: a sent picture's preview URL is let go when it is taken; one put back after a failed send gets a new one. No test of its own.

### BH-152 — Partially successful preview boxes never retry missing files

- Reporter: ArtifactPreviewBugs. Severity: medium. Status: source-confirmed incomplete retry condition.
- Sources: `web/filepreview.tsx:348-353,400-406`; `web/teamchat.tsx:628-636`; `web/dock.tsx:560-566`.
- Trigger/evidence: streaming names two outputs, only one exists. One preview makes box visible; expiry only retries wholly hidden boxes, so redraw reuses it forever.
- Impact/expected: second output never gets a lookup after it appears. Track unresolved paths independently.
- Limits: existing retry test covers wholly missing boxes; no file generation executed.

### BH-153 — Model-preview fallbacks promise download without a download link

- Reporter: ArtifactPreviewBugs. Severity: medium. Status: source-confirmed missing consumer action.
- Sources: `web/filepreview.tsx:231-234,249-258`; `web/modelviewer.ts:89-91,120,186-188`; `tests/web/filepreview.test.ts:90-105`.
- Trigger/evidence: ordinary chat previews unsupported/oversized/unparseable model. Model branch bypasses FileCard; toolbar has server-side Reveal only, while fallback tells user to download.
- Impact/expected: browser user cannot follow recovery instruction. Expose the file URL/download alongside model fallback.
- Limits: artifact cards have separate Open links; no model/browser run.

### BH-154 — Removed model previews lack observer/model disposal

- Reporter: ArtifactPreviewBugs. Severity: medium. Status: runtime candidate; cleanup omission confirmed.
- Sources: `web/modelviewer.ts:94-103,166-174,199-205`; `web/filepreview.tsx:379-381,404-407`; `web/ui/react.tsx:61-63`; `web/chat/parts.tsx:76-81`.
- Trigger/evidence: replace/remove previews or evict cache repeatedly. IntersectionObserver handle is not retained/disconnected and retained model is not disposed; visibility cleanup releases renderer only.
- Impact/expected: observer/model retention can grow across previews. Propagate explicit disposal through owners/cache eviction.
- Limits: actual browser retention/resource growth unmeasured; no browser execution.

### BH-155 — Versioned/windowed interpreters bypass launch approval classification

- Reporter: ProgramLaunchBugs. Severity: high. Status: source-confirmed executable-name classification gap.
- Sources: `server/tools.ts:274-275,715-718,2426-2432`.
- Trigger/evidence: launch an existing python3.12 or pythonw.exe with a script named .txt. Neither executable matches INTERPRETERS and the file extension does not escalate risk; executable can be resolved by its valid absolute path where necessary.
- Impact/expected: arbitrary script execution is treated as low risk and default auto autonomy skips approval. Recognize executable interpreter variants rather than relying on that narrow name/extension combination.
- Limits: existing launch-risk coverage uses node, not these variants. No interpreter, script or payload executed.
- Fixed: `launch_program` recognises interpreters whatever their version or windowless variant (`python3.12`, `pythonw.exe`, `node22`, `javaw`, `perl5.36`), and the list covers more of them (fish, lua, Rscript, dotnet, msbuild…). Test in `tests/server/launch-risk.test.ts`.

### BH-156 — Shortcut launches silently drop requested files and arguments

- Reporter: ProgramLaunchBugs. Severity: medium. Status: source-confirmed launch-target mismatch.
- Sources: `server/programs.ts:1444-1450,1461-1470`; `server/tools.ts:730`.
- Trigger/evidence: program is available only as a Start Menu shortcut and file/args are supplied. Known shortcut branch is skipped for extras, but Start Menu fallback chooses the same shortcut; openWithShell receives no extras.
- Impact/expected: success is reported without opening the requested document or applying options. Preserve arguments or explicitly reject unsupported shortcut launches.
- Limits: no program launched.
- Fixed: a program found only as a shortcut is refused when it is given a file or options, saying to use open_path or set its path, instead of opening without them. No test of its own.

### BH-157 — Scan again retains stale executable lookup results

- Reporter: ProgramLaunchBugs. Severity: medium. Status: source-confirmed cache invalidation omission.
- Sources: `server/util.ts:215-238`; `server/programs.ts:1342-1345,1355-1362`; contrasting callers `server/api/mcp.ts:103,110`.
- Trigger/evidence: lookup misses, executable is installed in an already-searched PATH directory, then force rescan. Catalog reruns but whichCache still returns null; cached positives likewise survive removal.
- Impact/expected: user-requested discovery cannot recover installation/removal until restart or unrelated cache clearing. Invalidate executable lookup during explicit rescan.
- Limits: no installation or scan executed.
- Fixed: Scan again (`discoverPrograms(true)`) clears the program lookup cache first. Test in `tests/server/util.test.ts`.

### BH-158 — Windows script program targets bypass the Windows-aware launcher

- Reporter: ProgramLaunchBugs. Severity: medium. Status: source-confirmed routing defect; exact runtime failure delivery untested.
- Sources: `server/programs.ts:1449-1450,1464-1465`; `server/util.ts:297-316,445-449`.
- Trigger/evidence: PATH resolves npm .cmd or ComfyUI override names portable .bat. launchDetached uses raw spawn rather than existing Windows-aware spawnCommand; asynchronous errors are discarded.
- Impact/expected: valid script targets fail or report Started misleadingly. Use a supported launcher and surface failure.
- Limits: runtime/Node version determines error delivery; no command launched. Distinct from terminal-specific quoting BH-088.
- Fixed: `launch_program` starts a program through `spawnCommand()` (an npm shim directly, another .cmd or .bat through cmd.exe with its checks) and waits for it to start, so a failure is said instead of "Started". No test of its own.

### BH-159 — Windows lookup cannot resolve already-suffixed executable names

- Reporter: ProgramLaunchBugs. Severity: medium. Status: source-confirmed candidate construction defect.
- Sources: `server/util.ts:219-230`; `server/programs.ts:1449-1450`.
- Trigger/evidence: request notepad.exe available on PATH. Lookup appends extensions to that supplied name, searching notepad.exe.exe/.cmd/etc., never the existing filename.
- Impact/expected: valid program is reported missing while extensionless name works. Try already-suffixed names unchanged.
- Limits: absolute paths take a separate branch; no executable lookup/runtime scenario run.
- Fixed: on Windows `which()` looks for a name that already ends in .exe, .cmd, .bat or .com as it is first. Test in `tests/server/util.test.ts` (Windows only).

### BH-160 — Service polling does not update installation visibility

- Reporter: ProgramLaunchBugs. Severity: medium. Status: source-confirmed discovery/polling state mismatch.
- Sources: `server/programs.ts:1367,1385,1397-1404`; `server/tools.ts:696`; `web/views/programs.tsx:156`.
- Trigger/evidence: service-only ComfyUI is down at discovery and later starts. Poll updates serviceUrl/running but leaves installed=false; optional entries already removed from cache are not polled.
- Impact/expected: now-running service stays hidden in Programs/list_programs until full scan. Reconcile installation visibility when service discovery succeeds.
- Limits: no service started or polled.
- Fixed: the running check asks every service the catalog knows (not only those the last scan listed) and shows one that answers now as installed and running. Test in `tests/server/programs-service.test.ts`.

### BH-161 — Service address changes do not notify the Programs page

- Reporter: ProgramLaunchBugs. Severity: medium. Status: source-confirmed incomplete event-change key.
- Sources: `server/programs.ts:1401-1409`; `web/views/programs.tsx:118-126,191-192`.
- Trigger/evidence: ComfyUI moves ports between polls without an observed stopped interval. serviceUrl changes but running-ID string does not, so no update event emits.
- Impact/expected: open Programs page retains obsolete Open URL despite server discovery. Include address changes in notification criteria.
- Limits: no port/service scenario executed.
- Fixed: a service answering at another address counts as a change, so the page is told. Test in `tests/server/programs-service.test.ts`.

### BH-162 — Linux program catalog confuses Orca IDE with the screen reader

- Reporter: ProgramLaunchBugs. Severity: medium. Status: source-confirmed platform identity inconsistency.
- Sources: `server/programs.ts:328-331,1486-1491`; `web/views/programs.tsx:78,91-95`.
- Trigger/evidence: Linux has bare orca screen reader or only orca-ide. Catalog detects bare orca everywhere, while orcaInstalled explicitly selects orca-ide on Linux.
- Impact/expected: wrong application is advertised/launched or IDE is missed, including terminal command generation. Use consistent platform-specific identity.
- Limits: no Linux process launched.
- Fixed: on Linux the catalog looks for `orca-ide` (as `orcaInstalled()` does), and the Programs page opens that command in a terminal. No test of its own (Linux only).

### BH-163 — Saved executable overrides stay unapplied in cached program launches

- Reporter: ProgramLaunchBugs. Severity: medium. Status: product-policy candidate; cache behavior confirmed.
- Sources: `server/store.ts:133-137`; `server/programs.ts:1328-1346,1438-1443,1476-1482`; `web/views/settings.tsx:425-426,455-457`.
- Trigger/evidence: save another installed version's path. Settings do not invalidate hourly program cache; ordinary launch keeps old executable while programExe-based DCC calls immediately select the new one.
- Impact/expected: launch paths disagree after an explicit setting change. Apply saved override immediately or clearly state delayed effect.
- Limits: background discovery caching is deliberate; intended delay for explicit overrides needs confirmation. No setting changed.
- Fixed: a program path saved in Settings is used by the next launch at once, as the 3D tools already did, whatever the last scan found. Test in `tests/server/launch-risk.test.ts`.

### BH-164 — Blender Python failure policy is supplied after the script action

- Reporter: ProgramLaunchBugs. Severity: medium. Status: runtime compatibility candidate.
- Sources: `server/tools.ts:937-945,953-955`.
- Trigger/evidence: --python script precedes --python-exit-code 1. [INFERENCE] If supported Blender processes actions sequentially, a script exception occurs before nonzero failure policy is set and can be labelled Finished.
- Impact/expected: failed scripts may appear successful. Establish exit policy before execution if the documented ordering requires it.
- Limits: supported Blender semantics need confirmation; no upstream implementation or Blender process inspected.
- Fixed: `--python-exit-code 1` now comes before `--python`, as Blender's own examples put it (it reads its arguments in order). No test of its own; Blender was not run.

### BH-165 — Loaded slicing profiles may restore prohibited post-processing commands

- Reporter: ProgramLaunchBugs. Severity: high. Status: runtime/security candidate; profile validation gap confirmed.
- Sources: `server/dcc.ts:117-118,136-147`; `server/tools.ts:1188-1190,1220-1225`; `tests/server/dcc.test.ts:95-100`.
- Trigger/evidence: use a readable profile containing post-process through --load. Direct setting is explicitly rejected for running programs, but profiles receive path validation only.
- Impact/expected: [INFERENCE] supported PrusaSlicer profile semantics may restore arbitrary command execution through this low-risk tool, bypassing direct-setting restrictions.
- Limits: verify supported CLI profile/post-processing behavior before treating this as an executed bypass. Existing tests cover direct settings only; no slicer/profile run.
- Fixed: `slice_model` refuses an .ini profile, or a .3mf/.amf project, whose saved `post_process` would run a program (`runsAfterSlicing()`; one it cannot read counts as one that would). Tests in `tests/server/dcc.test.ts`. The PrusaSlicer CLI behaviour itself was not run.

### BH-166 — OpenSCAD secondary file access lacks an explicit containment contract

- Reporter: ProgramLaunchBugs. Severity: medium. Status: runtime/product-policy candidate.
- Sources: `server/tools.ts:1140-1142,1170-1178,2652-2664`; `server/dcc.ts:113`.
- Trigger/evidence: only primary input/output paths are validated; submitted model code reaches OpenSCAD unchanged.
- Impact/expected: [INFERENCE] imports, surfaces and includes can reference outside files and incorporate them into allowed output. Define/enforce transitive containment if promised, or explicitly document unrestricted dependencies.
- Limits: tool policy and supported runtime behavior need confirmation; no OpenSCAD execution or outside-file read performed.

- Fixed: before OpenSCAD runs, the files a model reads in (include, use, import, surface; included .scad files followed in turn) must be in the agent's folders; a name that is no file next to the model is left to OpenSCAD's own libraries. A text check, not a sandbox. Test in `tests/server/dcc.test.ts`.