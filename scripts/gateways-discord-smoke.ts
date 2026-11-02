// Discord payload/REST proof only: no real Gateway socket, credentials or outgoing messages.
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
  const { saveGatewayInstance } = await import('../server/gateways/instances.ts');
  const { listProjects } = await import('../server/store.ts');
  const quiet: Logger = { child: () => quiet, debug() {}, info() {}, warn() {}, error() {} };
  const guild = '100000000000000001'; const channel = '200000000000000001'; const actor = '300000000000000001'; const bot = '400000000000000001'; const messageId = '500000000000000001';
  const instance = saveGatewayInstance({ name: 'Discord proof', platform: 'discord', accountId: bot, projectId: listProjects()[0].id, target: { kind: 'brain' },
    senderPolicy: { platform: 'discord', allowedUserIds: [actor] }, scope: { directMessages: false, conversationIds: [channel], guildIds: [guild] },
    fileLimits: { perFileBytes: 1024, perMessageBytes: 2048, filesPerMessage: 2, dailyBytes: 4096 }, enabled: true });
  const state = new GatewayStateAdapter(instance.id); const inbox = new GatewayInbox(state); const calls: string[] = [];
  const input = { id: messageId, channel_id: channel, guild_id: guild, author: { id: actor }, type: 0, content: 'Proof input', mentions: [{ id: bot }], attachments: [] };
  let edited = { ...input, content: 'Changed proof input' }; const failures: Error[] = [];
  const server = http.createServer((request, response) => {
    try {
      assert.equal(request.method, 'GET'); assert.equal(request.headers.authorization, 'Bot FAKE_BOT_TOKEN'); const endpoint = request.url ?? ''; calls.push(endpoint);
      let result: unknown;
      if (endpoint === '/users/@me') result = { id: bot, bot: true };
      else if (endpoint === '/oauth2/applications/@me') result = { id: bot, bot: { id: bot, bot: true }, flags: 1 << 19 };
      else if (endpoint === `/channels/${channel}`) result = { id: channel, guild_id: guild, type: 0, permission_overwrites: [] };
      else if (endpoint === `/guilds/${guild}/members/${bot}`) result = { user: { id: bot, bot: true }, roles: [] };
      else if (endpoint === `/guilds/${guild}/roles`) result = [{ id: guild, permissions: String((1n << 10n) | (1n << 11n) | (1n << 16n)) }];
      else if (endpoint === `/guilds/${guild}/members/${actor}`) result = { user: { id: actor, username: 'Verified Alice' } };
      else if (endpoint === `/channels/${channel}/messages/${messageId}`) result = edited;
      else throw new Error('Unexpected Discord proof request');
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(result));
    } catch (error) { failures.push(error instanceof Error ? error : new Error(String(error))); response.writeHead(500); response.end(); }
  });
  let chat: Chat | undefined; let adapter: InstanceType<typeof DiscordIntakeAdapter> | undefined;
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); assert.ok(address && typeof address !== 'string');
    adapter = new DiscordIntakeAdapter(instance.id, inbox, 'FAKE_BOT_TOKEN', { apiUrl: `http://127.0.0.1:${address.port}` });
    chat = new Chat({ userName: 'Athena', adapters: { discord: adapter }, state, logger: quiet }); await chat.initialize();
    assert.equal(await adapter.receiveDispatch('MESSAGE_CREATE', 'denied', { ...input, author: { id: '999' } }), null); assert.equal(calls.length, 2);
    fs.writeFileSync(state.inboxFile(), '{broken'); await assert.rejects(adapter.receiveDispatch('MESSAGE_CREATE', 'failed', input)); fs.unlinkSync(state.inboxFile());
    const original = await adapter.receiveDispatch('MESSAGE_CREATE', 'accepted', input); assert.ok(original); assert.equal(original.input.sourceMessageId, messageId);
    assert.equal(original.input.guildId, guild); assert.equal((await adapter.receiveDispatch('MESSAGE_CREATE', 'replay', input))?.id, original.id);
    const file = await adapter.receiveDispatch('MESSAGE_CREATE', 'file', { ...input, id: '500000000000000002', content: '', attachments: [{ id: '600000000000000001', filename: 'proof.txt', size: 5, url: 'https://never-fetch.invalid/PRIVATE_URL' }] });
    assert.equal(file?.status, 'waiting-files'); assert.ok(!fs.readFileSync(state.inboxFile(), 'utf8').includes('PRIVATE_'));
    const update = await adapter.receiveDispatch('MESSAGE_UPDATE', 'edit', { id: messageId, channel_id: channel, guild_id: guild }); assert.equal(update?.bindingId, original.bindingId);
    assert.equal(inbox.list()[0].status, 'needs-review'); assert.equal(inbox.claimNext(), null);
    assert.equal((await adapter.handleWebhook(new Request('http://localhost/not-used'))).status, 404);
    await assert.rejects(adapter.startGatewayListener({}));
    await adapter.disconnect(); await chat.shutdown(); chat = undefined; await state.connect(); assert.equal(new GatewayInbox(state).list().length, 3); assert.deepEqual(failures, []);
    console.log('gateways: Discord verified identities, guild scopes, permissions, source replay and partial edits pass');
  } finally {
    await adapter?.disconnect(); await chat?.shutdown(); await state.disconnect(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
