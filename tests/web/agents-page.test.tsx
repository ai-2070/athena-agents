// The Agents page (React): the list, and the editor's Save, knowledge and Delete.
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { state } from '../../web/core.ts';
import * as agents from '../../web/views/agents.tsx';
import { engineLabel } from '../../web/views/agents.tsx';
import type { Agent, AppState } from '../../shared/types.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const settle = () => act(() => new Promise((r) => setTimeout(r, 30)));

const base = { emoji: '🤖', color: '#fff', description: '', systemPrompt: 'Be brief.', model: 'sonnet', provider: 'openrouter', claudeAuth: 'login', hermesProfile: '', toolGroups: [], mcpServers: [], workspace: '', temperature: '', alwaysAllow: [], skills: [], source: { type: 'custom' }, pinned: false };
const writer = { ...base, id: 'a1', name: 'Writer', specialty: 'Posts', engine: 'claude-code', autonomy: 'auto' } as unknown as Agent;
const coder = { ...base, id: 'a2', name: 'Coder', specialty: 'Code', engine: 'openai', autonomy: 'full', pinned: true } as unknown as Agent;
let folders: string[];
let requests: { method: string; url: string; body: unknown }[];
let el: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = '<div id="modal-root"></div><div id="toasts"></div><section id="view"></section>';
  el = document.getElementById('view')!;
  folders = [];
  requests = [];
  state.data = {
    agents: [writer, coder],
    runs: [],
    toolGroups: [{ id: 'files', label: 'Files', description: 'Read and write' }],
    engines: { 'claude-code': { installed: true } },
    engineList: [{ id: 'claude-code', label: 'Claude Code' }, { id: 'openai', label: 'API model' }],
    secrets: { anthropicKey: { set: false }, openrouterKey: { set: true } },
    settings: { defaults: { claudeModel: 'sonnet', openrouterModel: 'x/y' } },
    project: { id: 'p1', skills: [] },
  } as unknown as AppState;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : null;
    requests.push({ method, url, body });
    const json = (v: unknown) => new Response(JSON.stringify(v));
    if (url === '/api/agents/a1' && method === 'GET') return json({ ...writer, knowledge: { folders }, knowledgeFiles: [], workspacePath: 'C:\\data\\a1', tools: [] });
    if (url === '/api/agents/a1/knowledge' && method === 'POST') {
      folders = [...folders, body.folder];
      return json({ ok: true });
    }
    if (url === '/api/mcp') return json({ servers: { github: {} } });
    if (url.startsWith('/api/memory')) return json({ text: '', updatedAt: 0 });
    return json(url.includes('/hermes') || url.includes('/workflows') || url.includes('/openclaw') || url.includes('/models') ? [] : { ok: true });
  });
});
afterEach(() => {
  act(() => agents.unmount());
  vi.unstubAllGlobals();
});

const open = async (params: string[] = []) => {
  await act(async () => agents.render(el, params));
  await settle();
};
const btn = (root: ParentNode, text: string) => [...root.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === text)!;
const type = (input: HTMLInputElement | HTMLTextAreaElement, text: string) =>
  act(async () => {
    const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
const field = (label: string) => [...el.querySelectorAll('label.field')].find((f) => f.querySelector('span')?.textContent === label)!.querySelector<HTMLInputElement>('input, textarea, select')!;

describe('engineLabel()', () => {
  it('names the engine and, for some, which provider or profile', () => {
    expect(engineLabel({ engine: 'claude-code' })).toBe('Claude Code');
    expect(engineLabel({ engine: 'openai', provider: 'ollama' })).toContain('ollama');
  });
});

describe('the agents list', () => {
  it('shows each agent with Chat and Edit links, and searches them', async () => {
    await open();
    const cards = [...el.querySelectorAll('.card')];
    expect(cards.map((c) => c.querySelector('.card-title')!.textContent)).toEqual(['Writer', 'Coder']);
    expect([...cards[0].querySelectorAll('.card-foot a')].map((a) => a.getAttribute('href'))).toEqual(['#/agents/a1', '#/agents/a1/edit']);
    expect(cards[1].querySelector('[aria-label="pinned"]')).not.toBeNull();
    expect(cards[1].querySelector('.card-foot button')).toBeNull(); // no terminal for API models
    await type(el.querySelector<HTMLInputElement>('input[aria-label="Search agents"]')!, 'code');
    expect([...el.querySelectorAll('.card-title')].map((t) => t.textContent)).toEqual(['Coder']);
    await type(el.querySelector<HTMLInputElement>('input[aria-label="Search agents"]')!, '');
  });
});

describe('the agent editor', () => {
  it('enables Save once something changes, and saves the agent', async () => {
    await open(['a1', 'edit']);
    const save = btn(el, 'Save');
    expect(save.disabled).toBe(true);
    await type(field('Name'), 'Writer Pro');
    expect(save.disabled).toBe(false);
    await act(async () => save.click());
    await settle();
    expect(requests.find((r) => r.method === 'PUT' && r.url === '/api/agents/a1')!.body).toMatchObject({ name: 'Writer Pro', systemPrompt: 'Be brief.' });
    expect(btn(el, 'Save').disabled).toBe(true);
  });

  it('a folder linked as knowledge stays linked when you then save the agent', async () => {
    await open(['a1', 'edit']);
    await act(async () => btn(el, '+ Link a folder').click());
    const path = document.querySelector<HTMLInputElement>('#modal-root .modal-body input')!;
    await type(path, 'C:\\brand');
    await act(async () => btn(document.querySelector('#modal-root')!, 'Save').click());
    await settle();
    expect(el.textContent).toContain('C:\\brand');
    await type(field('Specialty'), 'Long posts');
    await act(async () => btn(el, 'Save').click());
    await settle();
    expect((requests.find((r) => r.method === 'PUT' && r.url === '/api/agents/a1')!.body as Agent).knowledge).toEqual({ folders: ['C:\\brand'] });
  });

  it('warns before leaving with changes not saved', async () => {
    await open(['a1', 'edit']);
    expect(window.onbeforeunload?.(new Event('beforeunload') as BeforeUnloadEvent)).toBeUndefined();
    await type(field('Specialty'), 'Changed');
    expect(window.onbeforeunload?.(new Event('beforeunload') as BeforeUnloadEvent)).toBe(true);
  });

  it('deletes the agent only after you confirm', async () => {
    await open(['a1', 'edit']);
    await act(async () => btn(el, 'Delete').click());
    await act(async () => btn(document.querySelector('.modal-foot')!, 'Delete').click());
    await settle();
    expect(requests.some((r) => r.method === 'DELETE' && r.url === '/api/agents/a1')).toBe(true);
    expect(location.hash).toBe('#/agents');
  });
});
