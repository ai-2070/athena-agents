# Shared task tools and chat UI

1 November 2026. Implemented on `fix/team-orchestration-2026-10-31`, extending [automatic work completion](WORK_COMPLETION_2026-11-01.md).

## Request and source contract

Give agents, teams and the Brain the task tools available in Claude Code, and give the user a task UI for each. The user chose **All project tasks with filters** as the Brain's default view.

The implementation follows Anthropic's public [TaskCreate, TaskGet, TaskList and TaskUpdate schemas](https://code.claude.com/docs/en/agent-sdk/python#taskcreate) and [agent-team task coordination](https://code.claude.com/docs/en/agent-teams), reviewed on 1 November 2026. It is our implementation of the documented behavior. No proprietary Claude Code implementation is copied.

| Tool | Saved behavior |
|---|---|
| `TaskCreate` | Create a pending task with subject, full description, optional activeForm and metadata. |
| `TaskGet` | Read full details, owner, metadata and both dependency directions. |
| `TaskList` | Read summaries, owners and unfinished blockers, with pagination and filters. |
| `TaskUpdate` | Change details, claim work, set pending/in_progress/completed/deleted, merge metadata, and add dependency links. A null metadata value removes its key. |

Athena extensions are project/list scope, an owner at creation, dependency removal, search/status/pagination, optimistic edit versions, bulk creation/updates and assignment links for completion checks. Owners are empty, `brain`, `agent:<id>` or `team:<id>`. These names refer to saved Athena agents and teams, not Claude Code teammates.

## Bulk task calls

TaskCreate and TaskUpdate accept either the original single-task fields or `{ "tasks": [...] }`, with a non-empty array and **no per-call task-count cap**, as requested by the user. Mixing the two forms, a missing/empty array or a non-array fails before any mutation. Single-task inputs and responses remain compatible.

```json
{"tasks":[{"subject":"Write the report","description":"Include the findings and sources."},{"subject":"Review the report","description":"Verify every claim."}]}
```

```json
{"tasks":[{"taskId":"<first id>","status":"completed"},{"taskId":"<second id>","addBlockedBy":["<first id>"],"status":"in_progress"}]}
```

The shared batch runner applies each item in array order using the existing create/update validation, permissions, ownership, dependency and version checks. Every item is its own saved change: failures leave that item unchanged and do not roll back successful siblings or prevent later items. Nested batches are rejected per item. This is partial-success behavior, not a transaction over the whole array; retry only failed entries to avoid duplicate creates.

Both tools return `{ "results": [...] }` for batches. Each result has a zero-based index and success. Successes contain taskId, status and updatedAt; failures contain error and a numeric code (such as 400, 403, 404 or 409). Compact acknowledgements retain every task ID without repeating descriptions/metadata; TaskGet reads full saved details. API-model task mutation results bypass the ordinary 24,000-character tool-output crop, Codex/pi retain task results beyond their ordinary 20,000-character crop, and saved task results bypass the shared 30,000-character crop. The MCP bridge already returns the complete result. Model context management still applies to large conversations.

Deletion risk scans every update item. Any deletion gates the entire tool call before mutations, following the existing autonomy settings; an ordinary TaskUpdate allow rule cannot bypass high-risk approval. The Brain's structured TaskCreate/TaskUpdate actions accept the same bulk form, preserve unique-title/new-worker references, report individual errors, and link every successful task to delegated completion checks. Existing task events refresh all chat panels after changes; this adds no separate bulk UI.

The temporary 20-item guard was removed before release at the user's request. Existing per-task field/dependency limits and the project's live-task capacity remain unchanged. Processing is synchronous and ordered; a large batch does more work and may need more model context.

Regression tests cover mixed successes/errors, access denial, malformed/nested inputs, ordered dependencies, stale edits, exclusive claims, approval refusal before any item runs, uncapped 300-item creates/updates, uncut API-model results, native chat result retention, original-project ownership during a switch, Brain bulk actions and delegation bindings. The packaged desktop smoke also exercises partial bulk creation and bulk updates.

## Storage and access

- `shared/types.ts` defines the data and input shapes. `server/tasks.ts` stores one `tasks.json` per project through existing storage helpers. Each synchronous mutation validates the complete change before writing once, including both sides of every dependency. Separate tool calls cannot both acquire an already claimed task.
- Agents can access their own list, lists of teams they belong to, and Brain-list tasks assigned to them or a team they belong to. Creating tasks in other agents' private lists is refused. Membership is checked on every access. The Brain and local dashboard UI manage all project lists.
- Default tool scope is the current team when the run's chat belongs to a team, otherwise the agent. A running tool uses the run's original project and rejects a missing, stopped or wrong-agent run. UI requests use the existing Host, cross-site and `x-dash` checks; MCP uses the internal token.
- Ordinary bookkeeping has risk `none`. Agent tool deletion has risk `high` and passes through existing approval rules. User removal has a confirmation in the UI. Task records do not grant file, shell or messaging access.
- Task creation or ownership records a plan; it does not launch work. The existing chat/delegation tools start agents and teams. Every engine's system prompt explains this distinction and tells workers to recover tasks with TaskList, claim before work, and verify before completing.

## Ownership, dependencies and edits

