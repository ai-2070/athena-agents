// The Outbox (server/api/outbox.ts): posts and messages agents drafted for you to approve, edit, send back to their
// team or reject. A Telegram, Slack or Discord message goes to a chat one of the project's gateways has talked in.
import { oc, type } from '@orpc/contract';
import { z } from 'zod';
import type { GatewayPlatform, OutboxPost } from '../types.ts';

const onePost = z.object({ id: z.string() });
const parts = z.array(z.string(), { error: 'parts must be a list of texts.' });
const images = z.array(z.string(), { error: 'images must be a list.' });
/** a chat a gateway knows (server/gateways/ checks it) */
const chat = z.object({ instanceId: z.string(), chatKey: z.string() }, { error: 'Choose the chat it goes to.' });

export interface GatewayChatChoice {
  instanceId: string;
  instanceName: string;
  platform: GatewayPlatform;
  chatKey: string;
  title: string;
}

export const outbox = {
  /** Every post, newest first. */
  list: oc.route({ method: 'GET', path: '/outbox' }).output(type<OutboxPost[]>()),
  /** The chats the project's gateways have talked in: where a Telegram, Slack or Discord message can go. */
  chats: oc.route({ method: 'GET', path: '/outbox/gateway-chats' }).output(type<GatewayChatChoice[]>()),
  /** A draft of your own (an X post unless platform says). autoPosted: it went out at once (the account auto-posts). */
  draft: oc
    .route({ method: 'POST', path: '/outbox' })
    .input(
      z.object({
        platform: z.string().optional(),
        account: z.string().optional(),
        text: z.string({ error: 'Write the post first.' }).optional(),
        thread: parts.nullable().optional(),
        images: images.nullable().optional(),
        to: z.string().nullable().optional(),
        gateway: chat.optional(),
      }),
    )
    .output(type<OutboxPost & { autoPosted?: boolean }>()),
  /** Changes a draft: its parts, images, title or the chat it goes to. */
  edit: oc
    .route({ method: 'PUT', path: '/outbox/{id}' })
    .input(
      onePost.extend({
        parts: parts.optional(),
        images: images.optional(),
        title: z.string().optional(),
        gateway: chat.optional(),
      }),
    )
    .output(type<OutboxPost>()),
  /** Sends it, with what you changed. */
  approve: oc
    .route({ method: 'POST', path: '/outbox/{id}/approve' })
    .input(
      onePost.extend({
        parts: parts.optional(),
        images: images.optional(),
        title: z.string().nullable().optional(),
        gateway: chat.optional(),
      }),
    )
    .output(type<OutboxPost>()),
  /** Back to the team that drafted it, with what to change. */
  discuss: oc
    .route({ method: 'POST', path: '/outbox/{id}/discuss' })
    .input(onePost.extend({ text: z.string({ error: 'Say what to change.' }).nullable().optional() }))
    .output(type<OutboxPost>()),
  reject: oc
    .route({ method: 'POST', path: '/outbox/{id}/reject' })
    .input(onePost.extend({ reason: z.string().optional() }))
    .output(type<OutboxPost>()),
  remove: oc.route({ method: 'DELETE', path: '/outbox/{id}' }).input(onePost).output(type<{ ok: true }>()),
};
