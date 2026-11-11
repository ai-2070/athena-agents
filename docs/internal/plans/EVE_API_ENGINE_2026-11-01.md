# Replace the built-in API agent with Eve

_Plan, 1 November 2026; progress updated 2 November. The Eve cutover and compaction removal are implemented. Local Windows integration, build, desktop smoke and Rust checks pass. Final full-suite and Linux/Windows CI validation are being completed. Gateways are explicitly outside this session. Breaking changes are expected; no backward compatibility or saved-session migration is required._

## Progress

All six implementation phases are connected. Ordinary API turns register as `eve`; the handwritten
API loop is deleted. Eve owns model calls, tool sequencing, native context and compaction. Athena
keeps agent/project ownership, tool permissions, consent, saved originals, tasks and completion checks.
No second API harness or legacy reader remains.

Sessions retire on clear/delete, engine or model changes and incompatible runtime versions. Reset
intent survives a restart during a turn. Recovery can join exact saved descendants after their parent
completed. Private native payloads are retained locally until app data is removed; retired bindings
cannot execute or enter portable project copies/backups. This is an explicit retention policy, not
a claim that Workflow payloads have been securely erased.

Admission budgets standing instructions, tools, original history and the full current input. Images
use a conservative pinned-runtime bound; PDFs count page objects, including bounded compressed object
streams. Current input must fit the region Eve retains intact during compaction. Rejection leaves
originals untouched. Tool images are captured in the operation receipt, then passed through supported
Eve tool-output parts and the compatible model's vision messages. Unsupported/oversized images produce
an explicit note. Rich-answer instructions and outputs work through the native runtime; creating or
copying an agent now preserves that setting.

The native context test forces real Eve compaction, verifies model-facing tool images and rich output,
then searches and pages the complete pre-compaction original. Protocol tests cover OpenRouter,
LM Studio, Ollama and custom connections without paid calls. The real-process fixture covers native
waits, Stop, cost/step limits, lost input receipts, worker restarts and saved team read boundaries.
Existing suites exercise Brain, goals, routines, copies, backups, exports and CLI reseeding.

Windows validation passes all 1,710 tests (212 files; 20 intentional skips), the web build,
twenty-request native integration, staged desktop smoke with four crash boundaries, Rust format
and locked Clippy checks. The UI detector has no findings. A live browser visual check could not
run because the browser host is unavailable. No real provider accounts or paid models were used.

CI proved both Linux and Windows desktop jobs. The Linux test job exposed four old cold-start
waits that still assumed an in-process API loop; those waits now allow the native worker to start,
with explicit completion assertions and bounded cleanup. A cancelled Windows run also showed UI
timeouts while native and browser tests competed for resources. CI now runs two Vitest workers,
separates server and browser phases, and allows ten-second DOM polling within a fifteen-second
test. All 61 affected tests pass with that configuration. A final workflow run validates the fixes.
Native summary costs now use Eve's model-usage total plus reported SDK costs that have not yet
reached a refreshed native view. A real compaction test proves a charged summary blocks the next
model request when it reaches the turn budget. The model's already charged request cannot be undone.

## Earlier phase notes (historical)

Lifecycle integration now retires native sessions on clear/delete, engine changes, model generations
and incompatible runtime updates. Active Clear memory allows the current turn to finish, then saves
another reset marker; the reset intent is part of the private execution receipt and survives restart.
Retired handles are never reused. Their native payloads stay in private app data until that data is
removed; originals and tool images are deleted from searchable project history when the chat goes.
This retention policy is documented explicitly rather than claiming secure erasure of Workflow files.
Before a resumed model call, the bridge checks the live owner and runtime version again. Native
children can continue under a completed parent only with matching saved project, depth and root
ownership. Ancestor receipts remain while descendants are unfinished. Windows `bun run check` passes:
210 files, 1,702 tests, 20 intentional skips.

The cutover registers `eve` throughout engine settings, Brain routing and model selection, removes
`server/engines/openai.ts`, and routes normal turns through the private native worker. Shutdown
leaves native work running in its saved ledger instead of recording Stop. Team shutdown preserves
an admitted current assignment. Temporary routine access is saved with the execution receipt and
applied when native tools and instructions are rebuilt; team access is checked live.

Custom instant/summary compaction, overflow retries, `Chat.llm`, `recall_history`, compact/edit API
routes, slash commands and editable checkpoints are gone. Engines own active memory; native markers
are read-only. Context estimates and complete CLI reseeds live in `server/context.ts`. Oversized
original seeds fail explicitly. The settings retain a context-window override only. Source start/dev
commands build the private worker. Typecheck and frontend build pass; the full Windows suite passed
1,696 tests with one effort-test assertion failure, corrected and followed by all 34 API tests passing
(20 intentional skips). The UI detector reports no findings. Final full-suite and desktop checks follow.

