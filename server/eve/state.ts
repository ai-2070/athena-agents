import crypto from 'node:crypto';
import { agents, chats, listProjects, withProject, workflows } from '../store.ts';
import { teamWorkServers } from '../mcp.ts';
import { listFiles } from '../util.ts';
import { privateDataPath } from '../private.ts';
import { privateTeamDefinition } from '../private-conversations.ts';
import { readExecution } from '../execution.ts';
import { activeTeamAssignment } from '../teamwork.ts';
import { EVE_GENERATION } from './version.ts';
import { RecordFiles } from './records.ts';
import { eveCounts } from './counts.ts';
import { forgetRunSnapshot } from './snapshot.ts';
import type { Agent, Chat, EveModelCharge, EveRunRecord, EveRunStatus, EveSessionBinding, EveSteer, Project, RunEvent } from '../../shared/types.ts';

const idOk = (id: string) => /^[a-zA-Z0-9_-]{1,120}$/.test(id);
// messages Eve took that its turn didn't (yet), and no run follows
// (one still being sent counts too: Eve may have it already)
const unfollowed = (run: Pick<EveRunRecord, 'steers' | 'joinedDeliveries'>): EveSteer[] => (run.steers || []).filter((steer) => !(steer.deliveryId && run.joinedDeliveries?.includes(steer.deliveryId)) && !steer.adoptedBy && !steer.dropped);
function privatePath(...parts: string[]): string {
  return privateDataPath('runtime', 'eve', ...parts);
}
const bindingPath = (id: string) => privatePath('bindings', `${id}.json`);
const runPath = (id: string) => privatePath('runs', `${id}.json`);

/** What listings and the bridge's per-call checks need from a run, without its events. */
export type EveRunSummary = Pick<EveRunRecord, 'id' | 'bindingId' | 'depth' | 'parentRunId' | 'deliveryId' | 'status' | 'projected' | 'costBaseline' | 'endedAt' | 'updatedAt'> & { events: number; late: number };

// Bindings are small: the summary is the whole record.
const bindingFiles = new RecordFiles<EveSessionBinding, EveSessionBinding>({ maxBytes: 0, summarize: (binding) => binding });
const runFiles = new RecordFiles<EveRunRecord, EveRunSummary>({
  maxBytes: 24 * 1024 * 1024,
  summarize: (run) => ({ id: run.id, bindingId: run.bindingId, depth: run.depth, parentRunId: run.parentRunId, deliveryId: run.deliveryId, status: run.status, projected: run.projected, costBaseline: run.costBaseline, endedAt: run.endedAt, updatedAt: run.updatedAt, events: Array.isArray(run.events) ? run.events.length : 0, late: unfollowed(run).length }),
  readFromDisk: () => { eveCounts.runReads++; },
});
const saveBinding = (binding: EveSessionBinding): EveSessionBinding => bindingFiles.write(bindingPath(binding.id), binding);

export function readBinding(id: string): EveSessionBinding | null {
  return idOk(id) ? bindingFiles.summary(bindingPath(id)) : null;
}

export function sessionBindings(): EveSessionBinding[] {
  return listFiles(privatePath('bindings'), (name) => name.endsWith('.json'))
    .map((name) => readBinding(name.slice(0, -5))).filter((item): item is EveSessionBinding => !!item);
}

export function conversationBinding(projectId: string, agentId: string, chatId: string, generation: string): EveSessionBinding | null {
  const interrupted = new Set(runSummaries().filter((run) => ['failed', 'stopped', 'interrupted'].includes(run.status)).map((run) => run.bindingId));
  return sessionBindings()
    .filter((item) => !item.retiring && !item.retired && !item.runtimeEnded && !interrupted.has(item.id) && item.projectId === projectId && item.agentId === agentId && item.chatId === chatId && item.generation === generation)
    .sort((a, b) => b.createdAt - a.createdAt)[0] || null;
}

export function invalidateConversation(projectId: string, chatId: string): void {
  const working = new Set(runSummaries().filter((run) => !terminal(run.status)).map((run) => run.bindingId));
  for (const binding of sessionBindings()) {
    if (binding.projectId !== projectId || binding.chatId !== chatId || binding.retired) continue;
    saveBinding({ ...binding, retiring: true, retired: !working.has(binding.id) });
  }
}

