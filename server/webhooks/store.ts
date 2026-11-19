// Where webhooks are kept. The webhooks and what they received belong to their project; their secrets (the address's
// token, as a hash, and the signing secret) are global in data/webhook-secrets.json, like gateway secrets: never sent
// to the page, a project folder or a backup.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { collection, listProjects, withProject } from '../store.ts';
import { dataPath, readJSON, writeJSON } from '../util.ts';
import type { Project, Webhook, WebhookDelivery } from '../../shared/types.ts';

export const webhooks = collection<Webhook>('webhooks');
export const deliveries = collection<WebhookDelivery>('webhook-deliveries');

/** What is kept for a webhook outside its project. */
export interface WebhookSecrets {
  projectId: string;
  /** sha256 of the address's token: the token itself is shown once and never kept. */
  tokenHash: string;
  /** The signing secret or token the sender uses. */
  secret?: string;
}

const SECRETS_FILE = () => dataPath('webhook-secrets.json');

function records(): Record<string, WebhookSecrets> {
  const file = SECRETS_FILE();
  const all = fs.existsSync(file) ? readJSON<Record<string, WebhookSecrets>>(file) : {};
  if (!all || typeof all !== 'object' || Array.isArray(all))
    throw Object.assign(new Error('Saved webhook secrets are unreadable. Restore data/webhook-secrets.json.'), {
      status: 503,
    });
  return all;
}

export function secretsOf(webhookId: string): WebhookSecrets | null {
  const all = records();
  return Object.hasOwn(all, webhookId) ? all[webhookId] : null;
}

export function saveSecrets(webhookId: string, value: WebhookSecrets | null): void {
  if (!/^[\w-]+$/.test(webhookId)) throw new Error('Invalid webhook id.');
  const all = records();
  if (value === null) delete all[webhookId];
  else Object.defineProperty(all, webhookId, { value, enumerable: true, configurable: true, writable: true });
  writeJSON(SECRETS_FILE(), all);
}

export const hashToken = (token: string): string => crypto.createHash('sha256').update(token).digest('hex');

/** A new secret address token: 32 random bytes. */
export const newToken = (): string => crypto.randomBytes(32).toString('base64url');

/** The webhook a secret address leads to, and its project. A project removed since leads nowhere. */
export function findByToken(token: string): { project: Project; webhookId: string } | null {
  const hash = hashToken(token);
  const all = records();
  const id = Object.keys(all).find((k) => all[k].tokenHash === hash);
  if (!id) return null;
  const project = listProjects().find((p) => p.id === all[id].projectId);
  return project ? { project, webhookId: id } : null;
}

/** Every project's webhooks (to know whether the listener is needed). */
export function allWebhooks(): Webhook[] {
  return listProjects().flatMap((p) => withProject(p, () => webhooks.list()));
}

const KEEP_DELIVERIES = 50;
export const BODY_DAYS = 7;

/** The newest deliveries of a webhook first. */
export function deliveriesOf(webhookId: string): WebhookDelivery[] {
  return deliveries
    .list()
    .filter((d) => d.webhookId === webhookId)
    .sort((a, b) => b.receivedAt - a.receivedAt);
}

/** Keeps a webhook's latest deliveries. */
export function pruneDeliveries(webhookId: string): void {
  for (const old of deliveriesOf(webhookId).slice(KEEP_DELIVERIES)) deliveries.remove(old.id);
}

/** Drops what was sent once it is older than BODY_DAYS, in every project. */
export function dropOldBodies(now = Date.now()): void {
  const before = now - BODY_DAYS * 86_400_000;
  for (const p of listProjects())
    withProject(p, () => {
      for (const d of deliveries.list())
        if (d.body !== undefined && d.receivedAt < before) {
          delete d.body;
          deliveries.save(d);
        }
    });
}

/** Deliveries saved as started whose run never began (the dashboard closed in between). */
export function markInterruptedDeliveries(): void {
  for (const p of listProjects())
    withProject(p, () => {
      for (const d of deliveries.list())
        if (d.status === 'started' && !d.routineRunId) {
          d.status = 'failed';
          d.reason = 'The dashboard closed before this ran.';
          deliveries.save(d);
        }
    });
}

/** Turns a deleted routine's webhooks off, so how the sender is set up isn't lost. */
export function routineDeleted(routineId: string): void {
  for (const h of webhooks.list())
    if (h.routineId === routineId && (h.enabled || !h.offReason)) {
      h.enabled = false;
      h.offReason = 'Its routine was deleted.';
      webhooks.save(h);
    }
}