Engine lifecycle integration now saves input receipts, agent-chat queues and delegation handles in
private metadata outside project copies. Queue removal and run admission share one atomic write.
Steering saves its replacement input before stopping the old run. Startup reconciliation runs
before schedulers and the Brain's completion checks: unfinished existing-engine work pauses,
unsent inputs remain queued, and Stop remains final. Lost delegation callbacks recover completed
answers from run receipts; interrupted tasks report their interruption without restarting them.
An independent-process test exits between steering and completion and verifies saved order,
attachments and ownership. Native Eve runs are reserved for the coordinator described below.
Team assignments now retain original message IDs, skills, read boundaries, pending routing inputs,
steers and held messages in private metadata. A held input keeps its identity through posting and
assignment. A completed member run can finish its lost team callback on `/resume`, reusing the
saved answer and original read boundary without making another model or tool call. Run receipts
still owned by a paused team remain available beyond the ordinary six-hour retention window.
Stable reply IDs and assignment identities prevent duplicate delivery and follow-up assignments.
Cross-team requests and their delivery identities are saved before forwarding; settled replies
are posted before closing their request. Recovery pauses both teams for review, and an outgoing
request points to the receiving team that needs resuming. Normal shutdown preserves this work;
Stop and Clear save their cancellation before stopping members. Existing completion checks reopen
before a resumed saved result can settle. Project copies retain transcripts but do not inherit
private live-work ownership. Tests cover these boundaries, including a separate process exiting
during routing. Native team joining and new-turn admission are described below; engine registration remains before cutover.

The server now owns the private Eve worker through `server/eve/runtime.ts`. It stays lazy when
there is no saved native work, shares one startup across concurrent callers, and only reports
readiness after recovery. Before launching a worker, a transport-free pass validates owners,
marks unfinished execution intents uncertain, and interrupts orphaned children. This must precede
launch because the local Workflow world starts its saved queue immediately. Ancestor checks run
after all intents are reconciled, so file order cannot leave a child running under an interrupted
parent. Retiring stopped/interrupted native sessions then uses the authenticated worker.
Unexpected worker exit triggers a bounded retry when saved work remains; shutdown cancels startup
and closes the worker before its bridge. The manager resolves source and relocated desktop files
and continues to use the bundled Bun. Server startup runs recovery before schedulers and ordinary
execution reconciliation. Unit tests cover shared readiness, idle/crashed workers, failed recovery,
shutdown during launch and source/desktop paths; the six real-process integration scenarios now
run through this manager. The manager alone does not replace the API engine.

The native coordinator now restores owned runs into Athena's active map before schedules and
completion checks start, then follows the existing session's durable stream. Disconnects retain
the same run and reconnect from its saved cursor; the coordinator never submits a model message.
Saved consent answers are delivered while the stream waits. Stop saves its decision before
aborting the restored signal and retiring the native session. Completed native turns saved before
their application callback can still finish that callback, settle delegation handles and release
the queue. A callback has a persisted completion claim: an interrupted claim pauses follow-up
work for review rather than repeating unknown effects. This is not exactly-once execution of an
arbitrary callback. Native child restoration under already-ended parents still needs the adapter
work below.

Committed text, tools and images project into chat originals with stable source IDs. Chat save
precedes the projection receipt and publication; replay after that gap detects the existing fact.
Tool outputs are retained in full. Final answers resolve the native reply's part IDs; unreadable
references pause the run rather than becoming empty successful answers. Preview deltas do not
become saved originals. Terminal classification waits for the complete durable line, retaining a
pending terminal fact across reconnects so a cancelled turn plus session failure is reported as
a failure. Deleted owners interrupt their runs and close their pending questions; provider error
details remain private rather than being broadcast as diagnostics. Tests cover duplicate replay, the chat-save/cursor gap, project switches,
restored busy state, reconnect, Stop, lost completion callbacks and interrupted completion claims.
The real-process integration now also restarts the worker during a model call, checks that busy
ownership survives, and receives exactly one tool original, answer and completion. Across the
whole fixture there are twenty model requests: only the interrupted request repeats.

