import { Chat } from 'chat';
import type { Logger } from 'chat';
import type { GatewayHealth } from '../../shared/types.ts';
import { getGatewaySecrets } from '../store.ts';
import { captureGatewayRoute, getGatewayInstance } from './instances.ts';
import { GatewayInbox } from './inbox.ts';
import { GatewayStateAdapter } from './state.ts';
import { GatewaySetupError, TelegramIntakeAdapter } from './telegram.ts';
import { claimGatewayAccount } from './ownership.ts';
import { GatewayFileProcessor } from './files.ts';
import type { GatewayDownloader } from './files.ts';
import { GatewayDispatcher } from './dispatch.ts';
import type { GatewayExecutionServices } from './execution.ts';
import { GatewayReplies } from './replies.ts';
import type { GatewayReplySender } from './replies.ts';

interface Transport {
  start(): Promise<void>;
  stop(): Promise<void>;
  alive(): boolean;
  download?: GatewayDownloader;
  reply?: GatewayReplySender;
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
  return { start: () => chat.initialize(), stop: () => chat.shutdown(), alive: () => telegram.isPolling, download: (id, maxBytes, signal) => telegram.downloadFileSource(id, maxBytes, signal), reply: (event, text, signal) => telegram.replyText(event, text, signal) };
}

/** A supervised local intake worker. Agent execution and delivery consume the saved inbox separately. */
export class TelegramGatewayWorker {
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

  private publish(status: GatewayHealth['status'], reason = ''): void {
    if (this.closed && status !== 'paused') return;
    this.current = { instanceId: this.instanceId, status, reason, attempts: this.attempts, updatedAt: Date.now() };
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
      if (!instance.enabled || instance.platform !== 'telegram') throw new GatewaySetupError('This Telegram instance is paused.');
      captureGatewayRoute(instance.id);
      this.releaseAccount = await claimGatewayAccount('telegram', instance.accountId);
      abort.signal.throwIfAborted();
      await state.connect();
      abort.signal.throwIfAborted();
      const inbox = new GatewayInbox(state);
      this.inbox = inbox;
      inbox.recover();
      const transport = (this.options.transport ?? telegramTransport)(state, inbox, (connected) => {
        this.publish(connected ? 'connected' : 'retrying', connected ? '' : 'Telegram could not receive messages. It will retry.');
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
        this.replies = new GatewayReplies(inbox, transport.reply, abort.signal); this.replies.start();
        this.dispatcher = new GatewayDispatcher(inbox, abort.signal, this.options.execution);
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
      await this.dispose();
      if (this.closed) return;
      if (error instanceof GatewaySetupError) this.publish('needs-setup', error.message);
      else {
        this.publish('retrying', 'This gateway could not connect or restore its inbox. Check setup and local storage.');
        this.scheduleRetry();
      }
    }
  }

  private async restart(): Promise<void> {
    await this.dispose();
    if (this.closed) return;
    this.publish('retrying', 'Telegram stopped receiving messages. It will reconnect.');
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.retry || this.closed) return;
    const delay = Math.min(30000, (this.options.retryMs ?? 1000) * 2 ** Math.min(this.attempts, 5));
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
