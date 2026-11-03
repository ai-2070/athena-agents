import type { GatewayDeliveryReview, GatewayHealth, GatewayReconciliation, GatewayStatus, GatewayTelegramSetup, GatewayWhatsAppCheck, GatewayWhatsAppRecovery, GatewayWhatsAppSenders, GatewayWhatsAppSetup, GatewayWorkReview, ServerEvent } from '../../shared/types.ts';
import { gatewayNeedsReview, gatewayPlatformAvailable } from '../../shared/gateways.ts';
import { bus, emit, listProjects } from '../store.ts';
import { GatewayCleanupError, GatewayInbox, gatewayInboxHistory } from './inbox.ts';
import { GatewayStateAdapter } from './state.ts';
import { getGatewayInstance, listGatewayInstances } from './instances.ts';
import { reviewDiscordRecovery } from './discord-recovery.ts';
import { checkWhatsAppSetup, finishWhatsAppPairing, pairWhatsApp, replaceWhatsAppPairing, reviewWhatsAppPairing } from './whatsapp-setup.ts';
import { inspectWhatsAppRecovery, restoreWhatsAppRecovery, reviewWhatsAppRecovery } from './whatsapp-recovery.ts';
import { claimGatewayAccount } from './ownership.ts';
import { GatewayWorker } from './worker.ts';
import { checkTelegramSetup, switchTelegramToPolling } from './telegram-setup.ts';
import { GatewayOutboxLedger } from './outbox.ts';

/** Settings changes restart only their instance; transport failures never expose raw SDK errors. */
export class GatewaySupervisor {
  private readonly workers = new Map<string, GatewayWorker>();
  private readonly statuses = new Map<string, GatewayHealth>();
  private readonly reviews = new Map<string, number | null>();
  private readonly changedInboxes = new Set<string>();
  private pending: Promise<void> = Promise.resolve();
  private closed = false;
  private listening = false;
  private readonly worker: (instanceId: string, health: (value: GatewayHealth) => void) => GatewayWorker;

  constructor(worker = (instanceId: string, health: (value: GatewayHealth) => void) => new GatewayWorker(instanceId, { health })) {
    this.worker = worker;
  }

  private changed = (event: ServerEvent): void => {
    if ((event.type === 'gateway-inbox' || event.type === 'gateway-health') && typeof event.instanceId === 'string') this.changedInboxes.add(event.instanceId);
    if (event.type === 'gateways' && typeof event.id === 'string') { this.changedInboxes.add(event.id); void this.reconnect(event.id); }
    if (event.type === 'projects' || ((event.type === 'agents' || event.type === 'workflows') && event.removed === true)) {
      for (const instance of listGatewayInstances()) void this.reconnect(instance.id);
    }
  };

  health(): GatewayHealth[] { return [...this.statuses.values()].map((value) => ({ ...value })); }

  /** Read each changed journal once per state refresh, rather than for every delivery mutation. */
  summary(): GatewayStatus[] {
    const instances = listGatewayInstances();
    const ids = new Set(instances.map((instance) => instance.id));
    for (const id of this.reviews.keys()) if (!ids.has(id)) this.reviews.delete(id);
    for (const id of this.changedInboxes) if (!ids.has(id)) this.changedInboxes.delete(id);
    const projects = new Map(listProjects().map((project) => [project.id, project.name]));
    return instances.map((instance) => {
      if (!this.reviews.has(instance.id) || this.changedInboxes.has(instance.id)) {
        try { this.reviews.set(instance.id, gatewayInboxHistory(instance.id).filter(gatewayNeedsReview).length); }
        catch { this.reviews.set(instance.id, null); }
        this.changedInboxes.delete(instance.id);
      }
      return {
        id: instance.id, name: instance.name, platform: instance.platform, projectId: instance.projectId,
        projectName: projects.get(instance.projectId) || 'Project unavailable', enabled: instance.enabled,
        status: !instance.enabled ? 'paused' : !projects.has(instance.projectId) ? 'needs-setup'
          : this.statuses.get(instance.id)?.status ?? (gatewayPlatformAvailable(instance.platform) ? 'connecting' : 'needs-setup'),
        reviewCount: this.reviews.get(instance.id) ?? null,
      };
    });
  }

