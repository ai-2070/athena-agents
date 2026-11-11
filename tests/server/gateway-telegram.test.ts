import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
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
import { GatewayDispatcher } from '../../server/gateways/dispatch.ts';
import { GatewayReplies } from '../../server/gateways/replies.ts';
import { gatewayConversation } from '../../server/gateways/conversations.ts';
import { selectGatewayDocuments } from '../../server/gateways/outgoing.ts';
import { ensureBrain } from '../../server/projects.ts';
import { GatewayOutboxLedger } from '../../server/gateways/outbox.ts';

const quiet: Logger = { child: () => quiet, debug() {}, info() {}, warn() {}, error() {} };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
let account = 10000;
function update(id: number, actor = 123): TelegramUpdate {
  return {
    update_id: id,
    message: {
      message_id: id,
      date: 1700000000,
      chat: { id: actor, type: 'private' },
      from: { id: actor, is_bot: false, first_name: 'Alice' },
      text: `Message ${id}`,
    },
  };
}

async function fixture(
  options: {
    webhook?: string;
    wrongBot?: boolean;
    failCommit?: boolean;
    filePath?: string;
    fileSize?: number;
    redirect?: boolean;
    sendError?: number;
  } = {},
) {
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
    if (method === 'getMe')
      result = {
        id: options.wrongBot ? 888 : Number(instance.accountId),
        is_bot: true,
        first_name: 'Athena',
        username: 'actual_bot',
      };
    else if (method === 'getWebhookInfo')
      result = { url: options.webhook ?? '', pending_update_count: 0, has_custom_certificate: false };
    else if (method === 'getFile')
      result = { file_path: options.filePath ?? 'documents/proof.txt', file_size: options.fileSize ?? 5 };
    else if (method === 'sendMessage' || method === 'sendDocument') {
      if (options.sendError) {
        response.writeHead(options.sendError, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            ok: false,
            error_code: options.sendError,
            description: 'private provider detail',
            parameters: { retry_after: 7 },
          }),
        );
        return;
      }
      result = { message_id: 50, chat: { id: 123, type: 'private' } };
    } else if (method === 'proof.txt') {
      if (options.redirect) response.writeHead(302, { location: '/forbidden-download' });
      response.end('hello');
      return;
    } else if (method === 'getUpdates') {
      if (!batches.length) await new Promise((resolve) => setTimeout(resolve, 20));
      result = batches.shift() ?? [];
    } else {
      response.writeHead(500);
      response.end();
      return;
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ ok: true, result }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture port');
  const adapter = new TelegramIntakeAdapter(instance.id, inbox, 'private-token', () => {}, {
    apiUrl: `http://127.0.0.1:${address.port}`,
  });
  const chat = new Chat({
    userName: 'Dashboard display name',
    adapters: { telegram: adapter },
    state,
    logger: quiet,
    concurrency: 'concurrent',
  });
  cleanups.push(async () => {
    await chat.shutdown();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    instance,
    state,
    inbox,
    batches,
    calls,
    chat,
    adapter,
    unblock: () => {
      if (commitBlocked) {
        fs.unlinkSync(state.inboxFile());
        commitBlocked = false;
      }
    },
  };
}

