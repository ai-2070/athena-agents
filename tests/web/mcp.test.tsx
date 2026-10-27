// Settings > MCP servers (React): the server form in a dialog, Test, Remove, presets; and openModal().
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as mcp from '../../web/views/mcp.tsx';
import { parseHeaders, parseKv } from '../../web/views/mcp.tsx';
import { confirmBox } from '../../web/core.ts';
import { openModal } from '../../web/ui/overlays.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const settle = () => act(() => new Promise((r) => setTimeout(r, 30)));

let servers: Record<string, unknown>;
// GET /api/mcp "suggested" (left out, like an older server sends it, unless a test sets it)
let suggested: unknown[] | undefined;
let requests: { method: string; url: string; body: unknown }[];
let el: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = '<div id="modal-root"></div><div id="toasts"></div><section id="view"></section>';
  el = document.getElementById('view')!;
  servers = { playwright: { type: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp'], env: {}, url: '', headers: {} } };
  requests = [];
  suggested = undefined;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : null;
    requests.push({ method, url, body });
    const json = (v: unknown) => new Response(JSON.stringify(v));
    if (url === '/api/mcp' && method === 'GET') return json({ servers, presets: [{ name: 'github', title: 'GitHub', description: 'Repos', ready: true, installed: false, type: 'stdio', command: 'npx', args: ['gh'], env: { TOKEN: 'YOUR_TOKEN' } }], ...(suggested ? { suggested } : {}), importable: [], bridge: { command: 'bun', args: ['bridge.js'], env: {} } });
    if (url === '/api/tools') return json({ groups: [{ id: 'files', label: 'Files', description: 'Read and write' }], tools: [{ name: 'read_file', group: 'files', risk: 'none', description: 'Reads' }, { name: 'shell', group: 'files', risk: 'high', description: 'Runs' }] });
    if (url === '/api/mcp/playwright/test') return json({ tools: [{ name: 'click' }, { name: 'type' }] });
    if (url === '/api/mcp' && method === 'POST') {
      servers = { ...servers, [body.name]: body };
      return json({ ok: true });
    }
    if (method === 'DELETE') {
      servers = {};
      return json({ ok: true });
    }
    return json({ ok: true });
  });
});
afterEach(() => {
  act(() => mcp.unmount());
  vi.unstubAllGlobals();
});

