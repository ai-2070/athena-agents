# WhatsApp webhook relay

A separate Cloudflare Worker receives Meta webhooks and keeps a durable queue for a paired Athena
installation. Athena's dashboard stays on `127.0.0.1`; no tunnel, public dashboard route or model
runtime runs here. SQLite-backed Durable Objects serialize queue changes across Worker replicas.

This is the relay foundation. Athena cannot enable WhatsApp yet. Local signature verification,
exact phone guards, verified identity mappings and durable acknowledgement gates have offline
integration proof. The local Chat SDK adapter also checks the configured Meta phone/business account
and saves hash-verified private media. Guarded replies and selected document uploads enforce the
service window. The application transport joins these pieces under the gateway worker, and a
paused-only Settings flow can pair a new instance, check its account and relay, finish interrupted
setup and review an observed retention gap. Unstarted held requests can be dismissed separately.
The original relay can be checked after restoration, or explicitly replaced while preserving its
receipts. The remaining work/delivery controls and acceptance checks are still pending.
Deploying this Worker does not enable a gateway.

Each deployment serves **one Meta Business app and one business phone**. Use a separate deployment
for each WhatsApp instance. An original webhook body may contain several entries; forwarding such a
body to another phone's installation would expose its messages. The relay therefore refuses any
signed body containing another business account/phone. The Meta app/account setup must deliver batches for this phone only. Separate endpoints alone do
not split a mixed-phone Meta subscription. Use dedicated provider setup for this topology and the
`messages` and `user_id_update` webhook fields. Other webhook fields are not supported by this version.

## Build and verify

From the repository root, with Bun 1.4+ and Node 22+:

```sh
bun install --frozen-lockfile
bun run relay:build
bunx vitest run tests/server/gateway-whatsapp-relay.test.ts
bun run gateways:whatsapp-relay-smoke
```

The smoke command builds a standalone Worker outside the checkout, makes its files read-only,
then starts two separate Node/workerd processes against a throwaway SQLite directory. It proves
signed intake survives a restart, repeats are deduplicated, processing acknowledgements remove
bodies and revocation invalidates the pull token. No real account, platform message or deployment
is used. Miniflare `4.20260730.0` is pinned for these tests; the deployment uses the same compatibility
date. Test-only SQL fault/expiry controls live in the test harness, never in the deployed Worker.

## Deploy

You need a Cloudflare account that supports SQLite-backed Durable Objects, a Meta Business app and
its business-account and phone-number IDs. Cloudflare hosting/storage costs are separate from Athena.
The CLI below is pinned; use Node 24.22 or newer for deployment. Run it from the repository root.

1. Copy or edit `relay/whatsapp/wrangler.jsonc`. Give the Worker a deployment name for this phone,
   and replace `BUSINESS_ACCOUNT_ID` and `PHONE_NUMBER_ID` with their numeric IDs. Keep the SQLite
   migration and binding. Use a new deployment/namespace for a different phone; the stored account
   is immutable and a mismatched configuration fails closed.
2. Check and deploy:

   ```sh
   bunx wrangler@4.156.2 deploy --dry-run --config relay/whatsapp/wrangler.jsonc
   bunx wrangler@4.156.2 deploy --config relay/whatsapp/wrangler.jsonc
   ```

   The dry run was verified locally. A real Cloudflare deployment and Meta account check remain
   pending. The new service refuses requests until its secrets are configured. It also refuses plain
   HTTP, browser-origin requests and unsupported routes. `/health` checks configuration/liveness and
   returns no account data.
3. Set three separate secrets through Wrangler's prompt. Do not put them into the checked-in file:

   ```sh
   bunx wrangler@4.156.2 secret put META_APP_SECRET --config relay/whatsapp/wrangler.jsonc
   bunx wrangler@4.156.2 secret put META_VERIFY_TOKEN --config relay/whatsapp/wrangler.jsonc
   bunx wrangler@4.156.2 secret put RELAY_ADMIN_KEY --config relay/whatsapp/wrangler.jsonc
   ```

   `META_APP_SECRET` is the app secret from Meta, at least 16 characters. Choose a verification token
   of at least 16 characters and an independent random admin key of at least 32 characters. The
   relay does **not** need a Meta access token, model-provider key or Athena credential.
