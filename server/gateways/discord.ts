import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { DiscordAdapter } from '@chat-adapter/discord';
import type { ChatInstance, Logger, WebhookOptions } from 'chat';
import { z } from 'zod';
import type { GatewayInbound, GatewayInboxEvent, GatewayOutgoingFile } from '../../shared/types.ts';
import { discordId } from '../../shared/gateway-discord.ts';
import { getGatewayInstance } from './instances.ts';
import { gatewayInputAllowed, GatewayFileLimitError } from './inbox.ts';
import type { GatewayInbox } from './inbox.ts';
import { GatewaySetupError } from './telegram.ts';
import { DiscordGateway, discordGatewayDetails } from './discord-gateway.ts';
import type { GatewayStateAdapter } from './state.ts';
import { GatewaySendError } from './replies.ts';
import type { GatewayApprovedTextSend } from './replies.ts';
import { verifyGatewayDocument } from './outgoing.ts';
import type { GatewayDownloadSource } from './files.ts';

const id = z.string().refine(discordId, 'Invalid Discord ID.');
const stamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const user = z.object({ id, username: z.string().optional(), global_name: z.string().nullable().optional(), bot: z.boolean().optional(), system: z.boolean().optional() });
const header = z.object({ id, channel_id: id, guild_id: id.optional() });
const message = header.extend({
  author: user, type: z.number().int(), content: z.string().max(65536), flags: stamp.optional(),
  webhook_id: z.unknown().optional(), application_id: z.unknown().optional(), message_snapshots: z.array(z.unknown()).optional(),
  mentions: z.array(user).max(1000).default([]),
  message_reference: z.object({ message_id: id.optional(), channel_id: id.optional(), guild_id: id.optional(), type: z.number().int().optional() }).nullable().optional(),
  attachments: z.array(z.object({ id, filename: z.string().max(512), size: stamp, content_type: z.string().max(200).optional(), url: z.string().max(4096).optional() })).max(10).default([]),
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
  private readonly pendingChanges = new Map<string, number>();
  private readonly fileOrigin: string;
  private readonly dispatchSignal = new AsyncLocalStorage<AbortSignal>();
  private identity: { botId: string; appId: string } | undefined;
  private pending: Promise<void> = Promise.resolve();
  private queued = 0;
  private closed = false;
  private retryAt = 0;

  constructor(instanceId: string, inbox: GatewayInbox, botToken: string, options: { apiUrl?: string; signal?: AbortSignal; fileOrigin?: string } = {}) {
    super({ botToken, applicationId: getGatewayInstance(instanceId).accountId, apiUrl: options.apiUrl ?? 'https://discord.com/api/v10',
      logger: quiet, mentionRoleIds: [], respondToChannelIds: [], respondToGlobalMentions: false, publicKey: '',
      webhookVerifier: () => { throw new Error('Discord HTTP callbacks are not enabled.'); },
    });
    this.instanceId = instanceId; this.inbox = inbox;
    this.fileOrigin = new URL(options.fileOrigin ?? 'https://cdn.discordapp.com').origin;
    this.signal = options.signal ? AbortSignal.any([options.signal, this.abort.signal]) : this.abort.signal;
  }

  override get botUserId(): string | undefined { return this.identity?.botId; }

  override handleWebhook(_request: Request): Promise<Response> { return Promise.resolve(new Response('Not found', { status: 404 })); }

  override startGatewayListener(_options: WebhookOptions): Promise<Response> {
    return Promise.reject(new GatewaySetupError("Use Athena’s durable Discord Gateway connection."));
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
    const source = type === 'MESSAGE_UPDATE' ? header.safeParse(copy) : undefined;
    const original = source?.success ? this.inbox.list().find((event) => event.input.kind === 'message' && event.input.platform === 'discord'
      && event.input.guildId === source.data.guild_id && event.input.conversationId === source.data.channel_id && event.input.sourceMessageId === source.data.id) : undefined;
    if (original) this.pendingChanges.set(original.id, (this.pendingChanges.get(original.id) ?? 0) + 1);
    let release = true;
    this.queued++;
    const task = this.pending.then(() => this.dispatchSignal.run(signal, () => this.receive(safe.type, safe.eventId, copy))).catch(() => {
      if (original) {
        release = false;
        try { this.inbox.holdInput(original.id, 'Discord could not verify a source update. Review the original work before retrying delivery.'); release = true; } catch { /* Keep delivery blocked until this connection stops. */ }
      }
      throw new Error('Discord could not verify or save this event. Retry it before advancing recovery.');
    }).finally(() => {
      this.queued--;
      if (original && release) { const left = this.pendingChanges.get(original.id)! - 1; if (left) this.pendingChanges.set(original.id, left); else this.pendingChanges.delete(original.id); }
    });
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
    const verified = await this.context(source, raw.author.id);
    if (!verified) return null;
    const { info, parent, actor, threaded } = verified;
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
      media: inputMedia(raw),
    };
    this.assertOpen();
    if (!gatewayInputAllowed(getGatewayInstance(this.instanceId), input)) return null;
    if (original && input.kind === 'edit' && original.input.actor.id === input.actor.id && original.input.text === input.text && JSON.stringify(original.input.media) === JSON.stringify(input.media)) return null;
    return this.inbox.accept(input);
  }

  private async context(source: z.infer<typeof header>, actorId: string, attach = false) {
    const instance = getGatewayInstance(this.instanceId);
    const info = await this.read(`/channels/${source.channel_id}`, channel);
    if (info.id !== source.channel_id || info.guild_id !== source.guild_id) return null;
    let parent: z.infer<typeof channel> | undefined;
    const threaded = [10, 11, 12].includes(info.type);
    if (!source.guild_id) {
      if (info.type !== 1 || info.parent_id || info.recipients?.length !== 1 || info.recipients[0].id !== actorId || info.recipients[0].bot || info.recipients[0].system) return null;
    } else {
      if (!threaded && info.type !== 0 && info.type !== 5) return null;
      if (threaded) {
        if (!info.parent_id || !info.thread_metadata || info.thread_metadata.archived || info.thread_metadata.locked || (info.type === 12 && info.member?.user_id !== this.identity?.botId)) return null;
        parent = await this.read(`/channels/${info.parent_id}`, channel);
        if (parent.id !== info.parent_id || parent.guild_id !== source.guild_id || ![0, 5, 15, 16].includes(parent.type)) return null;
      }
      if (!instance.scope.conversationIds.includes(info.id) && !(parent && instance.scope.conversationIds.includes(parent.id))) return null;
      await this.permissions(source.guild_id, parent ?? info, threaded, attach);
    }
    const actor = source.guild_id
      ? (await this.read(`/guilds/${source.guild_id}/members/${actorId}`, z.object({ user, nick: z.string().nullable().optional() }))).user
      : await this.read(`/users/${actorId}`, user);
    if (actor.id !== actorId || actor.bot || actor.system) return null;
    return { info, parent, actor, threaded };
  }

  private replySource(events: GatewayInboxEvent[], channelId: string, guildId: string | undefined, messageId: string): GatewayInboxEvent | undefined {
    const remote = `${this.encodeThreadId({ guildId: guildId ?? '@me', channelId })}/${messageId}`;
    return events.find((event) => event.input.platform === 'discord' && event.input.accountId === this.identity?.botId && event.input.guildId === guildId && event.input.conversationId === channelId
      && (event.input.sourceMessageId === messageId || [...(event.reply?.parts ?? []), ...Object.values(event.notices ?? {}), ...(event.outgoing ?? [])].some((part) => part.status === 'sent' && part.remoteId === remote)));
  }

  private async permissions(guildId: string, info: z.infer<typeof channel>, threaded: boolean, attach = false): Promise<void> {
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
    const required = view | history | (threaded ? 1n << 38n : 1n << 11n) | (attach ? 1n << 15n : 0n);
    if ((bits & required) !== required) throw new Error('The Discord bot cannot read and reply in this channel.');
  }

  private authorize(event: GatewayInboxEvent): void {
    this.assertOpen();
    if (!this.identity || event.route.instanceId !== this.instanceId || event.input.platform !== 'discord' || event.input.accountId !== this.identity.botId || this.pendingChanges.has(event.id)) throw new GatewaySendError('failed');
    const saved = this.inbox.list().find((item) => item.id === event.id);
    if (!saved || JSON.stringify(saved.input) !== JSON.stringify(event.input) || JSON.stringify(saved.route) !== JSON.stringify(event.route)) throw new GatewaySendError('failed');
    this.inbox.checkAccess(event);
  }

  private async destination(event: GatewayInboxEvent, attach = false): Promise<z.infer<typeof message>> {
    this.authorize(event);
    const source = { id: event.input.sourceMessageId, channel_id: event.input.conversationId, guild_id: event.input.guildId };
    const verified = await this.context(source, event.input.actor.id, attach);
    if (!verified || verified.parent?.id !== event.input.parentConversationId) throw new GatewaySendError('failed');
    const raw = await this.read(`/channels/${source.channel_id}/messages/${source.id}`, message);
    if (raw.id !== source.id || raw.channel_id !== source.channel_id || (raw.guild_id && raw.guild_id !== source.guild_id)
      || raw.author.id !== event.input.actor.id || raw.author.bot || raw.author.system || raw.webhook_id !== undefined || raw.application_id !== undefined
      || ![0, 19].includes(raw.type) || raw.message_snapshots?.length || (BigInt(raw.flags ?? 0) & (2n | 64n | 16384n))) throw new GatewaySendError('failed');
    this.authorize(event);
    const latest = this.inbox.list().filter((item) => item.input.kind === 'edit' && item.input.accountId === event.input.accountId
      && item.input.guildId === event.input.guildId && item.input.conversationId === source.channel_id && item.input.sourceMessageId === source.id).at(-1)?.input ?? event.input;
    const media = inputMedia(raw);
    if (latest.text !== raw.content || JSON.stringify(latest.media) !== JSON.stringify(media)) {
      const sourceEventId = crypto.createHash('sha256').update(JSON.stringify([source, latest.sourceEventId, raw.content, media])).digest('hex');
      this.inbox.accept({ ...event.input, kind: 'edit', sourceEventId, text: raw.content, media });
      this.inbox.holdInput(event.id, 'The Discord source changed. Review this work before explicitly retrying delivery.');
      throw new GatewaySendError('failed');
    }
    return raw;
  }

  async downloadFileSource(fileId: string, maxBytes: number, signal: AbortSignal, event: GatewayInboxEvent): Promise<GatewayDownloadSource> {
    return this.dispatchSignal.run(signal, async () => {
      signal.throwIfAborted();
      const saved = event.input.media.find((item) => item.fileId === fileId);
      if (!saved) throw new Error('This file is not in the saved Discord message.');
      const raw = await this.destination(event);
      const file = raw.attachments.find((item) => item.id === fileId);
      if (!file || file.size !== saved.size || file.filename !== saved.name || !file.url) throw new Error('This Discord attachment changed.');
      if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || file.size > maxBytes) throw new GatewayFileLimitError('This Discord file exceeds its download limit.');
      const url = new URL(file.url); const parts = url.pathname.split('/');
      if (url.origin !== this.fileOrigin || url.username || url.password || url.hash || parts.length !== 5 || parts[1] !== 'attachments'
        || parts[2] !== event.input.conversationId || parts[3] !== fileId || !parts[4] || /%(?:2f|5c|00)/i.test(parts[4])) throw new Error('Discord supplied an unsafe attachment address.');
      this.authorize(event); signal.throwIfAborted();
      // The short-lived CDN URL is refreshed by reading the source message. It never receives a bot token.
      const response = await fetch(url, { redirect: 'error', signal: AbortSignal.any([signal, this.signal, AbortSignal.timeout(45000)]) });
      const declaredBytes = response.headers.has('content-length') ? Number(response.headers.get('content-length')) : file.size;
      if (!response.ok || !response.body || !Number.isSafeInteger(declaredBytes) || declaredBytes !== file.size || declaredBytes > maxBytes) {
        await response.body?.cancel(); throw new Error('This Discord file could not be downloaded within its limit.');
      }
      const body = response.body;
      const source = async function* (): AsyncGenerator<Uint8Array> {
        const reader = body.getReader(); let size = 0;
        try {
          for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength;
            if (size > maxBytes || size > file.size) throw new GatewayFileLimitError('This Discord file exceeds its download limit.');
            yield part.value;
          }
          if (size !== file.size) throw new Error('The Discord file was incomplete.');
        } finally { try { await reader.cancel(); } finally { reader.releaseLock(); } }
      };
      return { source: source(), declaredBytes, cancel: () => body.cancel() };
    });
  }

  async replyText(event: GatewayInboxEvent, text: string, signal: AbortSignal, approved?: GatewayApprovedTextSend): Promise<string> {
    return this.dispatchSignal.run(signal, async () => {
      const version = this.inbox.deliveryVersion(event.id);
      try {
        signal.throwIfAborted(); await this.destination(event);
        if (!text || text.length > 2000) throw new Error('Discord reply exceeds its limit.');
      } catch (error) { throw preflightError(error); }
      return this.sendMessage(event, text, signal, version, undefined, approved);
    });
  }

  async replyDocument(event: GatewayInboxEvent, file: GatewayOutgoingFile, signal: AbortSignal): Promise<string> {
    return this.dispatchSignal.run(signal, async () => {
      const version = this.inbox.deliveryVersion(event.id); let bytes: Buffer;
      try {
        signal.throwIfAborted(); await this.destination(event, true);
        bytes = await verifyGatewayDocument(event, file, signal);
      } catch (error) { throw preflightError(error); }
      return this.sendMessage(event, '', signal, version, { file, bytes });
    });
  }

  private async sendMessage(event: GatewayInboxEvent, text: string, signal: AbortSignal, version: string, upload?: { file: GatewayOutgoingFile; bytes: Buffer }, approved?: GatewayApprovedTextSend): Promise<string> {
    let token: string; let nonce: string; let body: string | FormData;
    try {
      token = await this.resolveBotToken(); signal.throwIfAborted(); this.authorize(event); this.checkRateLimit();
      const saved = this.inbox.list().find((item) => item.id === event.id)!;
      const index = upload ? saved.outgoing?.findIndex((file) => file.status === 'sending' && file.path === upload.file.path && file.sha256 === upload.file.sha256 && file.name === upload.file.name && file.size === upload.file.size) ?? -1
        : saved.reply?.parts.findIndex((part) => part.status === 'sending' && part.text === text) ?? -1;
      const notice = !upload && index < 0 ? (['working', 'approval'] as const).find((kind) => saved.notices?.[kind]?.status === 'sending' && saved.notices[kind]!.text === text) : undefined;
      if (approved) nonce = approved.authorize(event, text);
      else {
        if (index < 0 && !notice) throw new Error('Claim this Discord delivery before sending.');
        const attempt = upload ? saved.outgoing![index].attempts.length : notice ? saved.notices![notice]!.attempts : saved.reply!.parts[index].attempts;
        nonce = crypto.createHash('sha256').update(JSON.stringify([this.instanceId, event.id, upload ? 'file' : notice ?? 'reply', index, attempt])).digest('hex').slice(0, 24);
      }
      if (!/^[a-f0-9]{24}$/.test(nonce)) throw new Error('Invalid Discord delivery receipt.');
      const payload = { content: text, nonce, enforce_nonce: true, allowed_mentions: { parse: [], replied_user: false }, flags: 4,
        message_reference: { type: 0, message_id: event.input.sourceMessageId, channel_id: event.input.conversationId, fail_if_not_exists: true },
        ...(upload ? { attachments: [{ id: 0, filename: upload.file.name }] } : {}),
      };
      if (upload) {
        const form = new FormData(); form.set('payload_json', JSON.stringify(payload));
        form.set('files[0]', new Blob([new Uint8Array(upload.bytes)], { type: 'application/octet-stream' }), upload.file.name); body = form;
      } else body = JSON.stringify(payload);
      if (version !== this.inbox.deliveryVersion(event.id)) throw new Error('The Discord source changed.');
      if (approved && approved.authorize(event, text) !== nonce) throw new Error('The approved Discord delivery changed.');
    } catch (error) { throw preflightError(error); }
    try {
      const response = await fetch(`${this.apiBaseUrl}/channels/${event.input.conversationId}/messages`, { method: 'POST', body,
        headers: { authorization: `Bot ${token}`, ...(typeof body === 'string' ? { 'content-type': 'application/json' } : {}) },
        redirect: 'error', signal: AbortSignal.any([signal, this.signal, AbortSignal.timeout(30000)]),
      });
      if (response.status === 429) throw await this.rateLimited(response);
      if (!response.ok) { await response.body?.cancel(); throw new GatewaySendError(response.status >= 400 && response.status < 500 && response.status !== 408 ? 'failed' : 'uncertain'); }
      const sent = message.extend({ nonce: z.string() }).parse(await response.json());
      if (sent.channel_id !== event.input.conversationId || (sent.guild_id && sent.guild_id !== event.input.guildId) || sent.author.id !== this.identity?.botId || !sent.author.bot
        || sent.type !== 19 || sent.author.system || sent.webhook_id !== undefined || sent.nonce !== nonce || sent.content !== text || sent.message_reference?.message_id !== event.input.sourceMessageId
        || (sent.message_reference.channel_id && sent.message_reference.channel_id !== event.input.conversationId)
        || (sent.message_reference.guild_id && sent.message_reference.guild_id !== event.input.guildId)
        || (upload ? sent.attachments.length !== 1 || sent.attachments[0].filename !== upload.file.name || sent.attachments[0].size !== upload.file.size : sent.attachments.length !== 0)) throw new GatewaySendError('uncertain');
      return `${this.encodeThreadId({ guildId: event.input.guildId ?? '@me', channelId: sent.channel_id })}/${sent.id}`;
    } catch (error) { throw error instanceof GatewaySendError ? error : new GatewaySendError('uncertain'); }
  }

  private checkRateLimit(): void {
    if (this.retryAt > Date.now()) throw new GatewaySendError('retry', this.retryAt - Date.now());
  }
  private async rateLimited(response: Response): Promise<GatewaySendError> {
    const body = z.object({ retry_after: z.number().nonnegative().finite() }).safeParse(await response.json().catch(() => null));
    const header = Number(response.headers.get('retry-after')); const seconds = Math.max(1, Number.isFinite(header) ? header : 1, body.success ? body.data.retry_after : 1);
    const delay = Math.min(Number.MAX_SAFE_INTEGER - Date.now(), Math.ceil(seconds * 1000)); this.retryAt = Date.now() + delay;
    return new GatewaySendError('retry', delay);
  }

  private async read<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    const response = await this.discordFetch(path, 'GET');
    return schema.parse(await response.json());
  }

  protected override async discordFetch(path: string, method: string, body?: unknown): Promise<Response> {
    this.assertOpen(); this.checkRateLimit();
    const response = await fetch(`${this.apiBaseUrl}${path}`, { method, redirect: 'error', headers: { authorization: `Bot ${await this.resolveBotToken()}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.any([this.signal, this.dispatchSignal.getStore() ?? this.signal, AbortSignal.timeout(15000)]),
    });
    if (response.status === 429) throw await this.rateLimited(response);
    if (!response.ok) { await response.body?.cancel(); throw new Error('Discord could not verify this input. Check access, permissions and connection setup.'); }
    this.assertOpen(); return response;
  }

  async disconnect(): Promise<void> {
    this.closed = true; this.identity = undefined; this.abort.abort(); await this.pending;
  }
}

function inputMedia(raw: z.infer<typeof message>): GatewayInbound['media'] {
  return raw.attachments.map((file) => ({ kind: file.content_type?.startsWith('image/') ? 'image' : file.content_type?.startsWith('audio/') ? 'audio' : file.content_type?.startsWith('video/') ? 'video' : 'file',
    fileId: file.id, name: file.filename, mimeType: file.content_type, size: file.size }));
}

function preflightError(error: unknown): GatewaySendError {
  return error instanceof GatewaySendError && error.outcome === 'retry' ? error : new GatewaySendError('failed');
}
