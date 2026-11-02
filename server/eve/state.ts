import crypto from 'node:crypto';
import { agents, chats, listProjects, withProject, workflows } from '../store.ts';
import { teamWorkServers } from '../mcp.ts';
import { listFiles, readPlain, writeJSON } from '../util.ts';
import { privateDataPath } from '../private.ts';
import { privateTeamDefinition } from '../private-conversations.ts';
import { readExecution } from '../execution.ts';
import { activeTeamAssignment } from '../teamwork.ts';
import { EVE_GENERATION } from './version.ts';
import type { Agent, Chat, EveModelCharge, EveRunRecord, EveRunStatus, EveSessionBinding, Project, RunEvent } from '../../shared/types.ts';

const idOk = (id: string) => /^[a-zA-Z0-9_-]{1,120}$/.test(id);
function privatePath(...parts: string[]): string {
  return privateDataPath('runtime', 'eve', ...parts);
}
const bindingPath = (id: string) => privatePath('bindings', `${id}.json`);
const runPath = (id: string) => privatePath('runs', `${id}.json`);

export function readBinding(id: string): EveSessionBinding | null {
  return idOk(id) ? readPlain<EveSessionBinding | null>(bindingPath(id), null) : null;
}

export function sessionBindings(): EveSessionBinding[] {
  return listFiles(privatePath('bindings'), (name) => name.endsWith('.json'))
    .map((name) => readBinding(name.slice(0, -5))).filter((item): item is EveSessionBinding => !!item);
}

export function conversationBinding(projectId: string, agentId: string, chatId: string, generation: string): EveSessionBinding | null {
  const interrupted = new Set(eveRuns().filter((run) => ['failed', 'stopped', 'interrupted'].includes(run.status)).map((run) => run.bindingId));
  return listFiles(privatePath('bindings'), (name) => name.endsWith('.json')).map((name) => readBinding(name.slice(0, -5)))
    .filter((item): item is EveSessionBinding => !!item && !item.retiring && !item.retired && !item.runtimeEnded && !interrupted.has(item.id) && item.projectId === projectId && item.agentId === agentId && item.chatId === chatId && item.generation === generation)
    .sort((a, b) => b.createdAt - a.createdAt)[0] || null;
}

export function invalidateConversation(projectId: string, chatId: string): void {
  for (const name of listFiles(privatePath('bindings'), (file) => file.endsWith('.json'))) {
    const binding = readBinding(name.slice(0, -5));
    if (!binding || binding.projectId !== projectId || binding.chatId !== chatId || binding.retired) continue;
    const working = activeEveRuns().some((run) => run.bindingId === binding.id);
    writeJSON(bindingPath(binding.id), { ...binding, retiring: true, retired: !working });
  }
}

/** Accepting a receipt records identities even if Stop arrived while the request was in flight. */
export function recordAdmissionReceipt(id: string, sessionId: string, deliveryId: string, imported: string[]): void {
  const run = readRun(id);
  const binding = run && readBinding(run.bindingId);
  if (!run || !binding || !sessionId || !deliveryId) throw new Error('Invalid Eve admission receipt.');
  if (binding.sessionId && binding.sessionId !== sessionId) throw new Error('The Eve session changed its binding.');
  if (run.deliveryId && run.deliveryId !== deliveryId) throw new Error('The Eve delivery changed its run.');
  writeJSON(bindingPath(binding.id), { ...binding, sessionId, imported: [...new Set([...(binding.imported || []), ...imported])] });
  setRunStatus(id, run.status === 'queued' ? 'running' : run.status, deliveryId);
}

export function bindSession(agent: Agent, chat: Chat, project: Project, generation: string): EveSessionBinding {
  if (chat.agentId !== agent.id) throw new Error('The chat does not belong to this agent.');
  if (!generation) throw new Error('An Eve generation is required.');
  const binding: EveSessionBinding = { id: crypto.randomBytes(32).toString('hex'), agentId: agent.id, chatId: chat.id, projectId: project.id, teamId: chat.teamId || null, ...(chat.conversationId ? { conversationId: chat.conversationId } : {}), generation, runtimeVersion: EVE_GENERATION, sessionId: null, retired: false, createdAt: Date.now() };
  return writeJSON(bindingPath(binding.id), binding);
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
  return writeJSON(bindingPath(id), { ...binding, sessionId });
}

export function retireSession(id: string): void {
  const binding = readBinding(id);
  if (binding) writeJSON(bindingPath(id), { ...binding, retired: true });
}

export function markSessionEnded(id: string): void {
  const binding = readBinding(id);
  if (binding) writeJSON(bindingPath(id), { ...binding, runtimeEnded: true });
}

