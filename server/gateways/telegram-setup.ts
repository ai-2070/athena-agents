import crypto from 'node:crypto';
import fs from 'node:fs';
import { z } from 'zod';
import type { GatewayTelegramSetup, GatewayTelegramSetupState } from '../../shared/types.ts';
import { emit, getGatewaySecrets } from '../store.ts';
import { privateDataPath } from '../private.ts';
import { readJSON, writeJSON } from '../util.ts';
import { checkGatewayDestination, getGatewayInstance } from './instances.ts';
import type { GatewayStateAdapter } from './state.ts';

const stamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const key = z.string().regex(/^[a-f0-9]{64}$/);
const schema: z.ZodType<GatewayTelegramSetupState> = z
  .strictObject({
    version: z.literal(1),
    check: z
      .strictObject({
        at: stamp,
        configRevision: key,
        revision: key,
        fingerprint: key,
        webhook: z.boolean(),
        host: z.string().min(1).max(256).optional(),
        pendingUpdates: stamp,
      })
      .optional(),
    switches: z
      .array(
        z.strictObject({
          at: stamp,
          revision: key,
          state: z.enum(['started', 'confirmed', 'uncertain']),
          checkedAt: stamp.optional(),
        }),
      )
      .max(100),
  })
  .refine(
    (value) =>
      (!value.check || value.check.webhook === Boolean(value.check.host)) &&
      new Set(value.switches.map((item) => item.revision)).size === value.switches.length &&
      value.switches.every(
        (item, index) =>
          (index === 0 || item.at >= value.switches[index - 1].at) &&
          (item.state !== 'confirmed' || item.checkedAt !== undefined) &&
          (item.checkedAt === undefined || item.checkedAt >= item.at),
      ),
  );
const webhook = z.object({
  url: z.string().max(4096),
  pending_update_count: stamp,
  has_custom_certificate: z.boolean(),
  ip_address: z.string().max(256).optional(),
  max_connections: stamp.optional(),
  allowed_updates: z.array(z.string().max(100)).max(100).optional(),
});
const fail = (message: string, status = 400): never => {
  throw Object.assign(new Error(message), { status });
};
const hash = (value: unknown): string => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const file = (id: string) => {
  getGatewayInstance(id);
  return privateDataPath('gateways-runtime', id, 'telegram-setup.json');
};
function read(id: string): GatewayTelegramSetupState {
  const target = file(id);
  if (!fs.existsSync(target)) return { version: 1, switches: [] };
  const parsed = schema.safeParse(readJSON(target));
  if (!parsed.success) return fail('The Telegram setup receipts are unreadable. Restore them before continuing.', 503);
  return parsed.data;
}
function save(id: string, value: GatewayTelegramSetupState): void {
  try {
    writeJSON(file(id), value);
  } catch {
    return fail('Telegram setup could not be saved. Check storage, then reload and check setup.', 503);
  }
  emit('gateway-health', { instanceId: id });
}
function context(id: string, paused = false) {
  const instance = getGatewayInstance(id);
  if (instance.platform !== 'telegram') return fail('Choose a Telegram instance.');
  if (paused && instance.enabled) return fail('Pause this Telegram instance before checking or switching its setup.');
  const token = getGatewaySecrets(id).botToken;
  return { instance, token, revision: hash([instance, token ?? '']) };
}
function prerequisites(id: string): ReturnType<typeof context> {
  const value = context(id, true);
  if (
    !value.token ||
    !/^[1-9]\d*$/.test(value.instance.accountId) ||
    value.instance.senderPolicy.platform !== 'telegram' ||
    !value.instance.senderPolicy.allowedUserIds.length ||
    (!value.instance.scope.directMessages && !value.instance.scope.conversationIds.length)
  )
    return fail(
      'Save the bot token, numeric account ID, allowed senders and conversation scope before checking setup.',
    );
  checkGatewayDestination(id);
  return value;
}
function current(id: string, revision: string): void {
  if (prerequisites(id).revision !== revision)
    return fail('This instance or its token changed. Check setup again before switching.', 409);
}

/** Local status only. Full webhook URLs, tokens and provider errors stay private. */
export function telegramSetup(id: string): GatewayTelegramSetup {
  const { instance, token, revision } = context(id);
  const state = read(id);
  const check = state.check;
  const attempt = state.switches.at(-1);
  const fresh = check && check.configRevision === revision && check.at <= Date.now() && Date.now() - check.at <= 600000;
  const reason = instance.enabled
    ? 'Pause this instance before checking or switching Telegram setup.'
    : !token
      ? 'Add a bot token in the instance editor, then check setup.'
      : !fresh
        ? 'Check setup to verify this bot and its current webhook.'
        : check.webhook && state.switches.length >= 100
          ? 'The switch history is full. Keep its receipts intact before continuing.'
          : '';
  return {
    reason,
    revision: !reason && check?.webhook ? check.revision : null,
    check: check
      ? {
          at: check.at,
          webhook: check.webhook,
          ...(check.host ? { host: check.host } : {}),
          pendingUpdates: check.pendingUpdates,
        }
      : null,
    attempt: attempt
      ? {
          at: attempt.at,
          state: attempt.state,
          ...(attempt.checkedAt !== undefined ? { checkedAt: attempt.checkedAt } : {}),
        }
      : null,
    switches: state.switches.length,
  };
}

