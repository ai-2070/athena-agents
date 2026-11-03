// Offline SDK proof under Bun or Node: local fake Telegram API, no platform credentials or messages.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { Chat } from 'chat';
import type { Logger } from 'chat';
import { createTelegramAdapter } from '@chat-adapter/telegram';
import { createSlackAdapter } from '@chat-adapter/slack';
import { createDiscordAdapter } from '@chat-adapter/discord';
import { createWhatsAppAdapter } from '@chat-adapter/whatsapp';

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-gateways-smoke-'));
process.env.DASH_DATA = path.join(temporary, 'data');
process.env.HOME = process.env.USERPROFILE = path.join(temporary, 'home');
fs.mkdirSync(process.env.DASH_DATA);
fs.mkdirSync(process.env.HOME);
const { GatewayStateAdapter } = await import('../server/gateways/state.ts');
const logger: Logger = { child: () => logger, debug() {}, info() {}, warn() {}, error() {} };
const calls: string[] = [];
const fixture = 'Athena gateway file proof';
let sentInput = false;
let sentFile = false;
let handled = 0;
const failures: Error[] = [];
const server = http.createServer(async (request, response) => {
  try {
    const method = request.url?.split('/').at(-1) ?? '';
    calls.push(method);
    const body: Buffer[] = [];
    for await (const chunk of request) body.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const bytes = Buffer.concat(body);
    let result: unknown;
    switch (method) {
      case 'getMe': result = { id: 999, is_bot: true, first_name: 'Athena', username: 'athena_proof_bot' }; break;
      case 'getUpdates': {
        if (!sentInput) {
          sentInput = true;
          result = [123, 456].map((userId, index) => ({
            update_id: index + 1,
            message: {
              message_id: index + 10, date: Math.floor(Date.now() / 1000),
              chat: { id: userId, type: 'private', first_name: 'Fixture' },
              from: { id: userId, is_bot: false, first_name: 'Fixture' },
              document: { file_id: 'proof-file', file_unique_id: 'proof-unique', file_name: 'proof.txt', mime_type: 'text/plain', file_size: fixture.length },
            },
          }));
        } else {
          await new Promise((resolve) => setTimeout(resolve, 25));
          result = [];
        }
        break;
      }
      case 'getFile': result = { file_id: 'proof-file', file_unique_id: 'proof-unique', file_path: 'proof.txt', file_size: fixture.length }; break;
      case 'sendChatAction': result = true; break;
      case 'proof.txt': response.end(fixture); return;
      case 'sendDocument': {
        assert.ok(bytes.toString().includes(fixture), 'outbound multipart body must contain the file bytes');
        sentFile = true;
        result = { message_id: 20, date: Math.floor(Date.now() / 1000), chat: { id: 123, type: 'private' }, document: { file_id: 'outbound', file_unique_id: 'outbound-unique', file_name: 'proof.txt' } };
        break;
      }
      default: throw new Error(`Unexpected fake Telegram API call: ${method}`);
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ ok: true, result }));
  } catch (error) {
    failures.push(error instanceof Error ? error : new Error(String(error)));
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: false, description: 'Fixture failed' }));
  }
});
let chat: Chat | undefined;
try {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const apiUrl = `http://127.0.0.1:${address.port}`;
  // Import and construct every pinned adapter without opening a real platform connection.
  assert.equal(createSlackAdapter({ botToken: 'fixture', appToken: 'fixture', signingSecret: 'fixture', mode: 'socket', apiUrl, logger }).name, 'slack');
  assert.equal(createDiscordAdapter({ botToken: 'fixture', applicationId: '999', publicKey: '0'.repeat(64), apiUrl, logger }).name, 'discord');
  assert.equal(createWhatsAppAdapter({ accessToken: 'fixture', appSecret: 'fixture', verifyToken: 'fixture', phoneNumberId: '999', apiUrl, logger }).name, 'whatsapp');
  const telegram = createTelegramAdapter({
    botToken: 'fixture', apiUrl, logger, allowedUserIds: ['123'],
    mode: 'polling', longPolling: { deleteWebhook: false, timeout: 1 },
  });
  const state = new GatewayStateAdapter('sdk-smoke');
  chat = new Chat({ userName: 'athena_proof_bot', adapters: { telegram }, state, logger, concurrency: 'concurrent' });
  const delivered = new Promise<void>((resolve, reject) => {
    chat!.onDirectMessage(async (thread, message) => {
      try {
        handled++;
        assert.equal(message.author.userId, '123');
        assert.equal(message.text, '');
        const attachment = message.attachments[0];
        assert.ok(attachment.fetchData);
        const downloaded = await attachment.fetchData();
        const bytes = Buffer.isBuffer(downloaded) ? downloaded : Buffer.from(downloaded);
        assert.equal(bytes.toString(), fixture);
        await thread.subscribe();
        await thread.post({ markdown: 'Received your file', files: [{ data: bytes, filename: 'proof.txt', mimeType: 'text/plain' }] });
        resolve();
      } catch (error) { reject(error); }
    });
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await chat.initialize();
    await Promise.race([delivered, new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('SDK fixture did not deliver a file.')), 10000);
    })]);
    assert.equal(handled, 1, 'denied sender must never reach the handler');
    assert.ok(sentFile);
    assert.ok(!calls.includes('deleteWebhook'), 'polling must preserve webhook configuration');
    assert.deepEqual(failures, []);
    await chat.shutdown();
    const reopened = new GatewayStateAdapter('sdk-smoke');
    await reopened.connect();
    try { assert.ok(await reopened.isSubscribed('telegram:123')); }
    finally { await reopened.disconnect(); }
    console.log('gateways: pinned adapters load; Telegram polling, sender filter, private download, file reply and persistent subscription pass');
  } finally { clearTimeout(timeout); }
} finally {
  await chat?.shutdown();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(temporary, { recursive: true, force: true });
}
