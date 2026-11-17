// Tasks board work: an agent, a team or the Brain picks up a task you move to In progress (or start), in a private
// conversation of its own, board-<taskId> (private-conversations.ts, as Gateways uses). The work is saved on the task
// before it starts, so a restart never starts it twice; a loop follows it like the gateway dispatcher does and settles
// the card from the usual completion check (the automatic brief): In review when it's done, Blocked with the reason
// when it can't go on. Workers comment and move their own card with board_task / board_reply (tools.ts). The Brain
// answers in its private history for the task and does it itself or hands it on, and then the board follows the
// agent or team it handed it to.
import { agents, bus, chats, listProjects, withProject, workflows } from './store.ts';
import { uid } from './util.ts';
import { hasBackgroundWork, isChatBusy, queueMessage, runInfo, startRun, stopChat } from './engines/index.ts';
import { readExecution } from './execution.ts';
import { listApprovals } from './approvals.ts';
import { getTeam, getThread, isTeamBusy, postUserMessage, queueUserMessage, stopTeam } from './teams.ts';
import { pickMember } from './brain.ts';
import { listBriefs } from './briefs.ts';
import { privateAgentChat, privateTeamId, privateTeamRecord } from './private-conversations.ts';
import {
  addBoardComment,
  boardTags,
  changeBoardTask,
  editBoardTask,
  savedBoardTask,
  tagLine,
  tagsOf,
  tasksWithWork,
  workerOf,
} from './taskboard.ts';
import { ask, history, stopAsks } from './overseer.ts';
import { tagLabel } from '../shared/boardtags.ts';
import { taskFilePath, workerFiles } from './boardfiles.ts';
import type { BoardTag, BoardTask, Project, ProjectTask, ServerEvent, TaskFile, TaskWork } from '../shared/types.ts';

/** How the board signs what it sends (the chat and the team thread show it). */
export const BOARD_SENDER = 'Tasks board (you)';
const ACTIVE: readonly TaskWork['state'][] = ['starting', 'working', 'waiting'];
export const isWorking = (w: TaskWork | undefined): w is TaskWork => !!w && ACTIVE.includes(w.state);
export const boardConversation = (taskId: string) => `board-${taskId}`;
const fail = (message: string, status = 400): never => {
  throw Object.assign(new Error(message), { status });
};
const projectOf = (id: string): Project =>
  listProjects().find((p) => p.id === id) || fail('That project is unavailable.', 404);

/** The agent, team or Brain a task's assignee names, when it can pick work up. */
function targetOf(assignee: string): TaskWork['target'] | null {
  if (assignee === 'brain') return { kind: 'brain', id: 'brain' };
  const m = /^(agent|team):([\w.-]+)$/.exec(assignee);
  return m ? { kind: m[1] as 'agent' | 'team', id: m[2] } : null;
}
/** Whether moving a task given to this assignee to In progress starts work. */
export const canPickUp = (assignee: string): boolean => targetOf(assignee) !== null;
/** Who answers for the work: the worker, or the agent or team the Brain handed it to. */
const workerRef = (w: TaskWork) => (w.handedTo ? `${w.handedTo.kind}:${w.handedTo.id}` : workerOf(w));
/** The agent whose private chat does the work, if an agent does it. */
const agentOf = (w: TaskWork): string | null =>
  w.target.kind === 'agent' ? w.target.id : w.handedTo?.kind === 'agent' ? w.handedTo.id : null;

// ---------- what the worker is told ----------
function fileNames(files: TaskFile[] | undefined): string {
  return (files || []).map((f) => f.name).join(', ');
}
const REPORT =
  'Work on this task. Post what you find and what you made as a comment with board_reply, attaching finished files by their full paths. ' +
  "When it is done, call board_reply with status in_review. If you can't finish it, call board_reply with status blocked and say why. Never mark it done: the user does that. " +
  "If you can't use the board tools, end with your result, or say clearly that you are blocked and why.";
