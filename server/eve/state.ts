import crypto from 'node:crypto';
import { agents, chats, listProjects, withProject, workflows } from '../store.ts';
import { teamWorkServers } from '../mcp.ts';
import { DATA, dataPath, isInside, listFiles, readPlain, realTarget, writeJSON } from '../util.ts';
import type { Agent, Chat, EveRunRecord, EveRunStatus, EveSessionBinding, Project, RunEvent } from '../../shared/types.ts';

const idOk = (id: string) => /^[a-zA-Z0-9_-]{1,120}$/.test(id);
function privatePath(...parts: string[]): string {
  const file = dataPath('runtime', 'eve', ...parts);
  const root = realTarget(DATA);
  const target = realTarget(file);
  if (!root || !target || !isInside(root, target)) throw new Error('Eve metadata must stay under the data folder.');
  return file;
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
  const binding = readBinding(id);
  if (!binding || binding.retired) throw new Error('This Eve session binding is not active.');
  const project = listProjects().find((item) => item.id === binding.projectId);
  if (!project) throw new Error('The session project no longer exists.');
  return withProject(project, () => {
    let agent = agents.get(binding.agentId);
    const chat = chats.get(binding.agentId, binding.chatId);
    if (!agent || !chat || chat.agentId !== agent.id || (chat.teamId || null) !== binding.teamId) throw new Error('The session agent or conversation no longer exists.');
    if (binding.teamId) {
      const team = workflows.get(binding.teamId);
      if (!team || !team.members.includes(agent.id)) throw new Error('The agent no longer belongs to this team.');
      agent = { ...agent, toolGroups: [...new Set([...agent.toolGroups, ...(team.access?.toolGroups || [])])], mcpServers: teamWorkServers(agent.mcpServers, team.access?.mcpServers || []), _teamSkills: team.skills || [] };
    }
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
  return writeJSON(runPath(id), { id, bindingId, depth, parentRunId, status: 'queued', configurationVersions: [], deliveryId: null, cursor: null, events: [], createdAt: at, updatedAt: at } satisfies EveRunRecord);
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
  return listFiles(privatePath('runs'), (name) => name.endsWith('.json'))
    .map((name) => readRun(name.slice(0, -5))).filter((run): run is EveRunRecord => !!run && !terminal(run.status));
}

/** Commit before notifying listeners; a reconnect can replay these outputs by stable ID. */
export function recordEvents(id: string, cursor: { line: number; index: number }, events: RunEvent[]): { id: string; event: RunEvent }[] {
  const run = readRun(id);
  if (!run) throw new Error('No such Eve run.');
  if (!Number.isSafeInteger(cursor.line) || !Number.isSafeInteger(cursor.index) || cursor.line < 0 || cursor.index < 0) throw new Error('Invalid Eve event position.');
  if (run.cursor && (cursor.line < run.cursor.line || cursor.line === run.cursor.line && cursor.index <= run.cursor.index)) return [];
  if (terminal(run.status)) throw new Error('A finished Eve run cannot accept new events.');
  const saved = events.map((event, index) => ({ id: `${cursor.line}:${cursor.index}:${index}`, event }));
  writeJSON(runPath(id), { ...run, cursor, events: [...run.events, ...saved], updatedAt: Date.now() });
  return saved;
}
