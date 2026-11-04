// The Library page (React, Base UI): tabs, search and groups, reading and hiring an agent, presets, and leaving it early.
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { state } from '../../web/core.ts';
import * as library from '../../web/views/library.tsx';
import type { AppState, LibraryAgentListing } from '../../shared/types.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const athena = (n: number): LibraryAgentListing[] =>
  Array.from({ length: n }, (_, i) => ({
    slug: `a${i}`,
    name: i === 0 ? 'Brand Guardian' : `Agent ${i}`,
    description: i === 0 ? 'protects the brand' : 'does things',
    emoji: '🤖',
    color: '',
    specialty: 'helps',
    group: i % 2 ? 'design' : 'engineering',
    groupLabel: i % 2 ? 'Design' : 'Engineering',
    tools: ['files', 'shell', 'agents'],
    skills: [],
    engine: '',
    starter: i === 2,
  }));
let lib: Record<string, unknown>;
let presets: Record<string, unknown>[];
let requests: { method: string; url: string; body: unknown }[];
let slowLibrary: Promise<void> | null;
let el: HTMLElement;

const settle = () => act(() => new Promise((r) => setTimeout(r, 30)));
const buttons = (text: string) => [...el.querySelectorAll<HTMLButtonElement>('button')].filter((b) => b.textContent?.trim() === text);
const click = (b: HTMLElement) => act(async () => b.click());

beforeEach(() => {
  document.body.innerHTML = '<div id="modal-root"></div><div id="toasts"></div><section id="view"></section>';
  el = document.getElementById('view')!;
  location.hash = '#/library';
  lib = { agents: athena(3), hermes: [], claude: [] };
  presets = [];
  requests = [];
  slowLibrary = null;
  library.resetLibrary();
  state.data = {
    agents: [],
    engines: { hermes: { installed: false } },
    secrets: { veniceKey: { set: true } },
    engineList: [
      { id: 'claude-code', label: 'Claude Code' },
      { id: 'codex', label: 'Codex' },
    ],
    settings: { defaults: { engine: 'claude-code', claudeModel: 'sonnet', openrouterModel: '' } },
  } as unknown as AppState;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method || 'GET';
    requests.push({ method, url, body: init.body ? JSON.parse(String(init.body)) : null });
    const json = (v: unknown) => new Response(JSON.stringify(v));
    if (url === '/api/library') {
      if (slowLibrary) await slowLibrary;
      return json(lib);
    }
    if (url === '/api/presets') return json(presets);
    if (url === '/api/state') return json(state.data);
    if (url === '/api/models?engine=eve&provider=venice') return json([{ id: 'venice-chat', name: 'Venice Chat', reasoningEfforts: ['low', 'high'] }]);
    if (url.startsWith('/api/models?')) return json([]);
    if (url === '/api/library/hire') return json({ id: 'new-1', name: 'Hired' });
    if (url === '/api/library/agent/a0') return json({ slug: 'a0', name: 'Brand Guardian', body: '---\nname: Brand Guardian\n---\n\nKeep the brand **consistent**.' });
    if (url.startsWith('/api/presets/') && method === 'DELETE') return json({ ok: true });
    return json({});
  });
});
afterEach(() => {
  act(() => library.unmount());
  vi.unstubAllGlobals();
});

const open = async () => {
  await act(async () => library.render(el));
  await settle();
};