// (the Brain has no board_reply: it hands work on, or does it with its actions, and the board settles the card)
const brainReport = (t: ProjectTask) =>
  'This task is given to you, the Brain, and you are in its own conversation. Take it on as you would a request in your chat: ' +
  "hand the work to the agent or team best placed to do it with a clear brief (build one first if none fits), or do it yourself when it is yours to do (the dashboard's setup, the board). " +
  `In a brief, say it is task #${t.number} on the Tasks board, so they report on it with board_reply. ` +
  'Comment on the task with board_comment when there is something to note. Never move it to done: when the work is finished the board moves it to in_review, and the user checks it.';
/** The task in one message: what it is, its tags (in its order), what was said, and how to report back. */
function assignment(p: Project, t: ProjectTask, tags: readonly BoardTag[], report = REPORT): string {
  const comments = (t.comments || []).map((c) => {
    const files = fileNames(c.files);
    return `- ${c.by === 'you' ? 'You' : c.by}: ${c.text}${files ? ` [files: ${files}]` : ''}`;
  });
  return [
    `Task #${t.number} on the Tasks board of project "${p.name}": ${t.title}`,
    `Priority: ${t.priority}`,
    tags.length ? `Tags: ${tags.map(tagLabel).join(', ')}` : '',
    t.description ? `\n${t.description}` : '',
    t.files?.length ? `\nFiles on the task (attached): ${fileNames(t.files)}` : '',
    comments.length ? `\nComments so far (oldest first):\n${comments.join('\n')}` : '',
    `\n${report}`,
  ]
    .filter(Boolean)
    .join('\n');
}
/** What of the task's message the user wrote: the task, when they made it, and their own comments. Links in the
 *  rest (an agent's comment, a task an agent made) never count as theirs when the Brain installs or connects. */
function ownWords(t: ProjectTask): string {
  return [
    ...(t.createdBy === 'you' ? [t.title, t.description] : []),
    ...(t.comments || []).filter((c) => c.by === 'you').map((c) => c.text),
  ]
    .filter(Boolean)
    .join('\n');
}
/** The task's files and its comments' files, where they are now. */
function attachmentsOf(p: Project, t: ProjectTask): string[] {
  const all = [...(t.files || []), ...(t.comments || []).flatMap((c) => c.files || [])];
  return [...new Set(all.flatMap((f) => taskFilePath(p, f.path) ?? []))];
}

// ---------- starting ----------
const launching = new Set<string>();

/** Starts the task's agent, team or the Brain on it (Start, or your move to In progress). Nothing happens while it works. */
export async function startWork(projectId: string, taskId: string): Promise<BoardTask> {
  const p = projectOf(projectId);
  return withProject(p, async () => {
    const t = savedBoardTask(projectId, taskId) || fail('That task is unavailable.', 404);
    const target = targetOf(t.assignee) || fail('Give the task to an agent, a team or the Brain first.');
    if (isWorking(t.work)) return editBoardTask(projectId, taskId, () => false);
    if (target.kind === 'agent' ? !agents.get(target.id) : target.kind === 'team' && !workflows.get(target.id))
      return fail('That agent or team is not in this project anymore.');
    const conversationId = boardConversation(t.id);
    // (the private chat or thread is the same every time: a new start continues it, so the worker sees earlier tries)
    const chatId = target.kind === 'agent' ? privateAgentChat(conversationId, target.id).id : undefined;
    const teamId = target.kind === 'team' ? privateTeamId(conversationId, target.id) : undefined;
    const operationId = uid(target.kind === 'agent' ? 'r' : target.kind === 'team' ? 'm' : 'b');
    const claimed: { task?: ProjectTask } = {};
    const saved = editBoardTask(projectId, taskId, (task) => {
      if (isWorking(task.work)) return false;
      task.work = {
        operationId,
        conversationId,
        target,
        ...(chatId ? { chatId } : {}),
        ...(teamId ? { teamId } : {}),
        startedAt: Date.now(),
        state: 'starting',
      };
      // Start on a card in To do or Blocked moves it to In progress, where the board follows the work it started
      if (task.status === 'todo' || task.status === 'blocked') {
        task.status = 'in_progress';
        delete task.blockedReason;
      }
      claimed.task = structuredClone(task);
    });
    if (!claimed.task) return saved;
    const task = claimed.task;
    launching.add(operationId);
    const launch = async (): Promise<BoardTask> => {
      try {
        // (the card editBoardTask gave back has the task's tags: no other read of the board)
        const text = assignment(p, task, saved.tagList, target.kind === 'brain' ? brainReport(task) : REPORT);
        const attachments = attachmentsOf(p, task);
        if (target.kind === 'brain') return await brainStart(p, task, operationId, text, attachments);
        let started: Partial<TaskWork>;
        if (target.kind === 'agent') {
          const agent = agents.get(target.id)!;
          const chat = chats.get(target.id, chatId!) || fail("The task's chat is unavailable.");
          const run = startRun(agent, chat, text, {
            attachments,
            from: BOARD_SENDER,
            reservedRunId: operationId,
            userInitiated: true,
          });
          void run.promise.catch(() => {});
          started = { runId: run.runId };
        } else {
          const message = await postUserMessage(teamId!, text, {
            attachments,
            sender: BOARD_SENDER,
            messageId: operationId,
            route: pickMember,
          });
          started = { messageId: message.id };
        }
        return setWork(projectId, taskId, operationId, { ...started, state: 'working' });
      } catch (e) {
        return setWork(projectId, taskId, operationId, {
          state: 'needs-review',
          endedAt: Date.now(),
          note: `It didn't start: ${e instanceof Error ? e.message : String(e)}`,
        });
      } finally {
        launching.delete(operationId);
        void boardWork.wake();
      }
    };
    // (an agent starts at once; a team first picks who takes it and the Brain thinks, which ask a model: the card says
    // Starting meanwhile)
    if (target.kind === 'agent') return launch();
    void launch();
    return saved;
  });
}