Fresh turns now save their exact text, attachment bytes and role-preserving original history before
dispatch. The authenticated Eve channel retrieves that history from Athena; it is never flattened
into a second system prompt. Eve's public creation operation ID and later-turn idempotency key
cover a lost HTTP receipt. Startup retries the same saved input, including files edited or deleted
after admission. Receipts can still record the session identity after an in-flight Stop, without
reviving the run. Missing or retired owners and saved Stops cannot dispatch again. Failed or retired
sessions get a fresh binding on the next turn. History admission
budgets standing instructions, rich-answer instructions, tool definitions and text against the model
window, rejecting oversized originals instead of clipping them. Individual file bytes are capped at
16 MB and the turn at 24 MB; unsupported capacity fails before dispatch. Historical attachments keep
their file references in imported text; the native history interface itself accepts text roles only.
Further provider-specific accounting for document/image token capacity remains part of cutover.

Model, endpoint, effort, temperature, window and run limits now have a saved per-turn selection.
Credentials remain outside it. Permissions and tools still resolve against the current owner.
A changed provider address cannot reroute work already admitted. Model/option changes and a saved
memory-reset mark change the binding generation, starting a fresh session from admitted originals.
Retirement and deletion of old idle runtime state still belong to the cutover paths below.

The direct compatible-model SDK adapter sends temperature and the selected effort without silent
retry at another setting. OpenRouter receives its reasoning shape and prompt-cache identity;
compatible local/custom endpoints receive `reasoning_effort`. Provider-reported token/cache counts
and cost become cursor-deduplicated native facts, saved chat metadata and restored completion totals.
Summary usage counts too. Missing prices remain unknown, including a total with an unpriced call.
No price is estimated from the model name. The memory measurement is stamped with the selected model,
so editing an agent during a run cannot label old usage as a measurement from its new model.

Max tool steps now bounds native model steps, and the cost limit checks the provider-reported cost
available before another provider call. These checks wrap SDK calls; they do not add a second model
loop. The initial known-cost baseline is saved once in Athena's private run record, so a worker
restart cannot reset it. Eve's dynamic memo proved insufficient across the approval restart test.
Checks run at the provider-call boundary rather than during tool-catalog resolution, allowing an
already-approved pending tool to finish. A fixed saved limit reason reaches the run's failure text.
Missing price reports cannot establish an upper spending bound, and an already charged request
cannot be undone. Decimal comparison avoids an extra call from subtraction rounding.

The real Bun fixture now restarts a cost-limited run after the native delivery has durably settled
on an approval, approves the original write, and verifies one file write and no next model request.
It also checks the step limit, per-turn cost baselines on a reused session, requested temperature
and effort, and exact cost/cache totals. Unit tests exercise the actual compatible SDK, absent and
zero prices, role/model changes, endpoint pinning, invalid settings and replay of usage originals.

Saved current team assignments now join their restored native completion handles automatically.
Recovery checks project, agent, chat, team parent and the exact saved current delivery. It never
resubmits the assignment, replaces its delivery or advances its read/file boundary before success.
The dynamic configuration also retains the saved assignment's extra skills.
Unstarted assignments, held inputs and non-native turns remain paused; collecting a native result
cannot start them or trigger a premature completion check. Stop preserves both joined and previously
paused assignments. Unit tests cover repeated recovery, failure, Stop and a project switch. The real
Bun integration now follows a team turn through a worker restart and verifies one posted answer and
the original read mark. It also drops both creation and continuation receipts, restarts, and proves
one model delivery per turn with saved image/PDF bytes and original user/assistant roles.

`server/engines/eve.ts` supplies the admission/follow adapter but is not registered as the built-in
engine yet. The existing API engine remains active while native completion ownership, shutdown,
clearing/deletion and custom-compaction removal are connected in the ordinary run path.

This phase passed Windows typechecking, all 1,748 tests (21 skipped), the web build, the eighteen-request
real Bun integration and staged desktop smoke. Linux CI remains pending.

The following model-controls and usage phase passed Windows typechecking, all 1,756 tests (21 skipped),
the web build, the twenty-request real Bun integration and staged desktop smoke, including its four
crash boundaries. Linux CI remains pending.

A kernel-held loopback ownership socket now prevents two dashboard processes from recovering or
launching the same private runtime directory. Its port is derived from the resolved path, including
Windows path aliases. A collision with another local service fails closed. Process death releases
the claim without stale PID files or lease stealing. Ownership is claimed before reconciliation
and held until worker/bridge shutdown; another owner stops server startup before native state is
reconciled. Tests include an independent process killed while holding the claim.

Phase 1 now has a pinned Eve 1.0.0-rc.1 application, dynamic model/instructions/tool definitions,
private token authentication, an attachment-only virtual filesystem and a repeatable smoke check.
`eve:build` runs Eve under Bun 1.4+ and produces Nitro's Bun output. Desktop staging includes that
output and its filesystem templates; the dashboard continues to use its existing engines.
The Bun server supervises the private Bun process, keeping Tauri's single
dashboard-child ownership model rather than adding a second independent Rust supervisor.

