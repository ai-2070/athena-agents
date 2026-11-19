// How each sender proves a webhook is really from it. Pure functions on the raw bytes: no files, no clock of their
// own, so the tests can use the providers' examples. Nothing is parsed before the check passes, except the fields a
// preset itself signs over (Stripe's and Linear's timestamps live in the body or a header).
import crypto from 'node:crypto';
import type { WebhookPreset, WebhookVerify } from '../../shared/types.ts';

export type Headers = Record<string, string | string[] | undefined>;

export type Verdict =
  | {
      ok: true;
      event: string | null;
      senderId: string | null;
      /** The sender only checks the address works (GitHub's ping): answer, don't run. */
      ping?: boolean;
      /** Answer this instead of starting anything (Slack's address check). */
      reply?: Record<string, unknown>;
    }
  | { ok: false; reason: string };

/** Five minutes either way, as Stripe, Slack and Standard Webhooks advise. */
const TOLERANCE_MS = 5 * 60_000;
/** Linear asks for a minute. */
const LINEAR_TOLERANCE_MS = 60_000;

export const PRESET_NAMES: Record<WebhookPreset, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  stripe: 'Stripe',
  slack: 'Slack',
  linear: 'Linear',
  standard: 'Standard Webhooks',
  hmac: 'Other, signed',
  token: 'Other, with a token',
  none: 'Address only',
};

/** The presets whose secret comes from the sender (you paste it); the others get one made by Athena. */
export const SENDER_SECRET: ReadonlySet<WebhookPreset> = new Set(['stripe', 'slack', 'linear', 'standard']);

export const header = (headers: Headers, name: string): string | null => {
  const v = headers[name.toLowerCase()];
  const one = Array.isArray(v) ? v[0] : v;
  return typeof one === 'string' ? one : null;
};

/** Equal, in time that doesn't depend on where they differ (both are hashed to the same length first). */
export function same(a: string | Buffer, b: string | Buffer): boolean {
  const h = (x: string | Buffer) => crypto.createHash('sha256').update(x).digest();
  return crypto.timingSafeEqual(h(a), h(b));
}

const hmac = (algorithm: 'sha256' | 'sha1', key: string | Buffer, data: string | Buffer) =>
  crypto.createHmac(algorithm, key).update(data);

/** The body as JSON, or null (only for fields a preset reads after or while checking). */
function json(raw: Buffer): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(raw.toString('utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const text = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** A form body's fields; Slack's interactive payloads are JSON in a "payload" field. */
export function formFields(raw: Buffer): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of new URLSearchParams(raw.toString('utf8'))) out[k] = v;
  if (typeof out.payload === 'string')
    try {
      out.payload = JSON.parse(out.payload) as unknown;
    } catch {
      /* left as text */
    }
  return out;
}

const fresh = (seconds: number, now: number, tolerance = TOLERANCE_MS) =>
  Number.isFinite(seconds) && Math.abs(now - seconds * 1000) <= tolerance;

const bad = (reason: string): Verdict => ({ ok: false, reason });

function github(raw: Buffer, headers: Headers, secret: string): Verdict {
  const sig = header(headers, 'x-hub-signature-256');
  if (!sig) return bad('No X-Hub-Signature-256 header. Set a secret in the GitHub webhook.');
  if (!same(sig, `sha256=${hmac('sha256', secret, raw).digest('hex')}`)) return bad('The GitHub signature is wrong.');
  const event = header(headers, 'x-github-event');
  return { ok: true, event, senderId: header(headers, 'x-github-delivery'), ping: event === 'ping' };
}

function gitlab(_raw: Buffer, headers: Headers, secret: string): Verdict {
  const token = header(headers, 'x-gitlab-token');
  if (!token) return bad('No X-Gitlab-Token header. Set the secret token in the GitLab webhook.');
  if (!same(token, secret)) return bad('The GitLab token is wrong.');
  return {
    ok: true,
    event: header(headers, 'x-gitlab-event'),
    senderId: header(headers, 'x-gitlab-event-uuid') || header(headers, 'x-gitlab-webhook-uuid'),
  };
}

