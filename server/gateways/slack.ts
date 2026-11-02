import { SlackAdapter } from '@chat-adapter/slack';
import { LogLevel, SocketModeClient } from '@slack/socket-mode';
import type { Logger as SlackLogger } from '@slack/socket-mode';
import type { ChatInstance, Logger } from 'chat';
import { z } from 'zod';
import type { GatewayInbound, GatewayInboxEvent, GatewayOutgoingFile } from '../../shared/types.ts';
import { slackChannelId, slackTimestamp, slackUserId, slackWorkspaceId } from '../../shared/gateway-slack.ts';
import { getGatewayInstance, withGatewayRoute } from './instances.ts';
import { gatewayInputAllowed, GatewayFileLimitError } from './inbox.ts';
import type { GatewayInbox } from './inbox.ts';
import { GatewaySetupError } from './telegram.ts';
import { GatewaySendError } from './replies.ts';
import { verifyGatewayDocument } from './outgoing.ts';
import type { GatewayDownloadSource } from './files.ts';

const userId = z.string().regex(slackUserId).max(200);
const workspaceId = z.string().regex(slackWorkspaceId).max(200);
const channelId = z.string().regex(slackChannelId).max(200);
const timestamp = z.string().regex(slackTimestamp);
const appId = z.string().regex(/^A[A-Z0-9]+$/).max(200);
const botId = z.string().regex(/^B[A-Z0-9]+$/).max(200);
const fields = z.record(z.string(), z.unknown());
const envelope = z.object({
  type: z.literal('event_callback'), team_id: workspaceId, api_app_id: appId,
  event_id: z.string().min(1).max(200), event: fields,
  is_ext_shared_channel: z.boolean().optional(), is_enterprise_install: z.boolean().optional(), context_team_id: workspaceId.optional(),
});
const message = z.object({
  type: z.enum(['message', 'app_mention']), user: userId, ts: timestamp, thread_ts: timestamp.optional(),
  text: z.string().max(65536).default(''), subtype: z.string().optional(), bot_id: z.string().optional(), bot_profile: z.unknown().optional(),
  team: workspaceId.optional(), team_id: workspaceId.optional(), user_team: workspaceId.optional(),
  files: z.array(z.object({ id: z.string().regex(/^F[A-Z0-9]+$/).max(200), name: z.string().max(512).optional(), mimetype: z.string().max(200).optional(), size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional() })).max(10).optional(),
});
const member = z.object({ ok: z.literal(true), user: z.object({
  id: userId, team_id: workspaceId, deleted: z.boolean(), is_bot: z.boolean(), is_app_user: z.boolean().optional(), is_stranger: z.boolean().optional(),
  real_name: z.string().optional(), name: z.string().optional(), profile: z.object({ display_name: z.string().optional() }).optional(),
}) });
const channel = z.object({ ok: z.literal(true), channel: z.object({
  id: channelId, user: userId.optional(), is_im: z.boolean(), is_mpim: z.boolean().optional(), is_member: z.boolean().optional(), is_archived: z.boolean().optional(),
  is_ext_shared: z.boolean().optional(), is_org_shared: z.boolean().optional(), is_pending_ext_shared: z.boolean().optional(), context_team_id: workspaceId.optional(),
}) });
// SDK errors/logs can include tokens and raw message bodies. Report only our own safe health.
const quiet: Logger = { child: () => quiet, debug() {}, info() {}, warn() {}, error() {} };
const socketLog: SlackLogger = { debug() {}, info() {}, warn() {}, error() {}, setLevel() {}, getLevel: () => LogLevel.ERROR, setName() {} };

/** Socket Mode receipts and explicitly selected delivery share the same verified workspace. */
export class SlackIntakeAdapter extends SlackAdapter {
  private readonly instanceId: string;
  private readonly inbox: GatewayInbox;
  private readonly activity: (connected: boolean) => void;
  private readonly signal: AbortSignal | undefined;
  private identity: { workspaceId: string; appId: string; userId: string } | undefined;
  private closed = false;
  private socket: SocketModeClient | undefined;
  private pending: Promise<void> = Promise.resolve();
  private queued = 0;
  private connected = false;
  private readonly fileOrigin: string;

