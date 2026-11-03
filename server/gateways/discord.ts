import { AsyncLocalStorage } from 'node:async_hooks';
import { DiscordAdapter } from '@chat-adapter/discord';
import type { ChatInstance, Logger, WebhookOptions } from 'chat';
import { z } from 'zod';
import type { GatewayInbound, GatewayInboxEvent } from '../../shared/types.ts';
import { discordId } from '../../shared/gateway-discord.ts';
import { getGatewayInstance } from './instances.ts';
import { gatewayInputAllowed } from './inbox.ts';
import type { GatewayInbox } from './inbox.ts';
import { GatewaySetupError } from './telegram.ts';
import { DiscordGateway, discordGatewayDetails } from './discord-gateway.ts';
import type { GatewayStateAdapter } from './state.ts';

const id = z.string().refine(discordId, 'Invalid Discord ID.');
const stamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const user = z.object({ id, username: z.string().optional(), global_name: z.string().nullable().optional(), bot: z.boolean().optional(), system: z.boolean().optional() });
const header = z.object({ id, channel_id: id, guild_id: id.optional() });
const message = header.extend({
  author: user, type: z.number().int(), content: z.string().max(65536), flags: stamp.optional(),
  webhook_id: z.unknown().optional(), application_id: z.unknown().optional(), message_snapshots: z.array(z.unknown()).optional(),
  mentions: z.array(user).max(1000).default([]),
  message_reference: z.object({ message_id: id.optional(), channel_id: id.optional(), guild_id: id.optional(), type: z.number().int().optional() }).nullable().optional(),
  attachments: z.array(z.object({ id, filename: z.string().max(512), size: stamp, content_type: z.string().max(200).optional() })).max(10).default([]),
});
const overwrite = z.object({ id, type: z.union([z.literal(0), z.literal(1)]), allow: z.string().regex(/^\d{1,30}$/), deny: z.string().regex(/^\d{1,30}$/) });
const channel = z.object({
  id, type: z.number().int(), guild_id: id.optional(), parent_id: id.nullable().optional(),
  recipients: z.array(user).optional(), permission_overwrites: z.array(overwrite).max(1000).optional(),
  thread_metadata: z.object({ archived: z.boolean(), locked: z.boolean() }).optional(), member: z.object({ user_id: id.optional() }).optional(),
});
const quiet: Logger = { child: () => quiet, debug() {}, info() {}, warn() {}, error() {} };
const view = 1n << 10n; const history = 1n << 16n;

/** Verified message intake; the application worker remains disabled until delivery is ready. */
export class DiscordIntakeAdapter extends DiscordAdapter {
  private readonly instanceId: string;
  private readonly inbox: GatewayInbox;
  private readonly signal: AbortSignal;
  private readonly abort = new AbortController();
  private readonly dispatchSignal = new AsyncLocalStorage<AbortSignal>();
  private identity: { botId: string; appId: string } | undefined;
  private pending: Promise<void> = Promise.resolve();
  private queued = 0;
  private closed = false;

  constructor(instanceId: string, inbox: GatewayInbox, botToken: string, options: { apiUrl?: string; signal?: AbortSignal } = {}) {
    super({ botToken, applicationId: getGatewayInstance(instanceId).accountId, apiUrl: options.apiUrl ?? 'https://discord.com/api/v10',
      logger: quiet, mentionRoleIds: [], respondToChannelIds: [], respondToGlobalMentions: false, publicKey: '',
      webhookVerifier: () => { throw new Error('Discord HTTP callbacks are not enabled.'); },
    });
    this.instanceId = instanceId; this.inbox = inbox;
    this.signal = options.signal ? AbortSignal.any([options.signal, this.abort.signal]) : this.abort.signal;
  }

  override get botUserId(): string | undefined { return this.identity?.botId; }

  override handleWebhook(_request: Request): Promise<Response> { return Promise.resolve(new Response('Not found', { status: 404 })); }

