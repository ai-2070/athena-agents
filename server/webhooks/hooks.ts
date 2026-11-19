// Making, changing and removing webhooks (each starts one routine), and the webhooks settings. A signing secret Athena
// makes is shown once, in the answer that made it. The address can be shown again on request (Show address): a
// Cloudflare address changes on each start, and the senders then need it again. Neither is ever in a listing.
import crypto from 'node:crypto';
import path from 'node:path';
import { activeProject, getSettings, routines, saveSettings } from '../store.ts';
import { PORT } from '../util.ts';
import { deliveries, deliveriesOf, hashToken, newToken, saveSecrets, secretsOf, webhooks } from './store.ts';
import { SENDER_SECRET, signFor } from './verify.ts';
import { forgetWebhook, receiveIn } from './intake.ts';
import { listenerStatus, syncListener, webhookPort } from './listener.ts';
import { applyShare, checkTunnel, publicAddress, tunnelStatus } from './tunnel.ts';
import type {
  Webhook,
  WebhookCreated,
  WebhookDelivery,
  WebhookListing,
  WebhookSettings,
  WebhookStatus,
  WebhookVerify,
} from '../../shared/types.ts';

const oops = (message: string, status = 400) => Object.assign(new Error(message), { status });

export interface WebhookInput {
  name?: string;
  routineId?: string;
  enabled?: boolean;
  verify?: WebhookVerify;
  /** A signing secret or token from the sender ('' or missing keeps the saved one). */
  secret?: string;
  events?: string[];
  askFirst?: boolean;
  perMinute?: number;
  atOnce?: number;
  keepBodies?: boolean;
}

const SENDER_WORDS: Partial<Record<WebhookVerify['preset'], string>> = {
  stripe: 'Paste the signing secret from Stripe (it starts with whsec_).',
  slack: "Paste your Slack app's signing secret.",
  linear: 'Paste the signing secret Linear shows for this webhook.',
  standard: 'Paste the signing secret the sender shows (it often starts with whsec_).',
};

function cleanVerify(v: WebhookVerify): WebhookVerify {
  const out: WebhookVerify = { preset: v.preset };
  if (v.preset === 'hmac' || v.preset === 'token') {
    if (v.header) out.header = v.header.toLowerCase();
    if (v.eventHeader) out.eventHeader = v.eventHeader.toLowerCase();
    if (v.idHeader) out.idHeader = v.idHeader.toLowerCase();
  }
  if (v.preset === 'hmac') {
    out.algorithm = v.algorithm || 'sha256';
    out.encoding = v.encoding || 'hex';
    if (v.prefix) out.prefix = v.prefix;
  }
  return out;
}

const cleanEvents = (events: readonly string[]) =>
  [...new Set(events.map((e) => e.trim()).filter(Boolean))].slice(0, 50).map((e) => e.slice(0, 100));

const limit = (n: number | undefined, fallback: number, max: number) =>
  n === undefined ? fallback : Math.min(max, Math.max(1, Math.floor(n)));

function routineFor(id: string) {
  const r = routines.get(id);
  if (!r) throw oops('That routine is unavailable.', 404);
  return r;
}

/** The full address of a token: the public one when there is one, else this computer's. */
export function addressFor(token: string): string {
  const base = publicAddress() || `http://127.0.0.1:${webhookPort()}`;
  return `${base.replace(/\/+$/, '')}/h/${token}`;
}

function listing(h: Webhook): WebhookListing {
  const s = secretsOf(h.id);
  return {
    ...h,
    needsAddress: !s || s.projectId !== activeProject().id,
    hasSecret: !!s?.secret,
    lastDelivery: withoutBody(deliveriesOf(h.id)[0] || null),
  };
}

const withoutBody = (d: WebhookDelivery | null): WebhookDelivery | null => {
  if (!d) return null;
  const { body: _body, ...rest } = d;
  return rest;
};

export function listWebhooks(routineId?: string): WebhookListing[] {
  return webhooks
    .list()
    .filter((h) => !routineId || h.routineId === routineId)
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
    .map(listing);
}

export function getWebhook(id: string): Webhook {
  const h = webhooks.get(id);
  if (!h) throw oops('That webhook is unavailable.', 404);
  return h;
}

