// The Overview page's picture of every project: its agents, teams, the Brain and the board tasks being worked on, each
// working, needing you or idle, and when it last changed. Names and times only: no chat contents. Each project is read
// in its own withProject, whichever project is open.
import fs from 'node:fs';
import path from 'node:path';
import { activeProject, agents, bus, listProjects, questions, withProject, workflows } from './store.ts';
import { dataPath } from './util.ts';
import { activeRuns } from './engines/index.ts';
import { listTerminals } from './terminals.ts';
import { listApprovals } from './approvals.ts';
import { listBriefs } from './briefs.ts';
import { isTeamBusy } from './teams.ts';
import { projectCards } from './taskboard.ts';
import type {
  ActiveRun,
  Approval,
  OverviewData,
  OverviewProject,
  OverviewSession,
  Project,
  Terminal,
} from '../shared/types.ts';

const mtime = (file: string): number => {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
};
const cut = (text: string, n = 80) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

// Each agent's newest chat, read from the files once and then kept current by the chats' saves (the Overview is read
// again after every change: looking at every chat file each time would add up). Read again after a while, for
// files changed outside the dashboard.
const NEWEST_FOR = 5 * 60_000;
const newest = new Map<string, { chatId?: string; at: number; read: number }>();
const isPrivate = (chatId: string) => chatId.startsWith('private-chat-');
bus.on('event', (e) => {
  if (e.type !== 'chats') return;
  const { agentId, chatId, project, removed } = e as {
    agentId?: unknown;
    chatId?: unknown;
    project?: unknown;
    removed?: unknown;
  };
  if (typeof agentId !== 'string' || typeof project !== 'string') return;
  const key = `${project}/${agentId}`;
  if (removed || typeof chatId !== 'string') newest.delete(key);
  else if (!isPrivate(chatId) && newest.has(key)) newest.set(key, { chatId, at: e.ts, read: newest.get(key)!.read });
});

/** An agent's newest chat (not the private ones gateways and board tasks keep) and when it changed. */
function newestChat(projectId: string, agentId: string): { chatId?: string; at: number } {
  const key = `${projectId}/${agentId}`;
  const known = newest.get(key);
  if (known && Date.now() - known.read < NEWEST_FOR) return known;
  const found = newestChatOnDisk(projectId, agentId);
  newest.set(key, { ...found, read: Date.now() });
  return found;
}

/** The same, from the files' times. */
function newestChatOnDisk(projectId: string, agentId: string): { chatId?: string; at: number } {
  const dir = dataPath('projects', projectId, 'chats', agentId);
  let best: { chatId?: string; at: number } = { at: 0 };
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return best;
  }
  for (const name of names) {
    if (!name.endsWith('.json') || isPrivate(name)) continue;
    const at = mtime(path.join(dir, name));
    if (at > best.at) best = { chatId: name.slice(0, -5), at };
  }
  return best;
}

/** What is running, waiting for approval and open as a terminal, across every project (read once per overview). */
interface Live {
  runs: ActiveRun[];
  approvals: Approval[];
  terminals: Terminal[];
}

function projectOverview(p: Project, open: Project, live: Live): OverviewProject {
  return withProject(p, () => {
    const runs = live.runs.filter((r) => (r.projectId || open.id) === p.id);
    // (approvals made before they said their project belong to the one open now)
    const approvals = live.approvals.filter((a) => (a.projectId || open.id) === p.id);
    const waiting = questions.list().filter((q) => q.status === 'waiting');
    const stuck = listBriefs(p.id).filter((b) => b.status === 'blocked' || b.status === 'stuck');
    const sessions: OverviewSession[] = [];

    for (const a of agents.list()) {
      const approval = approvals.find((x) => x.agentId === a.id);
      const question = waiting.find((q) => q.agentId === a.id && !q.teamId);
      const brief = stuck.find((b) => b.kind === 'agent' && b.targetId === a.id);
      const why = approval
        ? `Approval: ${approval.title}`
        : question
          ? `Question: ${question.question}`
          : brief
            ? brief.summary || 'Its work stopped for you'
            : '';
      const chat = newestChat(p.id, a.id);
      sessions.push({
        kind: 'agent',
        id: a.id,
        name: a.name,
        ...(a.emoji ? { emoji: a.emoji } : {}),
        ...(a.color ? { color: a.color } : {}),
        engine: a.engine,
        status: why ? 'needs-you' : runs.some((r) => r.agentId === a.id) ? 'working' : 'idle',
        ...(why ? { why: cut(why) } : {}),
        updatedAt: chat.at,
        ...(chat.chatId ? { chatId: chat.chatId } : {}),
      });
    }

    for (const t of workflows.list()) {
      const question = waiting.find((q) => q.teamId === t.id);
      const brief = stuck.find((b) => b.kind === 'team' && b.targetId === t.id);
      const why = question
        ? `Question: ${question.question}`
        : brief
          ? brief.summary || 'Its work stopped for you'
          : '';
      sessions.push({
        kind: 'team',
        id: t.id,
        name: t.name,
        status: why ? 'needs-you' : isTeamBusy(t.id) ? 'working' : 'idle',
        ...(why ? { why: cut(why) } : {}),
        updatedAt: mtime(dataPath('projects', p.id, 'teamchats', `${t.id}.json`)),
      });
    }

    // the Brain: its own approvals (installing a skill, say) need you
    const brainAsks = approvals.find((x) => !x.agentId);
    sessions.push({
      kind: 'brain',
      id: 'brain',
      name: 'The Brain',
      status: brainAsks ? 'needs-you' : 'idle',
      ...(brainAsks ? { why: cut(`Approval: ${brainAsks.title}`) } : {}),
      updatedAt: mtime(dataPath('projects', p.id, 'brain-chat.json')),
    });

    // the terminals opened in this project (running, or ended with their code)
    for (const t of live.terminals.filter((x) => (x.projectId || open.id) === p.id)) {
      sessions.push({
        kind: 'terminal',
        id: t.id,
        name: t.title,
        status: 'idle',
        ...(t.exited ? { ended: true, why: `Ended (exit code ${t.exitCode ?? '?'})` } : {}),
        updatedAt: t.createdAt,
      });
    }

    // board tasks an agent or team works on, or whose work waits for you
    const board = projectCards(p.id);
    for (const t of board) {
      const state = t.work?.state;
      if (!state || !['starting', 'working', 'waiting', 'needs-review'].includes(state)) continue;
      const why =
        state === 'waiting'
          ? `${t.workerName || 'Its worker'} needs your OK for a step`
          : state === 'needs-review'
            ? 'Its work needs a look'
            : '';
      sessions.push({
        kind: 'task',
        id: t.id,
        number: t.number,
        name: t.title,
        status: why ? 'needs-you' : 'working',
        ...(why ? { why } : {}),
        updatedAt: t.updatedAt,
      });
    }

    return {
      id: p.id,
      name: p.name,
      sessions,
      working: sessions.filter((s) => s.status === 'working').length,
      needsYou: sessions.filter((s) => s.status === 'needs-you').length,
      boardOpen: board.filter((t) => t.status !== 'done').length,
    };
  });
}

/** Every project at a glance, the open one first. */
export function overview(): OverviewData {
  const open = activeProject();
  const list = listProjects();
  const live: Live = { runs: activeRuns(), approvals: listApprovals(), terminals: listTerminals() };
  const projects = [...list.filter((p) => p.id === open.id), ...list.filter((p) => p.id !== open.id)].map((p) =>
    projectOverview(p, open, live),
  );
  return { active: open.id, projects };
}
