// Tasks board work: an assigned agent or team picks up a task in its own private conversation, and the card
// settles from the run, the team thread and the completion check.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { activeProject, chats, workflows } from '../../server/store.ts';
import { newAgent } from '../../server/library.ts';
import { admitExecution, updateExecution } from '../../server/execution.ts';
import { addBrief, updateBrief } from '../../server/briefs.ts';
import { getThread, isTeamBusy } from '../../server/teams.ts';
import { addBoardTask, changeBoardTask, editBoardTask, restoredBoard, savedBoardTask } from '../../server/taskboard.ts';
import { afterUserChange, boardWork, checkWork, startWork, stopWork, workerReply, BOARD_SENDER } from '../../server/boardwork.ts';
import { safeUploadsRoot } from '../../server/uploads.ts';
import type { Agent, Approval, Chat } from '../../shared/types.ts';

type RunOptions = { reservedRunId?: string; from?: string | null; attachments?: string[]; userInitiated?: boolean };
const calls = vi.hoisted(() => ({
  runs: [] as { agentId: string; chatId: string; text: string; options: RunOptions }[],
  approvals: [] as Approval[],
  scopes: new Map<string, unknown>(),
  stopped: [] as string[],
  queued: [] as { chatId: string; text: string }[],
}));
// Stop marks the chat's runs stopped, as the real one does once the run ends.
async function stopFake() {
  const { readExecution, updateExecution: update } = await import('../../server/execution.ts');
  return { stopChat: (chatId: string) => {
    calls.stopped.push(chatId);
    for (const r of readExecution().runs) if (r.chatId === chatId && r.status === 'running') update(r.id, { status: 'stopped' });
  } };
}
vi.mock('../../server/brain.ts', async (original) => ({ ...await original<typeof import('../../server/brain.ts')>(), brainModel: () => ({ provider: 'openrouter', model: 'mock' }), think: async () => 'Brain answer.' }));
vi.mock('../../server/approvals.ts', async (original) => ({ ...await original<typeof import('../../server/approvals.ts')>(), listApprovals: () => calls.approvals }));
vi.mock('../../server/engines/index.ts', async (original) => ({
  ...await original<typeof import('../../server/engines/index.ts')>(),
  ...await stopFake(),
  runInfo: (id: string) => calls.scopes.get(id) ?? null,
  askAgent: async () => 'Member final answer.',
  queueMessage: (_agent: Agent, chat: Chat, text: string) => { calls.queued.push({ chatId: chat.id, text }); return { runId: 'queued' }; },
  startRun: (agent: Agent, chat: Chat, text: string, options: RunOptions) => {
    calls.runs.push({ agentId: agent.id, chatId: chat.id, text, options });
    const id = options.reservedRunId!;
    admitExecution({ id, projectId: activeProject().id, agentId: agent.id, chatId: chat.id, engine: agent.engine, ownerChatId: chat.id, ownerAgentId: agent.id, parentRunId: null, depth: 0, text, from: options.from || null, attachments: options.attachments || [], startedAt: Date.now(), status: 'running' });
    return { runId: id, promise: Promise.resolve(''), signal: new AbortController().signal };
  },
}));
afterEach(() => { calls.runs = []; calls.approvals = []; calls.scopes.clear(); calls.stopped = []; calls.queued = []; });

const project = () => activeProject().id;
const task = (id: string) => savedBoardTask(project(), id)!;
/** You move a task the way the board's PUT route does. */
async function move(id: string, input: Parameters<typeof changeBoardTask>[2]) {
  const before = task(id);
  return afterUserChange(project(), before, changeBoardTask(project(), id, input));
}
/** A run of the task's worker, as runInfo sees it while it goes. */
function scope(agent: Agent, chatId: string, conversationId: string, id = 'tool-run') {
  calls.scopes.set(id, { id, agentId: agent.id, projectId: project(), chatId, conversationId, depth: 0, signal: new AbortController().signal, project: activeProject(), agent });
  return id;
}

