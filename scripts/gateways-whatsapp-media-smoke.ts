// Local Meta API fixture and private state only. No provider account or messages are used.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Chat } from 'chat';
import type { Logger } from 'chat';

const proofRoot = process.env.ATHENA_WHATSAPP_MEDIA_PROOF_ROOT;
if (!proofRoot) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-whatsapp-media-'));
  const home = path.join(temporary, 'home'); const data = path.join(temporary, 'data'); fs.mkdirSync(home); fs.mkdirSync(data);
  try {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      env: { ...process.env, ATHENA_WHATSAPP_MEDIA_PROOF_ROOT: temporary, HOME: home, USERPROFILE: home, DASH_DATA: data }, stdio: 'inherit', timeout: 15000,
    }); assert.equal(child.status, 0, 'WhatsApp media proof child failed');
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
} else {
  assert.match(path.basename(proofRoot), /^athena-whatsapp-media-[a-zA-Z0-9]+$/);
  assert.equal(fs.realpathSync(path.dirname(proofRoot)), fs.realpathSync(os.tmpdir()));
  assert.equal(process.env.HOME, path.join(proofRoot, 'home')); assert.equal(process.env.USERPROFILE, process.env.HOME);
  assert.equal(os.homedir(), process.env.HOME); assert.equal(process.env.DASH_DATA, path.join(proofRoot, 'data'));
  await proof();
}

async function proof(): Promise<void> {
  const { WhatsAppGatewayAdapter } = await import('../server/gateways/whatsapp.ts');
  const { WhatsAppRelayIntake } = await import('../server/gateways/whatsapp-intake.ts');
  const { GatewayInbox } = await import('../server/gateways/inbox.ts');
  const { GatewayStateAdapter } = await import('../server/gateways/state.ts');
  const { GatewayFileProcessor } = await import('../server/gateways/files.ts');
  const { saveGatewayInstance, withGatewayRoute } = await import('../server/gateways/instances.ts');
  const { listProjects, saveProjects, setActiveProject } = await import('../server/store.ts');
  const { uploadsRoot } = await import('../server/uploads.ts');
  const quiet: Logger = { child: () => quiet, debug() {}, info() {}, warn() {}, error() {} };
  const business = '9000000001'; const phone = '9200000001'; const fileId = '9300000001'; const actor = '436641234567';
  const appSecret = 'FAKE_WHATSAPP_APP_SECRET'; const token = 'FAKE_WHATSAPP_ACCESS_TOKEN'; const digest = crypto.createHash('sha256').update('hello').digest('hex');
  const firstProject = listProjects()[0]; const instance = saveGatewayInstance({
    name: 'WhatsApp media proof', platform: 'whatsapp', accountId: phone, projectId: firstProject.id, target: { kind: 'brain' },
    senderPolicy: { platform: 'whatsapp', allowedPhones: [`+${actor}`] }, scope: { directMessages: true, conversationIds: [], guildIds: [] },
    fileLimits: { perFileBytes: 1024, perMessageBytes: 2048, filesPerMessage: 2, dailyBytes: 4096 }, enabled: true,
  });
  const state = new GatewayStateAdapter(instance.id); await state.connect(); const inbox = new GatewayInbox(state); const epoch = crypto.randomUUID();
  inbox.bindWhatsAppRelayConnection({ origin: 'https://relay.example', installationId: crypto.randomUUID(), businessAccountId: business, phoneNumberId: phone, epoch }, 0);
  let origin = ''; let downloads = 0; const errors: unknown[] = []; const calls: string[] = [];
  const server = http.createServer((request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://fixture'); calls.push(url.pathname);
      assert.equal(request.method, 'GET'); assert.equal(request.headers.authorization, `Bearer ${token}`);
      let result: unknown;
      if (url.pathname === `/v25.0/${phone}`) result = { id: phone };
      else if (url.pathname === `/v25.0/${business}/phone_numbers`) result = { data: [{ id: phone }] };
      else if (url.pathname === `/v25.0/${fileId}`) result = { id: fileId, messaging_product: 'whatsapp', file_size: 5, mime_type: 'text/plain', sha256: digest, url: `${origin}/file` };
      else if (url.pathname === '/file') { downloads++; assert.equal(request.headers['accept-encoding'], 'identity'); response.writeHead(200, { 'content-type': 'text/plain', 'content-length': '5' }); response.end('hello'); return; }
      else throw new Error('Unexpected Meta fixture request');
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(result));
    } catch (error) { errors.push(error); response.writeHead(500); response.end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); assert.ok(address && typeof address !== 'string'); origin = `http://127.0.0.1:${address.port}`;
  const adapter = new WhatsAppGatewayAdapter(instance.id, inbox, { businessAccountId: business, accessToken: token, appSecret }, { testOrigin: origin });
  const chat = new Chat({ userName: 'Athena', adapters: { whatsapp: adapter }, state, logger: quiet });
  const processor = new GatewayFileProcessor(instance.id, inbox, (...args) => adapter.downloadFileSource(...args), new AbortController().signal);
  try {
    await chat.initialize(); assert.equal(adapter.botUserId, phone); await processor.start();
    const second = { ...firstProject, id: 'whatsapp-proof-other', name: 'Other' }; saveProjects([...listProjects(), second]); setActiveProject(second.id);
    const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: business, changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp', metadata: { phone_number_id: phone }, messages: [{ id: 'wamid.media', from: actor, timestamp: '1700000000', type: 'document',
        document: { id: fileId, mime_type: 'text/plain', filename: '../../proof.txt', sha256: Buffer.from(digest, 'hex').toString('base64') } }],
    } }] }] });
    const bodyBase64 = Buffer.from(raw).toString('base64');
    const intake = new WhatsAppRelayIntake(instance.id, inbox, business, appSecret);
    await intake.receive(epoch, { sequence: 1, id: crypto.createHash('sha256').update(bodyBase64).digest('hex'), receivedAt: Date.now(), expiresAt: Date.now() + 60000,
      bodyBase64, signature: 'sha256=' + crypto.createHmac('sha256', appSecret).update(raw).digest('hex'), contentType: 'application/json' }, async (receipt) => {
      await processor.wake(); assert.equal(downloads, 0); assert.ok(!calls.includes(`/v25.0/${fileId}`)); assert.equal(inbox.claimNext(), null);
      return { epoch: receipt.epoch, cursor: receipt.sequence };
    });
    await processor.wake(); const event = inbox.list()[0]; const saved = event.files![0];
    assert.equal(event.status, 'queued'); assert.equal(saved.sha256, digest); assert.equal(downloads, 1);
    assert.equal(fs.readFileSync(saved.file!.path, 'utf8'), 'hello');
    assert.ok(fs.realpathSync(saved.file!.path).startsWith(fs.realpathSync(withGatewayRoute(event.route, uploadsRoot)) + path.sep)); assert.equal(event.route.projectId, firstProject.id);
    assert.equal((await adapter.handleWebhook(new Request('https://dashboard.test/webhook'))).status, 404);
    const count = calls.length; await assert.rejects(adapter.postMessage(adapter.encodeThreadId({ phoneNumberId: phone, userWaId: actor }), 'never'), /saved WhatsApp reply/);
    await assert.rejects(adapter.downloadMedia(fileId), /resend/); assert.equal(calls.length, count); assert.deepEqual(errors, []);
    console.log('gateways: WhatsApp SDK account checks, ACK-gated private media, signed hash and bound project pass');
  } finally {
    await processor.stop(); await adapter.disconnect(); await chat.shutdown(); await state.disconnect();
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