/** The Brain answers the task in its own conversation; once it has, the work goes on with whoever it handed it to,
 *  or is settled from its answer. Stopping it meanwhile (Stop, or moving the card) drops what it was about to do. */
async function brainStart(
  p: Project,
  t: ProjectTask,
  operationId: string,
  text: string,
  attachments: string[],
): Promise<BoardTask> {
  const same = () => {
    const w = savedBoardTask(p.id, t.id)?.work;
    return w?.operationId === operationId && isWorking(w);
  };
  const answer = await ask(text, {
    project: p.id,
    attachments,
    conversationId: boardConversation(t.id),
    from: BOARD_SENDER,
    ownWords: ownWords(t),
    operationId,
    proceed: same,
  });
  const d = answer.delegate;
  const team = d?.kind === 'branch' && d.sent?.messageId ? privateTeamRecord(d.id) : null;
  const handed: Partial<TaskWork> =
    d?.kind === 'agent' && d.sent?.chatId && d.sent.runId
      ? { handedTo: { kind: 'agent', id: d.id }, chatId: d.sent.chatId, runId: d.sent.runId }
      : team
        ? { handedTo: { kind: 'team', id: team.target.id }, teamId: d!.id, messageId: d!.sent!.messageId }
        : {};
  // (what it said as it handed the work on is the task's note of who does it; done alone, its answer settles it)
  if (handed.handedTo && same() && answer.answer.trim() && !brainCommented(savedBoardTask(p.id, t.id)!))
    addBoardComment(p.id, t.id, answer.answer, 'brain');
  return editBoardTask(p.id, t.id, (task) => {
    if (task.work?.operationId !== operationId || !isWorking(task.work)) return false;
    task.work = { ...task.work, ...handed, state: 'working' };
  });
}
/** The Brain already commented on the task since its work started. */
const brainCommented = (t: ProjectTask) =>
  (t.comments || []).some((c) => c.by === 'brain' && c.at >= t.work!.startedAt);

/** Changes the work saved on a task, if it is still the same work. */
function setWork(
  projectId: string,
  taskId: string,
  operationId: string,
  patch: Partial<TaskWork>,
  also?: (t: ProjectTask) => void,
): BoardTask {
  return editBoardTask(projectId, taskId, (t) => {
    if (t.work?.operationId !== operationId) return false;
    t.work = { ...t.work, ...patch };
    also?.(t);
  });
}