  retryFiles(instanceId: string, eventId: string): void {
    const worker = this.workers.get(instanceId);
    if (!worker) throw Object.assign(new Error('Connect this gateway before retrying its files.'), { status: 400 });
    worker.retryFiles(eventId);
  }

  retryReply(instanceId: string, eventId: string): void {
    const worker = this.workers.get(instanceId);
    if (!worker) throw Object.assign(new Error('Connect this gateway before retrying its reply.'), { status: 400 });
    worker.retryReply(eventId);
  }

  dismissRequest(instanceId: string, eventId: string, body: unknown): Promise<void> {
    const task = this.pending.then(async () => {
      const instance = getGatewayInstance(instanceId);
      if (this.closed || instance.enabled) throw Object.assign(new Error('Pause this gateway before dismissing a held request.'), { status: 400 });
      await this.workers.get(instanceId)?.stop(); this.workers.delete(instanceId);
      const state = new GatewayStateAdapter(instanceId); let release: (() => Promise<void>) | undefined;
      try {
        release = await claimGatewayAccount(instance.platform, instance.accountId); await state.connect();
        new GatewayInbox(state).dismissRequest(eventId, body);
      } catch (error) {
        if (error instanceof Error && 'status' in error) throw error;
        throw Object.assign(new Error('This request could not be dismissed. Check storage and ownership, then reload its saved receipt.'), { status: 503 });
      } finally { await state.disconnect(); await release?.(); }
    });
    this.pending = task.then(() => {}, () => {}); return task;
  }

  private deliveryReviewTask(instanceId: string, work: (inbox: GatewayInbox) => GatewayDeliveryReview): Promise<GatewayDeliveryReview> {
    const task = this.pending.then(async () => {
      const instance = getGatewayInstance(instanceId);
      if (this.closed || instance.enabled) throw Object.assign(new Error('Pause this gateway before reviewing delivery.'), { status: 400 });
      const state = new GatewayStateAdapter(instanceId); let release: (() => Promise<void>) | undefined; let reviewing = false;
      try {
        await this.workers.get(instanceId)?.stop(); this.workers.delete(instanceId);
        release = await claimGatewayAccount(instance.platform, instance.accountId); await state.connect();
        reviewing = true; return work(new GatewayInbox(state));
      } catch (error) {
        if (reviewing && error instanceof Error && 'status' in error && (error.status === 400 || error.status === 404 || error.status === 409 || error.status === 503)) throw error;
        throw Object.assign(new Error('Delivery could not be reviewed safely. Check storage and ownership, then reload its receipts.'), { status: 503 });
      } finally { await state.disconnect(); await release?.(); }
    });
    this.pending = task.then(() => {}, () => {}); return task;
  }

  prepareDeliveryReview(instanceId: string, eventId: string): Promise<GatewayDeliveryReview> {
    return this.deliveryReviewTask(instanceId, (inbox) => inbox.prepareDeliveryReview(eventId));
  }

  reviewDelivery(instanceId: string, eventId: string, body: unknown): Promise<GatewayDeliveryReview> {
    return this.deliveryReviewTask(instanceId, (inbox) => inbox.reviewDelivery(eventId, body));
  }

  private workReviewTask(instanceId: string, work: (inbox: GatewayInbox) => GatewayWorkReview): Promise<GatewayWorkReview> {
    const task = this.pending.then(async () => {
      const instance = getGatewayInstance(instanceId);
      if (this.closed || instance.enabled) throw Object.assign(new Error('Pause this gateway before reviewing saved work.'), { status: 400 });
      const state = new GatewayStateAdapter(instanceId); let release: (() => Promise<void>) | undefined; let reviewing = false;
      try {
        await this.workers.get(instanceId)?.stop(); this.workers.delete(instanceId);
        release = await claimGatewayAccount(instance.platform, instance.accountId); await state.connect(); reviewing = true;
        return work(new GatewayInbox(state));
      } catch (error) {
        if (reviewing && error instanceof Error && 'status' in error && (error.status === 400 || error.status === 404 || error.status === 409 || error.status === 503)) throw error;
        throw Object.assign(new Error('Saved work could not be reviewed safely. Check storage and ownership, then reload its receipts.'), { status: 503 });
      } finally { await state.disconnect(); await release?.(); }
    });
    this.pending = task.then(() => {}, () => {}); return task;
  }
  prepareWorkReview(instanceId: string, eventId: string): Promise<GatewayWorkReview> {
    return this.workReviewTask(instanceId, (inbox) => inbox.prepareWorkReview(eventId));
  }
  keepWork(instanceId: string, eventId: string, body: unknown): Promise<GatewayWorkReview> {
    return this.workReviewTask(instanceId, (inbox) => inbox.keepWork(eventId, body));
  }

