// Handing work to another agent without waiting (ask_agent): the work starts at once and the asker gets
// a handle back; await_agent collects the answer, however long it takes. So a long job never outlives the
// tool call that asked for it (an MCP call from Claude Code, Codex or pi gives up after an hour), and an
// agent can hand out several tasks at once. Stopping the asker's run stops what it handed out (stopRun).
import { uid } from './util.ts';
import { activeProject, chats } from './store.ts';
import { readExecution, saveHandoff } from './execution.ts';
import type { Agent, Chat, SavedHandoff } from '../shared/types.ts';

export interface Handoff extends SavedHandoff {
  /** settles when the work ends, either way */
  done: Promise<void>;
}

const jobs = new Map<string, Promise<void>>();
/** Finished ones are kept this long for await_agent (a later turn of the asker can still collect them). */
const KEEP_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_WAIT_S = 600;
export const MAX_WAIT_S = 1800;

const handoffs = () => readExecution().handoffs.filter((h) => !h.endedAt || Date.now() - h.endedAt < KEEP_MS);

/** Starts the task in a new chat with the target and returns at once. */
export async function startHandoff(
  from: Pick<Agent, 'id' | 'name'>,
  target: Agent,
  task: string,
  { depth, parentRunId, signal }: { depth: number; parentRunId?: string | null; signal?: AbortSignal },
): Promise<Handoff> {
  const { askAgent, conversationOfRun: conversationOf, isStopping, RunStopped } = await import('./engines/index.ts');
  // (the helper's chat is in the asker's private conversation, if it is in one: its work stays there)
  const conversationId = conversationOf(parentRunId);
  const chat = chats.create(target.id, `Asked by ${from.name}`, null, conversationId);
  const saved: SavedHandoff = {
    id: uid('h'),
    from: from.id,
    projectId: activeProject().id,
    to: target.id,
    toName: target.name,
    chatId: chat.id,
    runId: uid('r'),
    task,
    ...(conversationId ? { conversationId } : {}),
    startedAt: Date.now(),
  };
  saveHandoff(saved);
  const h: Handoff = { ...saved, done: Promise.resolve() };
  h.done = askAgent(target, task, {
    depth,
    from: from.name,
    chatId: chat.id,
    parentRunId,
    signal,
    reservedRunId: h.runId,
  }).then(
    (answer) => {
      h.answer = answer;
      h.endedAt = Date.now();
      saveHandoff({ ...saved, answer, endedAt: h.endedAt });
    },
    (e: unknown) => {
      // Shutdown aborts the local waiter while a saved native run can still resume.
      if (
        isStopping() &&
        readExecution().runs.some((run) => run.id === h.runId && run.status === 'running' && !run.stopRequested)
      )
        return;
      h.error = e instanceof RunStopped ? 'it was stopped' : (e as Error).message || String(e);
      h.endedAt = Date.now();
      saveHandoff({ ...saved, error: h.error, endedAt: h.endedAt });
    },
  );
  jobs.set(h.id, h.done);
  void h.done.finally(() => jobs.delete(h.id));
  return h;
}

/** Whether an asker, in its conversation (null: ordinary chats), may see a handoff: its own, from the same one. */
const owns = (h: SavedHandoff, askerId: string, conversationId: string | null) =>
  h.from === askerId && (h.conversationId || null) === conversationId;

const minutes = (ms: number) =>
  ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${Math.round(ms / 60_000)} min`;

/** Its latest words while it works (its live chat), for "still working" answers. */
function soFar(h: SavedHandoff, live: Chat | null): string {
  const items = (live || chats.get(h.to, h.chatId))?.items || [];
  const last = items.findLast((i) => i.type === 'assistant' && i.text.trim());
  const tools = items.filter((i) => i.type === 'tool').length;
  const words = last && last.type === 'assistant' ? last.text.trim().slice(-400) : '';
  return `${tools ? ` ${tools} tool call${tools === 1 ? '' : 's'} so far.` : ''}${words ? `\nLatest from ${h.toName}: ${words}` : ''}`;
}

/** Waits up to waitS seconds for a handoff's answer: the answer, its error, or that it is still going. */
export async function awaitHandoff(
  id: string,
  askerId: string,
  waitS = DEFAULT_WAIT_S,
  signal?: AbortSignal,
  conversationId: string | null = null,
): Promise<{ text: string; isError?: boolean }> {
  const found = handoffs().find((h) => h.id === String(id || '').trim());
  // (another project's handoff isn't there for this one)
  let h = found && found.projectId === activeProject().id ? found : undefined;
  if (!h)
    return {
      text: `No handoff with handle ${id}. (Finished ones are kept for 6 hours; call await_agent without a handle to list yours.)`,
      isError: true,
    };
  if (h.from !== askerId) return { text: 'That handle belongs to another agent.', isError: true };
  if (!owns(h, askerId, conversationId)) return { text: 'That handle belongs to another conversation.', isError: true };
  if (!h.endedAt && !signal?.aborted) {
    const wait = Math.min(MAX_WAIT_S, Math.max(1, Number(waitS) || DEFAULT_WAIT_S)) * 1000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;
    let onAbort = () => {};
    await Promise.race([
      jobs.get(h.id) ||
        new Promise<void>((resolve) => {
          const handle = h!.id;
          poll = setInterval(() => {
            if (handoffs().find((item) => item.id === handle)?.endedAt) resolve();
          }, 100);
        }),
      new Promise<void>((r) => (timer = setTimeout(r, wait))),
      new Promise<void>((r) => {
        onAbort = () => r();
        signal?.addEventListener('abort', onAbort);
      }),
    ]);
    clearTimeout(timer);
    clearInterval(poll);
    signal?.removeEventListener('abort', onAbort);
    h = handoffs().find((item) => item.id === h!.id) || h;
  }
  if (signal?.aborted && !h.endedAt) return { text: 'Stopped.', isError: true };
  return describe(h);
}

/** Where a handoff is now: its answer, its error, or how far it got. */
async function describe(
  h: SavedHandoff,
  again = `Call await_agent again with handle ${h.id}.`,
): Promise<{ text: string; isError?: boolean }> {
  if (h.error) return { text: `${h.toName} couldn't finish: ${h.error}`, isError: true };
  if (h.endedAt) return { text: `${h.toName} says:\n${h.answer || '(no answer)'}` };
  const { liveChat } = await import('./engines/index.ts');
  return {
    text: `${h.toName} is still working on it (${minutes(Date.now() - h.startedAt)} so far).${soFar(h, liveChat(h.chatId, h.projectId))}${again ? `\n${again}` : ''}`,
  };
}

