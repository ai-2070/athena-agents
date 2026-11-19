// Webhooks (server/api/webhooks.ts): another service starts a routine by sending to a webhook's secret address, which
// a Cloudflare or Tailscale tunnel makes reachable. server/webhooks/ cleans what comes in and refuses with a status.
import { oc, type } from '@orpc/contract';
import { z } from 'zod';
import type { RoutineRun, WebhookCreated, WebhookDelivery, WebhookListing, WebhookStatus } from '../types.ts';

const oneWebhook = z.object({ id: z.string() });
const headerName = z
  .string({ error: 'A header name must be text.' })
  .regex(/^[A-Za-z0-9-]{1,64}$/, { error: 'A header name has only letters, digits and dashes.' });

const verify = z.object(
  {
    preset: z.enum(['github', 'gitlab', 'stripe', 'slack', 'linear', 'standard', 'hmac', 'token', 'none'], {
      error: 'Choose who sends this webhook.',
    }),
    header: headerName.optional(),
    algorithm: z.enum(['sha256', 'sha1'], { error: 'The signature is SHA-256 or SHA-1.' }).optional(),
    encoding: z.enum(['hex', 'base64'], { error: 'The signature is hex or base64.' }).optional(),
    prefix: z.string({ error: 'The prefix must be text.' }).max(40, { error: 'The prefix is too long.' }).optional(),
    eventHeader: headerName.optional(),
    idHeader: headerName.optional(),
  },
  { error: 'Say how the sender proves itself.' },
);

const fields = {
  name: z.string({ error: 'Give the webhook a name.' }).max(120, { error: 'The name is too long.' }).optional(),
  routineId: z.string({ error: 'Choose the routine this webhook starts.' }).optional(),
  enabled: z.boolean({ error: 'enabled must be true or false.' }).optional(),
  verify: verify.optional(),
  secret: z.string({ error: 'The secret must be text.' }).max(500, { error: 'The secret is too long.' }).optional(),
  events: z
    .array(z.string({ error: 'An event must be text.' }), { error: 'events must be a list.' })
    .max(50, { error: 'Choose at most 50 events.' })
    .optional(),
  askFirst: z.boolean({ error: 'askFirst must be true or false.' }).optional(),
  perMinute: z.number({ error: 'perMinute must be a number.' }).int().min(1).max(600).optional(),
  atOnce: z.number({ error: 'atOnce must be a number.' }).int().min(1).max(20).optional(),
  keepBodies: z.boolean({ error: 'keepBodies must be true or false.' }).optional(),
};

const setup = z.object({
  on: z.boolean({ error: 'on must be true or false.' }).optional(),
  port: z.number({ error: 'The port must be a number.' }).int().nullable().optional(),
  publicUrl: z
    .string({ error: 'The public address must be text.' })
    .max(300, { error: 'The public address is too long.' })
    .optional(),
  share: z
    .enum(['off', 'cloudflare', 'tailscale-public', 'tailscale-tailnet'], {
      error: 'Share webhooks: off, Cloudflare, Tailscale public or Tailscale tailnet only.',
    })
    .optional(),
  toolPaths: z
    .object({
      cloudflared: z.string({ error: 'A program path must be text.' }).max(500).optional(),
      tailscale: z.string({ error: 'A program path must be text.' }).max(500).optional(),
    })
    .optional(),
});

export const webhooks = {
  /** Every webhook of the open project; routineId: only that routine's. */
  list: oc
    .route({ method: 'GET', path: '/webhooks' })
    .input(z.object({ routineId: z.string().optional() }))
    .output(type<WebhookListing[]>()),
  /** A new webhook. The answer has its address (and a secret Athena made): the only time they are shown. */
  create: oc
    .route({ method: 'POST', path: '/webhooks' })
    .input(z.object({ ...fields, routineId: z.string({ error: 'Choose the routine this webhook starts.' }) }))
    .output(type<WebhookCreated>()),
  change: oc
    .route({ method: 'PUT', path: '/webhooks/{id}' })
    .input(oneWebhook.extend(fields))
    .output(type<WebhookListing>()),
  remove: oc.route({ method: 'DELETE', path: '/webhooks/{id}' }).input(oneWebhook).output(type<{ ok: true }>()),
  /** A new secret address (the old one stops working), shown this once. */
  newAddress: oc
    .route({ method: 'POST', path: '/webhooks/{id}/address' })
    .input(oneWebhook)
    .output(type<WebhookCreated>()),
  /** A new signing secret: the one pasted, or one Athena makes and shows this once. */
  newSecret: oc
    .route({ method: 'POST', path: '/webhooks/{id}/secret' })
    .input(oneWebhook.extend({ secret: fields.secret }))
    .output(type<WebhookCreated>()),
  deliveries: oc
    .route({ method: 'GET', path: '/webhooks/{id}/deliveries' })
    .input(oneWebhook)
    .output(type<WebhookDelivery[]>()),
  /** Forgets what its deliveries sent. */
  removeBodies: oc
    .route({ method: 'DELETE', path: '/webhooks/{id}/bodies' })
    .input(oneWebhook)
    .output(type<{ ok: true }>()),
  /** Starts the routine again from what a delivery sent. */
  runAgain: oc
    .route({ method: 'POST', path: '/webhook-deliveries/{id}/run' })
    .input(oneWebhook)
    .output(type<RoutineRun>()),
  /** A signed sample through every check, without running anything. */
  test: oc.route({ method: 'POST', path: '/webhooks/{id}/test' }).input(oneWebhook).output(type<WebhookDelivery>()),
  /** Whether webhooks are received, on which port and public address. */
  status: oc.route({ method: 'GET', path: '/webhooks-setup' }).output(type<WebhookStatus>()),
  /** Turns receiving on or off, sets the port, the public address of your own tunnel, or the tunnel Athena runs. */
  setup: oc.route({ method: 'PUT', path: '/webhooks-setup' }).input(setup).output(type<WebhookStatus>()),
  /** Checks now that webhooks reach this computer through the public address. */
  check: oc.route({ method: 'POST', path: '/webhooks-setup/check' }).output(type<WebhookStatus>()),
  /** The senders have the new Cloudflare addresses: stop saying they changed. */
  seen: oc.route({ method: 'POST', path: '/webhooks-setup/seen' }).output(type<WebhookStatus>()),
  /** A webhook's full address again (never in a listing). */
  address: oc
    .route({ method: 'POST', path: '/webhooks/{id}/show-address' })
    .input(oneWebhook)
    .output(type<{ address: string }>()),
};
