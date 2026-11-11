import { StrictMode, act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskPanel } from '../../web/tasks.tsx';
import { connectEvents, state } from '../../web/core.ts';
import type { AppState, TaskScope, WorkTask } from '../../shared/types.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const settle = (ms = 30) => act(() => new Promise((r) => setTimeout(r, ms)));
let root: Root;
let el: HTMLElement;
let tasks: WorkTask[];
let requests: { url: string; method: string; body: Record<string, unknown> }[];
let failSave = false;
let failLoad = false;
class FakeSocket {
  static last: FakeSocket;
  onmessage: ((e: { data: string }) => void) | null = null;
  constructor() {
    FakeSocket.last = this;
  }
}
const task = (id: string, subject: string, scope: TaskScope = { kind: 'brain' }): WorkTask => ({
  id,
  subject,
  description: `${subject}: all checks pass.`,
  activeForm: '',
  scope,
  status: 'pending',
  owner: '',
  blockedBy: [],
  blocks: [],
  metadata: {},
  createdAt: 1,
  updatedAt: 1,
});
beforeEach(() => {
  document.body.innerHTML = '<div id="modal-root"></div><div id="toasts"></div><div id="tasks-test"></div>';
  el = document.getElementById('tasks-test')!;
  root = createRoot(el);
  tasks = [task('task1', 'Write the report'), task('task2', 'Review the report')];
  tasks[1].blockedBy = ['task1'];
  tasks[0].blocks = ['task2'];
  requests = [];
  failSave = false;
  failLoad = false;
  state.data = { project: { id: 'p1' }, agents: [{ id: 'a1', name: 'Writer' }] } as unknown as AppState;
  vi.stubGlobal('WebSocket', FakeSocket);
  connectEvents();
  vi.stubGlobal('fetch', async (input: string, init: RequestInit = {}) => {
    const url = new URL(input, 'http://localhost');
    const method = init.method || 'GET';
    const body: Record<string, unknown> = init.body ? JSON.parse(String(init.body)) : {};
    requests.push({ url: `${url.pathname}${url.search}`, method, body });
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
    if (url.pathname === '/api/workflows') return json([{ id: 't1', name: 'Editors', members: ['a1'] }]);
    if (url.pathname === '/api/tasks' && method === 'GET') {
      if (failLoad) return json({ error: 'Task list could not load.' }, 503);
      const view = url.searchParams.get('view');
      const search = url.searchParams.get('search')?.toLowerCase();
      const filter = url.searchParams.get('status');
      const rows = tasks
        .filter(
          (t) =>
            !view || view === 'all' || view === (t.scope.kind === 'brain' ? 'brain' : `${t.scope.kind}:${t.scope.id}`),
        )
        .filter((t) => !search || t.subject.toLowerCase().includes(search))
        .filter((t) => t.status !== 'deleted' && (filter !== 'open' || t.status !== 'completed'));
      return json({ tasks: rows, total: rows.length, nextOffset: null });
    }
    if (url.pathname === '/api/tasks' && method === 'POST') {
      const t = { ...task('created', String(body.subject), body.scope as TaskScope), ...body };
      tasks.push(t as WorkTask);
      return json({ task: t });
    }
    const id = url.pathname.split('/').at(-1)!;
    const t = tasks.find((t) => t.id === id);
    if (method === 'PUT') {
      if (failSave) return json({ error: 'This task changed. Reload it before saving.' }, 409);
      if (t) Object.assign(t, body, { updatedAt: t.updatedAt + 1 });
      return json({ task: t });
    }
    return json({ task: t });
  });
});
afterEach(async () => {
  await act(() => root.unmount());
  vi.unstubAllGlobals();
});
const button = (text: string) =>
  [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === text)!;
