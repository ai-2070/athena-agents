// The Outbox (server/api/outbox.ts): posts and messages agents drafted for you to approve, edit, send back to their
// team or reject, and the gateway deliveries' reviews. A gateway delivery's bodies are checked by server/gateways/
// (its revision, what you acknowledged), so they are passed on as they came, as in shared/api/gateways.ts.
import { oc, type } from '@orpc/contract';
import { z } from 'zod';
import { post, withBody as gatewayWithBody } from './gateways.ts';
import type { GatewayOutboxDeliveryReview, GatewayOutboxDestination, GatewayOutboxPostPreview, OutboxPost } from '../types.ts';

const onePost = z.object({ id: z.string() });
const withBody = gatewayWithBody({ id: z.string() });
const parts = z.array(z.string(), { error: 'parts must be a list of texts.' });
const images = z.array(z.string(), { error: 'images must be a list.' });
/** a Telegram or Discord conversation a gateway knows (server/gateways/ checks it can be sent to) */
const recipient = z.object({ instanceId: z.string(), eventId: z.string() }, { error: 'Choose a gateway conversation.' });

export const outbox = {
  /** Every post, newest first, with how far a gateway delivery got. */
  list: oc.route({ method: 'GET', path: '/outbox' }).output(type<OutboxPost[]>()),
  /** The gateway conversations a post can go to. */
  destinations: oc.route({ method: 'GET', path: '/outbox/gateway-destinations' }).output(type<GatewayOutboxDestination[]>()),
  /** A draft of your own (an X post unless platform says). autoPosted: it went out at once (the account auto-posts). */
  draft: oc.route({ method: 'POST', path: '/outbox' })
    .input(z.object({
      platform: z.string().optional(),
      account: z.string().optional(),
      text: z.string({ error: 'Write the post first.' }).optional(),
      thread: parts.nullable().optional(),
      images: images.nullable().optional(),
      to: z.string().nullable().optional(),
      gateway: recipient.optional(),
    }))
    .output(type<OutboxPost & { autoPosted?: boolean }>()),
  /** Changes a draft: its parts, images, title or gateway conversation (draftRevision: the one you saw). */
  edit: oc.route({ method: 'PUT', path: '/outbox/{id}' })
    .input(onePost.extend({ parts: parts.optional(), images: images.optional(), title: z.string().optional(), gateway: recipient.optional(), draftRevision: z.string().optional() }))
    .output(type<OutboxPost>()),
  /** Sends it, with what you changed; a gateway post needs the approval its review gave (gatewayApproval). */
  approve: oc.route({ method: 'POST', path: '/outbox/{id}/approve' })
    .input(onePost.extend({
      parts: parts.optional(),
      images: images.optional(),
      title: z.string().nullable().optional(),
      gatewayApproval: z.object({ instanceId: z.string(), projectId: z.string(), postId: z.string(), eventId: z.string(), parts: z.array(z.string()), revision: z.string() }, { error: 'Review the gateway message again before approving it.' }).optional(),
      draftRevision: z.string().optional(),
    }))
    .output(type<OutboxPost>()),
  /** Back to the team that drafted it, with what to change. */
  discuss: oc.route({ method: 'POST', path: '/outbox/{id}/discuss' }).input(onePost.extend({ text: z.string({ error: 'Say what to change.' }).nullable().optional() })).output(type<OutboxPost>()),
  reject: oc.route({ method: 'POST', path: '/outbox/{id}/reject' }).input(onePost.extend({ reason: z.string().optional() })).output(type<OutboxPost>()),
  remove: oc.route({ method: 'DELETE', path: '/outbox/{id}' }).input(onePost).output(type<{ ok: true }>()),
  /** The gateway message as it would go (its recipient and text), before you approve it. */
  gatewayReview: post('/outbox/{id}/gateway-review').input(withBody).output(type<GatewayOutboxPostPreview>()),
  /** A gateway delivery's receipts: what arrived, what is uncertain, and recording, retrying or finishing it. */
  delivery: oc.route({ method: 'GET', path: '/outbox/{id}/gateway-delivery' }).input(onePost).output(type<GatewayOutboxDeliveryReview>()),
  prepareDelivery: post('/outbox/{id}/gateway-delivery/prepare').input(withBody).output(type<GatewayOutboxDeliveryReview>()),
  reviewDelivery: post('/outbox/{id}/gateway-delivery').input(withBody).output(type<GatewayOutboxDeliveryReview>()),
  finishDelivery: post('/outbox/{id}/gateway-finish').input(withBody).output(type<OutboxPost | undefined>()),
  /** The old test route for global tokens and webhooks: it says what to do instead. */
  oldTest: oc.route({ method: 'POST', path: '/social/test' }).output(type<never>()),
};