/** Accepting a receipt records identities even if Stop arrived while the request was in flight. */
export function recordAdmissionReceipt(id: string, sessionId: string, deliveryId: string, imported: string[]): void {
  const run = readRun(id);
  const binding = run && readBinding(run.bindingId);
  if (!run || !binding || !sessionId || !deliveryId) throw new Error('Invalid Eve admission receipt.');
  if (binding.sessionId && binding.sessionId !== sessionId) throw new Error('The Eve session changed its binding.');
  if (run.deliveryId && run.deliveryId !== deliveryId) throw new Error('The Eve delivery changed its run.');
  saveBinding({ ...binding, sessionId, imported: [...new Set([...(binding.imported || []), ...imported])] });
  setRunStatus(id, run.status === 'queued' ? 'running' : run.status, deliveryId);
}

export function bindSession(agent: Agent, chat: Chat, project: Project, generation: string): EveSessionBinding {
  if (chat.agentId !== agent.id) throw new Error('The chat does not belong to this agent.');
  if (!generation) throw new Error('An Eve generation is required.');
  const binding: EveSessionBinding = { id: crypto.randomBytes(32).toString('hex'), agentId: agent.id, chatId: chat.id, projectId: project.id, teamId: chat.teamId || null, ...(chat.conversationId ? { conversationId: chat.conversationId } : {}), generation, runtimeVersion: EVE_GENERATION, sessionId: null, retired: false, createdAt: Date.now() };
  return saveBinding(binding);
}

export function sessionContext(id: string): { binding: EveSessionBinding; project: Project; agent: Agent; chat: Chat } {
  const context = transcriptContext(id);
  if (context.binding.retired) throw new Error('This Eve session binding is not active.');
  if (context.binding.runtimeVersion !== EVE_GENERATION) throw new Error('Eve was updated. Check the saved results before starting a fresh session.');
  return withProject(context.project, () => {
    const { binding } = context;
    let agent: Agent = { ...context.agent, engine: 'eve' };
    const receipt = readExecution().runs.find((run) => run.projectId === binding.projectId && run.agentId === agent.id && run.chatId === binding.chatId && run.status === 'running');
    if (binding.teamId) {
      const team = workflows.get(binding.teamId) || privateTeamDefinition(binding.teamId);
      if (!team || !team.members.includes(agent.id)) throw new Error('The agent no longer belongs to this team.');
      const assignment = receipt && activeTeamAssignment(receipt, team.id);
      agent = { ...agent, toolGroups: [...new Set([...agent.toolGroups, ...(team.access?.toolGroups || [])])], mcpServers: teamWorkServers(agent.mcpServers, team.access?.mcpServers || []), _teamSkills: [...new Set([...(team.skills || []), ...(assignment?.skills || [])])] };
    }
    if (!binding.teamId && receipt?.workAccess) {
      const extra = receipt.workAccess;
      agent = { ...agent, toolGroups: [...new Set([...agent.toolGroups, ...(extra.toolGroups || [])])], mcpServers: teamWorkServers(agent.mcpServers, extra.mcpServers || []), _teamSkills: extra.skills || [] };
    }
    return { ...context, agent };
  });
}

/** Saved originals can be projected after Stop; this never grants execution permission. */
export function transcriptContext(id: string): { binding: EveSessionBinding; project: Project; agent: Agent; chat: Chat } {
  const binding = readBinding(id);
  if (!binding) throw new Error('This Eve session binding is not active.');
  const project = listProjects().find((item) => item.id === binding.projectId);
  if (!project) throw new Error('The session project no longer exists.');
  return withProject(project, () => {
    const agent = agents.get(binding.agentId);
    const chat = chats.get(binding.agentId, binding.chatId);
    if (!agent || !chat || chat.agentId !== agent.id || (chat.teamId || null) !== binding.teamId || (chat.conversationId || null) !== (binding.conversationId || null)) throw new Error('The session agent or conversation no longer exists.');
    return { binding, project, agent, chat };
  });
}

