# Chat SDK Gateways with files

*Plan, 1 November 2026. Experimental Telegram conversations added 2 November;
Experimental Slack and Discord text/file delivery added 3 November. Product setup remains incomplete.
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
  real-account Slack/Discord connections and WhatsApp signatures/media remain unproven.
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
  Outbox helpers remain unchanged. WhatsApp reports unavailable in the application worker.
  Configuration requires parser-validated canonical E.164 numbers; the normalization helper accepts
  local notation only with an explicit country. Verified mappings are implemented below; setup
  controls remain to implement.
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
  | Discord | Private message attachments and selected regular output files | At most 20 MiB per file, 10 files and 50 MiB per assignment; configured limits can be lower | Refreshed source-message CDN URLs and one multipart request per selected file; experimental supervised workers |
  | WhatsApp | Guarded PDF, plain `.txt` and Office document uploads; application transport not enabled yet | At most 20 MiB per file and configured message/daily caps; live verification pending | One upload plus one contextual document message per file, with the 24-hour window checked before both. No captions, albums, native image/audio/video sends or template fallback |

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
  `#/settings?tab=gateways&instance=<id>` opens the named Telegram, Slack or Discord editor. WhatsApp remains
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
  This remains local-fixture evidence; real Discord account/platform checks remain pending.
- Enabled experimental Discord through the shared worker and a thin transport factory, keeping
  intake, file processing, native dispatch, final replies and selected files under the same instance
  and account claims. A lost Gateway aborts incoming/outgoing work promptly; shutdown drains the
  journals before releasing ownership. Fatal setup errors stop automatic retry. Retry deadlines
  survive restart and manual reconnect and are checked before REST authentication or Identify.
  Worker tests cover text delivery, Resume, source replay without another run, fatal closes,
  preserved waits and independent bot histories/destinations. Bun, Node and read-only bundle proofs
  also reconnect through the same transport factory without another Identify or repeated delivery.
- Settings > Gateways now adds Discord accounts, preserves separate secret storage, supports an
  optional exact user list, explicit server/channel/thread scopes, DM policy and independent
  Brain/team/agent targets. Saves remain paused. Enable rejects invalid or overflowing snowflake
  IDs. Search and existing instance/inbox links recognize Discord. The new recovery view shows only
  a date and opaque revision; it never exposes session IDs, resume URLs or sequence details. Its
  guarded API requires a paused instance, exclusive account/state ownership, a matching current
  revision and explicit acknowledgement. It atomically records the review and clears only the
  old session/gap, preserving Identify spacing, provider waits and all inbox/delivery receipts.
  Corrupt, foreign-account, stale or overfull review records fail closed. The instance stays paused
  until separately enabled; missing Discord messages are not silently recovered or discarded.
- Local API and DOM tests cover guarded/stale recovery requests, pause/confirmation, private
  credentials, scope fields, multiple bot drafts and deep links. The static UI detector returned no
  findings. Browser visual approval remains unavailable: no desktop/mobile capture surface was
  available, and the fresh finish review requested screenshots rather than issuing approval.
- Added the separate deployable `relay/whatsapp` Cloudflare Worker with SQLite-backed Durable
  Objects. Webhook verification checks the challenge token; POST intake verifies the exact raw
  HMAC-SHA256 bytes, configured business account/phone and supported message envelope before any
  acceptance. One deployment serves one phone/provider setup; mixed-account signed batches fail
  closed rather than exposing another installation's original body. Multiple WhatsApp instances
  can use separate deployments. No dashboard port or local API is exposed by the relay.
- The versioned relay protocol uses one-use ten-minute pairing codes, distinct administrative and
  per-installation pull keys, one active 60-second consumer lease, ordered cursors and acknowledgements
  tied to delivered envelope IDs. Bodies and cursor/replay mutations commit together in a SQL
  transaction; a storage failure returns 503. Exact retries reuse their receipt; acknowledged bodies
  are deleted from live storage while bounded replay hashes remain. The private envelope preserves
  exact body bytes and the signature/Content-Type headers for later local verification, omitting
  unrelated HTTP headers. The relay never holds an outbound Meta token, model key or local path.
- Default relay limits are 72 hours, 1,000 pending bodies and 16 MiB of raw bytes, plus 10,000 replay
  markers retained seven days. Overflow refuses acknowledgement. Alarms and request cleanup expire
  content; expired unacknowledged data creates a durable gap and blocks further consumption until
  explicit current-epoch administrative review. Revocation invalidates the pull key/lease, changes
  epoch and removes queued raw bodies only after explicit acknowledgement. Provider backup/PITR
  retention is documented separately from live deletion. Local intake must commit before ACK and
  must not dispatch native work from an unconfirmed relay acknowledgement. The local receipt and
  verification boundary below now enforces that rule; supervised polling remains next.
- Pinned Miniflare `4.20260730.0` and Worker types `5.20261103.1` for isolated runtime/type checks.
  The deployment guide includes the SQLite migration, secrets, provider scope, pairing, protocol,
  quotas and recovery boundaries. Wrangler `4.156.2` deployment dry-run passed with a throwaway home
  and no account credentials; no relay was deployed. Tests exercise real SQLite rollback, signature
  and account refusal, pairing/lease isolation, capacity, retention gaps, revocation and runtime
  restart. Separate Node/workerd processes also use a fully bundled read-only Worker outside the
  checkout, preserving receipts across process boundaries without any provider account.
- Added the local WhatsApp relay intake boundary. It independently verifies the original HMAC bytes,
  body digest, canonical base64/UTF-8, supported envelope and every business account/phone before
  normalizing anything. Only signed current-sender phone digits can authorize a message; names,
  forwarded metadata, typed numbers and contact-card claims cannot. Pinned `libphonenumber-js`
  `1.13.15` with full validation metadata handles normalization and exact canonical allowlists.
  Missing phones and business-scoped IDs without a verified mapping are denied; bounded local
  receipt counters record unmatched senders without retaining denied bodies. Status, system and
  action messages never become assignments. Verified mappings and rotation support follow below.
- A whole local webhook batch commits accepted messages, pinned routes, message timestamps, media
  descriptors and its receipt/cursor metadata in one atomic inbox write before remote ACK. Text,
  manual file preparation and background downloads remain blocked until the exact saved epoch,
  sequence and envelope ID are confirmed. An ACK timeout or failed local confirmation leaves the
  batch gated. A restart can retry only that saved acknowledgement without accepting the body again;
  replayed platform message IDs preserve their original route and create no second assignment.
  Skipped cursors, changed epochs and inconsistent saved flags fail closed, awaiting recovery work.
- Focused tests cover invalid signatures/encodings/accounts, phone spoofing and revocation, private
  descriptors, failed atomic writes, concurrent intake and lost ACK replies. The hosted relay proof
  now uses the actual bundled local inbox/intake from read-only application files: three separate
  Node processes retain Worker SQLite and local receipts, lose an ACK reply after its remote commit,
  then confirm that receipt after restart before releasing work. Both Bun and Node launch this proof.
  No Meta account, public dashboard webhook, deployment or native model call is involved.