Task scope is fixed after creation. Team-list owners must be that team, a member or the Brain; private-list owners must be that agent or the Brain. Brain-list tasks may be assigned to any saved agent/team. Empty ownership permits a ready worker to claim it. A task already in progress with an agent owner cannot be taken, finished or released by another agent; the user and Brain can reassign it.

Dependencies must refer to live tasks in the same list. Missing/self/cross-list links and cycles fail without saving any partial edit. Blocked work cannot enter In progress or Completed. TaskList omits completed prerequisites from its blockedBy summaries; TaskGet keeps the full graph. Completing a prerequisite makes dependent tasks ready. Reopening it resets downstream completed/in-progress work to Pending in dependency order. Deleting a task retains a tombstone in the live project, hides it from ordinary reads and detaches links.

UI saves carry expectedUpdatedAt. Stale edits return 409 and preserve the draft until the user explicitly reloads. Only changed task records get a new version; editing a different task does not invalidate the draft.

Inputs and outputs are bounded: subject/working label 240 characters, description 8,000, metadata 2,000 serialized characters, task 18,000 serialized characters, 40 links per direction and 10,000 live tasks per project. TaskList returns at most 100 rows and roughly 17,000 characters of summaries per page; nextOffset retrieves the rest. TaskGet retains the full description. Deleted records cannot displace live work when restoring a copy.

## Brain and completion integration

- `server/tasktools.ts` registers the four core tools for all engines. The existing MCP bridge exposes them to native CLIs. Non-interactive Claude runs disable harness-local TaskCreate/Get/List/Update and TodoWrite so agents use the shared dashboard records.
- The Brain sees open task summaries in its snapshot, can read task details or a filtered page before answering, and can create/update tasks through its existing structured action protocol using the same backend. Read lookups share the existing single second-pass mechanism, with at most three task reads per answer.
- Within a Brain action batch, `new` identifies the last task, unique titles resolve dependencies, and `agent:new`/`team:new` or scope id `new` resolve newly created workers. Ambiguous titles fail instead of guessing. This lets the Brain build a dependency graph before it knows generated task IDs.
- Brain-created/updated tasks are linked to the delegated brief before its run starts. Tasks created during supervised agent/team work inherit that assignment; claiming/completing an existing unlinked task attaches it too. Creating a task in an agent/team UI during its open assignment attaches the matching brief.
- Completion reviews receive linked saved task summaries. An evaluator's done verdict cannot close an assignment while linked tasks remain unfinished; the worker receives the concrete remaining IDs and a reminder to verify/update them. Finished tasks alone do not prove the user's full request was delivered. Existing blockers, Stop, no-progress checks and Needs you behavior remain in force.

## User interface and saved copies

`web/tasks.tsx` supplies one collapsible Tasks panel in full agent chats, team chats and the Brain dock. It uses existing controls and theme tokens. No new navigation page is needed. The compact embedded agent-chat variant keeps its existing layout.

The Brain starts with all project tasks and offers Brain/team/agent filters. Agent/team views include their list and assigned project work. All views support search, status filters, pagination, creation, full-detail editing, ownership/status/working-label changes, prerequisites and confirmed removal. Dependency choices use loaded rows from the same list; All statuses and Show more make completed/older rows available. Metadata remains available through the tools rather than a separate UI editor.

Task events and reconnects refresh open lists. Project changes reset panels and discard stale responses. Failed loads offer Retry; edit conflicts preserve drafts. The panel scrolls within the chat on smaller screens.

Project folder saves, backups and clones include tasks and dependency IDs. Restoring validates records/links, skips damaged entries and deleted tombstones, resets running tasks to Pending and drops old brief links. It does not claim work is still running on another PC. Old saves without tasks remain readable.

## Review findings and validation

Implementation review also fixed Brain TaskList dropping filters/pagination, old deleted records displacing live tasks during restore, and duplicate owner/list labels in task rows. The existing compaction fixture needed a larger fake context window to keep testing between-step compaction after adding four tool schemas; its assertion and production compaction policy are unchanged.

Regression coverage includes CRUD/metadata, dependency readiness/cycles/removal/reopening, competing claims, stale edits, permissions and membership changes, serialization/pagination, core tool risk, live-run project pinning, real HTTP routes, saved-folder and backup/clone round trips, Brain task actions/lookups, and completion refusing unfinished tasks. UI tests cover project-wide/default scope, task creation/editing, dependency removal, conflict drafts, errors/retry/search and live updates under React StrictMode.

- `bun run check`: passed after the bulk follow-up, 196 test files; 1,658 passed and 21 skipped.
- `bun run build` and `bun scripts/build-desktop.ts`: passed, including the bundled server.
- Visual check: isolated headless Edge project, desktop light/dark and a 390 px phone editor; task panel and page had no horizontal overflow. The native browser-control host was unavailable, so the preview used a disposable local server and browser profile, with no model runs or real user data.
- Design detector: no findings in the changed chat/task UI files.
- `bun run desktop:smoke`: passed page/API, conversation search/read, all four task tools, partial bulk creation and bulk updates, MCP bridge and shutdown against the bundled server.
- `git diff --check` passed. The local ccc index was refreshed for the task and engine changes and tests.