function stripe(raw: Buffer, headers: Headers, secret: string, now: number): Verdict {
  const sig = header(headers, 'stripe-signature');
  if (!sig) return bad('No Stripe-Signature header.');
  const parts = sig.split(',').map((p) => p.trim().split('='));
  const t = parts.find(([k]) => k === 't')?.[1];
  const v1 = parts.filter(([k]) => k === 'v1').map(([, v]) => v || '');
  if (!t || !v1.length) return bad('The Stripe-Signature header is incomplete.');
  if (!fresh(Number(t), now)) return bad('The Stripe signature is too old or from the future.');
  const want = hmac('sha256', secret, `${t}.${raw.toString('utf8')}`).digest('hex');
  if (!v1.some((v) => same(v, want))) return bad('The Stripe signature is wrong.');
  const body = json(raw);
  return { ok: true, event: text(body?.type), senderId: text(body?.id) };
}

function slack(raw: Buffer, headers: Headers, secret: string, now: number): Verdict {
  const sig = header(headers, 'x-slack-signature');
  const ts = header(headers, 'x-slack-request-timestamp');
  if (!sig || !ts) return bad('No X-Slack-Signature or X-Slack-Request-Timestamp header.');
  if (!fresh(Number(ts), now)) return bad('The Slack signature is too old or from the future.');
  if (!same(sig, `v0=${hmac('sha256', secret, `v0:${ts}:${raw.toString('utf8')}`).digest('hex')}`))
    return bad('The Slack signature is wrong.');
  const body = json(raw);
  if (body?.type === 'url_verification' && typeof body.challenge === 'string')
    return { ok: true, event: 'url_verification', senderId: null, reply: { challenge: body.challenge } };
  if (body) {
    const inner = body.event && typeof body.event === 'object' ? (body.event as Record<string, unknown>) : null;
    return { ok: true, event: text(inner?.type) || text(body.type), senderId: text(body.event_id) };
  }
  // a slash command or an interactive action (a form)
  const form = formFields(raw);
  const payload = form.payload && typeof form.payload === 'object' ? (form.payload as Record<string, unknown>) : null;
  return { ok: true, event: text(form.command) || text(payload?.type), senderId: text(form.trigger_id) };
}

function linear(raw: Buffer, headers: Headers, secret: string, now: number): Verdict {
  const sig = header(headers, 'linear-signature');
  if (!sig) return bad('No Linear-Signature header.');
  if (!same(sig, hmac('sha256', secret, raw).digest('hex'))) return bad('The Linear signature is wrong.');
  const body = json(raw);
  const ts = typeof body?.webhookTimestamp === 'number' ? body.webhookTimestamp : Number.NaN;
  if (!fresh(ts / 1000, now, LINEAR_TOLERANCE_MS)) return bad('The Linear webhook is too old or from the future.');
  return {
    ok: true,
    event: header(headers, 'linear-event') || text(body?.type),
    senderId: header(headers, 'linear-delivery'),
  };
}

/** Standard Webhooks (standardwebhooks.com): Svix, Resend, Clerk and others. Svix's own header names work too. */
function standard(raw: Buffer, headers: Headers, secret: string, now: number): Verdict {
  const id = header(headers, 'webhook-id') || header(headers, 'svix-id');
  const ts = header(headers, 'webhook-timestamp') || header(headers, 'svix-timestamp');
  const sig = header(headers, 'webhook-signature') || header(headers, 'svix-signature');
  if (!id || !ts || !sig) return bad('No webhook-id, webhook-timestamp or webhook-signature header.');
  if (!fresh(Number(ts), now)) return bad('The signature is too old or from the future.');
  const key = Buffer.from(secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret, 'base64');
  const want = hmac('sha256', key, `${id}.${ts}.${raw.toString('utf8')}`).digest('base64');
  const given = sig
    .split(' ')
    .map((s) => s.split(','))
    .filter(([v]) => v === 'v1')
    .map(([, s]) => s || '');
  if (!given.some((s) => same(s, want))) return bad('The signature is wrong.');
  return { ok: true, event: text(json(raw)?.type), senderId: id };
}

