// Offline Socket Mode proof under Bun or Node. Uses local HTTP/WebSocket fixtures and throwaway state.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Chat } from 'chat';
import type { Logger } from 'chat';
import { WebSocketServer } from 'ws';
import type WebSocket from 'ws';

// Bun caches homedir; set both home variables before the child process starts.
const proofRoot = process.env.ATHENA_SLACK_PROOF_ROOT;
if (!proofRoot) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-slack-smoke-'));
  const home = path.join(temporary, 'home');
  const data = path.join(temporary, 'data');
  fs.mkdirSync(home);
  fs.mkdirSync(data);
  try {
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      env: { ...process.env, ATHENA_SLACK_PROOF_ROOT: temporary, HOME: home, USERPROFILE: home, DASH_DATA: data },
      stdio: 'inherit',
      timeout: 15000,
    });
    assert.equal(result.status, 0, 'Slack proof child failed');
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
} else {
  assert.match(path.basename(proofRoot), /^athena-slack-smoke-[a-zA-Z0-9]+$/);
  assert.equal(fs.realpathSync(path.dirname(proofRoot)), fs.realpathSync(os.tmpdir()));
  assert.equal(process.env.DASH_DATA, path.join(proofRoot, 'data'));
  assert.equal(process.env.HOME, path.join(proofRoot, 'home'));
  await proof();
}

