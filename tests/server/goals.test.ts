// /goal: the Brain checks each turn against your goal and follows up until it is met (agent and team
// chats, and from the Brain chat); /stop and /resume in the Brain chat. With fake models for both.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ask, clearHistory } from '../../server/overseer.ts';
import { recoverWork, startIrc } from '../../server/irc.ts';
import { addBrief, listBriefs, openGoal } from '../../server/briefs.ts';
import { goalTool } from '../../server/goaltool.ts';
import { goalInChat, goalInTeam, resumeBrain, stopBrain } from '../../server/commands.ts';
import { newAgent } from '../../server/library.ts';
import { activeRuns, chatRunId, startRun, queueMessage, stopChat, forgetChat } from '../../server/engines/index.ts';
import { agents, chats, questions, saveSettings, workflows } from '../../server/store.ts';
import { clearThread, getThread, postUserMessage, stopTeam, teamState } from '../../server/teams.ts';
import { addQuestion, answerQuestion } from '../../server/questions.ts';
import { NO_PROGRESS_LIMIT } from '../../shared/commands.ts';
import { createTask, savedTasks, updateTask } from '../../server/tasks.ts';
import type { ChatItem, Team } from '../../shared/types.ts';

// the Brain's model: verdicts on the work, answers in the Brain chat (a promise: one that takes a while)
const verdicts: (string | Promise<string> | Error)[] = [];
const answers: (string | Promise<string>)[] = [];
const checked: string[] = [];
const checkedSystems: string[] = [];
const brainRequests: string[] = [];
vi.mock('../../server/brainrun.ts', async (orig) => ({
  ...(await orig<typeof import('../../server/brainrun.ts')>()),
  runBrain: (await import('./brain-fake.ts')).thinkingBrain,
}));
vi.mock('../../server/brain.ts', async (orig) => ({
  ...(await orig<typeof import('../../server/brain.ts')>()),
  brainModel: () => ({ provider: 'openrouter', model: 'mock', effort: '', fallback: false }),
  think: async (system: string, user: string) => {
    if (system.includes('Decide whether the brief is done')) {
      checked.push(user);
      checkedSystems.push(system);
      const v = verdicts.shift();
      if (v instanceof Error) throw v;
      return (await v) ?? '{"done":true,"summary":"Looks done."}';
    }
    brainRequests.push(user);
    return (await answers.shift()) ?? 'NOTHING';
  },
}));

