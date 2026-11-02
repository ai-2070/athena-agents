import fs from 'node:fs';
import http from 'node:http';
import { once } from 'node:events';
import { Chat } from 'chat';
import type { Logger } from 'chat';
import type { TelegramUpdate } from '@chat-adapter/telegram';
import { afterEach, describe, expect, it } from 'vitest';
import { saveGatewayCredentials, saveGatewayInstance } from '../../server/gateways/instances.ts';
import { GatewayStateAdapter } from '../../server/gateways/state.ts';
import { GatewayInbox } from '../../server/gateways/inbox.ts';
import { TelegramIntakeAdapter } from '../../server/gateways/telegram.ts';
import { gatewayConfig } from './gateway-fixtures.ts';

const quiet: Logger = { child: () => quiet, debug() {}, info() {}, warn() {}, error() {} };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
let account = 10000;
function update(id: number, actor = 123): TelegramUpdate {
  return {
    update_id: id,
    message: { message_id: id, date: 1700000000, chat: { id: actor, type: 'private' }, from: { id: actor, is_bot: false, first_name: 'Alice' }, text: `Message ${id}` },
  };
}

async function fixture(options: { webhook?: string; wrongBot?: boolean; failCommit?: boolean } = {}) {
  const config = gatewayConfig(String(account++));
  const instance = saveGatewayInstance(config);
  saveGatewayCredentials(instance.id, { botToken: 'private-token' });
  const state = new GatewayStateAdapter(instance.id);
  await state.connect();
  const inbox = new GatewayInbox(state);
  const batches: TelegramUpdate[][] = [];
  const calls: { method: string; body: string }[] = [];
  let commitBlocked = options.failCommit === true;
  if (commitBlocked) fs.writeFileSync(state.inboxFile(), '{broken');
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const method = request.url?.split('/').at(-1) ?? '';
    calls.push({ method, body: Buffer.concat(chunks).toString() });
    let result: unknown;
    if (method === 'getMe') result = { id: options.wrongBot ? 888 : Number(instance.accountId), is_bot: true, first_name: 'Athena', username: 'actual_bot' };
    else if (method === 'getWebhookInfo') result = { url: options.webhook ?? '', pending_update_count: 0, has_custom_certificate: false };
    else if (method === 'getUpdates') {
      if (!batches.length) await new Promise((resolve) => setTimeout(resolve, 20));
      result = batches.shift() ?? [];
    } else { response.writeHead(500); response.end(); return; }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ ok: true, result }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture port');
  const adapter = new TelegramIntakeAdapter(instance.id, inbox, 'private-token', () => {}, { apiUrl: `http://127.0.0.1:${address.port}` });
  const chat = new Chat({ userName: 'Dashboard display name', adapters: { telegram: adapter }, state, logger: quiet, concurrency: 'concurrent' });
  cleanups.push(async () => {
    await chat.shutdown();
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { instance, state, inbox, batches, calls, chat, unblock: () => { if (commitBlocked) { fs.unlinkSync(state.inboxFile()); commitBlocked = false; } } };
}

describe('Telegram durable intake', () => {
  it('checks the bot identity and refuses an existing webhook without deleting it or polling', async () => {
    const webhook = await fixture({ webhook: 'https://example.com/existing' });
    await expect(webhook.chat.initialize()).rejects.toThrow('has a webhook');
    expect(webhook.calls.map((call) => call.method)).toEqual(['getMe', 'getWebhookInfo']);
    const wrong = await fixture({ wrongBot: true });
    await expect(wrong.chat.initialize()).rejects.toThrow('different bot');
    expect(wrong.calls.map((call) => call.method)).toEqual(['getMe']);
  });

  it('guards raw actors and scopes before parsing media or saving denied content', async () => {
    const f = await fixture();
    const anonymous = update(3); anonymous.message!.sender_chat = { id: -10, type: 'supergroup' };
    const missing = update(4); delete missing.message!.from;
    const bot = update(5); bot.message!.from!.is_bot = true;
    const file = update(6); delete file.message!.text;
    file.message!.document = { file_id: 'private-file', file_unique_id: 'unique', file_name: 'plan.txt', file_size: 12 };
    const wrongGroup = update(7); wrongGroup.message!.chat = { id: -200, type: 'supergroup' };
    const forwarded = update(8, 456);
    Object.assign(forwarded.message!, { forward_origin: { type: 'user', sender_user: { id: 123, is_bot: false, first_name: 'Allowed author' } } });
    const denied = update(2, 456); denied.message!.text = 'denied-private-text';
    f.batches.push([update(1), denied, anonymous, missing, bot, file, wrongGroup, forwarded]);
    await f.chat.initialize();
    await expect.poll(() => f.inbox.list().length).toBe(2);
    expect(f.inbox.list().map((event) => event.input.sourceMessageId)).toEqual(['1', '6']);
    expect(f.inbox.list()[1].input.media[0].fileId).toBe('private-file');
    expect(fs.readFileSync(f.state.inboxFile(), 'utf8')).not.toContain('denied-private-text');
    expect(f.calls.some((call) => ['getFile', 'sendMessage', 'sendDocument', 'deleteWebhook'].includes(call.method))).toBe(false);
  });

  it('uses the real bot username for topic mentions and applies changed sender rules to subsequent batches', async () => {
    const f = await fixture();
    const shared = update(1); shared.message!.chat = { id: -100, type: 'supergroup' }; shared.message!.message_thread_id = 7;
    shared.message!.text = '@actual_bot please help';
    f.batches.push([shared]); await f.chat.initialize();
    await expect.poll(() => f.inbox.list().length).toBe(1);
    saveGatewayInstance({ ...gatewayConfig(f.instance.accountId), senderPolicy: { platform: 'telegram', allowedUserIds: ['777'] } }, f.instance.id);
    f.batches.push([update(2)]);
    await expect.poll(() => f.calls.filter((call) => call.method === 'getUpdates').length).toBeGreaterThan(3);
    expect(f.inbox.list()).toHaveLength(1);
  });

  it('does not advance the polling offset when the durable inbox commit fails', async () => {
    const f = await fixture({ failCommit: true });
    f.batches.push([update(1)]); await f.chat.initialize();
    await expect.poll(() => f.calls.filter((call) => call.method === 'getUpdates').length).toBeGreaterThan(1);
    const before = f.calls.filter((call) => call.method === 'getUpdates');
    expect(before.every((call) => !Object.hasOwn(JSON.parse(call.body) as object, 'offset'))).toBe(true);
    f.unblock(); f.batches.push([update(1)]);
    await expect.poll(() => f.inbox.list().length).toBe(1);
    await expect.poll(() => f.calls.some((call) => call.method === 'getUpdates' && (JSON.parse(call.body) as { offset?: number }).offset === 2)).toBe(true);
    f.batches.push([update(1)]);
    await expect.poll(() => f.calls.filter((call) => call.method === 'getUpdates').length).toBeGreaterThan(before.length + 2);
    expect(f.inbox.list()).toHaveLength(1);
  });
});