  private outboxReviewTask(instanceId: string, work: (ledger: GatewayOutboxLedger) => void): Promise<void> {
    const task = this.pending.then(async () => {
      const instance = getGatewayInstance(instanceId);
      if (this.closed || instance.enabled) throw Object.assign(new Error('Pause the selected gateway before reviewing its saved Outbox delivery.'), { status: 400 });
      const state = new GatewayStateAdapter(instanceId); let release: (() => Promise<void>) | undefined; let reviewing = false;
      try {
        await this.workers.get(instanceId)?.stop(); this.workers.delete(instanceId);
        release = await claimGatewayAccount(instance.platform, instance.accountId); await state.connect();
        reviewing = true;
        if (getGatewayInstance(instanceId).enabled) throw Object.assign(new Error('Pause this gateway before changing its Outbox delivery receipts.'), { status: 400 });
        work(new GatewayOutboxLedger(state, new GatewayInbox(state)));
      } catch (error) {
        if (reviewing && error instanceof Error && 'status' in error) throw error;
        throw Object.assign(new Error('This Outbox delivery could not be reviewed safely. Check storage and ownership, then reload its receipts.'), { status: 503 });
      } finally { await state.disconnect(); await release?.(); }
    });
    this.pending = task.then(() => {}, () => {}); return task;
  }

  finishOutbox(instanceId: string, projectId: string, postId: string, body: unknown): Promise<void> {
    return this.outboxReviewTask(instanceId, (ledger) => { ledger.recover({ projectId, postId }); ledger.finishLocal(projectId, postId, body); });
  }
  prepareOutboxReview(instanceId: string, projectId: string, postId: string): Promise<void> {
    return this.outboxReviewTask(instanceId, (ledger) => {
      if (!ledger.list().some((entry) => entry.projectId === projectId && entry.postId === postId)) throw Object.assign(new Error('No such saved Outbox delivery.'), { status: 404 });
      ledger.recover({ projectId, postId });
    });
  }
  reviewOutbox(instanceId: string, projectId: string, postId: string, body: unknown): Promise<void> {
    return this.outboxReviewTask(instanceId, (ledger) => ledger.review(projectId, postId, body));
  }

  reconcile(instanceId: string, eventId: string): GatewayReconciliation {
    const worker = this.workers.get(instanceId);
    if (!worker) throw Object.assign(new Error('Connect this gateway before checking its saved work.'), { status: 400 });
    return worker.reconcile(eventId);
  }

  groupAlbum(instanceId: string, eventId: string, body: unknown): { leaderId: string } {
    const worker = this.workers.get(instanceId);
    if (!worker) throw Object.assign(new Error('Connect this gateway before grouping its album.'), { status: 400 });
    return worker.groupAlbum(eventId, body);
  }

  async cleanup(instanceId: string, body: unknown): Promise<{ removed: number }> {
    const worker = this.workers.get(instanceId);
    if (worker) return worker.cleanup(body);
    const instance = getGatewayInstance(instanceId);
    if (instance.enabled) throw Object.assign(new Error('Pause this gateway or let it finish connecting before cleaning receipts.'), { status: 400 });
    const state = new GatewayStateAdapter(instanceId);
    try {
      await state.connect();
      return new GatewayInbox(state).cleanup(body);
    } catch (error) {
      throw Object.assign(new Error(error instanceof GatewayCleanupError ? error.message : 'This inbox could not be cleaned safely. Check storage and ownership before retrying.'), { status: 400 });
    } finally { await state.disconnect(); }
  }

