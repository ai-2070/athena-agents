// Local Discord REST, WebSocket and file proof: no real account or platform messages.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Chat } from 'chat';
import { WebSocketServer } from 'ws';
import type WebSocket from 'ws';
import type { GatewayDiscordState } from '../shared/types.ts';
import type { Logger } from 'chat';

// Set home before process startup: Bun caches homedir.
const proofRoot = process.env.ATHENA_DISCORD_PROOF_ROOT;
if (!proofRoot) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-discord-smoke-'));
  const home = path.join(temporary, 'home'); const data = path.join(temporary, 'data'); fs.mkdirSync(home); fs.mkdirSync(data);
  try {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      env: { ...process.env, ATHENA_DISCORD_PROOF_ROOT: temporary, HOME: home, USERPROFILE: home, DASH_DATA: data }, stdio: 'inherit', timeout: 15000,
    });
    assert.equal(child.status, 0, 'Discord proof child failed');
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
} else {
  assert.match(path.basename(proofRoot), /^athena-discord-smoke-[a-zA-Z0-9]+$/);
  assert.equal(fs.realpathSync(path.dirname(proofRoot)), fs.realpathSync(os.tmpdir()));
  assert.equal(process.env.DASH_DATA, path.join(proofRoot, 'data')); assert.equal(process.env.HOME, path.join(proofRoot, 'home'));
  await proof();
}

