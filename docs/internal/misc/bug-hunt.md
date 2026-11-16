# Bug hunt

Started: 2026-11-16. Updated after all twelve subagent reviews completed.

Investigation only: no application code changed. This is an accumulating concern log, not a claim of exhaustive coverage or patch-introduced regressions.

## Evidence and verification

- Source-confirmed means the relevant control/data flow was inspected, not that the behavior was reproduced.
- Candidates explicitly identify unresolved runtime or product-contract questions.
- No tests, builds, live app scenarios, provider calls, exploit payloads or large-memory reproductions were run.
- Reviewers inspected source, callers, guards, existing tests and installed dependency code where necessary. Language-server navigation was unavailable.
- Source references describe the reviewed tree; dependency line numbers are installation-specific.
- Recovery note: a disk-full append truncated this file. All findings were reconstructed from retained review results after the user authorized removal of the npm cache. That cleanup freed 50 GB. No project files or credentials were deleted.

## Review coverage

All twelve reviews completed:

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
- Parent review: shared text/mention helpers, archive search and selected finding traces.

## Findings

### BH-001 — Bare links outside the short TLD list get the wrong post length

- Severity: medium. Status: source-confirmed contract mismatch; current X recognition of the example domain untested.
- Sources: `shared/xtext.ts:25-30,54-65`; `server/social.ts:499-504,627-632,699-704`; `web/views/outbox.tsx:23-25,360-361`.
- Trigger/evidence: use a bare valid domain such as `example.museum` near the post limit. Its ending is absent from `TLDS`, so it counts as letters rather than 23 characters; explicitly prefixed URLs take a different branch.
- Impact/expected: counter and draft/publish checks can admit over-limit text or reject text that fits. Detected URLs should receive X's fixed weight.
- Limits: regex and enforcement paths inspected; no X request. Existing URL tests cover listed endings only (`tests/server/xtext.test.ts:39-45`). Reference: [X counting rules](https://docs.x.com/fundamentals/counting-characters).

### BH-002 — Non-emoji joiners make ordinary script text count as emoji

- Severity: medium. Status: source-confirmed classification defect; service rejection untested.
- Sources: `shared/xtext.ts:21-23,44-49`; `server/social.ts:499-504,627-632,699-704`.
- Trigger/evidence: ordinary script graphemes containing U+200D, such as an Indic conjunct `क्‍ष`, match `EMOJI` solely because of the joiner. The entire segment costs 2 instead of its ordinary code-point weights.
- Impact/expected: repeated text can pass the shared limit while exceeding X's weighting. Emoji treatment should require an emoji sequence, not a bare joiner.
- Limits: segmentation may differ between runtimes. Existing tests cover emoji joiners, not ordinary-script joiners (`tests/server/xtext.test.ts:22-32`); no runtime reproduction.

### BH-003 — Failed upload cleanup can delete an outside file

- Reporter: FileBoundaryBugs. Severity: high. Status: source-confirmed race-dependent unsafe cleanup.
- Sources: `server/uploads.ts:148-170`.
- Trigger/evidence: while streaming `sub/victim.txt`, replace ancestor `sub` with a symlink/junction to an outside directory containing another `victim.txt`. Post-stream checks reject it, but catch cleanup still removes `tmp` and `target` through those unsafe pathnames.
- Impact/expected: rejection can delete a server-writable outside file. Cleanup must stay within the reservation.
- Limits: requires concurrent filesystem control, link rights and destination permissions; not unauthenticated cross-site HTTP access. OS timing untested.

### BH-004 — Batch creation follows a dangling uploads `.gitignore` link

- Reporter: FileBoundaryBugs. Severity: medium. Status: source-confirmed outside write path.
- Sources: `server/uploads.ts:50-70`; `server/util.ts:110-116`.
- Trigger/evidence: a Git-backed Brain folder has `uploads/.gitignore` linked to a nonexistent outside file. `exists()` follows the link and returns false; `writeFileSync()` then creates its target without checking that child.
- Impact/expected: fixed ignore-all contents can be created outside uploads, including in another repository's missing `.gitignore`. Child writes should respect containment.
- Limits: crafted local project, working file symlinks and write permission required. Straightforward trigger does not overwrite an existing target; not reproduced.

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

### BH-007 — File-search regexes can block beyond the search timeout

- Reporter: FileBoundaryBugs. Severity: medium. Status: source-confirmed guard bypass and blocking path.
- Sources: `server/filetools.ts:154-198`; caller `server/tools.ts:2192-2211`.
- Trigger/evidence: search a long `a` run with a nonmatching suffix using `(a|aa)+$`. The nested-quantifier heuristic misses overlapping alternation; synchronous matching cannot be interrupted by the between-file time check.
- Impact/expected: the shared event loop can freeze despite the eight-second budget. Search should bound individual matching work.
- Limits: needs Files tools and suitable allowed content; `search_files` has risk `none`. Existing coverage catches `(a+)+$`, not this variant. No costly payload executed.

### BH-008 — Different projects can overwrite the same portable save

- Reporter: StorageBugs. Severity: high. Status: source-confirmed destination collision.
- Sources: `server/projects.ts:80-83,105-118`; `server/projectsync.ts:198-204,228-254,715-717`.
- Trigger/evidence: open an already-registered folder again or create projects with the same default folder name. Ordinary creation lacks an ownership guard; both save/prune the same `.dashboard` destination.
- Impact/expected: last save replaces the other recovery copy of agents, chats, knowledge or world state. Independent projects should not own one snapshot destination.
- Limits: source trace only. Backup restoration already rejects ownership collisions (`server/backup.ts:904-912`).

### BH-009 — Copied folders retain the original engine conversation

- Reporter: StorageBugs. Severity: high. Status: source-confirmed session forwarding.
- Sources: `server/projectsync.ts:351,599-611`; `server/engines/index.ts:915-919,944-949`; `server/engines/codex.ts:299-302`.
- Trigger/evidence: copy a saved Brain folder with a matching Codex `sessionEngine`/`sessionId`, then open it as another project. Restore retains the external ID and Codex resumes it.
- Impact/expected: separate local chats share external conversation state, potentially mixing project context. Copies should start independent sessions.
- Limits: no engine call. Reopening the original folder intentionally preserves sessions; backup cloning already clears them and reseeds (`server/backup.ts:995-1001`).

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

### BH-012 — Removing the open project omits the switch event

- Reporter: StorageBugs. Severity: medium. Status: source-confirmed fallback/event mismatch.
- Sources: `server/projects.ts:171-175`; `server/store.ts:299-302`; `web/views/outbox.tsx:52-68,124-127`; `web/views/artifacts.tsx:41-46`; `web/views/station.ts:5476-5480`.
- Trigger/evidence: remove the active project with another remaining. Saving the list happens before `activeProject()` checks; lookup has already fallen back, so `setActiveProject()` is not called.
- Impact/expected: global state changes without `project`, leaving component-local lists/chats stale. Emit the actual transition.
- Limits: generic `projects` refresh does not replace consumers' switch event. No UI scenario run.

### BH-013 — Metadata and world-link updates miss portable autosave

- Reporter: StorageBugs. Severity: medium. Status: source-confirmed unmatched event routing.
- Sources: `server/projects.ts:131-165`; `server/store.ts:267-269`; `server/projectsync.ts:682-713`; `server/voxel/link.ts:30-37`.
- Trigger/evidence: change metadata or a world link without another watched change, especially on an inactive project. Autosave ignores `projects`; link events lack the `world` field its world branch requires.
- Impact/expected: central JSON updates but portable copies remain stale; inactive changes can stay unsaved for the session. Relevant changes should schedule their own save.
- Limits: periodic fallback saves only the active project. No runtime scenario.

### BH-014 — Preserved timestamps can make autosave skip changed contents

- Reporter: StorageBugs. Severity: medium. Status: source-confirmed skip predicate.
- Sources: `server/projectsync.ts:174-179,249-263`.
- Trigger/evidence: replace an authoritative knowledge/chat/skill file with different equal-length contents and an equal/older mtime than its saved copy. `copyTree()` skips without comparing content.
- Impact/expected: successful autosave retains obsolete recovery data. Equal size/newer destination timestamp is not proof of equal contents.
- Limits: timestamp-preserving restores can trigger it; ordinary strictly increasing mtimes do not. Not reproduced.

### BH-015 — Aggregate backups can exceed their decoder's limit

- Reporter: StorageBugs. Severity: medium. Status: candidate; incompatible bounds confirmed.
- Sources: `server/backup.ts:71-87,458,479-481,626`.
- Trigger/evidence: separately allowed categories such as 290 MiB of world data plus 100 MiB of marks exceed the 512 MiB decoded limit after base64. Remaining-room accounting constrains only later task files.
- Impact/expected: serialization can fail or packing can create a backup its decoder rejects; cloning shares the path. Aggregate output must fit the accepted format.
- Limits: exact runtime string/memory failure point untested; no large allocation attempted.

### BH-016 — Backups/clones omit the uploaded Brain model

- Reporter: StorageBugs. Severity: medium. Status: candidate; omission confirmed, intended exclusion unclear.
- Sources: `server/projects.ts:510-566`; `server/backup.ts:133-179,350-351,435-436`.
- Trigger/evidence: upload `brain-model.<ext>`, then clone or restore. The file is in `.dashboard`, but backup shape/packing/restoration cover logo/background, not that model.
- Impact/expected: copied/restored projects lose their custom model if appearance assets are meant to be preserved.
- Limits: no explicit exclusion found and no restore executed; confirm backup contract.

### BH-017 — Manual Start leaves tasks To do or Blocked

- Reporter: TaskLifecycleBugs. Severity: medium. Status: source-confirmed lifecycle mismatch.
- Sources: `server/boardwork.ts:114-125,437-438`; `server/api/taskboard.ts:40`; `web/views/tasks.tsx:889-901,967-972`.
- Trigger/evidence: start an assigned To do/Blocked task from its page. Work starts without changing status/blocked reason; automatic settlement advances only In progress cards.
- Impact/expected: board and execution disagree, including after success. Explicit Start should transition into execution state.
- Limits: static caller-to-settlement trace; no task launched.

### BH-018 — Superseded workers can overwrite task state after file copying

- Reporter: TaskLifecycleBugs. Severity: medium. Status: source-confirmed asynchronous guard gap.
- Sources: `server/boardwork.ts:535-556,592-605`; `server/boardfiles.ts:54-70`.
- Trigger/evidence: while `board_reply` awaits file copying, stop/reassign the task or move it to Done. Ownership is checked only before the await, then comments/tags/status are unconditionally changed.
- Impact/expected: an old worker can undo newer decisions, including Done. Revalidate cancellation and operation ownership before committing.
- Limits: real filesystem await traced; timing untested.

### BH-019 — Agent-only workflows discard saved step prompts

- Reporter: TaskLifecycleBugs. Severity: medium. Status: source-confirmed dispatch mismatch.
- Sources: `server/api/workflows.ts:55-58`; `shared/teams.ts:5-6`; `server/workflows.ts:142,340-350`; `web/views/workflows.tsx:180-236,404-424`.
- Trigger/evidence: run an authored all-agent workflow, including Prompt to image. `isStepList()` is false, so dispatch sends only input/“Go ahead.” to team chat instead of rendering saved steps.
- Impact/expected: custom prompts, ordering and output substitutions are silently lost. Authored step semantics should survive dispatch.
- Limits: editor reachability and producer/consumer paths inspected; no model call.

### BH-020 — Workflow events can alter another project's indicator

- Reporter: TaskLifecycleBugs. Severity: medium. Status: source-confirmed ownership omission.
- Sources: `server/workflows.ts:126-128`; `server/store.ts:35-40`; `server/index.ts:688-691`; `web/core.ts:93-106`; `web/views/station.ts:5513-5531`.
- Trigger/evidence: A runs a workflow, user opens cloned B with the same workflow ID. Events have no project identity and Station matches by workflow ID alone.
- Impact/expected: A can light or clear B's workflow state. Origin ownership must accompany/filter progress.
- Limits: full event path traced; no browser scenario.

### BH-021 — Schedules ignore projects that are not open

- Reporter: TaskLifecycleBugs. Severity: medium. Status: candidate; behavior confirmed, intended policy unclear.
- Sources: `server/workflows.ts:291-307`; `server/routines.ts:287-295`; `server/store.ts:325-326,364-390`.
- Trigger/evidence: enable A's schedule and leave B open past its time. Schedulers enumerate active-project collections only; daily work can pass the one-hour catch-up window.
- Impact/expected: background schedules are skipped if they are intended to be project-independent.
- Limits: no documented open-project-only rule found; source trace, not runtime.

### BH-022 — Entirely unsuccessful routines can be Done

- Reporter: TaskLifecycleBugs. Severity: medium. Status: candidate; aggregation confirmed, mixed-state policy unclear.
- Sources: `server/routines.ts:218-237`.
- Trigger/evidence: one target stops and another fails. Neither all-stopped nor all-failed matches, so aggregate status is `done`.
- Impact/expected: a run with no successful targets looks completed successfully; define appropriate mixed terminal-state precedence.
- Limits: no routine executed.

### BH-023 — Deleted workflows can continue outstanding actions

- Reporter: TaskLifecycleBugs. Severity: medium. Status: candidate; continuation confirmed, deletion semantics unclear.
- Sources: `server/api/workflows.ts:38-42`; `server/workflows.ts:55,81-101`.
- Trigger/evidence: delete a workflow waiting at approval, then approve. Definition removal cancels neither active controls nor checkpoints; execution retains its object.
- Impact/expected: deleted work can perform subsequent actions if deletion is expected to cancel it.
- Limits: explicit stop handling exists but deletion does not invoke it; no action executed.

### BH-024 — Full chat shows the old project while sending to the new one

- Reporter: ClientStateBugs. Severity: high. Status: source-confirmed view/transport binding mismatch.
- Sources: `web/chat/ChatView.tsx:94-98`; `web/views/chat.tsx:389-390`; `web/core.ts:73-74`; `web/app.ts:337-363`; `server/backup.ts:991-1001`.
- Trigger/evidence: open A's chat, switch to cloned B and send without navigation. Transcript/agent stay loaded from A, but unscoped transport uses B's refreshed project header and preserved IDs.
- Impact/expected: instructions run in B while A's conversation is visible. Rebind/remount or explicitly pin the page.
- Limits: stale guard accepts B's current header; no browser or agent run.

### BH-025 — Floating chats can select private task/gateway conversations

- Reporter: ClientStateBugs. Severity: medium. Status: source-confirmed inconsistent selection filter.
- Sources: `web/agentchat.tsx:62,99`; `server/store.ts:486-500`; `server/private-conversations.ts:59-82`.
- Trigger/evidence: a private conversation is the newest agent chat. Initial selection excludes team sessions but not `conversationId`, unlike its own history list.
- Impact/expected: an ordinary tab shows/sends into another workflow's private conversation. Apply consistent private-chat exclusion.
- Limits: static list/selection trace only.

### BH-026 — Reconnection does not catch up open chat history

- Reporter: ClientStateBugs. Severity: medium. Status: source-confirmed missing refresh/follow path.
- Sources: `web/chat/ChatView.tsx:240-249`; `web/core.ts:111-116`; `server/api/status.ts:32-60`.
- Trigger/evidence: miss run events during socket outage, then reconnect. Global state refresh contains no transcript; ChatView neither handles reconnect nor reruns initial history/follow when runs change.
- Impact/expected: replies, queue/loop updates or live streams remain missing until another event/reopen. Reconnection should catch up.
- Limits: no outage simulated.

### BH-027 — Empty-queue loops can lose overlapping run starts

- Reporter: ClientStateBugs. Severity: medium. Status: source-confirmed ordering-dependent catch-up gap.
- Sources: `web/chat/ChatView.tsx:272-278`; `server/engines/index.ts:1110-1127,1618-1622,1751-1794`.
- Trigger/evidence: `/loop 2x review the work` starts its next turn before the preceding client stream ends, with no queued messages. Overlapping starts are retained only for nonempty queues.
- Impact/expected: later loop turns stop streaming live; reload gives only a snapshot. Relevant starts should survive independent of queue contents.
- Limits: source ordering traced; delivery timing untested.

### BH-028 — Obsolete chat loads update the parent after unmount

- Reporter: ClientStateBugs. Severity: medium. Status: source-confirmed stale callback path.
- Sources: `web/chat/ChatView.tsx:196-203`; `web/agentchat.tsx:107-110,150-158`.
- Trigger/evidence: delay C1's load, switch/load C2, then finish C1. Unmounted C1's unchanged ID still passes its check and calls the surviving parent's `onChat`.
- Impact/expected: Full page/history selection can target C1 while C2 is visible. Ignore obsolete view/request responses.
- Limits: no delay injected.

### BH-029 — Chat reconnect ignores cancellation

- Reporter: ClientStateBugs. Severity: medium. Status: source-confirmed missing signal propagation.
- Sources: `web/chat/transport.ts:36-38`; `web/chat/ChatView.tsx:303-308`; installed `ai/dist/index.js:21847-21858,22030-22037`.
- Trigger/evidence: delay reconnect before headers, then steer/close. `reconnectToStream` ignores the SDK's abort signal while steering waits for `followDone`.
- Impact/expected: steering blocks until request settlement/timeout and closed views leave requests outstanding. Forward cancellation.
- Limits: installed SDK inspected; network timing untested.

### BH-030 — Non-ASCII suffixes turn longer words into team mentions

- Reporter: parent. Severity: medium. Status: source-confirmed parser/routing mismatch.
- Sources: `shared/teams.ts:34-48`; `server/teams.ts:527-528,700-715,1283-1286`; `tests/server/crossteam.test.ts:64-80`.
- Trigger/evidence: with team `Café`, write `#Caféé`. ASCII `\w` treats the suffix as a boundary; non-ASCII preceding letters likewise permit in-word matches.
- Impact/expected: ordinary longer words unexpectedly relay work/messages. Exact-name boundaries should include Unicode letters/marks/numbers, as routines already do (`shared/routines.ts:5-10`).
- Limits: tests cover ASCII longer words; no relay executed.

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

### BH-034 — OpenCode initialization has a Stop-handling gap

- Reporter: EngineExecutionBugs. Severity: high. Status: source-confirmed cancellation gap.
- Sources: `server/engines/opencode.ts:342-344,660-781`.
- Trigger/evidence: Stop after server startup while events/model/session setup awaits. Startup listener is removed; turn listener appears only at line 779 before unconditional post.
- Impact/expected: stopped work can still call models/tools, and stalled initialization cannot be interrupted through that signal. Cancellation ownership must remain continuous.
- Limits: no server/model call.

### BH-035 — Pi/OMP crashes return partial text as success

- Reporter: EngineExecutionBugs. Severity: medium. Status: source-confirmed completion-classification gap.
- Sources: `server/engines/pi.ts:118-129,193-208,452-468`; `server/engines/index.ts:1029-1030`.
- Trigger/evidence: subprocess emits text then crashes without turn completion/error frame. Nonempty answers are accepted without requiring completed state or successful exit.
- Impact/expected: unfinished work is marked completed for users/delegates. Require a valid completed outcome.
- Limits: no subprocess crash induced.

### BH-036 — OpenCode quick queries hide errors after preliminary text

- Reporter: EngineExecutionBugs. Severity: medium. Status: source-confirmed failure suppression.
- Sources: `server/engines/opencode.ts:1012,1025-1035`; `server/brain.ts:389-390`; `server/irc.ts:628-643`.
- Trigger/evidence: quick query emits text then errors, exits unsuccessfully or times out. Failure is examined only when answer is empty.
- Impact/expected: Brain can publish preliminary commentary as success. Execution errors must not be hidden by partial output.
- Limits: no command/timeout executed.

### BH-037 — Codex corrupts backslashes in arbitrary MCP arguments

- Reporter: EngineExecutionBugs. Severity: medium. Status: source-confirmed transformation.
- Sources: `server/engines/codex.ts:172,237,298`; `server/mcp.ts:1119-1124`; `server/terminals.ts:104-110`.
- Trigger/evidence: stdio arguments contain scripts, escapes or regex backslashes. `tstr()` replaces all backslashes with `/`, including non-path arguments.
- Impact/expected: commands fail or change behavior in runs/terminals. Encode general strings without path normalization.
- Limits: transformation inspected; downstream effect depends on the command.

### BH-038 — Codex MCP secret variable names collide

- Reporter: EngineExecutionBugs. Severity: high. Status: source-confirmed credential routing collision.
- Sources: `server/engines/codex.ts:257-260,306`; `server/mcp.ts:1101-1104`.
- Trigger/evidence: HTTP servers `work-mail` and `work_mail` have different credentials at the same header index on environment-header-capable Codex. Both use `ATHENA_MCP_SECRET_WORK_MAIL_0`; later value wins.
- Impact/expected: authentication fails or a credential goes to another endpoint/account. Secret names must be unique.
- Limits: supported-version branch only; no credential transmitted.

### BH-039 — Claude acknowledges unrelated steers by substring

- Reporter: EngineExecutionBugs. Severity: medium. Status: source-confirmed ambiguous acknowledgement.
- Sources: `server/engines/claude.ts:342-344`; `server/engines/cli.ts:220-225`; `server/engines/index.ts:840-843,1358-1386`.
- Trigger/evidence: unread “write a summary” and “summary”; replay echoes only the first UUID. Text fallback marks both read and removes both pending deliveries.
- Impact/expected: an unconsumed instruction appears consumed and can be lost to recovery. Combined replay acknowledgement needs unambiguous identity.
- Limits: separate-message replay source trace; no process run.

### BH-040 — CLI recovery omits pending terminal memory reset

- Reporter: EngineExecutionBugs. Severity: medium. Status: source-confirmed recovery omission.
- Sources: `server/engines/index.ts:619,624-635,1494-1503`; `tests/server/eve-coordinator.test.ts:150-163`.
- Trigger/evidence: clear memory during a CLI turn, receive more output, crash before finalization. Saved `clearMemoryOnEnd` is not applied by non-native recovery before reseeding/settling.
- Impact/expected: post-reset material can reenter the new session's context. Apply the terminal reset as normal/native finalizers do.
- Limits: native tests express intended behavior; no restart scenario.

### BH-041 — A crash erases a steer between queue and transcript writes

- Reporter: EngineExecutionBugs. Severity: medium. Status: source-confirmed cross-file durability window.
- Sources: `server/engines/index.ts:842-846,1494-1499`.
- Trigger/evidence: crash after acknowledgement durably unqueues but before saving its transcript receipt. Execution contains only initial input; recovery discards interrupted CLI sessions and reseeds from saved chat.
- Impact/expected: acknowledged instructions vanish from both pending work and history. Keep a recoverable receipt across that write boundary.
- Limits: no crash induced.

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

### BH-044 — Renaming one MCP server transfers another's consent

- Reporter: ApprovalMcpBugs. Severity: high. Status: source-confirmed ambiguous rewrite.
- Sources: `server/mcp.ts:1101-1104,1369-1397,1452-1476`; `server/tools.ts:2426-2428`.
- Trigger/evidence: servers `a`, `a__b`, `c__b`; Eve grant `a__b__send`; rename `a` to `c`. Allowed delimiters make prefix replacement rewrite the unrelated grant to `c__b__send`, across every agent.
- Impact/expected: permissions transfer across endpoints/accounts; removal can revoke unrelated grants. Rewrite exact ownership, not ambiguous prefixes.
- Limits: deterministic source flow; Brain's separately stored server/tool grants are unaffected. Not executed.

### BH-045 — Brain tools Off during discovery still permits dispatch

- Reporter: ApprovalMcpBugs. Severity: medium. Status: source-confirmed revocation gap.
- Sources: `server/brainmcp.ts:130-135,168-174,233-244`; `server/api/settings.ts:16`.
- Trigger/evidence: set Off while `listTools()` awaits. The initial Off guard has passed; afterward only `ask` is special, so current `off` falls through. Settings do not cancel the turn.
- Impact/expected: mutations can dispatch after access is disabled. Recheck mode before dispatch.
- Limits: proceed checks conversation/project/Stop, not mode; disabled-server guards still work. Timing untested.

### BH-046 — Stale run-bound bridges silently become unbound

- Reporter: ApprovalMcpBugs. Severity: medium. Status: source-confirmed fail-open context.
- Sources: `server/mcp-bridge.ts:40-41,97-104`; `server/index.ts:325-374`; `server/engines/index.ts:563-579,1082-1084`; `server/tools.ts:480-500,2547-2549`.
- Trigger/evidence: delayed/surviving bridge calls carry a finished/stopped `DASH_RUN`, possibly after a switch. Null lookup is treated as intentionally unbound, selecting open project with no cancellation.
- Impact/expected: post-run mutations, including risk-none `save_artifact`, can hit another project. Reject supplied-but-unavailable run ownership.
- Limits: internal token required; not unauthenticated HTTP access. Valid live runs are pinned; no timing scenario.

### BH-047 — MCP cancellation does not reach forwarded operations

- Reporter: ApprovalMcpBugs. Severity: medium. Status: source-confirmed missing propagation.
- Sources: `server/mcp-bridge.ts:45-79,97-104`; `server/index.ts:361-374`; installed SDK `@modelcontextprotocol/sdk/dist/esm/shared/protocol.js:173-180,338-343,395-400`.
- Trigger/evidence: external client cancels while approval waits, keeps connection open, then approval is granted. Bridge ignores SDK handler signal; HTTP work stays pending without a run signal.
- Impact/expected: cancelled requests can execute later effects despite suppressed responses. Propagate cancellation before consent/dispatch.
- Limits: cannot undo dispatched effects; Dashboard Stop still handles valid run-bound calls. No cancellation scenario.

### BH-048 — An old connection failure deletes its replacement's cache entry

- Reporter: ApprovalMcpBugs. Severity: medium. Status: source-confirmed asynchronous bookkeeping defect.
- Sources: `server/mcp.ts:1135-1137,1493-1495,1565-1569,1623-1642`.
- Trigger/evidence: A starts, settings disconnect it, B starts, then A rejects. Its unconditional `clients.delete(name)` removes B; close-event handling already checks promise identity.
- Impact/expected: untracked live connections/processes and extra replacements; later cleanup cannot reliably close B. Only remove the failing entry.
- Limits: no race/process-count measurement.

### BH-049 — Paginated MCP lists lose later-page tools

- Reporter: ApprovalMcpBugs. Severity: medium. Status: source-confirmed pagination omission.
- Sources: `server/mcp.ts:1671-1695`; `server/apitools.ts:40-47`; `server/brainmcp.ts:99-100,130-132`; installed SDK client `index.js:554-558`.
- Trigger/evidence: `tools/list` returns `nextCursor`. SDK performs one request; wrapper caches only tools and never follows it.
- Impact/expected: Eve lacks later tools and Brain says they do not exist; refresh repeats page one. Consume pagination.
- Limits: existing fixtures have no cursor; no live server contacted.

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

### BH-052 — Agent comments masquerade as user-approved skill links

- Reporter: SkillInstallBugs. Severity: high. Status: source-confirmed provenance bypass conditional on Brain output.
- Sources: `server/boardwork.ts:74-84,133-135,190-195,592-600`; `server/overseer.ts:2888-2903,3217-3221`.
- Trigger/evidence: agent places a repository in `board_reply`; later task assignment to Brain embeds that comment in `userWords`. `prepareInstalls()` treats its repository as user-provided even with `brainAnyGitHub` off.
- Impact/expected: a generated install action can install agent-suggested instructions against the explicit user-link restriction. Preserve authorship boundaries.
- Limits: requires Brain to emit the action; no model response/install/request executed.

### BH-053 — Skill restore fails when an old file became a directory

- Reporter: SkillInstallBugs. Severity: medium. Status: source-confirmed shape mismatch.
- Sources: `server/skills.ts:481-486,541-544`; `server/history.ts:334`.
- Trigger/evidence: old `references/example` file becomes `references/example/detail.md`; restore old version. Current files are removed but directories remain, so copying the old file onto the directory fails.
- Impact/expected: SKILL.md and extras are partially restored. Remove obsolete structure or stage a complete replacement.
- Limits: no filesystem reproduction.

### BH-054 — Failed GitHub update destroys the live installation

- Reporter: SkillInstallBugs. Severity: medium. Status: source-confirmed destructive ordering.
- Sources: `server/skillinstall.ts:274-285`; contrast `server/skills.ts:1024-1031`.
- Trigger/evidence: partial removal or subsequent rename fails, for example under Windows locking. Old installation is removed before new rename; failure skips the skill and cleans staged files without rollback.
- Impact/expected: failed update leaves a damaged/missing skill, not the original. Preserve live state until replacement succeeds.
- Limits: History may allow manual recovery; bundled updates already attempt rollback. No fault injected.

### BH-055 — Coalesced skill edits lose old extra-file snapshots

- Reporter: SkillInstallBugs. Severity: medium. Status: source-confirmed version/snapshot gap.
- Sources: `server/skills.ts:328-330,529,542-544`; `server/versions.ts:130-137`; `server/skillinstall.ts:267-275`.
- Trigger/evidence: text-edit then GitHub Update within three minutes. Text-only version can coalesce with direct API install, returning null; installer snapshots old extras only when a new version is returned.
- Impact/expected: changed extras disappear from History and old text restore keeps new files. Combined changes must retain complete rollback data.
- Limits: coalescing itself is intentional; no update run.

### BH-056 — Mutable refs mix install revisions and evade aggregate limits

- Reporter: SkillInstallBugs. Severity: medium. Status: source-confirmed ref race.
- Sources: `server/skillinstall.ts:126-145,160-169,224-235`.
- Trigger/evidence: branch advances between tree metadata and independent per-file downloads, which use the branch rather than immutable revision/blob IDs.
- Impact/expected: files can mix commits; listed-small files can grow below individual 2 MB limits but exceed the aggregate 10 MB cap. Use one immutable revision.
- Limits: no requests or branch changes exercised.

### BH-057 — Encoded skill paths produce broken Update origins

- Reporter: SkillInstallBugs. Severity: medium. Status: source-confirmed URL round-trip mismatch.
- Sources: `server/skillinstall.ts:56,239-245`; `web/views/skills.tsx:217,266`.
- Trigger/evidence: encoded branch/folder contains `#`, `?` or literal percent escape. Parser decodes, but origin interpolation does not re-encode; Update reparses it.
- Impact/expected: fragment/query truncation or double-decoding breaks updates or selects another folder. Preserve segment encoding.
- Limits: no repository accessed.

### BH-058 — Missing GitHub CLI credentials stay cached after sign-in

- Reporter: SkillInstallBugs. Severity: medium. Status: source-confirmed negative caching.
- Sources: `server/skillinstall.ts:75-85`; `web/skilldialogs.tsx:296-298`.
- Trigger/evidence: private install before authentication caches null; user follows `gh auth login` then immediately retries, without `GITHUB_TOKEN`.
- Impact/expected: retries remain unauthenticated for ten minutes/restart, also after installing missing CLI. Refresh negative credential discovery on retry.
- Limits: no CLI/authentication run.

### BH-059 — Eve recovery resumes runs with a saved Stop intent

- Reporter: EveRecoveryBugs. Severity: high. Status: source-confirmed cross-file recovery gap.
- Sources: `server/eve/recovery.ts:289-292,325`; `server/eve/admission.ts:128-138`; `server/engines/index.ts:299-324,1811`; `server/eve/bridge.ts:45-53`.
- Trigger/evidence: crash after journal `stopRequested: true` but before native abort persists. Accepted session/delivery identities bypass `validAdmission()`; root `canResume()` accepts, and restored native run does not reject that intent.
- Impact/expected: tools/model calls continue despite durable Stop. Reconcile Stop before resumption.
- Limits: existing tests cover native stopped state, not this persistence gap; no crash run.

### BH-060 — Ambiguous Eve steers can be delivered twice

- Reporter: EveRecoveryBugs. Severity: high. Status: source-confirmed double-submission path; timing untested.
- Sources: `server/eve/steer.ts:62-64`; `server/engines/index.ts:1195-1220,1315-1330,1806-1818`; `server/eve/state.ts:92-116`; `server/eve/bridge.ts:69-80`.
- Trigger/evidence: Eve accepts a steer as prior turn finishes but receipt is lost; old run completes before fallback. Fallback marks dropped and resubmits; `stopRun(oldId)` cannot retire the removed run's reusable binding.
- Impact/expected: different idempotency keys (`athena:steer:<id>` / `athena:<newRunId>`) allow repeated instructions/effects. Retire/reconcile ambiguous delivery before retry.
- Limits: accepted old turn can use fallback active-run configuration; no transport race executed.

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

### BH-067 — Delegation from private conversations creates incorrectly owned chats

- Reporter: BrainOrchestrationBugs. Severity: high. Status: source-confirmed producer/guard mismatch.
- Sources: `server/handoffs.ts:30-48`; `server/engines/index.ts:1899-1907`; `server/store.ts:520-530`; `server/tools.ts:1883-1887`.
- Trigger/evidence: gateway/board-private agent calls `ask_agent`. Handoff creates ordinary chat without `conversationId`, then passes it with private parent; ownership guard rejects before start.
- Impact/expected: private agents cannot delegate, leaving failed handle and empty ordinary chat. Helper chat should inherit private ownership.
- Limits: ordinary handoff tests miss this boundary; no helper run.

### BH-068 — Private runs can collect unrelated handoff results

- Reporter: BrainOrchestrationBugs. Severity: high. Status: source-confirmed authorization gap.
- Sources: `server/handoffs.ts:94-102,153-161,194-204`; `server/tools.ts:1917-1927,2402-2411`; `shared/types.ts:884-897`.
- Trigger/evidence: same agent has dashboard handoffs and a private gateway run. `await_agent` without handles lists agent/project handoffs and excerpts; a listed handle retrieves the answer.
- Impact/expected: private conversations access unrelated delegated instructions/results. Records/collection need asker-conversation ownership, absent from schema and checks.
- Limits: tools remain available in private scopes; no disclosure executed.

### BH-069 — Brain activity includes other projects' runs

- Reporter: BrainOrchestrationBugs. Severity: medium. Status: source-confirmed snapshot ownership omission.
- Sources: `server/overseer.ts:505-527,3387-3395`; `server/engines/index.ts:552-562`.
- Trigger/evidence: A works while B's Brain is inspected. Ordinary snapshot accepts global `liveActivity()`; matches local agents by ID only. Clones preserve those IDs.
- Impact/expected: A's task/response can be attributed to B's agent; running count/pulse includes unrelated work even without ID collision. Filter project before matching.
- Limits: private branch does check ownership; no simultaneous-project run.

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

### BH-074 — Saved thread edits corrupt the already-published prefix

- Reporter: SocialPostingBugs. Severity: medium. Status: source-confirmed edit/retry mismatch.
- Sources: `server/social.ts:368-384,685-694,829`; `server/api/outbox.ts:33`.
- Trigger/evidence: `[A,B,C]` fails after A posts; save edits `[B,C]`. Complete replacement leaves one `postIds` receipt, so retry skips B. Editing A without removing it also changes local transcript but not public text.
- Impact/expected: retries omit intended parts or history misrepresents published content. Preserve the immutable prefix as approval already does.
- Limits: no provider call.

### BH-075 — Publishing overwrites concurrent edit/reject/remove decisions

- Reporter: SocialPostingBugs. Severity: medium. Status: source-confirmed competing mutation gap.
- Sources: `server/social.ts:683-684,696-714,742,792-798,816-838`; `server/gateways/outbox-posts.ts:62-65`; `server/store.ts:387-403`; `web/views/outbox.tsx:437-446`.
- Trigger/evidence: mutate X/Reddit card during pending provider request. Only approvals use `publishing`; gateway-only mutation guard returns for social. Publisher later saves its stale object.
- Impact/expected: edits/rejection vanish or removed cards reappear. Refuse/reconcile competing lifecycle mutations.
- Limits: UI exposes Remove during posting; timing untested.

### BH-076 — Stale approval still publishes rejected/returned drafts

- Reporter: SocialPostingBugs. Severity: medium. Status: source-confirmed missing status admission.
- Sources: `server/social.ts:678-684,696-729`; `server/api/outbox.ts:34`; `web/views/outbox.tsx:208,379-408`.
- Trigger/evidence: another tab's stale approval arrives after rejection/return. Approval short-circuits only `posted`, without requiring pending/failed.
- Impact/expected: externally sends content after a terminal user decision. Revalidate allowed lifecycle state.
- Limits: no provider call or race execution.

### BH-077 — Asynchronous return does not claim the draft

- Reporter: SocialPostingBugs. Severity: medium. Status: source-confirmed lifecycle race.
- Sources: `server/social.ts:763-769,786-789`; `server/api/outbox.ts:35-38`; `server/teams.ts:570-578`; `server/brain.ts:584-591`.
- Trigger/evidence: returning feedback awaits team routing while draft remains pending; approval publishes meanwhile. Return saves stale `returned` object, overwriting status/receipts. Concurrent returns also duplicate feedback.
- Impact/expected: contradictory publication records or duplicate feedback. Claim/revalidate across asynchronous delivery.
- Limits: route may await member choice; no model/platform call.

### BH-078 — Empty X approval reports a nonexistent post as published

- Reporter: SocialPostingBugs. Severity: medium. Status: source-confirmed missing invariant.
- Sources: `shared/api/outbox.ts:16`; `server/social.ts:370-385,688-704,718`; `web/views/outbox.tsx:348-354`.
- Trigger/evidence: clear every textarea and approve. Filtering leaves no parts; length check succeeds, publish loops zero times and returns `/status/undefined`.
- Impact/expected: card becomes posted though no tweet/image was sent. Reject empty approval as drafting already does.
- Limits: source trace only; no publication.

### BH-079 — Reddit link edits publish the old URL

- Reporter: SocialPostingBugs. Severity: medium. Status: source-confirmed duplicated-field mismatch.
- Sources: `server/social.ts:560-566,688-694,829-831`; `server/reddit.ts:368-375`; `web/views/outbox.tsx:237,348-354`.
- Trigger/evidence: edit visible URL on a link draft. Editor changes `parts`, while publisher prefers unchanged `reddit.link`.
- Impact/expected: original URL is published although saved/displayed parts show replacement. Synchronize link state or do not expose misleading edits.
- Limits: no Reddit request.

### BH-080 — Interrupted social publications remain stranded in Posting

- Reporter: SocialPostingBugs. Severity: medium. Status: source-confirmed missing startup recovery.
- Sources: `server/social.ts:663,696-697,711-714`; `server/index.ts:714-752`; `web/views/outbox.tsx:71-72,208,437-446`.
- Trigger/evidence: interrupt process after durable `posting`. In-memory lock disappears, startup never reconciles social Outbox, and only pending/failed cards show approval/retry.
- Impact/expected: partial threads with saved continuation receipts remain in Waiting with Remove rather than actionable recovery. Classify unfinished/uncertain posting without blindly resending.
- Limits: no process interruption or provider interaction.

### BH-081 — Old X refresh responses overwrite a new sign-in

- Reporter: SocialPostingBugs. Severity: medium. Status: source-confirmed credential generation race.
- Sources: `server/social.ts:238-286,452-459`.
- Trigger/evidence: old refresh awaits while account disconnects/reconnects; response arrives after new credentials save. Refresh serialization excludes reconnect, then assigns old response into the fresh account.
- Impact/expected: new authorization/scopes are replaced with old credentials. Validate connection generation/token before persistence.
- Limits: removal alone does not resurrect an account: assigning into missing entry throws. No account requests.

### BH-082 — Outbox requests can change projects during body parsing

- Reporter: SocialPostingBugs. Severity: medium. Status: source-confirmed admission-time ownership gap.
- Sources: `server/index.ts:139-147,602-618,628-630`; `server/rpc.ts:50-66,74-79,108-114`; `server/api/outbox.ts:30-34`; `server/social.ts:555,637,666-668`.
- Trigger/evidence: A's ordinary request passes project-header guard, awaits body, then B opens before handler. Only explicitly scoped routes are pinned; Outbox is not among them. Draft/approval captures current project too late.
- Impact/expected: A's request saves/operates in B. Retain admitted ownership or revalidate after parsing.
- Limits: source scheduling window only; no HTTP scenario.

### BH-083 — Reddit refresh accepts HTTP-success error documents

- Reporter: SocialPostingBugs. Severity: medium. Status: response-contract candidate.
- Sources: `server/reddit.ts:18-24,132,161-178`; `server/util.ts:518-541`.
- Trigger/evidence: refresh receives an HTTP-success document containing OAuth `error`. Callback checks `tok.error`, refresh does not; it can persist undefined token with future expiry.
- Impact/expected: later calls send `Bearer undefined` instead of exposing refresh failure. Validate the token/error response before saving.
- Limits: discrepancy/control flow confirmed; whether current Reddit refresh failures use this response shape is unverified. No provider request.
