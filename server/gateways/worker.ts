import { Chat } from 'chat';
import type { Logger } from 'chat';
import type { GatewayHealth, GatewayReconciliation } from '../../shared/types.ts';
import { getGatewaySecrets } from '../store.ts';
import { captureGatewayRoute, getGatewayInstance } from './instances.ts';
import { GatewayCleanupError, GatewayInbox } from './inbox.ts';
import { GatewayStateAdapter } from './state.ts';
import { GatewaySetupError, TelegramIntakeAdapter } from './telegram.ts';
import { SlackIntakeAdapter } from './slack.ts';
import { DiscordGatewayGapError, DiscordGatewayRetryError } from './discord-gateway.ts';
import { discordTransport } from './discord-transport.ts';
import { whatsAppTransport } from './whatsapp-transport.ts';
import { WhatsAppRelayError } from './whatsapp-relay.ts';
export { discordTransport } from './discord-transport.ts';
import { gatewayPlatformAvailable } from '../../shared/gateways.ts';
import { claimGatewayAccount } from './ownership.ts';
import { GatewayFileProcessor } from './files.ts';
import type { GatewayDownloader } from './files.ts';
import { GatewayDispatcher } from './dispatch.ts';
import { gatewayExecution } from './execution.ts';
import type { GatewayExecutionServices } from './execution.ts';
import { GatewayReplies } from './replies.ts';
import type { GatewayReplySender } from './replies.ts';
import { selectGatewayDocuments } from './outgoing.ts';
import type { GatewayFileSender } from './outgoing.ts';
import { registerGatewayDeliverables } from './deliverables.ts';
import { GatewayOutboxLedger } from './outbox.ts';
import { registerGatewayOutbox } from './outbox-owner.ts';

export interface Transport {
  start(): Promise<void>;
  stop(): Promise<void>;
  alive(): boolean;
  failure?(): Error | undefined;
  download?: GatewayDownloader;
  reply?: GatewayReplySender;
  upload?: GatewayFileSender;
}
interface WorkerOptions {
  transport?(state: GatewayStateAdapter, inbox: GatewayInbox, activity: (connected: boolean) => void, signal: AbortSignal): Transport;
  health?(value: GatewayHealth): void;
  retryMs?: number;
  monitorMs?: number;
  execution?: GatewayExecutionServices;
}
const quiet: Logger = { child: () => quiet, debug() {}, info() {}, warn() {}, error() {} };

function telegramTransport(state: GatewayStateAdapter, inbox: GatewayInbox, activity: (connected: boolean) => void, signal: AbortSignal): Transport {
  const botToken = getGatewaySecrets(state.instanceId).botToken;
  if (!botToken) throw new GatewaySetupError('Add a Telegram bot token before connecting.');
  const telegram = new TelegramIntakeAdapter(state.instanceId, inbox, botToken, activity, { signal });
  const chat = new Chat({ userName: 'Athena', adapters: { telegram }, state, logger: quiet, concurrency: 'concurrent' });
  return { start: () => chat.initialize(), stop: () => chat.shutdown(), alive: () => telegram.isPolling, download: (id, maxBytes, signal) => telegram.downloadFileSource(id, maxBytes, signal), reply: (event, text, signal, approved) => telegram.replyText(event, text, signal, approved), upload: (event, file, signal) => telegram.replyDocument(event, file, signal) };
}

function slackTransport(state: GatewayStateAdapter, inbox: GatewayInbox, activity: (connected: boolean) => void, signal: AbortSignal): Transport {
  const { botToken, appToken } = getGatewaySecrets(state.instanceId);
  if (!botToken || !appToken) throw new GatewaySetupError('Add Slack bot and app tokens before connecting.');
  const slack = new SlackIntakeAdapter(state.instanceId, inbox, botToken, appToken, activity, { signal });
  const chat = new Chat({ userName: 'Athena', adapters: { slack }, state, logger: quiet, concurrency: 'concurrent' });
  return { start: () => chat.initialize(), stop: () => chat.shutdown(), alive: () => slack.isConnected,
    download: (id, maxBytes, signal, event) => slack.downloadFileSource(id, maxBytes, signal, event),
    reply: (event, text, signal) => slack.replyText(event, text, signal), upload: (event, file, signal) => slack.replyDocument(event, file, signal) };
}

/** A supervised local intake worker. Agent execution and delivery consume the saved inbox separately. */
export class GatewayWorker {
  private readonly instanceId: string;
  private readonly options: WorkerOptions;
  private state: GatewayStateAdapter | undefined;
  private transport: Transport | undefined;
  private files: GatewayFileProcessor | undefined;
  private dispatcher: GatewayDispatcher | undefined;
  private replies: GatewayReplies | undefined;
  private inbox: GatewayInbox | undefined;
  private abort: AbortController | undefined;
  private releaseAccount: (() => Promise<void>) | undefined;
  private releaseDeliverables: (() => void) | undefined;
  private releaseOutbox: (() => void) | undefined;
  private starting: Promise<void> | undefined;
  private stopping: Promise<void> | undefined;
  private disposing: Promise<void> | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private monitor: ReturnType<typeof setInterval> | undefined;
  private closed = false;
  private attempts = 0;
  private current: GatewayHealth;