describe('an agent picks up its task', () => {
  it('starts once in the task\'s own chat when you move it to In progress, and not from To do or the Brain\'s moves', async () => {
    const agent = newAgent({ name: 'Board writer' });
    const t = addBoardTask(project(), { title: 'Write the launch post', description: 'Two paragraphs.', assignee: `agent:${agent.id}` });
    await move(t.id, { status: 'todo', rank: 5 });
    changeBoardTask(project(), t.id, { status: 'in_progress' }); // the Brain's board_update path
    expect(calls.runs).toHaveLength(0);
    changeBoardTask(project(), t.id, { status: 'todo' });

    const card = await move(t.id, { status: 'in_progress' });
    expect(calls.runs).toHaveLength(1);
    const run = calls.runs[0];
    expect(run.text).toContain('Task #');
    expect(run.text).toContain('Write the launch post');
    expect(run.text).toContain('Two paragraphs.');
    expect(run.options).toMatchObject({ from: BOARD_SENDER, userInitiated: true, reservedRunId: card.work!.operationId });
    expect(card.work).toMatchObject({ state: 'working', runId: run.options.reservedRunId, chatId: run.chatId, conversationId: `board-${t.id}`, target: { kind: 'agent', id: agent.id } });
    expect(chats.get(agent.id, run.chatId)?.conversationId).toBe(`board-${t.id}`);
    expect(card.workerName).toBe('Board writer');

    // a second Start while it works does nothing
    await startWork(project(), t.id);
    expect(calls.runs).toHaveLength(1);
  });

  it('settles to In review with the answer as the worker\'s comment', async () => {
    const agent = newAgent({ name: 'Board finisher' });
    const t = addBoardTask(project(), { title: 'Sum the numbers', assignee: `agent:${agent.id}`, status: 'in_progress' });
    const started = await startWork(project(), t.id);
    await boardWork.wake();
    expect(task(t.id).work!.state).toBe('working');
    updateExecution(started.work!.runId!, { status: 'completed', answer: 'The total is 42.' });
    await boardWork.wake();
    const done = task(t.id);
    expect(done.status).toBe('in_review');
    expect(done.work).toMatchObject({ state: 'review' });
    expect(done.comments?.at(-1)).toMatchObject({ by: `agent:${agent.id}`, text: 'The total is 42.' });
  });

  it('follows the completion check: open waits, blocked moves the card with the reason and the Brain\'s note', async () => {
    const agent = newAgent({ name: 'Board blocked' });
    const t = addBoardTask(project(), { title: 'Deploy', assignee: `agent:${agent.id}`, status: 'in_progress' });
    const started = await startWork(project(), t.id);
    updateExecution(started.work!.runId!, { status: 'completed', answer: 'I need the server password.' });
    const brief = addBrief({ kind: 'agent', targetId: agent.id, name: agent.name, chatId: started.work!.chatId, messageId: started.work!.runId, text: 'Deploy', ts: Date.now() });
    await boardWork.wake();
    expect(task(t.id).work!.state).toBe('working');
    updateBrief(brief.id, { status: 'blocked', summary: 'It needs the server password.', userAction: 'Add the password to the agent\'s keys.' });
    await boardWork.wake();
    const blocked = task(t.id);
    expect(blocked).toMatchObject({ status: 'blocked', blockedReason: 'It needs the server password.' });
    expect(blocked.work).toMatchObject({ state: 'blocked' });
    expect(blocked.comments?.at(-1)).toMatchObject({ by: 'brain' });
    expect(blocked.comments?.at(-1)?.text).toContain('Add the password');
  });

  it('shows Needs you while an approval for its conversation waits', async () => {
    const agent = newAgent({ name: 'Board approver' });
    const t = addBoardTask(project(), { title: 'Send it', assignee: `agent:${agent.id}`, status: 'in_progress' });
    const started = await startWork(project(), t.id);
    const runId = scope(agent, started.work!.chatId!, `board-${t.id}`, started.work!.runId!);
    calls.approvals = [{ id: 'a1', title: 'Send', detail: '', kind: 'tool', agentId: agent.id, agentName: agent.name, data: { runId }, editable: null, createdAt: Date.now() }];
    await boardWork.wake();
    expect(task(t.id).work!.state).toBe('waiting');
  });

  it('stops when you move the task away or give it to someone else, and Stop does the same', async () => {
    const agent = newAgent({ name: 'Board stopper' });
    const other = newAgent({ name: 'Board other' });
    const t = addBoardTask(project(), { title: 'Long job', assignee: `agent:${agent.id}`, status: 'in_progress' });
    const first = await startWork(project(), t.id);
    const moved = await move(t.id, { status: 'todo' });
    expect(calls.stopped).toEqual([first.work!.chatId]);
    expect(moved.work!.state).toBe('stopped');

    await move(t.id, { status: 'in_progress' });
    const handed = await move(t.id, { assignee: `agent:${other.id}` });
    // the first agent is stopped and the new one starts, in a chat of its own
    expect(calls.stopped).toHaveLength(2);
    expect(handed.work).toMatchObject({ state: 'working', target: { id: other.id } });
    expect(calls.runs.at(-1)!.agentId).toBe(other.id);

    expect(stopWork(project(), t.id).work!.state).toBe('stopped');
  });

  it('passes your changed description to the worker while it works', async () => {
    const agent = newAgent({ name: 'Board listener' });
    const t = addBoardTask(project(), { title: 'Draft', assignee: `agent:${agent.id}`, status: 'in_progress' });
    const started = await startWork(project(), t.id);
    await move(t.id, { description: 'Make it shorter.' });
    expect(calls.queued).toEqual([{ chatId: started.work!.chatId, text: expect.stringContaining('Make it shorter.') }]);
  });

  it('puts saved work that never started in Needs review, and Check saved work wants the id the page showed', async () => {
    const agent = newAgent({ name: 'Board crashed' });
    const t = addBoardTask(project(), { title: 'Crashed', assignee: `agent:${agent.id}`, status: 'in_progress' });
    const started = await startWork(project(), t.id);
    // the dashboard stopped between saving the work and starting it
    editBoardTask(project(), t.id, (x) => { x.work = { ...x.work!, state: 'starting' }; });
    await boardWork.wake();
    expect(task(t.id).work).toMatchObject({ state: 'needs-review' });
    expect(calls.runs).toHaveLength(1);
    expect(() => checkWork(project(), t.id, 'another-operation')).toThrow('changed meanwhile');
    // its run was going after all: checking finds it working, and it settles as usual when it ends
    expect(checkWork(project(), t.id, started.work!.operationId).work).toMatchObject({ state: 'working' });
    updateExecution(started.work!.runId!, { status: 'completed', answer: 'All done.' });
    await boardWork.wake();
    expect(task(t.id)).toMatchObject({ status: 'in_review', work: { state: 'review' } });
  });
});