- Added private verified WhatsApp identity mappings in the same atomic inbox write as the batch's
  messages, route bindings and relay receipt. A signed current phone plus BSUID, or one exactly
  matched signed provider contact, establishes the phone association. Later BSUID-only messages use
  that stored phone and still require its exact current allowlist entry. Names, contact cards,
  unrelated contacts, forwarded authors and parent IDs alone never prove a phone. Instance/business
  account mismatches fail closed, including when confirming a saved receipt after restart.
- Both the relay and local intake now support scoped `user_id_update` notifications as well as
  `messages`. Signed number/ID-change system messages and dated identity updates retire old aliases,
  clear missing new-phone proof, hold old queued/running assignments and pending delivery, and block
  earlier phone-only messages. A newly shared phone needs its own permission and conversation; it
  never inherits the old number's target binding. Conflicting aliases stay blocked. Up to 10,000 user
  records and 10,000 phone-change cutoffs retain replay protection rather than silently evicting it.
  Parent changes only revoke matching proof; parent IDs do not provide an alternative allowlist.
- Tests cover restart with hidden phones, uniquely matched provider contacts, account isolation,
  conflicts, old-message/rotation replay, same-batch ordering and an atomic write failure during
  revocation. The real Worker/SQLite and bundled local intake proof now also restores a phone mapping
  after process restart, consumes a BSUID-only message, then applies a signed rotation that holds
  old work without running a model. Updates without usable signed timestamps or complete identity
  information stop intake without ACK for review; product recovery controls remain pending.
- Validation: type checks and all 2,263 tests passed (one skipped) with CI's two-worker limit;
  desktop staging and smoke passed. The initial four-worker run had one gateway lifecycle startup
  status mismatch; it passed in the focused and complete reruns. No startup/ownership code was changed.
- Added the authenticated local WhatsApp relay consumer. Explicit pairing pins the HTTPS origin,
  installation, business account, phone and epoch in the claimed private inbox; status responses
  cannot replace them or reset its cursor. Bearer/lease keys stay out of that journal. Requests use
  fixed protocol paths, reject redirects, omit browser credentials and enforce ten-second deadlines
  and bounded response bytes (64 KiB for controls, 2 MiB for pulls). Shared version-one schemas bound
  metadata, limits and batches of at most 20 original signed envelopes.
- Polling commits each normalized receipt before its remote ACK. On restart, a still-pending body
  is pulled under the new lease before acknowledgement; when the remote ACK already committed, an
  idempotent ACK must confirm that exact saved envelope ID before local work is released. A status
  cursor alone never releases work. Competing/expired leases and temporary outages return redacted
  retry errors with safe wait times; there are no hidden request retries. The consumer polls every
  five seconds after start and stops on failure for its owner to handle. Stop aborts/drains in-flight
  work, then makes a bounded release attempt before freeing its in-process ownership claim.
- Retention gaps, changed paired identities/epochs, unexpected cursors and malformed envelopes save
  a durable local review marker and hold existing work and pending delivery. Ordinary polling,
  message retry and ACK confirmation cannot clear this marker or accept loss. No consumer request
  uses administrative recovery/revocation credentials or drops queued bodies. Product review and
  re-pairing controls remain pending, so WhatsApp stays unavailable in the application worker.
- Consumer tests cover ordered bounded batches, exact ACK recovery on both sides of remote commit,
  changed accounts/cursors, missing/invalid bodies, local write failure, competing/expired leases,
  secret-safe HTTP errors, stalled bodies, shutdown during ACK and timer cleanup. The read-only
  bundled, separate-process Worker/SQLite proof now uses the actual consumer for authenticated
  status, claim, pull and ACK operations, preserving the lost-reply and identity-rotation checks.
- Validation: full checks passed with CI's two-worker limit (2,297 tests, one skipped), followed by
  56 passing consumer/inbox/bundled-proof tests after requiring the protocol's exact HTTP 200 ACK.
  Type checks, desktop staging and desktop smoke passed. No service was deployed or account used.
- Added the pinned WhatsApp Chat SDK adapter and read-only Graph `v25.0` phone/account checks. The
  token must resolve the configured phone ID and list it under the paired business account before
  media access is available. Account paging follows only bounded encoded cursors on fixed paths
  (ten pages of 100), never provider next URLs; JSON responses are capped at 64 KiB. SDK logs are
  muted. The public SDK webhook, default sends/uploads and buffered media helper are blocked so
  they cannot bypass the relay receipt, phone guards or the future service-window delivery ledger.
- Signed media SHA-256 values now normalize from hex/base64 into canonical hex descriptors. Local
  downloads require an acknowledged saved event, its exact original descriptor/route, verified Meta
  account and current sender/identity access before metadata and binary I/O and while streaming.
  Metadata ID, MIME and size are checked; both metadata and final byte hashes must match the signed
  source. Older media without a signed hash requires a resend. Only fixed Graph and trusted Meta
  CDN host families may receive the Meta bearer token; URLs stay ephemeral, HTTPS/redirect checks
  are strict, and a transfer has a 45-second deadline. Per-file, message and daily reservations use
  the existing bound-project upload stage; current limits can further lower the 5 MiB image,
  16 MiB audio/video and 20 MiB local document caps. No partial or unverified file is published.
- Tests use local HTTP fixtures for wrong phone/business/permissions, bounded paging, signed hashes,
  mismatched metadata, redirects, length/MIME/encoding faults, short/long/corrupt streams, missing
  signed proof, sender revocation, reduced limits and shutdown. A separate proof runs the actual SDK
  and hash-checked file stage under Bun and Node and from a bundled read-only app outside the repo,
  with temporary home/data, no live account, no sends and no model invocation. It proves no metadata
  download before ACK, safe file names, original-project storage and default SDK bypass refusal.
- Validation: type checks and all 2,331 tests passed (one skipped) using CI's two-worker limit;
  desktop staging and smoke passed. The relay and dashboard were not deployed or connected to a
  real WhatsApp account. Application transport remains unavailable pending replies and setup.
- Added guarded WhatsApp text/notices and selected document delivery. Every call must match a saved
  `sending` part/file/notice, original input and pinned route, with current sender/identity permission
  and a confirmed same-account/contact message inside 24 hours. Activity from another sender,
  unconfirmed receipts and old signed replays cannot refresh the window. The signed timestamp is
  clamped to its first local receipt time. Long answers retain all plain text in the existing durable
  part ledger; each part quotes the original message and disables previews. No automatic template,
  formatter fallback or hidden split/send path is used.
- Selected `.txt`, PDF and Office documents use the existing safe regular-file/root/hash proof,
  one bounded multipart upload and one contextual document message. The 24-hour window, access,
  source revision and claim are checked before upload and again before the final send. Expiry holds
  the remaining work with a local request for a fresh message and explicit retry. No upload is
  started for an unsupported file; no document is posted after a lost/invalid upload response.
  A completed authorized upload may remain at Meta if a later access/window check refuses its send.
  Per-file byte reservations and confirmed-prefix preservation remain in the shared delivery ledger.
