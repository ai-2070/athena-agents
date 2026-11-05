// What waits for you, a chat's tasks, routines and runs over oRPC (server/api/needs.ts, tasks.ts, routines.ts,
// runs.ts): the lists, answers to a question that isn't there or is already closed, a decision on a request that
// was already decided, a task changed since you read it, a routine with nothing to do, and fields of the wrong kind
// refused in plain words.
import http from 'node:http';
import type net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handleRpc } from '../../server/rpc.ts';
import { questions } from '../../server/store.ts';
import type { AgentQuestion, WorkTask } from '../../shared/types.ts';

let base = '';
const server = http.createServer(async (req, res) => {
  if (!(await handleRpc(req, res, '/api'))) res.writeHead(404).end();
});
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const send = async (method: string, p: string, body?: unknown) => {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> & { task: WorkTask } };
};

describe('questions and approvals over oRPC', () => {
  it('list questions newest first, and refuse an answer to one that is gone or closed', async () => {
    questions.save({ id: 'q-old', question: 'Old?', status: 'dismissed', createdAt: 1 } as Partial<AgentQuestion>);
    questions.save({ id: 'q-new', question: 'New?', status: 'dismissed', createdAt: 2 } as Partial<AgentQuestion>);
    const ids = ((await send('GET', '/api/questions')).json as unknown as AgentQuestion[]).map((q) => q.id);
    expect(ids.indexOf('q-new')).toBeLessThan(ids.indexOf('q-old'));
    expect(await send('POST', '/api/questions/nobody/answer', { text: 'yes' })).toEqual({ status: 404, json: { error: 'No such question.' } });
    expect(await send('POST', '/api/questions/q-old/answer', { text: 'yes' })).toEqual({ status: 409, json: { error: 'This question was answered or closed already.' } });
    expect(await send('POST', '/api/questions/q-old/answer', { text: 5 })).toEqual({ status: 400, json: { error: 'Type your answer.' } });
    expect(await send('DELETE', '/api/questions/q-old')).toEqual({ status: 200, json: { ok: true } });
    expect(questions.get('q-old')).toBeNull();
  });

  it('say a request that was already decided is, and refuse a decision of the wrong kind', async () => {
    expect(Array.isArray((await send('GET', '/api/approvals')).json)).toBe(true);
    expect(await send('POST', '/api/approvals/nothing', { approved: true })).toEqual({ status: 200, json: { ok: false } });
    expect(await send('POST', '/api/approvals/nothing', { approved: 'yes' })).toEqual({ status: 400, json: { error: 'approved must be true or false.' } });
  });
});

describe("a chat's tasks over oRPC", () => {
  it('make, list, read and change a task, and refuse one changed since you read it', async () => {
    const { task } = (await send('POST', '/api/tasks', { subject: 'Write the intro', description: 'Two paragraphs.' })).json;
    expect(task).toMatchObject({ subject: 'Write the intro', status: 'pending', scope: { kind: 'brain' } });
    const page = (await send('GET', '/api/tasks?view=all&status=open&limit=5')).json;
    expect((page.tasks as WorkTask[]).some((t) => t.id === task.id)).toBe(true);
    expect((await send('GET', `/api/tasks/${task.id}`)).json.task.subject).toBe('Write the intro');
    const done = (await send('PUT', `/api/tasks/${task.id}`, { status: 'completed', expectedUpdatedAt: task.updatedAt })).json.task;
    expect(done.status).toBe('completed');
    expect((await send('PUT', `/api/tasks/${task.id}`, { subject: 'stale', expectedUpdatedAt: task.updatedAt })).status).toBe(409);
    expect(await send('GET', '/api/tasks/nothing')).toEqual({ status: 404, json: { error: 'That task is unavailable.' } });
  });

  it('refuse a task with no subject, a status it cannot have, and a list of the wrong kind', async () => {
    expect((await send('POST', '/api/tasks', { subject: '' })).status).toBe(400);
    expect(await send('GET', '/api/tasks?status=someday')).toEqual({ status: 400, json: { error: 'Invalid task status.' } });
    expect(await send('PUT', '/api/tasks/t1', { addBlockedBy: 't2' })).toEqual({ status: 400, json: { error: 'addBlockedBy must be a list of task ids.' } });
  });
});

describe('routines and runs over oRPC', () => {
  it('make, read, change and delete a routine, and never one with nothing to do', async () => {
    const made = (await send('POST', '/api/routines', { name: 'Morning', text: 'Summarize the news.' })).json;
    expect(made).toMatchObject({ name: 'Morning', enabled: true, schedule: { type: 'none' } });
    expect((await send('GET', `/api/routines/${made.id}`)).json).toMatchObject({ id: made.id, text: 'Summarize the news.' });
    expect((await send('PUT', `/api/routines/${made.id}`, { enabled: false })).json).toMatchObject({ enabled: false, text: 'Summarize the news.' });
    expect(((await send('GET', '/api/routines')).json as unknown as { id: string }[]).some((r) => r.id === made.id)).toBe(true);
    expect(await send('POST', '/api/routines', { name: 'Empty', text: '  ' })).toEqual({ status: 400, json: { error: 'Write what the routine should do first.' } });
    expect(await send('PUT', `/api/routines/${made.id}`, { enabled: 'no' })).toEqual({ status: 400, json: { error: 'enabled must be true or false.' } });
    expect(await send('DELETE', `/api/routines/${made.id}`)).toEqual({ status: 200, json: { ok: true } });
    expect(await send('GET', `/api/routines/${made.id}`)).toEqual({ status: 404, json: { error: 'That routine is unavailable.' } });
    expect(await send('POST', `/api/routines/${made.id}/run`)).toEqual({ status: 404, json: { error: 'That routine is unavailable.' } });
  });

  it('list the runs going now and say a run that ended is not stopped again', async () => {
    expect((await send('GET', '/api/runs')).json).toEqual([]);
    expect(await send('POST', '/api/runs/nothing/stop')).toEqual({ status: 200, json: { ok: false } });
    expect((await send('GET', '/api/routine-runs?routineId=nothing')).json).toEqual([]);
    expect(await send('POST', '/api/routine-runs/nothing/stop')).toEqual({ status: 200, json: { ok: false } });
  });
});