  override startGatewayListener(_options: WebhookOptions): Promise<Response> {
    return Promise.reject(new GatewaySetupError('Discord Gateway recovery is not available yet.'));
  }

  override async initialize(chat: ChatInstance): Promise<void> {
    this.assertOpen();
    const instance = getGatewayInstance(this.instanceId);
    if (!instance.enabled || instance.platform !== 'discord' || !discordId(instance.accountId)) throw new GatewaySetupError('This Discord instance is paused or has an invalid bot ID.');
    const self = await this.read('/users/@me', user);
    if (self.id !== instance.accountId || !self.bot || self.system) throw new GatewaySetupError('The Discord token must belong to the configured bot account.');
    const app = await this.read('/oauth2/applications/@me', z.object({ id, bot: user.optional(), flags: stamp }));
    // The pinned adapter also uses the application ID as its bot mention ID.
    if (app.id !== self.id || (app.bot && (app.bot.id !== self.id || !app.bot.bot))) throw new GatewaySetupError('The Discord app and bot identities do not match.');
    if (!(BigInt(app.flags) & ((1n << 18n) | (1n << 19n)))) throw new GatewaySetupError('Enable the Message content intent for this Discord app before connecting.');
    this.assertOpen();
    this.identity = { botId: self.id, appId: app.id }; this.resolvedApplicationId = app.id;
    await super.initialize(chat);
  }

  createGateway(state: GatewayStateAdapter, options: { onDisconnect?: (error: Error) => void; testOrigin?: string } = {}): DiscordGateway {
    this.assertOpen();
    if (!this.identity || state.instanceId !== this.instanceId) throw new Error('Verify this Discord instance before connecting.');
    return new DiscordGateway({ state, accountId: this.identity.botId, token: () => this.resolveBotToken(),
      discover: () => this.read('/gateway/bot', discordGatewayDetails),
      receive: (type, eventId, payload, signal) => this.receiveDispatch(type, eventId, payload, signal),
      signal: this.signal, ...options,
    });
  }

  private assertOpen(): void {
    this.signal.throwIfAborted(); this.dispatchSignal.getStore()?.throwIfAborted();
    if (this.closed) throw new Error('This Discord connection is closed.');
  }

  /** Caller must supply an authenticated Gateway dispatch and advance recovery only after this settles. */
  receiveDispatch(type: string, eventId: string, payload: unknown, signal: AbortSignal = this.signal): Promise<GatewayInboxEvent | null> {
    this.assertOpen();
    if (!this.identity) return Promise.reject(new Error('Verify the Discord bot before receiving messages.'));
    if (this.queued >= 32) return Promise.reject(new Error('The Discord input queue is full. Retry without advancing recovery.'));
    const safe = z.object({ type: z.string().max(100), eventId: z.string().min(1).max(500), payload: z.unknown() }).parse({ type, eventId, payload });
    // Detach caller-owned objects before waiting for any earlier event.
    const copy: unknown = structuredClone(safe.payload);
    this.queued++;
    const task = this.pending.then(() => this.dispatchSignal.run(signal, () => this.receive(safe.type, safe.eventId, copy))).catch(() => {
      throw new Error('Discord could not verify or save this event. Retry it before advancing recovery.');
    }).finally(() => { this.queued--; });
    this.pending = task.then(() => {}, () => {});
    return task;
  }