// the agents' model: "Holder" answers only when the test lets it go, the rest at once
const held: (() => void)[] = [];
const calls = new Map<string, number>();
let childId = '';
let server: http.Server;
beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    if (req.url?.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'mock' }] }));
    let body = '';
    for await (const c of req) body += c;
    const j = JSON.parse(body) as { messages: { role: string; content: string | { text?: string }[] }[] };
    const text = (c: string | { text?: string }[]) => (typeof c === 'string' ? c : c.map((x) => x.text || '').join(''));
    const name = /You are ([A-Z]\w+)/.exec(text(j.messages[0].content))?.[1] || '';
    const n = (calls.get(name) || 0) + 1;
    calls.set(name, n);
    if (name === 'Broken' || name === 'Offline' || (name === 'Transient' && n === 1)) {
      res.writeHead(name === 'Broken' ? 401 : 503, { 'content-type': 'application/json' });
      return res.end(
        JSON.stringify({ error: { message: name === 'Broken' ? 'Authentication failed' : '503 overloaded' } }),
      );
    }
    if (name === 'Holder') await new Promise<void>((go) => held.push(go));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (name === 'Taskworker') {
      const last = j.messages.at(-1)!;
      const result =
        last.role === 'tool' ? (JSON.parse(text(last.content)) as { task?: { id: string }; success?: boolean }) : null;
      const fn = !result
        ? {
            name: 'TaskCreate',
            arguments: JSON.stringify({
              subject: 'Verify the task',
              description: 'Check the result before marking complete.',
            }),
          }
        : result.task
          ? { name: 'TaskUpdate', arguments: JSON.stringify({ taskId: result.task.id, status: 'completed' }) }
          : null;
      if (fn) {
        res.write(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `task-${n}`, type: 'function', function: fn }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`,
        );
        return res.end();
      }
    }
    if (['Evidence', 'Delegator'].includes(name) && j.messages.at(-1)?.role === 'user') {
      const fn =
        name === 'Evidence'
          ? { name: 'list_agents', arguments: '{}' }
          : { name: 'ask_agent', arguments: JSON.stringify({ agent: childId, message: 'Finish the delegated part.' }) };
      res.write(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'tool-one', type: 'function', function: fn }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`,
      );
      return res.end();
    }
    res.write(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: `${name} worked on it.${name === 'Repeater' ? '' : ` Result ${n}.`}` } }] })}\n\n`,
    );
    res.write(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
    );
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  saveSettings({
    providers: {
      custom: { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, label: 'Fake model' },
    },
  });
  startIrc();
});
afterAll(() => {
  held.splice(0).forEach((go) => go());
  return new Promise<void>((r) => server.close(() => r()));
});
beforeEach(() => {
  saveSettings({ brainFollowsUp: true });
  clearHistory();
  verdicts.length = 0;
  checked.length = 0;
  checkedSystems.length = 0;
  brainRequests.length = 0;
});

const until = async (ok: () => boolean, ms = 8000) => {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (ok()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('timed out');
};
const agent = (name: string) => newAgent({ name, engine: 'eve', provider: 'custom', model: 'mock', toolGroups: [] });
const items = (agentId: string, chatId: string): ChatItem[] => chats.get(agentId, chatId)?.items || [];
const users = (agentId: string, chatId: string) =>
  items(agentId, chatId)
    .filter((i) => i.type === 'user')
    .map((i) => (i.type === 'user' ? `${i.from || 'you'}: ${i.text.split('\n')[0]}` : ''));
const notes = (agentId: string, chatId: string) =>
  items(agentId, chatId)
    .filter((i) => i.type === 'meta')
    .map((i) => i.text);
const notDone = (followUp: string) => JSON.stringify({ done: false, followUp, summary: 'Not there yet.' });
const briefIn = (chatId: string) => listBriefs().findLast((b) => b.chatId === chatId)!;

describe('ordinary assignments keep going automatically', () => {
  it('lets an API agent create and finish a saved task with real core tools', async () => {
    const a = agent('Taskworker');
    const c = chats.create(a.id);
    startRun(a, c, 'Finish the assignment and track the work.');
    await until(() => briefIn(c.id)?.status === 'done');
    const t = savedTasks().find((t) => t.scope.kind === 'agent' && t.scope.id === a.id)!;
    expect(t).toMatchObject({ status: 'completed', briefId: briefIn(c.id).id });
    expect(checked.at(-1)).toContain('Verify the task');
  });

  it('does not accept a done verdict while linked saved tasks are still unfinished', async () => {
    const a = agent('Heldtask');
    const c = chats.create(a.id);
    let release!: (s: string) => void;
    verdicts.push(
      new Promise<string>((r) => {
        release = r;
      }),
    );
    startRun(a, c, 'Finish the saved steps.');
    await until(() => checked.length === 1);
    const t = createTask(
      { subject: 'Required check', description: 'Must be verified.' },
      { admin: true, scope: { kind: 'agent', id: a.id }, briefId: briefIn(c.id).id },
    );
    verdicts.push(
      JSON.stringify({
        done: false,
        blocked: true,
        userAction: 'Provide the required test fixture.',
        summary: 'The check needs a fixture.',
      }),
    );
    release('{"done":true,"summary":"Claimed done too early."}');
    await until(() => briefIn(c.id)?.status === 'blocked');
    expect(users(a.id, c.id).at(-1)).toContain('unfinished saved tasks');
    updateTask({ taskId: t.id, status: 'deleted' }, { admin: true, scope: { kind: 'brain' } });
  });

  it('gives the Brain task creation, dependency updates and full TaskGet results', async () => {
    const unique = `Brain plan ${Date.now()}`;
    answers.push(
      `Saved the plan.\n\`\`\`actions\n${JSON.stringify([
        { do: 'TaskCreate', subject: `${unique} write`, description: 'Detailed requirements: ALPHA_DETAIL.' },
        { do: 'TaskCreate', subject: `${unique} check`, description: 'Verify the deliverable.' },
        { do: 'TaskUpdate', taskId: 'new', addBlockedBy: [`${unique} write`] },
      ])}\n\`\`\``,
    );
    const result = await ask('Create a writing and verification task plan.');
    expect(result.done.filter((d) => d.kind === 'task')).toHaveLength(3);
    const tasks = savedTasks().filter((t) => t.subject.startsWith(unique));
    expect(tasks[1].blockedBy).toEqual([tasks[0].id]);
    answers.push(
      `Opening task.\n\`\`\`actions\n[{"do":"TaskGet","taskId":"${tasks[0].id}"}]\n\`\`\``,
      'The task includes ALPHA_DETAIL.',
    );
    await ask('Read the full writing task.');
    expect(brainRequests.at(-1)).toContain('TOOL RESULTS');
    expect(brainRequests.at(-1)).toContain('ALPHA_DETAIL');
    answers.push(
      `Listing tasks.\n\`\`\`actions\n${JSON.stringify([{ do: 'TaskList', search: unique, limit: 1, offset: 1 }])}\n\`\`\``,
      'Found the requested task page.',
    );
    await ask('Read the second task page.');
    // (the tasks tool's result, after its line in the results)
    const lookup = brainRequests.at(-1)!.split('--- tasks ')[1].split(' ---\n')[1];
    expect(JSON.parse(lookup)).toMatchObject({ total: 2, nextOffset: null });
    expect(JSON.parse(lookup).tasks).toHaveLength(1);
  });
  it('lets the Brain create and update batches with per-item failures and ordered dependencies', async () => {
    const unique = `Brain batch ${Date.now()}`;
    answers.push(
      `Saving tasks.\n\`\`\`actions\n${JSON.stringify([
        {
          do: 'TaskCreate',
          tasks: [
            { subject: `${unique} build`, description: 'Build the result.' },
            { subject: '', description: 'Bad item.' },
            { subject: `${unique} check`, description: 'Verify the result.' },
          ],
        },
        {
          do: 'TaskUpdate',
          tasks: [
            { taskId: `${unique} check`, addBlockedBy: [`${unique} build`] },
            { taskId: 'missing task', status: 'completed' },
            { taskId: `${unique} build`, status: 'completed' },
            { taskId: `${unique} check`, status: 'completed' },
          ],
        },
      ])}\n\`\`\``,
    );
    const result = await ask('Save and finish a two-step task plan.');
    expect(result.done.filter((d) => d.kind === 'task')).toHaveLength(5);
    expect(result.done.filter((d) => d.kind === 'error')).toHaveLength(2);
    expect(result.done.filter((d) => d.kind === 'error').every((d) => d.text.includes('item 2'))).toBe(true);
    const tasks = savedTasks().filter((t) => t.subject.startsWith(unique));
    expect(tasks.map((t) => t.status)).toEqual(['completed', 'completed']);
    expect(tasks[1].blockedBy).toEqual([tasks[0].id]);
  });

  it('binds all successful Brain batch tasks to the delegated assignment before it starts', async () => {
    const a = agent('Holder');
    const unique = `Delegated batch ${Date.now()}`;
    answers.push(
      `Handing it on.\n\`\`\`actions\n${JSON.stringify([
        {
          do: 'TaskCreate',
          tasks: [
            { subject: `${unique} first`, description: 'First requirement.', scope: { kind: 'agent', id: a.id } },
            { subject: `${unique} second`, description: 'Second requirement.', scope: { kind: 'agent', id: a.id } },
          ],
        },
        { do: 'delegate', to: 'agent', id: a.id, message: 'Finish both saved tasks.' },
      ])}\n\`\`\``,
    );
    const result = await ask('Finish both requirements.');
    const chatId = result.delegate!.sent!.chatId!;
    await until(() => held.length > 0);
    const brief = briefIn(chatId);
    const tasks = savedTasks().filter((t) => t.subject.startsWith(unique));
    expect(tasks).toHaveLength(2);
    expect(tasks.every((t) => t.briefId === brief.id)).toBe(true);
    for (const task of tasks)
      updateTask({ taskId: task.id, status: 'completed' }, { admin: true, scope: { kind: 'brain' } });
    held.shift()!();
    await until(() => briefIn(chatId).status === 'done');
  });

  it('checks a direct message and continues beyond the old five-turn cap while results advance', async () => {
    const a = agent('Progressing');
    const c = chats.create(a.id);
    for (let n = 0; n < 7; n++)
      verdicts.push(
        JSON.stringify({
          done: false,
          progress: `Result ${n + 1} delivered`,
          followUp: `Finish part ${n + 2}`,
          summary: `Part ${n + 1} complete.`,
        }),
      );
    startRun(a, c, 'Finish all eight parts, with checks.');
    await until(() => briefIn(c.id)?.status === 'done');
    expect(briefIn(c.id)).toMatchObject({ automatic: true, followUps: 7, stalled: 0 });
    expect(users(a.id, c.id)).toHaveLength(8);
    expect(checked[0]).toContain('Finish all eight parts, with checks.');
  });

  it('checks an ordinary team assignment and posts missing work without a command', async () => {
    const a = agent('Teamworker');
    const t = workflows.save({ name: 'Auto team', members: [a.id], lead: a.id, steps: [] } as Partial<Team>);
    verdicts.push(notDone('@Teamworker add the verification.'));
    await postUserMessage(t.id, 'Make the report and verify it.');
    await until(() => listBriefs().findLast((b) => b.targetId === t.id)?.status === 'done');
    expect(getThread(t.id).messages.some((m) => m.from === 'brain' && m.text.includes('add the verification'))).toBe(
      true,
    );
  });

  it('keeps the full user request as the condition when the Brain delegates a shorter brief', async () => {
    const a = agent('Assigned');
    answers.push(
      `On it.\n\`\`\`actions\n[{"do":"delegate","to":"agent","id":"${a.id}","message":"Make the report"}]\n\`\`\``,
    );
    const result = await ask('Make the report, verify every figure, and include the sources.');
    const c = result.delegate!.sent!.chatId!;
    await until(() => briefIn(c)?.status === 'done');
    expect(briefIn(c).goal).toBe('Make the report, verify every figure, and include the sources.');
    expect(checked.at(-1)).toContain('verify every figure');
  });

  it('keeps unrelated user questions open when tracking new work', async () => {
    const q = addQuestion({ question: 'Which account should I use?' });
    const a = agent('Independent');
    const c = chats.create(a.id);
    startRun(a, c, 'Answer this separate question.');
    await until(() => briefIn(c.id)?.status === 'done');
    expect(questions.get(q.id)?.status).toBe('waiting');
  });

  it('stops repeated identical results even when the evaluator paraphrases progress', async () => {
    const a = agent('Repeater');
    const c = chats.create(a.id);
    for (let n = 0; n < 4; n++)
      verdicts.push(
        JSON.stringify({
          done: false,
          progress: `Claim ${n}`,
          followUp: 'Try a different approach.',
          summary: 'Still unfinished.',
        }),
      );
    startRun(a, c, 'Do the work.');
    await until(() => briefIn(c.id)?.status === 'stuck');
    expect(briefIn(c.id).followUps).toBe(3);
    expect(questions.list().find((q) => q.briefId === briefIn(c.id).id)).toMatchObject({ status: 'waiting' });
  });

  it('records a blocker separately from completion and resumes the original assignment after an answer', async () => {
    const a = agent('Blocked');
    const c = chats.create(a.id);
    verdicts.push(
      JSON.stringify({
        done: false,
        blocked: true,
        userAction: 'Connect the project account.',
        summary: 'The draft is ready; publishing needs access.',
      }),
    );
    startRun(a, c, 'Draft and publish the report.');
    await until(() => briefIn(c.id)?.status === 'blocked');
    const b = briefIn(c.id);
    const q = questions.list().find((q) => q.briefId === b.id)!;
    expect(q).toMatchObject({ status: 'waiting', question: 'Connect the project account.' });
    expect(notes(a.id, c.id).some((n) => n.includes('finished.'))).toBe(false);
    await answerQuestion(q.id, { text: 'The account is connected. Continue.' });
    await until(() => briefIn(c.id)?.status === 'done');
    expect(briefIn(c.id).id).toBe(b.id);
    expect(checked.at(-1)).toContain('Draft and publish the report.');
    expect(checked.at(-1)).toContain('The account is connected.');
  });

  it('routes a team blocker through Needs you and resumes the same team assignment after the answer', async () => {
    const a = agent('Teamblocked');
    const t = workflows.save({ name: 'Team needing access', members: [a.id], lead: a.id, steps: [] } as Partial<Team>);
    verdicts.push(
      JSON.stringify({
        done: false,
        blocked: true,
        userAction: 'Choose the destination account.',
        summary: 'A draft is ready.',
      }),
    );
    await postUserMessage(t.id, 'Publish the draft in the chosen account.');
    await until(() => listBriefs().findLast((b) => b.targetId === t.id)?.status === 'blocked');
    const b = listBriefs().findLast((b) => b.targetId === t.id)!;
    const q = questions.list().find((q) => q.briefId === b.id)!;
    expect(q.teamId).toBe(t.id);
    await answerQuestion(q.id, { text: 'Use the work account.' });
    await until(() => listBriefs().find((x) => x.id === b.id)?.status === 'done');
    expect(checked.at(-1)).toContain('Use the work account.');
  });

  it('surfaces evaluator failure as a question instead of leaving silent open work', async () => {
    const a = agent('Reviewerror');
    const c = chats.create(a.id);
    verdicts.push(new Error('Brain model unavailable'));
    startRun(a, c, 'Complete the task.');
    await until(() => briefIn(c.id)?.status === 'blocked');
    expect(briefIn(c.id).summary).toContain('Brain model unavailable');
    expect(questions.list().some((q) => q.briefId === briefIn(c.id).id && q.status === 'waiting')).toBe(true);
  });

  it('does not restart an authentication failure and retries a temporary service error', async () => {
    const broken = agent('Broken');
    const c = chats.create(broken.id);
    startRun(broken, c, 'Finish this.');
    await until(() => briefIn(c.id)?.status === 'blocked');
    expect(calls.get('Broken')).toBe(1);
    const a = agent('Transient');
    const retry = chats.create(a.id);
    startRun(a, retry, 'Finish despite a temporary outage.');
    await until(() => briefIn(retry.id)?.status === 'done');
    expect(calls.get('Transient')).toBe(2);
  });

  it('bounds transient retries, then requests user action', async () => {
    const a = agent('Offline');
    const c = chats.create(a.id);
    startRun(a, c, 'Finish the assignment.');
    await until(() => briefIn(c.id)?.status === 'blocked', 11000);
    expect(calls.get('Offline')).toBe(3);
    expect(questions.list().some((q) => q.briefId === briefIn(c.id).id && q.status === 'waiting')).toBe(true);
  }, 12000);

  it('includes actual tool results in the completion check', async () => {
    const a = agents.save({ ...agent('Evidence'), toolGroups: ['agents'] });
    const c = chats.create(a.id);
    startRun(a, c, 'List the available agents.');
    await until(() => briefIn(c.id)?.status === 'done');
    expect(checked.at(-1)).toContain('Tool list_agents (done)');
  });

  it('waits for background delegates before judging the parent and includes their results', async () => {
    const child = agent('Holder');
    childId = child.id;
    const a = agents.save({ ...agent('Delegator'), toolGroups: ['agents'] });
    const c = chats.create(a.id);
    startRun(a, c, 'Finish the work with the helper.');
    await until(() => held.length > 0 && !activeRuns().some((r) => r.chatId === c.id));
    expect(checked).toHaveLength(0);
    held.shift()!();
    await until(() => briefIn(c.id)?.status === 'done');
    expect(checked.at(-1)).toContain('Delegated work finished:');
    expect(checked.at(-1)).toContain('Holder worked on it.');
    // (by name, not by id)
    expect(checked.at(-1)).toContain('**Holder:**');
  });

  it('Stop also stops background delegates after their parent turn has ended', async () => {
    const child = agent('Holder');
    childId = child.id;
    const a = agents.save({ ...agent('Delegator'), toolGroups: ['agents'] });
    const c = chats.create(a.id);
    startRun(a, c, 'Finish with the helper.');
    await until(() => held.length > 0 && !activeRuns().some((r) => r.chatId === c.id));
    stopChat(c.id);
    await until(() => !activeRuns().some((r) => r.agentId === child.id));
    held.shift()!();
    expect(briefIn(c.id).status).toBe('stopped');
    expect(checked).toHaveLength(0);
  });

  it("team completion waits for a member's background delegate and sees its finished result", async () => {
    const child = agent('Holder');
    childId = child.id;
    const a = agents.save({ ...agent('Delegator'), toolGroups: ['agents'] });
    const t = workflows.save({ name: 'Delegating team', members: [a.id], lead: a.id, steps: [] } as Partial<Team>);
    await postUserMessage(t.id, 'Finish the assignment with help.');
    await until(() => held.length > 0 && !teamState(t.id).working.length);
    expect(checked).toHaveLength(0);
    held.shift()!();
    await until(() => listBriefs().findLast((b) => b.targetId === t.id)?.status === 'done');
    expect(checked.at(-1)).toContain('Holder worked on it.');
  });

  it('Team Stop stops delegates whose member turn has already ended', async () => {
    const child = agent('Holder');
    childId = child.id;
    const a = agents.save({ ...agent('Delegator'), toolGroups: ['agents'] });
    const t = workflows.save({ name: 'Stopping delegates', members: [a.id], lead: a.id, steps: [] } as Partial<Team>);
    await postUserMessage(t.id, 'Start with a helper.');
    await until(() => held.length > 0 && !teamState(t.id).working.length);
    stopTeam(t.id);
    await until(() => !activeRuns().some((r) => r.agentId === child.id));
    held.shift()!();
    expect(listBriefs().findLast((b) => b.targetId === t.id)?.status).toBe('stopped');
    expect(checked).toHaveLength(0);
  });

  it('waits for another team to finish and pass its completion check before judging the requester', async () => {
    const child = agent('Holder');
    childId = child.id;
    const helper = agents.save({ ...agent('Delegator'), toolGroups: ['agents'] });
    const destination = workflows.save({
      name: 'Helper crew',
      members: [helper.id],
      lead: helper.id,
      steps: [],
    } as Partial<Team>);
    const lead = agent('Requester');
    const origin = workflows.save({
      name: 'Request crew',
      members: [lead.id],
      lead: lead.id,
      steps: [],
    } as Partial<Team>);
    await postUserMessage(origin.id, '#Helper crew finish the assignment.');
    await until(() => held.length > 0 && !teamState(destination.id).working.length);
    expect(checked).toHaveLength(0);
    expect(listBriefs().findLast((b) => b.targetId === origin.id)?.status).toBe('open');
    held.shift()!();
    await until(() => listBriefs().findLast((b) => b.targetId === origin.id)?.status === 'done');
    expect(listBriefs().findLast((b) => b.targetId === destination.id)?.status).toBe('done');
    expect(checked[0]).toContain('Holder worked on it.');
    expect(checked).toHaveLength(2);
  });

  it('ignores a stale verdict after a newer queued user message and checks the combined assignment', async () => {
    const a = agent('Steered');
    const c = chats.create(a.id);
    let release!: (s: string) => void;
    verdicts.push(
      new Promise<string>((r) => {
        release = r;
      }),
    );
    startRun(a, c, 'Write the draft.');
    await until(() => checked.length === 1);
    queueMessage(a, chats.get(a.id, c.id)!, 'Also add a summary.');
    await until(() => !activeRuns().some((r) => r.chatId === c.id));
    release(notDone('Stale instruction.'));
    await until(() => briefIn(c.id)?.status === 'done');
    expect(users(a.id, c.id)).toHaveLength(2);
    expect(checked.at(-1)).toContain('Write the draft.');
    expect(checked.at(-1)).toContain('Also add a summary.');
  });

  it('Stop cancels a verdict in flight, even when the agent itself is already idle', async () => {
    const a = agent('Stopcheck');
    const c = chats.create(a.id);
    let release!: (s: string) => void;
    verdicts.push(
      new Promise<string>((r) => {
        release = r;
      }),
    );
    startRun(a, c, 'Work until finished.');
    await until(() => checked.length === 1);
    stopChat(c.id);
    release(notDone('Do more work.'));
    await new Promise((r) => setTimeout(r, 75));
    expect(briefIn(c.id).status).toBe('stopped');
    expect(users(a.id, c.id)).toHaveLength(1);
  });

  it('Clear and Delete cancel automatic checks', async () => {
    const a = agent('Holder');
    const c = chats.create(a.id);
    startRun(a, c, 'Work until finished.');
    await until(() => held.length > 0);
    forgetChat(c.id);
    chats.remove(a.id, c.id);
    held.shift()!();
    await until(() => !activeRuns().some((r) => r.chatId === c.id));
    expect(briefIn(c.id).status).toBe('cleared');
    const t = workflows.save({ name: 'Clear auto', members: [a.id], lead: a.id, steps: [] } as Partial<Team>);
    await postUserMessage(t.id, 'Team task.');
    await until(() => held.length > 0);
    clearThread(t.id);
    held.shift()!();
    await until(() => !teamState(t.id).working.length);
    expect(listBriefs().findLast((b) => b.targetId === t.id)?.status).toBe('cleared');
    expect(getThread(t.id).messages).toEqual([]);
  });

  it('recovers saved open work after startup without restarting stopped work', async () => {
    const a = agent('Recovered');
    const c = chats.create(a.id);
    const b = addBrief({
      kind: 'agent',
      targetId: a.id,
      chatId: c.id,
      name: a.name,
      text: 'Finish the saved assignment.',
      goal: 'Finish the saved assignment.',
      automatic: true,
      origin: 'chat',
      ts: Date.now(),
    });
    verdicts.push(notDone('Check the files and finish the saved assignment.'));
    await recoverWork();
    await until(() => listBriefs().find((x) => x.id === b.id)?.status === 'done');
    expect(users(a.id, c.id)).toEqual(['the Brain: Check the files and finish the saved assignment.']);
  });
});