- Unknown message POST outcomes, malformed acknowledgements, mismatched recipients and ambiguous
  responses remain uncertain for explicit review; only definite rate refusals return safe waits.
  New adapters cannot reuse a pre-existing `sending` claim, and concurrent duplicate calls cannot
  post that attempt twice. SDK public/default sends and template paths stay blocked. Public failure
  reasons for expired windows and unsupported document types use fixed text, never provider details.
- Local fixtures cover expiry between reply parts and during file upload, fresh-message recovery,
  notices, future timestamps, original-project/recipient routing, selected-byte integrity, revoked
  access, unsupported types, rate refusals, unknown sends and reconnect without a second POST. The
  Bun/Node and bundled read-only proof now sends a full long reply followed by one selected document
  through the saved ledger against the local Meta fixture; no real account or model is used.
- Validation: full checks passed with CI's two-worker limit (2,360 tests, one skipped). After adding
  the final held-assignment guard, type checks and 52 focused delivery/SDK/outgoing tests passed.
  Desktop staging, the web build and desktop smoke passed. No service was deployed or real account used.
- Joined the paired relay consumer and guarded Meta adapter in the application transport factory,
  with instance-scoped access token, app secret and pull key. The worker selects this factory for
  WhatsApp, verifies the Meta phone/business before relay I/O, recovers the inbox before intake and
  shares the existing file, native-work, reply and selected-document stages. Relay failures abort
  the worker signal immediately, stopping new dispatch and file/delivery I/O before monitor disposal;
  existing native runs keep ordinary stop/recovery semantics. Shutdown drains local stages and releases
  the remote lease before SDK state and account ownership. Temporary errors respect relay retry times;
  setup errors and durable recovery markers do not retry automatically or clear saved review holds.
- Integration fixtures cover the complete worker path, signed ACK-gated input/files, selected output,
  lost ACKs before/after remote commit, restart without duplicate work or sends, independent business
  phones, missing credentials/pairing, Meta verification failure, durable gaps, redacted health,
  rate waits and shutdown during a stalled pull. The Bun/Node and bundled read-only proof also
  reconnects the actual transport, dedupes a replay and delivers a new saved reply with no real account
  or model invocation. WhatsApp remains unavailable in the product pending pairing and recovery controls.
- Validation: full type checks and 2,377 tests passed (one skipped) with CI's two-worker limit;
  desktop staging, the web build and desktop smoke passed. No relay deployment or live account was used.
- Added paused-only initial WhatsApp pairing APIs under the supervisor's exclusive state/account
  ownership. Setup accepts a user-chosen HTTPS origin, exact business account and one-use code, with
  explicit acknowledgement of the starting cursor. It refuses existing relay/conversation history,
  follows no redirects and bounds the exchange to ten seconds/64 KiB. It saves an attempt before
  I/O, then atomically saves the returned pull key and received receipt in private gateway secrets
  before binding the empty inbox. Codes are never saved, and setup neither claims nor ACKs the relay,
  sends messages, starts work nor verifies the Meta access token. The instance stays paused.
- Added secret-free setup status and revision-checked local finish/review actions. A received key can
  finish after an inbox write failure or restart without another exchange; a crash after inbox commit
  is idempotent. Unknown exchanges cannot retry until the user acknowledges remote administrative
  revocation and its queue loss. This local acknowledgement does not invoke or verify revocation.
  Received keys and existing bindings cannot be abandoned by this action. Pending setup blocks
  credential replacement and transport startup. Remote gaps stay held; no recovery marker is cleared.
- Tests cover response/account/origin faults, bounded/stalled reads, save failures before/after the
  remote exchange, stale revisions, pause/delete races, ownership and secret-free API responses.
  The existing Bun/Node and bundled read-only proof now begins with the actual one-use pairing client.
  Settings controls, read-only Meta setup checks and recovery for already paired relays remain pending;
  WhatsApp stays unavailable in the product.
- Validation: full checks passed with CI's two-worker limit (2,413 tests, one skipped). The initial
  run hit an ownership-port collision and Miniflare oversized-request EPIPE; 139 focused tests and
  the full rerun passed. After the final malformed-receipt guard, type checks and 74 focused tests
  passed. Desktop staging, the web build and desktop smoke passed. No deployment or live account was used.
- Added paused-only inspection and explicit local review of an observed retention gap. Inspection
  uses only the saved origin/key and a bounded read-only status check; the exact installation,
  business/phone, epoch and local receipt prefix must match. It saves the lost range, holds old work
  and provides only the hold reason, date and opaque revision through a local preview. Review
  requires a fresh authenticated status after separate operator administration: the gap must be gone
  and the remote cursor must equal the exact observed end. Unknown advances, stale work/settings,
  new gaps and changed identities are refused. No local action claims, pulls, ACKs or administers the relay.
- Local cursor movement and a bounded audit commit atomically, retaining identity mappings, source
  dedupe, operation IDs, files and confirmed reply prefixes. A skipped pending ACK moves into the
  audit without confirming its envelope; its saved messages remain unconfirmed and held. Journal
  validation rejects forged promotion into a confirmed receipt, even after later valid intake.
  Existing ordering still blocks work behind unresolved earlier assignments/deliveries. A gap review
  only restores intake; it neither releases those holds, enables the instance nor restarts work/sends.
  Local history retains 1,000 reviews without eviction and then refuses further reviews.
- Fixtures cover restarts, saved/unconfirmed ACKs, stale/changed gaps, read bounds and timeouts,
  ownership, save failure and retained work/mappings. A real local SQLite Worker proof reviews a
  retained gap after an ACK reply is lost; fresh intake resumes without confirming or replaying old
  work. The Bun/Node and bundled read-only proof also reopens saved state before reviewing its gap
  and preserves prior work. Non-gap receipt holds and identity/installation changes remain
  blocked for restoration or separate recovery controls; no epoch or inbox replacement is implemented.
- Validation: full type checks and 2,445 tests passed (one skipped) with CI's two-worker limit;
  desktop staging, the web build and desktop smoke passed. No service was deployed or live account used.
- Added paused-only, revision-checked dismissal for held requests that have never reserved or started
  native work. The local review preview and explicit confirmation refuse any operation ID, dispatch,
  reply, outgoing delivery, notice or album. Dismissal adds an audit marker without rewriting the
  source, route or original hold; it cannot start work, send or confirm a receipt. Interrupted incoming
  transfers become failed while their reservations remain charged. Current WhatsApp relay holds
  still block dismissal, and unconfirmed inputs require a saved reviewed-gap proof of abandonment.
- The inbox offers Dismiss request only on unstarted holds and requires pause, a fresh server preview
  and explicit confirmation. Dismissed requests stay visible in All messages and no longer count as
  needing review or block later work in the binding. Old source IDs remain deduplicated across restart.
  Completed/dismissed receipts can be explicitly cleaned together when their conversation is resolved;
  compact replay markers and byte charges remain. Native operations and deliveries keep their existing
  reconciliation/retry controls; this action never overrides ambiguous work or album completeness.
- Added server, API and UI fixtures for ownership, stale confirmation, pause/settings changes,
  native-work refusal, ACK/gap gates, interrupted download charges, cleanup replay protection,
  double clicks and closing during confirmation. The Bun/Node and read-only bundled proof also
  dismisses a saved held request without work or delivery. README and guide describe the new controls.