async function proof(): Promise<void> {
  assert.equal(os.homedir(), process.env.HOME, 'Discord proof must use its throwaway home');
  const { DiscordIntakeAdapter } = await import('../server/gateways/discord.ts');
  const { GatewayInbox } = await import('../server/gateways/inbox.ts');
  const { GatewayStateAdapter } = await import('../server/gateways/state.ts');
  const { discordTransport } = await import('../server/gateways/discord-transport.ts');
  const { saveGatewayInstance, saveGatewayCredentials } = await import('../server/gateways/instances.ts');
  const { listProjects } = await import('../server/store.ts');
  const { GatewayFileProcessor } = await import('../server/gateways/files.ts');
  const { GatewayReplies } = await import('../server/gateways/replies.ts');
  const { gatewayConversation } = await import('../server/gateways/conversations.ts');
  const { selectGatewayDocuments } = await import('../server/gateways/outgoing.ts');
  const { ensureBrain } = await import('../server/projects.ts');
  const quiet: Logger = { child: () => quiet, debug() {}, info() {}, warn() {}, error() {} };
  const guild = '100000000000000001'; const channel = '200000000000000001'; const actor = '300000000000000001'; const bot = '400000000000000001'; const messageId = '500000000000000001';
  const instance = saveGatewayInstance({ name: 'Discord proof', platform: 'discord', accountId: bot, projectId: listProjects()[0].id, target: { kind: 'brain' },
    senderPolicy: { platform: 'discord', allowedUserIds: [actor] }, scope: { directMessages: false, conversationIds: [channel], guildIds: [guild] },
    fileLimits: { perFileBytes: 1024, perMessageBytes: 2048, filesPerMessage: 2, dailyBytes: 4096 }, enabled: true });
  const state = new GatewayStateAdapter(instance.id); const inbox = new GatewayInbox(state); const calls: string[] = [];
  const input = { id: messageId, channel_id: channel, guild_id: guild, author: { id: actor }, type: 0, content: 'Proof input', mentions: [{ id: bot }], attachments: [] };
  let gatewayOrigin = ''; let fileOrigin = ''; const posts: { payload: Record<string, unknown>; file?: Blob }[] = [];
  const fileInput = { ...input, id: '500000000000000002', content: '', attachments: [{ id: '600000000000000001', filename: 'proof.txt', size: 5, url: 'https://never-fetch.invalid/PRIVATE_URL' }] };
  const edited = { ...input, content: 'Changed proof input' }; const failures: Error[] = [];
  const server = http.createServer(async (request, response) => {
    try {
      const endpoint = request.url ?? ''; calls.push(endpoint);
      if (endpoint.startsWith('/attachments/')) {
        assert.equal(request.method, 'GET'); assert.equal(request.headers.authorization, undefined); response.end('hello'); return;
      }
      assert.equal(request.headers.authorization, 'Bot FAKE_BOT_TOKEN');
      if (request.method === 'POST') {
        assert.equal(endpoint, `/channels/${channel}/messages`); const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const bytes = new Uint8Array(Buffer.concat(chunks)); let file: Blob | undefined; let payload: Record<string, unknown>;
        if (request.headers['content-type']?.startsWith('multipart/form-data')) {
          const form = await new Response(bytes, { headers: { 'content-type': request.headers['content-type'] } }).formData();
          const selected = form.get('files[0]'); assert.ok(selected instanceof Blob); file = selected; assert.equal(await file.text(), 'world');
          payload = JSON.parse(String(form.get('payload_json'))) as Record<string, unknown>;
        } else payload = JSON.parse(Buffer.from(bytes).toString()) as Record<string, unknown>;
        assert.deepEqual(payload.allowed_mentions, { parse: [], replied_user: false }); assert.equal(payload.flags, 4);
        assert.deepEqual(payload.message_reference, { type: 0, message_id: fileInput.id, channel_id: channel, fail_if_not_exists: true });
        assert.ok(String(payload.content).length <= 2000); posts.push({ payload, file });
        response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ ...payload, id: String(700000000000000000n + BigInt(posts.length)),
          channel_id: channel, guild_id: guild, author: { id: bot, bot: true }, type: 19,
          attachments: file ? [{ id: '600000000000000009', filename: 'result.txt', size: file.size }] : [],
        })); return;
      }
      assert.equal(request.method, 'GET');
      let result: unknown;
      if (endpoint === '/users/@me') result = { id: bot, bot: true };
      else if (endpoint === '/gateway/bot') result = { url: gatewayOrigin, shards: 1, session_start_limit: { total: 1000, remaining: 999, reset_after: 10000, max_concurrency: 1 } };
      else if (endpoint === '/oauth2/applications/@me') result = { id: bot, bot: { id: bot, bot: true }, flags: 1 << 19 };
      else if (endpoint === `/channels/${channel}`) result = { id: channel, guild_id: guild, type: 0, permission_overwrites: [] };
      else if (endpoint === `/guilds/${guild}/members/${bot}`) result = { user: { id: bot, bot: true }, roles: [] };
      else if (endpoint === `/guilds/${guild}/roles`) result = [{ id: guild, permissions: String((1n << 10n) | (1n << 11n) | (1n << 15n) | (1n << 16n)) }];
      else if (endpoint === `/guilds/${guild}/members/${actor}`) result = { user: { id: actor, username: 'Verified Alice' } };
      else if (endpoint === `/channels/${channel}/messages/${messageId}`) result = edited;
      else if (endpoint === `/channels/${channel}/messages/${fileInput.id}`) result = { ...fileInput, attachments: [{ ...fileInput.attachments[0], url: `${fileOrigin}/attachments/${channel}/600000000000000001/proof.txt?ex=PRIVATE_SIGNATURE` }] };
      else throw new Error('Unexpected Discord proof request');
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(result));
    } catch (error) { failures.push(error instanceof Error ? error : new Error(String(error))); response.writeHead(500); response.end(); }
  });
  const sockets: WebSocket[] = []; const gatewayErrors: Error[] = []; let identifies = 0; let resumes = 0;
  const wireInput = { ...input, id: '500000000000000003' }; const replayInput = { ...input, id: '500000000000000004' };
  const socketServer = new WebSocketServer({ server });
  const dispatch = (socket: WebSocket, sequence: number, type: string, payload: unknown) => socket.send(JSON.stringify({ op: 0, s: sequence, t: type, d: payload }));
  socketServer.on('connection', (socket, request) => {
    sockets.push(socket);
    socket.on('message', (data) => {
      try {
        const value = JSON.parse(data.toString()) as { op: number; d: { token?: string; intents?: number; seq?: number; session_id?: string } };
        if (value.op === 1) { socket.send(JSON.stringify({ op: 11, d: null })); return; }
        assert.equal(request.url, '/?v=10&encoding=json'); assert.equal(value.d.token, 'FAKE_BOT_TOKEN');
        if (value.op === 2) {
          identifies++; assert.equal(value.d.intents, 1 | 512 | 4096 | 32768);
          dispatch(socket, 1, 'READY', { v: 10, user: { id: bot, bot: true }, session_id: 'PRIVATE_PROOF_SESSION', resume_gateway_url: gatewayOrigin });
        } else {
          assert.equal(value.op, 6); resumes++; assert.equal(value.d.session_id, 'PRIVATE_PROOF_SESSION');
          if (resumes === 1) { assert.equal(value.d.seq, 2); dispatch(socket, 3, 'MESSAGE_CREATE', replayInput); dispatch(socket, 4, 'RESUMED', {}); }
          else { assert.equal(value.d.seq, 5); dispatch(socket, 6, 'RESUMED', {}); }
        }
      } catch (error) { failures.push(error instanceof Error ? error : new Error(String(error))); socket.terminate(); }
    });
    socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 1000 } }));
  });
  const waitFor = async (condition: () => boolean) => {
    const deadline = Date.now() + 4000;
    while (!condition()) { assert.ok(Date.now() < deadline, 'Discord proof timed out'); await new Promise((resolve) => setTimeout(resolve, 10)); }
  };
  const cursor = () => JSON.parse(fs.readFileSync(state.discordGatewayFile(), 'utf8')) as GatewayDiscordState;
  let gateway: ReturnType<InstanceType<typeof DiscordIntakeAdapter>['createGateway']> | undefined;
  let processor: InstanceType<typeof GatewayFileProcessor> | undefined; let deliveries: InstanceType<typeof GatewayReplies> | undefined;
  let supervised: ReturnType<typeof discordTransport> | undefined;
  let chat: Chat | undefined; let adapter: InstanceType<typeof DiscordIntakeAdapter> | undefined;
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); assert.ok(address && typeof address !== 'string');
    gatewayOrigin = `ws://127.0.0.1:${address.port}`; fileOrigin = `http://127.0.0.1:${address.port}`;
    adapter = new DiscordIntakeAdapter(instance.id, inbox, 'FAKE_BOT_TOKEN', { apiUrl: fileOrigin, fileOrigin });
    chat = new Chat({ userName: 'Athena', adapters: { discord: adapter }, state, logger: quiet }); await chat.initialize();
    assert.equal(await adapter.receiveDispatch('MESSAGE_CREATE', 'denied', { ...input, author: { id: '999' } }), null); assert.equal(calls.length, 2);
    fs.writeFileSync(state.inboxFile(), '{broken'); await assert.rejects(adapter.receiveDispatch('MESSAGE_CREATE', 'failed', input)); fs.unlinkSync(state.inboxFile());
    const original = await adapter.receiveDispatch('MESSAGE_CREATE', 'accepted', input); assert.ok(original); assert.equal(original.input.sourceMessageId, messageId);
    assert.equal(original.input.guildId, guild); assert.equal((await adapter.receiveDispatch('MESSAGE_CREATE', 'replay', input))?.id, original.id);
    const file = await adapter.receiveDispatch('MESSAGE_CREATE', 'file', fileInput);
    assert.equal(file?.status, 'waiting-files'); assert.ok(!fs.readFileSync(state.inboxFile(), 'utf8').includes('PRIVATE_'));
    const update = await adapter.receiveDispatch('MESSAGE_UPDATE', 'edit', { id: messageId, channel_id: channel, guild_id: guild }); assert.equal(update?.bindingId, original.bindingId);
    assert.equal(inbox.list()[0].status, 'needs-review'); assert.equal(inbox.claimNext(), null);
    assert.equal((await adapter.handleWebhook(new Request('http://localhost/not-used'))).status, 404);
    await assert.rejects(adapter.startGatewayListener({}));
    gateway = adapter.createGateway(state, { testOrigin: gatewayOrigin, onDisconnect: (error) => gatewayErrors.push(error) }); await gateway.start();
    dispatch(sockets[0], 2, 'MESSAGE_CREATE', wireInput); await waitFor(() => cursor().session?.sequence === 2);
    const committed = fs.readFileSync(state.inboxFile(), 'utf8'); fs.writeFileSync(state.inboxFile(), '{broken');
    dispatch(sockets[0], 3, 'MESSAGE_CREATE', replayInput); await waitFor(() => !gateway?.alive);
    assert.equal(cursor().session?.sequence, 2); assert.equal(gatewayErrors.length, 1); await gateway.stop(); fs.writeFileSync(state.inboxFile(), committed);
    gateway = adapter.createGateway(state, { testOrigin: gatewayOrigin }); await gateway.start();
    assert.equal(cursor().session?.sequence, 4); assert.equal(inbox.list().length, 5); assert.equal(identifies, 1); assert.equal(resumes, 1);
    dispatch(sockets[1], 5, 'MESSAGE_CREATE', wireInput); await waitFor(() => cursor().session?.sequence === 5); assert.equal(inbox.list().length, 5);
    assert.ok(!fs.readFileSync(state.discordGatewayFile(), 'utf8').includes('FAKE_BOT_TOKEN')); await gateway.stop();
    console.log('gateways: Discord Gateway Identify, durable cursor, failed-write replay and Resume pass');
    const transport = adapter; const abort = new AbortController();
    processor = new GatewayFileProcessor(instance.id, inbox, (id, limit, signal, event) => transport.downloadFileSource(id, limit, signal, event), abort.signal);
    await processor.start(); const downloaded = inbox.list().find((event) => event.id === file?.id)!;
    assert.equal(downloaded.files?.[0].status, 'saved'); assert.equal(fs.readFileSync(downloaded.files[0].file!.path, 'utf8'), 'hello');
    const claimed = inbox.claimNext(); assert.equal(claimed?.id, downloaded.id); assert.ok(claimed);
    inbox.beginDispatch(claimed.id, claimed.operationId!, await gatewayConversation(claimed, abort.signal));
    const answer = 'a'.repeat(1999) + '😊 done'; inbox.finishDispatch(claimed.id, claimed.operationId!, answer);
    const selected = path.join(ensureBrain(), 'result.txt'); fs.writeFileSync(selected, 'world');
    await selectGatewayDocuments(inbox, claimed.id, { paths: [selected] }, abort.signal);
    deliveries = new GatewayReplies(inbox, (event, text, signal) => transport.replyText(event, text, signal), abort.signal, () => true,
      (event, file, signal) => transport.replyDocument(event, file, signal));
    await deliveries.wake(); await deliveries.wake(); const delivered = inbox.list().find((event) => event.id === claimed.id)!;
    assert.equal(posts.length, 3); assert.equal(posts.filter((post) => !post.file).map((post) => post.payload.content).join(''), answer);
    assert.ok(delivered.reply?.parts.every((part) => part.status === 'sent')); assert.equal(delivered.outgoing?.[0].status, 'sent');
    assert.ok(!fs.readFileSync(state.inboxFile(), 'utf8').includes('PRIVATE_'));
    console.log('gateways: Discord private download, bounded replies and selected document upload pass');
    await deliveries.stop(); await processor.stop(); await adapter.disconnect(); await chat.shutdown(); chat = undefined; await state.connect();
    saveGatewayCredentials(instance.id, { botToken: 'FAKE_BOT_TOKEN' });
    supervised = discordTransport(state, new GatewayInbox(state), () => {}, new AbortController().signal, { apiUrl: fileOrigin, fileOrigin, testOrigin: gatewayOrigin });
    await supervised.start(); assert.equal(supervised.alive(), true); assert.equal(identifies, 1); assert.equal(resumes, 2); await supervised.stop(); await state.connect();
    console.log('gateways: shared Discord transport resumes without a new Identify or repeated delivery');
    assert.equal(new GatewayInbox(state).list().length, 5); assert.deepEqual(failures, []);
    console.log('gateways: Discord verified identities, guild scopes, permissions, source replay and partial edits pass');
  } finally {
    await supervised?.stop(); await deliveries?.stop(); await processor?.stop(); await gateway?.stop(); for (const socket of sockets) socket.terminate(); await new Promise<void>((resolve) => socketServer.close(() => resolve()));
    await adapter?.disconnect(); await chat?.shutdown(); await state.disconnect(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