export function readRun(id: string): EveRunRecord | null {
  return idOk(id) ? readPlain<EveRunRecord | null>(runPath(id), null) : null;
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
  if (activeEveRuns().some((run) => run.bindingId === bindingId)) throw new Error('This Eve conversation already has work in progress.');
  return writeJSON(runPath(id), { id, bindingId, depth, parentRunId, status: 'queued', configurationVersions: [], deliveryId: null, turnId: null, cursor: null, events: [], createdAt: at, updatedAt: at } satisfies EveRunRecord);
}

export function recordConfiguration(id: string, definition: unknown): void {
  const run = readRun(id);
  if (!run) throw new Error('No such Eve run.');
  if (terminal(run.status)) throw new Error('A finished Eve run cannot change configuration.');
  const version = crypto.createHash('sha256').update(JSON.stringify(definition)).digest('hex');
  if (run.configurationVersions.at(-1) !== version) writeJSON(runPath(id), { ...run, configurationVersions: [...run.configurationVersions, version], updatedAt: Date.now() });
}

export function recordLimit(id: string, limitReason: string): void {
  const run = readRun(id);
  if (!run || terminal(run.status)) throw new Error('This Eve run is no longer active.');
  if (!run.limitReason) writeJSON(runPath(id), { ...run, limitReason, updatedAt: Date.now() });
}

export function recordCostBaseline(id: string, cost: number): number {
  const run = readRun(id);
  if (!run || terminal(run.status) || !Number.isFinite(cost) || cost < 0) throw new Error('Invalid Eve usage baseline.');
  if (run.costBaseline !== undefined) return run.costBaseline;
  writeJSON(runPath(id), { ...run, costBaseline: cost, updatedAt: Date.now() });
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
  writeJSON(runPath(id), { ...run, charges: [...(run.charges || []), charge], updatedAt: Date.now() });
}

const terminal = (status: EveRunStatus) => ['completed', 'failed', 'stopped', 'interrupted'].includes(status);

export function setRunStatus(id: string, status: EveRunStatus, deliveryId?: string): EveRunRecord {
  const run = readRun(id);
  if (!run) throw new Error('No such Eve run.');
  if (terminal(run.status) && status !== run.status) throw new Error('A finished Eve run cannot start again.');
  if (deliveryId && run.deliveryId && run.deliveryId !== deliveryId) throw new Error('An Eve run cannot change its delivery.');
  return writeJSON(runPath(id), { ...run, status, ...(deliveryId ? { deliveryId } : {}), updatedAt: Date.now() });
}

export function activeEveRuns(): EveRunRecord[] {
  return eveRuns().filter((run) => !terminal(run.status));
}

export function eveRuns(): EveRunRecord[] {
  return listFiles(privatePath('runs'), (name) => name.endsWith('.json'))
    .map((name) => readRun(name.slice(0, -5))).filter((run): run is EveRunRecord => !!run);
}

export function recordTurn(id: string, turnId: string): void {
  const run = readRun(id);
  if (!run || terminal(run.status)) throw new Error('This Eve run is no longer active.');
  if (run.turnId && run.turnId !== turnId) throw new Error('An Eve run cannot change its turn.');
  if (!run.turnId) writeJSON(runPath(id), { ...run, turnId, updatedAt: Date.now() });
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
  writeJSON(runPath(id), { ...run, cursor, events: [...run.events, ...saved], ...(partId && text ? { textParts: { ...run.textParts, [partId]: text.id } } : {}), updatedAt: Date.now() });
  return saved;
}

export function markProjected(id: string, count: number): void {
  const run = readRun(id);
  if (!run || !Number.isSafeInteger(count) || count < (run.projected || 0) || count > run.events.length) throw new Error('Invalid Eve transcript position.');
  writeJSON(runPath(id), { ...run, projected: count });
}

export function settleRun(id: string, status: 'completed' | 'failed' | 'stopped' | 'interrupted', answer: string, error?: string): void {
  const run = readRun(id);
  if (!run) throw new Error('No such Eve run.');
  if (terminal(run.status)) return;
  writeJSON(runPath(id), { ...run, status, answer, pendingTerminal: undefined, ...(error ? { error } : {}), endedAt: Date.now(), updatedAt: Date.now() });
  if (readBinding(run.bindingId)?.retiring) retireSession(run.bindingId);
}

export function stageTerminal(id: string, pendingTerminal: NonNullable<EveRunRecord['pendingTerminal']>): void {
  const run = readRun(id);
  if (!run || terminal(run.status)) return;
  writeJSON(runPath(id), { ...run, pendingTerminal });
}