export function attachSession(id: string, sessionId: string): EveSessionBinding {
  const { binding } = sessionContext(id);
  if (binding.sessionId && binding.sessionId !== sessionId) throw new Error('This binding already belongs to another Eve session.');
  if (!sessionId) throw new Error('An Eve session ID is required.');
  return saveBinding({ ...binding, sessionId });
}

export function retireSession(id: string): void {
  const binding = readBinding(id);
  if (binding) saveBinding({ ...binding, retired: true });
}

export function markSessionEnded(id: string): void {
  const binding = readBinding(id);
  if (binding) saveBinding({ ...binding, runtimeEnded: true });
}

export const runEnded = (status: EveRunStatus): boolean => ['completed', 'failed', 'stopped', 'interrupted'].includes(status);
const terminal = runEnded;

// The run each binding is working on, so a bridge call checks one file instead of listing every run.
const workingRuns = new Map<string, string>();
// The definition each working run last recorded, so an unchanged one is neither hashed nor saved again.
const configurations = new Map<string, string>();

function forgetRunMemory(run: Pick<EveRunRecord, 'id' | 'bindingId'>): void {
  if (workingRuns.get(run.bindingId) === run.id) workingRuns.delete(run.bindingId);
  configurations.delete(run.id);
  forgetRunSnapshot(run.id);
}

function saveRun(run: EveRunRecord): EveRunRecord {
  runFiles.write(runPath(run.id), run);
  if (terminal(run.status)) forgetRunMemory(run);
  else workingRuns.set(run.bindingId, run.id);
  return run;
}

export function readRun(id: string): EveRunRecord | null {
  return idOk(id) ? runFiles.read(runPath(id)) : null;
}

/** A run without its events: enough for status checks, and kept in memory for every run. */
export function readRunSummary(id: string): EveRunSummary | null {
  return idOk(id) ? runFiles.summary(runPath(id)) : null;
}

const runIds = (): string[] => listFiles(privatePath('runs'), (name) => name.endsWith('.json')).map((name) => name.slice(0, -5));

/** Every saved run without its events; a file is read again only when it changed. */
export function runSummaries(): EveRunSummary[] {
  return runIds().map((id) => readRunSummary(id)).filter((run): run is EveRunSummary => !!run);
}

/** The binding's running or waiting run. The given or last known run is checked before listing them all. */
export function workingRunOf(bindingId: string, runId?: string): EveRunSummary | null {
  const working = (run: EveRunSummary | null): run is EveRunSummary => !!run && run.bindingId === bindingId && (run.status === 'running' || run.status === 'waiting');
  for (const id of [runId, workingRuns.get(bindingId)]) {
    const run = id ? readRunSummary(id) : null;
    if (working(run)) return run;
  }
  const found = runSummaries().find(working) || null;
  if (found) workingRuns.set(bindingId, found.id);
  return found;
}

export function beginRun(id: string, bindingId: string, depth = 0, parentRunId: string | null = null): EveRunRecord {
  if (!idOk(id)) throw new Error('Invalid Eve run ID.');
  sessionContext(bindingId);
  const existing = readRun(id);
  if (existing) {
    if (existing.bindingId !== bindingId || existing.depth !== depth || existing.parentRunId !== parentRunId) throw new Error('An Eve run cannot change ownership.');
    return existing;
  }
  const at = Date.now();
  if (runSummaries().some((run) => run.bindingId === bindingId && !terminal(run.status))) throw new Error('This Eve conversation already has work in progress.');
  return saveRun({ id, bindingId, depth, parentRunId, status: 'queued', configurationVersions: [], deliveryId: null, turnId: null, cursor: null, events: [], createdAt: at, updatedAt: at } satisfies EveRunRecord);
}

export function recordConfiguration(id: string, definition: unknown): void {
  const saved = readRunSummary(id);
  if (!saved) throw new Error('No such Eve run.');
  if (terminal(saved.status)) throw new Error('A finished Eve run cannot change configuration.');
  const text = JSON.stringify(definition);
  if (configurations.get(id) === text) return;
  const run = readRun(id);
  if (!run) throw new Error('No such Eve run.');
  const version = crypto.createHash('sha256').update(text).digest('hex');
  if (run.configurationVersions.at(-1) !== version) saveRun({ ...run, configurationVersions: [...run.configurationVersions, version], updatedAt: Date.now() });
  configurations.set(id, text);
}