// ---------- stopping and steering ----------
/** Stops the work on a task (Stop, or you moved the task away from its worker). */
export function stopWork(projectId: string, taskId: string): BoardTask {
  const p = projectOf(projectId);
  return withProject(p, () => {
    const t = savedBoardTask(projectId, taskId) || fail('That task is unavailable.', 404);
    const w = t.work;
    if (!isWorking(w)) return editBoardTask(projectId, taskId, () => false);
    if (w.target.kind === 'brain' && !w.handedTo) stopAsks(projectId, w.conversationId);
    if (w.chatId) stopChat(w.chatId, projectId);
    if (w.teamId && getTeam(w.teamId)) stopTeam(w.teamId);
    return setWork(projectId, taskId, w.operationId, { state: 'stopped', endedAt: Date.now() });
  });
}

/** Your comment (or changed description) reaches the worker while it works: queued, not stopping it. */
export async function passToWorker(
  projectId: string,
  taskId: string,
  text: string,
  files: TaskFile[] = [],
): Promise<void> {
  const p = projectOf(projectId);
  await withProject(p, async () => {
    const w = savedBoardTask(projectId, taskId)?.work;
    if (!isWorking(w)) return;
    const attachments = files.flatMap((f) => taskFilePath(p, f.path) ?? []);
    // (while the Brain still thinks, nobody has it yet: the comment waits on the task)
    const agentId = agentOf(w);
    if (w.chatId && agentId) {
      const agent = agents.get(agentId);
      const chat = chats.get(agentId, w.chatId);
      if (agent && chat) queueMessage(agent, chat, text, attachments);
    } else if (w.teamId && getTeam(w.teamId))
      await queueUserMessage(w.teamId, text, { attachments, route: pickMember });
  });
}

/** After you change a task: start its worker, or stop the work when you moved it away or gave it to someone else. */
export async function afterUserChange(projectId: string, before: ProjectTask, after: BoardTask): Promise<BoardTask> {
  let now = after;
  const handedOn = before.assignee !== after.assignee;
  if (isWorking(before.work)) {
    if (after.status !== 'in_progress' || handedOn) now = stopWork(projectId, after.id);
    else if (before.description !== after.description && after.description)
      void passToWorker(projectId, after.id, `The task's description changed:\n\n${after.description}`).catch(() => {});
  }
  if (after.status === 'in_progress' && targetOf(after.assignee) && (before.status !== 'in_progress' || handedOn))
    now = await startWork(projectId, after.id);
  return now;
}

// ---------- following and settling ----------
type Outcome =
  | { state: 'pending'; waiting: boolean }
  | { state: 'completed'; answer: string }
  | { state: 'blocked'; summary: string; action: string }
  | { state: 'stopped' }
  | { state: 'needs-review'; note: string };
const review = (note: string): Outcome => ({ state: 'needs-review', note });

// The newest completion check in this conversation since the work started (a follow-up keeps the same one).
const briefOf = (kind: 'agent' | 'team', w: TaskWork, targetId: string) =>
  listBriefs().findLast(
    (b) =>
      b.kind === kind &&
      b.targetId === targetId &&
      (kind === 'team' || b.chatId === w.chatId) &&
      b.ts >= w.startedAt - 1000,
  );

function fromBrief(b: ReturnType<typeof briefOf>, answer: () => string): Outcome | null {
  if (!b) return null;
  if (b.status === 'open') return { state: 'pending', waiting: false };
  if (b.status === 'done') return { state: 'completed', answer: answer() || b.summary || '' };
  if (b.status === 'blocked' || b.status === 'stuck')
    return { state: 'blocked', summary: b.summary || 'The work cannot continue.', action: b.userAction || '' };
  if (b.status === 'stopped') return { state: 'stopped' };
  return review('Its completion check was cleared or replaced. Open the chat to see where it got to.');
}

function approvalPending(w: TaskWork, projectId: string): boolean {
  return listApprovals().some((a) => {
    if (a.createdAt < w.startedAt || typeof a.data.runId !== 'string') return false;
    const run = runInfo(a.data.runId);
    return run?.projectId === projectId && run.conversationId === w.conversationId;
  });
}

