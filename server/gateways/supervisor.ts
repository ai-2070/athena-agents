import type { GatewayHealth, GatewayReconciliation, GatewayStatus, ServerEvent } from '../../shared/types.ts';
import { gatewayNeedsReview } from '../../shared/gateways.ts';
import { bus, emit, listProjects } from '../store.ts';
import { gatewayInboxHistory } from './inbox.ts';
import { getGatewayInstance, listGatewayInstances } from './instances.ts';
import { TelegramGatewayWorker } from './worker.ts';

/** Settings changes restart only their instance; transport failures never expose raw SDK errors. */
export class GatewaySupervisor {
  private readonly workers = new Map<string, TelegramGatewayWorker>();
  private readonly statuses = new Map<string, GatewayHealth>();
  private readonly reviews = new Map<string, number | null>();
  private readonly changedInboxes = new Set<string>();
  private pending: Promise<void> = Promise.resolve();
  private closed = false;
  private listening = false;
  private readonly worker: (instanceId: string, health: (value: GatewayHealth) => void) => TelegramGatewayWorker;

  constructor(worker = (instanceId: string, health: (value: GatewayHealth) => void) => new TelegramGatewayWorker(instanceId, { health })) {
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
          : this.statuses.get(instance.id)?.status ?? (instance.platform === 'telegram' ? 'connecting' : 'needs-setup'),
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

  reconcile(instanceId: string, eventId: string): GatewayReconciliation {
    const worker = this.workers.get(instanceId);
    if (!worker) throw Object.assign(new Error('Connect this gateway before checking its saved work.'), { status: 400 });
    return worker.reconcile(eventId);
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
      if (!instance.enabled || instance.platform !== 'telegram') {
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