Windows checks prove the model/tool round trip, rejection of unauthenticated input, idle-session
restart, image bytes and PDF input without Docker, and relocation into the staged desktop app.
Models and tool execution in these checks are protocol fixtures: no live paid model, user key or
local model installation is used. Linux CI runs the same proof; that result is still pending.
The initial Node proof worked but added a 92.8 MB Windows executable. Follow-up tests under Bun
1.4.4 passed both the existing Node-targeted output and a fresh native Bun build, so that extra
runtime and its download code were removed. Native Bun output is about 13.6 MB plus a small
filesystem template; source startup measured about 0.6 seconds. These are local observations,
not performance guarantees. The final target is a separate process using the already bundled Bun,
not a second runtime installation or a new agent loop embedded in the dashboard process.

Runtime findings:

- Eve 1.0.0-rc.1 ignores `WORKFLOW_LOCAL_DATA_DIR` for its managed local world and derives state
  from the process working directory. The supervisor must use a private working directory under
  `DATA` and copy the prepared attachment templates there. Compiler output alone is insufficient.
- A reply's delivery event can precede its Workflow checkpoint. Set
  `WORKFLOW_INLINE_OWNERSHIP=0` to avoid a dead worker's inline ownership lease (about 14 minutes).
  A separate crash gap was traced to the local store creating an empty terminal claim before
  writing its step checkpoint and event. The surviving claim rejects completion forever after
  a crash between those writes. The pinned local-store patch below fixes that gap.

Phase 2 adds private session bindings and a run ledger below `DATA/runtime/eve`, current project,
agent and team permission resolution, configuration fingerprints, immutable run/delivery ownership,
and ordered event IDs for replay. Provider discovery and API tool catalogs now live outside the
old API engine. Engine capabilities describe direct tools and attachment handling explicitly.
The private bridge routes selected tools through Athena's existing risk checks and MCP account
selection; the process host confines runtime state to `DATA` and owns its child through stdin.

Committed Eve facts are normalized and saved before they can be published. Transient previews
are excluded from saved originals; referenced values must be resolved before projection, rather
than substituted with an empty result. The API adapter and UI consumption arrive at cutover.

`bun run eve:integration` exercises the actual Bun process, private Athena bridge, saved ownership,
tool routing and event projection with a fake provider and isolated project. Unit tests cover
project switches, retired bindings, changed permissions, competing runs, stopped-run finality,
duplicate events, tool results, native compaction markers and process shutdown. These are the
foundations for the durable waits below.

Checkpoint interruption is now a required process regression check:

```sh
bun run eve:recovery
```

The check holds the filesystem write at each of three precise boundaries: after the claim but
before the step checkpoint, after the checkpoint but before its event, and after the event but
before clearing the claim's payload. It kills the worker, restarts it and sends another message.
All three windows pass repeatedly on Windows/Bun 1.4.4, without repeating either model call or
the tool. Linux results remain pending CI. Tests use a fake provider, never paid calls or user
credentials. The fault preload exists only in the throwaway test process.

`runtime/eve-world` selects `@workflow/world-local` 5.2.1 through Eve's public custom-world option.
The committed Bun patch stores the exact outcome and event in the atomic terminal claim, then
finishes pending writes before startup requeues work. It clears the extra payload after committing
both files. Successes, failures, duplicate startup and event deduplication have tests. Application
code does not edit private Workflow files, and no model or tool runs during this storage recovery.
No old orphan claims are migrated. See that package's README for patch removal criteria.

The local store must retain its package metadata, so its import stays at runtime and the build
copies its complete dependency tree. The relocated desktop smoke repeats all three crash windows
using the bundled Bun. Active work also resumes on startup without new input, and the custom
world authenticates internal queue deliveries. Output is now about 16.2 MB plus the attachment template, compared with the
initial 13.6 MB proof. The temporary diagnostic edits to generated output are gone.

Phase 3 persists approvals, exact consent identities, edited arguments, decisions and expiry. Eve's
native approval policy parks the call, rather than keeping an ordinary HTTP executor waiting for
consent. Athena remains the only approval UI. Outbox questions use the same checkpoint boundary;
an answer resumes its original saved call instead of also queuing a second chat message.

Every tool operation has a project/session/run/call identity, saved execution intent and a saved
outcome. Duplicate calls join a live executor or reuse its completed result. An execution intent
left behind by a crash becomes uncertain, interrupts the run and asks the user to check the outcome.
Acknowledging that check cannot restart the tool. This is conservative reconciliation, not a claim
of exactly-once effects for external tools.

