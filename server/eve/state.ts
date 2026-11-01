import crypto from 'node:crypto';
import { agents, chats, listProjects, withProject, workflows } from '../store.ts';
import { teamWorkServers } from '../mcp.ts';
import { listFiles, readPlain, writeJSON } from '../util.ts';
import { privateDataPath } from '../private.ts';
import type { Agent, Chat, EveRunRecord, EveRunStatus, EveSessionBinding, Project, RunEvent } from '../../shared/types.ts';

const idOk = (id: string) => /^[a-zA-Z0-9_-]{1,120}$/.test(id);
function privatePath(...parts: string[]): string {
  return privateDataPath('runtime', 'eve', ...parts);
}
const bindingPath = (id: string) => privatePath('bindings', `${id}.json`);
const runPath = (id: string) => privatePath('runs', `${id}.json`);

export function readBinding(id: string): EveSessionBinding | null {
  return idOk(id) ? readPlain<EveSessionBinding | null>(bindingPath(id), null) : null;
}

export function bindSession(agent: Agent, chat: Chat, project: Project, generation: string): EveSessionBinding {
  if (chat.agentId !== agent.id) throw new Error('The chat does not belong to this agent.');
  if (!generation) throw new Error('An Eve generation is required.');
  const binding: EveSessionBinding = { id: crypto.randomBytes(32).toString('hex'), agentId: agent.id, chatId: chat.id, projectId: project.id, teamId: chat.teamId || null, generation, sessionId: null, retired: false, createdAt: Date.now() };
  return writeJSON(bindingPath(binding.id), binding);
}

export function sessionContext(id: string): { binding: EveSessionBinding; project: Project; agent: Agent; chat: Chat } {
  const context = transcriptContext(id);
  if (context.binding.retired) throw new Error('This Eve session binding is not active.');
  return withProject(context.project, () => {
    const { binding } = context;
    let { agent } = context;
    if (binding.teamId) {
      const team = workflows.get(binding.teamId);
      if (!team || !team.members.includes(agent.id)) throw new Error('The agent no longer belongs to this team.');
      agent = { ...agent, toolGroups: [...new Set([...agent.toolGroups, ...(team.access?.toolGroups || [])])], mcpServers: teamWorkServers(agent.mcpServers, team.access?.mcpServers || []), _teamSkills: team.skills || [] };
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
    if (!agent || !chat || chat.agentId !== agent.id || (chat.teamId || null) !== binding.teamId) throw new Error('The session agent or conversation no longer exists.');
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
}

export function stageTerminal(id: string, pendingTerminal: NonNullable<EveRunRecord['pendingTerminal']>): void {
  const run = readRun(id);
  if (!run || terminal(run.status)) return;
  writeJSON(runPath(id), { ...run, pendingTerminal });
}