- Validation: full checks passed with CI's two-worker limit (2,470 tests, one skipped). The initial
  run exposed a WhatsApp fixture clock that could lag fresh signed input across a second boundary;
  intake now captures one time frame and the full rerun passed. Desktop staging, the web build and
  desktop smoke passed. A scoped desktop/mobile finish review approved the control and confirmation;
  the existing design system is unchanged. Only synthetic preview data was used, then removed.
- Added WhatsApp Settings configuration and relay setup while keeping the transport availability
  gate closed. Each instance saves its own business phone, project, Brain/team/agent destination,
  full-phone guard and file limits, always paused. Meta access tokens and app secrets have masked,
  independent keep/replace/remove controls; partial updates preserve the private relay pull key.
  Settings search and stable instance/relay links reach the new flow.
- The relay panel exposes one-use pairing with starting-position confirmation, locally finishing
  received keys, reviewing unknown outcomes only after remote revocation acknowledgement, and
  exact observed retention-gap inspection/review. It never calls relay administration. A failed
  pairing refreshes the saved outcome before another action, codes clear on exchange, and competing
  actions/double clicks are blocked. Changed installations and invalid receipts still require
  restoration rather than a reset; receiving/sending remain explicitly disabled.
- Added a paused, exclusively owned read-only setup check. Fixed, bounded Graph `v25.0` GETs verify
  the phone and business-account membership before a saved-origin relay status GET. Configuration,
  secrets and local relay receipts must stay unchanged, and the remote installation/account/phone,
  epoch and cursor must match saved state or its exact pending ACK/gap-review exception. The safe
  result reports ready, pending acknowledgement or needs review without saving proof, clearing a
  hold, initializing Chat, claiming/ACKing, downloading files, invoking work or sending. App-secret
  presence is checked; signed webhook intake still proves whether it matches Meta.
- Added account/relay fault, stale-check, pending-ACK, stalled-read, partial-secret, ownership,
  local API guard and DOM coverage. The Bun/Node and read-only bundle proof now checks the paused
  account/relay path and unchanged inbox bytes before enabling its synthetic transport. README,
  guide and relay instructions describe setup, its limits and the interrupted/recovery paths.
- A scoped finish review approved the editor, pairing, gap and confirmation states at desktop/mobile
  sizes with no material findings. The existing design system is unchanged; only isolated synthetic
  preview data was used and removed. This review does not prove dark rendering, keyboard behavior
  or live transport readiness. The full check caught and fixed a Settings search ranking regression
  so Telegram continues to find Gateways first; WhatsApp setup/relay/secret searches are covered too.
- Validation: `CI=1 bun run check` passed (258 files; 2,508 tests passed, one skipped), followed by
  successful desktop staging and bundled desktop smoke. The web build passed. No real Meta account,
  relay deployment, provider messages or model calls were used for this slice.
- Added explicit paused restoration of the original WhatsApp relay after installation, epoch,
  cursor or envelope connection holds. The safe preview exposes only a hold time and opaque
  revision. Settings confirms the restoration before the exclusively owned local route reads
  status at the saved origin with the saved pull key. The original installation/business/phone,
  epoch and local cursor or exact pending ACK position must match, with no remote gap. Changed
  settings, credentials, local receipts or saved work invalidate the check; no replacement pairing,
  administrative call, lease claim, pull or ACK is performed.
- A matching check atomically records the old hold and observed cursor in a bounded restoration
  audit, then clears only the connection hold. It keeps the cursor, pending ACK, signed identity
  mappings and retired aliases, source dedupe, files, native operations and confirmed/uncertain
  delivery state. Existing work stays held, the instance stays paused, and WhatsApp stays unavailable.
  A full history refuses another review instead of evicting evidence. A non-gap hold with a remote
  gap still requires the original queue/receipt position restored; gap review cannot override it.
- Added restoration coverage for all hold reasons, foreign metadata, unexplained cursor advances,
  stale/double/replayed restoration confirmations, mid-check changes, ownership, partial setup, failed writes,
  audit limits, retired aliases, preserved sent/uncertain replies and guarded local API access.
  Local consumer fixtures prove lost ACK recovery before/after remote commit still needs the exact
  envelope ID and leaves earlier work held; an invalid signed envelope remains invalid after review.
  Bun/Node and read-only bundled proof now also restores the original relay across local restart.
  README, guide and relay instructions include the user flow and a restored-deployment example.
- A scoped finish reviewer approved the restoration panel and confirmation with no material findings
  in light/dark desktop/mobile captures. A local keyboard probe kept six successive Tab presses
  inside the confirmation and Escape closed it. Preview used only isolated synthetic state, with no
  remote check submitted, then removed that state. The review does not establish live restoration
  or transport readiness; success behavior is covered by source/DOM and local protocol tests.
- Validation: `CI=1 bun run check` passed (258 files; 2,536 tests passed, one skipped). One earlier
  full run found a Discord fixture with no test socket; all 76 Discord tests and the full rerun
  passed without a source change. The web build, desktop staging and bundled desktop smoke passed.
  No real account, relay deployment or provider messages were used.
- Added explicit lost-relay replacement on the same instance, business account and phone. The
  safe preview exposes only an opaque revision and retired-binding count. Settings requires the
  old relay revoked or permanently stopped and its queue loss reviewed, then exchanges one new
  code with the same bounded HTTPS pairing client. A requesting marker saves before exchange;
  the new key and received receipt save atomically. Unknown outcomes require revoking the new
  pairing before review; the code is never reused or saved and the old pull key is not restored.
- Replacement intentionally has a separate finish confirmation. Its revision includes current
  settings and work, so changed work requires a fresh review after the key has been safely saved.
  Finish makes no network request: it atomically archives the old relay state and binds a new,
  never-before-used epoch, retaining original event IDs, dedupe and charged byte accounting. The
  previous cursors, pending ACKs, identity mappings, gaps and audits remain private evidence. A
  crash after that commit can finish the received key idempotently without archiving twice. Up to
  100 prior bindings are retained without eviction; a full history refuses replacement.
- Archived source requests cannot authorize work, file I/O or sending through the new epoch, even
  if they were confirmed before replacement. Unconfirmed old batches stay unconfirmed when a new
  sequence has the same number. Old unstarted requests can be dismissed explicitly without losing
  their replay protection. Native operations, sent prefixes and uncertain delivery state remain;
  replacement neither cancels nor repeats native agents. An already initialized SDK adapter is
  also pinned to its original relay epoch.
- Fresh signed messages after the finish boundary create separate private conversations with the
  same project and Brain/team/agent target. Older messages and identity notices are ignored before
  learning aliases. Active aliases require new signed phone proof; retired IDs stay tombstones.
  An unproven alias no longer advances its verification time and blocks a later phone proof in the
  same provider second. Receipts remain gated until the new relay confirms their exact envelope ID.
- Added replacement, crash/write-failure, stale finish, ownership, archive-limit, foreign/reused
  epoch, delayed-input, alias, duplicate, old-ACK, native-work/reply-prefix and local API guard tests.
  DOM tests cover both confirmations, cancel, disabled/full states and unknown outcomes. The
  Bun/Node and read-only bundle proof replaces a relay across restart, preserves old receipts,
  admits a fresh separate conversation and refuses a stale SDK send before provider I/O. README,
  guide and relay instructions include the flow, its limits and a lost-deployment example.