The recovery service replays a bounded session snapshot, restores native approval interactions,
delivers saved answers with stable Eve input keys, and settles recorded turns once. Stop is saved
before contacting the worker and retires the binding; missing owners and orphaned cross-engine
children are interrupted. History tools resolve a valid saved run after its in-memory entry is lost.

Tool-access grants, voxel ownership checks and the Station look setting now use native checkpoints
too. A read-only consent plan collects the outer gate and nested checks before execution; one
approval covers the listed checks. Each executor boundary reads the saved decision without
starting another promise-based approval wait. Consent records bind ownership checks to the
world, object/prefab or skin target and original arguments. Replacing a named object or editing
the call toward another target cannot reuse its consent. A combined approval's Always allow
choice does not silently grant every nested capability permanently. Setting changes still go
directly to the user, including at Full autonomy. Other engines keep their existing approval flow.

The integration fixture now restarts the actual Bun worker while waiting for a file approval,
tool-access grant, ownership approval, look setting or Outbox answer. It resumes the original
operation and proves that stopped work cannot write its file. The six scenarios use thirteen
fake model requests, including no second request for stopped work. Unit
tests cover duplicate execution, unknown outcomes, lost approval receipts, expiry, edited consent,
withdrawal and interrupted Brain review. All state stays in throwaway project/home directories.

Remaining integration belongs with engine cutover: native completion ownership and shutdown in the
ordinary run path, retirement when clearing/deleting/changing engines or runtime generations, and
native children under ended parents.
The existing API engine remains active until these paths and compaction removal are connected.

## Goal and scope

Replace Athena's handwritten API agent harness with [Vercel Eve](https://github.com/vercel/eve).
Eve should own the model/tool loop, active conversation context and durable execution. Athena should
own projects, agent definitions, permissions, tools, the saved conversation and the user interface.

This replaces `server/engines/openai.ts`, rather than adding a second permanent API engine. The
Claude Code, Codex, Hermes, pi, oh-my-pi and OpenClaw engines remain. "Default built-in agent" here
means the built-in API runtime; changing the factory setting for new agents is a separate decision.

Do not preserve `openai` engine IDs, `chat.llm`, old compaction settings or old API sessions just to
make existing development data work. Use an `eve` engine ID and a plain "API models" label in the UI.
Do not carry two harnesses, dual-write model histories, add legacy readers or run a migration service.
An implementation may use isolated test fixtures during development; the final cutover removes the old path.

The [Chat SDK Gateways plan](CHAT_GATEWAYS_2026-11-01.md) is independent. Gateways call Athena's
conversation services, which can select Eve or any CLI engine. Eve's own messaging channels are not
a second implementation of Gateways.

## Starting implementation (before the cutover)

| Area                    | Current ownership and relevant files                                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| API calls and tool loop | `server/engines/openai.ts`: raw Chat Completions streaming, provider configuration, tool routing, image handling, retries, limits and compaction calls |
| Run lifecycle           | `server/engines/index.ts`: project binding, session seeding, events, stop/steer, queues, run completion and transcript saving                          |
| Active model history    | `Chat.llm` in `shared/types.ts`, rebuilt from `Chat.items` when needed                                                                                 |
| Context and compaction  | `server/compaction.ts`, `shared/compaction.ts`, manual routes in `server/index.ts`, `/compact`, `web/compactmark.ts`, chat rendering and Settings      |
| Teams                   | `server/teams.ts`, `server/teamcontext.ts`: full shared-message imports, stable source IDs and per-member sessions                                     |
| Memory and recall       | `server/memory.ts`, `server/knowledge.ts`, `server/conversations.ts`, history tools in `server/tools.ts`                                               |
| Brain                   | `server/brain.ts` has separate short inference paths; `server/overseer.ts` owns Brain chat and orchestration                                           |
| Desktop                 | `scripts/build-desktop.ts` bundles the server for Bun; Tauri starts it with bundled Bun                                                                |

The current API loop already contains substantial product behavior. Replacing its file is only one
part of the change. Callers also infer capability from `engine === 'openai'`; replace those branches
with explicit engine capabilities instead of changing the string and keeping the assumptions.

## Upstream facts and constraints

These are upstream capabilities checked on the plan date, rather than claims that our integration
already supports them. Pin the exact Eve and provider versions after the packaging proof.