export function requireTelegramSetupReviewed(id: string): void {
  const latest = read(id).switches.at(-1);
  if (latest && latest.state !== 'confirmed')
    return fail(
      'The Telegram switch has an unconfirmed outcome. Pause this instance and check Telegram setup before connecting.',
      409,
    );
}

type Options = {
  request?: (url: string, init: RequestInit) => Promise<Response>;
  testOrigin?: string;
  timeoutMs?: number;
};
function client(token: string, options: Options) {
  const origin = options.testOrigin ?? 'https://api.telegram.org';
  if (options.testOrigin && !/^http:\/\/127\.0\.0\.1:\d+$/.test(origin))
    return fail('The test Telegram origin must be loopback.');
  // Keep Telegram's token separator without letting a token change the URL path.
  const pathToken = encodeURIComponent(token).replaceAll('%3A', ':');
  const signal = AbortSignal.timeout(options.timeoutMs ?? 15000);
  return async (method: 'getMe' | 'getWebhookInfo' | 'deleteWebhook'): Promise<unknown> => {
    try {
      const response = await (options.request ?? fetch)(`${origin}/bot${pathToken}/${method}`, {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(method === 'deleteWebhook' ? { drop_pending_updates: false } : {}),
      });
      if (!response.ok || !response.body) throw new Error();
      const reader = response.body.getReader();
      const chunks: Buffer[] = [];
      let size = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > 65536) throw new Error();
          chunks.push(Buffer.from(next.value));
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      const envelope = z
        .object({ ok: z.literal(true), result: z.unknown() })
        .parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      return envelope.result;
    } catch {
      return fail(
        'Telegram setup could not be verified. Check the token and connection, then check setup again. No automatic switch will be retried.',
        503,
      );
    }
  };
}
async function inspect(id: string, revision: string, request: ReturnType<typeof client>) {
  const bot = z.object({ id: stamp.positive(), is_bot: z.literal(true) }).safeParse(await request('getMe'));
  if (!bot.success || String(bot.data.id) !== getGatewayInstance(id).accountId)
    return fail('The Telegram token belongs to a different bot. Check the account ID and token.', 409);
  const info = webhook.safeParse(await request('getWebhookInfo'));
  if (!info.success) return fail('Telegram returned an invalid webhook status. Check setup again.', 503);
  current(id, revision);
  let host: string | undefined;
  if (info.data.url) {
    try {
      const url = new URL(info.data.url);
      if (url.protocol !== 'https:') throw new Error();
      host = url.hostname;
      if (!host || host.length > 256) throw new Error();
    } catch {
      return fail('Telegram returned an invalid webhook address. Review the bot setup before switching.', 503);
    }
  }
  const { pending_update_count: pendingUpdates, ...settings } = info.data;
  return {
    at: Date.now(),
    configRevision: revision,
    revision: crypto.randomBytes(32).toString('hex'),
    fingerprint: hash(settings),
    webhook: Boolean(info.data.url),
    ...(host ? { host } : {}),
    pendingUpdates,
  };
}

export async function checkTelegramSetup(
  state: GatewayStateAdapter,
  options: Options = {},
): Promise<GatewayTelegramSetup> {
  state.inboxFile();
  const id = state.instanceId;
  const config = prerequisites(id);
  const saved = read(id);
  const check = await inspect(id, config.revision, client(config.token!, options));
  const latest = saved.switches.at(-1);
  if (latest && latest.state !== 'confirmed') {
    latest.checkedAt = check.at;
    if (!check.webhook) latest.state = 'confirmed';
  }
  saved.check = check;
  save(id, saved);
  return telegramSetup(id);
}

export async function switchTelegramToPolling(
  state: GatewayStateAdapter,
  body: unknown,
  options: Options = {},
): Promise<GatewayTelegramSetup> {
  state.inboxFile();
  const id = state.instanceId;
  const config = prerequisites(id);
  const saved = read(id);
  const preview = telegramSetup(id);
  const parsed = z
    .strictObject({ revision: key, acknowledgeStopped: z.literal(true), acknowledgeKeepUpdates: z.literal(true) })
    .safeParse(body);
  if (!parsed.success || !preview.revision || preview.revision !== parsed.data.revision)
    return fail('This setup check changed or expired. Check setup again and review its current webhook.', 409);
  const request = client(config.token!, options);
  const checked = await inspect(id, config.revision, request);
  if (!checked.webhook || checked.fingerprint !== saved.check?.fingerprint)
    return fail('The Telegram webhook changed. Check setup again before switching.', 409);
  const attempt: GatewayTelegramSetupState['switches'][number] = {
    at: Date.now(),
    revision: parsed.data.revision,
    state: 'started',
  };
  delete saved.check;
  saved.switches.push(attempt);
  save(id, saved);
  try {
    current(id, config.revision);
    if ((await request('deleteWebhook')) !== true) throw new Error();
    const after = await inspect(id, config.revision, request);
    if (after.webhook) throw new Error();
    attempt.state = 'confirmed';
    attempt.checkedAt = after.at;
    saved.check = after;
    save(id, saved);
  } catch {
    attempt.state = 'uncertain';
    delete saved.check;
    save(id, saved);
    return fail(
      'The webhook switch has an unconfirmed outcome. This instance stays paused. Check setup before taking any further action; the switch will not retry automatically.',
      503,
    );
  }
  return telegramSetup(id);
}
