# Chat SDK Gateways with files

*Plan, 1 November 2026. Experimental Telegram conversations added 2 November;
Experimental Slack text/file delivery added 3 November. Product setup remains incomplete.
New gateway data does not need a legacy compatibility layer.*

## Implementation status

- Added browser-safe instance and route types, global instance storage, separate server-only
  credential storage and Brain/team/agent validation in the configured project.
- Added account ownership checks, sender-guard and file-limit configuration validation, per-instance
  pause/delete, route generations and project-pinned execution helpers. Changed routes block stale
  queued work for review; they never redirect it. Deleted projects or targets pause the instance
  when its route is checked.
- Pinned `chat` and the four official adapters to `4.43.0`. Added a local SDK state adapter for
  subscriptions, cache/dedupe, lists, token-checked expiring locks and FIFO queues. Mutations use
  atomic JSON writes under `DATA/gateways-runtime/<instanceId>`, with one kernel-held ownership
  claim per resolved instance directory. A competing writer or ownership-port collision fails
  closed; process death releases the claim. State corruption blocks reconnect instead of resetting
  it. Queue overflow fails for retry instead of silently dropping a message. This SDK queue is not
  the application inbox or its execution/recovery ledger.
- `bun run gateways:smoke` uses a fake local Telegram API and throwaway data/home folders. It proves
  SDK polling, required sender filtering, an attachment-only input, private file download, a file
  reply and subscription persistence, with webhook deletion explicitly disabled. The same fixture
  passes under Bun and Node; tests exercise both runtimes, state isolation, expiry, competing claims
  and recovery after killing a writer. A bundled proof also runs from read-only files outside the
  repository. All four adapters import and construct in the fixture;
  live Slack/Discord connections and WhatsApp signatures/media remain unproven.
- Added a separate durable application inbox. A single atomic write saves each accepted message,
  its sender, conversation binding, explicit route and ordered receipt. Replays deduplicate across
  restarts and route changes. Each conversation waits for earlier unresolved input; unrelated
  conversations can progress. An operation ID is saved before work is claimed; interrupted claims
  require review instead of starting a second run. Edits are separate review items and hold any
  unstarted original. File input stays in `waiting-files` until every attachment is saved and checked.
- Added supervised Telegram polling on server startup for enabled instances, account-level ownership
  claims, retry/backoff, redacted health events and pause/delete/reconnect lifecycle. Configuration
  changes restart the relevant instance. Startup checks the token's bot ID and refuses an existing
  webhook without deleting it. Sender/scope checks and durable inbox writes happen before returning
  a fetched batch to the SDK; denied bodies never enter SDK pending state, and storage failure does
  not advance the polling offset. Exact topic scopes use `chatId/topicId`; new shared conversations
  require a bot mention or reply. No attachment is downloaded during intake.
- Added guarded local APIs for instance configuration, credential replacement/presence, connection
  health, reconnect, inbox receipts, explicit file/reply retry and deletion under `/api/gateways`;
  the existing
  Outbox helpers remain unchanged. Discord and WhatsApp fail closed at application intake and report
  unavailable when enabled. WhatsApp configuration currently accepts canonical E.164 only;
  local-number parsing and verified business identity mapping remain to implement.
- Added a streamed incoming-file stage. Telegram metadata and response headers are checked before
  consuming a bounded body; redirects and unsafe provider paths are refused. Browser uploads and
  gateway streams share the same safe upload writer. Files go into a uniquely claimed batch in
  the bound project, with per-file results and content hashes saved in the inbox. Successful files
  survive partial failures; missing/changed files hold the whole message until explicit retry.
  Owned-batch recovery removes unrecorded final files and partial downloads after a crash.
- File/message/daily budgets are reserved durably before each transfer. Successful attempts release
  unused allowance; failed or interrupted attempts conservatively keep their reservation, including
  across retries and restarts. File counts and known total sizes are checked before any download.
  File work stops and saves its receipt before SDK shutdown releases instance ownership. Albums
  save their individual files but remain review items until grouping is implemented.
- Added stable private conversation identities and a guarded gateway resolver for claimed input.
  Brain histories, Stop/Clear state and snapshots are scoped per binding. Agent chats and team
  member sessions carry the same scope; conversation search/read tools refuse other scopes.
  Private team runtime IDs reuse the existing turn, queue and recovery services, with current
  membership and access resolved from the configured team. They do not appear as extra configured
  teams or get scheduled, and automatic cross-team relays are disabled for these private threads.
  Brain delegation stays in its private scope. Native Eve membership checks, task ownership and
  user questions recognize the private team identities. Sender labels survive team input recovery.
- These conversations use the selected project's files and target settings. Private Brain snapshots
  omit other conversations' team messages, active turns, activity, briefs, approvals and pending posts.
  Target deletion and unreadable private records fail closed. A global project switch does not move
  a private Brain answer or cancel its work; the dispatcher must supply its access/route recheck.
- Enabled Telegram workers now dispatch accepted input through the normal Brain, agent or team
  services. Admission saves the private conversation and operation ID before starting work. Native
  run/message IDs and scoped Brain operation markers reconcile restarts without repeating model
  actions. Missing or interrupted execution evidence requires review. Completion waits for active
  descendants and the normal completion brief; blocked work and changed brief revisions are held.
  Normal tool permissions and approvals still apply. Pausing transport does not implicitly cancel
  a native run, and changed sender access or routes block its eventual outward answer.
- Final text is saved atomically with an ordered delivery ledger before network I/O. Unicode-safe
  parts retain exact plain text and reply to the originating Telegram message/topic. Confirmed parts
  survive restarts; provider rate limits persist their retry time. Lost confirmations and interrupted
  sends become uncertain and need an explicit retry after checking Telegram. Source edits hold
  queued/running work and unsent answer parts. Local fixtures cover admission through reply delivery;
  live account checks remain outstanding.
- Added bounded text notices: after five seconds, a running operation can send one "Working on it
  in Athena" message. A visible approval for a live run in the same project and private binding
  can send one "Needs approval in Athena" notice instead. Approval titles, arguments, reasons and
  local URLs are never included. Approval notices are checked again before sending; finished work,
  revoked access and superseded working notices are dropped. Notices share the serialized sender,
  per-send timeout, rate-limit waits and uncertain-delivery recovery, but never block a final answer
  or a later assignment. No remote approval controls are added.
