// Settings > General & keys (React): what Save sends, switches that save at once, keys.
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { state } from '../../web/core.ts';
import * as general from '../../web/views/settings.tsx';
import { setPath } from '../../web/views/settings.tsx';
import type { AppState, VeniceAccountInfo } from '../../shared/types.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const settle = () => act(() => new Promise((r) => setTimeout(r, 30)));

const settings = {
  brainApproves: true,
  brainFollowsUp: true,
  brainTools: 'full',
  brainAnyGitHub: false,
  brain: { provider: 'claude', model: 'haiku' },
  defaults: { engine: 'claude-code', claudeModel: 'sonnet', openrouterModel: 'x/y', autonomy: 'ask' },
  maxToolSteps: 20,
  costLimitUsdPerRun: 1,
  contextWindowTokens: 0,
  providers: {
    lmstudio: { baseUrl: 'http://127.0.0.1:1234/v1' },
    ollama: { baseUrl: 'http://127.0.0.1:11434/v1' },
    custom: { baseUrl: '' },
  },
  comfyui: { url: '', workflowDirs: [] },
  paths: {},
  allowedFolders: [],
};
const secrets = {
  openrouterKey: { set: false },
  veniceKey: { set: false },
  anthropicKey: { set: false },
  customKey: { set: false },
};
let veniceAccount: VeniceAccountInfo;
let requests: { method: string; url: string; body: unknown }[];
let refuse: string | null;
let grants: { server: string; tool: string }[];
let el: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = '<div id="modal-root"></div><div id="toasts"></div><section id="view"></section>';
  el = document.getElementById('view')!;
  requests = [];
  refuse = null;
  grants = [];
  secrets.veniceKey.set = false;
  veniceAccount = { accessPermitted: true, expired: false, expiresAt: null, balances: { usd: 3, diem: 5, bundled: 0 } };
  state.data = {
    port: 4800,
    dataDir: 'C:\\data',
    engines: {
      'claude-code': { installed: true, version: '2.1' },
      codex: { installed: true, loggedIn: true },
      hermes: { installed: false },
    },
    engineList: [
      { id: 'claude-code', label: 'Claude Code' },
      { id: 'codex', label: 'Codex' },
    ],
    settings,
  } as unknown as AppState;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method || 'GET';
    requests.push({ method, url, body: init.body ? JSON.parse(String(init.body)) : null });
    if (refuse && url.endsWith(refuse) && method !== 'GET')
      return new Response(JSON.stringify({ error: 'nope' }), { status: 500 });
    if (url === '/api/settings')
      return new Response(JSON.stringify(method === 'GET' ? { settings, secrets } : { ok: true }));
    if (url === '/api/state') return new Response(JSON.stringify(state.data));
    if (url === '/api/settings/test-venice') return Response.json(veniceAccount);
    if (url === '/api/brain-tools/allowed') return Response.json({ allowed: grants });
    if (url === '/api/brain-tools/allowed/forget') {
      const { server, tool } = JSON.parse(String(init.body)) as { server: string; tool: string };
      grants = grants.filter((g) => g.server !== server || g.tool !== tool);
      return Response.json({ allowed: grants });
    }
    return new Response('{}');
  });
});
afterEach(() => {
  act(() => general.unmount());
  vi.unstubAllGlobals();
});

