// The hosted Worker runs in a local workerd process. No real Meta account or Cloudflare deployment.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { GatewayWhatsAppRelayEnvelope, GatewayWhatsAppRelayStatus } from '../shared/types.ts';

const suppliedRoot = process.env.ATHENA_WHATSAPP_RELAY_PROOF_ROOT;
if (!suppliedRoot) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-whatsapp-relay-'));
  const home = path.join(root, 'home'); const data = path.join(root, 'data'); const application = path.join(root, 'app');
  for (const directory of [home, data, application]) fs.mkdirSync(directory);
  const bundle = path.join(application, 'worker.mjs');
  const env = { ...process.env, ATHENA_WHATSAPP_RELAY_PROOF_ROOT: root, HOME: home, USERPROFILE: home, DASH_DATA: data };
  try {
    const build = spawnSync('bun', [path.resolve(import.meta.dirname, 'build-whatsapp-relay.ts'), '--outfile', bundle], { env, stdio: 'pipe', timeout: 20000 });
    assert.equal(build.status, 0, 'WhatsApp relay build failed'); fs.chmodSync(bundle, 0o444); fs.chmodSync(application, 0o555);
    // Miniflare's host uses Node; the Worker itself is runtime-independent and fully bundled.
    const runtime = process.versions.bun ? 'node' : process.execPath;
    for (const mode of ['write', 'read']) {
      const child = spawnSync(runtime, [fileURLToPath(import.meta.url), mode], { cwd: application, env, stdio: 'inherit', timeout: 20000 });
      assert.equal(child.status, 0, `WhatsApp relay ${mode} process failed`);
    }
    console.log('gateways: WhatsApp relay signed intake, process restart, commit-before-ack, replay, lease and revocation pass');
  } finally {
    fs.chmodSync(application, 0o755); if (fs.existsSync(bundle)) fs.chmodSync(bundle, 0o644); fs.rmSync(root, { recursive: true, force: true });
  }
} else {
  assert.match(path.basename(suppliedRoot), /^athena-whatsapp-relay-[a-zA-Z0-9]+$/);
  assert.equal(fs.realpathSync(path.dirname(suppliedRoot)), fs.realpathSync(os.tmpdir()));
  assert.equal(process.env.HOME, path.join(suppliedRoot, 'home')); assert.equal(process.env.USERPROFILE, process.env.HOME); assert.equal(os.homedir(), process.env.HOME);
  assert.equal(process.env.DASH_DATA, path.join(suppliedRoot, 'data')); await proof(suppliedRoot, process.argv[2]);
}

async function proof(root: string, mode: string | undefined): Promise<void> {
  assert.ok(mode === 'write' || mode === 'read');
  const { Miniflare, Log, LogLevel } = await import('miniflare');
  const business = '100000000000001'; const phone = '200000000000001'; const appSecret = 'FAKE_META_APPLICATION_SECRET'; const admin = 'a'.repeat(64);
  const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: business, changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp', metadata: { phone_number_id: phone }, messages: [{ id: 'wamid.proof', from: '436641234567', type: 'text', text: { body: 'Relay proof' } }],
  } }] }] });
  const signature = 'sha256=' + crypto.createHmac('sha256', appSecret).update(raw).digest('hex');
  const mf = new Miniflare({ modules: true, modulesRoot: path.join(root, 'app'), rootPath: root, scriptPath: path.join(root, 'app', 'worker.mjs'),
    compatibilityDate: '2026-07-30', durableObjects: { QUEUE: { className: 'WhatsAppRelayQueue', useSQLite: true } }, durableObjectsPersist: path.join(root, 'data', 'queue'),
    log: new Log(LogLevel.NONE), bindings: { BUSINESS_ACCOUNT_ID: business, PHONE_NUMBER_ID: phone, META_APP_SECRET: appSecret, META_VERIFY_TOKEN: 'FAKE_META_VERIFY_TOKEN', RELAY_ADMIN_KEY: admin } });
  const call = (route: string, body?: unknown, token?: string, lease?: string) => mf.dispatchFetch(`https://relay.test${route}`, { method: body === undefined ? 'GET' : 'POST',
    body: body === undefined ? undefined : JSON.stringify(body), headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(lease ? { 'x-relay-lease': lease } : {}) } });
  const webhook = () => mf.dispatchFetch('https://relay.test/webhooks/meta', { method: 'POST', body: raw, headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature } });
  const clientFile = path.join(root, 'data', 'client.json');
  try {
    if (mode === 'write') {
      const pairing = await call('/admin/pairing', {}, admin); assert.equal(pairing.status, 200); const { code } = await pairing.json() as { code: string };
      const pairedResponse = await call('/v1/pair', { code }); assert.equal(pairedResponse.status, 200); const paired = await pairedResponse.json() as GatewayWhatsAppRelayStatus & { token: string };
      const claimed = await call('/v1/claim', { epoch: paired.epoch, consumerId: crypto.randomUUID() }, paired.token); assert.equal(claimed.status, 200); const { lease } = await claimed.json() as { lease: string };
      assert.equal((await webhook()).status, 200); fs.writeFileSync(clientFile, JSON.stringify({ ...paired, lease }), { mode: 0o600 });
    } else {
      const client = JSON.parse(fs.readFileSync(clientFile, 'utf8')) as GatewayWhatsAppRelayStatus & { token: string; lease: string };
      const response = await call(`/v1/pull?epoch=${client.epoch}&after=0`, undefined, client.token, client.lease); assert.equal(response.status, 200);
      const { envelopes } = await response.json() as { envelopes: GatewayWhatsAppRelayEnvelope[] }; assert.equal(envelopes.length, 1); const event = envelopes[0];
      assert.equal(event.sequence, 1); assert.equal(Buffer.from(event.bodyBase64, 'base64').toString(), raw); assert.equal(event.signature, signature);
      // A local adapter must commit its receipt before this processing acknowledgement.
      fs.writeFileSync(path.join(root, 'data', 'receipt.json'), JSON.stringify({ id: event.id, sequence: event.sequence }));
      const ack = { epoch: client.epoch, through: event.sequence, eventId: event.id };
      assert.equal((await call('/v1/ack', ack, client.token, client.lease)).status, 200); assert.equal((await call('/v1/ack', ack, client.token, client.lease)).status, 200);
      assert.equal((await webhook()).status, 200);
      const empty = await call(`/v1/pull?epoch=${client.epoch}&after=1`, undefined, client.token, client.lease); assert.equal((await empty.json() as { envelopes: unknown[] }).envelopes.length, 0);
      assert.equal((await call('/admin/revoke', { acknowledgeDrop: true }, admin)).status, 200); assert.equal((await call('/v1/status', undefined, client.token)).status, 401);
    }
  } finally { await mf.dispose(); }
}
