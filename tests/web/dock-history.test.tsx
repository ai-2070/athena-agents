// The Brain chat reopened: its earlier answers show the files it read, what it did and the work it
// handed on (the agent's turn, the team's replies) as they did live.
import { act } from 'react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { state } from '../../web/core.ts';
import { initDock } from '../../web/dock.tsx';
import type { AppState } from '../../shared/types.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const settle = () => act(() => new Promise((r) => setTimeout(r, 40)));

const history = [
  { role: 'user', text: 'make a review skill', ts: 1 },
  {
    role: 'brain',
    text: 'I made it and asked the team to use it.',
    ts: 2,
    steps: [{ id: 't1', name: 'Read', input: { file_path: 'PROJECT.md' }, state: 'done', output: '# Project' }],
    done: [
      { kind: 'skill', text: 'Made the skill "Finish the job"', skillId: 'finish-the-job' },
      ...['Created', 'Updated', 'Removed'].map((verb) => ({ kind: 'task', taskId: 'task-internal-id', text: `${verb} task: Check the report [phase 2] [task-internal-id]` })),
    ],
    delegate: { kind: 'branch', id: 'w1', name: 'Review Team', message: 'Check the app.', sent: { messageId: 'brief', ts: 3 } },
  },
  { role: 'user', text: 'and have Scout look too', ts: 10 },
  { role: 'brain', text: 'Scout is on it.', ts: 11, delegate: { kind: 'agent', id: 'a1', name: 'Scout', message: 'Look.', sent: { chatId: 'c1', runId: 'r1' } } },
  { role: 'user', text: 'and the old team', ts: 20 },
  { role: 'brain', text: 'Sent.', ts: 21, delegate: { kind: 'branch', id: 'gone', name: 'Old Team', message: 'Hi.', sent: { messageId: 'b2', ts: 22 } } },
];
const scoutChat = {
  id: 'c1',
  agentId: 'a1',
  items: [
    { type: 'user', text: 'Look.' },
    { type: 'tool', id: 'x', name: 'list_files', args: { path: '.' }, result: 'a.ts', status: 'done' },
    { type: 'assistant', text: 'Scout found two files.' },
  ],
};

beforeAll(() => {
  document.body.append(Object.assign(document.createElement('div'), { id: 'toasts' }));
  state.data = {
    runs: [],
    approvals: [],
    agents: [{ id: 'a1', name: 'Scout', emoji: '🔭', engine: 'eve', model: 'm', provider: 'custom' }],
    project: { id: 'p1', name: 'P' },
    settings: { brain: { provider: 'claude', model: 'haiku' } },
  } as unknown as AppState;
  vi.stubGlobal('fetch', async (url: string) => {
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
    if (url === '/api/brain/history') return json(history);
    if (url === '/api/workflows') return json([{ id: 'w1', name: 'Review Team', members: ['a1'], steps: [] }]);
    if (url === '/api/teams/w1/chat') return json({ messages: [{ id: 'brief', ts: 3, from: 'brain', text: 'Check the app.', mentions: [] }, { id: 'm2', ts: 5, from: 'a1', text: 'The team checked it: all good.', mentions: [] }], working: [], queued: [] });
    if (url === '/api/teams/gone/chat') return json({ error: 'No such team' }, 404);
    if (url === '/api/runs') return json([]);
    // (no run going in Scout's chat: nothing to resume)
    if (url === '/api/agents/a1/chats/c1/stream') return new Response(null, { status: 204 });
    if (url === '/api/agents/a1/chats/c1') return json(scoutChat);
    return json({});
  });
  initDock();
});
afterAll(() => vi.unstubAllGlobals());

describe('a reopened Brain chat', () => {
  it('shows the files it read, what it did, and the work it handed on', async () => {
    const list = document.querySelector('.dock-list')!;
    for (let i = 0; i < 50 && !list.textContent?.includes('Scout found two files.'); i++) await settle();
    const text = list.textContent || '';
    expect(text).toContain('I made it and asked the team to use it.');
    // the file it read, as a step, and the skill it made as an action (not "(…)" lines)
    expect([...list.querySelectorAll('.tool .tname')].map((n) => n.textContent)).toContain('Read');
    expect(text).toContain('Made the skill "Finish the job"');
    for (const verb of ['Created', 'Updated', 'Removed']) expect(text).toContain(`${verb} task: Check the report [phase 2]`);
    expect(text).not.toContain('task-internal-id');
    expect(text).not.toContain('(Made the skill');
    // the team's reply to its brief (not the brief itself), and Scout's turn with its tool call
    expect(text).toContain('The team checked it: all good.');
    expect(text).toContain('Scout found two files.');
    expect(text).toContain('list_files');
    // a team deleted since: no card left waiting on it
    expect(text).not.toContain('Sent to the team…');
  });
});
