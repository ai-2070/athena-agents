import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { state } from '../../web/core.ts';
import { openModelPicker } from '../../web/models.ts';
import { openBranchBuilder } from '../../web/builder.ts';
import type { ModelPatch } from '../../web/models.ts';
import type { AppState } from '../../shared/types.ts';

type Reply = { status?: number; body: unknown };
type Route = (method: string, path: string, body: unknown) => Reply | undefined;
const calls: { method: string; path: string; body: unknown }[] = [];

// Answer the client's fetch('/api/...') calls from a route function.
function serve(route: Route) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method || 'GET';
      const path = String(url).replace(/^\/api/, '');
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path, body });
      const r = route(method, path, body) || (path === '/state' ? { body: state.data } : { status: 404, body: { error: 'not found' } });
      return new Response(JSON.stringify(r.body), { status: r.status || 200 });
    }),
  );
}
const settle = () => new Promise((r) => setTimeout(r, 20));
const buttons = (root: ParentNode, text: string) => [...root.querySelectorAll('button')].filter((b) => b.textContent?.includes(text));

beforeEach(() => {
  calls.length = 0;
  document.body.innerHTML = '<div id="toasts"></div><div id="modal-root"></div>';
  state.data = { agents: [], toolGroups: [], engines: {}, secrets: {}, runs: [], approvals: [] } as unknown as AppState;
});
afterEach(() => {
  vi.unstubAllGlobals();
  state.data = null;
});

describe('model picker: models on this PC', () => {
  it("lists each local server's own models, so picking one never sends an empty model", async () => {
    serve((_m, path) => {
      if (path === '/models?engine=openai&provider=ollama') return { body: [{ id: 'llama3.2' }, { id: 'qwen3' }] };
      if (path.startsWith('/models?engine=openai&provider=')) return { body: [] };
    });
    const picked: ModelPatch[] = [];
    openModelPicker(document.body, { engine: 'openai', provider: 'ollama', model: 'llama3.2' }, (p) => picked.push(p));
    await settle();
    const menu = document.querySelector('.model-menu')!;
    expect(menu.textContent).toContain('No models found. Is LM Studio running?');
    expect(menu.querySelector('.st-menu-item.on')?.textContent).toContain('llama3.2');
    buttons(menu, 'qwen3')[0].click();
    expect(picked).toEqual([{ engine: 'openai', provider: 'ollama', model: 'qwen3' }]);
  });

  it('can type a model id for a local server', async () => {
    serve(() => ({ body: [] }));
    const picked: ModelPatch[] = [];
    openModelPicker(document.body, { engine: 'openai', provider: 'openrouter', model: 'x/y' }, (p) => picked.push(p));
    await settle();
    const input = [...document.querySelectorAll<HTMLInputElement>('.model-search')].find((i) => i.placeholder.includes('LM Studio'))!;
    input.value = 'my-model';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(picked).toEqual([{ engine: 'openai', provider: 'lmstudio', model: 'my-model' }]);
  });
});

describe('team builder: saving', () => {
  const draft = (name: string) => ({ newAgent: { name, emoji: '🤖', specialty: '', systemPrompt: '', toolGroups: [], mcpServers: [], engine: 'claude-code' as const } });
  let failHire: string | null = null;
  let failTeam = false;
  beforeEach(() => {
    failHire = null;
    failTeam = false;
    let n = 0;
    serve((method, path, body) => {
      if (path === '/mcp') return { body: { servers: {} } };
      if (method === 'POST' && path === '/agents') {
        const name = (body as { name: string }).name;
        return name === failHire ? { status: 500, body: { error: 'nope' } } : { body: { id: `id-${name}-${++n}`, name } };
      }
      if (method === 'POST' && path === '/workflows') return failTeam ? { status: 500, body: { error: 'nope' } } : { body: { id: 'team1', ...(body as object) } };
    });
  });
  const hires = () => calls.filter((c) => c.method === 'POST' && c.path === '/agents').map((c) => (c.body as { name: string }).name);
  const teamBody = () => calls.find((c) => c.method === 'POST' && c.path === '/workflows')?.body as { members: string[]; lead: string | null } | undefined;
  const saveBtn = () => buttons(document, 'Create team')[0];

  it('keeps a new-agent lead after removing a member above it', async () => {
    await openBranchBuilder({ prefill: { name: 'Crew', members: [draft('A'), draft('B'), draft('C')], leadIndex: 1 } });
    buttons(document, '✕').filter((b) => b.title === 'Remove')[0].click();
    saveBtn().click();
    await settle();
    expect(hires()).toEqual(['B', 'C']);
    const body = teamBody()!;
    expect(body.lead).toMatch(/^id-B-/);
    expect(body.members[0]).toBe(body.lead);
  });

  it('a double click saves once', async () => {
    await openBranchBuilder({ prefill: { name: 'Crew', members: [draft('A'), draft('B')], leadIndex: -1 } });
    saveBtn().click();
    saveBtn().click();
    await settle();
    expect(hires()).toEqual(['A', 'B']);
    expect(calls.filter((c) => c.path === '/workflows')).toHaveLength(1);
  });

  it('a retry after a failed hire does not hire the earlier agents again', async () => {
    await openBranchBuilder({ prefill: { name: 'Crew', members: [draft('A'), draft('B')], leadIndex: 0 } });
    failHire = 'B';
    saveBtn().click();
    await settle();
    expect(teamBody()).toBeUndefined();
    failHire = null;
    saveBtn().click();
    await settle();
    expect(hires()).toEqual(['A', 'B', 'B']);
    const body = teamBody()!;
    expect(body.members).toHaveLength(2);
    expect(body.lead).toMatch(/^id-A-/);
  });

  it('a retry after a failed team save reuses the hired agents', async () => {
    await openBranchBuilder({ prefill: { name: 'Crew', members: [draft('A')], leadIndex: 0 } });
    failTeam = true;
    saveBtn().click();
    await settle();
    failTeam = false;
    saveBtn().click();
    await settle();
    expect(hires()).toEqual(['A']);
    const posts = calls.filter((c) => c.path === '/workflows');
    expect(posts).toHaveLength(2);
    expect((posts[1].body as { lead: string }).lead).toMatch(/^id-A-/);
  });

  it("editing a step list keeps its approval and post steps (the Station's stepList)", async () => {
    state.data!.agents = [{ id: 'a1', name: 'Writer' }, { id: 'a2', name: 'Editor' }] as AppState['agents'];
    serve((method, path, body) => {
      if (path === '/mcp') return { body: { servers: {} } };
      if (method === 'PUT' && path === '/workflows/w1') return { body: body };
    });
    const stepList = [{ type: 'agent', agentId: 'a1' }, { type: 'approval' }, { type: 'agent', agentId: 'a2' }, { type: 'x_post' }];
    const wf = { id: 'w1', name: 'Posting', members: ['a1', 'a2'], steps: [{ type: 'agent', agentId: 'a1' }, { type: 'agent', agentId: 'a2' }], stepList };
    await openBranchBuilder({ wf: wf as never });
    buttons(document, '✕').filter((b) => b.title === 'Remove')[1].click();
    buttons(document, 'Save team')[0].click();
    await settle();
    const put = calls.find((c) => c.method === 'PUT')!.body as { steps: { type: string; agentId?: string }[]; stepList?: unknown };
    expect(put.steps.map((x) => x.agentId || x.type)).toEqual(['a1', 'approval', 'x_post']);
    expect(put.stepList).toBeUndefined();
  });
});