  private async receive(type: string, eventId: string, payload: unknown): Promise<GatewayInboxEvent | null> {
    this.assertOpen();
    if (!['MESSAGE_CREATE', 'MESSAGE_UPDATE'].includes(type)) return null;
    const instance = getGatewayInstance(this.instanceId);
    if (!instance.enabled || instance.platform !== 'discord' || instance.accountId !== this.identity?.botId) throw new Error('This Discord instance changed.');
    const source = header.parse(payload);
    if (source.guild_id ? !instance.scope.guildIds.includes(source.guild_id) : !instance.scope.directMessages) return null;
    const events = this.inbox.list();
    const original = events.find((event) => event.input.platform === 'discord' && event.input.accountId === instance.accountId && event.input.guildId === source.guild_id
      && event.input.conversationId === source.channel_id && event.input.sourceMessageId === source.id && event.input.kind === 'message');
    if (type === 'MESSAGE_UPDATE' && !original) return null;
    // Updates can omit author, text or files. Resolve the complete current message, never invent an actor.
    const raw = type === 'MESSAGE_UPDATE' ? await this.read(`/channels/${source.channel_id}/messages/${source.id}`, message) : message.parse(payload);
    if (raw.id !== source.id || raw.channel_id !== source.channel_id || (raw.guild_id && raw.guild_id !== source.guild_id)) return null;
    if (raw.author.id === this.identity?.botId || raw.author.bot || raw.author.system || raw.webhook_id !== undefined || raw.application_id !== undefined
      || (raw.type !== 0 && raw.type !== 19) || (BigInt(raw.flags ?? 0) & (2n | 64n | 16384n)) || raw.message_snapshots?.length) return null;
    if (instance.senderPolicy.platform !== 'discord' || (instance.senderPolicy.allowedUserIds.length && !instance.senderPolicy.allowedUserIds.includes(raw.author.id))) return null;
    const info = await this.read(`/channels/${source.channel_id}`, channel);
    if (info.id !== source.channel_id || info.guild_id !== source.guild_id) return null;
    let parent: z.infer<typeof channel> | undefined;
    const threaded = [10, 11, 12].includes(info.type);
    if (!source.guild_id) {
      if (info.type !== 1 || info.parent_id || info.recipients?.length !== 1 || info.recipients[0].id !== raw.author.id || info.recipients[0].bot || info.recipients[0].system) return null;
    } else {
      if (!threaded && info.type !== 0 && info.type !== 5) return null;
      if (threaded) {
        if (!info.parent_id || !info.thread_metadata || info.thread_metadata.archived || info.thread_metadata.locked || (info.type === 12 && info.member?.user_id !== this.identity?.botId)) return null;
        parent = await this.read(`/channels/${info.parent_id}`, channel);
        if (parent.id !== info.parent_id || parent.guild_id !== source.guild_id || ![0, 5, 15, 16].includes(parent.type)) return null;
      }
      if (!instance.scope.conversationIds.includes(info.id) && !(parent && instance.scope.conversationIds.includes(parent.id))) return null;
      await this.permissions(source.guild_id, parent ?? info, threaded);
    }
    const actor = source.guild_id
      ? (await this.read(`/guilds/${source.guild_id}/members/${raw.author.id}`, z.object({ user, nick: z.string().nullable().optional() }))).user
      : await this.read(`/users/${raw.author.id}`, user);
    if (actor.id !== raw.author.id || actor.bot || actor.system) return null;
    const referenced = raw.message_reference;
    const reply = referenced?.message_id && (referenced.channel_id === undefined || referenced.channel_id === info.id) && (referenced.guild_id === undefined || referenced.guild_id === source.guild_id) && (referenced.type === undefined || referenced.type === 0)
      ? this.replySource(events, info.id, source.guild_id, referenced.message_id) : undefined;
    const input: GatewayInbound = {
      platform: 'discord', accountId: instance.accountId, conversationId: info.id,
      ...(source.guild_id ? { guildId: source.guild_id } : {}), ...(parent ? { parentConversationId: parent.id } : {}),
      threadId: original?.input.threadId ?? (!source.guild_id ? '' : threaded ? info.id : reply?.input.threadId ?? raw.id),
      sourceEventId: eventId, sourceMessageId: raw.id, kind: type === 'MESSAGE_UPDATE' ? 'edit' : 'message',
      actor: { id: actor.id, label: (actor.global_name || actor.username || actor.id).slice(0, 200), kind: 'user' },
      directMessage: !source.guild_id, triggered: raw.mentions.some((mention) => mention.id === this.identity?.botId) || Boolean(reply), text: raw.content,
      media: raw.attachments.map((file) => ({ kind: file.content_type?.startsWith('image/') ? 'image' : file.content_type?.startsWith('audio/') ? 'audio' : file.content_type?.startsWith('video/') ? 'video' : 'file',
        fileId: file.id, name: file.filename, mimeType: file.content_type, size: file.size })),
    };
    this.assertOpen();
    if (!gatewayInputAllowed(getGatewayInstance(this.instanceId), input)) return null;
    if (original && input.kind === 'edit' && original.input.actor.id === input.actor.id && original.input.text === input.text && JSON.stringify(original.input.media) === JSON.stringify(input.media)) return null;
    return this.inbox.accept(input);
  }