async function proof(): Promise<void> {
  assert.equal(os.homedir(), process.env.HOME, 'Slack proof must use its throwaway home');
  const { GatewayStateAdapter } = await import('../server/gateways/state.ts');
  const { GatewayInbox } = await import('../server/gateways/inbox.ts');
  const { SlackIntakeAdapter } = await import('../server/gateways/slack.ts');
  const { saveGatewayInstance } = await import('../server/gateways/instances.ts');
  const { listProjects } = await import('../server/store.ts');
  const { GatewayFileProcessor } = await import('../server/gateways/files.ts');
  const { GatewayDispatcher } = await import('../server/gateways/dispatch.ts');
  const { GatewayReplies } = await import('../server/gateways/replies.ts');
  const { selectGatewayDocuments } = await import('../server/gateways/outgoing.ts');
  const { ensureBrain } = await import('../server/projects.ts');
  const quiet: Logger = { child: () => quiet, debug() {}, info() {}, warn() {}, error() {} };
  const instance = saveGatewayInstance({
    name: 'Slack proof',
    platform: 'slack',
    accountId: 'TPROOF',
    projectId: listProjects()[0].id,
    target: { kind: 'brain' },
    senderPolicy: { platform: 'slack', allowedUserIds: ['UALICE'] },
    scope: { directMessages: true, conversationIds: [], guildIds: [] },
    fileLimits: { perFileBytes: 1024, perMessageBytes: 2048, filesPerMessage: 2, dailyBytes: 4096 },
    enabled: true,
  });
  const state = new GatewayStateAdapter(instance.id);
  const inbox = new GatewayInbox(state);
  const calls: string[] = [];
  const acks: string[] = [];
  const failures: Error[] = [];
  let peer: WebSocket | undefined;
  let failed = false;
  let posts = 0;
  const server = http.createServer(async (request, response) => {
    try {
      const method = request.url?.split('/').at(-1) ?? '';
      calls.push(method);
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const params = new URLSearchParams(Buffer.concat(chunks).toString());
      let result: unknown;
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const origin = `http://127.0.0.1:${address.port}`;
      if (method === 'auth.test') result = { ok: true, team_id: 'TPROOF', user_id: 'UBOT', bot_id: 'BBOT' };
      else if (method === 'bots.info') result = { ok: true, bot: { id: 'BBOT', user_id: 'UBOT', app_id: 'AAPP' } };
      else if (method === 'apps.connections.open') {
        assert.equal(request.headers.authorization, 'Bearer xapp-FAKE_APP_TOKEN');
        const address = server.address();
        assert.ok(address && typeof address !== 'string');
        result = { ok: true, url: `ws://127.0.0.1:${address.port}/socket` };
      } else if (method === 'users.info')
        result = {
          ok: true,
          user: {
            id: params.get('user'),
            team_id: 'TPROOF',
            deleted: false,
            is_bot: false,
            is_app_user: false,
            name: 'Alice',
          },
        };
      else if (method === 'conversations.info')
        result = { ok: true, channel: { id: params.get('channel'), is_im: true, user: 'UALICE' } };
      else if (method === 'files.info')
        result = {
          ok: true,
          file: {
            id: 'FFILE',
            user: 'UALICE',
            mode: 'hosted',
            is_external: false,
            size: 5,
            ims: ['DALICE'],
            url_private: `${origin}/files-pri/proof.txt`,
          },
        };
      else if (method === 'proof.txt') {
        assert.equal(request.headers.authorization, 'Bearer xoxb-FAKE_BOT_TOKEN');
        response.end('hello');
        return;
      } else if (method === 'chat.postMessage') {
        assert.equal(params.get('mrkdwn'), 'false');
        assert.ok(params.get('thread_ts'));
        result = { ok: true, channel: params.get('channel'), ts: `1700000001.${String(++posts).padStart(6, '0')}` };
      } else if (method === 'files.getUploadURLExternal')
        result = { ok: true, file_id: 'FOUT', upload_url: `${origin}/upload/proof` };
      else if (method === 'proof') {
        assert.equal(Buffer.concat(chunks).toString(), 'Proof output');
        assert.equal(request.headers.authorization, undefined);
        response.end('OK');
        return;
      } else if (method === 'files.completeUploadExternal') {
        assert.equal(params.get('channel_id'), 'DALICE');
        assert.equal(params.get('thread_ts'), '1700000000.000001');
        result = { ok: true, files: [{ id: 'FOUT' }] };
      } else throw new Error('Unexpected Slack fixture request');
      if (method !== 'apps.connections.open') assert.equal(request.headers.authorization, 'Bearer xoxb-FAKE_BOT_TOKEN');
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(result));
    } catch (error) {
      failures.push(error instanceof Error ? error : new Error(String(error)));
      response.writeHead(500);
      response.end();
    }
  });
  const sockets = new WebSocketServer({ server });
  sockets.on('connection', (socket) => {
    peer = socket;
    socket.on('message', (bytes) => {
      try {
        const ack = JSON.parse(bytes.toString()) as { envelope_id: string };
        // Each accepted receipt must already be readable at the instant Slack sees its acknowledgement.
        if (ack.envelope_id === 'text' || ack.envelope_id === 'replay')
          assert.equal(inbox.list()[0]?.input.sourceMessageId, '1700000000.000001');
        if (ack.envelope_id === 'file') assert.equal(inbox.list()[1]?.status, 'waiting-files');
        acks.push(ack.envelope_id);
      } catch (error) {
        failures.push(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.send(JSON.stringify({ type: 'hello', num_connections: 1 }));
  });
  const waitFor = async (ready: () => boolean) => {
    const until = Date.now() + 5000;
    while (!ready() && Date.now() < until && !failures.length) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(failures, []);
    assert.ok(ready(), 'Slack fixture did not finish');
  };
  let chat: Chat | undefined;
  let processor: InstanceType<typeof GatewayFileProcessor> | undefined;
  let dispatcher: InstanceType<typeof GatewayDispatcher> | undefined;
  let replies: InstanceType<typeof GatewayReplies> | undefined;
  const signal = new AbortController().signal;
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const adapter = new SlackIntakeAdapter(
      instance.id,
      inbox,
      'xoxb-FAKE_BOT_TOKEN',
      'xapp-FAKE_APP_TOKEN',
      (connected) => {
        if (!connected) failed = true;
      },
      { apiUrl: `http://127.0.0.1:${address.port}/`, fileOrigin: `http://127.0.0.1:${address.port}` },
    );
    chat = new Chat({
      userName: 'Athena',
      adapters: { slack: adapter },
      state,
      logger: quiet,
      concurrency: 'concurrent',
    });
    await chat.initialize();
    const send = (
      id: string,
      user: string,
      ts = '1700000000.000001',
      files?: { id: string; name: string; url_private: string }[],
    ) => {
      assert.ok(peer);
      peer.send(
        JSON.stringify({
          type: 'events_api',
          envelope_id: id,
          payload: {
            type: 'event_callback',
            team_id: 'TPROOF',
            api_app_id: 'AAPP',
            event_id: id,
            event: {
              type: 'message',
              channel: 'DALICE',
              channel_type: 'im',
              user,
              ts,
              text: files ? '' : 'Proof text',
              files,
            },
          },
        }),
      );
    };
    send('denied', 'UBOB');
    await waitFor(() => acks.includes('denied'));
    assert.equal(inbox.list().length, 0);
    assert.ok(!calls.includes('users.info'));
    fs.writeFileSync(state.inboxFile(), '{broken');
    send('failed', 'UALICE');
    await waitFor(() => failed);
    assert.ok(!acks.includes('failed'));
    fs.unlinkSync(state.inboxFile());
    send('text', 'UALICE');
    await waitFor(() => acks.includes('text'));
    send('replay', 'UALICE');
    await waitFor(() => acks.includes('replay'));
    assert.equal(inbox.list().length, 1);
    send('file', 'UALICE', '1700000000.000002', [
      { id: 'FFILE', name: 'proof.txt', url_private: 'https://never-download.invalid/private' },
    ]);
    await waitFor(() => acks.includes('file'));
    assert.equal(inbox.list()[1].input.media[0].fileId, 'FFILE');
    assert.ok(!fs.readFileSync(state.inboxFile(), 'utf8').includes('url_private'));
    processor = new GatewayFileProcessor(
      instance.id,
      inbox,
      (id, limit, signal, event) => adapter.downloadFileSource(id, limit, signal, event),
      signal,
    );
    await processor.start();
    assert.equal(inbox.list()[1].files?.[0].status, 'saved');
    assert.equal(fs.readFileSync(inbox.list()[1].files![0].file!.path, 'utf8'), 'hello');
    dispatcher = new GatewayDispatcher(inbox, signal, {
      async submit() {
        return {};
      },
      poll() {
        return { state: 'completed', answer: 'Proof answer' };
      },
    });
    await dispatcher.wake();
    await waitFor(() => inbox.list().every((event) => event.status === 'done'));
    const output = path.join(ensureBrain(), 'result.txt');
    fs.writeFileSync(output, 'Proof output');
    await selectGatewayDocuments(inbox, inbox.list()[0].id, { paths: [output] }, signal);
    replies = new GatewayReplies(
      inbox,
      (event, text, signal) => adapter.replyText(event, text, signal),
      signal,
      () => true,
      (event, file, signal) => adapter.replyDocument(event, file, signal),
    );
    await replies.wake();
    assert.equal(posts, 2);
    assert.equal(inbox.list()[0].outgoing?.[0].status, 'sent');
    assert.equal(calls.filter((method) => method === 'files.completeUploadExternal').length, 1);
    await dispatcher.stop();
    await replies.stop();
    await processor.stop();
    await chat.shutdown();
    chat = undefined;
    await state.connect();
    assert.equal(new GatewayInbox(state).list().length, 2);
    console.log(
      'gateways: Slack Socket Mode, sender scope, commit-before-ack, replay and private file descriptors pass',
    );
    console.log('gateways: Slack private downloads, native dispatch, threaded replies and selected file uploads pass');
  } finally {
    await dispatcher?.stop();
    await replies?.stop();
    await processor?.stop();
    await chat?.shutdown();
    await state.disconnect();
    for (const socket of sockets.clients) socket.terminate();
    sockets.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
