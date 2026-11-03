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
import type { GatewayWhatsAppRelayStatus } from '../shared/types.ts';

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
  const { whatsAppTransport } = await import('../server/gateways/whatsapp-transport.ts');
  const { pairWhatsApp, checkWhatsAppSetup, replaceWhatsAppPairing, finishWhatsAppPairing, whatsAppSetup } = await import('../server/gateways/whatsapp-setup.ts');
  const { inspectWhatsAppRecovery, restoreWhatsAppRecovery, reviewWhatsAppRecovery } = await import('../server/gateways/whatsapp-recovery.ts');
  const { WhatsAppRelayIntake } = await import('../server/gateways/whatsapp-intake.ts');
  const { GatewayInbox, gatewayRequestReview, gatewayWhatsAppRecovery, gatewayWhatsAppReplacement } = await import('../server/gateways/inbox.ts');
  const { GatewayStateAdapter } = await import('../server/gateways/state.ts');
  const { GatewayFileProcessor } = await import('../server/gateways/files.ts');
  const { GatewayReplies } = await import('../server/gateways/replies.ts');
  const { gatewayConversation } = await import('../server/gateways/conversations.ts');
  const { selectGatewayDocuments } = await import('../server/gateways/outgoing.ts');
  const { ensureBrain } = await import('../server/projects.ts');
  const { saveGatewayCredentials, saveGatewayInstance, withGatewayRoute } = await import('../server/gateways/instances.ts');
  const { listProjects, saveProjects, setActiveProject } = await import('../server/store.ts');
  const { uploadsRoot } = await import('../server/uploads.ts');
  const quiet: Logger = { child: () => quiet, debug() {}, info() {}, warn() {}, error() {} };
  const business = '9000000001'; const phone = '9200000001'; const fileId = '9300000001'; const actor = '436641234567';
  const appSecret = 'FAKE_WHATSAPP_APP_SECRET'; const token = 'FAKE_WHATSAPP_ACCESS_TOKEN'; const digest = crypto.createHash('sha256').update('hello').digest('hex');
  const firstProject = listProjects()[0]; const config = {
    name: 'WhatsApp media proof', platform: 'whatsapp', accountId: phone, projectId: firstProject.id, target: { kind: 'brain' },
    senderPolicy: { platform: 'whatsapp', allowedPhones: [`+${actor}`] }, scope: { directMessages: true, conversationIds: [], guildIds: [] },
    fileLimits: { perFileBytes: 1024, perMessageBytes: 2048, filesPerMessage: 2, dailyBytes: 4096 }, enabled: false,
  }; const instance = saveGatewayInstance(config);
  const state = new GatewayStateAdapter(instance.id); await state.connect(); const inbox = new GatewayInbox(state); const epoch = crypto.randomUUID();
  saveGatewayCredentials(instance.id, { accessToken: token, signingSecret: appSecret });
  const relayLimits = { bodyBytes: 1048576, queueBytes: 16777216, queueEvents: 1000, replayEntries: 10000, retentionMs: 259200000, replayMs: 604800000, pairingMs: 600000, leaseMs: 60000, batchBytes: 2097152, batchEvents: 20 };
  const setup = await pairWhatsApp(inbox, { origin: 'https://relay.example', businessAccountId: business, code: 'c'.repeat(64), acknowledgeStart: true }, { request: async (url, init) => {
    assert.equal(url, 'https://relay.example/v1/pair'); assert.equal(init.redirect, 'error'); assert.equal(new Headers(init.headers).has('authorization'), false);
    assert.deepEqual(JSON.parse(String(init.body)), { code: 'c'.repeat(64) });
    return Response.json({ version: 1, installationId: crypto.randomUUID(), businessAccountId: business, phoneNumberId: phone, epoch, cursor: 0, gap: null, limits: relayLimits, queuedEvents: 0, queuedBytes: 0, token: 'a'.repeat(64) });
  } });
  assert.deepEqual(setup, { paired: true, pending: null, recoveryRequired: false }); assert.equal(instance.enabled, false);
  console.log('gateways: WhatsApp one-use pairing saves private keys and pins a paused instance');
  let origin = ''; let downloads = 0; let replyTo = 'wamid.media'; const errors: unknown[] = []; const calls: string[] = [];
  const posts: Record<string, unknown>[] = [];
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://fixture'); calls.push(url.pathname);
      assert.equal(request.headers.authorization, `Bearer ${token}`);
      if (request.method === 'POST') {
        const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); const bytes = Buffer.concat(chunks); let result: unknown;
        if (url.pathname === `/v25.0/${phone}/media`) {
          const form = await new Response(bytes, { headers: { 'content-type': request.headers['content-type']! } }).formData();
          assert.equal(form.get('messaging_product'), 'whatsapp'); assert.equal(form.get('type'), 'text/plain'); assert.equal(await (form.get('file') as Blob).text(), 'Proof output');
          posts.push({ upload: true }); result = { id: '9900000001' };
        } else {
          assert.equal(url.pathname, `/v25.0/${phone}/messages`); const body = JSON.parse(bytes.toString()) as Record<string, unknown>; posts.push(body);
          assert.equal(body.to, actor); assert.deepEqual(body.context, { message_id: replyTo });
          result = { messaging_product: 'whatsapp', contacts: [{ input: actor, wa_id: actor }], messages: [{ id: `wamid.out-${posts.length}` }] };
        }
        response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(result)); return;
      }
      assert.equal(request.method, 'GET');
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
  const beforeCheck = fs.readFileSync(state.inboxFile(), 'utf8'); const paired = inbox.whatsAppRelayState()!.connection!;
  const checked = await checkWhatsAppSetup(inbox, { testOrigin: origin, request: async (url, init) => {
    assert.equal(url, `${paired.origin}/v1/status`); assert.equal(init.method, 'GET'); assert.equal(init.body, undefined);
    assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${'a'.repeat(64)}`);
    return Response.json({ version: 1, installationId: paired.installationId, businessAccountId: business, phoneNumberId: phone, epoch, cursor: 0, gap: null, limits: relayLimits, queuedEvents: 0, queuedBytes: 0 });
  } });
  assert.equal(checked.account, 'verified'); assert.equal(checked.relay, 'ready'); assert.equal(fs.readFileSync(state.inboxFile(), 'utf8'), beforeCheck);
  console.log('gateways: WhatsApp paused setup checks verify account and relay without intake or writes');
  saveGatewayInstance({ ...config, enabled: true }, instance.id);
  const adapter = new WhatsAppGatewayAdapter(instance.id, inbox, { businessAccountId: business, accessToken: token, appSecret }, { testOrigin: origin });
  const chat = new Chat({ userName: 'Athena', adapters: { whatsapp: adapter }, state, logger: quiet });
  const processor = new GatewayFileProcessor(instance.id, inbox, (...args) => adapter.downloadFileSource(...args), new AbortController().signal);
  const signal = new AbortController().signal;
  const replies = new GatewayReplies(inbox, (event, text, signal) => adapter.replyText(event, text, signal), signal, () => true,
    (event, file, signal) => adapter.replyDocument(event, file, signal));
  try {
    await chat.initialize(); assert.equal(adapter.botUserId, phone); await processor.start();
    const second = { ...firstProject, id: 'whatsapp-proof-other', name: 'Other' }; saveProjects([...listProjects(), second]); setActiveProject(second.id);
    const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: business, changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp', metadata: { phone_number_id: phone }, messages: [{ id: 'wamid.media', from: actor, timestamp: String(Math.floor(Date.now() / 1000)), type: 'document',
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
    const claimed = inbox.claimNext()!; inbox.beginDispatch(claimed.id, claimed.operationId!, await gatewayConversation(claimed, signal));
    const selected = path.join(withGatewayRoute(event.route, ensureBrain), 'whatsapp-proof-result.txt'); fs.writeFileSync(selected, 'Proof output');
    await selectGatewayDocuments(inbox, event.id, { paths: [selected] }, signal);
    const answer = 'a'.repeat(2999) + '🧪' + 'b'.repeat(3500); inbox.finishDispatch(claimed.id, claimed.operationId!, answer);
    await replies.wake();
    assert.equal(posts.length, 5); assert.equal(posts.filter((post) => post.type === 'text').map((post) => (post.text as { body: string }).body).join(''), answer);
    assert.deepEqual(posts[4].document, { id: '9900000001', filename: 'whatsapp-proof-result.txt' });
    assert.ok(inbox.list()[0].reply!.parts.every((part) => part.status === 'sent')); assert.equal(inbox.list()[0].outgoing![0].status, 'sent');
    assert.deepEqual(errors, []); console.log('gateways: WhatsApp service-window replies and selected document upload pass');
    await replies.stop(); await processor.stop(); await adapter.disconnect(); await chat.shutdown(); await state.connect();
    saveGatewayCredentials(instance.id, { accessToken: token, signingSecret: appSecret, relayKey: 'a'.repeat(64) });
    replyTo = 'wamid.transport';
    const fresh = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: business, changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp', metadata: { phone_number_id: phone }, messages: [{ id: replyTo, from: actor, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'Transport request' } }],
    } }] }] });
    const envelopes = [raw, fresh].map((body, index) => {
      const bodyBase64 = Buffer.from(body).toString('base64');
      return { sequence: index + 2, id: crypto.createHash('sha256').update(bodyBase64).digest('hex'), receivedAt: Date.now(), expiresAt: Date.now() + 60000,
        bodyBase64, signature: 'sha256=' + crypto.createHmac('sha256', appSecret).update(body).digest('hex'), contentType: 'application/json' };
    });
    let cursor = 1; let leased = false;
    const connection = inbox.whatsAppRelayState()!.connection!;
    const metadata = () => ({ version: 1, installationId: connection.installationId, businessAccountId: business, phoneNumberId: phone, epoch,
      cursor, gap: null, queuedEvents: envelopes.length, queuedBytes: envelopes.length * 100,
      limits: relayLimits });
    const transport = whatsAppTransport(state, inbox, () => assert.fail('Unexpected transport disconnect'), signal, { testOrigin: origin, request: async (url, init) => {
      const address = new URL(url); assert.equal(address.origin, connection.origin); const headers = new Headers(init.headers);
      assert.equal(headers.get('authorization'), `Bearer ${'a'.repeat(64)}`); assert.equal(init.redirect, 'error');
      const body = typeof init.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {};
      if (address.pathname === '/v1/status') return Response.json(metadata());
      if (address.pathname === '/v1/claim') { assert.equal(leased, false); leased = true; return Response.json({ epoch, cursor, lease: 'b'.repeat(64), expiresAt: Date.now() + 60000 }); }
      assert.equal(headers.get('x-relay-lease'), 'b'.repeat(64));
      if (address.pathname === '/v1/pull') return Response.json({ ...metadata(), envelopes, leaseExpiresAt: Date.now() + 60000 });
      if (address.pathname === '/v1/ack') {
        const next = envelopes.shift()!; assert.equal(body.through, next.sequence); assert.equal(body.eventId, next.id);
        assert.equal(inbox.whatsAppRelayState()!.receipt!.confirmed, false); cursor = next.sequence; return Response.json({ cursor });
      }
      assert.equal(address.pathname, '/v1/release'); leased = false; return Response.json({ released: true });
    } });
    const connectedReplies = new GatewayReplies(inbox, transport.reply!, signal);
    try {
      await transport.start(); assert.equal(transport.alive(), true); assert.equal(cursor, 3); assert.equal(inbox.list().length, 2);
      assert.equal(inbox.list()[0].reply!.parts[0].status, 'sent'); assert.equal(posts.length, 5);
      const next = inbox.claimNext()!; assert.equal(next.input.sourceMessageId, replyTo);
      inbox.beginDispatch(next.id, next.operationId!, await gatewayConversation(next, signal)); inbox.finishDispatch(next.id, next.operationId!, 'Transport answer');
      await connectedReplies.wake(); assert.equal(posts.length, 6); assert.equal(inbox.list()[1].reply!.parts[0].status, 'sent'); assert.deepEqual(errors, []);
      console.log('gateways: WhatsApp paired transport reconnect, replay dedupe and guarded delivery pass');
    } finally { await connectedReplies.stop(); await transport.stop(); }
    assert.equal(leased, false);
    await state.connect(); saveGatewayInstance(config, instance.id);
    const remote: GatewayWhatsAppRelayStatus = { ...metadata(), version: 1, cursor: 3, gap: { at: Date.now(), through: 5 } };
    const check = { request: async (url: string, init: RequestInit) => {
      assert.equal(url, `${connection.origin}/v1/status`); assert.equal(init.method, 'GET'); assert.equal(init.body, undefined);
      assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${'a'.repeat(64)}`); return Response.json(remote);
    } };
    const work = JSON.stringify(inbox.list()); const mappings = JSON.stringify(inbox.whatsAppRelayState()!.identities);
    const observed = await inspectWhatsAppRecovery(inbox, check); assert.ok(observed.gap); assert.equal(observed.reason, 'gap');
    await state.disconnect(); await state.connect(); remote.cursor = 5; remote.gap = null;
    assert.deepEqual(await reviewWhatsAppRecovery(inbox, { revision: observed.gap.revision, acknowledgeGap: true }, check), { reason: null, gap: null });
    assert.equal(JSON.stringify(inbox.list()), work); assert.equal(JSON.stringify(inbox.whatsAppRelayState()!.identities), mappings);
    assert.equal(inbox.whatsAppRelayState()!.cursor, 5); assert.equal(inbox.whatsAppRelayState()!.reviewedGaps!.length, 1); assert.equal(posts.length, 6);
    console.log('gateways: WhatsApp saved gap review survives restart and keeps prior work intact');
    inbox.holdWhatsAppRelay('installation'); const heldWork = JSON.stringify(inbox.list());
    const restoration = gatewayWhatsAppRecovery(instance.id).restoration!; await state.disconnect(); await state.connect();
    assert.deepEqual(await restoreWhatsAppRecovery(inbox, { revision: restoration.revision, acknowledgeRestore: true }, check), { reason: null, gap: null });
    assert.equal(JSON.stringify(inbox.list()), heldWork); assert.equal(JSON.stringify(inbox.whatsAppRelayState()!.identities), mappings);
    assert.equal(inbox.whatsAppRelayState()!.cursor, 5); assert.equal(inbox.whatsAppRelayState()!.restorations!.length, 1); assert.equal(posts.length, 6);
    console.log('gateways: WhatsApp original relay restoration preserves receipts and held work');
    saveGatewayInstance({ ...config, enabled: true }, instance.id);
    const heldRaw = fresh.replace('wamid.transport', 'wamid.dismiss'); const heldBase64 = Buffer.from(heldRaw).toString('base64');
    await intake.receive(epoch, { sequence: 6, id: crypto.createHash('sha256').update(heldBase64).digest('hex'), receivedAt: Date.now(), expiresAt: Date.now() + 60000,
      bodyBase64: heldBase64, signature: 'sha256=' + crypto.createHmac('sha256', appSecret).update(heldRaw).digest('hex'), contentType: 'application/json' }, async (receipt) => ({ epoch: receipt.epoch, cursor: receipt.sequence }));
    const held = inbox.list()[2]; inbox.review(held.id); saveGatewayInstance(config, instance.id);
    const review = gatewayRequestReview(instance.id, held.id); assert.equal(review.canDismiss, true);
    inbox.dismissRequest(held.id, { revision: review.revision, acknowledgeDismiss: true }); await state.disconnect(); await state.connect();
    assert.ok(inbox.list()[2].dismissed); assert.equal(inbox.list()[2].operationId, undefined); assert.equal(posts.length, 6);
    saveGatewayInstance({ ...config, enabled: true }, instance.id); assert.equal(inbox.claimNext(), null);
    console.log('gateways: held request dismissal preserves its receipt without work or delivery');
    const staleAdapter = new WhatsAppGatewayAdapter(instance.id, inbox, { businessAccountId: business, accessToken: token, appSecret }, { testOrigin: origin });
    const staleChat = new Chat({ userName: 'Athena', adapters: { whatsapp: staleAdapter }, state, logger: quiet });
    try {
      await staleChat.initialize();
      saveGatewayInstance(config, instance.id); const prior = JSON.stringify(inbox.list().map((event) => event.relay)); const nextEpoch = crypto.randomUUID();
      await replaceWhatsAppPairing(inbox, { revision: gatewayWhatsAppReplacement(instance.id).revision, origin: 'https://replacement.example', businessAccountId: business, code: 'd'.repeat(64), acknowledgePreviousStopped: true, acknowledgeLoss: true }, { request: async (url, init) => {
        assert.equal(url, 'https://replacement.example/v1/pair'); assert.equal(init.method, 'POST'); assert.deepEqual(JSON.parse(String(init.body)), { code: 'd'.repeat(64) });
        return Response.json({ ...metadata(), version: 1, installationId: crypto.randomUUID(), epoch: nextEpoch, cursor: 0, gap: null, token: 'e'.repeat(64) });
      } });
      assert.equal(whatsAppSetup(instance.id).pending!.replacement, true); await state.disconnect(); await state.connect();
      finishWhatsAppPairing(inbox, { revision: whatsAppSetup(instance.id).pending!.revision, acknowledgeLoss: true });
      assert.equal(JSON.stringify(inbox.list().map((event) => event.relay)), prior); assert.equal(inbox.whatsAppRelayState()!.epoch, nextEpoch); assert.equal(inbox.whatsAppRelayState()!.cursor, 0);
      saveGatewayInstance({ ...config, enabled: true }, instance.id); assert.throws(() => inbox.checkAccess(inbox.list()[0]), /replaced relay/); assert.equal(posts.length, 6);
      const replacementRaw = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: business, changes: [{ field: 'messages', value: {
        messaging_product: 'whatsapp', metadata: { phone_number_id: phone }, messages: [{ id: 'wamid.replacement', from: actor, timestamp: String(inbox.whatsAppRelayState()!.startedAt! / 1000 + 2), type: 'text', text: { body: 'Fresh replacement request' } }],
      } }] }] });
      const replacementBody = Buffer.from(replacementRaw).toString('base64');
      await intake.receive(nextEpoch, { sequence: 1, id: crypto.createHash('sha256').update(replacementBody).digest('hex'), receivedAt: Date.now(), expiresAt: Date.now() + 60000,
        bodyBase64: replacementBody, signature: 'sha256=' + crypto.createHmac('sha256', appSecret).update(replacementRaw).digest('hex'), contentType: 'application/json' }, async (receipt) => ({ epoch: receipt.epoch, cursor: receipt.sequence }));
      const replacementWork = inbox.claimNext()!; assert.equal(replacementWork.input.sourceMessageId, 'wamid.replacement'); assert.notEqual(replacementWork.bindingId, inbox.list()[0].bindingId);
      inbox.beginDispatch(replacementWork.id, replacementWork.operationId!, await gatewayConversation(replacementWork, signal)); inbox.finishDispatch(replacementWork.id, replacementWork.operationId!, 'Fresh answer');
      const replacementReply = inbox.claimReply()!;
      const beforeStaleSend = calls.length;
      await assert.rejects(staleAdapter.replyText(replacementReply.event, replacementReply.event.reply!.parts[replacementReply.index].text, signal)); assert.equal(posts.length, 6); assert.equal(calls.length, beforeStaleSend);
      console.log('gateways: WhatsApp replacement saves a new key across restart and quarantines old receipts');
    } finally { await staleAdapter.disconnect(); await staleChat.shutdown(); }
  } finally {
    await replies.stop(); await processor.stop(); await adapter.disconnect(); await chat.shutdown(); await state.disconnect();
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