- Added explicitly selected document replies through the guarded local API:
  `POST /api/gateways/:id/inbox/:eventId/files` takes `{ paths: [...] }`. One immutable selection belongs
  to the current assignment; identical requests preserve its receipts. Only the target's current
  workspace folders and safe uploads are eligible. Private data/runtime stores, common credential
  files, unrelated project folders, directories, hard links and oversized files are refused.
  Bounded descriptor reads save a size and content hash; send-time checks re-resolve access and
  paths and upload only the verified bytes. A changed file requires a new explicit selection in a
  new assignment rather than silently changing the authorized attachment.
- Each document gets its own receipt and reserved outgoing bytes before I/O. Incoming and outgoing
  budgets are tracked separately against the configured limits; failed/interrupted outgoing attempts
  retain their reservation. Text finishes first, then files send one at a time through the same sender.
  Confirmed files survive retries, provider waits persist, and interrupted/ambiguous sends require
  an explicit decision. Per-file `POST .../files/:index/retry` and `.../skip` control the remaining work;
  skipping an uncertain file does not undo a possible remote delivery. Unresolved files hold later
  work in the same binding. Source edits hold pending uploads. Worker shutdown saves upload outcomes
  before releasing state ownership. Local multipart fixtures prove byte uploads and original-message
  routing; live-account validation is still pending.
- Current outgoing capabilities at SDK/adapters `4.43.0`:

  | Platform | Files | Limit | Captions and grouping |
  | --- | --- | --- | --- |
  | Telegram | Nonempty regular files as documents, including images/audio/video | At most 20 MiB per file, 10 files and 50 MiB per assignment; configured limits can be lower | No file captions, native media or albums. One SDK transport request and remote receipt per file, with a 30-second send timeout |
  | Slack | Hosted local uploads and explicitly selected regular output files | At most 20 MiB per file, 10 files and 50 MiB per assignment; configured limits can be lower | Bounded private streaming downloads; one external-upload allocation, byte upload and completion per file, without SDK retry/fallback |
  | Discord | Private message attachments and selected regular output files, local proof only | At most 20 MiB per file, 10 files and 50 MiB per assignment; configured limits can be lower | Refreshed source-message CDN URLs and one multipart request per selected file; application workers remain disabled |
  | WhatsApp | Not enabled in application transport | Pending live verification | Pending |

  The application uses the SDK's Telegram multipart transport primitive directly for documents,
  avoiding formatter fallback, grouped sends and hidden retries that would obscure per-file outcomes.
  Ordinary artifacts and tool images are never attached automatically.
- Added `prepare_gateway_files` and high-risk `send_gateway_files` tools for explicit run deliverables.
  Inspection returns eligible paths, sizes and SHA-256 hashes without selecting or sending files.
  The send request carries those hashes through the existing autonomy/approval policy, rechecks
  the bytes after approval and saves one immutable selection. Changed files require fresh inspection
  and approval. The destination comes only from the live run's private conversation and project;
  callers cannot supply an instance, event or recipient. A matching running execution receipt and
  live worker ownership are required, and reconnect/shutdown revokes the old handoff.
  Deliverables carry a server-created source run, agent, chat and resolved workspace. This allows
  Brain delegates to hand in files from custom workspaces without adding every agent folder to a
  gateway's allowed roots. Inspection and delivery require a matching native execution receipt in
  the bound project, the private chat's matching binding, and unchanged current workspace access.
  Team-member files also require current membership. Failed/cancelled or missing/pruned execution
  receipts, deleted chats/agents and changed workspaces hold delivery for review. Ordinary local API
  selection retains its target-folder limits and cannot supply source records. Tool callers can supply
  only paths and hashes; source records never come from model arguments. Tests cover restart after
  completion, custom Brain-delegate folders, cross-binding reuse, missing/failed run evidence and
  revoked workspace access. The result confirms selection only; the normal final-answer and per-file
  delivery ledger still control upload. Remote messages cannot approve these tool requests.
- Added Settings > Gateways with multiple instance rows, connection health, pause/enable,
  reconnect and confirmed deletion. Telegram forms cover account ID, token replacement/removal,
  project, Brain/team/agent destination, required sender IDs, direct messages, exact group/topic
  scopes and file limits. Saves leave instances paused; enabling is a separate explicit action.
  Tokens use the separate credential endpoint and are never loaded into the form. Partial saves
  retain the new instance ID so retrying credential storage cannot create a duplicate account.
  Live health refreshes preserve form drafts. Destination lookup lists only names/IDs in the chosen
  project without changing the open project. Settings search finds gateways, and
  `#/settings?tab=gateways&instance=<id>` opens the named Telegram or Slack editor. Discord and WhatsApp are marked
  unavailable; old one-way forms remain under Connections until unified delivery is ready.
  DOM tests cover creation, separate secrets, partial saves, project/team choice, deep links and
  loading errors. Browser screenshot verification was unavailable in this development session.
- Added a per-instance inbox under Settings > Gateways, including
  `#/settings?tab=gateways&inbox=<id>` links. The default filter shows messages needing review;
  All messages shows queued, active and completed work, newest first in batches of 25. Expand a
  message to inspect its actor/chat/topic, original input, saved project/target, incoming files,
  chosen final reply, text-part outcomes and outgoing file outcomes. Untrusted message text is
  rendered literally; internal reasoning/tool logs are not drawn. Long text scrolls with keyboard focus.
- Inbox actions use the existing guarded APIs for failed-download retry, remaining-reply retry,
  outgoing file retry/skip and explicit file selection by absolute paths. Confirmed parts and files
  have no retry action. Uncertain retries require checking Telegram and confirming duplicate risk;
  skipping a file also requires confirmation and never claims to undo remote delivery. Paused or
  unavailable instances cannot retry deliveries. Paused instances can still inspect and clean eligible
  receipts. A closed inbox cannot apply a stale confirmation.
  File selection preserves drafts on errors and is offered only for the current eligible assignment.
  Live receipt updates preserve open rows and drafts. Tests cover actions, confirmation/cancellation,
  disabled controls, rendering bounds, deep links and missing instances. Native `needs-review` work
  remains held unless its original saved operation can be verified; no model replay or override of
  unproven work is provided.
