import { SlackAdapter } from '@chat-adapter/slack';
import { LogLevel, SocketModeClient } from '@slack/socket-mode';
import type { Logger as SlackLogger } from '@slack/socket-mode';
import type { ChatInstance, Logger } from 'chat';
import { z } from 'zod';
import type { GatewayInbound } from '../../shared/types.ts';
import { slackChannelId, slackTimestamp, slackUserId, slackWorkspaceId } from '../../shared/gateway-slack.ts';
import { getGatewayInstance } from './instances.ts';
import { gatewayInputAllowed } from './inbox.ts';
import type { GatewayInbox } from './inbox.ts';
import { GatewaySetupError } from './telegram.ts';

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

/** Socket Mode ingress only. Production setup stays unavailable until delivery and files are proved. */
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

  constructor(instanceId: string, inbox: GatewayInbox, botToken: string, appToken: string, activity: (connected: boolean) => void, options: { apiUrl?: string; signal?: AbortSignal } = {}) {
    super({ botToken, appToken, mode: 'socket', logger: quiet, signingSecret: '', apiUrl: options.apiUrl,
      webClientOptions: { retryConfig: { retries: 0 }, rejectRateLimitedCalls: true, timeout: 10000, logger: socketLog, allowAbsoluteUrls: false },
      agentView: false, nativeStreaming: false,
    });
    this.instanceId = instanceId; this.inbox = inbox; this.activity = activity; this.signal = options.signal;
  }

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
    socket.on('error', () => { if (!this.closed) this.activity(false); });
    socket.on('disconnected', () => { if (!this.closed) this.activity(false); });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      await Promise.race([socket.start(), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new GatewaySetupError('Slack did not connect in time. Try reconnecting.')), 15000);
        abort = () => reject(new GatewaySetupError('This Slack connection was stopped.'));
        this.signal?.addEventListener('abort', abort, { once: true });
        if (this.signal?.aborted) abort();
      })]);
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
      platform: 'slack', accountId: payload.team_id, conversationId, threadId: input.thread_ts ?? (directMessage ? '' : input.ts),
      sourceEventId: payload.event_id, sourceMessageId: input.ts, kind: edited ? 'edit' : 'message',
      actor: { id: input.user, label: input.user, kind: 'user' }, directMessage,
      triggered: input.text.includes(`<@${identity.userId}>`), text: input.text,
      media: (input.files ?? []).map((file) => ({ kind: file.mimetype?.startsWith('image/') ? 'image' : file.mimetype?.startsWith('audio/') ? 'audio' : file.mimetype?.startsWith('video/') ? 'video' : 'file', fileId: file.id, name: file.name, mimeType: file.mimetype, size: file.size })),
    };
    // A thread can appear on a DM root later, or be omitted from an edit's inner message.
    if (original) normalized.threadId = original.input.threadId;
    if (!gatewayInputAllowed(instance, normalized)) return;
    // A workspace event is not proof that its actor belongs to that workspace (Slack Connect).
    const user = member.parse(await this.webClient.users.info({ user: input.user })).user;
    this.assertOpen();
    if (user.id !== input.user || user.team_id !== identity.workspaceId || user.deleted || user.is_bot || user.is_app_user || user.is_stranger) return;
    const info = channel.parse(await this.webClient.conversations.info({ channel: conversationId })).channel;
    this.assertOpen();
    if (info.id !== conversationId || info.is_im !== directMessage || info.is_mpim || info.is_archived || info.is_org_shared || info.is_ext_shared || info.is_pending_ext_shared
      || (info.context_team_id && info.context_team_id !== identity.workspaceId)) return;
    if (directMessage ? info.user !== input.user : info.is_member !== true || info.is_ext_shared !== false || info.is_org_shared !== false) return;
    normalized.actor.label = (user.profile?.display_name || user.real_name || user.name || user.id).slice(0, 200);
    if (edited) {
      // Slack also sends message_changed when only a link preview changes.
      if (original?.input.actor.id === normalized.actor.id && original.input.text === normalized.text && JSON.stringify(original.input.media) === JSON.stringify(normalized.media)) return;
    }
    // accept() rechecks current sender policy and route after asynchronous identity lookups.
    this.inbox.accept(normalized);
  }

  override async disconnect(): Promise<void> {
    this.closed = true; this.identity = undefined;
    await this.socket?.disconnect(); this.socket = undefined;
    await this.pending;
    await super.disconnect();
  }
}