describe('Library page', () => {
  it('opens on Athena with labelled tabs, and remembers the tab you picked', async () => {
    await open();
    const tabs = [...el.querySelectorAll<HTMLElement>('[role="tab"]')];
    expect(tabs.map((t) => t.textContent)).toEqual(['Athena (3)', 'Hermes profiles (0)', 'Claude Code subagents (0)', 'Your presets (0)']);
    expect(el.querySelector('[role="tablist"]')!.getAttribute('aria-label')).toBe('Agent library');
    expect(tabs[0].classList.contains('on')).toBe(true);
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
    await click(tabs[2]);
    act(() => library.unmount());
    await open();
    expect(el.querySelector('[role="tab"].on')!.textContent).toBe('Claude Code subagents (0)');
  });

  it('opens on Your presets from a ?tab=presets link', async () => {
    location.hash = '#/library?tab=presets';
    await open();
    expect(el.querySelector('[role="tab"].on')!.textContent).toBe('Your presets (0)');
    expect(el.textContent).toContain('No presets yet.');
  });

  it('narrows the agents by search, by group and to the starter team', async () => {
    await open();
    const titles = () => [...el.querySelectorAll('.card-title')].map((t) => t.textContent);
    expect(titles()).toEqual(['Brand Guardian', 'Agent 1', 'Agent 2']);
    expect([...el.querySelectorAll('[aria-label="Group"] button')].map((b) => b.textContent)).toEqual(['All', 'Starter team', 'Engineering', 'Design']);
    const search = el.querySelector<HTMLInputElement>('input[aria-label="Search the agents"]')!;
    expect(search.placeholder).toMatch(/^Search 3 agents/);
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      set.call(search, 'brand');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(titles()).toEqual(['Brand Guardian']);
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      set.call(search, '');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(buttons('Design')[0]);
    expect(titles()).toEqual(['Agent 1']);
    expect(buttons('Design')[0].classList.contains('on')).toBe(true);
    await click(buttons('Starter team')[0]);
    expect(titles()).toEqual(['Agent 2']);
    await click(buttons('All')[0]);
    expect(titles()).toHaveLength(3);
  });

  it("reads an agent's instructions, without its frontmatter, and hires it from there", async () => {
    await open();
    await click(buttons('Read')[0]);
    await settle();
    const dialog = document.querySelector<HTMLElement>('.modal')!;
    expect(dialog.textContent).toContain('Keep the brand consistent.');
    expect(dialog.textContent).not.toContain('name: Brand Guardian');
    await click([...dialog.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Hire')!);
    await settle();
    expect(requests.find((r) => r.url === '/api/library/hire')!.body).toMatchObject({ source: 'library', slug: 'a0' });
  });

  it('shows each engine\'s logo next to its name under "Runs on"', async () => {
    state.data!.engineList.push({ id: 'pi', label: 'pi' } as AppState['engineList'][number]);
    await open();
    const options = [...el.querySelectorAll<HTMLButtonElement>('[aria-label="Runs on"] button')];
    expect(options.map((b) => b.textContent)).toEqual(['Claude Code', 'Codex', 'pi']);
    for (const option of options) expect(option.querySelector('svg, img')).not.toBeNull();
    expect(options[2].querySelector('img')!.getAttribute('src')).toBe('/brand/engines/pi.svg');
  });

  it('hires on the engine picked under "Runs on", then offers Chat and Edit', async () => {
    await open();
    await click(buttons('Codex')[0]);
    await click(el.querySelector<HTMLButtonElement>('.card .btn.small')!);
    await settle();
    const hireCall = requests.find((r) => r.url === '/api/library/hire')!;
    expect(hireCall.body).toEqual({ source: 'library', slug: 'a0', overrides: { engine: 'codex', model: '' } });
    const foot = el.querySelector('.card .card-foot')!;
    expect([...foot.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Chat', 'Edit']);
    expect(document.getElementById('toasts')!.textContent).toContain('Brand Guardian joined your team');
  });

  it.each([{ effort: 'high' }, { effort: '' }])('keeps effort "$effort" when hiring with Venice', async ({ effort }) => {
    state.data!.engineList.push({ id: 'eve', label: 'API model' } as AppState['engineList'][number]);
    await open();
    await click(buttons('API model')[0]);
    await click(buttons('Choose API model')[0]);
    const veniceTab = [...document.querySelectorAll<HTMLButtonElement>('.model-tab')].find((b) => b.textContent === 'Venice')!;
    await click(veniceTab);
    await settle();
    await click(document.querySelector<HTMLButtonElement>('button[title="High effort"]')!);
    if (!effort) await click(document.querySelector<HTMLButtonElement>('button[title="The model\'s own default"]')!);
    const model = [...document.querySelectorAll<HTMLButtonElement>('.model-list .st-menu-item')].find((b) => b.textContent?.includes('Venice Chat'))!;
    await click(model);
    await settle();
    expect(el.textContent).toContain('Venice · venice-chat');
    await click(buttons('Venice · venice-chat')[0]);
    await settle();
    expect(document.querySelector('.model-effort-level.on')?.textContent).toBe(effort ? 'High' : 'Auto');
    await click([...document.querySelectorAll<HTMLButtonElement>('.model-list .st-menu-item')].find((b) => b.textContent?.includes('Venice Chat'))!);
    await click(el.querySelector<HTMLButtonElement>('.card .btn.small')!);
    expect(requests.find((r) => r.url === '/api/library/hire')?.body).toMatchObject({ source: 'library', overrides: { engine: 'eve', provider: 'venice', model: 'venice-chat', effort } });
  });

  it('deletes a preset only after you confirm', async () => {
    presets = [{ id: 'p1', kind: 'agent', name: 'Helper', emoji: '🙂' }];
    location.hash = '#/library?tab=presets';
    await open();
    await click(el.querySelector<HTMLButtonElement>('[aria-label="Delete the preset Helper"]')!);
    const sure = [...document.querySelectorAll<HTMLButtonElement>('.modal-foot button')].find((b) => b.textContent === 'Delete')!;
    presets = [];
    await click(sure);
    await settle();
    expect(requests.some((r) => r.method === 'DELETE' && r.url === '/api/presets/p1')).toBe(true);
    expect(el.textContent).toContain('No presets yet.');
  });

  it('says so when the library cannot load', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: 'disk on fire' }), { status: 500 }));
    await open();
    expect(el.textContent).toBe('Something went wrong: disk on fire');
  });

  it('draws nothing after you leave while it is still loading', async () => {
    let finish!: () => void;
    slowLibrary = new Promise((r) => (finish = r));
    await open();
    // the page's shape while it loads, with what is loading for screen readers
    expect(el.querySelector('[role="status"]')!.textContent).toContain('Loading library…');
    expect(el.querySelectorAll('.cards .card').length).toBeGreaterThan(0);
    act(() => library.unmount());
    finish();
    await settle();
    expect(el.textContent).toBe('');
  });
});