  reviewDiscordRecovery(instanceId: string, body: unknown): Promise<void> {
    const task = this.pending.then(async () => {
      const instance = getGatewayInstance(instanceId);
      if (instance.platform !== 'discord' || instance.enabled) throw Object.assign(new Error('Pause this Discord instance before reviewing its recovery gap.'), { status: 400 });
      await this.workers.get(instanceId)?.stop(); this.workers.delete(instanceId);
      const state = new GatewayStateAdapter(instanceId); let release: (() => Promise<void>) | undefined;
      try {
        release = await claimGatewayAccount('discord', instance.accountId); await state.connect();
        reviewDiscordRecovery(state, body);
        const health: GatewayHealth = { instanceId, status: 'paused', reason: '', attempts: 0, updatedAt: Date.now() };
        this.statuses.set(instanceId, health); emit('gateway-health', { ...health });
      } finally { await state.disconnect(); await release?.(); }
    });
    this.pending = task.then(() => {}, () => {}); return task;
  }

  private whatsAppSetupTask<T>(instanceId: string, work: (inbox: GatewayInbox) => T | Promise<T>): Promise<T> {
    const task = this.pending.then(async () => {
      const instance = getGatewayInstance(instanceId);
      if (this.closed || instance.platform !== 'whatsapp' || instance.enabled) throw Object.assign(new Error('Pause this WhatsApp instance before changing its setup or recovery.'), { status: 400 });
      await this.workers.get(instanceId)?.stop(); this.workers.delete(instanceId);
      const state = new GatewayStateAdapter(instanceId); let release: (() => Promise<void>) | undefined;
      try {
        release = await claimGatewayAccount('whatsapp', instance.accountId); await state.connect();
        const result = await work(new GatewayInbox(state));
        const health: GatewayHealth = { instanceId, status: 'paused', reason: '', attempts: 0, updatedAt: Date.now() };
        this.statuses.set(instanceId, health); emit('gateway-health', { ...health }); return result;
      } finally { await state.disconnect(); await release?.(); }
    });
    this.pending = task.then(() => {}, () => {}); return task;
  }

  private telegramSetupTask(instanceId: string, work: (state: GatewayStateAdapter) => Promise<GatewayTelegramSetup>): Promise<GatewayTelegramSetup> {
    const task = this.pending.then(async () => {
      const instance = getGatewayInstance(instanceId);
      if (this.closed || instance.platform !== 'telegram' || instance.enabled) throw Object.assign(new Error('Pause this Telegram instance before checking or switching setup.'), { status: 400 });
      const state = new GatewayStateAdapter(instanceId); let release: (() => Promise<void>) | undefined; let checking = false;
      try {
        await this.workers.get(instanceId)?.stop(); this.workers.delete(instanceId);
        release = await claimGatewayAccount('telegram', instance.accountId); await state.connect(); checking = true;
        const result = await work(state);
        const health: GatewayHealth = { instanceId, status: 'paused', reason: '', attempts: 0, updatedAt: Date.now() };
        this.statuses.set(instanceId, health); emit('gateway-health', { ...health }); return result;
      } catch (error) {
        if (checking && error instanceof Error && 'status' in error) throw error;
        throw Object.assign(new Error('Telegram setup could not be checked safely. Check storage and ownership, then reload setup.'), { status: 503 });
      } finally { await state.disconnect(); await release?.(); }
    });
    this.pending = task.then(() => {}, () => {}); return task;
  }

  checkTelegramSetup(instanceId: string): Promise<GatewayTelegramSetup> {
    return this.telegramSetupTask(instanceId, (state) => checkTelegramSetup(state));
  }
  switchTelegramToPolling(instanceId: string, body: unknown): Promise<GatewayTelegramSetup> {
    return this.telegramSetupTask(instanceId, (state) => switchTelegramToPolling(state, body));
  }