function agentOutcome(projectId: string, w: TaskWork, agentId: string): Outcome {
  const chatId = w.chatId!;
  const chat = chats.get(agentId, chatId);
  if (!chat || chat.conversationId !== w.conversationId) return review("The task's chat is gone.");
  const runs = readExecution().runs.filter(
    (r) => r.projectId === projectId && r.chatId === chatId && r.agentId === agentId,
  );
  const run = runs.find((r) => r.id === w.runId);
  if (!run) return review("Its run can't be found. Open the chat to see where it got to.");
  const busy =
    runs.some((r) => r.status === 'running') ||
    isChatBusy(chatId) ||
    hasBackgroundWork(chatId) ||
    readExecution().runs.some((r) => r.projectId === projectId && r.ownerChatId === chatId && r.status === 'running');
  if (busy) return { state: 'pending', waiting: approvalPending(w, projectId) };
  const last = runs
    .filter((r) => r.startedAt >= run.startedAt)
    .sort((a, b) => a.startedAt - b.startedAt)
    .at(-1)!;
  const brief = fromBrief(briefOf('agent', w, agentId), () => last.answer || '');
  if (brief) return brief;
  if (last.status === 'completed') return { state: 'completed', answer: last.answer || '' };
  if (last.status === 'stopped') return { state: 'stopped' };
  return review(
    last.status === 'failed'
      ? 'Its run failed. Open the chat to see the error.'
      : 'Its run was interrupted. Open the chat to see where it got to.',
  );
}

function teamOutcome(projectId: string, w: TaskWork): Outcome {
  const teamId = w.teamId!;
  if (privateTeamRecord(teamId)?.conversationId !== w.conversationId) return review("The task's team thread is gone.");
  const team = getTeam(teamId);
  if (!team) return review('The team is gone.');
  const thread = getThread(teamId, 10000);
  const at = thread.messages.findIndex((m) => m.id === w.messageId);
  if (at < 0) return review("Its message in the team thread can't be found.");
  if (isTeamBusy(teamId)) return { state: 'pending', waiting: approvalPending(w, projectId) };
  const answer = () => thread.messages.slice(at + 1).findLast((m) => team.members.includes(m.from))?.text || '';
  const brief = fromBrief(briefOf('team', w, teamId), answer);
  if (brief) return brief;
  const said = answer();
  return said ? { state: 'completed', answer: said } : review('No one on the team answered.');
}

/** The Brain's work: followed in the agent's chat or team's thread it handed it to, or settled from its own answer. */
function brainOutcome(projectId: string, w: TaskWork): Outcome {
  if (w.handedTo)
    return w.handedTo.kind === 'agent' ? agentOutcome(projectId, w, w.handedTo.id) : teamOutcome(projectId, w);
  const said = history(projectId, w.conversationId).findLast(
    (m) => m.role === 'brain' && m.operationId === w.operationId,
  );
  if (!said) return review("The Brain's answer can't be found. Start it again.");
  const failed = (said.done || []).filter((d) => d.kind === 'error');
  if (failed.length) return review(`The Brain couldn't do all of it: ${failed.map((d) => d.text).join(' ')}`);
  return { state: 'completed', answer: said.text };
}

/** Where saved work stands, by its ids (after it started). */
function started(projectId: string, w: TaskWork): Outcome {
  if (w.target.kind === 'brain') return brainOutcome(projectId, w);
  if (w.target.kind === 'agent') return w.runId ? agentOutcome(projectId, w, w.target.id) : review('It never started.');
  return w.messageId ? teamOutcome(projectId, w) : review('It never started.');
}

/** Where a task's work stands now. */
function outcome(projectId: string, w: TaskWork): Outcome {
  if (w.state === 'starting')
    return launching.has(w.operationId)
      ? { state: 'pending', waiting: false }
      : review(
          'It was saved but may not have started (the dashboard stopped). Open the chat to check, then start it again.',
        );
  return started(projectId, w);
}