4. Create a pairing code with `POST /admin/pairing`, using the admin key in an Authorization header.
   Pair it through `/v1/pair` before connecting Meta. Codes expire after ten minutes and work once.
   The pull token is returned only by that successful pairing response. Save it securely on the
   intended computer. A lost response needs an explicit administrative revoke/re-pair; the token
   cannot be recovered from the relay. In Athena, use **Settings → Gateways → Set up relay** to
   exchange the code and save the response privately; the local pairing API below does the same.
5. In Meta's webhook settings, use `https://<your-worker>/webhooks/meta` and the same verification
   token. Subscribe to `messages` for the configured business phone. GET verification echoes only
   a valid numeric challenge. Every POST must carry the valid `X-Hub-Signature-256` for its exact
   original bytes. Unpaired, full or unavailable queues return non-success, allowing Meta to retry.

For example, in Bash, after setting `RELAY_URL` and reading the admin key into `RELAY_ADMIN_KEY`:

```sh
curl --fail-with-body "$RELAY_URL/admin/pairing" \
  --header "Authorization: Bearer $RELAY_ADMIN_KEY" \
  --header 'Content-Type: application/json' --data '{}'
```

On PowerShell, the equivalent uses a hidden prompt:

```powershell
$relayUrl = 'https://your-worker.workers.dev'
$relayAdminSecure = Read-Host 'Relay admin key' -AsSecureString
$relayAdminToken = [System.Net.NetworkCredential]::new('', $relayAdminSecure).Password
Invoke-RestMethod -Method Post -Uri "$relayUrl/admin/pairing" `
  -Headers @{ Authorization = "Bearer $relayAdminToken" } -ContentType 'application/json' -Body '{}'
