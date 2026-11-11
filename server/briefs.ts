// Work the Brain handed to teams and agents, per project, so it can follow up and see what is open.
import { activeProject, emit, questions } from './store.ts';
import { readJSON, writeJSON, dataPath, uid } from './util.ts';
import { showsGoal } from '../shared/commands.ts';
import type { BrainBrief } from '../shared/types.ts';

// Keep unresolved assignments as well as the latest finished ones.
const KEEP = 40;
const file = (pid: string) => dataPath('projects', pid, 'brain-briefs.json');

export function listBriefs(pid = activeProject().id): BrainBrief[] {
  return readJSON<{ briefs: BrainBrief[] }>(file(pid), { briefs: [] }).briefs;
}

function save(pid: string, list: BrainBrief[]) {
  const closed = list.filter((b) => !['open', 'blocked', 'stuck'].includes(b.status));
  const drop = new Set(closed.slice(0, Math.max(0, closed.length - KEEP)));
  writeJSON(file(pid), { briefs: list.filter((b) => !drop.has(b)) });
}

// Open chats show a goal (and its follow-ups) as it changes.
const told = (b: BrainBrief, pid: string) => emit('brief', { projectId: pid, brief: b });

// Work in another chat is independent, even when the same agent owns both.
const sameWork = (x: BrainBrief, b: Omit<BrainBrief, 'id' | 'followUps' | 'status'>) =>
  x.kind === b.kind && x.targetId === b.targetId && (b.kind === 'team' || x.chatId === b.chatId);

/** A new brief. Older open ones to the same team or agent are replaced by it. */
export function addBrief(b: Omit<BrainBrief, 'id' | 'followUps' | 'status'>, pid = activeProject().id): BrainBrief {
  const replaced: BrainBrief[] = [];
  const list = listBriefs(pid).map((x) => {
    if (x.status !== 'open' || !sameWork(x, b)) return x;
    const y = { ...x, status: 'replaced' as const, updatedAt: Date.now() };
    replaced.push(y);
    return y;
  });
  const brief: BrainBrief = { ...b, id: uid('bf'), followUps: 0, status: 'open' };
  save(pid, [...list, brief]);
  for (const x of replaced) told(x, pid);
  told(brief, pid);
  return brief;
}

export function updateBrief(id: string, patch: Partial<BrainBrief>, pid = activeProject().id): BrainBrief | null {
  const list = listBriefs(pid);
  const at = list.findIndex((x) => x.id === id);
  if (at === -1) return null;
  list[at] = { ...list[at], ...patch, id, updatedAt: Date.now() };
  save(pid, list);
  told(list[at], pid);
  return list[at];
}

/** The open goal in an agent's chat, or a team's: yours, or work the agent, lead or Brain recognized. */
export const openGoal = (
  kind: BrainBrief['kind'],
  targetId: string,
  chatId: string | null = null,
  pid = activeProject().id,
): BrainBrief | null =>
  listBriefs(pid).findLast(
    (x) =>
      x.status === 'open' &&
      showsGoal(x) &&
      x.kind === kind &&
      x.targetId === targetId &&
      (kind === 'team' || x.chatId === chatId),
  ) || null;

/** The open brief to a team or an agent (the newest). */
export const openBrief = (kind: BrainBrief['kind'], targetId: string, pid = activeProject().id): BrainBrief | null =>
  listBriefs(pid).findLast((x) => x.status === 'open' && x.kind === kind && x.targetId === targetId) || null;

/** Ordinary messages become work to finish. A steer adds to the open assignment. */
export function trackWork(
  kind: BrainBrief['kind'],
  targetId: string,
  name: string,
  text: string,
  ref: { chatId?: string; messageId?: string; ts?: number } = {},
): BrainBrief {
  const previous = listBriefs().findLast(
    (b) =>
      ['open', 'blocked', 'stuck'].includes(b.status) &&
      b.kind === kind &&
      b.targetId === targetId &&
      (kind === 'team' || b.chatId === ref.chatId),
  );
  for (const q of questions.list())
    if (previous && q.status === 'waiting' && q.briefId === previous.id)
      questions.save({ ...q, status: 'closed', note: 'You sent a new message about this work.' });
  if (previous)
    return updateBrief(previous.id, {
      status: 'open',
      text: `${previous.text}\n\nUser update:\n${text}`,
      revision: (previous.revision || 0) + 1,
      stalled: 0,
      failures: 0,
      userAction: undefined,
    })!;
  return addBrief({
    kind,
    targetId,
    name,
    text,
    goal: text,
    automatic: true,
    origin: 'chat',
    ts: ref.ts ?? Date.now(),
    ...ref,
  });
}

/** Clear/delete cancels completion checks, including a verdict already in flight. */
export function clearWork(kind: BrainBrief['kind'], targetId: string, chatId?: string): void {
  for (const b of listBriefs())
    if (
      b.kind === kind &&
      b.targetId === targetId &&
      (kind === 'team' || b.chatId === chatId) &&
      ['open', 'blocked', 'stuck'].includes(b.status)
    ) {
      updateBrief(b.id, { status: 'cleared' });
      for (const q of questions.list())
        if (q.briefId === b.id && q.status === 'waiting')
          questions.save({ ...q, status: 'closed', note: 'This work was cleared.' });
    }
}

export function stopChatWork(chatId: string, pid = activeProject().id): void {
  for (const b of listBriefs(pid))
    if (b.kind === 'agent' && b.chatId === chatId && ['open', 'blocked', 'stuck'].includes(b.status)) stopBrief(b, pid);
}

export function stopTeamWork(teamId: string): void {
  for (const b of listBriefs())
    if (b.kind === 'team' && b.targetId === teamId && ['open', 'blocked', 'stuck'].includes(b.status)) stopBrief(b);
}

function stopBrief(b: BrainBrief, pid = activeProject().id): void {
  updateBrief(b.id, { status: 'stopped' }, pid);
  if (pid === activeProject().id)
    for (const q of questions.list())
      if (q.briefId === b.id && q.status === 'waiting')
        questions.save({ ...q, status: 'closed', note: 'You stopped this work.' });
}
