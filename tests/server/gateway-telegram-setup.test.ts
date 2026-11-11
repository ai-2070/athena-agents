import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Chat } from 'chat';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GatewayTelegramSetupState } from '../../shared/types.ts';
import { getGatewayInstance, saveGatewayCredentials, saveGatewayInstance } from '../../server/gateways/instances.ts';
import { GatewayStateAdapter } from '../../server/gateways/state.ts';
import { GatewayInbox } from '../../server/gateways/inbox.ts';
import { GatewaySupervisor } from '../../server/gateways/supervisor.ts';
import { TelegramIntakeAdapter } from '../../server/gateways/telegram.ts';
import {
  checkTelegramSetup,
  requireTelegramSetupReviewed,
  switchTelegramToPolling,
  telegramSetup,
} from '../../server/gateways/telegram-setup.ts';
import { gatewayConfig, gatewayInput } from './gateway-fixtures.ts';

const TOKEN = '9600000001:PRIVATE_TOKEN';
const HOOK = 'https://private-user:PRIVATE_PASSWORD@receiver.example/PRIVATE_PATH?key=PRIVATE_QUERY';
const closes: (() => Promise<void>)[] = [];
let accounts = 9550000000;
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const close of closes.splice(0).reverse()) await close();
});
async function fixture() {
  const config = gatewayConfig(String(accounts++));
  const instance = saveGatewayInstance(config);
  saveGatewayCredentials(instance.id, { botToken: TOKEN });
  const state = new GatewayStateAdapter(instance.id);
  await state.connect();
  closes.push(() => state.disconnect());
  const inbox = new GatewayInbox(state);
  inbox.accept({ ...gatewayInput(), accountId: instance.accountId });
  const work = inbox.claimNext()!;
  inbox.complete(work.id, work.operationId!);
  saveGatewayInstance({ ...config, enabled: false }, instance.id);
  const file = path.join(path.dirname(state.inboxFile()), 'telegram-setup.json');
  const calls: { method: string; init: RequestInit }[] = [];
  let hook = HOOK;
  let pending = 7;
  let wrongBot = false;
  let reject: string | undefined;
  let loseDelete = false;
  let remains = false;
  let extra: Record<string, unknown> = {};
  let intercept: ((method: string) => void) | undefined;
  const request = async (url: string, init: RequestInit) => {
    expect(url.startsWith(`https://api.telegram.org/bot${TOKEN}/`)).toBe(true);
    expect(init.redirect).toBe('error');
    expect(init.method).toBe('POST');
    const method = url.split('/').at(-1)!;
    calls.push({ method, init });
    intercept?.(method);
    if (reject === method) throw new Error('PRIVATE_NETWORK ' + TOKEN + HOOK);
    if (method === 'getMe')
      return Response.json({ ok: true, result: { id: Number(instance.accountId) + (wrongBot ? 1 : 0), is_bot: true } });
    if (method === 'getWebhookInfo')
      return Response.json({
        ok: true,
        result: { url: hook, pending_update_count: pending, has_custom_certificate: false, ...extra },
      });
    expect(method).toBe('deleteWebhook');
    expect(JSON.parse(String(init.body))).toEqual({ drop_pending_updates: false });
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as GatewayTelegramSetupState;
    expect(saved.switches.at(-1)!.state).toBe('started');
    expect(saved.check).toBeUndefined();
    if (!remains) hook = '';
    if (loseDelete) throw new Error('Lost delete response');
    return Response.json({ ok: true, result: true });
  };
  const options = { request };
  const check = () => checkTelegramSetup(state, options);
  const preview = () => telegramSetup(instance.id);
  const body = () => ({ revision: preview().revision, acknowledgeStopped: true, acknowledgeKeepUpdates: true });
  const change = (value: {
    hook?: string;
    pending?: number;
    wrongBot?: boolean;
    reject?: string;
    loseDelete?: boolean;
    remains?: boolean;
    extra?: Record<string, unknown>;
    intercept?: (method: string) => void;
  }) => {
    if (value.hook !== undefined) hook = value.hook;
    if (value.pending !== undefined) pending = value.pending;
    if (value.wrongBot !== undefined) wrongBot = value.wrongBot;
    reject = value.reject;
    if (value.loseDelete !== undefined) loseDelete = value.loseDelete;
    if (value.remains !== undefined) remains = value.remains;
    if (value.extra !== undefined) extra = value.extra;
    intercept = value.intercept;
  };
  return {
    config,
    instance,
    state,
    inbox,
    file,
    calls,
    options,
    check,
    preview,
    body,
    change,
    switch: (body: unknown) => switchTelegramToPolling(state, body, options),
  };
}

