# WhatsApp webhook relay

A separate Cloudflare Worker receives Meta webhooks and keeps a durable queue for a paired Athena
installation. Athena's dashboard stays on `127.0.0.1`; no tunnel, public dashboard route or model
runtime runs here. SQLite-backed Durable Objects serialize queue changes across Worker replicas.

This is the relay foundation. Athena cannot pair or enable WhatsApp yet. Local signature verification,
exact phone guards, verified identity mappings and durable acknowledgement gates have offline
integration proof. The local Chat SDK adapter also checks the configured Meta phone/business account
and saves hash-verified private media. Replies, service-window checks, application transport wiring
and Settings controls are the next pieces. Deploying this Worker does not enable a gateway.

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
   cannot be recovered from the relay. The current Athena UI does not perform this step yet.
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
Pairing/setup UI, explicit recovery controls and application worker integration remain pending;
WhatsApp is still unavailable in Athena. No consumer operation calls the relay's administrative
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