describe('/goal in an agent chat', () => {
  it('starts the agent on it, follows up until the Brain says it is met, and says so in the chat', async () => {
    const a = agent('Worker');
    const c = chats.create(a.id);
    verdicts.push(notDone('Add the tests too.'));
    const { goal } = goalInChat(a.id, c.id, 'the login page works and has tests');
    expect(goal?.origin).toBe('chat');
    await until(() => listBriefs().find((b) => b.id === goal!.id)?.status === 'done');
    expect(users(a.id, c.id)).toEqual([
      '/goal: Your goal: the login page works and has tests',
      'the Brain: Add the tests too.',
    ]);
    expect(checked[0]).toContain("THE USER'S GOAL");
    expect(checked[0]).toContain('the login page works and has tests');
    // (the reply above says what was done: the note doesn't repeat the check's summary)
    await until(() => notes(a.id, c.id).includes('Goal reached.'));
    expect(listBriefs().find((b) => b.id === goal!.id)?.followUps).toBe(1);
  });

  it('stops after repeated lack of progress, even with ordinary follow-ups off', async () => {
    saveSettings({ brainFollowsUp: false });
    const a = agent('Stubborn');
    const c = chats.create(a.id);
    for (let i = 0; i < NO_PROGRESS_LIMIT; i++) verdicts.push(notDone(`Try again ${i}.`));
    const { goal } = goalInChat(a.id, c.id, 'ship it');
    await until(() => listBriefs().find((b) => b.id === goal!.id)?.status === 'stuck', 15000);
    expect(users(a.id, c.id).filter((u) => u.startsWith('the Brain'))).toHaveLength(NO_PROGRESS_LIMIT - 1);
    await until(() => notes(a.id, c.id).some((n) => n.includes(`No new progress in ${NO_PROGRESS_LIMIT} checks.`)));
  });

  it('/goal clear drops it: the next turn is not checked', async () => {
    const a = agent('Holder');
    const c = chats.create(a.id);
    const { goal } = goalInChat(a.id, c.id, 'something');
    await until(() => held.length > 0);
    expect(goalInChat(a.id, c.id, '').goal?.id).toBe(goal!.id);
    goalInChat(a.id, c.id, 'clear');
    expect(goalInChat(a.id, c.id, '').goal).toBeNull();
    held.shift()!();
    await until(() => !activeRuns().some((r) => r.chatId === c.id));
    await new Promise((r) => setTimeout(r, 100));
    expect(checked).toEqual([]);
    expect(listBriefs().find((b) => b.id === goal!.id)?.status).toBe('cleared');
  });

  it("a goal in one chat doesn't replace a goal in another chat with the same agent", async () => {
    const a = agent('Holder');
    const one = chats.create(a.id);
    const two = chats.create(a.id);
    const g1 = goalInChat(a.id, one.id, 'first').goal!;
    const g2 = goalInChat(a.id, two.id, 'second').goal!;
    expect(listBriefs().find((b) => b.id === g1.id)?.status).toBe('open');
    expect(listBriefs().find((b) => b.id === g2.id)?.status).toBe('open');
    goalInChat(a.id, one.id, 'clear');
    goalInChat(a.id, two.id, 'clear');
    await until(() => held.length >= 2);
    held.splice(0).forEach((go) => go());
    await until(() => !activeRuns().some((r) => r.chatId === one.id || r.chatId === two.id));
  });
});