/** Settles a task's work: moves the card and adds the worker's answer as a comment. */
function settle(projectId: string, t: ProjectTask, result: Outcome): void {
  const w = t.work!;
  if (result.state === 'pending') {
    const state = result.waiting ? 'waiting' : 'working';
    if (w.state !== state && w.state !== 'starting') setWork(projectId, t.id, w.operationId, { state });
    return;
  }
  const end = { endedAt: Date.now() };
  if (result.state === 'stopped') {
    setWork(projectId, t.id, w.operationId, { state: 'stopped', ...end });
    return;
  }
  if (result.state === 'needs-review') {
    setWork(projectId, t.id, w.operationId, { state: 'needs-review', note: result.note, ...end });
    return;
  }
  // (a worker that already commented since it started has said its piece; the answer isn't repeated. The Brain's
  // completion notes don't count, unless the Brain is the one answering)
  const by = workerRef(w);
  const commented =
    by === 'brain'
      ? brainCommented(t)
      : (t.comments || []).some((c) => c.by !== 'you' && c.by !== 'brain' && c.at >= w.startedAt);
  if (result.state === 'blocked') {
    const reason = result.summary;
    // (the reason comes from the completion check, so the Brain signs it)
    addBoardComment(projectId, t.id, [`**${result.summary}**`, result.action].filter(Boolean).join('\n\n'), 'brain');
    setWork(projectId, t.id, w.operationId, { state: 'blocked', note: reason, ...end }, (task) => {
      if (task.status === 'in_progress' || task.status === 'in_review') {
        task.status = 'blocked';
        task.blockedReason = reason;
      }
    });
    return;
  }
  if (!commented && result.answer.trim()) addBoardComment(projectId, t.id, result.answer, by);
  setWork(projectId, t.id, w.operationId, { state: 'review', ...end }, (task) => {
    if (task.status === 'blocked') task.work!.state = 'blocked';
    else if (task.status === 'in_progress') task.status = 'in_review';
  });
}

/** Check saved work: looks again at work that needs review, by the id the page showed. */
export function checkWork(projectId: string, taskId: string, operationId: unknown): BoardTask {
  const p = projectOf(projectId);
  return withProject(p, () => {
    const t = savedBoardTask(projectId, taskId) || fail('That task is unavailable.', 404);
    if (!t.work || t.work.operationId !== operationId)
      return fail('This work changed meanwhile. Reload the task.', 409);
    if (t.work.state !== 'needs-review') return editBoardTask(projectId, taskId, () => false);
    const result = started(projectId, t.work);
    if (result.state === 'pending')
      setWork(projectId, taskId, t.work.operationId, {
        state: result.waiting ? 'waiting' : 'working',
        note: undefined,
        endedAt: undefined,
      });
    else if (result.state !== 'needs-review') settle(projectId, savedBoardTask(projectId, taskId)!, result);
    else setWork(projectId, taskId, t.work.operationId, { note: result.note });
    return editBoardTask(projectId, taskId, () => false);
  });
}

/** The loop that follows every task's work: wakes on runs, teams, briefs, approvals and the board, and every second. */
class BoardWorkLoop {
  private pending: Promise<void> | undefined;
  private again = false;
  // (the timer only looks again while some work goes; events wake it either way)
  private going = true;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly changed = (event: ServerEvent) => {
    if (['run', 'team', 'brief', 'approvals', 'board'].includes(event.type)) void this.wake();
  };

  start(): void {
    if (this.timer) return;
    bus.on('event', this.changed);
    this.timer = setInterval(() => void (this.going && this.wake()), 1000);
    this.timer.unref();
    void this.wake();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    bus.off('event', this.changed);
  }

