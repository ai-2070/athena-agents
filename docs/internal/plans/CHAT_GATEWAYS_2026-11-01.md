# Chat SDK Gateways with files

*Plan, 1 November 2026. Foundation started 2 November; transports and product setup are not implemented.
New gateway data does not need a legacy compatibility layer.*

## Implementation status

- Added browser-safe instance and route types, global instance storage, separate server-only
  credential storage and Brain/team/agent validation in the configured project.
- Added account ownership checks, sender-guard and file-limit configuration validation, per-instance
  pause/delete, route generations and project-pinned execution helpers. Changed routes block stale
  queued work for review; they never redirect it. Deleted projects or targets pause the instance
  when its route is checked.
- These are internal foundation services only. No worker, transport, API routes or Settings UI is
  enabled yet. Sender validation here checks configuration, not inbound platform identities.
  WhatsApp configuration currently accepts canonical E.164 only; local-number parsing and verified
  business identity mapping remain to implement.
- Next: transport/media proof against pinned SDK packages, then durable inbox/delivery state and
  worker ownership. Real-account text/file checks on all four platforms remain outstanding.

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
