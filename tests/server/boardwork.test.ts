// Tasks board work: an assigned agent, team or the Brain picks up a task in its own private conversation, and the card
// settles from the run, the team thread, the Brain's answer and the completion check.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { activeProject, chats, workflows } from '../../server/store.ts';
import { newAgent } from '../../server/library.ts';
import { admitExecution, updateExecution } from '../../server/execution.ts';
import { addBrief, listBriefs, updateBrief } from '../../server/briefs.ts';
import { history } from '../../server/overseer.ts';
import { getThread, isTeamBusy } from '../../server/teams.ts';
import { addBoardTask, changeBoardTask, editBoardTask, restoredBoard, savedBoardTask } from '../../server/taskboard.ts';
import { afterUserChange, boardWork, canPickUp, checkWork, startWork, stopWork, workerReply, BOARD_SENDER } from '../../server/boardwork.ts';
import { safeUploadsRoot } from '../../server/uploads.ts';
import { agentBoardTags } from '../../server/boardtagtools.ts';
import { createProject } from '../../server/projects.ts';
import { setActiveProject } from '../../server/store.ts';
import { addBoardTag, boardTags, boardTask } from '../../server/taskboard.ts';
import type { Agent, Approval, Chat } from '../../shared/types.ts';

type RunOptions = { reservedRunId?: string; from?: string | null; attachments?: string[]; userInitiated?: boolean };
const calls = vi.hoisted(() => ({
  runs: [] as { agentId: string; chatId: string; text: string; options: RunOptions }[],
  approvals: [] as Approval[],
  scopes: new Map<string, unknown>(),
  stopped: [] as string[],
  queued: [] as { chatId: string; text: string }[],
  // what the Brain's model answers (the prompt it was given is kept)
  think: (_system: string, _user: string): string | Promise<string> => 'Brain answer.',
  asked: [] as string[],
}));
// Stop marks the chat's runs stopped, as the real one does once the run ends.
async function stopFake() {
  const { readExecution, updateExecution: update } = await import('../../server/execution.ts');
  return { stopChat: (chatId: string) => {
    calls.stopped.push(chatId);
    for (const r of readExecution().runs) if (r.chatId === chatId && r.status === 'running') update(r.id, { status: 'stopped' });
  } };
}
vi.mock('../../server/brain.ts', async (original) => ({
  ...await original<typeof import('../../server/brain.ts')>(),
  brainModel: () => ({ provider: 'openrouter', model: 'mock' }),
  think: async (system: string, user: string) => (calls.asked.push(user), calls.think(system, user)),
}));
vi.mock('../../server/approvals.ts', async (original) => ({ ...await original<typeof import('../../server/approvals.ts')>(), listApprovals: () => calls.approvals }));
vi.mock('../../server/engines/index.ts', async (original) => ({
  ...await original<typeof import('../../server/engines/index.ts')>(),
  ...await stopFake(),
  runInfo: (id: string) => calls.scopes.get(id) ?? null,
  askAgent: async () => 'Member final answer.',
  queueMessage: (_agent: Agent, chat: Chat, text: string) => { calls.queued.push({ chatId: chat.id, text }); return { runId: 'queued' }; },
  startRun: (agent: Agent, chat: Chat, text: string, options: RunOptions) => {
    calls.runs.push({ agentId: agent.id, chatId: chat.id, text, options });
    const id = options.reservedRunId || `brief-run-${calls.runs.length}`;
    admitExecution({ id, projectId: activeProject().id, agentId: agent.id, chatId: chat.id, engine: agent.engine, ownerChatId: chat.id, ownerAgentId: agent.id, parentRunId: null, depth: 0, text, from: options.from || null, attachments: options.attachments || [], startedAt: Date.now(), status: 'running' });
    return { runId: id, promise: Promise.resolve(''), signal: new AbortController().signal };
  },
}));
afterEach(() => { calls.runs = []; calls.approvals = []; calls.scopes.clear(); calls.stopped = []; calls.queued = []; calls.think = () => 'Brain answer.'; calls.asked = []; });

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