describe('explicit paused Telegram polling setup', () => {
  it('keeps the token separator in Telegram format while escaping other path and query characters', async () => {
    const f = await fixture();
    saveGatewayCredentials(f.instance.id, { botToken: '9550000000:private/path?query#fragment' });
    const paths: string[] = [];
    await checkTelegramSetup(f.state, {
      request: async (url) => {
        const address = new URL(url);
        expect(address.origin).toBe('https://api.telegram.org');
        expect(address.search).toBe('');
        expect(address.hash).toBe('');
        paths.push(address.pathname);
        return Response.json({
          ok: true,
          result: url.endsWith('/getMe')
            ? { id: Number(f.instance.accountId), is_bot: true }
            : { url: '', pending_update_count: 0, has_custom_certificate: false },
        });
      },
    });
    expect(paths).toEqual([
      '/bot9550000000:private%2Fpath%3Fquery%23fragment/getMe',
      '/bot9550000000:private%2Fpath%3Fquery%23fragment/getWebhookInfo',
    ]);
  });

  it('reads only local status on GET and keeps remote webhook secrets out of checks and saved receipts', async () => {
    const f = await fixture();
    const before = fs.readFileSync(f.state.inboxFile(), 'utf8');
    expect(f.preview().check).toBeNull();
    expect(f.calls).toEqual([]);
    const checked = await f.check();
    expect(f.calls.map((item) => item.method)).toEqual(['getMe', 'getWebhookInfo']);
    expect(checked).toMatchObject({
      reason: '',
      check: { webhook: true, host: 'receiver.example', pendingUpdates: 7 },
      revision: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    for (const value of [TOKEN, HOOK, 'PRIVATE_PASSWORD', 'PRIVATE_PATH', 'PRIVATE_QUERY']) {
      expect(JSON.stringify(checked)).not.toContain(value);
      expect(fs.readFileSync(f.file, 'utf8')).not.toContain(value);
    }
    expect(fs.readFileSync(f.state.inboxFile(), 'utf8')).toBe(before);
    expect(getGatewayInstance(f.instance.id).enabled).toBe(false);
  });

  it('writes an intent first, removes exactly the verified webhook with pending updates kept, verifies and stays paused', async () => {
    const f = await fixture();
    await f.check();
    const body = f.body();
    const before = fs.readFileSync(f.state.inboxFile(), 'utf8');
    const result = await f.switch(body);
    expect(f.calls.map((item) => item.method)).toEqual([
      'getMe',
      'getWebhookInfo',
      'getMe',
      'getWebhookInfo',
      'deleteWebhook',
      'getMe',
      'getWebhookInfo',
    ]);
    expect(result).toMatchObject({
      revision: null,
      check: { webhook: false, pendingUpdates: 7 },
      attempt: { state: 'confirmed', checkedAt: expect.any(Number) },
      switches: 1,
    });
    expect(getGatewayInstance(f.instance.id).enabled).toBe(false);
    expect(fs.readFileSync(f.state.inboxFile(), 'utf8')).toBe(before);
    await f.state.disconnect();
    await f.state.connect();
    expect(f.preview()).toEqual(result);
    expect(() => requireTelegramSetupReviewed(f.instance.id)).not.toThrow();
    await expect(f.switch(body)).rejects.toMatchObject({ status: 409 });
    expect(f.calls.filter((item) => item.method === 'deleteWebhook')).toHaveLength(1);
  });

  it('requires explicit current acknowledgements and refuses changed, expired or cross-instance checks before remote deletion', async () => {
    const f = await fixture();
    await f.check();
    const body = f.body();
    for (const invalid of [
      {},
      { ...body, acknowledgeStopped: false },
      { ...body, acknowledgeKeepUpdates: false },
      { ...body, extra: true },
      { ...body, revision: 'a'.repeat(64) },
    ])
      await expect(f.switch(invalid)).rejects.toMatchObject({ status: 409 });
    const other = await fixture();
    await other.check();
    await expect(other.switch(body)).rejects.toMatchObject({ status: 409 });
    expect(other.calls.some((item) => item.method === 'deleteWebhook')).toBe(false);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 600001);
    await expect(f.switch(body)).rejects.toThrow('expired');
    vi.restoreAllMocks();
    saveGatewayInstance({ ...f.config, enabled: false, name: 'Renamed' }, f.instance.id);
    await expect(f.switch(body)).rejects.toThrow('changed');
    expect(f.calls.some((item) => item.method === 'deleteWebhook')).toBe(false);
  });

  it('rechecks full webhook settings rather than trusting a matching displayed host or volatile queue count', async () => {
    const f = await fixture();
    await f.check();
    const body = f.body();
    f.change({ hook: HOOK.replace('PRIVATE_PATH', 'OTHER_PRIVATE_PATH') });
    await expect(f.switch(body)).rejects.toThrow('webhook changed');
    expect(f.calls.some((item) => item.method === 'deleteWebhook')).toBe(false);
    await f.check();
    f.change({ pending: 12 });
    expect((await f.switch(f.body())).check?.pendingUpdates).toBe(12);
  });

  it('checks the exact bot, sender rules and token again without taking over an enabled instance', async () => {
    const f = await fixture();
    f.change({ wrongBot: true });
    await expect(f.check()).rejects.toThrow('different bot');
    expect(f.calls.map((item) => item.method)).toEqual(['getMe']);
    f.change({ wrongBot: false });
    await f.check();
    const body = f.body();
    saveGatewayCredentials(f.instance.id, { botToken: TOKEN + '-changed' });
    await expect(f.switch(body)).rejects.toThrow('changed');
    saveGatewayInstance(f.config, f.instance.id);
    await expect(f.check()).rejects.toThrow('Pause');
    saveGatewayInstance(
      { ...f.config, enabled: false, senderPolicy: { platform: 'telegram', allowedUserIds: [] } },
      f.instance.id,
    );
    await expect(f.check()).rejects.toThrow('allowed senders');
    expect(f.calls.some((item) => item.method === 'deleteWebhook')).toBe(false);
  });

  it('rejects changes during remote inspection before any deletion', async () => {
    const f = await fixture();
    await f.check();
    const body = f.body();
    f.change({
      intercept: (method) => {
        if (method === 'getWebhookInfo')
          saveGatewayInstance({ ...f.config, enabled: false, name: 'Changed while checking' }, f.instance.id);
      },
    });
    await expect(f.switch(body)).rejects.toThrow('changed');
    expect(f.calls.some((item) => item.method === 'deleteWebhook')).toBe(false);
  });

  it('holds an uncertain switch across restart, blocks the adapter without provider I/O, and resolves only through an explicit check', async () => {
    const f = await fixture();
    await f.check();
    const body = f.body();
    f.change({ loseDelete: true });
    await expect(f.switch(body)).rejects.toThrow('unconfirmed');
    expect(f.preview()).toMatchObject({ revision: null, check: null, attempt: { state: 'uncertain' } });
    await f.state.disconnect();
    await f.state.connect();
    expect(() => requireTelegramSetupReviewed(f.instance.id)).toThrow('unconfirmed');
    const count = f.calls.length;
    await expect(f.switch(body)).rejects.toThrow('changed');
    expect(f.calls.length).toBe(count);
    saveGatewayInstance(f.config, f.instance.id);
    const adapter = new TelegramIntakeAdapter(f.instance.id, f.inbox, TOKEN, () => {});
    const chat = new Chat({ userName: 'Athena', adapters: { telegram: adapter }, state: f.state });
    await expect(chat.initialize()).rejects.toThrow('switch receipts');
    expect(f.calls.length).toBe(count);
    saveGatewayInstance({ ...f.config, enabled: false }, f.instance.id);
    const checked = await f.check();
    expect(checked.attempt?.state).toBe('confirmed');
    expect(() => requireTelegramSetupReviewed(f.instance.id)).not.toThrow();
    expect(f.calls.filter((item) => item.method === 'deleteWebhook')).toHaveLength(1);
  });

  it('requires a fresh explicit check and confirmation after an unsuccessful or replaced remote webhook', async () => {
    const f = await fixture();
    await f.check();
    f.change({ remains: true });
    await expect(f.switch(f.body())).rejects.toThrow('unconfirmed');
    expect(f.preview().revision).toBeNull();
    await f.check();
    const next = f.body();
    expect(next.revision).toBeTruthy();
    f.change({ remains: false });
    expect((await f.switch(next)).switches).toBe(2);
  });

  it('fails before remote deletion if the intent cannot save, and keeps a durable hold when its final write fails', async () => {
    const f = await fixture();
    await f.check();
    const before = fs.readFileSync(f.file, 'utf8');
    const write = fs.writeFileSync.bind(fs);
    vi.spyOn(fs, 'writeFileSync').mockImplementation((file, ...args) => {
      if (String(file).includes('telegram-setup.json')) throw new Error('PRIVATE_DISK');
      return write(file, ...args);
    });
    await expect(f.switch(f.body())).rejects.toThrow('could not be saved');
    vi.restoreAllMocks();
    expect(fs.readFileSync(f.file, 'utf8')).toBe(before);
    expect(f.calls.some((item) => item.method === 'deleteWebhook')).toBe(false);
    f.change({
      intercept: (method) => {
        if (method === 'deleteWebhook')
          vi.spyOn(fs, 'writeFileSync').mockImplementation((file, ...args) => {
            if (String(file).includes('telegram-setup.json')) throw new Error('PRIVATE_DISK');
            return write(file, ...args);
          });
      },
    });
    await expect(f.switch(f.body())).rejects.toThrow('could not be saved');
    vi.restoreAllMocks();
    expect(f.preview().attempt?.state).toBe('started');
    expect(() => requireTelegramSetupReviewed(f.instance.id)).toThrow('unconfirmed');
  });

  it('redacts provider failures and rejects malformed, oversized and redirect responses without a delete', async () => {
    const f = await fixture();
    f.change({ reject: 'getMe' });
    await expect(f.check()).rejects.toThrow('could not be verified');
    f.change({ extra: { pending_update_count: -1 } });
    await expect(f.check()).rejects.toThrow('invalid webhook');
    for (const response of [
      Response.json({ ok: false, description: TOKEN + HOOK }),
      new Response('x'.repeat(65537)),
      new Response(null, { status: 302, headers: { location: HOOK } }),
    ]) {
      await expect(checkTelegramSetup(f.state, { request: async () => response })).rejects.toThrow(
        'could not be verified',
      );
    }
    expect(f.calls.some((item) => item.method === 'deleteWebhook')).toBe(false);
  });

  it('does not switch a bot with no webhook, retains a full audit and refuses unreadable receipts', async () => {
    const f = await fixture();
    f.change({ hook: '' });
    await f.check();
    expect(f.preview().revision).toBeNull();
    await expect(f.switch(f.body())).rejects.toThrow('changed');
    f.change({ hook: HOOK });
    await f.check();
    const saved = JSON.parse(fs.readFileSync(f.file, 'utf8')) as GatewayTelegramSetupState;
    saved.switches = Array.from({ length: 100 }, (_, i) => ({
      at: i,
      checkedAt: i,
      revision: crypto.createHash('sha256').update(String(i)).digest('hex'),
      state: 'confirmed',
    }));
    fs.writeFileSync(f.file, JSON.stringify(saved));
    expect(f.preview().reason).toContain('history is full');
    await expect(f.switch(f.body())).rejects.toThrow('changed');
    fs.writeFileSync(f.file, '{broken');
    expect(() => f.preview()).toThrow('unreadable');
    expect(() => requireTelegramSetupReviewed(f.instance.id)).toThrow('unreadable');
  });

  it('checks and switches through exclusive supervisor ownership without constructing a transport', async () => {
    const f = await fixture();
    const supervisor = new GatewaySupervisor(() => {
      throw new Error('No transport');
    });
    closes.push(() => supervisor.stop());
    vi.stubGlobal('fetch', f.options.request);
    await expect(supervisor.checkTelegramSetup(f.instance.id)).rejects.toMatchObject({ status: 503 });
    expect(f.calls).toHaveLength(0);
    await f.state.disconnect();
    await supervisor.checkTelegramSetup(f.instance.id);
    expect((await supervisor.switchTelegramToPolling(f.instance.id, f.body())).attempt?.state).toBe('confirmed');
  });
});