export async function createWebhook(input: WebhookInput): Promise<WebhookCreated> {
  if (!input.routineId) throw oops('Choose the routine this webhook starts.');
  const routine = routineFor(input.routineId);
  const verify = cleanVerify(input.verify || { preset: 'github' });
  const given = (input.secret || '').trim();
  if (SENDER_SECRET.has(verify.preset) && !given) throw oops(SENDER_WORDS[verify.preset] || 'Paste the secret.');
  const made = verify.preset === 'none' || given ? null : crypto.randomBytes(32).toString('hex');
  const token = newToken();
  const h = webhooks.save({
    name: (input.name || '').trim().slice(0, 120) || `${routine.name} webhook`,
    routineId: routine.id,
    enabled: input.enabled ?? true,
    verify,
    events: cleanEvents(input.events || []),
    askFirst: input.askFirst ?? true,
    perMinute: limit(input.perMinute, 20, 600),
    atOnce: limit(input.atOnce, 3, 20),
    keepBodies: input.keepBodies ?? true,
    addressHint: token.slice(-4),
  });
  saveSecrets(h.id, {
    projectId: activeProject().id,
    tokenHash: hashToken(token),
    token,
    ...(given || made ? { secret: given || made || '' } : {}),
  });
  // making a webhook means you want to receive them, but not that a tunnel switched off with them starts again
  if (!getSettings().webhooks.on) saveSettings({ webhooks: { on: true, share: 'off' } });
  await syncListener();
  return { webhook: listing(h), address: addressFor(token), secret: made };
}

export async function changeWebhook(id: string, patch: WebhookInput): Promise<WebhookListing> {
  const h = getWebhook(id);
  if (patch.name !== undefined) h.name = patch.name.trim().slice(0, 120) || h.name;
  if (patch.routineId !== undefined) h.routineId = routineFor(patch.routineId).id;
  const s = secretsOf(h.id);
  if (patch.verify !== undefined) {
    const next = cleanVerify(patch.verify);
    // another kind of check needs its own secret
    if (next.preset !== h.verify.preset && next.preset !== 'none' && !(patch.secret || '').trim())
      throw oops('A different sender needs its secret: paste it, or make a new secret after saving.');
    h.verify = next;
  }
  if (patch.secret?.trim() && s) saveSecrets(h.id, { ...s, secret: patch.secret.trim() });
  if (patch.events !== undefined) h.events = cleanEvents(patch.events);
  if (patch.askFirst !== undefined) h.askFirst = patch.askFirst;
  if (patch.perMinute !== undefined) h.perMinute = limit(patch.perMinute, 20, 600);
  if (patch.atOnce !== undefined) h.atOnce = limit(patch.atOnce, 3, 20);
  if (patch.keepBodies !== undefined) {
    h.keepBodies = patch.keepBodies;
    if (!h.keepBodies) removeBodies(h.id);
  }
  if (patch.enabled !== undefined) {
    if (patch.enabled) {
      routineFor(h.routineId);
      delete h.offReason;
    }
    h.enabled = patch.enabled;
  }
  webhooks.save(h);
  await syncListener();
  return listing(h);
}

export async function removeWebhook(id: string): Promise<void> {
  const h = webhooks.get(id);
  if (!h) return;
  webhooks.remove(h.id);
  saveSecrets(h.id, null);
  for (const d of deliveriesOf(h.id)) deliveries.remove(d.id);
  forgetWebhook(h.id);
  await syncListener();
}

/** A new secret address; the old one stops working at once. */
export function newAddress(id: string): WebhookCreated {
  const h = getWebhook(id);
  const token = newToken();
  const s = secretsOf(h.id);
  saveSecrets(h.id, { ...s, projectId: activeProject().id, tokenHash: hashToken(token), token });
  h.addressHint = token.slice(-4);
  webhooks.save(h);
  return { webhook: listing(h), address: addressFor(token), secret: null };
}

/** The full address again, on request (never in listings): a Cloudflare address changes on each start. */
export function showAddress(id: string): string {
  const h = getWebhook(id);
  const s = secretsOf(h.id);
  if (!s?.token || s.projectId !== activeProject().id)
    throw oops("This webhook's address can't be shown again. Make a new address.", 409);
  return addressFor(s.token);
}

/** A new signing secret: the one given (from the sender), or one Athena makes and shows this once. */
export function newSecret(id: string, given?: string): WebhookCreated {
  const h = getWebhook(id);
  const s = secretsOf(h.id);
  if (!s) throw oops('Make a new address for this webhook first.', 409);
  if (h.verify.preset === 'none') throw oops('This webhook has no secret: its address is the only check.');
  const pasted = (given || '').trim();
  if (SENDER_SECRET.has(h.verify.preset) && !pasted) throw oops(SENDER_WORDS[h.verify.preset] || 'Paste the secret.');
  const made = pasted ? null : crypto.randomBytes(32).toString('hex');
  saveSecrets(h.id, { ...s, secret: pasted || made || '' });
  return { webhook: listing(h), address: null, secret: made };
}