const open = async () => {
  await act(async () => mcp.render(el));
  await settle();
};
const btn = (root: ParentNode, text: string) => [...root.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === text)!;
const type = (input: HTMLInputElement | HTMLTextAreaElement, text: string) =>
  act(async () => {
    const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
const field = (label: string) => [...document.querySelectorAll('#modal-root label.field')].find((f) => f.querySelector('span')?.textContent === label)!.querySelector<HTMLInputElement>('input, textarea')!;

describe('parsing', () => {
  it('reads KEY=value and Name: value lines, skipping the rest', () => {
    expect(parseKv('A=1\n\n B = two=2 \nnot this')).toEqual({ A: '1', B: 'two=2' });
    expect(parseHeaders('Authorization: Bearer x:y\nnope')).toEqual({ Authorization: 'Bearer x:y' });
  });
});

describe('the MCP servers tab', () => {
  it('suggests servers for programs on this PC, with why and what they need, and adds one only on a click', async () => {
    suggested = [
      { name: 'blender', title: 'Blender (live)', description: 'Control a running Blender scene.', reason: 'Blender is installed', needs: 'setup: install the add-on in Blender', program: 'blender' },
      { name: 'fetch', title: 'Web fetch', description: 'Fetch any URL.', reason: 'useful to most agents, no key or setup', needs: '', program: null },
    ];
    await open();
    expect(el.textContent).toContain('Suggested for this PC');
    const rows = [...el.querySelectorAll('.mcp-suggest')];
    expect(rows.map((r) => r.querySelector('.mcp-why')!.textContent)).toEqual(['Blender is installed', 'useful to most agents, no key or setup']);
    expect(rows[0].querySelector('.mcp-why')!.classList.contains('on')).toBe(true);
    expect(rows[0].textContent).toContain('First: install the add-on in Blender');
    expect(requests.some((r) => r.url === '/api/mcp-preset')).toBe(false);
    await act(async () => btn(rows[0], 'Add').click());
    await settle();
    expect(requests.find((r) => r.url === '/api/mcp-preset')!.body).toEqual({ name: 'blender' });
  });

  it('shows no suggestions section when there are none (or the server sends none)', async () => {
    await open();
    expect(el.textContent).not.toContain('Suggested for this PC');
  });

  it('lists servers, presets and built-in tools with their risk', async () => {
    await open();
    expect(el.querySelector('.mcp-server .title')!.textContent).toBe('playwright');
    expect(el.textContent).toContain('needs your key');
    expect(el.textContent).toContain('Built-in tools (2)');
    expect([...el.querySelectorAll('.mcp-tool')].map((t) => t.textContent)).toEqual(['read_file', 'shell ●']);
  });

  it('tests a server and shows its tools', async () => {
    await open();
    await act(async () => btn(el, 'Test').click());
    await settle();
    expect(el.querySelector('.mcp-server .pill.ok')!.textContent).toBe('2 tools');
    expect(el.querySelector('.mcp-tools')!.textContent).toBe('click · type');
  });

  it('adds a remote server from the form, then lists it', async () => {
    await open();
    await act(async () => btn(el, '+ Add server').click());
    expect(document.querySelector('#modal-root .modal h2')!.textContent).toBe('Add MCP server');
    await type(field('Name'), 'notion');
    await act(async () => btn(document.querySelector('#modal-root')!, 'Remote URL').click());
    await type(field('URL'), 'https://mcp.notion.com/mcp');
    await type(field('Headers'), 'Authorization: Bearer abc');
    await act(async () => btn(document.querySelector('#modal-root')!, 'Save').click());
    await settle();
    const post = requests.find((r) => r.method === 'POST' && r.url === '/api/mcp')!;
    expect(post.body).toMatchObject({ name: 'notion', type: 'http', url: 'https://mcp.notion.com/mcp', headers: { Authorization: 'Bearer abc' } });
    expect(document.querySelector('#modal-root .modal')).toBeNull();
    expect([...el.querySelectorAll('.mcp-server .title')].map((t) => t.textContent)).toEqual(['playwright', 'notion']);
  });

  it('edits a server with its name locked and its arguments and environment filled in', async () => {
    await open();
    await act(async () => btn(el, 'Edit').click());
    expect(field('Name').disabled).toBe(true);
    expect(field('Arguments').value).toBe('-y @playwright/mcp');
    await type(field('Environment'), 'DEBUG=1');
    await act(async () => btn(document.querySelector('#modal-root')!, 'Save').click());
    await settle();
    expect(requests.find((r) => r.method === 'POST' && r.url === '/api/mcp')!.body).toMatchObject({ name: 'playwright', args: ['-y', '@playwright/mcp'], env: { DEBUG: '1' } });
  });

  it('removes a server only after you confirm', async () => {
    await open();
    await act(async () => btn(el, 'Remove').click());
    await act(async () => btn(document.querySelector('.modal-foot')!, 'Remove').click());
    await settle();
    expect(requests.some((r) => r.method === 'DELETE' && r.url === '/api/mcp/playwright')).toBe(true);
    expect(el.textContent).toContain('None yet. Add a preset below.');
  });
});

describe('openModal()', () => {
  it('draws React content, stacks a confirm on top, and closing it closes the confirm too', async () => {
    let close!: () => void;
    await act(async () => void openModal('Form', (c) => ((close = c), <div className="modal-body"><input aria-label="Name" /></div>)));
    let asked!: Promise<boolean>;
    await act(async () => void (asked = confirmBox('Sure?')));
    expect([...document.querySelectorAll('#modal-root .modal h2')].map((h) => h.textContent)).toEqual(['Form', 'Are you sure?']);
    await act(async () => close());
    expect(await asked).toBe(false);
    expect(document.querySelector('#modal-root .modal')).toBeNull();
  });
});