export function recordLimit(id: string, limitReason: string): void {
  const run = readRun(id);
  if (!run || terminal(run.status)) throw new Error('This Eve run is no longer active.');
  if (!run.limitReason) saveRun({ ...run, limitReason, updatedAt: Date.now() });
}

export function recordCostBaseline(id: string, cost: number): number {
  const saved = readRunSummary(id);
  if (!saved || terminal(saved.status) || !Number.isFinite(cost) || cost < 0) throw new Error('Invalid Eve usage baseline.');
  if (saved.costBaseline !== undefined) return saved.costBaseline;
  const run = readRun(id);
  if (!run) throw new Error('Invalid Eve usage baseline.');
  saveRun({ ...run, costBaseline: cost, updatedAt: Date.now() });
  return cost;
}

export function recordCharge(id: string, charge: EveModelCharge): void {
  const run = readRun(id);
  if (!run || terminal(run.status)) throw new Error('This Eve run is no longer active.');
  const previous = run.charges?.find((item) => item.id === charge.id);
  if (previous) {
    if (JSON.stringify(previous) !== JSON.stringify(charge)) throw new Error('The saved model charge changed.');
    return;
  }
  saveRun({ ...run, charges: [...(run.charges || []), charge], updatedAt: Date.now() });
}

export function setRunStatus(id: string, status: EveRunStatus, deliveryId?: string): EveRunRecord {
  const run = readRun(id);
  if (!run) throw new Error('No such Eve run.');
  if (terminal(run.status) && status !== run.status) throw new Error('A finished Eve run cannot start again.');
  if (deliveryId && run.deliveryId && run.deliveryId !== deliveryId) throw new Error('An Eve run cannot change its delivery.');
  // Nothing changes, so nothing is written: a finished run keeps the time it ended.
  if (run.status === status && (!deliveryId || run.deliveryId === deliveryId)) return run;
  return saveRun({ ...run, status, ...(deliveryId ? { deliveryId } : {}), ...(terminal(status) && !run.endedAt ? { endedAt: Date.now() } : {}), updatedAt: Date.now() });
}

export function activeEveRuns(): EveRunRecord[] {
  return runIds().filter((id) => { const run = readRunSummary(id); return !!run && !terminal(run.status); })
    .map((id) => readRun(id)).filter((run): run is EveRunRecord => !!run && !terminal(run.status));
}

export function eveRuns(): EveRunRecord[] {
  return runIds().map((id) => readRun(id)).filter((run): run is EveRunRecord => !!run);
}

export function recordTurn(id: string, turnId: string): void {
  const run = readRun(id);
  if (!run || terminal(run.status)) throw new Error('This Eve run is no longer active.');
  if (run.turnId && run.turnId !== turnId) throw new Error('An Eve run cannot change its turn.');
  if (!run.turnId) saveRun({ ...run, turnId, updatedAt: Date.now() });
}

/** Commit before notifying listeners; a reconnect can replay these outputs by stable ID. */
export function recordEvents(id: string, cursor: { line: number; index: number }, events: RunEvent[], partId?: string): { id: string; event: RunEvent }[] {
  const run = readRun(id);
  if (!run) throw new Error('No such Eve run.');
  if (!Number.isSafeInteger(cursor.line) || !Number.isSafeInteger(cursor.index) || cursor.line < 0 || cursor.index < 0) throw new Error('Invalid Eve event position.');
  if (run.cursor && (cursor.line < run.cursor.line || cursor.line === run.cursor.line && cursor.index <= run.cursor.index)) return [];
  if (terminal(run.status)) throw new Error('A finished Eve run cannot accept new events.');
  const saved = events.map((event, index) => ({ id: `${cursor.line}:${cursor.index}:${index}`, event }));
  const text = saved.find((item) => item.event.kind === 'text');
  saveRun({ ...run, cursor, events: [...run.events, ...saved], ...(partId && text ? { textParts: { ...run.textParts, [partId]: text.id } } : {}), updatedAt: Date.now() });
  return saved;
}