describe('Telegram durable intake', () => {
  it('sends approved Outbox parts through the selected bot without changing native work or permitting reuse', async () => {
    const f = await fixture();
    f.batches.push([update(1)]);
    await f.chat.initialize();
    await expect.poll(() => f.inbox.list().length).toBe(1);
    const signal = new AbortController().signal;
    const event = f.inbox.claimNext()!;
    f.inbox.beginDispatch(event.id, event.operationId!, await gatewayConversation(event, signal));
    f.inbox.finishDispatch(event.id, event.operationId!, 'Native answer');
    f.inbox.claimReply();
    f.inbox.settleReply(event.id, 0, { remoteId: 'already-confirmed' });
    const native = fs.readFileSync(f.state.inboxFile(), 'utf8');
    const ledger = new GatewayOutboxLedger(f.state, f.inbox);
    const preview = ledger.prepare({
      instanceId: f.instance.id,
      projectId: f.instance.projectId,
      postId: 'approved-post',
      eventId: event.id,
      parts: ['Approved follow-up 😀', 'Second part'],
    });
    ledger.approve(preview.approval);
    const replies = new GatewayReplies(
      f.inbox,
      (input, text, abort, approved) => f.adapter.replyText(input, text, abort, approved),
      signal,
      () => true,
      undefined,
      ledger,
    );
    cleanups.push(() => replies.stop());
    await replies.wake();
    await replies.wake();
    const sends = f.calls.filter((call) => call.method === 'sendMessage');
    expect(sends.map((call) => JSON.parse(call.body).text)).toEqual(preview.approval.parts);
    for (const call of sends)
      expect(JSON.parse(call.body)).toMatchObject({
        chat_id: '123',
        reply_parameters: { message_id: 1 },
        link_preview_options: { is_disabled: true },
      });
    expect(ledger.list()[0].receipts.every((part) => part.status === 'sent')).toBe(true);
    expect(fs.readFileSync(f.state.inboxFile(), 'utf8')).toBe(native);
    const saved = f.inbox.list()[0];
    await expect(
      f.adapter.replyText(saved, 'Approved follow-up 😀', signal, {
        authorize: (input, text) =>
          ledger.authorize(
            {
              projectId: f.instance.projectId,
              postId: 'approved-post',
              index: 0,
              attempt: 1,
              event: saved,
              text: 'Approved follow-up 😀',
            },
            input,
            text,
          ),
      }),
    ).rejects.toMatchObject({ outcome: 'failed' });
    expect(f.calls.filter((call) => call.method === 'sendMessage')).toHaveLength(2);
  });

  it('uploads explicitly selected, verified bytes as a document after the text reply', async () => {
    const f = await fixture();
    f.batches.push([update(1)]);
    await f.chat.initialize();
    await expect.poll(() => f.inbox.list().length).toBe(1);
    const signal = new AbortController().signal;
    const event = f.inbox.claimNext()!;
    f.inbox.beginDispatch(event.id, event.operationId!, await gatewayConversation(event, signal));
    const target = path.join(ensureBrain(), `${f.instance.id}.txt`);
    fs.writeFileSync(target, 'verified document bytes');
    await selectGatewayDocuments(f.inbox, event.id, { paths: [target] }, signal);
    f.inbox.finishDispatch(event.id, event.operationId!, 'Here is your document.');
    const replies = new GatewayReplies(
      f.inbox,
      (input, text, abort) => f.adapter.replyText(input, text, abort),
      signal,
      () => true,
      (input, file, abort) => f.adapter.replyDocument(input, file, abort),
    );
    cleanups.push(() => replies.stop());
    await replies.wake();
    expect(
      f.calls.filter((call) => ['sendMessage', 'sendDocument'].includes(call.method)).map((call) => call.method),
    ).toEqual(['sendMessage', 'sendDocument']);
    const body = f.calls.find((call) => call.method === 'sendDocument')!.body;
    expect(body).toContain('verified document bytes');
    expect(body).toContain(`filename="${path.basename(target)}"`);
    expect(body).toContain('name="chat_id"');
    expect(body).toContain('123');
    expect(body).toContain('name="reply_parameters"');
    expect(body).toContain('{"message_id":1}');
    expect(f.inbox.list()[0].outgoing?.[0].status).toBe('sent');
    expect(f.inbox.list()[0].outgoing?.[0].remoteId).toBeTruthy();
    fs.writeFileSync(target, 'changed document bytes');
    await expect(
      f.adapter.replyDocument(f.inbox.list()[0], f.inbox.list()[0].outgoing![0], signal),
    ).rejects.toMatchObject({ outcome: 'failed' });
    expect(f.calls.filter((call) => call.method === 'sendDocument')).toHaveLength(1);
  });

  it.each([
    { code: 429, outcome: 'retry' },
    { code: 403, outcome: 'failed' },
    { code: 500, outcome: 'uncertain' },
  ])('classifies $code send failures without exposing provider details', async ({ code, outcome }) => {
    const f = await fixture({ sendError: code });
    f.batches.push([update(1)]);
    await f.chat.initialize();
    await expect.poll(() => f.inbox.list().length).toBe(1);
    const send = f.adapter.replyText(f.inbox.list()[0], 'Answer', new AbortController().signal);
    await expect(send).rejects.toMatchObject({
      outcome,
      message: 'The gateway reply could not be confirmed.',
      ...(code === 429 ? { retryAfterMs: 7000 } : {}),
    });
    expect(f.calls.filter((call) => call.method === 'sendMessage')).toHaveLength(1);
  });

  it('dispatches accepted input once and sends the saved final text to its original message', async () => {
    const f = await fixture();
    let submissions = 0;
    const answer = '**Literal** :wave: [text] 😀';
    const abort = new AbortController();
    const dispatcher = new GatewayDispatcher(f.inbox, abort.signal, {
      async submit() {
        submissions++;
        return {};
      },
      poll() {
        return { state: 'completed', answer };
      },
    });
    const replies = new GatewayReplies(
      f.inbox,
      (event, text, signal) => f.adapter.replyText(event, text, signal),
      abort.signal,
    );
    cleanups.push(async () => {
      abort.abort();
      await dispatcher.stop();
      await replies.stop();
    });
    await dispatcher.start();
    replies.start();
    f.batches.push([update(1), update(2, 456), update(1)]);
    await f.chat.initialize();
    await expect.poll(() => f.inbox.list()[0]?.reply?.parts[0]?.status).toBe('sent');
    expect(submissions).toBe(1);
    expect(f.inbox.list()).toHaveLength(1);
    const sends = f.calls.filter((call) => call.method === 'sendMessage');
    expect(sends).toHaveLength(1);
    expect(JSON.parse(sends[0].body)).toMatchObject({
      chat_id: '123',
      text: answer,
      reply_parameters: { message_id: 1 },
    });
    expect(JSON.parse(sends[0].body)).not.toHaveProperty('parse_mode');
    expect(f.inbox.list()[0].reply?.parts[0].remoteId).toBeTruthy();
  });

  it('streams private files with metadata limits, safe provider paths and no redirects', async () => {
    const valid = await fixture();
    const result = await valid.adapter.downloadFileSource('private-file', 16, new AbortController().signal);
    const chunks: Buffer[] = [];
    for await (const chunk of result.source) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe('hello');
    expect(result.declaredBytes).toBe(5);
    const large = await fixture({ fileSize: 1000 });
    await expect(large.adapter.downloadFileSource('private-file', 16, new AbortController().signal)).rejects.toThrow(
      'limit',
    );
    expect(large.calls.some((call) => call.method === 'proof.txt')).toBe(false);
    const escape = await fixture({ filePath: '../proof.txt' });
    await expect(escape.adapter.downloadFileSource('private-file', 16, new AbortController().signal)).rejects.toThrow(
      'unsafe',
    );
    const redirect = await fixture({ redirect: true });
    await expect(
      redirect.adapter.downloadFileSource('private-file', 16, new AbortController().signal),
    ).rejects.toThrow();
    expect(redirect.calls.some((call) => call.method === 'forbidden-download')).toBe(false);
  });
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
    const anonymous = update(3);
    anonymous.message!.sender_chat = { id: -10, type: 'supergroup' };
    const missing = update(4);
    delete missing.message!.from;
    const bot = update(5);
    bot.message!.from!.is_bot = true;
    const file = update(6);
    delete file.message!.text;
    file.message!.document = {
      file_id: 'private-file',
      file_unique_id: 'unique',
      file_name: 'plan.txt',
      file_size: 12,
    };
    const wrongGroup = update(7);
    wrongGroup.message!.chat = { id: -200, type: 'supergroup' };
    const forwarded = update(8, 456);
    Object.assign(forwarded.message!, {
      forward_origin: { type: 'user', sender_user: { id: 123, is_bot: false, first_name: 'Allowed author' } },
    });
    const denied = update(2, 456);
    denied.message!.text = 'denied-private-text';
    f.batches.push([update(1), denied, anonymous, missing, bot, file, wrongGroup, forwarded]);
    await f.chat.initialize();
    await expect.poll(() => f.inbox.list().length).toBe(2);
    expect(f.inbox.list().map((event) => event.input.sourceMessageId)).toEqual(['1', '6']);
    expect(f.inbox.list()[1].input.media[0].fileId).toBe('private-file');
    expect(fs.readFileSync(f.state.inboxFile(), 'utf8')).not.toContain('denied-private-text');
    expect(
      f.calls.some((call) => ['getFile', 'sendMessage', 'sendDocument', 'deleteWebhook'].includes(call.method)),
    ).toBe(false);
  });

  it('uses the real bot username for topic mentions and applies changed sender rules to subsequent batches', async () => {
    const f = await fixture();
    const shared = update(1);
    shared.message!.chat = { id: -100, type: 'supergroup' };
    shared.message!.message_thread_id = 7;
    shared.message!.text = '@actual_bot please help';
    f.batches.push([shared]);
    await f.chat.initialize();
    await expect.poll(() => f.inbox.list().length).toBe(1);
    saveGatewayInstance(
      { ...gatewayConfig(f.instance.accountId), senderPolicy: { platform: 'telegram', allowedUserIds: ['777'] } },
      f.instance.id,
    );
    f.batches.push([update(2)]);
    await expect.poll(() => f.calls.filter((call) => call.method === 'getUpdates').length).toBeGreaterThan(3);
    expect(f.inbox.list()).toHaveLength(1);
  });

  it('does not advance the polling offset when the durable inbox commit fails', async () => {
    const f = await fixture({ failCommit: true });
    f.batches.push([update(1)]);
    await f.chat.initialize();
    await expect.poll(() => f.calls.filter((call) => call.method === 'getUpdates').length).toBeGreaterThan(1);
    const before = f.calls.filter((call) => call.method === 'getUpdates');
    expect(before.every((call) => !Object.hasOwn(JSON.parse(call.body) as object, 'offset'))).toBe(true);
    f.unblock();
    f.batches.push([update(1)]);
    await expect.poll(() => f.inbox.list().length).toBe(1);
    await expect
      .poll(() =>
        f.calls.some(
          (call) => call.method === 'getUpdates' && (JSON.parse(call.body) as { offset?: number }).offset === 2,
        ),
      )
      .toBe(true);
    f.batches.push([update(1)]);
    await expect
      .poll(() => f.calls.filter((call) => call.method === 'getUpdates').length)
      .toBeGreaterThan(before.length + 2);
    expect(f.inbox.list()).toHaveLength(1);
  });
});