export function listDeliveries(webhookId: string): WebhookDelivery[] {
  getWebhook(webhookId);
  return deliveriesOf(webhookId);
}

export function removeBodies(webhookId: string): void {
  for (const d of deliveriesOf(webhookId))
    if (d.body !== undefined) {
      delete d.body;
      deliveries.save(d);
    }
}

/** Send a test: a sample signed the way the sender signs, through every check of a real delivery. Nothing runs. */
export async function testWebhook(id: string): Promise<WebhookDelivery> {
  const h = getWebhook(id);
  const now = Date.now();
  const sample: Record<string, unknown> = { type: 'athena.test', test: true, text: 'A test from Athena.' };
  if (h.verify.preset === 'linear') sample.webhookTimestamp = now;
  const body = JSON.stringify(sample);
  const reply = await receiveIn(h.id, {
    token: '',
    body: Buffer.from(body),
    headers: { 'content-type': 'application/json', ...signFor(h.verify, secretsOf(h.id)?.secret ?? null, body, now) },
    now,
    test: true,
  });
  const latest = deliveriesOf(h.id)[0];
  if (!latest) throw oops(`The test got no answer (${reply.status}).`, 500);
  return latest;
}

// ---------- settings ----------
function cleanPublicUrl(raw: string): string {
  const text = raw.trim();
  if (!text) return '';
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw oops('The public address should look like https://hooks.example.com.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw oops('The public address should start with https://.');
  if (url.username || url.password || url.search || url.hash)
    throw oops('The public address is only the start of the address, like https://hooks.example.com.');
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/** The listener and the tunnel, as Settings › Webhooks shows them. */
export function webhookStatus(): WebhookStatus {
  return { ...listenerStatus(), tunnel: tunnelStatus() };
}

const cleanToolPath = (raw: string) => {
  const p = raw.trim();
  if (p && !path.isAbsolute(p)) throw oops("Give the program's full path, starting at the drive (or /).");
  return p;
};

export interface SetupInput extends Partial<Omit<WebhookSettings, 'toolPaths' | 'tunnelUrl' | 'tunnelChanged'>> {
  toolPaths?: Partial<WebhookSettings['toolPaths']>;
}

export async function setupWebhooks(patch: SetupInput): Promise<WebhookStatus> {
  const next: Partial<WebhookSettings> = {};
  if (patch.on !== undefined) next.on = patch.on;
  // turning webhooks off stops the tunnel for good: it starts again only when you pick it again
  if (patch.on === false && patch.share === undefined) Object.assign(next, { share: 'off', tunnelChanged: false });
  if (patch.share !== undefined) {
    next.share = patch.share;
    // picking a tunnel means you want to receive webhooks
    if (patch.share !== 'off') next.on = true;
    if (patch.share !== getSettings().webhooks.share) next.tunnelChanged = false;
  }
  if (patch.toolPaths !== undefined) {
    const now = getSettings().webhooks.toolPaths;
    next.toolPaths = {
      cloudflared: cleanToolPath(patch.toolPaths.cloudflared ?? now.cloudflared),
      tailscale: cleanToolPath(patch.toolPaths.tailscale ?? now.tailscale),
    };
  }
  if (patch.port !== undefined) {
    if (patch.port !== null && (patch.port < 1024 || patch.port > 65535)) throw oops('Pick a port from 1024 to 65535.');
    if (patch.port === PORT) throw oops(`Port ${PORT} is the dashboard's. Pick another port for webhooks.`);
    next.port = patch.port;
  }
  if (patch.publicUrl !== undefined) next.publicUrl = cleanPublicUrl(patch.publicUrl);
  saveSettings({ webhooks: next });
  await syncListener();
  await applyShare();
  return webhookStatus();
}

/** The senders were given the new Cloudflare addresses. */
export function addressesSeen(): WebhookStatus {
  saveSettings({ webhooks: { tunnelChanged: false } });
  return webhookStatus();
}

/** Checks now that webhooks reach this computer through the public address. */
export async function checkNow(): Promise<WebhookStatus> {
  await checkTunnel();
  return webhookStatus();
}