  /** Resolves after a pass that started after this call (a wake during a pass runs one more). */
  wake(): Promise<void> {
    if (this.pending) {
      this.again = true;
      return this.pending;
    }
    this.pending = (async () => {
      do {
        this.again = false;
        await Promise.resolve();
        try {
          this.drain();
        } catch {
          /* the next pass tries again */
        }
      } while (this.again);
    })().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  /** One pass over every task with work going. */
  drain(): void {
    const list = tasksWithWork();
    this.going = list.length > 0;
    for (const { projectId, task } of list) {
      try {
        withProject(projectOf(projectId), () => settle(projectId, task, outcome(projectId, task.work!)));
      } catch (e) {
        try {
          setWork(projectId, task.id, task.work!.operationId, {
            state: 'needs-review',
            endedAt: Date.now(),
            note: `Its progress couldn't be read: ${e instanceof Error ? e.message : String(e)}`,
          });
        } catch {
          /* the task is gone */
        }
      }
    }
  }
}
export const boardWork = new BoardWorkLoop();

// ---------- the worker's tools ----------
/** The task a run works on: its conversation must be the task's, the work still going, and the run its worker's. */
export function workerTask(
  runId: string | null | undefined,
  agentId: string,
): { run: NonNullable<ReturnType<typeof runInfo>>; task: ProjectTask } {
  const unavailable = () =>
    fail(
      "This chat isn't working on a Tasks board task. board_task and board_reply only work in a task's own conversation.",
    );
  const run = runInfo(runId);
  if (!run || run.agentId !== agentId || run.signal.aborted) return unavailable();
  const m = /^board-([\w.-]+)$/.exec(run.conversationId || '');
  if (!m) return unavailable();
  return withProject(run.project, () => {
    const task = savedBoardTask(run.projectId, m[1]);
    const w = task?.work;
    if (!task || !isWorking(w) || w.conversationId !== run.conversationId) return unavailable();
    const chat = chats.get(run.agentId, run.chatId);
    // (the worker's chat or thread; for the Brain's work, the one it handed it to)
    const agentId = agentOf(w);
    const own = w.teamId ? chat?.teamId === w.teamId : !!agentId && run.agentId === agentId && run.chatId === w.chatId;
    return own ? { run, task } : unavailable();
  });
}

/** board_task: the task as its worker reads it. */
export function readWorkerTask(runId: string | null | undefined, agentId: string): string {
  const { run, task } = workerTask(runId, agentId);
  return withProject(run.project, () => {
    const all = boardTags(run.projectId);
    return `${assignment(run.project, task, tagsOf(task, all))}\n\nThe board's ${tagLine(all)}`;
  });
}

/** board_reply: a comment from the worker, with files, and its card moved to In review or Blocked. */
export async function workerReply(
  runId: string | null | undefined,
  agentId: string,
  args: {
    text?: unknown;
    files?: unknown;
    status?: unknown;
    reason?: unknown;
    addTags?: unknown;
    removeTags?: unknown;
  },
): Promise<string> {
  const { run, task } = workerTask(runId, agentId);
  const text = typeof args.text === 'string' ? args.text.trim() : '';
  const status =
    args.status === undefined || args.status === ''
      ? null
      : args.status === 'in_review' || args.status === 'blocked'
        ? args.status
        : fail('status must be in_review or blocked. Only the user moves a task to Done.');
  const reason = typeof args.reason === 'string' ? args.reason.trim() : '';
  if (status === 'blocked' && !reason && !text) return fail('Say why it is blocked (reason).');
  const by = `agent:${run.agentId}`;
  const files = await workerFiles(run, args.files, by);
  // (copying files takes a while: stopped, given to someone else or moved to Done meanwhile, this reply is not saved)
  if (workerTask(runId, agentId).task.work?.operationId !== task.work?.operationId)
    return fail("This task's work changed while the files were copied, so nothing was saved.");
  const retag = args.addTags !== undefined || args.removeTags !== undefined;
  if (!text && !files.length && !status && !retag) return fail('Give text, files, a status or tags.');
  return withProject(run.project, () => {
    // (tags first: a name that can't be a tag stops the reply before anything is saved)
    const tagged = retag
      ? changeBoardTask(run.projectId, task.id, { addTags: args.addTags, removeTags: args.removeTags }, undefined, by)
      : null;
    if (text || files.length) addBoardComment(run.projectId, task.id, text, by, files);
    if (status)
      editBoardTask(run.projectId, task.id, (t) => {
        t.status = status;
        if (status === 'blocked') t.blockedReason = reason || text;
        else delete t.blockedReason;
      });
    return [
      text || files.length
        ? `Commented on #${task.number}${files.length ? ` with ${files.length} file${files.length === 1 ? '' : 's'}` : ''}.`
        : '',
      status ? `Moved #${task.number} to ${status === 'in_review' ? 'In review' : 'Blocked'}.` : '',
      tagged
        ? tagged.tagList.length
          ? `Its tags: ${tagged.tagList.map(tagLabel).join(', ')}.`
          : 'It has no tags now.'
        : '',
    ]
      .filter(Boolean)
      .join(' ');
  });
}