const open = async (props: Parameters<typeof TaskPanel>[0] = { filters: true }) => {
  await act(() =>
    root.render(
      <StrictMode>
        <TaskPanel {...props} />
      </StrictMode>,
    ),
  );
  await act(() => button('Tasks').click());
  await settle(160);
  await settle();
};
const fill = async (input: HTMLInputElement | HTMLTextAreaElement, value: string) =>
  act(async () => {
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
const field = (label: string) =>
  [...el.querySelectorAll('label')]
    .find((l) => l.textContent?.startsWith(label))!
    .querySelector<HTMLInputElement | HTMLTextAreaElement>('input,textarea')!;

describe('task lists in chats', () => {
  it('confirms before clearing open tasks and keeps completed tasks', async () => {
    tasks.push({ ...task('done', 'Finished work'), status: 'completed' });
    await open();
    expect(button('Clear tasks').disabled).toBe(false);
    expect(button('Clear tasks').querySelector('svg')).not.toBeNull();
    expect(button('Add task').querySelector('svg')).not.toBeNull();
    await act(async () => button('Clear tasks').click());
    await settle();
    expect(requests.some((r) => r.method === 'PUT')).toBe(false);
    const confirm = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
      (b) => b.textContent === 'Clear tasks',
    )!;
    await act(async () => confirm.click());
    await settle();
    expect(tasks.map((t) => t.status)).toEqual(['deleted', 'deleted', 'completed']);
    expect(button('Clear tasks').disabled).toBe(true);
  });

  it('can cancel clearing and only clears the selected list', async () => {
    tasks = [task('own', 'Agent work', { kind: 'agent', id: 'a1' }), task('brain', 'Brain work')];
    await open({ view: 'agent:a1', scope: { kind: 'agent', id: 'a1' } });
    await act(async () => button('Clear tasks').click());
    await settle();
    const dialogButton = (label: string) =>
      [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((b) => b.textContent === label)!;
    await act(async () => dialogButton('Cancel').click());
    await settle(250);
    expect(tasks.every((t) => t.status === 'pending')).toBe(true);
    await act(async () => button('Clear tasks').click());
    await settle();
    await act(async () => dialogButton('Clear tasks').click());
    await settle();
    expect(tasks.map((t) => t.status)).toEqual(['deleted', 'pending']);
  });

  it('visibly disables clearing when there are no open tasks', async () => {
    tasks = [{ ...task('done', 'Finished work'), status: 'completed' }];
    await open();
    expect(button('Clear tasks').disabled).toBe(true);
    await act(async () => button('Clear tasks').click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('closes and reopens the task panel through the same accessible toggle', async () => {
    await open();
    const toggle = button('Tasks');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById(toggle.getAttribute('aria-controls')!)).not.toBeNull();
    await act(async () => toggle.click());
    await settle();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(el.querySelector('[aria-label="Search tasks"]')).toBeNull();
    await act(async () => toggle.click());
    await settle(160);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(el.querySelector('[aria-label="Search tasks"]')).not.toBeNull();
  });

  it('shows all project tasks in the Brain view, with owner, status and dependency states', async () => {
    await open();
    expect(el.textContent).toContain('Write the report');
    expect(el.textContent).toContain('Review the report');
    expect(el.textContent).toContain('Blocked');
    expect(el.textContent).toContain('Waiting for 1 prerequisite');
    expect(requests.some((r) => r.url.includes('view=all'))).toBe(true);
    expect(el.querySelector('[aria-label="Task list"]')).not.toBeNull();
  });

  it('keeps agent and team views scoped and creates tasks on the matching list', async () => {
    tasks = [task('own', 'Agent work', { kind: 'agent', id: 'a1' })];
    await open({ view: 'agent:a1', scope: { kind: 'agent', id: 'a1' }, chatId: 'c1' });
    expect(el.textContent).toContain('Agent work');
    expect(el.querySelector('[aria-label="Task list"]')).toBeNull();
    await act(() => button('Add task').click());
    await fill(field('Title'), 'New agent work');
    await fill(field('Description'), 'Verify the output.');
    await act(() => button('Create task').click());
    await settle();
    expect(requests.find((r) => r.method === 'POST')?.body).toMatchObject({
      subject: 'New agent work',
      scope: { kind: 'agent', id: 'a1' },
      owner: 'agent:a1',
      chatId: 'c1',
    });
    expect(el.textContent).toContain('New agent work');
  });

  it('opens full details and saves edits with an optimistic version', async () => {
    await open();
    await act(() => button('Write the report').click());
    await settle();
    expect(field('Description').value).toContain('all checks pass');
    await fill(field('Title'), 'Write the final report');
    await act(() => button('Save task').click());
    await settle();
    expect(requests.find((r) => r.method === 'PUT')?.body).toMatchObject({
      subject: 'Write the final report',
      expectedUpdatedAt: 1,
    });
  });

  it('preserves a draft after a conflict and offers an explicit reload', async () => {
    await open();
    await act(() => button('Write the report').click());
    await settle();
    await fill(field('Title'), 'My unsaved draft');
    failSave = true;
    await act(() => button('Save task').click());
    await settle();
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('This task changed');
    expect(field('Title').value).toBe('My unsaved draft');
    expect(button('Reload saved task')).toBeTruthy();
  });

  it('searches, handles a load error, retries and refreshes from live task events', async () => {
    failLoad = true;
    await open();
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('could not load');
    failLoad = false;
    await act(() => button('Retry').click());
    await settle();
    expect(el.textContent).toContain('Write the report');
    tasks.push(task('added', 'Fresh live task'));
    await act(async () => FakeSocket.last.onmessage!({ data: JSON.stringify({ type: 'tasks', projectId: 'p1' }) }));
    await settle();
    expect(el.textContent).toContain('Fresh live task');
    await fill(el.querySelector<HTMLInputElement>('[aria-label="Search tasks"]')!, 'Fresh');
    await settle(160);
    expect(el.textContent).toContain('Fresh live task');
    expect(el.textContent).not.toContain('Write the report');
  });

  it('shows prerequisites in the editor and lets the user remove a link', async () => {
    await open();
    await act(() => button('Review the report').click());
    await settle();
    const remove = el.querySelector<HTMLButtonElement>('[aria-label="Remove prerequisite Write the report"]')!;
    expect(remove).not.toBeNull();
    await act(() => remove.click());
    await act(() => button('Save task').click());
    await settle();
    expect(requests.find((r) => r.method === 'PUT')?.body.removeBlockedBy).toEqual(['task1']);
  });
});