- Added **Check saved work** for held messages with a dispatch receipt. The guarded
  `POST /api/gateways/:id/inbox/:eventId/reconcile` checks the original operation only: it never calls
  admission, Brain ask, agent start or team post. Verified pending work resumes completion tracking
  under the same operation ID; a verified completed answer and its pending text parts are saved in
  one atomic journal write. Missing/error evidence stays held with the latest check state/time.
  Existing reply receipts cannot be replaced or reconciled a second time. The native completion
  check requires exact run/message/Brain operation identities and unchanged completion revisions;
  team recovery additionally requires a nonempty completion summary tied to that original message.
  This stricter check remains in use after tracking resumes, so a later unrelated team reply cannot
  become the recovered outward answer. Source edits, ungrouped albums, revoked sender access and changed routes
  are rejected again before committing. The UI explains that a completed reply may be delivered,
  disables the check while paused, and shows the saved outcome. Tests cover restart, no resubmission,
  native Brain/team evidence, stale edits/access/routes, duplicate checks, error redaction and request guards.
- Added gateway status navigation to the sidebar's Status panel. It shows up to five instances,
  prioritizing held work, failed deliveries and connection problems, with an All gateways link for
  larger lists. Review/healthy links open the relevant instance inbox; Telegram setup/reconnect
  problems open that instance's editor. Paused instances with held work still link to their receipts.
  Tooltips identify the platform and bound project, and a setup link appears when no instance exists.
  The app state contains only instance identity, project label, connection state and review count;
  credentials, sender rules and message contents are excluded. Review counts share the inbox's
  attention rules and are cached until receipt/health/configuration changes, then read once per state
  refresh. Unreadable journals report an unknown count without being reset; missing projects report
  setup needed. Gateway events refresh sidebar state. Tests cover summary privacy, dirty-count refresh,
  corrupt journals, deleted projects, link destinations, ordering and the sidebar row limit.
- Added manual completed-receipt cleanup to the inbox, with received-before choices of 7, 30 or
  90 days and All completed receipts. The UI previews an exact selection and requires confirmation;
  `POST /api/gateways/:id/inbox/cleanup` revalidates its IDs and cutoff under the exclusive instance
  claim. Active/unresolved conversations and edited sources keep their completed context. Pending,
  sending, failed or uncertain final deliveries are never removed. In-flight advisory notices also
  protect their conversation; finished advisory failures do not block cleanup after final delivery.
- One atomic journal write removes eligible receipt bodies and saves compact message-ID hashes plus
  per-day incoming/outgoing byte totals, including failed attempts and skipped uploads. Replayed
  messages and edits of removed originals cannot start work, even after restart or rebinding. Neither
  sequence numbers nor private conversation bindings are reset. Native chats and project files stay;
  this is inbox cleanup, not whole-conversation erasure. Paused instances acquire storage ownership
  without starting a transport. Stale selections fail as a whole, and corrupt replay/quota records fail
  closed in both processing and diagnostics. Replay markers are retained without expiry, capped at
  100,000 per instance; reaching that cap refuses further cleanup instead of forgetting protection.
  Compact quota-day records also remain (at most 100,000); cleanup cannot refund a daily budget or
  exploit a clock rollback. There is no automatic purge or reset of these safety records. Tests cover
  full-inbox capacity, replay/restart/retargeting, shared-thread bindings, quota preservation, uploaded
  file preservation, unresolved context, corruption, ownership, selection age and confirmation.
- Added explicit Telegram album grouping in the inbox. Files remain held until all currently saved
  parts are reviewed and **Group album and start** is confirmed. Telegram provides no reliable end
  marker, so there is no quiet-period auto-dispatch. The guarded grouping request names the exact
  source receipts; a changed selection, missing file, edited source, mixed actor/route or revoked
  access refuses the whole action. File counts and byte reservations apply across all parts,
  including failed downloads. Each source retains its original ID, caption, file batch and hash.
- One durable leader starts one native operation with all verified attachments and source captions;
  followers point to its work and delivery receipts and cannot start their own operation. Every
  member's file is verified in its own original batch before admission. Current journal state is
  checked again after asynchronous file verification and by the Brain's admission callback. Late
  parts and edits of any member hold unfinished work and pending deliveries, preserving confirmed
  sends. A rate-limited in-flight delivery cannot silently return to automatic retry after a source
  change. Grouped work can reconcile only its original operation with unchanged source receipts.
- Cleanup removes a delivered album only as a whole. In addition to message replay hashes and byte
  totals, it retains an opaque album-family hash (up to 100,000) so late parts after cleanup or restart
  stay held instead of forming a second assignment. Reaching this cap refuses cleanup. Tests cover
  one-operation dispatch, complete captions/attachments, source integrity, stale selections, actor/
  route/access changes, late parts, edits, restart/reconciliation, aggregate limits, cleanup and UI
  confirmation/paused controls. Real-account album checks remain outstanding.
- Added the first Slack intake slice using the pinned Chat SDK adapter and an explicitly pinned
  `@slack/socket-mode` 2.0.7 client. The SDK's default socket handler acknowledges before background
  processing, so Athena owns the ordered receive/ack boundary. Accepted messages are normalized and
  atomically committed before acknowledgement; failed local writes or identity API calls remain
  unacknowledged for Slack redelivery. Source-message timestamps stay strings, deduplicating message/
  mention deliveries across event IDs. The in-memory queue holds at most 32 unacknowledged events;
  overflow is left for redelivery. Shutdown blocks admission/ack and waits for active checks before
  state ownership can be released. API calls have bounded timeouts and no automatic retries; socket
  reconnect belongs to the future supervisor integration. Raw SDK logs and provider details are muted.