  pairWhatsApp(instanceId: string, body: unknown): Promise<GatewayWhatsAppSetup> {
    return this.whatsAppSetupTask(instanceId, (inbox) => pairWhatsApp(inbox, body));
  }
  replaceWhatsAppPairing(instanceId: string, body: unknown): Promise<GatewayWhatsAppSetup> {
    return this.whatsAppSetupTask(instanceId, (inbox) => replaceWhatsAppPairing(inbox, body));
  }
  checkWhatsAppSetup(instanceId: string): Promise<GatewayWhatsAppCheck> {
    return this.whatsAppSetupTask(instanceId, (inbox) => checkWhatsAppSetup(inbox));
  }
  finishWhatsAppPairing(instanceId: string, body: unknown): Promise<GatewayWhatsAppSetup> {
    return this.whatsAppSetupTask(instanceId, (inbox) => finishWhatsAppPairing(inbox, body));
  }
  reviewWhatsAppPairing(instanceId: string, body: unknown): Promise<GatewayWhatsAppSetup> {
    return this.whatsAppSetupTask(instanceId, (inbox) => reviewWhatsAppPairing(inbox, body));
  }
  inspectWhatsAppRecovery(instanceId: string): Promise<GatewayWhatsAppRecovery> {
    return this.whatsAppSetupTask(instanceId, (inbox) => inspectWhatsAppRecovery(inbox));
  }
  reviewWhatsAppRecovery(instanceId: string, body: unknown): Promise<GatewayWhatsAppRecovery> {
    return this.whatsAppSetupTask(instanceId, (inbox) => reviewWhatsAppRecovery(inbox, body));
  }

  restoreWhatsAppRecovery(instanceId: string, body: unknown): Promise<GatewayWhatsAppRecovery> {
    return this.whatsAppSetupTask(instanceId, (inbox) => restoreWhatsAppRecovery(inbox, body));
  }

  reviewWhatsAppSender(instanceId: string, body: unknown): Promise<GatewayWhatsAppSenders> {
    return this.whatsAppSetupTask(instanceId, (inbox) => inbox.reviewWhatsAppSender(body));
  }

  async selectDocuments(instanceId: string, eventId: string, body: unknown): Promise<void> {
    const worker = this.workers.get(instanceId);
    if (!worker) throw Object.assign(new Error('Connect this gateway before selecting files.'), { status: 400 });
    await worker.selectDocuments(eventId, body);
  }

  changeDocument(instanceId: string, eventId: string, index: number, action: 'retry' | 'skip'): void {
    const worker = this.workers.get(instanceId);
    if (!worker) throw Object.assign(new Error('Connect this gateway before changing its files.'), { status: 400 });
    worker.changeDocument(eventId, index, action);
  }

  start(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (!this.listening) { bus.on('event', this.changed); this.listening = true; }
    return Promise.all(listGatewayInstances().map((instance) => this.reconnect(instance.id))).then(() => {});
  }

  reconnect(instanceId: string): Promise<void> {
    const task = this.pending.then(async () => {
      if (this.closed) return;
      await this.workers.get(instanceId)?.stop();
      this.workers.delete(instanceId);
      let instance;
      try { instance = getGatewayInstance(instanceId); }
      catch { this.statuses.delete(instanceId); return; }
      const publish = (health: GatewayHealth) => {
        this.statuses.set(instanceId, health);
        emit('gateway-health', { ...health });
      };
      if (!instance.enabled || !gatewayPlatformAvailable(instance.platform)) {
        publish({ instanceId, status: instance.enabled ? 'needs-setup' : 'paused', reason: instance.enabled ? 'This platform is not available yet.' : '', attempts: 0, updatedAt: Date.now() });
        return;
      }
      const worker = this.worker(instanceId, publish);
      this.workers.set(instanceId, worker);
      void worker.start().catch(() => publish({ instanceId, status: 'needs-setup', reason: 'This gateway could not stop or reconnect safely. Restart Athena before retrying.', attempts: 0, updatedAt: Date.now() }));
    });
    this.pending = task.catch(() => {
      const health: GatewayHealth = { instanceId, status: 'needs-setup', reason: 'This gateway could not stop safely. Restart Athena before retrying.', attempts: 0, updatedAt: Date.now() };
      this.statuses.set(instanceId, health);
      emit('gateway-health', { ...health });
    });
    return this.pending;
  }

  async stop(): Promise<void> {
    this.closed = true;
    bus.off('event', this.changed);
    await this.pending;
    await Promise.all([...this.workers.values()].map((worker) => worker.stop()));
    this.workers.clear();
  }
}