/** For the generic presets: the event and delivery from the headers the user named, else the body's "type". */
function named(raw: Buffer, headers: Headers, v: WebhookVerify): Verdict {
  const body = json(raw);
  return {
    ok: true,
    event: (v.eventHeader && header(headers, v.eventHeader)) || text(body?.type) || text(body?.event),
    senderId: (v.idHeader && header(headers, v.idHeader)) || null,
  };
}

function signed(raw: Buffer, headers: Headers, secret: string, v: WebhookVerify): Verdict {
  const name = v.header || 'x-signature';
  const sig = header(headers, name);
  if (!sig) return bad(`No ${name} header.`);
  const digest = hmac(v.algorithm || 'sha256', secret, raw).digest(v.encoding || 'hex');
  if (!same(sig, `${v.prefix || ''}${digest}`)) return bad('The signature is wrong.');
  return named(raw, headers, v);
}

function token(raw: Buffer, headers: Headers, secret: string, v: WebhookVerify): Verdict {
  const name = v.header || 'authorization';
  const given = header(headers, name);
  if (!given) return bad(`No ${name} header.`);
  const bearer = /^bearer\s+/i.test(given) ? given.replace(/^bearer\s+/i, '') : null;
  if (!same(given, secret) && !(bearer !== null && same(bearer, secret))) return bad('The token is wrong.');
  return named(raw, headers, v);
}

/** Checks one request against a webhook's preset and secret. */
export function verify(v: WebhookVerify, secret: string | null, raw: Buffer, headers: Headers, now: number): Verdict {
  if (v.preset === 'none') return named(raw, headers, v);
  if (!secret) return bad('No secret is saved for this webhook. Make or paste one first.');
  switch (v.preset) {
    case 'github':
      return github(raw, headers, secret);
    case 'gitlab':
      return gitlab(raw, headers, secret);
    case 'stripe':
      return stripe(raw, headers, secret, now);
    case 'slack':
      return slack(raw, headers, secret, now);
    case 'linear':
      return linear(raw, headers, secret, now);
    case 'standard':
      return standard(raw, headers, secret, now);
    case 'hmac':
      return signed(raw, headers, secret, v);
    case 'token':
      return token(raw, headers, secret, v);
  }
}

/** Signs a body the way a preset's sender would, with its headers (Send a test, and the tests). */
export function signFor(v: WebhookVerify, secret: string | null, body: string, now: number): Record<string, string> {
  const ts = Math.floor(now / 1000);
  switch (v.preset) {
    case 'github':
      return {
        'x-github-event': 'ping',
        'x-github-delivery': crypto.randomUUID(),
        'x-hub-signature-256': `sha256=${hmac('sha256', secret || '', body).digest('hex')}`,
      };
    case 'gitlab':
      return { 'x-gitlab-event': 'Test Hook', 'x-gitlab-token': secret || '' };
    case 'stripe':
      return { 'stripe-signature': `t=${ts},v1=${hmac('sha256', secret || '', `${ts}.${body}`).digest('hex')}` };
    case 'slack':
      return {
        'x-slack-request-timestamp': String(ts),
        'x-slack-signature': `v0=${hmac('sha256', secret || '', `v0:${ts}:${body}`).digest('hex')}`,
      };
    case 'linear':
      return { 'linear-event': 'Test', 'linear-signature': hmac('sha256', secret || '', body).digest('hex') };
    case 'standard': {
      const id = `msg_${crypto.randomUUID()}`;
      const s = secret || '';
      const key = Buffer.from(s.startsWith('whsec_') ? s.slice('whsec_'.length) : s, 'base64');
      return {
        'webhook-id': id,
        'webhook-timestamp': String(ts),
        'webhook-signature': `v1,${hmac('sha256', key, `${id}.${ts}.${body}`).digest('base64')}`,
      };
    }
    case 'hmac':
      return {
        [v.header || 'x-signature']:
          `${v.prefix || ''}${hmac(v.algorithm || 'sha256', secret || '', body).digest(v.encoding || 'hex')}`,
      };
    case 'token':
      return {
        [v.header || 'authorization']:
          (v.header || 'authorization') === 'authorization' ? `Bearer ${secret}` : secret || '',
      };
    case 'none':
      return {};
  }
}