describe('the Brain picks up its task', () => {
  const actions = (list: unknown[]) => `\n\`\`\`actions\n${JSON.stringify(list)}\n\`\`\``;

  it('answers it in the task\'s own conversation and settles to In review with its answer', async () => {
    expect(canPickUp('brain')).toBe(true);
    expect(canPickUp('you')).toBe(false);
    calls.think = () => 'I checked the settings: everything is in place.';
    const t = addBoardTask(project(), { title: 'Check the settings', description: 'Make sure the keys are set.', assignee: 'brain' });
    await move(t.id, { status: 'todo', rank: 3 });
    changeBoardTask(project(), t.id, { status: 'in_progress' }); // the Brain's own board_update path
    expect(calls.asked).toHaveLength(0);
    changeBoardTask(project(), t.id, { status: 'todo' });

    const card = await move(t.id, { status: 'in_progress' });
    expect(card.work).toMatchObject({ target: { kind: 'brain', id: 'brain' }, conversationId: `board-${t.id}` });
    expect(card.workerName).toBe('The Brain');
    await expect.poll(() => task(t.id).status).toBe('in_review');
    // it was told the task, as a message from the board, and sees only this task of the board
    const prompt = calls.asked[0];
    expect(prompt).toContain(`Task #${t.number}`);
    expect(prompt).toContain('Make sure the keys are set.');
    expect(prompt).toContain('given to you, the Brain');
    expect(prompt).toContain(`USER (${BOARD_SENDER})`);
    expect(history(project(), `board-${t.id}`).at(-1)).toMatchObject({ role: 'brain', text: 'I checked the settings: everything is in place.', operationId: card.work!.operationId });
    const done = task(t.id);
    expect(done.work).toMatchObject({ state: 'review' });
    expect(done.comments?.at(-1)).toMatchObject({ by: 'brain', text: 'I checked the settings: everything is in place.' });
    expect(done.comments).toHaveLength(1);
  });

  it('hands it to an agent in the task\'s chat, and the board follows that agent\'s work', async () => {
    const agent = newAgent({ name: 'Brain helper' });
    calls.think = () => `I gave this to the Brain helper.${actions([{ do: 'delegate', to: 'agent', id: agent.id, message: `Write the summary for task #1 on the Tasks board.` }])}`;
    const t = addBoardTask(project(), { title: 'Write the summary', assignee: 'brain' });
    await move(t.id, { status: 'in_progress' });
    await expect.poll(() => task(t.id).work!.runId).toBeTruthy();
    const w = task(t.id).work!;
    expect(w).toMatchObject({ state: 'working', target: { kind: 'brain' }, handedTo: { kind: 'agent', id: agent.id } });
    const run = calls.runs.at(-1)!;
    expect(run).toMatchObject({ agentId: agent.id, chatId: w.chatId, options: { from: 'the Brain' } });
    expect(chats.get(agent.id, w.chatId!)?.conversationId).toBe(`board-${t.id}`);
    // what the Brain said as it handed it on is on the task
    expect(task(t.id).comments?.at(-1)).toMatchObject({ by: 'brain', text: 'I gave this to the Brain helper.' });

    // the agent it handed it to may use the task's board tools; another agent may not
    const runId = scope(agent, w.chatId!, `board-${t.id}`);
    expect(await workerReply(runId, agent.id, { text: 'Here is a first draft.' })).toContain('Commented');
    const stranger = newAgent({ name: 'Brain stranger' });
    await expect(workerReply(scope(stranger, w.chatId!, `board-${t.id}`, 'stranger-run'), stranger.id, { text: 'Hi' })).rejects.toThrow('isn\'t working on a Tasks board task');

    // your comment while it works reaches that agent
    const { passToWorker } = await import('../../server/boardwork.ts');
    await passToWorker(project(), t.id, 'Keep it short.');
    expect(calls.queued).toEqual([{ chatId: w.chatId, text: 'Keep it short.' }]);

    // the brief the Brain opened settles it
    updateExecution(w.runId!, { status: 'completed', answer: 'The summary is done.' });
    await boardWork.wake();
    expect(task(t.id).work!.state).toBe('working');
    const brief = listBriefs().findLast((b) => b.kind === 'agent' && b.targetId === agent.id && b.chatId === w.chatId)!;
    updateBrief(brief.id, { status: 'done', summary: 'Summary written.' });
    await boardWork.wake();
    const done = task(t.id);
    expect(done).toMatchObject({ status: 'in_review', work: { state: 'review' } });
    // (the agent commented itself, so its answer isn't repeated)
    expect(done.comments?.map((c) => c.by)).toEqual(['brain', `agent:${agent.id}`]);
  });

  it('changes nothing when you stop it while it thinks', async () => {
    let answer: (text: string) => void = () => {};
    calls.think = () => new Promise<string>((resolve) => { answer = resolve; });
    const t = addBoardTask(project(), { title: 'Think it over', assignee: 'brain', status: 'in_progress' });
    await startWork(project(), t.id);
    await expect.poll(() => calls.asked.length).toBe(1);
    expect(task(t.id).work!.state).toBe('starting');
    expect(stopWork(project(), t.id).work!.state).toBe('stopped');
    answer(`Noted.${actions([{ do: 'board_comment', task: `#${t.number}`, text: 'Should not be saved.' }])}`);
    await new Promise((r) => setTimeout(r, 50));
    await boardWork.wake();
    expect(task(t.id).work!.state).toBe('stopped');
    expect(task(t.id).comments ?? []).toHaveLength(0);
  });

  it('may change only its own task there, and an action that fails puts the work in Needs review', async () => {
    const other = addBoardTask(project(), { title: 'Someone else\'s task' });
    calls.think = () => `Moved it.${actions([{ do: 'board_update', task: `#${other.number}`, status: 'done' }])}`;
    const t = addBoardTask(project(), { title: 'Tidy the board', assignee: 'brain', status: 'in_progress' });
    await startWork(project(), t.id);
    await expect.poll(() => task(t.id).work!.state).toBe('needs-review');
    expect(task(t.id).work!.note).toContain('only that task can be changed');
    expect(task(other.id).status).toBe('todo');
    expect(task(t.id).status).toBe('in_progress');
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

describe('board tags for agents', () => {
  const names = (projectId: string, id: string) => boardTask(projectId, id).tagList.map((x) => x.name);

  it('lets any agent tag any task of its run\'s project, make, rename and delete tags, signed as the agent', async () => {
    const agent = newAgent({ name: 'Board tagger' });
    const runId = scope(agent, 'tagger-chat', '');
    const t = addBoardTask(project(), { title: 'Tag me' });
    expect(agentBoardTags(runId, agent.id, { action: 'create', name: '🐛 Bug' })).toBe('Made tag 🐛 Bug.');
    expect(agentBoardTags(runId, agent.id, { action: 'create', name: 'bug' })).toBe('Tag 🐛 Bug is there already (on 0 tasks).');
    expect(agentBoardTags(runId, agent.id, { action: 'tag', task: `#${t.number}`, add: ['Bug', '🎨 Design'] })).toBe(`Tagged #${t.number} Tag me: 🐛 Bug, 🎨 Design.`);
    expect(boardTags(project()).find((x) => x.name === 'Design')).toMatchObject({ createdBy: `agent:${agent.id}`, tasks: 1 });
    // re-tag in one call
    agentBoardTags(runId, agent.id, { action: 'tag', task: 'Tag me', remove: ['design'], add: ['Docs'] });
    expect(names(project(), t.id)).toEqual(['Bug', 'Docs']);
    expect(agentBoardTags(runId, agent.id, { action: 'list' })).toContain('🐛 Bug (1)');
    expect(agentBoardTags(runId, agent.id, { action: 'edit', name: 'Docs', rename: '📝 Writing' })).toBe('Tag Docs is now 📝 Writing (on 1 task).');
    expect(agentBoardTags(runId, agent.id, { action: 'delete', name: 'writing' })).toBe('Deleted tag 📝 Writing; it came off 1 task.');
    expect(agentBoardTags(runId, agent.id, { action: 'tag', task: `#${t.number}`, tags: [] })).toBe(`#${t.number} Tag me has no tags now.`);
    expect(() => agentBoardTags(runId, agent.id, { action: 'edit', name: 'Nope', rename: 'x' })).toThrow('No tag "Nope" on the board.');
    expect(() => agentBoardTags(runId, agent.id, { action: 'edit', name: 'Bug' })).toThrow('Give rename or emoji.');
    expect(() => agentBoardTags(runId, agent.id, { action: 'tag', task: '#999', add: ['Bug'] })).toThrow('no task "#999"');
    expect(() => agentBoardTags(runId, agent.id, { action: 'tag', task: `#${t.number}` })).toThrow('Give tags, add or remove.');
    expect(() => agentBoardTags(runId, agent.id, { action: 'shout' })).toThrow('action must be list, find, tag, create, edit or delete.');
  });

  it('works in its run\'s own project, not the open one, and not in a gateway conversation or another agent\'s run', async () => {
    const open = activeProject();
    const agent = newAgent({ name: 'Board elsewhere tagger' });
    const runId = scope(agent, 'elsewhere-chat', '');
    const other = await createProject({ name: 'Tags other project' });
    setActiveProject(open.id);
    const theirs = addBoardTask(other.id, { title: 'Theirs' });
    // the run belongs to the project that was open when it started; a project opened since doesn't change that
    setActiveProject(other.id);
    agentBoardTags(runId, agent.id, { action: 'create', name: 'Run project only' });
    expect(boardTags(open.id).some((x) => x.name === 'Run project only')).toBe(true);
    expect(boardTags(other.id).some((x) => x.name === 'Run project only')).toBe(false);
    expect(() => agentBoardTags(runId, agent.id, { action: 'tag', task: theirs.id, add: ['x'] })).toThrow('no task');
    setActiveProject(open.id);

    const gateway = scope(agent, 'gateway-chat', 'a'.repeat(64), 'gateway-run');
    expect(() => agentBoardTags(gateway, agent.id, { action: 'list' })).toThrow('isn\'t available in this conversation');
    expect(() => agentBoardTags(gateway, agent.id, { action: 'find', tags: ['x'] })).toThrow('isn\'t available in this conversation');
    expect(() => agentBoardTags(runId, 'someone-else', { action: 'list' })).toThrow('That run is not available to you.');
    // a task's own conversation is a normal chat for this
    const own = scope(agent, 'own-chat', 'board-some-task', 'own-run');
    expect(agentBoardTags(own, agent.id, { action: 'list' })).toMatch(/^TAGS: /);
  });

  it('finds tasks by tag for any agent', () => {
    const agent = newAgent({ name: 'Board finder' });
    const runId = scope(agent, 'finder-chat', '');
    addBoardTag(project(), { name: '🧪 Finder test' });
    addBoardTask(project(), { title: 'Found one', tags: ['finder test'] });
    expect(agentBoardTags(runId, agent.id, { action: 'find', tags: ['Finder test'] })).toMatch(/^#\d+ \[To do\] Found one \| unassigned \| tags: 🧪 Finder test$/);
    expect(agentBoardTags(runId, agent.id, { action: 'find', tags: ['finder test', 'no such tag'], match: 'all' })).toMatch(/^No tasks match\.\nNo tag called: no such tag\. TAGS: /);
  });

  it('lets a worker tag its own task as it replies, and reads the board\'s tags with board_task', async () => {
    const agent = newAgent({ name: 'Board reply tagger' });
    const t = addBoardTask(project(), { title: 'Reply and tag', assignee: `agent:${agent.id}`, status: 'in_progress', tags: ['Ops'] });
    const started = await startWork(project(), t.id);
    expect(calls.runs.at(-1)!.text).toContain('Tags: Ops');
    // a task whose tag ids point at no tag (a hand-edited board) gets no empty Tags line
    const bare = addBoardTask(project(), { title: 'Lost its tag', assignee: `agent:${agent.id}` });
    editBoardTask(project(), bare.id, (x) => void (x.tags = ['tag0000000000000000']));
    await startWork(project(), bare.id);
    expect(calls.runs.at(-1)!.text).not.toContain('Tags:');
    const runId = scope(agent, started.work!.chatId!, `board-${t.id}`);
    expect(await workerReply(runId, agent.id, { addTags: ['✅ Checked'], removeTags: ['ops'] })).toBe('Its tags: ✅ Checked.');
    expect(await workerReply(runId, agent.id, { text: 'Done.', status: 'in_review', removeTags: ['checked'] })).toBe(`Commented on #${t.number}. Moved #${t.number} to In review. It has no tags now.`);
    await expect(workerReply(runId, agent.id, { addTags: [7] })).rejects.toThrow('addTags must be a list of tag names.');
    // nothing of the refused reply was saved
    expect(task(t.id).comments).toHaveLength(1);
  });
});