  private replySource(events: GatewayInboxEvent[], channelId: string, guildId: string | undefined, messageId: string): GatewayInboxEvent | undefined {
    const remote = `${this.encodeThreadId({ guildId: guildId ?? '@me', channelId })}/${messageId}`;
    return events.find((event) => event.input.platform === 'discord' && event.input.accountId === this.identity?.botId && event.input.guildId === guildId && event.input.conversationId === channelId
      && (event.input.sourceMessageId === messageId || event.reply?.parts.some((part) => part.status === 'sent' && part.remoteId === remote)));
  }

  private async permissions(guildId: string, info: z.infer<typeof channel>, threaded: boolean): Promise<void> {
    const bot = await this.read(`/guilds/${guildId}/members/${this.identity!.botId}`, z.object({ user, roles: z.array(id).max(1000) }));
    if (bot.user.id !== this.identity?.botId || !bot.user.bot) throw new Error('Discord bot membership could not be verified.');
    const roles = await this.read(`/guilds/${guildId}/roles`, z.array(z.object({ id, permissions: z.string().regex(/^\d{1,30}$/) })).max(1000));
    const everyone = roles.find((role) => role.id === guildId);
    if (!everyone || new Set(roles.map((role) => role.id)).size !== roles.length || new Set(bot.roles).size !== bot.roles.length
      || bot.roles.some((roleId) => !roles.some((role) => role.id === roleId)) || !info.permission_overwrites) throw new Error('Discord permissions could not be verified.');
    let bits = roles.filter((role) => role.id === guildId || bot.roles.includes(role.id)).reduce((all, role) => all | BigInt(role.permissions), 0n);
    if (bits & 8n) return;
    const apply = (items: z.infer<typeof overwrite>[]) => {
      const denied = items.reduce((all, item) => all | BigInt(item.deny), 0n); const allowed = items.reduce((all, item) => all | BigInt(item.allow), 0n);
      bits = (bits & ~denied) | allowed;
    };
    apply(info.permission_overwrites.filter((item) => item.type === 0 && item.id === guildId));
    apply(info.permission_overwrites.filter((item) => item.type === 0 && item.id !== guildId && bot.roles.includes(item.id)));
    apply(info.permission_overwrites.filter((item) => item.type === 1 && item.id === this.identity?.botId));
    const required = view | history | (threaded ? 1n << 38n : 1n << 11n);
    if ((bits & required) !== required) throw new Error('The Discord bot cannot read and reply in this channel.');
  }

  private async read<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    const response = await this.discordFetch(path, 'GET');
    return schema.parse(await response.json());
  }

  protected override async discordFetch(path: string, method: string, body?: unknown): Promise<Response> {
    this.assertOpen();
    const response = await fetch(`${this.apiBaseUrl}${path}`, { method, redirect: 'error', headers: { authorization: `Bot ${await this.resolveBotToken()}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.any([this.signal, this.dispatchSignal.getStore() ?? this.signal, AbortSignal.timeout(15000)]),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error('Discord could not verify this input. Check access, permissions and connection setup.'); }
    this.assertOpen(); return response;
  }

  async disconnect(): Promise<void> {
    this.closed = true; this.identity = undefined; this.abort.abort(); await this.pending;
  }
}