- A scoped finish review approved the entry, form, both confirmations and saved-key state at
  desktop/mobile sizes, plus the dark mobile state, with no material findings. A six-Tab keyboard
  probe stayed in the finish confirmation and Escape closed it. Browser confirmations were
  cancelled; only synthetic local setup was seeded and later removed. Unknown/error/archive states
  have source and DOM evidence; no live provider or transport readiness is claimed.
- Validation: `CI=1 bun run check` passed (259 files; 2,557 tests passed, one skipped). Web build,
  desktop staging and bundled desktop smoke passed. No real account, deployment, provider message
  or model call was used to exercise replacement.
- Added local WhatsApp sender status and explicit review of confirmed signed identity changes.
  Settings → Review senders lists allowed phones as missing proof, verified, needs review or
  reviewed, plus saved-request counts and aggregate retired/unproven/unallowed counts. Provider
  IDs, parent IDs, business IDs, relay metadata, keys and raw bodies stay private. Edit allowed
  phones and Open inbox connect the review to existing policy/work controls.
- A sender review requires pause, a fully saved pairing/pull key, resolved relay recovery, an exact
  confirmed ACK, an allowed phone and verified current association after a recorded change. It
  never restores an alias, edits the guard or transfers permission to a new number. The current
  settings/work/identity revision and explicit fresh-conversation acknowledgement are checked
  under exclusive state/account ownership. No network, claim, pull, ACK, file/model work or send
  occurs. Missing proof, stale/replayed confirmation and a full 1,000-entry audit fail closed.
- The review atomically holds earlier requests/files/unsent replies and records the association
  fingerprint, time and prior input sequence. A fresh signed message after review gets a distinct
  private conversation with the same project/Brain/team/agent; delayed input is ignored. Earlier
  source requests stay blocked even if a provider timestamp was ahead of the local clock. Native
  operation IDs and sent/uncertain delivery evidence remain, and native agents keep their ordinary
  controls. Other allowed phones keep their existing histories. Normal message timestamps do not
  invalidate a reviewed association; a later identity change needs another review. Replacement
  archives the sender reviews with the old relay instead of carrying their authority forward.
- Added local status/privacy, exact ACK, pause/pairing/hold/phone gates, stale/double confirmations,
  atomic failure, ownership, audit-limit, future-clock native-work/reply and per-phone isolation
  tests. DOM tests cover discovery/back, all sender states, confirmation, cancel, navigation/error
  and no automatic mutation. Bun/Node and read-only bundle proof now reviews a signed rotation
  across restart and admits only a fresh separate conversation without provider sends or a model.
  README, guide and relay instructions include same-phone rotation and new-number examples.
- Testing also exposed dismissed requests still blocking later text/file replies in the same
  binding. Delivery now skips these already settled unstarted requests, matching work dispatch;
  regression coverage verifies later text and file claims while retaining the dismissed receipt.
- A scoped finish review approved the sender panel, four status states, navigation and confirmation
  in light/dark desktop/mobile captures, with no material findings. A six-Tab probe stayed in the
  confirmation and Escape closed it. Only isolated synthetic state was used and removed; browser
  review submission was cancelled. Error/empty/success states have source and DOM evidence, without
  a live-provider correctness or transport-readiness claim.
- Validation: `CI=1 bun run check` passed (261 files; 2,575 tests passed, one skipped). The web
  build, desktop staging and bundled desktop smoke passed. No real account, deployment, provider
  message or model call was used to exercise sender review.
- Paused delivery review now records an operator-confirmed remote message/file ID for one attempted
  uncertain text part, outgoing file or advisory notice. The review is bound to the exact event,
  target and current journal/configuration revision. Pending, failed, unattempted and already sent
  parts cannot be promoted. Native work must already have a completed saved answer; no provider or
  model call is made. Local review remains possible after sender permission or relay changes.
- An explicit **Finish delivery locally** action permanently closes the remaining delivery while
  preserving original statuses, uncertainty, confirmed parts, native IDs and byte reservations.
  Closed receipts cannot retry, select or skip files, send notices, or reopen delivery. Schedulers
  let later messages continue in the binding after other holds are resolved. Source changes and
  restart recovery keep closed evidence intact. Normal cleanup retains replay and quota markers.
- **Review delivery** in the inbox opens a dedicated Settings section using the existing shared
  controls, showing the original source, pinned destination and per-item receipts. Interrupted
  sends require an explicit local recovery action for the selected completed answer; GET stays
  read-only. Both recovery and review drain the worker and take exclusive account/state ownership
  while paused, including unavailable WhatsApp, without constructing a transport.
- The offline WhatsApp media proof now records an old
  sender's uncertain delivery locally, closes a new saved answer, survives restart and checks that
  provider calls, native work and delivery evidence are unchanged. WhatsApp remains unavailable.
- A scoped finish reviewer approved the delivery panel and both confirmations in eleven
  light/dark desktop/mobile captures, with no blocking findings. Six Tab presses stayed in the
  local-finish confirmation and Escape closed it. Only isolated synthetic state was used and
  removed; both browser submissions were cancelled. DOM tests supply the empty/error/success,
  stale review and closed-state evidence; no real-provider correctness claim is made.
- Validation: `CI=1 bun run check` passed (263 files; 2,603 tests passed, one skipped). The web
  build, desktop staging and bundled desktop smoke passed. An earlier full run hit an ownership-port
  collision in the isolated Bun proof; its focused rerun passed without changing ownership guards.
  A later full run was interrupted by confirmed system sleep and timed out across unrelated suites;
  a fresh complete run with idle-sleep prevention passed. No real account, deployment, provider
  message or model call was used to exercise delivery review.
- Telegram instances now offer **Set up Telegram** with local status, an explicit paused bot/webhook
  check and a separately confirmed switch to polling. `getMe` must match the saved numeric bot ID;
  full webhook settings and current configuration/token are rechecked before removal. The browser
  and private setup receipts keep only the host, queue count and opaque fingerprints, never the
  full URL, credentials, query/path or raw provider errors. Opening/reloading makes no provider call.