const open = async () => {
  await act(async () => general.render(el));
  await settle();
};
const type = (input: HTMLInputElement | HTMLTextAreaElement, text: string) =>
  act(async () => {
    const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
const fieldInput = (label: string) =>
  [...el.querySelectorAll('label.field')]
    .find((f) => f.querySelector('span')?.textContent === label)!
    .querySelector<HTMLInputElement>('input, textarea')!;
const button = (text: string) =>
  [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === text)!;
const switchFor = (text: string) => [...el.querySelectorAll('label.switch-row')].find((l) => l.textContent === text)!;

describe('setPath()', () => {
  it('puts a value at a dotted path, keeping what is already there', () => {
    const p: Record<string, unknown> = {};
    setPath(p, 'defaults.engine', 'codex');
    setPath(p, 'defaults.autonomy', 'auto');
    setPath(p, 'maxToolSteps', 5);
    expect(p).toEqual({ defaults: { engine: 'codex', autonomy: 'auto' }, maxToolSteps: 5 });
  });
});

describe('General & keys', () => {
  it('saves, tests and removes a Venice key without putting it into settings', async () => {
    secrets.veniceKey.set = true;
    await open();
    const row = () =>
      [...el.querySelectorAll('.ai-key')].find((r) => r.querySelector('label')?.textContent === 'Venice key')!;
    const action = (name: string) =>
      [...row().querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === name)!;
    expect(row().querySelector('input')?.type).toBe('password');
    await type(row().querySelector('input')!, ' venice-secret ');
    await act(async () => action('Save').click());
    await settle();
    expect(requests.find((r) => r.url === '/api/secrets')?.body).toEqual({ key: 'veniceKey', value: 'venice-secret' });
    expect(row().querySelector('input')?.value).toBe('');
    await act(async () => action('Test').click());
    await settle();
    expect(row().querySelector('[role="status"]')?.textContent).toContain('The key works');
    expect(row().textContent).toContain('$3.00 USD · 5.00 DIEM · 0.00 bundled credits');
    expect(requests.some((r) => r.url === '/api/settings/test-venice' && r.method === 'POST')).toBe(true);
    await act(async () => action('Remove').click());
    expect(requests.filter((r) => r.url === '/api/secrets').at(-1)?.body).toEqual({ key: 'veniceKey', value: '' });
    expect(requests.filter((r) => r.url === '/api/settings' && r.method === 'PUT')).toHaveLength(0);
  });

  it('keeps expired and access-blocked keys distinct from a successful test', async () => {
    secrets.veniceKey.set = true;
    veniceAccount.expired = true;
    await open();
    const row = [...el.querySelectorAll('.ai-key')].find(
      (r) => r.querySelector('label')?.textContent === 'Venice key',
    )!;
    const test = () => [...row.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Test')!;
    await act(async () => test().click());
    expect(row.textContent).toContain('key has expired');
    veniceAccount = { ...veniceAccount, expired: false, accessPermitted: false };
    await act(async () => test().click());
    expect(row.textContent).toContain('blocked API access');
  });

  it('saves the Venice default independently of the OpenRouter default', async () => {
    await open();
    await type(fieldInput('Venice model'), 'my-venice-model');
    await act(async () => button('Save settings').click());
    expect(requests.find((r) => r.method === 'PUT' && r.url === '/api/settings')?.body).toEqual({
      defaults: { veniceModel: 'my-venice-model' },
    });
  });

  it('Save settings sends only what you changed', async () => {
    await open();
    await type(fieldInput('Max tool steps per message'), '7');
    await type(fieldInput('Extra ComfyUI workflow folders'), 'C:\\flows\n\n D:\\more ');
    await act(async () =>
      [...el.querySelectorAll<HTMLButtonElement>('.seg button')].find((b) => b.textContent === 'Codex')!.click(),
    );
    await act(async () => button('Save settings').click());
    await settle();
    const put = requests.find((r) => r.method === 'PUT' && r.url === '/api/settings')!;
    expect(put.body).toEqual({
      maxToolSteps: 7,
      comfyui: { workflowDirs: ['C:\\flows', 'D:\\more'] },
      defaults: { engine: 'codex' },
    });
  });

  it('a Brain switch saves at once, and shows the real setting again when saving fails', async () => {
    await open();
    const row = switchFor('The Brain follows up');
    const sw = row.querySelector<HTMLElement>('[role="switch"]')!;
    expect(sw.getAttribute('aria-checked')).toBe('true');
    // clicking its text flips it too
    await act(async () => row.querySelector<HTMLElement>('.toggle-text')!.click());
    await settle();
    expect(requests.filter((r) => r.method === 'PUT').map((r) => r.body)).toEqual([{ brainFollowsUp: false }]);
    expect(row.querySelector('[role="switch"]')!.getAttribute('aria-checked')).toBe('false');
    refuse = '/api/settings';
    await act(async () => switchFor('The Brain approves').querySelector<HTMLElement>('[role="switch"]')!.click());
    await settle();
    expect(switchFor('The Brain approves').querySelector('[role="switch"]')!.getAttribute('aria-checked')).toBe('true');
    expect(document.getElementById('toasts')!.textContent).toContain('nope');
  });

  it("the Brain's tool access starts on Full and saves at once", async () => {
    await open();
    const seg = el.querySelector('[aria-label="Tool access"]')!;
    const choice = (text: string) =>
      [...seg.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === text)!;
    expect(choice('Full').className).toContain('on');
    await act(async () => choice('Ask first').click());
    await settle();
    expect(requests.filter((r) => r.method === 'PUT').map((r) => r.body)).toEqual([{ brainTools: 'ask' }]);
    expect(el.textContent).toContain('Anything else waits for you in Needs you');
  });

  it('shows the tools the Brain may use without asking, and takes one back', async () => {
    await open();
    expect(el.textContent).not.toContain('Always allowed');
    act(() => general.unmount());
    grants = [
      { server: 'composio', tool: 'GMAIL_SEND_EMAIL' },
      { server: 'oomol', tool: 'DRIVE_UPLOAD' },
    ];
    await open();
    const list = el.querySelector('.brain-grants')!;
    expect(list.textContent).toContain('composio · GMAIL_SEND_EMAIL');
    await act(async () =>
      list.querySelector<HTMLButtonElement>('[aria-label="Take back GMAIL_SEND_EMAIL on composio"]')!.click(),
    );
    await settle();
    expect(requests.find((r) => r.url === '/api/brain-tools/allowed/forget')?.body).toEqual({
      server: 'composio',
      tool: 'GMAIL_SEND_EMAIL',
    });
    expect(el.querySelector('.brain-grants')!.textContent).not.toContain('GMAIL_SEND_EMAIL');
    expect(el.querySelector('.brain-grants')!.textContent).toContain('DRIVE_UPLOAD');
  });

  it('saves a key, then clears the box; Save waits until a key is typed', async () => {
    await open();
    // the key's row: found by its label, with its own Save button
    const row = () =>
      [...el.querySelectorAll('.ai-key')].find((r) => r.querySelector('label')?.textContent === 'OpenRouter key')!;
    const key = () => row().querySelector<HTMLInputElement>('input')!;
    const save = () => [...row().querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Save')!;
    expect(row().querySelector('label')!.htmlFor).toBe(key().id);
    expect(key().type).toBe('password');
    expect(save().disabled).toBe(true);
    await type(key(), ' sk-or-123 ');
    expect(save().disabled).toBe(false);
    await act(async () => save().click());
    await settle();
    expect(requests.find((r) => r.url === '/api/secrets')!.body).toEqual({ key: 'openrouterKey', value: 'sk-or-123' });
    expect(key().value).toBe('');
  });

  it('adds decorative marks to model choices and program fields without changing their names', async () => {
    await open();
    const sections = [...el.querySelectorAll('.settings-section h2')];
    const folderIndex = sections.findIndex((heading) => heading.textContent === 'Allowed folders');
    expect(sections[folderIndex - 2].textContent).toBe("The Brain's model");
    expect(sections[folderIndex - 1].textContent).toBe("The Brain's tools");
    expect(sections[folderIndex].querySelector('svg')).not.toBeNull();
    const labels = [...el.querySelectorAll('label.field')].map((field) => field.querySelector('span')?.textContent);
    expect(labels.indexOf('ComfyUI path')).toBe(labels.indexOf('Extra ComfyUI workflow folders') + 1);
    expect(labels.indexOf('Blender path')).toBe(labels.indexOf('ComfyUI path') + 1);
    const brain = el.querySelector('[aria-label="Brain"].seg')!;
    for (const button of brain.querySelectorAll('button')) expect(button.querySelector('svg, img')).not.toBeNull();
    for (const label of [
      'LM Studio server',
      'Ollama server',
      'Blender path',
      'Extra ComfyUI workflow folders',
      'Venice model',
    ]) {
      const field = [...el.querySelectorAll('label.field')].find(
        (f) => f.querySelector('span')?.textContent === label,
      )!;
      expect(field.querySelector('svg, img')).not.toBeNull();
      expect(field.querySelector('input, textarea')).not.toBeNull();
    }
  });

  it('shows each engine with its logo and status, and copies an install command', async () => {
    const copied: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (t: string) => void copied.push(t) },
    });
    await open();
    const names = [...el.querySelectorAll('.ai-row .ai-name')].map((n) => n.textContent);
    expect(names).toEqual(
      expect.arrayContaining([
        'Claude Code',
        'OpenAI Codex',
        'Hermes',
        'pi coding agent',
        'oh-my-pi',
        'OpenClaw',
        'opencode',
        'OpenRouter key',
        'Anthropic API key',
      ]),
    );
    // every engine and key row has a mark (a logo or its glyph)
    for (const r of el.querySelectorAll('.ai-list .ai-row'))
      expect(r.querySelector('.ai-mark')!.childNodes.length).toBeGreaterThan(0);
    for (const [name, engine] of [
      ['Venice key', 'venice'],
      ['Hermes', 'hermes'],
      ['pi coding agent', 'pi'],
      ['oh-my-pi', 'omp'],
      ['OpenClaw', 'openclaw'],
      ['opencode', 'opencode'],
    ]) {
      const row = [...el.querySelectorAll('.ai-row')].find((r) => r.querySelector('.ai-name')?.textContent === name)!;
      const image = row.querySelector<HTMLImageElement>('.ai-mark img')!;
      expect(image.getAttribute('src')).toBe(`/brand/engines/${engine}.svg`);
      expect(image.getAttribute('aria-hidden')).toBe('true');
      expect(image.getAttribute('width')).toBe(engine === 'pi' ? '15' : '17');
    }
    // pi isn't in this state, so it shows its install command
    const copy = el.querySelector<HTMLButtonElement>('.ai-cmd button')!;
    await act(async () => copy.click());
    await settle();
    expect(copied).toEqual(['npm install -g @earendil-works/pi-coding-agent']);
  });
});