  constructor(instanceId: string, inbox: GatewayInbox, botToken: string, appToken: string, activity: (connected: boolean) => void, options: { apiUrl?: string; signal?: AbortSignal; fileOrigin?: string } = {}) {
    super({ botToken, appToken, mode: 'socket', logger: quiet, signingSecret: '', apiUrl: options.apiUrl,
      webClientOptions: { retryConfig: { retries: 0 }, rejectRateLimitedCalls: true, timeout: 10000, logger: socketLog, allowAbsoluteUrls: false },
      agentView: false, nativeStreaming: false,
    });
    this.instanceId = instanceId; this.inbox = inbox; this.activity = activity; this.signal = options.signal;
    this.fileOrigin = new URL(options.fileOrigin ?? 'https://files.slack.com').origin;
  }

  get isConnected(): boolean { return this.connected && !this.closed && !this.signal?.aborted; }

  override async initialize(chat: ChatInstance): Promise<void> {
    this.assertOpen();
    const instance = getGatewayInstance(this.instanceId);
    if (!instance.enabled || instance.platform !== 'slack') throw new GatewaySetupError('This Slack instance is paused.');
    // The SDK catches auth failures; fail before connecting a socket to the wrong workspace or app.
    const auth = z.object({ ok: z.literal(true), team_id: workspaceId, user_id: userId, bot_id: botId, is_enterprise_install: z.boolean().optional() }).parse(await this.webClient.auth.test());
    if (auth.team_id !== instance.accountId || auth.is_enterprise_install) throw new GatewaySetupError('The Slack token must belong to this workspace installation.');
    const bot = z.object({ ok: z.literal(true), bot: z.object({ id: botId, user_id: userId, app_id: appId }) }).parse(await this.webClient.bots.info({ bot: auth.bot_id }));
    if (bot.bot.id !== auth.bot_id || bot.bot.user_id !== auth.user_id) throw new GatewaySetupError('The Slack bot identity could not be verified.');
    this.assertOpen();
    this.identity = { workspaceId: auth.team_id, appId: bot.bot.app_id, userId: auth.user_id };
    this._botUserId = auth.user_id; this._botId = auth.bot_id;
    await super.initialize(chat);
    this.assertOpen();
  }

  private assertOpen(): void {
    this.signal?.throwIfAborted();
    if (this.closed) throw new GatewaySetupError('This Slack connection is closed.');
  }