  constructor(instanceId: string, options: WorkerOptions = {}) {
    this.instanceId = instanceId;
    this.options = options;
    this.current = { instanceId, status: 'paused', reason: '', attempts: 0, updatedAt: Date.now() };
  }

  health(): GatewayHealth { return { ...this.current }; }

  private publish(status: GatewayHealth['status'], reason = '', details: Pick<GatewayHealth, 'retryAt' | 'recoveryRequired'> = {}): void {
    if (this.closed && status !== 'paused') return;
    this.current = { instanceId: this.instanceId, status, reason, attempts: this.attempts, updatedAt: Date.now(), ...details };
    this.options.health?.(this.health());
  }

  start(): Promise<void> {
    if (this.closed || this.transport) return Promise.resolve();
    if (this.starting) return this.starting;
    if (this.disposing) return this.disposing.then(() => this.start());
    clearTimeout(this.retry);
    this.retry = undefined;
    return this.starting = this.open().finally(() => { this.starting = undefined; });
  }

  private async open(): Promise<void> {
    this.attempts++;
    this.publish('connecting');
    const state = new GatewayStateAdapter(this.instanceId);
    const abort = new AbortController();
    this.state = state;
    this.abort = abort;
    try {
      const instance = getGatewayInstance(this.instanceId);
      if (!instance.enabled || !gatewayPlatformAvailable(instance.platform)) throw new GatewaySetupError('This gateway instance is paused or unavailable.');
      captureGatewayRoute(instance.id);
      this.releaseAccount = await claimGatewayAccount(instance.platform, instance.accountId);
      abort.signal.throwIfAborted();
      await state.connect();
      abort.signal.throwIfAborted();
      const inbox = new GatewayInbox(state);
      this.inbox = inbox;
      inbox.recover();
      const outbox = new GatewayOutboxLedger(state, inbox);
      outbox.recover();
      const transport = (this.options.transport ?? (instance.platform === 'whatsapp' ? whatsAppTransport : instance.platform === 'discord' ? discordTransport : instance.platform === 'slack' ? slackTransport : telegramTransport))(state, inbox, (connected) => {
        if (!connected && (instance.platform === 'discord' || instance.platform === 'whatsapp')) abort.abort();
        this.publish(connected ? 'connected' : 'retrying', connected ? '' : 'This gateway could not receive messages. It will retry.');
      }, abort.signal);
      this.transport = transport;
      await transport.start();
      abort.signal.throwIfAborted();
      if (transport.download) {
        this.files = new GatewayFileProcessor(this.instanceId, inbox, transport.download, abort.signal);
        await this.files.start();
      }
      abort.signal.throwIfAborted();
      if (transport.reply) {
        const execution = this.options.execution ?? gatewayExecution;
        if (instance.platform === 'telegram' || instance.platform === 'discord') this.releaseOutbox = registerGatewayOutbox(instance.id, outbox, abort.signal);
        if (transport.upload) this.releaseDeliverables = registerGatewayDeliverables(instance.id, inbox, abort.signal);
        this.replies = new GatewayReplies(inbox, transport.reply, abort.signal, (event, kind) => kind !== 'approval' || execution.approvalPending?.(event) === true, transport.upload, outbox); this.replies.start();
        this.dispatcher = new GatewayDispatcher(inbox, abort.signal, execution);
        await this.dispatcher.start();
      }
      abort.signal.throwIfAborted();
      this.attempts = 0;
      this.publish('connected');
      this.monitor = setInterval(() => {
        if (transport.alive() || this.closed) return;
        clearInterval(this.monitor);
        this.monitor = undefined;
        void this.restart().catch(() => this.publish('needs-setup', 'This gateway could not stop safely. Restart Athena before retrying.'));
      }, this.options.monitorMs ?? 1000);
      this.monitor.unref();
    } catch (error) {
      const failure = this.transport?.failure?.() ?? error;
      await this.dispose();
      if (!this.closed) this.connectionFailed(failure);
    }
  }

  private async restart(): Promise<void> {
    const failure = this.transport?.failure?.();
    await this.dispose();
    if (!this.closed) this.connectionFailed(failure);
  }

  private connectionFailed(error: unknown): void {
    if (error instanceof WhatsAppRelayError && error.kind !== 'retry') this.publish('needs-setup', error.message, { recoveryRequired: error.kind === 'review' });
    else if (error instanceof GatewaySetupError) this.publish('needs-setup', error.message, error instanceof DiscordGatewayGapError ? { recoveryRequired: true } : {});
    else {
      const retryAt = error instanceof DiscordGatewayRetryError || error instanceof WhatsAppRelayError ? error.retryAt : undefined;
      this.publish('retrying', retryAt ? error instanceof WhatsAppRelayError ? 'The WhatsApp relay asked this instance to wait before reconnecting.' : 'Discord asked this instance to wait before reconnecting.' : 'This gateway could not connect or restore its inbox. Check setup and local storage.', { retryAt });
      this.scheduleRetry(retryAt);
    }
  }