describe('a team picks up its task', () => {
  it('posts the task in a private thread of its own and settles from the members\' answer', async () => {
    const agent = newAgent({ name: 'Board team member' });
    const team = workflows.save({ name: 'Board team', members: [agent.id], lead: agent.id, steps: [] });
    const t = addBoardTask(project(), { title: 'Research rivals', assignee: `team:${team.id}` });
    const starting = await move(t.id, { status: 'in_progress' });
    // (a team first picks who takes it: the card says Starting meanwhile)
    expect(starting.work!.state).toBe('starting');
    await expect.poll(() => task(t.id).work!.messageId).toBeTruthy();
    const card = task(t.id);
    const teamId = card.work!.teamId!;
    expect(teamId).not.toBe(team.id);
    expect(card.work).toMatchObject({ target: { kind: 'team', id: team.id }, messageId: card.work!.operationId });
    const thread = getThread(teamId);
    expect(thread.messages.find((m) => m.id === card.work!.messageId)).toMatchObject({ text: expect.stringContaining('Research rivals') });
    // the team's main chat doesn't get it
    expect(getThread(team.id).messages.some((m) => m.id === card.work!.messageId)).toBe(false);
    await expect.poll(() => isTeamBusy(teamId)).toBe(false);
    await boardWork.wake();
    const done = task(t.id);
    expect(done.status).toBe('in_review');
    expect(done.comments?.at(-1)).toMatchObject({ by: `team:${team.id}`, text: 'Member final answer.' });
  });
});