  protected override async startSocketMode(): Promise<void> {
    if (!this.appToken) throw new GatewaySetupError('Add a Slack app token before connecting.');
    const socket = new SocketModeClient({ appToken: this.appToken, logger: socketLog, autoReconnectEnabled: false,
      clientOptions: { retryConfig: { retries: 0 }, rejectRateLimitedCalls: true, timeout: 10000, ...(this.slackApiUrl ? { slackApiUrl: this.slackApiUrl } : {}) },
    });
    this.socket = socket;
    socket.on('slack_event', (value: unknown) => {
      if (this.closed || this.signal?.aborted) return;
      const event = z.object({ type: z.string(), body: fields, ack: z.custom<() => Promise<void>>((item) => typeof item === 'function') }).safeParse(value);
      if (!event.success || this.queued >= 32) { this.activity(false); return; }
      // Bound memory and preserve socket arrival order; nothing queued is acknowledged early.
      this.queued++;
      this.pending = this.pending.then(() => this.routeSocketEvent(event.data.body, event.data.type, event.data.ack)).finally(() => { this.queued--; });
    });
    socket.on('error', () => { this.connected = false; if (!this.closed) this.activity(false); });
    socket.on('disconnected', () => { this.connected = false; if (!this.closed) this.activity(false); });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      await Promise.race([socket.start(), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new GatewaySetupError('Slack did not connect in time. Try reconnecting.')), 15000);
        abort = () => reject(new GatewaySetupError('This Slack connection was stopped.'));
        this.signal?.addEventListener('abort', abort, { once: true });
        if (this.signal?.aborted) abort();
      })]);
      this.connected = true;
    } catch {
      await socket.disconnect();
      throw new GatewaySetupError('Slack could not connect. Check both tokens and Socket Mode setup.');
    } finally {
      clearTimeout(timer);
      if (abort) this.signal?.removeEventListener('abort', abort);
    }
  }

  protected override async routeSocketEvent(body: Record<string, unknown>, eventType: string, ack: (response?: Record<string, unknown>) => Promise<void>): Promise<void> {
    try {
      this.assertOpen();
      if (!this.identity) throw new GatewaySetupError('Verify the Slack workspace before receiving messages.');
      if (eventType === 'events_api') await this.receive(body);
      // Never invoke SDK actions, slash commands or background message handlers here.
      this.assertOpen();
      await ack();
      this.activity(true);
    } catch {
      // Leaving this delivery unacknowledged allows Slack to retry after a failed local commit.
      if (!this.closed && !this.signal?.aborted) this.activity(false);
    }
  }

  private async receive(body: Record<string, unknown>): Promise<void> {
    const parsed = envelope.safeParse(body);
    if (!parsed.success) return;
    const payload = parsed.data; const identity = this.identity!;
    const instance = getGatewayInstance(this.instanceId);
    if (!instance.enabled) throw new GatewaySetupError('This Slack instance is paused.');
    if (payload.team_id !== identity.workspaceId || payload.team_id !== instance.accountId || payload.api_app_id !== identity.appId
      || payload.is_enterprise_install || payload.is_ext_shared_channel || (payload.context_team_id && payload.context_team_id !== identity.workspaceId)) return;
    const outer = payload.event;
    if (!['message', 'app_mention'].includes(String(outer.type))) return;
    const edited = outer.subtype === 'message_changed';
    const raw = edited ? fields.parse(outer.message) : outer;
    if (raw.bot_id || raw.bot_profile || (raw.subtype && raw.subtype !== 'file_share')) return;
    const input = message.parse(raw);
    if (input.user === identity.userId || [input.team, input.team_id, input.user_team].some((team) => team && team !== identity.workspaceId)) return;
    const conversationId = channelId.parse(outer.channel);
    if (raw.channel !== undefined && raw.channel !== conversationId) return;
    const original = edited ? this.inbox.list().find((event) => event.input.kind === 'message' && event.input.accountId === payload.team_id
      && event.input.conversationId === conversationId && event.input.sourceMessageId === input.ts) : undefined;
    if (edited && !original) return;
    const channelType = outer.channel_type ?? (original ? original.input.directMessage ? 'im' : 'channel' : outer.type === 'app_mention' ? 'channel' : '');
    const directMessage = channelType === 'im';
    if (!directMessage && !['channel', 'group'].includes(String(channelType))) return;
    const normalized: GatewayInbound = {
      platform: 'slack', accountId: payload.team_id, conversationId, threadId: input.thread_ts ?? input.ts,
      sourceEventId: payload.event_id, sourceMessageId: input.ts, kind: edited ? 'edit' : 'message',
      actor: { id: input.user, label: input.user, kind: 'user' }, directMessage,
      triggered: input.text.includes(`<@${identity.userId}>`), text: input.text,
      media: (input.files ?? []).map((file) => ({ kind: file.mimetype?.startsWith('image/') ? 'image' : file.mimetype?.startsWith('audio/') ? 'audio' : file.mimetype?.startsWith('video/') ? 'video' : 'file', fileId: file.id, name: file.name, mimeType: file.mimetype, size: file.size })),
    };
    // Edits can omit their original thread timestamp.
    if (original) normalized.threadId = original.input.threadId;
    if (!gatewayInputAllowed(instance, normalized)) return;
    // A workspace event is not proof that its actor belongs to that workspace (Slack Connect).
    const user = await this.localMember(input.user);
    if (!user || !await this.localConversation(normalized)) return;
    normalized.actor.label = (user.profile?.display_name || user.real_name || user.name || user.id).slice(0, 200);
    if (edited) {
      // Slack also sends message_changed when only a link preview changes.
      if (original?.input.actor.id === normalized.actor.id && original.input.text === normalized.text && JSON.stringify(original.input.media) === JSON.stringify(normalized.media)) return;
    }
    // accept() rechecks current sender policy and route after asynchronous identity lookups.
    this.inbox.accept(normalized);
  }

  private async localMember(id: string) {
    const user = member.parse(await this.webClient.users.info({ user: id })).user;
    this.assertOpen();
    return user.id === id && user.team_id === this.identity?.workspaceId && !user.deleted && !user.is_bot && !user.is_app_user && !user.is_stranger ? user : null;
  }

  private async localConversation(input: GatewayInbound): Promise<boolean> {
    const info = channel.parse(await this.webClient.conversations.info({ channel: input.conversationId })).channel;
    this.assertOpen();
    if (info.id !== input.conversationId || info.is_im !== input.directMessage || info.is_mpim || info.is_archived || info.is_org_shared || info.is_ext_shared || info.is_pending_ext_shared
      || (info.context_team_id && info.context_team_id !== this.identity?.workspaceId)) return false;
    return input.directMessage ? info.user === input.actor.id : info.is_member === true && info.is_ext_shared === false && info.is_org_shared === false;
  }

  private authorize(event: GatewayInboxEvent): void {
    this.assertOpen();
    if (!this.identity || event.route.instanceId !== this.instanceId || event.input.platform !== 'slack' || event.input.accountId !== this.identity.workspaceId) throw new GatewaySendError('failed');
    this.inbox.checkAccess(event);
  }

  private async destination(event: GatewayInboxEvent): Promise<void> {
    this.authorize(event);
    if (!await this.localMember(event.input.actor.id) || !await this.localConversation(event.input)) throw new GatewaySendError('failed');
    this.authorize(event);
  }

  private fileUrl(value: string, prefix: string): URL {
    const url = new URL(value);
    if (url.origin !== this.fileOrigin || url.username || url.password || url.hash || !url.pathname.startsWith(prefix)) throw new Error('Slack supplied an unsafe file location.');
    return url;
  }

  async downloadFileSource(fileId: string, maxBytes: number, signal: AbortSignal, event: GatewayInboxEvent): Promise<GatewayDownloadSource> {
    await this.destination(event);
    if (!event.input.media.some((file) => file.fileId === fileId)) throw new Error('This file is not in the saved message.');
    const file = z.object({ ok: z.literal(true), file: z.object({
      id: z.string(), user: userId, mode: z.literal('hosted'), is_external: z.literal(false), user_team: workspaceId.optional(),
      size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), url_private_download: z.string().optional(), url_private: z.string().optional(),
      channels: z.array(z.string()).optional(), groups: z.array(z.string()).optional(), ims: z.array(z.string()).optional(),
      shares: z.object({ public: fields.optional(), private: fields.optional() }).optional(), shared_team_ids: z.array(z.string()).optional(),
    }) }).parse(await this.webClient.files.info({ file: fileId })).file;
    if (file.id !== fileId || (file.user_team && file.user_team !== this.identity?.workspaceId) || file.shared_team_ids?.some((id) => id !== this.identity?.workspaceId)
      || ![...(file.channels ?? []), ...(file.groups ?? []), ...(file.ims ?? []), ...Object.keys(file.shares?.public ?? {}), ...Object.keys(file.shares?.private ?? {})].includes(event.input.conversationId)
      || !await this.localMember(file.user)) throw new Error('This file is not shared in the saved local conversation.');
    if (file.size > maxBytes) throw new GatewayFileLimitError('This Slack file exceeds its download limit.');
    const url = this.fileUrl(file.url_private_download ?? file.url_private ?? '', '/files-pri/');
    this.authorize(event);
    const combined = AbortSignal.any([signal, AbortSignal.timeout(45000), ...(this.signal ? [this.signal] : [])]);
    const response = await fetch(url, { headers: { authorization: `Bearer ${await this.getToken()}` }, redirect: 'error', signal: combined });
    const declaredBytes = response.headers.has('content-length') ? Number(response.headers.get('content-length')) : file.size;
    if (!response.ok || !response.body || !Number.isSafeInteger(declaredBytes) || declaredBytes !== file.size || declaredBytes > maxBytes) {
      await response.body?.cancel(); throw new Error('This Slack file could not be downloaded within its limit.');
    }
    const body = response.body;
    async function* source(): AsyncGenerator<Uint8Array> {
      const reader = body.getReader(); let size = 0;
      try {
        for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength;
          if (size > maxBytes) throw new GatewayFileLimitError('This Slack file exceeds its download limit.');
          yield part.value;
        }
      } finally { try { await reader.cancel(); } finally { reader.releaseLock(); } }
    }
    return { source: source(), declaredBytes, cancel: () => body.cancel() };
  }

  async replyText(event: GatewayInboxEvent, text: string, signal: AbortSignal): Promise<string> {
    const version = this.inbox.deliveryVersion(event.id);
    try { signal.throwIfAborted(); await this.destination(event); signal.throwIfAborted();
      if (version !== this.inbox.deliveryVersion(event.id)) throw new GatewaySendError('failed');
    }
    catch { throw new GatewaySendError('failed'); }
    const rendered = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    if (!text || rendered.length > 3000 || !event.input.threadId) throw new GatewaySendError('failed');
    try {
      const result = z.object({ ok: z.literal(true), channel: channelId, ts: timestamp,
        warning: z.string().optional(), warnings: z.array(z.string()).optional(),
        response_metadata: z.object({ warnings: z.array(z.string()).optional() }).optional(),
      }).parse(await this.webClient.chat.postMessage({ channel: event.input.conversationId, thread_ts: event.input.threadId, text: rendered,
        mrkdwn: false, parse: 'none', link_names: false, unfurl_links: false, unfurl_media: false,
      }));
      if (result.channel !== event.input.conversationId || result.warning === 'message_truncated' || result.warnings?.includes('message_truncated') || result.response_metadata?.warnings?.includes('message_truncated')) throw new GatewaySendError('uncertain');
      return this.encodeThreadId({ channel: result.channel, threadTs: result.ts });
    } catch (error) { throw slackSendError(error); }
  }

  async replyDocument(event: GatewayInboxEvent, file: GatewayOutgoingFile, signal: AbortSignal): Promise<string> {
    const version = this.inbox.deliveryVersion(event.id);
    let bytes: Buffer;
    try { signal.throwIfAborted(); bytes = await verifyGatewayDocument(event, file, signal); await this.destination(event); }
    catch { throw new GatewaySendError('failed'); }
    try {
      const allocation = z.object({ ok: z.literal(true), file_id: z.string().regex(/^F[A-Z0-9]+$/), upload_url: z.string() })
        .parse(await this.webClient.files.getUploadURLExternal({ filename: file.name, length: bytes.length }));
      const url = this.fileUrl(allocation.upload_url, '/upload/');
      await verifyGatewayDocument(event, file, signal);
      this.authorize(event); signal.throwIfAborted();
      if (version !== this.inbox.deliveryVersion(event.id)) throw new GatewaySendError('failed');
      const response = await fetch(url, { method: 'POST', body: new Uint8Array(bytes), headers: { 'content-type': 'application/octet-stream' },
        redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(30000), ...(this.signal ? [this.signal] : [])]),
      });
      await response.body?.cancel();
      if (!response.ok) throw new GatewaySendError(response.status === 429 ? 'retry' : 'failed', 1000);
      await this.destination(event); signal.throwIfAborted();
      await verifyGatewayDocument(event, file, signal); this.authorize(event);
      if (version !== this.inbox.deliveryVersion(event.id)) throw new GatewaySendError('failed');
      const result = z.object({ ok: z.literal(true), files: z.array(z.object({ id: z.string() })).length(1) })
        .parse(await this.webClient.files.completeUploadExternal({ files: [{ id: allocation.file_id, title: file.name }], channel_id: event.input.conversationId, thread_ts: event.input.threadId }));
      if (result.files[0].id !== allocation.file_id) throw new GatewaySendError('uncertain');
      return `${this.encodeThreadId({ channel: event.input.conversationId, threadTs: event.input.threadId })}:${allocation.file_id}`;
    } catch (error) { throw slackSendError(error); }
  }

  override async disconnect(): Promise<void> {
    this.closed = true; this.connected = false; this.identity = undefined;
    await this.socket?.disconnect(); this.socket = undefined;
    await this.pending;
    await super.disconnect();
  }
}

function slackSendError(error: unknown): GatewaySendError {
  if (error instanceof GatewaySendError) return error;
  if (error instanceof Error && 'code' in error) {
    if (error.code === 'slack_webapi_rate_limited_error') {
      const seconds = 'retryAfter' in error && typeof error.retryAfter === 'number' && Number.isFinite(error.retryAfter) ? error.retryAfter : 1;
      return new GatewaySendError('retry', Math.ceil(Math.max(1, seconds) * 1000));
    }
    if (error.code === 'slack_webapi_platform_error') return new GatewaySendError('failed');
  }
  return new GatewaySendError('uncertain');
}
