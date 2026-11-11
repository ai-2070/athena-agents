// The Tasks board's oRPC routes (server/api/taskboard.ts) check what comes in before the board sees it:
// a wrong type is refused in plain words, keys a route doesn't take are dropped, and the board's own rules
// still answer in theirs. (tests/server/api.test.ts covers the same routes on the real server.)
import http from 'node:http';
import type net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handleRpc } from '../../server/rpc.ts';
import { createProject } from '../../server/projects.ts';
import type { Project } from '../../shared/types.ts';

let base = '';
let project: Project;
const server = http.createServer(async (req, res) => {
  if (!(await handleRpc(req, res, '/api'))) res.writeHead(404).end();
});
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  project = await createProject({ name: 'Board over oRPC' });
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const send = async (method: string, p: string, body?: unknown) => {
  const r = await fetch(base + p, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
};

describe('board tags', () => {
  it('refuse a name or an emoji that isn’t text, in plain words', async () => {
    expect(await send('POST', `/api/task-board-tags/${project.id}`, { name: 3 })).toEqual({
      status: 400,
      json: { error: 'Give the tag a name.' },
    });
    expect(await send('POST', `/api/task-board-tags/${project.id}`, {})).toEqual({
      status: 400,
      json: { error: 'Give the tag a name.' },
    });
    expect(await send('POST', `/api/task-board-tags/${project.id}`, { name: 'Bug', emoji: 5 })).toEqual({
      status: 400,
      json: { error: 'Choose one emoji for the tag.' },
    });
  });

  it('leave the board’s own rules to the board', async () => {
    expect(await send('POST', `/api/task-board-tags/${project.id}`, { name: 'Bug', emoji: 'nope' })).toEqual({
      status: 400,
      json: { error: 'Choose one emoji for the tag.' },
    });
    expect(await send('POST', `/api/task-board-tags/${project.id}`, { name: '  ' })).toEqual({
      status: 400,
      json: { error: 'Give the tag a name.' },
    });
  });

  it('drop keys they don’t take', async () => {
    const { status, json } = await send('POST', `/api/task-board-tags/${project.id}`, {
      name: '🐛 Bug',
      createdBy: 'agent:sneaky',
      id: 'tagxxxxxxxxxxxxxxxx',
    });
    expect(status).toBe(200);
    expect(json.tag).toMatchObject({ name: 'Bug', emoji: '🐛', createdBy: 'you', made: true });
    expect((json.tag as { id: string }).id).not.toBe('tagxxxxxxxxxxxxxxxx');
  });

  it('change, list and delete a tag, and say when it is gone', async () => {
    const { json } = await send('POST', `/api/task-board-tags/${project.id}`, { name: 'Design' });
    const id = (json.tag as { id: string }).id;
    expect((await send('PUT', `/api/task-board-tags/${project.id}/${id}`, { emoji: '🎨' })).json.tag).toMatchObject({
      name: 'Design',
      emoji: '🎨',
    });
    expect(
      ((await send('GET', `/api/task-board-tags/${project.id}`)).json.tags as { name: string }[]).map((t) => t.name),
    ).toContain('Design');
    expect((await send('DELETE', `/api/task-board-tags/${project.id}/${id}`)).json).toMatchObject({ tasks: 0 });
    expect(await send('DELETE', `/api/task-board-tags/${project.id}/${id}`)).toEqual({
      status: 404,
      json: { error: 'That tag is unavailable.' },
    });
    expect(await send('PUT', `/api/task-board-tags/${project.id}/${id}`, { name: 'Again' })).toEqual({
      status: 404,
      json: { error: 'That tag is unavailable.' },
    });
  });

  it('say when the project is unavailable', async () => {
    const r = await send('GET', '/api/task-board-tags/nope');
    expect(r.status).toBe(404);
  });
});

describe('board tasks', () => {
  const at = () => `/api/task-board/${project.id}`;

  it('refuse a field of the wrong kind in the board’s words', async () => {
    expect(await send('POST', at(), {})).toEqual({ status: 400, json: { error: 'title must be non-empty text.' } });
    expect(await send('POST', at(), { title: 'A', status: 'later' })).toEqual({
      status: 400,
      json: { error: 'Choose a status: To do, In progress, In review, Blocked or Done.' },
    });
    expect(await send('POST', at(), { title: 'A', priority: 9 })).toEqual({
      status: 400,
      json: { error: 'Choose a priority: urgent, high, normal or low.' },
    });
    expect(await send('POST', at(), { title: 'A', rank: 'first' })).toEqual({
      status: 400,
      json: { error: 'rank must be a number.' },
    });
    expect(await send('POST', at(), { title: 'A', files: 'a.png' })).toEqual({
      status: 400,
      json: { error: 'files must be a list.' },
    });
    expect(await send('POST', at(), { title: 'A', tags: 5 })).toEqual({
      status: 400,
      json: { error: 'tags must be a list of tag names.' },
    });
    expect(await send('PUT', '/api/task-board-ranks', { ranks: 'all' })).toEqual({
      status: 400,
      json: { error: 'ranks must be a list.' },
    });
    expect(await send('PUT', '/api/task-board-ranks', { ranks: [{ id: 'x' }] })).toMatchObject({ status: 400 });
    expect(await send('POST', '/api/task-board-draft', { projectId: project.id, kind: 'poem' })).toEqual({
      status: 400,
      json: { error: 'Say whether to draft a task or a comment.' },
    });
    // (and the board's own rules still answer in theirs)
    expect(await send('POST', at(), { title: '   ' })).toEqual({
      status: 400,
      json: { error: 'title must be non-empty text.' },
    });
    expect(await send('POST', at(), { title: 'A', assignee: 'someone' })).toEqual({
      status: 400,
      json: { error: 'assignee must be empty, you, brain, agent:<id> or team:<id>.' },
    });
  });

  it('take tags as a list or as "a, b"', async () => {
    const listed = (await send('POST', at(), { title: 'Listed', tags: ['Red', 'Blue'] })).json.task as {
      tagList: { name: string }[];
    };
    expect(listed.tagList.map((t) => t.name)).toEqual(['Red', 'Blue']);
    const written = (await send('POST', at(), { title: 'Written', tags: 'Red, Green' })).json.task as {
      tagList: { name: string }[];
    };
    expect(written.tagList.map((t) => t.name)).toEqual(['Red', 'Green']);
  });

  it('make, read, move, comment on and remove a task', async () => {
    const { status, json } = await send('POST', at(), {
      title: 'Bake bread',
      priority: 'high',
      number: 99,
      createdBy: 'brain',
    });
    expect(status).toBe(200);
    const task = json.task as { id: string; number: number; createdBy: string; updatedAt: number };
    expect(task).toMatchObject({ title: 'Bake bread', priority: 'high', status: 'todo', createdBy: 'you' });
    expect(task.number).not.toBe(99);
    const one = `${at()}/${task.id}`;
    expect((await send('GET', one)).json.task).toMatchObject({ id: task.id, title: 'Bake bread' });

    const moved = (
      await send('PUT', one, { status: 'blocked', blockedReason: 'No flour', expectedUpdatedAt: task.updatedAt })
    ).json.task as { updatedAt: number };
    expect(moved).toMatchObject({ status: 'blocked', blockedReason: 'No flour' });
    expect(await send('PUT', one, { title: 'Old', expectedUpdatedAt: task.updatedAt })).toEqual({
      status: 409,
      json: { error: 'This task changed meanwhile. Reload it before saving.' },
    });

    const commented = (await send('POST', `${one}/comments`, { text: 'Flour is coming.' })).json.task as {
      comments: { id: string; text: string }[];
    };
    expect(commented.comments.map((c) => c.text)).toEqual(['Flour is coming.']);
    const cid = commented.comments[0].id;
    expect(
      (
        (await send('PUT', `${one}/comments/${cid}`, { text: 'Flour is here.' })).json.task as {
          comments: { text: string }[];
        }
      ).comments[0].text,
    ).toBe('Flour is here.');
    expect(await send('PUT', `${one}/comments/${cid}`, {})).toEqual({
      status: 400,
      json: { error: 'comment must be non-empty text.' },
    });
    expect(((await send('DELETE', `${one}/comments/${cid}`)).json.task as { comments: unknown[] }).comments).toEqual(
      [],
    );

    expect(
      await send('PUT', '/api/task-board-ranks', {
        ranks: [{ projectId: project.id, id: task.id, status: 'blocked', rank: -5 }],
      }),
    ).toEqual({ status: 200, json: { ok: true } });
    expect((await send('GET', one)).json.task).toMatchObject({ rank: -5 });
    const shown = (await send('GET', `/api/task-board?project=${project.id}`)).json as { tasks: { id: string }[] };
    expect(shown.tasks.map((t) => t.id)).toContain(task.id);

    expect(await send('DELETE', one)).toEqual({ status: 200, json: { ok: true } });
    expect(await send('GET', one)).toEqual({ status: 404, json: { error: 'That task is unavailable.' } });
    expect(await send('PUT', one, { title: 'Gone' })).toEqual({
      status: 404,
      json: { error: 'That task is unavailable.' },
    });
  });

  it('take Stop with no body at all, as the page sends it', async () => {
    const task = (await send('POST', at(), { title: 'Nothing to stop' })).json.task as { id: string };
    const r = await fetch(`${base}${at()}/${task.id}/stop`, { method: 'POST' });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { task: { id: string } }).task.id).toBe(task.id);
  });

  it('list who a project’s tasks can go to', async () => {
    expect((await send('GET', `/api/task-board-people/${project.id}`)).json).toEqual({
      agents: expect.any(Array),
      teams: expect.any(Array),
    });
  });
});