describe('the worker\'s tools', () => {
  it('comment and move only the worker\'s own task, never to Done, with files from its workspace copied in', async () => {
    const agent = newAgent({ name: 'Board tool user' });
    const t = addBoardTask(project(), { title: 'Make a chart', assignee: `agent:${agent.id}`, status: 'in_progress' });
    const started = await startWork(project(), t.id);
    const runId = scope(agent, started.work!.chatId!, `board-${t.id}`);
    await expect(workerReply(runId, agent.id, { text: 'Done', status: 'done' })).rejects.toThrow('Only the user');
    await expect(workerReply(runId, agent.id, { status: 'blocked' })).rejects.toThrow('why');
    await expect(workerReply(runId, 'someone-else', { text: 'Hi' })).rejects.toThrow('isn\'t working on a Tasks board task');
    const elsewhere = scope(agent, 'some-chat', 'board-other', 'other-run');
    await expect(workerReply(elsewhere, agent.id, { text: 'Hi' })).rejects.toThrow('isn\'t working on a Tasks board task');

    const brain = activeProject().brainPath;
    const chart = path.join(brain, 'chart.png');
    fs.writeFileSync(chart, 'png bytes');
    const secret = path.join(brain, '.env');
    fs.writeFileSync(secret, 'KEY=1');
    await expect(workerReply(runId, agent.id, { text: 'x', files: [secret] })).rejects.toThrow('cannot be attached');
    const outside = path.join(process.env.DASH_DATA!, 'secrets.json');
    await expect(workerReply(runId, agent.id, { text: 'x', files: [outside] })).rejects.toThrow('cannot be attached');
    const link = path.join(brain, 'chart-link.png');
    fs.symlinkSync(chart, link);
    await expect(workerReply(runId, agent.id, { text: 'x', files: [link] })).rejects.toThrow('cannot be attached');

    expect(await workerReply(runId, agent.id, { text: 'Here is the chart.', files: [chart], status: 'in_review' })).toContain('In review');
    const after = task(t.id);
    expect(after.status).toBe('in_review');
    const comment = after.comments!.at(-1)!;
    expect(comment).toMatchObject({ by: `agent:${agent.id}`, text: 'Here is the chart.' });
    expect(comment.files).toHaveLength(1);
    const file = comment.files![0];
    expect(file).toMatchObject({ name: 'chart.png', size: 9, by: `agent:${agent.id}` });
    expect(file.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(fs.readFileSync(path.join(safeUploadsRoot()!, file.path), 'utf8')).toBe('png bytes');

    // the run ended: its settled answer isn't repeated, because it already commented
    updateExecution(started.work!.runId!, { status: 'completed', answer: 'Finished the chart.' });
    await boardWork.wake();
    expect(task(t.id).comments).toHaveLength(1);
    expect(task(t.id).work!.state).toBe('review');
  });
});

describe('files you attach', () => {
  it('stay where they are in the open project, and are copied into a task in another project', async () => {
    const { createProject } = await import('../../server/projects.ts');
    const { filesFromRequest } = await import('../../server/boardfiles.ts');
    const { newBatch } = await import('../../server/uploads.ts');
    const { dir } = newBatch();
    const upload = path.join(dir, 'brief.txt');
    fs.writeFileSync(upload, 'The brief');
    const here = activeProject();
    const [same] = await filesFromRequest(here, [upload]);
    expect(same).toMatchObject({ path: `${path.basename(dir)}/brief.txt`, name: 'brief.txt', size: 9, by: 'you' });
    const other = await createProject({ name: 'Board files elsewhere' });
    // (making a project opens it: the open one is still where the upload is)
    const { setActiveProject } = await import('../../server/store.ts');
    setActiveProject(here.id);
    const [copied] = await filesFromRequest(other, [upload]);
    expect(copied.sha256).toMatch(/^[a-f0-9]{64}$/);
    const { withProject } = await import('../../server/store.ts');
    const otherRoot = withProject(other, () => safeUploadsRoot()!);
    expect(fs.readFileSync(path.join(otherRoot, copied.path), 'utf8')).toBe('The brief');
    // a path that isn't an upload of the open project is left out; files already on the task stay by their path
    expect(await filesFromRequest(here, [path.join(activeProject().brainPath, 'not-uploaded.txt')])).toEqual([]);
    expect(await filesFromRequest(here, [same.path], [same])).toEqual([same]);
    // as many as you attach (a chat message carries 50; a task has no limit)
    const many = Array.from({ length: 60 }, (_, i) => {
      const f = path.join(dir, `page-${i}.txt`);
      fs.writeFileSync(f, String(i));
      return f;
    });
    expect(await filesFromRequest(here, many)).toHaveLength(60);
  });
});

describe('saved copies of the board', () => {
  it('keep files inside the uploads folder and leave work behind', () => {
    const board = restoredBoard({ tasks: [{
      id: 't1', title: 'Copied', status: 'in_progress',
      files: [{ path: 'batch/a.txt', name: 'a.txt', size: 3, by: 'you', at: 1 }, { path: '../escape.txt', name: 'x', size: 1 }, { path: '/etc/passwd', name: 'p', size: 1 }],
      work: { operationId: 'r1', conversationId: 'board-t1', target: { kind: 'agent', id: 'a' }, startedAt: 1, state: 'working' },
      comments: [{ id: 'c1', text: '', by: 'agent:a', files: [{ path: 'batch/b.png', name: 'b.png', size: 2, by: 'agent:a', at: 2 }] }],
    }] });
    const [t] = board.tasks;
    expect(t.files).toEqual([{ path: 'batch/a.txt', name: 'a.txt', size: 3, by: 'you', at: 1 }]);
    expect(t.work).toBeUndefined();
    expect(t.comments?.[0].files?.[0].name).toBe('b.png');
  });
});