- Eve's default harness owns model calls, tool execution and automatic compaction. Its compaction
  summarizes older context and retains recent context; this is a suitable replacement for our API
  compaction algorithm. [Default harness](https://eve.dev/docs/concepts/default-harness)
- Dynamic definitions resolve tools, instructions and models from session context. Use that to serve
  Athena's editable agents through one authored root, rather than compiling one app per agent.
  [Dynamic capabilities](https://eve.dev/docs/guides/dynamic-capabilities)
- Self-hosting produces a Nitro Node server and uses a Workflow world for state. The local world
  writes to disk. Eve documents Node.js 24+; the runtime proof additionally verifies its native
  Nitro Bun build and execution under Bun 1.4.4.
  [Getting started](https://eve.dev/docs/getting-started),
  [self-hosting](https://eve.dev/docs/guides/deployment/self-hosting)
- Direct AI SDK provider models and OpenAI-compatible local endpoints are supported. A model ID
  string selects Vercel AI Gateway, so do not accidentally move users' providers to that service.
  [Agent configuration](https://eve.dev/docs/agent-config)
- Optional default tools can be disabled. Catalog tools can still appear for reachable capabilities;
  disabling defaults alone is not a permission boundary.
  [Built-in tools](https://eve.dev/docs/concepts/built-in-tools)
- Recovery is checkpoint based, not exactly-once execution of external effects. Self-hosted sessions
  can become stranded after an Eve version change. Both need explicit application handling.
  [Execution and recovery](https://eve.dev/docs/concepts/execution-model-and-durability)

## Proposed architecture

```text
Browser / Gateway / team / routine
                  |
        Athena conversation service
        saved originals + run identity
                  |
          engines/eve.ts adapter
                  |
       private local Eve runtime
       workflow + model context
                  |
       authenticated tool bridge
                  |
  Athena tools / MCP / approval policy
```

### Runtime and desktop packaging

Use the verified Bun runtime: one supervised private Bun sidecar, one prebuilt Eve app and one
local Workflow world. Athena's Bun HTTP server remains the dashboard host. The runtime proof
builds with Nitro's Bun preset and runs under Bun 1.4.4. Keep the process boundary; Eve is not
a `run()` helper placed inside our existing dashboard bundle.

Package the Eve build output and reuse the existing bundled Bun. Change `scripts/build-desktop.ts`,
the Bun server's child-process lifecycle, desktop smoke checks and CI together. Tauri continues
to supervise the dashboard server. Include all runtime-discovered files and dependencies. No development checkout,
globally installed Node, `npx` download, Docker installation or writable application directory may
be needed on the installed user's machine.

Bind the sidecar to loopback on a free port. Authenticate its application-facing routes with a
per-installation or per-launch secret and keep its credentials out of browser state. Verify how
Workflow callbacks authenticate without breaking recovery. Athena retains its Host, `x-dash`,
`Sec-Fetch-Site` and internal-token checks; do not publicly proxy Eve or the dashboard.

All mutable Eve state must live below `DATA`, in a private runtime directory configured through
supported upstream options. Resolve the default `.eve/.workflow-data` location during the proof;
launching from a writable directory is insufficient if build/source discovery changes its meaning.
Extend the store/path layer for runtime metadata. Eve owns its Workflow files; Athena must not
rewrite their internal format. Document this exception to the current "plain JSON state" description.

### One authored root, many Athena agents

Add a small build-time Eve application, proposed under `runtime/eve/`, with dynamic model,
instruction and tool definitions. Add `server/engines/eve.ts` and a runtime supervisor under
`server/eve/`. Names are proposed, not existing APIs.

Persist an immutable session binding containing project ID, agent ID, chat ID, engine generation
and applicable team ID. Resolve it from an opaque authenticated handle; neither model input nor
gateway metadata may select an arbitrary project. Resolve mutable agent configuration at documented
turn boundaries and record the configuration version used by each turn.

Configure OpenRouter, Ollama, LM Studio and custom endpoints through direct provider objects.
Extract model discovery/status from `openai.ts` into a provider module before deleting it. Preserve
custom URLs, model selection, effort, temperature and tool-capability reporting where supported;
report unsupported options explicitly. Establish model window metadata, including local overrides.

Use current Athena prompt assembly for skills, knowledge, `MEMORY.md`, workspace, team context and
rich answers. Refresh changed standing instructions without appending repeated system material to
ordinary history. Do not adopt a second memory database, scheduler or team implementation just
because Eve includes one.

### Tools, permissions and approvals

Expose Athena's selected tool definitions as dynamic Eve tools. Every execution returns to Athena's
existing built-in/MCP routing and risk checks. Disable unneeded Eve defaults, native delegation,
file/shell tools, external connections and self-modification. Inspect the complete effective catalog
in tests so deferred lookup cannot reveal tools outside the agent's permissions.

The bridge binds calls to the persisted project, agent, chat, turn and tool-call identity. Re-establish
`withProject()` on every resumed call. A missing in-memory `RunEntry` after restart cannot grant
access, change projects, or cause the run to lose its tools silently.

Refactor approvals into persisted requests keyed by operation identity, with durable decision lookup.
Map waits onto Eve's supported workflow-aware tool/approval mechanism. Do not hold an ordinary
Promise in `requestApproval()` and describe that as a durable approval. Retain Brain review,
"Needs you", edited arguments, deny/cancel and run ownership. There must be one approval decision,
not an Athena prompt followed by a second Eve prompt for the same action.

Record operation intent and outcome for side effects. Reuse IDs on retry and return recorded outcomes
where safe. A send or external command with an uncertain result becomes "Needs you" or a tool-specific
reconciliation, rather than an automatic repeat. Some tools cannot guarantee exactly-once effects.

### Sessions, transcript and run recovery

Athena's saved original messages remain the source for display, search, exports and project copies.
Eve's Workflow state owns active model context. Store its session handle separately from transcript
items; remove `Chat.llm` and the old API session reconstruction path.

Translate Eve events into Athena events with stable source event IDs and a persisted cursor. Save
before broadcasting, deduplicate reconnects, and reconstruct a partial response/tool call after a
crash. Terminal events settle an Athena run once, including costs and completion callbacks.

Add a persisted run ledger and startup reconciliation. Rehydrate or reconcile project bindings,
busy state, pending approvals, team read marks, child-work handles, queues and completion monitoring.
Eve recovery alone does not restore Athena's in-memory teams, promises, `active` map or goal tracking.
Never let both Athena and Eve independently restart the same turn.

Map stop, steer, queue, resume and run end deliberately. Explicit Stop must remain stopped after
restart. Transport disconnect is not Stop. Queue processing must not race a recovered turn. If a
cross-engine delegated child cannot resume, mark it interrupted and resolve its parent's wait with
an honest outcome instead of pretending the whole team is durable.

### Attachments and artifacts

Keep uploads in Athena's project upload area. Preserve image input and images returned by tools,
as well as text/file references. Agent-produced files continue to appear as artifacts.

Eve's default file-attachment behavior can require a sandbox; without one it may supply only a text
note. The proof must exercise a real image and a document. Use supported model message inputs and
Athena file tools where sufficient, or implement a restricted attachment sandbox adapter. Do not
silently downgrade image understanding or require Docker as an accidental desktop dependency.
Do not mount the user's home or arbitrary allowed folders into a default Eve sandbox.

### Copies, clear/delete and updates

Project clones and imports create fresh runtime identities from retained transcripts; never reuse
live session IDs, pending approvals or operation ledgers. Backups remain portable project data,
without credentials or opaque live Workflow snapshots. Clear/Delete must remove the associated
searchable transcript and retire runtime state according to an explicit retention policy.

Pin Eve exactly. For an Eve version update, stop new work, settle or mark interrupted operations,
then retire incompatible sessions and start fresh when next used. Reimport supported transcript
context with an admission check. In-flight actions and approvals are not reconstructed from prose.
No historical-version compatibility layer is required. Notify the user when an update interrupts work.

## Compaction and feature decisions

Remove our custom compaction system as a product feature, rather than running it before or after Eve.
Each engine owns active-context management. Preserve original conversations independently.

| Existing behavior                                                     | Planned outcome                                                                          |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| API instant/summary compaction, history trimming and overflow retries | Delete; Eve owns these concerns                                                          |
| Global Chat memory switches, keep-message count and threshold         | Remove; expose only supported engine-specific controls if needed later                   |
| Dashboard compaction fallback for CLI engines                         | Remove; native CLI context handling remains; unsupported/oversized seeds fail explicitly |
| Editable compaction checkpoints                                       | Remove across engines; do not promise editing Eve's private summary                      |
| `/compact instant` and `/compact summary`                             | Remove; optional `/compact` only when the engine has a supported native operation        |
| Compaction timeline marker                                            | Keep as a read-only engine event when available; no fabricated editable summary          |
| Memory/context meter                                                  | Show engine-reported values or a labeled estimate; unknown is allowed                    |
| `recall_history`                                                      | Remove in favor of the existing original-message search/read tools                       |
| `search_conversations`, `read_conversation`                           | Keep with existing own/team/project access boundaries                                    |
| `MEMORY.md`, knowledge and skills                                     | Keep as standing context; these are not compaction                                       |
| Full team transcript and source IDs                                   | Keep; compaction cannot advance a read mark or discard an undelivered source             |
| Model switch / missing native session                                 | Create a fresh session from admitted original context; no silent clipping                |

Extract shared token estimation, model window metadata and admission checks into `server/context.ts`
and any DOM-free shared formatting into a small shared module. Delete `server/compaction.ts` and
`shared/compaction.ts` after replacing their non-compaction consumers. Search every consumer before
deletion, including Brain utilities and CLI seeds, rather than merely removing the API import.

Reject an addressed request that cannot fit its model's usable context before handing it to Eve.
Budget standing instructions, tools, attachments and output space too. Eve documents shortening an
oversized current message during compaction; Athena's full-task guarantee must not depend on that.
Large new team seeds need explicit native capacity handling or a clear "use a larger model / start
a smaller request" error. The originals stay available through search/read. No new instant-summary
algorithm is introduced as a fallback.

## Other affected features

- **Brain helpers:** `brain.think()` is a separate short-call path. Extract shared provider plumbing
  for it; do not accidentally turn JSON drafting, routing or approval review into long-lived agents.
  Brain chat orchestration remains Athena-owned. Evaluate its API path explicitly during integration.
- **Teams and tasks:** keep Athena's ownership, source IDs, dependency rules, cross-team delegation
  and completion monitoring. Do not enable Eve subagents alongside the same `ask_agent` workflow.
- **Limits and usage:** map step budgets, costs, cached tokens and context where supported. Count
  compaction calls and recovered attempts; unknown provider cost is unknown, not zero. A cost limit
  is checked at available boundaries and cannot undo an already charged call.
- **Prompt caching and rich output:** port only supported provider options, then verify structured
  rich answers and tool images still reach both the UI and model. Remove obsolete compatibility retries.
- **Settings and docs:** rename the internal engine/status types, simplify model and memory controls,
  update README, `docs/guide.md`, desktop docs and AGENTS ownership notes. Remove the instant
  compaction attribution if its implementation is fully removed; respect license notices that remain.

## Implementation sequence

1. **Prove the runtime before the rewrite.** Build a pinned minimal Eve app with dynamic model,
   prompt and Athena tool bridge. Run on Windows and Linux; stage the verified Bun sidecar in a
   desktop build. Exercise a local compatible model, a remote model, an image and a document.
   Prove authenticated loopback callbacks, writable runtime storage and no Docker requirement.
   Deliver a packaging decision and measured startup/package cost. If the supported packaging path
   cannot meet desktop requirements, record the blocker rather than assuming a different runtime will work.
2. **Define the ownership boundary.** Add session bindings, run ledger, provider extraction, engine
   capabilities and the single dynamic root. Implement transcript event projection and tool routing.
3. **Make waits and recovery real.** Persist approvals and operation outcomes, implement startup
   reconciliation, and settle interrupted team/child work. Verify Stop/queue/steer through restart.
4. **Replace API execution.** Register `eve`, route API agents through it, support model options,
   tools, MCP, attachment inputs and usage. Delete `openai.ts` once its discovery utilities have moved.
5. **Remove custom compaction and simplify features.** Apply the table above across server, shared
   types, routes, commands, settings and chat presentation. Rewrite tests around the new ownership.
6. **Complete integration and cutover.** Verify teams, Brain API paths, goals, routines, copies,
   exports, delete/clear and update recovery. Update docs and remove development fallback flags and fixtures.

## Verification and completion criteria

Use fake model endpoints and a controllable sidecar for deterministic integration tests. Include:

- Tool execution with changed permissions, MCP account selection and deferred-tool catalog inspection.
- Crash before/after tool publication, after an external effect and during approval; no blind duplicate send.
- A project switch during execution and restart; every write and tool stays in the original project.
- An explicit Stop followed by restart; no resumed turn. Reconnect projects one visible response and one terminal outcome.
- Long-team import tails, duplicate source delivery, late joiners, failed runs and read marks after recovery.
- Forced Eve compaction followed by search/read of a saved original; oversized addressed input fails without truncation.
- Model/provider switch, runtime-version change, project clone/import, clear/delete and portable backup restore.
- Local and remote model inputs, vision and tool images, unknown costs, budget boundaries and rich responses.
- CLI regressions after removing dashboard compaction, including missing sessions and large seed rejection.

Run `bun run check`, `bun run build`, desktop staging and desktop smoke on Windows and Linux CI;
run the Rust checks required by desktop CI. The smoke test must use staged files and bundled runtimes,
with application files read-only and user state redirected to a throwaway directory.

Done means there is one built-in API harness, no custom dashboard compaction pipeline, honest native
engine capabilities, functioning desktop packaging, and tested recovery across Athena and Eve together.
Writing this plan does not change or delete current user data.