- Switching requires acknowledgements that the previous integration is stopped and pending updates
  will be kept. An atomic private intent precedes one `deleteWebhook` request with
  `drop_pending_updates: false`; a fresh identity/webhook check must verify the result. The instance
  remains paused. There is no polling, intake, download, send or model work during setup; native
  operations, inbox receipts and byte reservations stay untouched. Connect still refuses webhooks
  and keeps the SDK's automatic deletion disabled. [Telegram's API](https://core.telegram.org/bots/api#deletewebhook)
  has no atomic compare/delete operation, so stopping the previous integration remains necessary.
- Interrupted switches and uncertain responses survive restart and block adapter initialization
  before any provider request. Only an explicit paused check can verify no webhook remains; a
  remaining or changed webhook requires a fresh check and confirmation. Checks expire after ten
  minutes or any configuration/token change, old confirmations cannot replay, and the bounded
  100-attempt history is never evicted. Account and state ownership drain the worker for both
  checks and switching; write failures before intent prevent remote mutation.
- The Bun/Node and read-only bundle proof now switches a local fake Telegram webhook, keeps its
  pending count, survives state restart and verifies that only setup methods ran. Server tests cover
  identity, pause, source/configuration/URL changes, lost outcomes, strict request bodies, failed
  writes, bounded responses, redaction, ownership and audit capacity. API/DOM tests cover request
  guards, deep links, loading/check states, confirmation, cancellation, unmount, pause and reload.
  A scoped finish reviewer approved ten light/dark desktop/mobile captures of the setup, held
  switch and confirmation, with no blocking findings. Six Tab presses stayed in the confirmation;
  Escape closed it. Only isolated synthetic saved state was used and removed; no browser provider
  check or switch was submitted. Empty/error/success/pause states have source and DOM evidence,
  without a live-provider correctness claim.
- Validation: `CI=1 bun run check` passed (265 files; 2,624 tests passed, one skipped). The web
  build, desktop staging and bundled desktop smoke passed. The final request-format review keeps
  Telegram's token separator while escaping URL path/query characters, with regression coverage.
  No real account, deployment, provider mutation, message or model call was used to exercise setup.
- Added paused **Review saved work → Keep work in Athena** for a reserved or started request
  without a final gateway reply. The operator explicitly acknowledges possibly running native
  work, no gateway reply, and a separate future private conversation. This permanently closes
  gateway tracking, reconciliation, file selection and future delivery for that request, without
  cancelling, completing, approving or replaying native work. Original operation/dispatch IDs,
  inputs, saved files, notices, delivery uncertainty and byte reservations are retained unchanged.
- The review is bound to the selected event and exact settings/journal revision, drains the
  worker, and claims exclusive account/state ownership while paused. It makes no provider or
  native-runtime call and also works for unavailable platforms or revoked old access. A selected
  interrupted receipt requires explicit local recovery; GET only reads saved evidence. The UI
  clearly distinguishes saved native receipts from a live status check and keeps native IDs in
  a disclosure, alongside the original source and destination.
- Keeping work holds earlier queued input and unsent output in the same external conversation
  lineage. Newly accepted messages use a fresh private binding under current routing/guards, so
  an old possibly running native chat/team/Brain operation cannot become the next request's
  context. Other conversations/threads and separate route, relay and sender-review generations
  are untouched. Old edits and late grouped album parts stay in the old binding. Dedupe still
  returns the original receipt; no old source is admitted a second time. Successive reviews keep
  a monotonic action order and validated binding roots, independent of original input order.
- Kept work does not consume active dispatcher slots, emit more notices, reenter tracking or
  accept late native completion callbacks. Its original saved status is preserved rather than
  invented completion. Normal cleanup retains these review/routing markers and their old held
  context for recovery; resolved work in a fresh binding can still be cleaned normally, retaining
  replay/quota markers and stable future routing.
- Added server coverage for Brain/agent/team and Slack/Discord isolation, paused and stale/body
  guards, source edits and albums, preserved native runs/chats, no old callbacks or admissions,
  local receipt recovery, revoked access, repeated reviews, cleanup and forged roots, atomic saves,
  ownership and stop-failure redaction. API/DOM checks cover request guards, private metadata,
  exact confirmation, pause, history, cancellation, stale errors and unmount. The signed WhatsApp
  Bun/Node/read-only bundle proof now keeps native work locally across restart and admits only a
  new private request, without provider calls, sends or model work. WhatsApp remains unavailable.
- A scoped finish reviewer approved twelve light/dark desktop/mobile captures of saved native
  work, reservation-only work, the ID disclosure and irreversible confirmation, with no material
  findings. Six Tab presses stayed in the confirmation and Escape closed it. Only isolated
  synthetic state was used and removed; the browser confirmation was cancelled. Unshown
  empty/error/success/prepare states have source and DOM evidence, without a live-native or
  provider-readiness claim.
- Validation: `CI=1 bun run check` passed (267 files; 2,650 tests passed, one skipped). The web
  build, desktop staging and bundled desktop smoke passed. No real account, provider call,
  native cancellation/admission, message or model call was used to exercise keeping work local.
- Added the backend ledger for approved Telegram/Discord Outbox follow-ups, separate from native
  inbox answers. Review binds an explicit instance, project, post, real completed source message
  and exact bounded Unicode text parts to current credentials, sender access, scope and routing.
  Review exposes recipient addresses and an opaque revision, without source text or credentials.
  Changed review text or context requires a fresh review; repeated approval retains existing
  receipts and cannot replace the recipient or resend confirmed parts.
- Approved parts use the worker's exclusive state claim and serialized reply sender. Each part is
  saved as sending before provider I/O. Confirmed IDs and provider retry times survive restart;
  interrupted or unknown sends remain uncertain and do not retry automatically. A failed or held
  delivery blocks later approved sends in that binding while unrelated conversations can proceed.
  Instance, policy, source and credential changes hold unsent work, with another approval check
  immediately before provider POST, including after Discord's asynchronous recipient checks.
  Discord uses separate per-attempt Outbox nonces and retains its native claimed-reply guard.
- Unresolved approved sends protect their real source binding from inbox cleanup. Completion
  releases that protection but retains dedupe and confirmed delivery evidence. Private receipts
  reject foreign instances, inconsistent ordering, changed approval text and duplicate post keys;
  capacity and storage failures stop delivery rather than evicting evidence. Worker startup
  recovers interrupted receipts before opening transport. No new native request or run is created.
- Added local ledger and fake-provider adapter coverage for exact text/recipient review, partial
  success, rate limits, failed/uncertain outcomes, restart, stale authorization, credential changes
  during Discord preflight, unchanged native work, ordered bindings, cleanup and atomic saves.
  This is backend groundwork: HTTP/tools do not yet enqueue these approved sends. The Outbox
  recipient picker, approval/progress projection, paused delivery reconciliation and replacement
  of old global-token helpers/Connections forms remain to implement. No real account or external
  platform send was used; WhatsApp stays unavailable and Slack proactive sends are not enabled.
- Validation: `CI=1 bun run check` passed (268 files; 2,670 tests passed, one skipped), followed
  by the web build, desktop staging and bundled desktop smoke. An earlier full run hit the
  existing kernel ownership-port collision in a saved-work fixture before it opened state;
  the full rerun passed with the ownership guard unchanged.
- Connected Telegram/Discord Outbox drafts to the worker-owned delivery ledger. The guarded
  destination list contains only current-project, completed, still-allowed source conversations
  with confirmed native replies. No source text, private native answer or credentials is returned.
  Drafts can wait without a recipient; no instance is picked implicitly. Review saves selected
  instance/conversation and exact Unicode-safe parts, then returns a draft revision and explicit
  approval snapshot. Stale edits, another project/platform, changed access or source, and stopped
  owners refuse approval. Successful approval reports queued rather than delivered.
- The private approval is authoritative before the sender wakes; failed public-status saves
  cannot unlock an approved draft. Outbox GET projects per-part receipts, confirmed IDs, retry
  waits, held/failed/uncertain/sent states and local closure. Each private journal is read once per
  list request. Missing or corrupt committed receipts fail closed; draft edits, reject, return and
  remove cannot erase approved delivery evidence. Removed instances stay held with retained
  receipts rather than appearing queued. Native work and its inbox records are not rewritten.
- Added paused **Finish locally** for approved Outbox deliveries. The supervisor drains the worker,
  claims account and private state, recovers interrupted sends as uncertain, and requires a fresh
  receipt revision plus explicit no-send acknowledgement. Closure preserves confirmed IDs,
  remaining text, attempts and uncertainty, blocks all future sends from that post and releases
  its cleanup hold. Original-project receipts can be finished after an instance is rebound to
  another project; the action never follows the new route or starts native work.
- Outbox now offers **Gateway message**, separate instance/conversation pickers, saved draft
  review with full bot/chat/thread/source addresses and every text part, checkbox-gated approval,
  per-part delivery receipts and paused local finish confirmation. It distinguishes queued,
  sending, confirmed, uncertain, held and locally finished states. Cancellation does not approve;
  stale reviews and unmounted views cannot submit later. Original draft revisions are retained
  while editing, so another tab's changes cannot silently become the review baseline.
- Replaced Telegram/Discord Connections credential forms and implicit test sends with fresh
  Gateways setup links; Settings search and Station links now open Gateways. Old global tokens,
  chat IDs and Discord webhooks are not used for sends. X/Reddit account behavior stays separate.
  `gateway_draft` saves an unsent draft for the user's recipient choice. High-risk `telegram_send`
  and `discord_send` require explicit instance/source IDs and keep normal approval policy, with
  queued results in Outbox. `notify_user` is local-only; legacy external flags fail explicitly.
  Workflow notifications remain local and their Telegram option saves an unapproved Outbox draft.
- Added API/server/DOM checks for draft snapshots, no implicit recipient or old-secret fallback,
  owner/platform/project guards, concurrent edits, immutable approved receipts, partial progress,
  storage interruption, missing/corrupt evidence, paused exclusive closure, rebinding and removed
  instances, project-pinned tool sends, workflow drafts, cancelled/stale UI and modal unmount.
  An obsolete webhook-send fixture now checks that old gateway drafts stay unsent and isolated.
- A fresh scoped finish reviewer approved fourteen light/dark desktop/mobile captures of Outbox
  recipient review, uncertain parts, local finish confirmation and Connections setup links. Six
  Tab presses stayed in the review modal and Escape closed it. Both confirmations were cancelled;
  native inbox bytes stayed unchanged and the fake provider recorded zero writes. The isolated
  data/home/Chrome profile were removed. Unshown states have source and DOM evidence rather than
  real-account readiness claims. WhatsApp remains unavailable; Slack/WhatsApp proactive Outbox
  sends and Outbox manual confirmation/explicit retry remain to implement.
- A separate source-only finish review approved the Gateways and workflow wording corrections:
  follow-ups are reviewed in Outbox, and the workflow Telegram option creates a draft requiring
  recipient choice and approval. This does not extend the fourteen-capture visual evidence.
- Validation: `CI=1 bun run check` passed (270 files; 2,692 tests passed, one skipped). The final
  focused Outbox fixture passed all twelve tests after making its storage-failure path match
  Windows separators too. The web build, desktop staging and bundled desktop smoke passed.
  An earlier WhatsApp fixture hit the existing kernel ownership-port collision before state
  opened; its isolated rerun and the final full check passed with ownership checks unchanged.
- Added **Outbox → Review delivery** for approved Telegram/Discord posts. Opening reads saved
  recipient/text/part metadata without provider checks, state claims or receipt recovery. Closed,
  removed-instance and completed history remain readable; no configuration fingerprints, secrets
  or private native answers reach the view. Original recipient metadata is shared with send review.
- Paused **Recover interrupted receipts** drains the worker and claims account/private state before
  classifying the selected post's interrupted send as uncertain. Pause is checked again after
  asynchronous ownership acquisition. GET never performs this mutation, other posts keep their
  receipts, and stale revisions must be reloaded before recording or retrying.
- **Record confirmed delivery** requires an explicitly selected attempted uncertain part, its own
  messaging-app ID, a fresh receipt revision and acknowledgement that the operator checked the
  app. It records ID, time and attempt locally; pending, unattempted, failed and already-confirmed
  parts cannot be relabelled. Confirmed prefix IDs remain intact. A pending tail on that post is
  held until an explicit continuation; recording a result sends nothing and enables no instance.
- **Retry remaining delivery** requeues only the first unresolved failed/uncertain part and its
  original approved suffix, with duplicate-risk acknowledgement for an attempted send.
  **Continue remaining delivery** releases the pending tail after a local confirmation. Both keep
  confirmed parts, immutable text/recipient and existing attempt counts; actual send claims still
  increment attempts and use distinct transport nonces. The instance stays paused until enabled.
  Saved provider retry waits are not bypassed and ordinary already-queued work is not reapproved.
- Retry rechecks the exact original route, project, target, account, credentials, sender/scope rules,
  source messages, grouped album members and private-conversation review boundaries. Pure paused
  policy inspection never enables intake or transport. Changed or previously held destinations
  cannot be reopened by retry; local confirmation/finish remain available where appropriate.
  Native runs, inbox evidence, files and byte charges are not replayed or rewritten.
- Review history is bounded, revisioned and checked against part order, attempts, confirmed IDs and
  continuation holds. History and closure seals survive restart; contradictory records fail closed.
  Failed writes cannot clear a hold or queue work. Confirmation, retry and local finish each require
  fresh paused receipts under exclusive ownership; closed delivery remains permanent.
- Added API/server/DOM checks for paused and stale/body guards, explicit part selection, duplicate
  acknowledgement, preserved prefixes, continuation holds, recovery, ownership and pause races,
  source/credential/policy/route changes, albums, audit corruption, storage failure and late callbacks.
  The UI keeps upper receipt details and lower actions accessible in scrolling shared dialogs, with
  inline errors, cancelled confirmations, double-click/unmount guards and explicit paused results.
- A fresh scoped finish reviewer approved fourteen light/dark desktop/mobile captures of recovery,
  uncertain parts, local confirmation, held continuation and duplicate-warning dialogs. Six Tab
  presses stayed inside and Escape closed the dialog. In isolated synthetic state, real local APIs
  recovered a receipt, recorded a checked ID and queued continuation/retry without enabling the
  instance. The confirmed prefix and native inbox bytes stayed unchanged; the pending tail retained
  zero attempts and the retried part retained its prior single attempt. The preview recorded zero
  provider attempts, then its data/home/Chrome profile were removed. Unshown states have source and
  test evidence; this is not real-account delivery acceptance. WhatsApp remains unavailable.
- Final validation: `CI=1 bun run check` passed (272 files; 2,715 tests passed, one skipped),
  including closed-history projection after confirming a part and finishing locally. A WhatsApp
  recovery fixture failed once; its isolated 55-test rerun and the final full check passed with
  ownership checks unchanged. The web build, desktop staging and bundled desktop smoke passed.
- Gateway deletion now saves a versioned, credential-free retirement record before draining its
  worker. The record blocks intake, route capture, settings/credential edits and reconnects even
  if the raw setup file survives a failure. Only after worker shutdown and exclusive account/state
  claims does removal clear local credentials/pairing and the setup file. Worker shutdown retains
  confirmed and uncertain results; no native work, private journals, quotas or uploaded files are
  purged or replayed. Removal can preserve even unreadable SDK bytes without opening SDK state.
- Interrupted removal is retryable using the original ID. Pending accounts stay reserved even if
  the setup file was already removed. Completed removal is idempotent and cannot restore an old
  identity. Startup resumes valid incomplete removals under ownership; a broken retirement record
  remains blocked without delaying another instance's cleanup. Corrupt credential storage is
  refused rather than replaced with an empty store that could erase other accounts.
- Added read-only local APIs for safe retired identity metadata and validated saved inbox history.
  Reads never take ownership or rewrite/classify receipts, and normal active-instance APIs remain
  closed. Retirement metadata and native journals remain outside project exports/backups. Deletion
  clears local pairing only; it makes no relay administration or messaging-service request.
- Lifecycle/API fixtures cover all four platform records, token/pairing separation, worker drain
  and shutdown failure, in-flight uncertainty without native replay, account/state ownership,
  atomic-write/unlink failures, restart after setup removal, idempotence, corrupt journals/records
  and credential storage, independent cleanup and guarded DELETE. Product recovery controls for
  retired instances, legacy removed folders without retirement records and media retention remain
  pending; this backend slice adds no new screen or real-account delivery claim.
- Validation: `CI=1 bun run check` passed (273 files; 2,732 tests passed, one skipped). The web
  build, desktop staging and bundled desktop smoke passed. These checks used isolated local
  fixtures; no account was connected or revoked, and no provider message or relay request was sent.
- Added **Settings → Gateways → View removed instances**, with literal metadata search, bounded
  list/history rendering and stable `retired` deep links. Each instance's history shows its saved
  account/project/target, input, native operation/conversation IDs, answer, album linkage and separate
  text/notice/file outcomes. Confirmed IDs and historical in-flight/uncertain states stay intact.
  Long text scrolls within disclosures. The view grants no intake, send, native replay or reconnect.
- Unfinished retirement offers a shared confirmation naming the exact instance/account before
  retrying guarded DELETE. Cancel, duplicate clicks, selection changes and unmount cannot submit a
  different instance. Success refreshes metadata; storage/ownership failure keeps the connection
  blocked with a retryable inline error. Active setup stays separate. Read-only retired deep links
  load independently even when active credentials prevent the active listing from loading.
- Added DOM fixtures for GET-only discovery/history, independent deep links, original metadata and
  delivery IDs, cancelled/duplicate/unmounted removal, failure/reload, empty/missing records, long
  escaped content, search/paging and stale history responses after changing selection. Retired
  receipt reconciliation and permanent local-finish actions remain pending.
- A fresh scoped finish reviewer approved twelve light/dark desktop/phone captures covering the
  list, original history, lower text/notice receipts, unfinished removal and its shared confirmation.
  Six settled Tab samples stayed within the dialog; Escape closed it. A real local API exercise in
  isolated synthetic state finished an ownership-blocked removal, kept saved native inbox bytes
  unchanged and left remaining instances paused. It recorded zero external/provider attempts, then
  its server stopped and temporary data/home/Chrome profile were removed. The existing Settings
  shell's small phone overflow is also present with this view closed; target content fits. Unshown
  states have source/test evidence, not visual approval. This does not enable WhatsApp or establish
  real-account delivery acceptance.
- Final validation: `CI=1 bun run check` passed (274 files; 2,742 tests passed, one skipped).
  The web build, desktop staging and bundled desktop smoke passed. The existing running web
  watcher overlapped one manual build; its clean rerun and final desktop staging succeeded.
- Added removed-instance **Review local finish** for completed native answers and reserved/started
  native work. GET returns an opaque revision of the retirement identity and validated full journal,
  original source/target and saved operation/conversation IDs, plus current text/file/notice outcomes.
  It performs no ownership claim, receipt recovery, SDK opening, credential read or native-status check.
- Mutations require completed removal and exclusive account/private-state ownership, recheck the
  retirement after asynchronous claims, and validate the exact displayed revision and strict body.
  Selected-request recovery is a separate revisioned POST before closure. The same journal validator
  protects live and retired paths, including replay, quota, album and WhatsApp ACK evidence; no
  unavailable platform is enabled. Corrupt SDK or unrelated credential storage cannot force a reset.
- Completed delivery uses the existing permanent `deliveryFinished`/audit proof, including notice-only
  unresolved delivery. Started/reserved work uses the existing `workKept` proof and sequence cutoff;
  other saved requests in that conversation stay held. The live keep/recovery paths share the same
  small mutation helpers. The selected native operation/dispatch, original input, confirmed IDs,
  attempts, file charges, SDK state and unrelated Outbox receipts stay intact. Late callbacks cannot reopen tracking
  or delivery. Queued requests, edits and album members remain read-only evidence here.
- The Settings review shows original source/target, saved native IDs and individual delivery outcomes,
  explicit interrupted-receipt recovery, reloadable failures and permanent closure time. A shared
  confirmation names original chat/message/project and warns that native work may still run or
  uncertain delivery may already have arrived. Cancel, duplicate clicks, stale reads and unmount are
  guarded; this view grants no send, reconnect, native replay or manual-confirmation capability.
- Added server/API/DOM checks for source identity, fresh revisions/acknowledgements, atomic writes,
  ownership conflicts and recheck races, preserved evidence, strict WhatsApp relay proof, notice-only
  closure, Brain/agent/team native work, unknown admission, queued requests, late callbacks, corrupt
  SDK/credentials and UI cancellation/failure/reload. Synthetic archived fixtures exercise all four
  platform labels without establishing real-account delivery acceptance.
- A fresh scoped finish reviewer approved fourteen light/dark desktop/phone captures of original
  source/work IDs, interrupted receipt recovery, retained outcomes, native-work warnings, permanent
  closure and both confirmations. Six settled Tab samples stayed inside the confirmation; Escape
  closed it. In isolated synthetic state, real local UI/API actions recovered and closed delivery
  and native tracking. The confirmed prefix ID stayed intact, the pending tail kept zero attempts,
  the selected dispatches/inputs, file reservations, SDK bytes and unrelated Outbox bytes stayed
  unchanged, and a queued sibling stayed held without an operation. Remaining instances stayed
  paused. The preview recorded zero external/provider attempts, stopped, and its data/home/Chrome
  profile were removed. Unshown states have source/test evidence, not visual approval; this does
  not enable WhatsApp or establish real-account delivery acceptance.
- Final validation: `CI=1 bun run check` passed (276 files; 2,770 tests passed, one skipped).
  The web build, desktop staging and bundled desktop smoke passed.
- Next: finish retired Outbox closure and temporary-media retention, then
  remaining delivery/product controls and proactive platform coverage under the same approval policy.
  Real-account checks on all four platforms and Windows/Linux verification remain outstanding.
  Offline checks run in CI.

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
