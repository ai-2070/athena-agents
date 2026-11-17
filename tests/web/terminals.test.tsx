// The Terminals page (React): which terminal shows, tabs as links with their own close button, the launcher.
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { state } from '../../web/core.ts';
import * as terminals from '../../web/views/terminals.tsx';
import { pickTerminal, terminalTheme } from '../../web/views/terminals.tsx';
import type { AppState } from '../../shared/types.ts';

// (no real terminal in happy-dom: an open terminal is just its host element here; made ones are kept, to see their theme)
const made: { options: { theme?: Record<string, string> }; disposed: boolean }[] = [];
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options: { theme?: Record<string, string> };
    disposed = false;
    constructor(o: { theme?: Record<string, string> }) {
      this.options = { ...o };
      made.push(this);
    }
    loadAddon() {}
    open() {}
    focus() {}
    write() {}
    onData() {
      return { dispose() {} };
    }
    dispose() {
      this.disposed = true;
    }
  },
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const settle = () => act(() => new Promise((r) => setTimeout(r, 30)));
let requests: { method: string; url: string; body: unknown }[];
let el: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = '<div id="modal-root"></div><div id="toasts"></div><section id="view"></section>';
  el = document.getElementById('view')!;
  location.hash = '#/terminals';
  requests = [];
  state.data = {
    terminals: [],
    agents: [
      { id: 'a1', name: 'Coder', emoji: '🧑‍💻', engine: 'claude-code' },
      { id: 'a2', name: 'Api', engine: 'eve' },
    ],
    engines: { 'claude-code': { installed: true }, hermes: { installed: false } },
  } as unknown as AppState;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method || 'GET';
    requests.push({ method, url, body: init.body ? JSON.parse(String(init.body)) : null });
    if (url === '/api/terminals' && method === 'POST')
      return new Response(JSON.stringify({ id: 't9', title: 'PowerShell' }));
    return new Response(JSON.stringify(url === '/api/terminals' ? [] : { ok: true }));
  });
});
afterEach(() => {
  act(() => terminals.unmount());
  vi.unstubAllGlobals();
});

describe('pickTerminal()', () => {
  it('shows the one asked for, the launcher for "new", else the first', () => {
    const list = [{ id: 't1' }, { id: 't2' }];
    expect(pickTerminal('t2', list)).toBe('t2');
    expect(pickTerminal('new', list)).toBeNull();
    expect(pickTerminal('gone', list)).toBe('t1');
    expect(pickTerminal(undefined, [])).toBeNull();
  });
});

describe('the Terminals page', () => {
  it('with none open shows the launcher: buttons for each program and agents that can run in a terminal', async () => {
    await act(async () => terminals.render(el, []));
    await settle();
    expect([...el.querySelectorAll('button.term-card .card-title')].map((t) => t.textContent)).toEqual([
      'PowerShell',
      'Claude Code',
      'Orca',
    ]);
    await act(async () => el.querySelector<HTMLButtonElement>('button[aria-label="Agent"]')!.click());
    await settle();
    expect([...document.querySelectorAll('[role="option"]')].map((o) => o.textContent)).toEqual(['🧑‍💻 Coder']);
    await act(async () => el.querySelector<HTMLButtonElement>('button[aria-label="Agent"]')!.click());
    expect(el.querySelector('nav[aria-label="Terminals"] a[aria-current="page"]')!.textContent).toBe('+ New');
    await act(async () => el.querySelector<HTMLButtonElement>('button.term-card')!.click());
    await settle();
    expect(requests.find((r) => r.method === 'POST')!.body).toEqual({ kind: 'shell' });
    expect(location.hash).toBe('#/terminals/t9');
  });

  it("says an OpenClaw agent's terminal uses OpenClaw's own instructions (BH-091)", async () => {
    state.data = {
      ...state.data!,
      agents: [{ id: 'o1', name: 'Claw', engine: 'openclaw' }],
    } as unknown as AppState;
    await act(async () => terminals.render(el, []));
    await settle();
    expect(el.querySelector('.openclaw-note')?.textContent).toMatch(
      /OpenClaw agent's own instructions, not the ones set here/,
    );
  });

  it('closing the terminal that shows falls back to the next one (the page stays the same)', async () => {
    class FakeSocket {
      readyState = 0;
      send() {}
      close() {}
    }
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    const open = [
      { id: 't1', title: 'One' },
      { id: 't2', title: 'Two' },
    ];
    state.data = { ...state.data!, terminals: open } as unknown as AppState;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      requests.push({ method: init.method || 'GET', url, body: null });
      return new Response(JSON.stringify(url === '/api/terminals' ? open : { ok: true }));
    });
    await act(async () => terminals.render(el, []));
    await settle();
    const current = () => el.querySelector('nav[aria-label="Terminals"] a[aria-current="page"]')!.textContent;
    expect(current()).toContain('One');
    await act(async () => el.querySelector<HTMLButtonElement>('button[aria-label="Close One"]')!.click());
    await settle();
    // the app state hears it is gone
    await act(async () => {
      state.data = { ...state.data!, terminals: [open[1]] } as unknown as AppState;
      for (const fn of state.listeners) fn(state.data);
    });
    await settle();
    expect(requests.some((r) => r.method === 'DELETE' && r.url === '/api/terminals/t1')).toBe(true);
    expect(current()).toContain('Two');
  });
});