describe('/goal in a team chat', () => {
  it('posts it for the team and checks when the team goes quiet; the result is posted in the thread', async () => {
    const lead = agent('Leader');
    const t = workflows.save({
      name: `Goal team ${Date.now()}`,
      description: '',
      members: [lead.id],
      lead: lead.id,
      steps: [],
    } as Partial<Team>);
    verdicts.push(notDone('@Leader add the summary.'));
    const { goal } = await goalInTeam(t.id, 'a weekly report with a summary');
    await until(() => listBriefs().find((b) => b.id === goal!.id)?.status === 'done');
    const said = getThread(t.id).messages.map((m) => `${m.from === lead.id ? 'Leader' : m.from}: ${m.text}`);
    expect(said[0]).toBe('user: Goal: a weekly report with a summary');
    expect(said).toContain('brain: @Leader add the summary.');
    await until(() => getThread(t.id).messages.some((m) => m.from === 'system' && m.text === 'Goal reached.'));
    await until(() => !teamState(t.id).working.length);
  });
});

describe('/stop and /resume in the Brain chat', () => {
  it('stops the work the Brain handed out, and /resume picks it up again', async () => {
    const a = agent('Holder');
    answers.push(
      `On it.\n\`\`\`actions\n[{"do":"delegate","to":"agent","id":"${a.id}","message":"Write the report"}]\n\`\`\``,
    );
    const r = await ask('get the report written');
    const chatId = r.delegate!.sent!.chatId!;
    await until(() => held.length > 0);
    expect(stopBrain({}).stopped).toEqual(['Holder']);
    await until(() => !activeRuns().some((x) => x.chatId === chatId));
    const brief = listBriefs().findLast((b) => b.chatId === chatId)!;
    expect(brief.status).toBe('stopped');
    held.splice(0).forEach((go) => go());

    const back = resumeBrain({});
    expect(back.resumed).toEqual(['Holder']);
    expect(back.chats).toEqual([chatId]);
    expect(listBriefs().find((b) => b.id === brief.id)?.status).toBe('open');
    await until(() => held.length > 0);
    expect(users(a.id, chatId).at(-1)).toBe('the Brain: Continue from where you stopped.');
    held.shift()!();
    await until(() => listBriefs().find((b) => b.id === brief.id)?.status === 'done');
    expect(() => resumeBrain({})).toThrow('Nothing to resume.');
  });

  it('an answer the Brain was writing when you stopped it changes nothing', async () => {
    const a = agent('Finisher');
    let finish: (s: string) => void = () => {};
    answers.push(new Promise<string>((r) => (finish = r)));
    const pending = ask('hand this on');
    await new Promise((r) => setTimeout(r, 30));
    stopBrain({});
    finish(`Sure.\n\`\`\`actions\n[{"do":"delegate","to":"agent","id":"${a.id}","message":"Do it"}]\n\`\`\``);
    const r = await pending;
    expect(r.delegate).toBeNull();
    expect(r.done.map((d) => d.text)).toEqual(['You stopped the Brain, so nothing was changed.']);
    expect(listBriefs().some((b) => b.targetId === a.id)).toBe(false);
  });

  it('a /goal from the Brain chat is kept for its hand-off even with follow-ups off', async () => {
    saveSettings({ brainFollowsUp: false });
    const a = agent('Finisher');
    answers.push(
      `Handing it on.\n\`\`\`actions\n[{"do":"delegate","to":"agent","id":"${a.id}","message":"Make the site load fast"}]\n\`\`\``,
    );
    await ask('the site loads in under a second', { goal: true });
    const b = listBriefs().findLast((x) => x.targetId === a.id)!;
    expect(b.goal).toBe('the site loads in under a second');
    await until(() => listBriefs().find((x) => x.id === b.id)?.status === 'done');
    expect(checked.at(-1)).toContain('the site loads in under a second');
  });
});