  private scheduleRetry(retryAt?: number): void {
    if (this.retry || this.closed) return;
    const backoff = Math.min(30000, (this.options.retryMs ?? 1000) * 2 ** Math.min(this.attempts, 5));
    const delay = Math.min(2147483647, Math.max(backoff, (retryAt ?? 0) - Date.now()));
    this.retry = setTimeout(() => {
      this.retry = undefined;
      void this.start().catch(() => this.publish('needs-setup', 'This gateway could not reconnect safely. Restart Athena before retrying.'));
    }, delay);
    this.retry.unref();
  }

  private dispose(): Promise<void> {
    return this.disposing ??= this.disposeOwned().finally(() => { this.disposing = undefined; });
  }

  private async disposeOwned(): Promise<void> {
    this.abort?.abort();
    this.releaseDeliverables?.(); this.releaseDeliverables = undefined;
    this.releaseOutbox?.(); this.releaseOutbox = undefined;
    const transport = this.transport;
    const state = this.state;
    const releaseAccount = this.releaseAccount;
    // Keep claims if transport shutdown fails; another worker must not take over a live consumer.
    // Chat.shutdown disconnects SDK state, so finish file receipts while ownership is still held.
    await this.dispatcher?.stop();
    await this.replies?.stop();
    await this.files?.stop();
    await transport?.stop();
    await state?.disconnect();
    await releaseAccount?.();
    this.transport = undefined;
    this.state = undefined;
    this.releaseAccount = undefined;
    this.files = undefined;
    this.inbox = undefined;
    this.dispatcher = undefined; this.replies = undefined;
  }

  retryFiles(eventId: string): void {
    if (this.closed || !this.inbox || !this.files) throw Object.assign(new Error('Connect this gateway before retrying its files.'), { status: 400 });
    this.inbox.retryFiles(eventId);
  }

  retryReply(eventId: string): void {
    if (this.closed || !this.inbox || !this.replies) throw Object.assign(new Error('Connect this gateway before retrying its reply.'), { status: 400 });
    try { this.inbox.retryReply(eventId); }
    catch { throw Object.assign(new Error('This reply cannot be retried. Check its status, access and destination.'), { status: 400 }); }
  }

  reconcile(eventId: string): GatewayReconciliation {
    if (this.closed || !this.dispatcher) throw Object.assign(new Error('Connect this gateway before checking its saved work.'), { status: 400 });
    try { return this.dispatcher.reconcile(eventId); }
    catch { throw Object.assign(new Error('This work cannot be reconciled. Check the saved destination, sender access and source edits. Nothing was restarted or sent.'), { status: 400 }); }
  }

  groupAlbum(eventId: string, body: unknown): { leaderId: string } {
    if (this.closed || !this.inbox || !this.dispatcher) throw Object.assign(new Error('Connect this gateway before grouping its album.'), { status: 400 });
    try { return this.inbox.groupAlbum(eventId, body); }
    catch { throw Object.assign(new Error('This album cannot be grouped. Reload and check all source messages, saved files, limits and destination.'), { status: 400 }); }
  }

  cleanup(body: unknown): { removed: number } {
    if (this.closed || !this.inbox) throw Object.assign(new Error('This gateway is changing connection state. Retry cleanup once it has settled.'), { status: 400 });
    try { return this.inbox.cleanup(body); }
    catch (error) { throw Object.assign(new Error(error instanceof GatewayCleanupError ? error.message : 'This inbox could not be cleaned safely. Check its saved receipts before retrying.'), { status: 400 }); }
  }

  async selectDocuments(eventId: string, body: unknown): Promise<void> {
    if (this.closed || !this.inbox || !this.transport?.upload || !this.replies || !this.abort) throw Object.assign(new Error('Connect this gateway before selecting files.'), { status: 400 });
    await selectGatewayDocuments(this.inbox, eventId, body, this.abort.signal);
  }

  changeDocument(eventId: string, index: number, action: 'retry' | 'skip'): void {
    if (this.closed || !this.inbox || !this.transport?.upload || !Number.isSafeInteger(index) || index < 0) throw Object.assign(new Error('Connect this gateway and choose a saved file.'), { status: 400 });
    try { this.inbox.changeOutgoing(eventId, index, action); }
    catch { throw Object.assign(new Error('This file cannot be changed. Check its status, access and destination.'), { status: 400 }); }
  }

  stop(): Promise<void> { return this.stopping ??= this.close(); }

  private async close(): Promise<void> {
    this.closed = true;
    this.abort?.abort();
    clearTimeout(this.retry);
    clearInterval(this.monitor);
    await this.starting;
    await this.dispose();
    this.publish('paused');
  }
}