// WCAG contrast of two #rrggbb colours
const lum = (hex: string) => {
  const [r, g, b] = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);

describe('the terminal follows the page: light or dark', () => {
  afterEach(() => {
    delete document.documentElement.dataset.theme;
    made.length = 0;
  });
  const ANSI = [
    'black',
    'red',
    'green',
    'yellow',
    'blue',
    'magenta',
    'cyan',
    'white',
    'brightBlack',
    'brightRed',
    'brightGreen',
    'brightYellow',
    'brightBlue',
    'brightMagenta',
    'brightCyan',
    'brightWhite',
  ] as const;

  it('light: dark ink on white, and all 16 colours can be read on it', () => {
    const t = terminalTheme(false) as Record<string, string>;
    expect(t.background).toBe('#ffffff');
    expect(contrast(t.foreground, t.background)).toBeGreaterThan(10);
    for (const name of ANSI) expect(contrast(t[name], t.background), name).toBeGreaterThanOrEqual(4);
  });

  it('dark: light ink on near-black, and the colours can be read on it (black is the dim one on purpose)', () => {
    const t = terminalTheme(true) as Record<string, string>;
    expect(t.background).toBe('#0e0f11');
    expect(contrast(t.foreground, t.background)).toBeGreaterThan(10);
    for (const name of ANSI.filter((n) => n !== 'black'))
      expect(contrast(t[name], t.background), name).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t.black, t.background)).toBeGreaterThan(3);
  });

  it('a terminal that is open changes with the page, and stops listening once it is closed', async () => {
    class FakeSocket {
      readyState = 0;
      send() {}
      close() {}
    }
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    document.documentElement.dataset.theme = 'light';
    const open = [{ id: 't1', title: 'One' }];
    state.data = { ...state.data!, terminals: open } as unknown as AppState;
    vi.stubGlobal(
      'fetch',
      async (url: string) => new Response(JSON.stringify(url === '/api/terminals' ? open : { ok: true })),
    );
    await act(async () => terminals.render(el, []));
    await settle();
    const term = made.at(-1)!;
    expect(term.options.theme!.background).toBe('#ffffff');
    await act(async () => void (document.documentElement.dataset.theme = 'dark'));
    await settle();
    expect(term.options.theme!.background).toBe('#0e0f11');
    expect(term.options.theme!.foreground).toBe(terminalTheme(true).foreground);
    // closed: the next switch is not for it
    act(() => terminals.unmount());
    await settle();
    expect(term.disposed).toBe(true);
    await act(async () => void (document.documentElement.dataset.theme = 'light'));
    await settle();
    expect(term.options.theme!.background).toBe('#0e0f11');
  });
});

describe('a terminal whose connection drops', () => {
  it('connects again by itself, but not to one that is gone', async () => {
    const all: { url: string; onclose: ((e: { code: number }) => void) | null; closed: boolean }[] = [];
    // (the terminal's own sockets still open: the page's event socket is another, and one let go is closed)
    const mine = () => all.filter((x) => x.url.includes('/ws/term') && !x.closed);
    const sockets = {
      get length() {
        return mine().length;
      },
      at: (i: number) => mine()[i],
    };
    class FakeSocket {
      readyState = 0;
      onclose: ((e: { code: number }) => void) | null = null;
      closed = false;
      url: string;
      constructor(url: string) {
        this.url = url;
        all.push(this);
      }
      send() {}
      close() {
        this.closed = true;
      }
    }
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    const open = [{ id: 't1', title: 'One' }];
    state.data = { ...state.data!, terminals: open } as unknown as AppState;
    vi.stubGlobal(
      'fetch',
      async (url: string) => new Response(JSON.stringify(url === '/api/terminals' ? open : { ok: true })),
    );
    await act(async () => terminals.render(el, []));
    await settle();
    expect(sockets).toHaveLength(1);
    // the connection drops (a restart, a sleep): another one opens after a moment
    const first = sockets.at(0)!;
    first.closed = true;
    await act(async () => first.onclose?.({ code: 1006 }));
    await act(() => new Promise((r) => setTimeout(r, 700)));
    expect(sockets).toHaveLength(1);
    expect(sockets.at(0)).not.toBe(first);
    // the terminal itself is gone: no more tries
    const second = sockets.at(0)!;
    second.closed = true;
    await act(async () => second.onclose?.({ code: 4004 }));
    await act(() => new Promise((r) => setTimeout(r, 1200)));
    expect(sockets).toHaveLength(0);
  });
});
