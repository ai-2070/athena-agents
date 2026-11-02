// Input admission and its run receipt share one write: a crash cannot submit a queued input twice.
import { privateDataPath } from './private.ts';
import { readPlain, writeJSON } from './util.ts';
import { readTeamWork } from './teamwork.ts';
import type { ExecutionJournal, ExecutionQueue, ExecutionRun, SavedHandoff } from '../shared/types.ts';

const file = () => privateDataPath('runtime', 'execution.json');
export const readExecution = (): ExecutionJournal => readPlain(file(), { runs: [], queues: [], handoffs: [] });
const sameChat = (a: ExecutionQueue, projectId: string, chatId: string) => a.projectId === projectId && a.chatId === chatId;
const KEEP_MS = 6 * 60 * 60 * 1000;

function teamOwnsRun(run: ExecutionRun): boolean {
  const prefix = `team:${run.projectId}/`;
  if (!run.parentRunId?.startsWith(prefix)) return false;
  const work = readTeamWork(run.projectId, run.parentRunId.slice(prefix.length));
  return !!work && [...work.current, ...work.queue, ...work.interrupted].some((q) => q.delivery?.runId === run.id);
}

function change<T>(fn: (state: ExecutionJournal) => T): T {
  const state = readExecution();
  const result = fn(state);
  const keep = (item: { endedAt?: number }) => !item.endedAt || Date.now() - item.endedAt < KEEP_MS;
  state.handoffs = state.handoffs.filter(keep);
  const ancestors = new Set<string>();
  for (const child of state.runs.filter((r) => !r.settled)) {
    let parent = child.parentRunId;
    while (parent && !ancestors.has(parent)) {
      ancestors.add(parent);
      parent = state.runs.find((r) => r.id === parent && r.projectId === child.projectId)?.parentRunId || null;
    }
  }
  state.runs = state.runs.filter((r) => !r.settled || keep(r) || ancestors.has(r.id) || state.handoffs.some((h) => h.runId === r.id) || teamOwnsRun(r));
  writeJSON(file(), state);
  return result;
}

export function saveExecutionQueue(queue: ExecutionQueue): void {
  change((state) => {
    state.queues = state.queues.filter((q) => !sameChat(q, queue.projectId, queue.chatId));
    if (queue.items.length || queue.paused) state.queues.push(queue);
  });
}

export function admitExecution(run: ExecutionRun, queueId?: string): void {
  change((state) => {
    if (state.runs.some((r) => r.id === run.id)) throw new Error('This input already has a run.');
    if (state.runs.some((r) => r.projectId === run.projectId && r.chatId === run.chatId && r.status === 'running')) throw new Error('This chat already has saved work.');
    const queue = state.queues.find((q) => sameChat(q, run.projectId, run.chatId));
    if (queueId) {
      const item = queue?.items[0];
      if (!item || item.id !== queueId || queue?.paused) throw new Error('This message is no longer next in the queue.');
      if (item.text !== run.text || JSON.stringify(item.attachments || []) !== JSON.stringify(run.attachments) || (item.from || null) !== run.from) throw new Error('The queued message changed before it started.');
      queue.items.shift();
      queue.priority = queue.priority.filter((id) => id !== queueId);
    } else if (queue) queue.paused = false;
    state.queues = state.queues.filter((q) => q.items.length || q.paused);
    state.runs.push(run);
  });
}

export function updateExecution(id: string, update: Partial<Pick<ExecutionRun, 'status' | 'stopRequested' | 'steered' | 'endedAt' | 'answer' | 'error' | 'settled' | 'completionClaimed' | 'clearMemoryOnEnd'>>): ExecutionRun | null {
  return change((state) => {
    const run = state.runs.find((r) => r.id === id);
    if (!run) return null;
    if (run.status !== 'running' && update.status && run.status !== update.status) return run;
    Object.assign(run, update);
    if (run.status !== 'running') for (const handoff of state.handoffs) {
      if (handoff.runId !== run.id || handoff.projectId !== run.projectId || handoff.endedAt) continue;
      handoff.endedAt = run.endedAt || Date.now();
      if (run.status === 'completed') handoff.answer = run.answer || '(no answer)';
      else handoff.error = run.status === 'stopped' ? 'it was stopped' : run.error || 'The task could not finish.';
    }
    return run;
  });
}

/** Called before schedulers or incoming messages. Native Eve runs are reconciled by their adapter. */
export function interruptExecutions(resumable: ReadonlySet<string> = new Set()): ExecutionRun[] {
  return change((state) => {
    const interrupted: ExecutionRun[] = [];
    for (const run of state.runs) {
      if (resumable.has(run.id) || run.settled) continue;
      if (run.status === 'running') Object.assign(run, { status: run.stopRequested && !run.steered ? 'stopped' : 'interrupted', endedAt: Date.now(), error: run.stopRequested && !run.steered ? 'Stopped.' : 'The dashboard restarted before this work finished. Check what was done before sending another message.' });
      const queue = state.queues.find((q) => sameChat(q, run.projectId, run.chatId));
      if (queue && run.status === 'stopped' && !run.steered) {
        queue.items = [];
        queue.priority = [];
      }
      if (queue) queue.paused = true;
      interrupted.push({ ...run });
    }
    // Unclaimed inputs can have survived a crash before the preceding run was admitted.
    for (const queue of state.queues) if (!state.runs.some((r) => resumable.has(r.id) && r.projectId === queue.projectId && r.chatId === queue.chatId)) queue.paused = true;
    for (const h of state.handoffs) {
      if (h.endedAt) continue;
      const run = state.runs.find((r) => r.id === h.runId);
      if (run?.status === 'running') continue;
      h.endedAt = run?.endedAt || Date.now();
      if (run?.status === 'completed') h.answer = run.answer || '(no answer)';
      else h.error = run?.error || 'The dashboard restarted before the task started.';
    }
    return interrupted;
  });
}

export function saveHandoff(handoff: SavedHandoff): void {
  change((state) => {
    const existing = state.handoffs.find((h) => h.id === handoff.id);
    if (existing) {
      if (existing.projectId !== handoff.projectId || existing.from !== handoff.from || existing.runId !== handoff.runId) throw new Error('A handoff cannot change ownership.');
      Object.assign(existing, handoff);
    } else state.handoffs.push(handoff);
  });
}