- Slack startup checks `auth.test` against the configured workspace and verifies bot/user/app identity
  with `bots.info` before opening Socket Mode with the separate app token. Only one workspace
  installation is supported; org-wide installs, foreign app/workspace envelopes, external/shared
  channels, group DMs, bot/self actors and unsupported controls are refused. Every permitted input
  also checks `users.info` for a live local human and `conversations.info` for the exact DM peer or
  local channel membership. An empty user allowlist adds no person-specific restriction; configured
  DM/channel/thread scope still applies. Exact user and scope rules are rechecked before journaling
  and queued execution. Channel roots need an explicit bot mention; later replies stay in that
  subscribed thread. Edits hold their original work; preview-only updates with unchanged text/files
  do not create assignments or interrupt it. File receipts retain only bounded IDs/metadata, without
  private URLs, SDK callbacks or downloads. See Slack's [Socket Mode acknowledgement contract](https://docs.slack.dev/apis/events-api/using-socket-mode/)
  and [Slack Connect identity guidance](https://docs.slack.dev/apis/slack-connect/).
- `bun run gateways:slack-smoke` exercises the real SDK against a local HTTP/WebSocket fixture with
  throwaway data/home folders. Bun, Node and a read-only bundled proof outside the checkout pass.
  Tests cover separate tokens, failed commits and replay, optional sender guards, exact scopes,
  actor/channel verification, edits, stale access/routes, queue limits, arrival order and shutdown.
  This proof is extended below to cover file transfer, reply delivery and supervised lifecycle; no
  dashboard callback routes or public endpoints were added.
- Enabled experimental Slack workers alongside Telegram through one shared supervised lifecycle.
  Workspace ownership, pause/reconnect/delete, file reservations, native Brain/team/agent dispatch,
  completion tracking, approvals, selected/delegated files and durable per-part outcomes use the
  existing application ledger. Slack closes its socket on failure; the supervisor reconnects with
  backoff without resubmitting recorded native work. Every new Slack message root, including a DM,
  binds its own thread; replies continue that thread's private Athena conversation. Edits recover the
  original binding even when Slack omits channel/thread metadata.
- Added Slack private streaming downloads. The worker resolves only saved file IDs, verifies hosted
  mode, local owner identity and a share in the accepted conversation, checks size and headers, and
  refuses redirects and off-origin URLs. Only the fixed Slack file origin receives a bot-token header;
  private URLs never enter the journal. File counts, failed reservations, daily limits, hash checks,
  cancellation and download retries use the shared processor. Unsupported or inaccessible media
  holds the whole request rather than dispatching partial input.
- Slack final text and advisory notices use direct SDK Web API calls with zero automatic retries.
  Control characters are escaped, markup and automatic parsing/unfurls are disabled, and durable
  parts fit 3,000 encoded UTF-16 units including entity expansion. Up to 2,000 parts cover the existing
  million-character answer bound. Replies stay in the original thread. Truncation warnings and unknown
  outcomes are held, confirmed prefixes stay confirmed, and known rate limits persist a wait time.
  See [Slack text escaping](https://docs.slack.dev/messaging/formatting-message-text/).
- Selected Slack documents use verified bytes and three explicit steps: upload-URL allocation,
  bounded byte upload to the fixed Slack origin, then completion in the saved channel/thread. Access
  is rechecked before sharing; signed upload URLs are transient. A lost completion response stays
  uncertain for explicit review. SDK helper fan-out and hidden resend are not used. Tests cover
  byte/hash and destination checks, redirect/URL refusal, private downloads, upload ambiguity and
  plain long replies. The Bun/Node/read-only bundled proof now exercises this complete path locally.
- Settings can add multiple Slack workspaces with independent targets, optional user guards, exact
  channel/thread scopes and separate bot/app tokens. Blank credential fields keep saved values;
  guarded POST credential updates replace or remove just the named token without revealing the
  other one. Save pauses the instance, enable needs both tokens, and Inbox/status/deep links work
  for Slack. Setup explains bot scopes, event subscriptions and local-only restrictions. DOM and
  API tests cover token isolation, partial saves, enable controls and request guards. Browser visual
  verification is unavailable in this session; real-account and Windows/Linux checks remain pending.
- Added the first Discord intake foundation using the pinned Chat SDK adapter. Startup verifies
  `/users/@me` against the configured bot and checks the application/bot relationship and Message
  content capability. Only caller-supplied authenticated Gateway dispatches can enter this proof:
  inherited HTTP callback handling always returns 404, and the SDK's default Gateway listener is
  explicitly blocked. It is not wired into production workers or Settings yet.
- Discord receipts retain guild and actual channel IDs separately from a native thread's parent.
  Queued authorization requires an explicit guild plus channel/verified-parent scope; DM policy
  stays separate. The optional exact user-ID list permits local scoped humans when empty. REST
  checks verify one-to-one DM recipients or guild membership, native thread parent/guild and bot
  read/reply permissions. Permission calculation applies everyone, role and member overwrites in
  Discord order, including administrator and send-in-thread rules. Missing permission evidence,
  unjoined private threads, locked/archived threads, bot/system/webhook actors, forwarded snapshots,
  foreign guilds and unsupported message types are refused before admission. IDs stay unsigned
  64-bit strings; guild/parent metadata is checked against each persisted binding.
- Non-thread channel roots need a direct bot mention; unrelated channel messages cannot inherit
  a previous topic. Replies to saved source messages or confirmed bot deliveries keep the original
  topic, and native threads keep independent histories. Partial updates fetch a complete current
  message after finding its original receipt. Verified text/file changes hold that original work;
  unchanged metadata/unfurl updates do not start work. Attachments remain bounded ID/metadata
  descriptors without CDN URLs or downloads. API calls are bounded, redacted and never automatically
  retried. Intake is serialized with at most 32 queued events, snapshots caller-owned payloads and
  drains on cancellation; a failed check/write rejects rather than reporting a committed event.
- Added an explicit Discord WebSocket client with JSON/v10, fixed Discord Gateway hosts, bounded
  packets and a 32-event/8 MiB FIFO. The SDK's stock listener remains blocked. Private instance state
  stores the verified bot, intents, session ID, regional resume URL and last durably handled sequence;
  tokens never enter that file or instance APIs. READY is saved before connection success. Subsequent
  dispatches advance the cursor only after verified intake settles and its inbox write succeeds.
  Heartbeats use the latest received sequence as Discord requires; Resume uses only the saved cursor.
  Slow intake does not block heartbeat ACKs. Failed checks, storage errors, queue overflow or missing
  heartbeat ACKs cancel pending REST checks and drop the socket without a normal session-invalidating
  close. The owner must drain the client before releasing the instance claim.
- New sessions check `/gateway/bot` for a single-shard allowance and save Identify spacing before
  sending credentials. Reconnects use the saved regional URL/session/sequence without another
  Identify. Rate limits and resumable Invalid Session responses persist retry deadlines. Expired or
  invalid saved sessions retain an explicit recovery gap and do not silently start fresh; reviewing
  that gap and explicitly starting a replacement session still needs product controls. Fatal token,
  intent and shard errors report setup failure. Corrupted or foreign-account journals fail closed.
- `bun run gateways:discord-smoke` proves identities, scopes, permissions, message edits and a live
  local WebSocket Identify/Resume exchange under Bun, Node and a read-only bundled build outside
  the checkout. A failed inbox write leaves its cursor unchanged; replay saves the missing message
  without duplicating existing receipts. Unit tests also interrupt the interval between intake and
  checkpoint, fail checkpoint writes, exercise cancellation, ordering, Identify allowance, recovery
  gaps, heartbeat loss, backoff, payload bounds and untrusted hosts. No real Discord account,
  platform message or application Discord worker is enabled. See Discord's
  [Gateway lifecycle and resume contract](https://docs.discord.com/developers/events/gateway) and
  [close codes](https://docs.discord.com/developers/topics/opcodes-and-status-codes).
- Added Discord text and file delivery to the local transport proof. Replies are saved in at most
  2,000-character UTF-16-safe parts and sent with explicit source-message references, no allowed
  mentions and suppressed link previews. The transport requires a claimed ledger part, notice or
  selected file; sends use bounded direct API calls with no SDK retry or fallback. A per-attempt
  nonce identifies the request, and success checks the bot, channel, reference, nonce, exact returned
  text and file metadata. Known refusals are failed; 429 preserves its requested wait; timeouts,
  server errors and malformed/mismatched successes are uncertain and need explicit review.
- Delivery rechecks the saved route, optional sender guard, verified human, live DM recipient or
  guild/thread parent and bot read/send permissions. Documents also require Attach files. Live
  source-message reads detect missed edits before delivery and hold the old work. Removing all text
  and files still records an edit, and returning to earlier text records a separate transition. Partial updates
  block delivery while verification is pending; failed verification holds pending output rather than
  letting the cursor or delivery bypass it. An explicitly retried answer can still be delivered after
  a known, reviewed edit; another edit during asynchronous checks stops that attempt. Replies to
  confirmed advisory messages and document deliveries now resolve their saved topic too.
- Incoming Discord files use only attachment IDs saved in the receipt. The transport rereads the
  source message for a fresh signed URL, checks the exact CDN host/channel/attachment path, rejects
  redirects and bounds the stream against both saved size and reserved budget. The CDN gets no bot
  authorization header; its URL is never saved. Changed metadata or incomplete/oversized downloads
  hold the assignment and retain their quota charge. Selected output files pass the existing root,
  regular-file, size and hash checks and are uploaded as verified bytes in one multipart message,
  after final text. Unconfirmed uploads are never repeated automatically. See Discord's
  [message API](https://docs.discord.com/developers/resources/message),
  [attachment URL and upload reference](https://docs.discord.com/developers/reference) and
  [rate-limit handling](https://docs.discord.com/developers/topics/rate-limits).
- The Bun, Node and read-only bundle smoke proof now downloads a private attachment, splits and
  confirms a complete long reply, uploads a selected document and verifies duplicate wakes do not
  send it again. Unit tests cover unsafe CDN paths, missing permissions, changed sources and local
  bytes, inaccurate lengths, redirect refusal, source-check barriers and uncertain text/file outcomes.
  This remains local-fixture evidence: Discord workers and Settings are still disabled, and real
  Discord account/platform checks remain pending.
- Next: wire Discord's supervised workers and setup, including explicit recovery-gap review; implement
  WhatsApp after that. Native-work override controls and explicit webhook
  switching still need product setup. Deleted instances retain private inbox receipts for recovery;
  the full deletion flow for retired instances is pending. Real-account text/file checks on all four platforms
  and platform verification on Windows/Linux remain outstanding. Offline checks run in CI.

## Goal

Add **Gateways**: two-way conversations with Athena through Telegram, Discord, WhatsApp and Slack,
using [Vercel Chat SDK](https://github.com/vercel/chat). Each gateway platform supports multiple
independently configured instances. Each instance connects an account to an explicit Athena project
and exactly one Brain, team or agent target. People can send text and files from the
messaging app, and receive replies and selected output files in the same conversation.

Gateways are transport adapters, not agent runtimes. They use the same Athena conversation services
as the dashboard and work with every engine. The [Eve API engine plan](EVE_API_ENGINE_2026-11-01.md)
can ship separately. Do not also implement Eve-native channels for these four platforms.

Required sender policy from the product discussion:

| Platform | Sender guard |
|---|---|
| Telegram | Required allowlist of numeric user IDs |
| WhatsApp | Required allowlist of phone numbers, stored in canonical international form |
| Slack | Optional allowlist of user IDs; an empty list adds no user-specific restriction |
| Discord | Explicit guild/channel or DM scope; optional user-ID allowlist proposed for finer control |

Gateway instance setup is the user's authorization to send ordinary replies to accepted messages in its
configured conversation. It does not authorize arbitrary outbound posts, unrelated recipients or
unrequested file disclosure. Existing agent tool risk and approval rules continue to apply.

## What exists today

- `server/social.ts` sends Telegram text with a bot token and one chat ID, and Discord text to a
  webhook. These are outbound helpers used by the Outbox, not inbound chat gateways.
- `server/index.ts` invokes engines, Brain orchestration and team messages from browser routes.
  Factor these entry points into reusable services instead of making gateways call browser APIs.
- `server/uploads.ts` stores project uploads, cleans paths and validates attachment roots. Its
  request-body receiver needs a stream/bytes abstraction for platform downloads.
- `server/store.ts`, `shared/types.ts`, `server/approvals.ts`, `server/artifacts.ts` and chat events
  already provide most local storage, approval and UI building blocks.
- `web/views/setup.tsx` owns the Settings tabs, deep links and search index. Add a dedicated
  **Gateways** tab backed by a new `web/views/gateways.tsx`; create shared service/client modules
  where its settings and status require them. `web/views/connections.tsx` keeps social connections.

## Upstream facts

Use the official packages `chat`, `@chat-adapter/telegram`, `@chat-adapter/discord`,
`@chat-adapter/whatsapp` and `@chat-adapter/slack`. Pin versions after the transport proof and
update `bun.lock`. Next.js scaffolding, Vercel Connect and Vercel AI Gateway are not required by this
design. [Repository](https://github.com/vercel/chat), [adapter catalog](https://chat-sdk.dev/adapters)

| Adapter | Verified constraint and source |
|---|---|
| Telegram | Supports polling and webhooks; polling and a registered webhook are mutually exclusive. Its optional SDK user allowlist defaults to allowing everyone when omitted, so Athena must impose its required guard. [Telegram](https://chat-sdk.dev/adapters/official/telegram) |
| Discord | HTTP interactions do not deliver normal messages. Regular messages need a persistent Gateway WebSocket. [Discord](https://chat-sdk.dev/adapters/official/discord) |
| Slack | Socket Mode can receive events behind a firewall without a public HTTP endpoint. Bot and app tokens are distinct. [Slack](https://chat-sdk.dev/adapters/official/slack) |
| WhatsApp | Uses Meta WhatsApp Business Cloud, signed HTTP events, media upload and template restrictions outside the customer-service window. This is not a personal-account/WhatsApp Web bridge. [WhatsApp](https://chat-sdk.dev/adapters/official/whatsapp) |
| Files | Incoming attachments can supply lazy `fetchData()` and serializable `fetchMetadata`; outgoing generic uploads use `files`, while typed media can use `attachments`. [Files](https://chat-sdk.dev/docs/files) |
| State | SDK state covers subscriptions, locks and cache. Memory state is not restart-safe; custom state adapters are supported. Lock conflict defaults must not become dropped user messages. [State adapters](https://chat-sdk.dev/docs/state-adapters), [concurrency](https://chat-sdk.dev/docs/concurrency) |

Adapter APIs and platform restrictions change. During implementation, verify the exact installed
version's event, media and lifecycle support; do not derive feature parity from the shared interface.

## Transport architecture

```text
Telegram polling -----\
Slack Socket Mode -----+--> Chat SDK --> guards --> durable inbox --> Athena conversation service
Discord Gateway -------/                                      |               |
                                                             |         any engine / team
WhatsApp signed webhook --> small public relay                 |               |
                              ^                               +<-- reply/file delivery queue
                              |
                  local outbound authenticated connection
```

### Gateway instances

Telegram, Discord, WhatsApp and Slack are gateway platform types, not singleton connections. Users
can add multiple named instances of each type, such as two Telegram bots routed to different teams,
a Slack instance routed to the Brain and a Discord instance routed to one agent. Each instance owns
its account credentials, project, target (`Brain`, `Team` or `Agent`), scopes, sender policy, limits,
enabled state and health. Team and agent targets reference an explicit ID in the selected project.

Keep instance IDs stable and include them in secrets, worker ownership, SDK state, bindings, inbox
and delivery records, relay pairing and API/UI actions. Instances must not share conversation
history, authorization or operational state implicitly. Reject overlapping ownership of the same
external account/event stream where it would create duplicate consumers or ambiguous routing;
multiple instances do not permit multiple Telegram polling consumers for one bot. Changing an
instance's project or target creates a new route generation and local conversation; pending work
stays pinned to its original binding and cannot be redirected to the new target.

### Run locally where possible

Run Chat SDK and its adapters in a supervised local gateway worker, with explicit start/stop,
reconnect/backoff and health reporting. Prove Bun compatibility first. If a package requires Node,
use a packaged private worker; do not make installation of the Eve engine a dependency of Gateways.
Persist operational state below `DATA`, and ship worker files in desktop builds.

- Telegram: explicit polling mode, one consumer per bot. Register no public webhook. Do not silently
  delete an existing webhook during connection; detect it and offer an explicit switch in setup.
- Slack: Socket Mode with the configured bot token and app-level token. Start with one workspace
  installation per instance; separate instances can connect different accounts/workspaces.
- Discord: a persistent Gateway listener for ordinary messages and attachments. Verify message
  content intents and channel permissions. Route interaction acknowledgements using the supported
  SDK Gateway path; if that path needs forwarding, use an authenticated private worker endpoint.
  A Discord incoming-webhook URL alone cannot provide this feature.

Do not route platform callbacks through dashboard `/api/` routes or exempt them from `x-dash`.
The public dashboard remains loopback-only with all existing request guards.

### WhatsApp ingress

WhatsApp needs a public HTTPS webhook. Build a separate small relay service as part of this plan;
do not expose Athena's port through a tunnel or a reverse proxy. The user supplies or connects a
relay deployment and a Meta Business app/phone number. A deployment guide and testable relay are
deliverables, not an assumed external dependency somebody else will build later.

The relay handles Meta verification and signature validation, associates events with a paired
installation, and stores them durably before acknowledging. It exposes an authenticated outbound
pull/stream connection to the local worker. The local worker sends a processing acknowledgement
after its durable inbox commit, not after the model finishes. Use per-installation keys, bounded
retention, replay IDs, sequence/cursor recovery and explicit revocation.

Keep the original signed body and headers in the private envelope so the local adapter can verify
and normalize the event too. The relay stores only the webhook verification material it needs;
the outbound Meta access token stays on the computer. No model provider keys, local filesystem
access or dashboard session is available to the relay. The relay necessarily sees webhook content;
document that boundary and expire acknowledged content promptly.

Keep media download local through the authenticated platform API. If media expires while the
computer is offline, report it and request a resend; do not pretend an expired URL is an attachment.
Show the relay's bounded offline retention and quota in setup. Exhausted capacity must return a
retryable webhook failure rather than acknowledge and lose the event.

## Sender guards and conversation boundaries

Run sender guards on every inbound message and control, including messages in subscribed threads,
edits, attachment-only messages and action callbacks. Run them before downloading media, creating
local conversations or invoking an agent. Platform transport authentication and sender authorization
are separate checks. Recheck the current policy before queued work executes.

### Telegram

Require a nonempty allowlist of exact numeric sender IDs. Store IDs as strings to avoid accidental
numeric coercion. Usernames and chat IDs are not user IDs. Reject missing senders, anonymous
administrator/channel identities and forwarded author metadata as proof of the current sender.
Support DMs and explicitly enabled groups/topics; allowed people in an unbound chat cannot change
the project target. Do not accept all group members because the bot was added to that group.

### WhatsApp

Require a nonempty allowlist of canonical E.164 phone numbers. Normalize input with an established
phone-number parser and an explicit country selection when local notation is entered. Do not use
suffix matching or compare display names. Scope identities to the configured business phone/account.

The adapter can receive business-scoped user IDs without a phone number. Accept those only through
a verified platform identity mapping to an allowed phone number. Never trust a number typed in the
message, a contact-card claim or an unverified alias. If no verified mapping exists, deny and show
"Sender could not be matched to an allowed phone number" locally. Follow verified rotation events
without transferring authorization to unrelated identities. Do not introduce an ID-only bypass.

### Slack

The user-ID list is optional. When empty, accepted users in the configured workspace and
conversation scope may chat. When set, require an exact workspace-scoped user-ID match on every
event. Reject missing actors and bot/self messages. Show the empty-list behavior plainly in setup.
Optional sender guards do not imply accepting any workspace, arbitrary public channels or strangers'
Slack Connect identities; those scopes remain explicit configuration.

### Discord and shared rules

Require configured guild/channel scopes, with DMs enabled separately. Offer an optional exact user-ID
list. Usernames, channel names and message mentions cannot grant access. Do not accept messages from
other bots by default. Server/channel permission failures appear as connection errors.

Use a binding key composed from gateway instance ID, platform account/workspace ID, channel/chat ID and
thread/topic/conversation ID. Persist the bound project and target. A global project switch never
redirects a conversation. Rebinding starts a new local conversation and cannot leak old private
history. An instance with a deleted project/target pauses instead of selecting another one.

DM messages are accepted in allowed bound DMs. In shared channels, start on an explicit bot mention
or reply, then continue only the subscribed thread/topic. Platforms without usable threading use an
explicitly configured conversation scope. Preserve real sender attribution so multiple permitted
people do not become one fabricated local user. Ignore own-message echoes and status-only events.

## Storage and execution

Add new shapes to `shared/types.ts`, with server-only credentials kept out of browser-safe records:

| Record | Purpose |
|---|---|
| Gateway instance | Stable instance ID, platform, instance name/account label, project, discriminated Brain/team/agent target, transport, sender policy, conversation scopes, file limits and enabled state |
| Gateway instance secret record | Instance-scoped bot/app tokens, signing/verification secrets and relay credentials, stored through the secrets layer |
| Conversation binding | Instance ID and external composite identity to local project, agent/team/Brain conversation and route generation |
| Inbox event | Instance ID, stable source ID, actor, received time, normalized input, serializable media descriptors and processing status |
| Delivery | Instance ID, bound route generation, destination, source run/message, text parts, approved files, remote IDs, attempts and individual outcomes |
| Gateway instance health | Instance ID, redacted status, last activity, reconnect/failure reason and counts; emit changes to open tabs |

Persist through `store.ts` helpers. Add a local `StateAdapter` backed by the same storage layer for
SDK subscriptions, TTL cache/dedupe and leases. It supports one local worker per gateway instance, with
atomic write/claim and expiry semantics; a second worker must fail its ownership claim. Keep the
SDK's coordination state separate from the application inbox and delivery ledgers.

Do not use the in-memory state adapter in shipped code. A single-writer JSON implementation fits the
current app; prove its lock and crash semantics with process tests. A hosted relay uses a durable
store suitable for its deployment and replicas, rather than a process-local JSON lock.

Normalize and durably enqueue accepted events, then return to the transport promptly. SDK handlers
must not wait through a long model run. Configure deliberate queuing, not the SDK's default dropping
of lock conflicts. Preserve per-conversation order, deduplicate within an instance by account plus platform event/message
identity, and reconcile edits separately. A repeated event cannot start a second agent run.

Factor shared agent, Brain and team send services from the existing browser routes. Call them under
the binding's `withProject()` context, with stable message IDs, actual sender attribution and saved
attachment paths. Integrate busy/queue behavior and completion signals rather than scraping visible
text or assuming the first team member response means the assignment is finished.

## Files in both directions

### Incoming uploads

1. Authorize actor and destination before fetching. Accept messages with files and no text.
2. Preserve serializable platform IDs/metadata. Never put `fetchData` functions or bearer-bearing
   URLs in JSON or logs; use SDK rehydration where supported and a tested resolver otherwise.
3. Download private media with platform authentication. Enforce per-file, per-message and daily
   quotas before and during transfer, with timeouts and redirect/SSRF checks. Initially cap at
   20 MiB per file, 10 files and 50 MiB per accepted message, lowered to provider limits. For an
   SDK helper that buffers its whole response, enforce an upstream cap before using it; do not
   describe that helper as streaming. Reject or use a bounded download path when safety is unknown.
4. Refactor `server/uploads.ts` to share streamed/byte-source saving, safe names, unique file claims,
   temporary cleanup and symlink/root checks with browser uploads. Save in the bound project.
5. Save the local attachment record before committing its inbox transition. Retry without duplicate
   files or duplicate messages; crash leftovers are cleaned by an owned temporary-file policy.
6. Pass ordinary Athena attachment paths to agents/Brain/teams and show source platform, filename,
   size and status in the dashboard. Images reach vision-capable models; other files use the same
   file tools as dashboard uploads. Audio/video remain files unless a separate enabled tool processes them.

Treat documents and captions as untrusted conversation content. Never run an upload or extract an
archive automatically. If one file fails, retain successful files and show the individual failure;
do not silently give an agent an incomplete request. Wait for a resend or an explicit instruction
to proceed without the missing file. Album/burst grouping must preserve all source message IDs.

### Outgoing uploads

Deliver files selected by the user or explicitly returned as deliverable attachments by the run.
Do not attach every artifact/tool image automatically. Resolve each path against the run's allowed
roots, recheck real paths at send time, and exclude credentials, private runtime stores and unrelated
project files. Snapshot approved bytes or verify a content hash so a changed file is not sent under
an earlier authorization.

Use SDK generic `files` uploads for documents and supported typed `attachments` for native media.
Upload bytes through the platform API; local `127.0.0.1` URLs are not remotely fetchable. Add no public
file-hosting service just to make local attachments work. Oversized/unsupported files receive a clear
per-file error and stay available in Athena; an external share link requires a separately authorized service.

Maintain a capability matrix for MIME categories, captions, counts and size limits at the pinned
adapter version. Split WhatsApp multi-file sends into individual delivery outcomes, handle Telegram
document/media distinctions and albums, and check Slack file scopes and Discord attachment permissions.
Do not equate a logical SDK post with a single remote message or claim all files arrived because
the final returned remote ID exists.

## Replies, permissions and failure handling

- First ship final replies plus a bounded "Working"/typing indication. Add throttled streaming only
  where it preserves the full final text and reliable delivery accounting; split long replies or
  attach a full text file rather than silently truncate them.
- Configure reply routing to the originating conversation and target. An instance targeting a team sends the
  chosen outward answer and selected files, not private member reasoning, internal tools or raw logs.
- Preserve current autonomy and risk approvals. V1 approvals stay in the dashboard; a remote user
  sees "Needs approval in Athena" without secrets or a public link to the local app. Remote approval
  controls require a separate actor/operation-bound design, not a generic "approve" message parser.
- Ordinary contextual replies use the instance's explicit setup authorization. Agent-requested
  proactive sends, other recipients and additional file disclosures use a high-risk gateway tool
  and existing approval policy/Outbox where appropriate. Never let the model supply credentials.
- Track text parts and files separately. Retry rate limits using provider hints; do not resend already
  confirmed parts. Ambiguous send outcomes become "Delivery uncertain" and require reconciliation
  or an explicit retry, since platform sends are not universally idempotent.
- For WhatsApp, enforce the current service-window/template rules at delivery time. Do not send a
  generated free-text answer outside the allowed window. Keep the answer locally and show the
  restriction; templates are optional explicit configuration, not invented by the model.
- Disabling/revoking an instance stops its intake and prevents queued sends. Recheck policy before a
  download/run/send; already executing tools follow ordinary stop semantics. Deleting an instance
  clears its credentials, relay pairing and temporary media by a defined retention policy.

## Product interface and existing outbound helpers

Add a dedicated **Settings > Gateways** tab listing instances grouped by platform, with Add instance,
Edit, Enable/Pause, reconnect/test, and recent activity for each instance. Allow repeated additions
of the same platform; adding one instance must not replace an existing one.
Register `gateways` in `web/views/setup.tsx` alongside the other Settings tabs, with the deep link
`#/settings?tab=gateways`. Add search entries for all four platforms, sender guards, file uploads
and relay setup. Gateway status links in `web/app.ts` should open this tab and the relevant instance, using its stable ID.
The tab owns gateway accounts, routing, access guards, files, relay setup and connection health.
Each instance setup includes a name, account credentials, project, an explicit Brain/Team/Agent
target picker (with a team or agent picker where needed), channel/DM scope, the platform-specific
sender guard, file limits and a plain explanation of who can trigger work. An empty required guard
prevents enabling Telegram or WhatsApp. Slack's optional field is labeled "Allowed user IDs (optional)".

Show each instance's project and target alongside "Connected", "Waiting for relay", "Needs setup", "Paused" and actionable errors. Test setup
performs read-only credential/scope checks; an actual test message is an explicit user action with
a selected destination. Show denied identities locally without downloading their files or quoting
their private message text. UI uses existing controls, theme tokens and `web/client/` requests.

Move Telegram/Discord setup out of Connections into Settings > Gateways once parity is implemented;
remove the old one-way forms and update their settings-search entries and status links. Route their
existing Outbox send intent through the gateway delivery service with an explicit destination
instance, retaining its approval behavior. Never choose the first instance of a platform implicitly.
No old secret-field migration is needed; clearly request
fresh setup. Keep X/Reddit social account handling separate. Add Slack/WhatsApp proactive sends only
through the same explicit policy, with WhatsApp restrictions enforced.

## Implementation sequence

1. **Transport and media proof:** pin packages; receive and reply with one real file on each platform
   using test accounts. Prove Telegram polling, local Slack/Discord connections, a minimal WhatsApp
   relay, signature verification and adapter lifecycle on Windows/Linux. Confirm Bun versus packaged
   Node, exact attachment limits, SDK state methods and Discord intents/interaction routing.
2. **Foundation:** add multi-instance schemas, instance-scoped secret storage, local durable SDK state, worker supervision, identity
   guards, bindings, inbox/delivery ledgers and shared Athena conversation entry points.
3. **Telegram:** ship required user-ID guards, polling, files, burst/album behavior, ordered dispatch,
   final replies, restart recovery and the dedicated Settings > Gateways tab end to end, including
   Settings search, instance deep links and status-link navigation. Support multiple Telegram instances
   with independent Brain/team/agent targets from the first release.
4. **Slack and Discord:** add socket/Gateway lifecycle, configured scopes, Slack optional user guard,
   Discord optional user guard, file permissions and thread mapping. Exercise multiple instances per platform and independent Brain/team/agent targets.
5. **WhatsApp:** complete the deployable relay, pairing/revocation, required phone guards and verified
   identity mappings, local media downloads, service-window handling, quotas and offline recovery.
6. **Unify delivery and finish:** replace old one-way helpers, add approved proactive sending,
   complete file outcomes and diagnostics, and update README, guide, desktop/deployment instructions
   and any ownership notes. Keep disabled platforms explicit until their acceptance cases pass.

## Verification and completion criteria

Test normalized adapter fixtures and real process boundaries, with network calls mocked except for
an explicit manual test-account matrix. Required cases:

- Telegram denied/allowed/missing/forwarded/anonymous actors; an empty guard cannot enable intake.
- WhatsApp equivalent phone formats, invalid numbers, exact match versus suffix, missing phones,
  verified/unverified business IDs and identity rotations; no claimed-number bypass.
- Slack empty optional guard versus populated guard, wrong workspace, missing actors, shared
  channels and action callbacks. Discord wrong guild/channel, DM policy and missing permissions.
- All sender policies apply to subscribed messages, attachment-only input and delayed queued work.
- Duplicate events, lock conflicts, bursts, own echoes, message edits and interrupted poll offsets.
- Multiple instances of every platform with separate Brain, team and agent targets; independent
  credentials, guards, scopes, health, pause/delete and SDK state; no cross-instance history or delivery.
- Duplicate external account/event-stream ownership is rejected where routing would be ambiguous;
  one Telegram polling consumer per bot, with no duplicate runs from overlapping intake.
- Project switch/rebinding/deleted target; agent, Brain and team dispatch; gateway engine independence.
  Queued work retains its original instance/binding and route generation after configuration changes.
- Private incoming and outgoing image, document, audio and video; expired URLs, misleading sizes,
  path traversal, symlink escape, SSRF redirect, quota exhaustion and partial multi-file failures.
- Crash after inbox commit, after run start and during individual send/upload; no blind duplicate run
  or outbound resend. Reconnect preserves subscriptions, cursor and phone identity mappings.
- Relay invalid signatures, pairing isolation, replay, storage failure, offline retention, revocation
  and slow consumers. Never acknowledge an event that has not reached durable storage.
- WhatsApp window expiry while a run is busy; full long replies on all platforms; per-part status.
- Credentials and token-bearing media URLs absent from state APIs, logs, exports and project backups.
- The dedicated Settings tab, direct links and search results for all four platforms; removal of
  Telegram/Discord setup from Connections; required/optional guard validation, file progress/errors
  and per-instance pause/reconnect behavior; repeated Add instance, target pickers, stable instance
  deep links and explicit Outbox instance selection.

Run `bun run check`, `bun run build`, desktop staging/smoke and required Rust checks. Test the bundled
worker from read-only application files with throwaway `DASH_DATA` and test homes on Windows/Linux.
The relay has its own storage/signature/retry checks and a local end-to-end integration fixture.

Done means all four platforms support authorized two-way text and file delivery, restart-safe
routing across multiple independently configured instances per platform, each targeting the Brain,
a team or an agent, clear partial-failure states and the specified sender guards, while Athena remains local
and login-free. Telegram/Slack/Discord need no public dashboard endpoint; WhatsApp has a working,
documented relay. Creating this plan sends no platform messages and deploys no service.
