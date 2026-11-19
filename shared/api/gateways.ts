// Chat gateways (server/api/gateways.ts): Telegram, Slack and Discord bots that bring messages to the Brain, a team
// or an agent. Settings › Gateways sets them up and shows their messages. Tokens go in and never come back out.
import { oc, type } from '@orpc/contract';
import { z } from 'zod';
import type { GatewayInstance, GatewayListing, GatewayMessage } from '../types.ts';

const one = z.object({ id: z.string() });
const ids = (what: string) => z.array(z.string(), { error: `${what} must be a list of IDs.` });
const target = z.discriminatedUnion(
  'kind',
  [
    z.object({ kind: z.literal('brain') }),
    z.object({ kind: z.literal('team'), id: z.string() }),
    z.object({ kind: z.literal('agent'), id: z.string() }),
  ],
  { error: 'Choose who answers: the Brain, a team or an agent.' },
);
const token = z.string({ error: 'A token is text.' }).nullable().optional();
const ok = type<{ ok: true }>();

export const gateways = {
  list: oc.route({ method: 'GET', path: '/gateways' }).output(type<GatewayListing[]>()),
  /** The teams and agents of a project, for choosing who answers (the project needn't be the open one). */
  targets: oc
    .route({ method: 'GET', path: '/gateways/targets' })
    .input(z.object({ projectId: z.string({ error: 'Choose a project.' }) }))
    .output(type<{ agents: { id: string; name: string }[]; teams: { id: string; name: string }[] }>()),
  /** Adds one (id left out; it starts off) or changes one. */
  save: oc
    .route({ method: 'POST', path: '/gateways' })
    .input(
      z.object({
        id: z.string().optional(),
        platform: z.enum(['telegram', 'slack', 'discord'], { error: 'Choose Telegram, Slack or Discord.' }),
        name: z.string({ error: 'The name must be text.' }),
        projectId: z.string({ error: 'Choose a project.' }),
        target,
        users: ids('Users'),
        channels: ids('Channels'),
      }),
    )
    .output(type<GatewayInstance>()),
  /** Saves its tokens: text replaces one, null removes it, leaving one out keeps it. */
  tokens: oc
    .route({ method: 'POST', path: '/gateways/{id}/tokens' })
    .input(one.extend({ botToken: token, appToken: token }))
    .output(ok),
  /** Turns it on (it checks it has what it needs) or off. */
  enable: oc
    .route({ method: 'POST', path: '/gateways/{id}/enabled' })
    .input(one.extend({ enabled: z.boolean({ error: 'enabled must be true or false.' }) }))
    .output(type<GatewayInstance>()),
  reconnect: oc.route({ method: 'POST', path: '/gateways/{id}/reconnect' }).input(one).output(ok),
  remove: oc.route({ method: 'DELETE', path: '/gateways/{id}' }).input(one).output(ok),
  /** Lets a person or channel it ignored talk to it (adds it to its list). */
  allow: oc
    .route({ method: 'POST', path: '/gateways/{id}/allow' })
    .input(one.extend({ kind: z.enum(['user', 'channel']), value: z.string() }))
    .output(type<GatewayInstance>()),
  /** Its messages, newest first. */
  messages: oc.route({ method: 'GET', path: '/gateways/{id}/messages' }).input(one).output(type<GatewayMessage[]>()),
  retry: oc
    .route({ method: 'POST', path: '/gateways/{id}/messages/{messageId}/retry' })
    .input(one.extend({ messageId: z.string() }))
    .output(ok),
  /** Lets a failed message go. */
  dismiss: oc
    .route({ method: 'DELETE', path: '/gateways/{id}/messages/{messageId}' })
    .input(one.extend({ messageId: z.string() }))
    .output(ok),
};