```

Keep admin, pairing, pull and lease credentials out of URLs and committed files. The admin key
manages this deployment; it is not the local consumer's pull key. Reissuing a pending code requires
`{"replacePending":true}` and still cannot replace a live pairing without explicit revocation.

## Protocol version 1

All non-verification responses are JSON with `Cache-Control: no-store`. Errors contain a safe code,
never raw bodies, database errors or credentials. No endpoint sends WhatsApp messages or downloads
media. Account IDs are strings throughout. These types live in `shared/types.ts`.

| Endpoint | Authorization and body | Result |
| --- | --- | --- |
| `GET /health` | None | Configuration/liveness only |
| `GET /webhooks/meta` | Meta's `hub.mode`, `hub.verify_token`, `hub.challenge` query | Challenge or refusal |
| `POST /webhooks/meta` | Meta signature, JSON, at most 1 MiB | 200 only after durable commit; duplicate bodies are accepted without requeueing |
| `POST /admin/pairing` | Admin bearer; `{}` or `{"replacePending":true}` | One-time code and its expiry |
| `POST /v1/pair` | `{"code":"…"}` | Installation/account IDs, epoch, current cursor, limits and a one-time pull token |
| `GET /v1/status` | Pull bearer | Queue counts, limits, epoch/cursor and any retention gap; no message bodies |
| `POST /v1/claim` | Pull bearer; `{"epoch":"…","consumerId":"<uuid>"}` | Exclusive 60-second lease, cursor and expiry |
| `GET /v1/pull?epoch=…&after=…&limit=20` | Pull bearer and `X-Relay-Lease` | Ordered envelopes and renewed lease |
| `POST /v1/ack` | Pull bearer and lease; `{"epoch":"…","through":1,"eventId":"<envelope-id>"}` | Acknowledges the delivered prefix; deletes its raw bodies |
| `POST /v1/release` | Pull bearer and lease; `{"epoch":"…"}` | Releases ownership without acknowledging content |
| `POST /admin/recovery` | Admin bearer; `{"epoch":"…","through":1,"acknowledgeGap":true}` | Explicitly accepts loss through the current gap and removes that queued prefix |
| `POST /admin/revoke` | Admin bearer; `{"acknowledgeDrop":true}` | Revokes keys/lease, changes epoch and deletes queued raw bodies |

Each envelope contains a sequence, stable body digest, receipt/expiry times, the exact original body
as base64, and the original signature and Content-Type values. Other HTTP headers are discarded.
The local adapter must independently verify those signed bytes, authorize the configured phone and
sender, and durably save its normalized receipt **before** acknowledging the relay. It must not
start native work from an unconfirmed relay acknowledgement. No model run belongs in a webhook
request. The relay cannot itself prove the computer committed a receipt; that is the local adapter's
contract. `server/gateways/whatsapp-intake.ts` and the application inbox implement this boundary.
The smoke proof bundles these local modules into read-only files and runs them across separate
processes against the real local Worker/SQLite runtime. It deliberately loses an ACK reply after
remote commit, verifies local work is still blocked, then retries the saved ACK after process restart.
No real provider account is used. `server/gateways/whatsapp-relay.ts` now implements authenticated
polling for explicitly paired instances. It pins the HTTPS origin, installation, business account,
phone and epoch in the private inbox and never follows redirects. Pull and lease keys stay out of
that journal. Status/claim/pull/ACK responses have bounded bodies, deadlines and versioned schemas.
The consumer processes ordered batches of at most 20, commits each receipt before ACK and confirms
lost ACK replies by matching the saved envelope ID at the relay, including after process restart.
A pending body not yet acknowledged remotely must be pulled again under the new lease before ACK.
Competing or expired leases wait for safe retry; a lost claim cannot silently take over its lease.

The consumer polls every five seconds after startup and stops on an error for its owner to handle;
retry errors carry a safe retry time where known. Shutdown aborts and drains the current request,
then attempts a bounded lease release before giving up local ownership. A retention gap, changed
epoch/account, unexpected cursor or invalid envelope saves a local review marker and holds queued
work and pending delivery. Polling, ACK confirmation and manual message retries cannot clear it.
Settings now provides initial pairing and explicit retention-gap review, and the application worker
integration has offline proof. Other recovery controls remain pending, so WhatsApp is still
unavailable in Athena. No consumer operation calls the relay's administrative
loss/revocation endpoints or advances a cursor just because status reported it.

Local identity checks accept a business-scoped user ID only after a signed message or its unique,
exactly matched provider contact ties that ID to an allowed phone. Contact cards, names, forwarded
metadata and parent IDs alone do not authorize a sender. Mappings are private to the instance,
business account and relay epoch and commit with the normalized batch receipt. Signed number/ID
changes retire old aliases and hold their queued work and pending delivery. A new number needs its
own allowlist entry and conversation; permission is never copied from the old phone. Conflicting
aliases stay blocked and bounded retired-ID records prevent delayed messages from restoring them.
An update without a usable signed timestamp, or an incomplete/ambiguous rotation, stops local intake
without ACK for later review. Recovery controls for these cases remain pending; WhatsApp stays
unavailable in the application worker. Subscribe the Meta app to both supported webhook fields.

The local `WhatsAppGatewayAdapter` pins the SDK/Graph API to `v25.0`, verifies the token's phone ID
and membership in the paired business account with read-only requests, and never follows paging
URLs. Its public webhook and default SDK sends/downloads are blocked; verified relay intake remains
the only inbound route. Account paging is bounded to ten pages of 100 and JSON responses to 64 KiB.

Incoming media keeps only the provider ID, name, MIME type and canonical signed hash in the inbox.
The local adapter checks that receipt and current sender/route before obtaining fresh metadata and
again while streaming. Metadata ID, MIME type, size and SHA-256 must agree with the saved descriptor;
HTTP headers, byte count and the completed binary digest are checked before the upload writer can
publish a file. Hex and canonical base64 provider hashes normalize to the same hex receipt. Older
media without a signed hash fails closed and needs a resend. Download URLs never enter the journal
or relay; the outbound Meta token only goes to the fixed Graph host and trusted Meta CDN families,
with HTTPS, no credentials in URLs, no redirects and a 45-second transfer deadline. Local fixture
origins are test-only constructor options. Current app limits can be lower than the provider limits:
images cap at 5 MiB, audio/video at 16 MiB, documents at the app's 20 MiB. Failed/incomplete bytes
stay unpublished and hold the assignment; retries keep the inbox's normal quota accounting.

Outgoing replies use the saved delivery ledger and check current phone permission, identity and
route before each request. A fresh confirmed user message for that same business phone/contact must
exist within 24 hours; an old replay or an unconfirmed relay receipt cannot open the window. Signed
timestamps are clamped to the first local receipt time so a future timestamp cannot extend it.
Parts retain the full plain answer, quote the original message and disable link previews. Every
part, advisory notice, document upload and final document send rechecks the window. Expiry asks for
a new message and an explicit retry in Athena; no template fallback is attempted.

Selected `.txt`, `.pdf`, `.doc`, `.docx`, `.xls`, `.xlsx`, `.ppt` and `.pptx` files send as documents,
with the app's existing regular-file/root/hash checks and 20 MiB ceiling (configured limits can be
lower). There are no captions, albums or native image/audio/video sends. Each file gets a single
multipart upload and then one contextual message with its returned media ID. If access or the
window changes during upload, the document is not posted; an authorized private upload may remain
at Meta under its own retention rules. Upload failures keep their quota charge and require explicit
retry unless Meta confirms a rate refusal. Unknown message POST outcomes are marked uncertain and
never resend automatically. HTTP 200 receipts must include one message ID and a matching recipient.
SDK default sends stay blocked, and reconnecting cannot reuse an old `sending` claim.

The local `whatsAppTransport` reads the outbound access token, Meta app secret (`signingSecret`)
and relay pull key (`relayKey`) from instance-scoped secrets. Its pinned business account and relay
origin come only from the saved pairing. It verifies the Meta account before claiming or pulling
the relay, then uses the shared inbox, file processor, dispatcher and reply ledger. Relay failures
abort the worker signal immediately, stopping new dispatch and file/delivery I/O. Already running
native agents keep their ordinary stop/recovery semantics. The worker drains delivery and files,
releases the remote lease, then releases SDK state and account ownership. Temporary outages honor relay retry times; invalid
credentials require setup, and gaps or changed pairing metadata require explicit recovery review.
Reconnect never clears a recovery marker or re-runs an interrupted assignment automatically.
The product availability gate remains closed pending the remaining recovery controls and acceptance checks.

### Settings setup and checks

In **Settings → Gateways**, add a WhatsApp instance with its own business phone ID, project,
Brain/team/agent destination and allowed phone numbers in full international form. Save its Meta
access token and app secret. Blank secret fields preserve saved credentials; the separate removal
controls never remove the relay pull key. Receiving and sending remain disabled.

Choose **Set up relay**, enter the HTTPS origin, business account ID and one-use code from the relay,
then review and confirm the starting position. The instance stays paused. An interrupted response
shows either **Finish saved pairing** or **Pairing outcome unknown**; follow the restoration or
explicit revocation steps below instead of reusing a code.

**Check setup** requires a paused, paired instance with credentials, allowed phones, direct messages
and an existing project/destination. It verifies the Meta phone and business-account membership with
bounded Graph `v25.0` GETs, then reads `/v1/status` from the saved relay. It checks the installation,
phone, account, epoch and cursor against local receipts, and reports ready, pending acknowledgement
or recovery needed. It saves no proof or intake changes, claims no lease, acknowledges no messages
and performs no file, model or delivery work. A changed setup invalidates the check. The app secret's
presence is checked; only signed webhook intake can prove the secret matches Meta. Connection will
repeat account verification, and a check never grants permission to enable or send.

The local endpoint is `POST /api/gateways/:id/whatsapp-setup/check`, with the normal `x-dash: 1` guard
and exclusive local state/account ownership. It returns only a check time, `account: "verified"` and
`relay: "ready"`, `"acknowledgement-pending"` or `"needs-review"`; credentials and relay metadata stay
private. **Check relay gap** and **Review gap locally** expose the explicit gap flow below, without
calling relay administration. Other holds require restoration rather than a gap reset.

### Local pairing API

Create and configure a paused WhatsApp instance before pairing. A new pairing requires an empty
instance: it cannot replace a saved relay, conversation receipts or identity history. It takes the
existing relay cursor as its starting point, so review any previous installation before continuing.
No model run, message, relay claim or acknowledgement is made by setup.

`POST /api/gateways/:id/whatsapp-pairing` uses the normal local `x-dash: 1` request guard and accepts:

```json
{
  "origin": "https://your-relay.example",
  "businessAccountId": "9000000001",
  "code": "<one-use 64-character lowercase hex code>",
  "acknowledgeStart": true
}
```

Only the code goes to the fixed `/v1/pair` path on that HTTPS origin. Redirects, URL credentials,
paths, queries and fragments are refused. The response must match the instance's phone and chosen
business account. Setup has a ten-second deadline and a 64 KiB response limit. It saves an attempt
before the request, then atomically saves the returned pull key and its receipt in private gateway
secrets. The code is never saved. A matching inbox binding follows; the instance stays paused.
Remote gaps remain held for review. Meta access-token verification happens in the explicit read-only
setup check and again on connection; pairing alone is not a successful Meta credential check.

`GET /api/gateways/:id/whatsapp-setup` returns only `paired`, `recoveryRequired` and a pending phase
with an opaque revision. Keys, account IDs and the private relay origin are omitted. If `pending.phase`
is `received`, send its current `revision` to `POST /api/gateways/:id/whatsapp-pairing/finish` to finish
the local save after fixing storage. This makes no network request and is safe across a crash after
the exact inbox binding was already saved. A pending attempt blocks credential replacement and
transport startup, so partially saved setup cannot be used.

If the phase is `requesting`, the remote outcome is unknown. No automatic retry or code reuse is
allowed. Revoke the pairing at the relay, explicitly reviewing its queue loss as described below.
Then `POST /api/gateways/:id/whatsapp-pairing/review` with the current `revision` and
`acknowledgeRemoteRevoked: true` permits a fresh pairing code. This acknowledgement does not itself
call the relay or verify an administrative revocation. It cannot discard a received key or replace
an existing local relay binding. All mutation routes require the instance to be paused and acquire
exclusive local state/account ownership. Stale revisions are refused.

A consumer must claim a lease before pulling. A second claim, even with the same consumer UUID,
is refused while the lease is active; pull/ack renew it. A lost claim response waits for lease expiry.
An acknowledgement must identify an envelope already delivered under that lease. Duplicate final
acknowledgements are idempotent. `after` must equal the relay's acknowledged cursor, so clients cannot
skip unseen bodies. A cursor mismatch requires reconciliation with the saved local receipts; do not
advance it blindly. A new lease must pull again before it can acknowledge an old delivery.

Body-hash dedupe covers exact webhook retries. Meta can batch a source message differently on a
later delivery; the local inbox must also dedupe the platform message ID. Pairing belongs to one
installation and its saved data. A new computer requires explicit revoke/re-pair and review of work
on the old computer, rather than copying credentials and starting another independent inbox.

## Retention and recovery

The defaults are 72 hours of unacknowledged content, 1,000 queued webhook envelopes and 16 MiB of
raw queued bytes. Replay hashes live for seven days, bounded to 10,000 entries; exhausting that
bound returns `503 relay_full` even after bodies were acknowledged. Request bodies are capped at
1 MiB; pull responses have at most 20 envelopes and a 2 MiB budget. Increase the documented numeric
limits for expected volume before deployment; never acknowledge a body that could not be stored.
Limits and each envelope's actual expiry are returned to the paired client. Changing retention
applies to newly accepted bodies; it does not rewrite existing expiry times.

Acknowledged bodies are deleted immediately from live storage. Alarms and request-time cleanup
expire old content and replay hashes. Expired unacknowledged envelopes record a durable retention
gap. Pull/claim stop with `410 retention_gap` until the operator checks the provider for missing
messages and explicitly reviews the current gap. Review advances past the affected prefix and
removes any remaining bodies through that cursor; it invalidates the old lease. It never silently
skips lost messages. The last 100 numerical administrative review/revocation records remain as a
bounded audit. A revoked relay refuses new webhooks until it has been paired again.

### Local review of an observed gap

Pause the instance, then `POST /api/gateways/:id/whatsapp-recovery/inspect`. This checks only
`GET /v1/status` at the saved origin with the saved pull key. It never claims, pulls, ACKs or calls
administrative endpoints. The exact installation, business phone, epoch and local receipt prefix
must still match. A real gap is saved locally with its lost range, and earlier work/delivery stays
held. Requests and response bodies are bounded to ten seconds and 64 KiB; provider details are not
returned. Setup must be fully saved before inspection.

`GET /api/gateways/:id/whatsapp-recovery` is a local-only preview: it returns the hold reason and,
when an observation exists, its date and opaque revision. It omits keys, origins, IDs and cursors.
The revision changes with the saved work or instance settings. After checking missing messages,
the relay operator must review that exact gap through `/admin/recovery`. Then send the current
revision and `acknowledgeGap: true` to `POST /api/gateways/:id/whatsapp-recovery`. The local action
checks a fresh authenticated status: the remote gap must be gone and its cursor must equal the
previously observed end. It refuses stale previews, changed ranges, new gaps, foreign identities
and epochs, and cursor advances without a saved observation. All local mutation routes use the
normal `x-dash: 1`/cross-site guards and exclusive state/account ownership.

The instance remains paused. The local cursor and audit commit atomically; identities, source
dedupe, files, native operation IDs and confirmed delivery prefixes are retained. A pending ACK
that the remote gap skipped is retained in the review audit. Its saved messages remain unconfirmed
and held for a resend; a status cursor never becomes proof of their exact envelope ID. New intake
can continue after explicit enable, but the existing conversation-order rule still blocks new work
behind unresolved earlier work or deliveries. Clearing a gap does not resolve those assignments,
retry a send or start another model run. Those product controls remain pending.

The local journal keeps up to 1,000 gap reviews without eviction; a full history refuses another
review. Non-gap receipt holds and identity/epoch changes use the restoration check below; accepting
an installation replacement uses its separate pairing flow below. Gap review cannot clear them, re-pair an existing inbox or replace
its private conversation history. A gap already skipped remotely without a prior local observation
also requires restoration rather than guessing the lost range.

### Check a restored original relay

After an installation, epoch, cursor or envelope fault, **Settings → Gateways → Set up relay** offers
**Restore the saved relay**. Restore the original deployment and its saved data at its saved HTTPS
origin, then choose **Check restored relay** and confirm. For example, if a deployment was accidentally
replaced, restore its original Durable Object data and pairing rather than creating another pairing
with a new installation ID. A revoked pairing cannot be recovered by this check.

`GET /api/gateways/:id/whatsapp-recovery` includes an optional `restoration` with the hold time and an
opaque revision. `POST /api/gateways/:id/whatsapp-recovery/restore` accepts that `revision` and
`acknowledgeRestore: true`. The local route uses the normal request guards and exclusive ownership.
It performs only the bounded, saved-origin `/v1/status` GET with the saved pull key; it never calls
administration, claims a lease, pulls or acknowledges messages. Instance settings, credentials and
local receipts must remain unchanged during the check, and a changed work journal invalidates the
confirmation. The installation, business account, phone and epoch must match exactly, with no gap.
The remote cursor must equal the local cursor or the exact pending receipt's sequence.

A matching check atomically records the previous hold and observed cursor, then clears only the
connection hold. It never changes the local cursor, confirms an ACK, rebinds a relay, restores a
retired sender alias, releases held work or retries a delivery. A pending ACK still needs the exact
envelope ID checked on connection; invalid signed bodies are still refused when pulled again. The
instance stays paused, and WhatsApp remains disabled. A full audit of 1,000 restorations refuses
another review instead of discarding older entries. A gap hold uses its separate review flow; a
non-gap hold with a new remote gap requires the original queue/receipts to be restored first.

### Replace a lost relay

If restoration is impossible, revoke or permanently stop the old relay and review its queue loss.
For example, after losing a deployment's Durable Object data, create a fresh deployment for the
same business account and phone, create a new one-use code, then choose **Replace relay** in Athena.
The origin and installation may change; the business account and phone may not. A revoke/re-pair on
the original installation also works with its new epoch. Current or previously archived epochs
cannot be reused. This action never calls relay administration on the user's behalf.

`GET /api/gateways/:id/whatsapp-replacement` returns only a current opaque revision and the number
of archived bindings. A `null` revision means no saved binding or a full history. Send that revision,
the new `origin`, `businessAccountId` and `code`, plus `acknowledgePreviousStopped: true` and
`acknowledgeLoss: true`, to `POST /api/gateways/:id/whatsapp-pairing/replace`. The normal local request
guards, pause requirement and exclusive ownership apply. A requesting marker saves before the
one-use exchange; the returned key and received receipt save together in private secrets. Codes
are never saved. An unknown outcome requires revoking the new pairing and explicitly reviewing
that attempt. The old pull key is not restored when the unknown attempt is cleared.

A received replacement is deliberately not finished automatically. Reload its saved preview, then
send the pending revision and `acknowledgeLoss: true` to `/whatsapp-pairing/finish`. The revision
includes the current instance and work journal, so changed work requires a fresh finish review.
This step makes no network request. It atomically archives the old relay state and binds the new
one; a crash before the private pending marker clears can finish idempotently after reloading.

The instance ID, project, destination, source dedupe and charged byte accounting remain. Old cursors,
pending ACKs, signed mappings, gaps, review audits and event receipts stay archived. They never
authorize new intake or delivery; an unconfirmed old batch stays unconfirmed even if a new sequence
has the same number. Unstarted old requests can still be explicitly dismissed, retaining dedupe.
Running native agents keep their ordinary controls; replacement does not cancel or repeat them.

Fresh signed messages after the finish boundary get new private conversation bindings. Older
messages and identity updates are ignored without learning aliases. Previously active aliases
lose their phone association and need fresh signed phone proof; retired aliases remain tombstones.
Senders should message again after finishing (messages in the finish second are conservatively
ignored). An already initialized SDK adapter also cannot operate across the epoch change. Old
files, native work, sent prefixes and uncertain deliveries cannot run or send through the new relay.
The history holds up to 100 prior relay states without eviction; a full history refuses replacement.
The instance remains paused and WhatsApp receiving/sending remain disabled.

The relay necessarily sees webhook content and holds Meta's verification secret. Use a deployment
whose operator you trust. The outbound Meta access token, model keys, files and dashboard sessions
stay on the computer. Raw content is removed from the live SQLite queue as described above;
Cloudflare's provider-level backups/PITR have their own retention (documented up to 30 days), so a
live deletion does not promise physical deletion from provider backups. Production traffic, account
setup, quotas and recovery still need real-provider acceptance tests.

References: [Meta's webhook verification reference](https://whatsapp.github.io/WhatsApp-Nodejs-SDK/api-reference/webhooks/start/)
(the reference SDK is archived), [SQLite Durable Object transactions and alarms](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/),
[storage and recovery boundaries](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/),
and [Miniflare persistence](https://developers.cloudflare.com/workers/testing/miniflare/storage/durable-objects/).