/** Several handoffs in one call: waits until one is done (or, with all, every one), then says where each is. */
export async function awaitHandoffs(
  ids: string[],
  askerId: string,
  {
    all = false,
    waitS = DEFAULT_WAIT_S,
    signal,
    conversationId = null,
  }: { all?: boolean; waitS?: number; signal?: AbortSignal; conversationId?: string | null } = {},
): Promise<{ text: string; isError?: boolean }> {
  const wanted = [...new Set(ids.map((id) => String(id || '').trim()).filter(Boolean))];
  if (wanted.length <= 1) return awaitHandoff(wanted[0] || '', askerId, waitS, signal, conversationId);
  const projectId = activeProject().id;
  const find = (id: string) => handoffs().find((h) => h.id === id && h.projectId === projectId);
  for (const id of wanted) {
    const h = find(id);
    if (!h)
      return {
        text: `No handoff with handle ${id}. (Finished ones are kept for 6 hours; call await_agent without a handle to list yours.)`,
        isError: true,
      };
    if (h.from !== askerId) return { text: `Handle ${id} belongs to another agent.`, isError: true };
    if (!owns(h, askerId, conversationId))
      return { text: `Handle ${id} belongs to another conversation.`, isError: true };
  }
  const finished = () => wanted.filter((id) => find(id)?.endedAt).length;
  const ready = () => (all ? finished() === wanted.length : finished() > 0);
  if (!ready() && !signal?.aborted) {
    const wait = Math.min(MAX_WAIT_S, Math.max(1, Number(waitS) || DEFAULT_WAIT_S)) * 1000;
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        clearInterval(poll);
        signal?.removeEventListener('abort', finish);
        resolve();
      };
      const timer = setTimeout(finish, wait);
      // (a handoff of an earlier run of the dashboard has no job here: its saved record is checked instead)
      const poll = setInterval(() => ready() && finish(), 100);
      for (const id of wanted) void jobs.get(id)?.then(() => ready() && finish());
      signal?.addEventListener('abort', finish);
    });
  }
  if (signal?.aborted && !ready()) return { text: 'Stopped.', isError: true };
  const parts = await Promise.all(wanted.map(async (id) => ({ id, ...(await describe(find(id)!, '')) })));
  const working = parts.filter((p) => !find(p.id)?.endedAt).map((p) => p.id);
  const text = parts.map((p) => `[${p.id}] ${p.text}`).join('\n\n');
  return {
    text: working.length
      ? `${text}\n\nStill working: call await_agent again with handles ${JSON.stringify(working)}.`
      : text,
    isError: parts.every((p) => p.isError),
  };
}

/** The asker's handoffs, newest first (await_agent without a handle). */
export function listHandoffs(askerId: string, conversationId: string | null = null): string {
  const projectId = activeProject().id;
  const mine = handoffs()
    .filter((h) => owns(h, askerId, conversationId) && h.projectId === projectId)
    .sort((a, b) => b.startedAt - a.startedAt);
  if (!mine.length) return 'You have no handoffs. Give a task to a teammate with ask_agent.';
  return mine
    .map(
      (h) =>
        `- ${h.id} → ${h.toName}: "${h.task.replace(/\s+/g, ' ').slice(0, 80)}" — ${h.error ? `failed (${h.error.slice(0, 80)})` : h.endedAt ? 'done, answer ready' : `working, ${minutes(Date.now() - h.startedAt)}`}`,
    )
    .join('\n');
}