describe('simple questions are not goals', () => {
  const setGoal = (a: { id: string; name: string }, chatId: string, goal: string) =>
    goalTool().run({ goal }, { agent: a, runId: chatRunId(a.id, chatId) });

  it('a question the reply answers closes quietly: no goal, no note', async () => {
    const a = agent('Answerer');
    const c = chats.create(a.id);
    verdicts.push('{"assignment":false,"done":true,"summary":"Answered the question."}');
    startRun(a, c, 'What does parseCommand do?');
    expect(openGoal('agent', a.id, c.id)).toBeNull();
    await until(() => briefIn(c.id)?.status === 'done');
    expect(briefIn(c.id).recognized).toBeFalsy();
    expect(checkedSystems[0]).toContain('assignment: false when');
    expect(notes(a.id, c.id).filter((n) => n.includes('finished'))).toEqual([]);
    expect(users(a.id, c.id)).toHaveLength(1);
  });

  it('work the Brain recognizes at its check becomes the chat goal and is followed up', async () => {
    const a = agent('Recognized');
    const c = chats.create(a.id);
    verdicts.push(
      JSON.stringify({
        assignment: true,
        done: false,
        progress: 'Part one',
        followUp: 'Add the tests.',
        summary: 'Half done.',
      }),
    );
    startRun(a, c, 'Add a help command.');
    await until(() => briefIn(c.id)?.status === 'done');
    expect(briefIn(c.id)).toMatchObject({ recognized: true, followUps: 1 });
    // (once recognized, the next check doesn't ask again)
    expect(checkedSystems[1]).not.toContain('assignment: false when');
    await until(() => notes(a.id, c.id).includes('Recognized finished.'));
  });

  it('the agent sets the goal with set_goal: it shows at once and the check reads it beside your words', async () => {
    const a = agent('Holder');
    const c = chats.create(a.id);
    startRun(a, c, 'Add a help command.');
    await until(() => held.length > 0);
    expect(openGoal('agent', a.id, c.id)).toBeNull();
    const r = await setGoal(a, c.id, 'The help command lists every command.');
    expect(r.text).toContain('Goal set');
    expect(openGoal('agent', a.id, c.id)).toMatchObject({
      recognized: true,
      doneWhen: 'The help command lists every command.',
      goal: 'Add a help command.',
    });
    held.shift()!();
    await until(() => briefIn(c.id)?.status === 'done');
    expect(checkedSystems[0]).not.toContain('assignment: false when');
    expect(checked[0]).toContain('WHAT DONE LOOKS LIKE, AS THE AGENT SET IT');
    expect(checked[0]).toContain("THE USER'S GOAL (done only when met):\nAdd a help command.");
  });

  it('set_goal leaves your own /goal as it is', async () => {
    const a = agent('Holder');
    const c = chats.create(a.id);
    const { goal } = goalInChat(a.id, c.id, 'the build is green');
    await until(() => held.length > 0);
    expect((await setGoal(a, c.id, 'Something else.')).text).toContain(
      'The user already set the goal: the build is green',
    );
    expect(openGoal('agent', a.id, c.id)).toMatchObject({ id: goal!.id, goal: 'the build is green' });
    expect(openGoal('agent', a.id, c.id)?.doneWhen).toBeUndefined();
    goalInChat(a.id, c.id, 'clear');
    held.shift()!();
    await until(() => !activeRuns().some((x) => x.chatId === c.id));
  });

  it('in a team only the lead sets the goal', async () => {
    const lead = agent('Leadgoal');
    const member = agent('Holder');
    const t = workflows.save({
      name: `Set goal team ${Date.now()}`,
      members: [lead.id, member.id],
      lead: lead.id,
      steps: [],
    } as Partial<Team>);
    const b = addBrief({
      kind: 'team',
      targetId: t.id,
      name: t.name,
      text: 'Make the report.',
      goal: 'Make the report.',
      automatic: true,
      origin: 'chat',
      ts: Date.now(),
    });
    const c = chats.create(member.id);
    c.teamId = t.id;
    chats.save(c);
    startRun(member, c, 'Your part of the report.', { from: 'the team' });
    await until(() => held.length > 0);
    expect((await setGoal(member, c.id, 'A report.')).text).toContain("The team's lead sets its goal");
    expect(listBriefs().find((x) => x.id === b.id)?.recognized).toBeFalsy();
    held.shift()!();
    await until(() => !activeRuns().some((x) => x.chatId === c.id));
    clearThread(t.id);
  });

  it('with follow-ups off, set_goal keeps nothing and says so', async () => {
    saveSettings({ brainFollowsUp: false });
    const a = agent('Holder');
    const c = chats.create(a.id);
    startRun(a, c, 'Add a help command.');
    await until(() => held.length > 0);
    expect((await setGoal(a, c.id, 'Done when it works.')).text).toContain('Completion checks are off');
    expect(listBriefs().some((x) => x.chatId === c.id)).toBe(false);
    held.shift()!();
    await until(() => !activeRuns().some((x) => x.chatId === c.id));
  });
});