export function markProjected(id: string, count: number): void {
  const run = readRun(id);
  if (!run || !Number.isSafeInteger(count) || count < (run.projected || 0) || count > run.events.length) throw new Error('Invalid Eve transcript position.');
  saveRun({ ...run, projected: count });
}

export function settleRun(id: string, status: 'completed' | 'failed' | 'stopped' | 'interrupted', answer: string, error?: string): void {
  const run = readRun(id);
  if (!run) throw new Error('No such Eve run.');
  if (terminal(run.status)) return;
  saveRun({ ...run, status, answer, pendingTerminal: undefined, ...(error ? { error } : {}), endedAt: Date.now(), updatedAt: Date.now() });
  if (readBinding(run.bindingId)?.retiring) retireSession(run.bindingId);
}

export function stageTerminal(id: string, pendingTerminal: NonNullable<EveRunRecord['pendingTerminal']>): void {
  const run = readRun(id);
  if (!run || terminal(run.status)) return;
  saveRun({ ...run, pendingTerminal });
}

// ---------- messages that join a running turn (server/eve/steer.ts) ----------
/** Saved before it is sent, so a restart knows Eve may have it. */
export function recordSteer(id: string, steer: EveSteer): void {
  const run = readRun(id);
  if (!run || terminal(run.status)) throw new Error('This Eve run is no longer working.');
  if (run.steers?.some((item) => item.id === steer.id)) return;
  saveRun({ ...run, steers: [...(run.steers || []), steer], updatedAt: Date.now() });
}

/** A steer's progress: delivered, joined the turn, followed by another run, or never sent. */
export function updateSteer(id: string, steerId: string, change: Pick<Partial<EveSteer>, 'deliveryId' | 'adoptedBy' | 'dropped'>): EveSteer | null {
  const run = readRun(id);
  const steer = run?.steers?.find((item) => item.id === steerId);
  if (!run || !steer) return null;
  const next = { ...steer, ...change };
  saveRun({ ...run, steers: run.steers!.map((item) => (item.id === steerId ? next : item)) });
  return next;
}

/** Another delivery the run's turn took in: a message sent while it worked. */
export function joinDelivery(id: string, deliveryId: string): void {
  const run = readRun(id);
  if (!run || run.joinedDeliveries?.includes(deliveryId)) return;
  saveRun({ ...run, joinedDeliveries: [...(run.joinedDeliveries || []), deliveryId] });
}

/** Whether the run's turn took this delivery in. */
export const joinedTurn = (id: string, deliveryId: string): boolean => !!readRun(id)?.joinedDeliveries?.includes(deliveryId);

/** Delivered messages the ended run's turn didn't take: Eve starts the next turn with the first. Not after
 *  Stop or a restart that interrupted it (the session went with them). */
export function lateSteers(id: string): EveSteer[] {
  const run = readRun(id);
  return run && (run.status === 'completed' || run.status === 'failed') ? unfollowed(run).filter((steer) => steer.deliveryId) : [];
}

/** The binding's last run ended with a message Eve starts its next turn with, before a run follows it. */
export function awaitingTakeover(bindingId: string): boolean {
  // (a minute at most after the turn ended, however long ago the message went: one a crash left unsent
  // never holds the conversation up)
  const recent = Date.now() - 60_000;
  return runSummaries().some((run) => run.bindingId === bindingId && run.late > 0 && (run.status === 'completed' || run.status === 'failed') && (run.endedAt || 0) > recent);
}

/** A run that follows a turn Eve already started (with a late steer's message): no input of its own to send. */
export function adoptRun(id: string, bindingId: string, deliveryId: string, depth = 0, parentRunId: string | null = null, steers: EveSteer[] = []): EveRunRecord {
  const run = beginRun(id, bindingId, depth, parentRunId);
  saveRun({ ...run, adopted: true, ...(steers.length ? { steers } : {}), updatedAt: Date.now() });
  return setRunStatus(id, 'running', deliveryId);
}

/** For retention: the run's own file. Its operations and admission are removed by their modules. */
export function removeRun(id: string): void {
  if (!idOk(id)) return;
  const run = readRunSummary(id);
  runFiles.remove(runPath(id));
  if (run) forgetRunMemory(run);
  else forgetRunSnapshot(id);
}
