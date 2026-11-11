// The floating chat windows (React shell, Base UI tabs): opening chats as tabs, closing, minimizing,
// remembering, and dragging tabs between windows, out into new ones, and windows into each other.
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { state } from '../../web/core.ts';
import {
  chatWindows,
  closeChatsForProject,
  minimizeMaximizedChats,
  moveChatTab,
  openChat,
  restoreChats,
} from '../../web/chatwin.tsx';
import { isMac } from '../../web/shortcuts.ts';
import type { AppState } from '../../shared/types.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const settle = () => act(() => new Promise((r) => setTimeout(r, 40)));

beforeEach(() => {
  document.body.innerHTML = '<div id="modal-root"></div><div id="toasts"></div><div class="bottom-bar"></div>';
  localStorage.clear();
  state.data = {
    runs: [],
    approvals: [],
    settings: {},
    agents: [
      { id: 'a1', name: 'Scout', emoji: '🔭', engine: 'eve', model: 'm', provider: 'custom' },
      { id: 'a2', name: 'Writer', emoji: '✍️', engine: 'eve', model: 'm', provider: 'custom' },
    ],
  } as unknown as AppState;
  window.__teams = [];
  vi.stubGlobal(
    'fetch',
    async (url: string) =>
      new Response(JSON.stringify(url.endsWith('/chats') ? [] : url.endsWith('/commands') ? [] : {}), {
        headers: { 'content-type': 'application/json' },
      }),
  );
  // (no animations in happy-dom)
  Element.prototype.animate ??= () =>
    ({ finished: Promise.resolve(), cancel() {}, onfinish: null }) as unknown as Animation;
  Element.prototype.getAnimations ??= () => [];
});
afterEach(async () => {
  await act(async () => closeChatsForProject());
  vi.unstubAllGlobals();
  // (happy-dom has no hit testing; tests below stand it in)
  delete (document as { elementsFromPoint?: unknown }).elementsFromPoint;
});

const tabs = () => [...document.querySelectorAll<HTMLElement>('.cw [role="tab"]')];
const win = () => document.querySelector<HTMLElement>('.cw')!;

describe('the chat window', () => {
  it('opens a chat as a labelled tab, and a second one as a second tab', async () => {
    await act(async () => void openChat('agent', 'a1'));
    await settle();
    expect(win().classList.contains('hidden')).toBe(false);
    expect(document.querySelector('.cw [role="tablist"]')!.getAttribute('aria-label')).toBe('Open chats');
    expect(tabs().map((t) => t.textContent)).toEqual(['🔭Scout']);
    await act(async () => void openChat('agent', 'a2'));
    await settle();
    expect(tabs().map((t) => `${t.textContent}${t.getAttribute('aria-selected') === 'true' ? '*' : ''}`)).toEqual([
      '🔭Scout',
      '✍️Writer*',
    ]);
    // the tab you are on shows its pane
    const panes = [...document.querySelectorAll<HTMLElement>('.cw-pane')];
    expect(panes.map((p) => p.classList.contains('hidden'))).toEqual([true, false]);
  });

  it('closes a tab with its own close button (beside the tab, not inside it)', async () => {
    await act(async () => void openChat('agent', 'a1'));
    await act(async () => void openChat('agent', 'a2'));
    await settle();
    const close = document.querySelector<HTMLButtonElement>('button[aria-label="Close Writer"]')!;
    expect(close.closest('[role="tab"]')).toBeNull();
    await act(async () => close.click());
    expect(tabs().map((t) => t.textContent)).toEqual(['🔭Scout']);
    expect(JSON.parse(localStorage.getItem('dash-chatwin')!).wins.map((w: { tabs: string[] }) => w.tabs)).toEqual([
      ['agent:a1'],
    ]);
  });

  it('maximized, stops above the bottom bar instead of under Ask the Brain', async () => {
    await act(async () => void openChat('agent', 'a1'));
    await settle();
    await act(async () =>
      document.querySelector<HTMLButtonElement>('button[aria-label="Maximize the chats"]')!.click(),
    );
    await settle();
    const bottom = parseFloat(win().style.top) + parseFloat(win().style.height);
    // the bar sits 18px up and is about 44px tall
    expect(window.innerHeight - bottom).toBeGreaterThanOrEqual(18 + 44);
  });

  it('minimizes when maximized and the Station under it is used, and comes back maximized', async () => {
    await act(async () => void openChat('agent', 'a1'));
    await settle();
    // a window that is not maximized stays open
    await act(async () => minimizeMaximizedChats());
    await settle();
    expect(win().classList.contains('hidden')).toBe(false);
    await act(async () =>
      document.querySelector<HTMLButtonElement>('button[aria-label="Maximize the chats"]')!.click(),
    );
    await act(async () => minimizeMaximizedChats());
    await settle();
    expect(win().classList.contains('hidden')).toBe(true);
    await act(async () => document.querySelector<HTMLButtonElement>('.bottom-bar .cw-pill')!.click());
    await settle();
    expect(win().classList.contains('hidden')).toBe(false);
    expect(document.querySelector('button[aria-label="Restore the chats"]')).not.toBeNull();
  });

  it('minimizes to a pill in the bottom bar, and opens again from it', async () => {
    await act(async () => void openChat('agent', 'a1'));
    await settle();
    await act(async () =>
      document.querySelector<HTMLButtonElement>('button[aria-label="Minimize the chats"]')!.click(),
    );
    await settle();
    const pill = document.querySelector<HTMLButtonElement>('.bottom-bar .cw-pill')!;
    expect(pill.classList.contains('hidden')).toBe(false);
    expect(pill.textContent).toBe('1 chat');
    expect(win().classList.contains('hidden')).toBe(true);
    await act(async () => pill.click());
    await settle();
    expect(win().classList.contains('hidden')).toBe(false);
    expect(pill.classList.contains('hidden')).toBe(true);
  });

  it('⌘↓ / Ctrl+↓ minimizes the window on top, ⌘↑ / Ctrl+↑ brings back the one minimized last', async () => {
    const press = (key: string) => {
      const e = new KeyboardEvent('keydown', {
        key,
        bubbles: true,
        cancelable: true,
        ...(isMac() ? { metaKey: true } : { ctrlKey: true }),
      });
      act(() => void window.dispatchEvent(e));
      return e.defaultPrevented;
    };
    const shown = () =>
      [...document.querySelectorAll<HTMLElement>('.cw')].filter((el) => !el.classList.contains('hidden')).length;
    await act(async () => void openChat('agent', 'a1'));
    await settle();
    await act(async () => void openChat('agent', 'a2'));
    await act(async () => moveChatTab('agent:a2', null));
    await settle();
    expect(shown()).toBe(2);
    // the window on top (Writer's) goes first, then the other
    expect(press('ArrowDown')).toBe(true);
    await settle();
    expect(shown()).toBe(1);
    expect(document.querySelector('.cw:not(.hidden) [role="tab"]')!.textContent).toBe('🔭Scout');
    expect(press('ArrowDown')).toBe(true);
    await settle();
    expect(shown()).toBe(0);
    // nothing left to minimize: the key keeps its usual job
    expect(press('ArrowDown')).toBe(false);
    // back in reverse: Scout's window was minimized last
    expect(press('ArrowUp')).toBe(true);
    await settle();
    expect(document.querySelector('.cw:not(.hidden) [role="tab"]')!.textContent).toBe('🔭Scout');
    expect(press('ArrowUp')).toBe(true);
    await settle();
    expect(shown()).toBe(2);
    expect(press('ArrowUp')).toBe(false);
  });

  it("a lone team chat's pill says the team's name", async () => {
    window.__teams = [{ id: 't1', name: 'Research', color: '#7350c8' }] as unknown as typeof window.__teams;
    await act(async () => void openChat('team', 't1'));
    await settle();
    await act(async () =>
      document.querySelector<HTMLButtonElement>('button[aria-label="Minimize the chats"]')!.click(),
    );
    await settle();
    expect(document.querySelector('.bottom-bar .cw-pill')!.textContent).toBe('Research');
  });

  it("lets the tabs shrink and scroll when they don't fit, also with a mouse wheel", async () => {
    await act(async () => void openChat('agent', 'a1'));
    await act(async () => void openChat('agent', 'a2'));
    await settle();
    const list = document.querySelector<HTMLElement>('.cw [role="tablist"]')!;
    // the tabs' wrapper must be able to shrink, or the list never gets narrow enough to scroll
    expect(list.parentElement!.classList.contains('min-w-0')).toBe(true);
    const wheel = () => {
      const e = new WheelEvent('wheel', { deltaY: 40, cancelable: true });
      list.dispatchEvent(e);
      return e.defaultPrevented;
    };
    // everything fits: the wheel is left alone
    expect(wheel()).toBe(false);
    Object.defineProperty(list, 'scrollWidth', { configurable: true, value: 600 });
    Object.defineProperty(list, 'clientWidth', { configurable: true, value: 200 });
    expect(wheel()).toBe(true);
    expect(list.scrollLeft).toBe(40);
  });
});

describe('arranging the windows', () => {
  /** Presses Ctrl+Alt (Ctrl+⌥) + an arrow; true if it did something. */
  const arrange = (key: string) => {
    const e = new KeyboardEvent('keydown', { key, ctrlKey: true, altKey: true, bubbles: true, cancelable: true });
    act(() => void window.dispatchEvent(e));
    return e.defaultPrevented;
  };
  const shown = () =>
    [...document.querySelectorAll<HTMLElement>('.cw')].filter((el) => !el.classList.contains('hidden'));
  /** Each shown window's tabs and where it is, left to right. */
  const layout = () =>
    shown()
      .map((el) => ({
        tabs: [...el.querySelectorAll('[role="tab"]')].map((t) => t.textContent).join(','),
        x: parseFloat(el.style.left),
        y: parseFloat(el.style.top),
        w: parseFloat(el.style.width),
      }))
      .sort((a, b) => a.x - b.x);
  // the room arranged windows share (happy-dom's screen is 1024 × 768): right of the rail, above the bottom bar
  const area = { x: 72, y: 64, w: 1024 - 86, h: 768 - 64 - 74 };

  it('snaps the window on top to the left or right half; the same side again makes it ⅔ wide', async () => {
    await act(async () => void openChat('agent', 'a1'));
    await settle();
    expect(arrange('ArrowLeft')).toBe(true);
    await settle();
    const half = (area.w - 10) / 2;
    expect(layout()).toEqual([{ tabs: '🔭Scout', x: area.x, y: area.y, w: half }]);
    expect(parseFloat(win().style.height)).toBe(area.h);
    arrange('ArrowLeft');
    await settle();
    expect(layout()[0].w).toBeCloseTo(((area.w - 10) * 2) / 3);
    arrange('ArrowRight');
    await settle();
    expect(layout()).toEqual([{ tabs: '🔭Scout', x: area.x + area.w - half, y: area.y, w: half }]);
    // it is remembered
    expect(JSON.parse(localStorage.getItem('dash-chatwin')!).wins[0].rect.x).toBe(area.x + area.w - half);
  });

  it('separates every tab into a window of its own side by side, and combines them back', async () => {
    await act(async () => void openChat('agent', 'a1'));
    await act(async () => void openChat('agent', 'a2'));
    await settle();
    expect(arrange('ArrowUp')).toBe(true);
    await settle();
    const half = (area.w - 10) / 2;
    // in the tabs' order, left to right
    expect(layout()).toEqual([
      { tabs: '🔭Scout', x: area.x, y: area.y, w: half },
      { tabs: '✍️Writer', x: area.x + half + 10, y: area.y, w: half },
    ]);
    // the chat you were on stays on top
    expect(chatWindows().at(-1)!.tabs).toEqual(['agent:a2']);
    expect(arrange('ArrowDown')).toBe(true);
    await settle();
    expect(chatWindows()).toEqual([{ id: expect.any(Number), tabs: ['agent:a2', 'agent:a1'], active: 'agent:a2' }]);
  });

  it('a minimized window comes back to take part', async () => {
    await act(async () => void openChat('agent', 'a1'));
    await act(async () => void openChat('agent', 'a2'));
    await act(async () => moveChatTab('agent:a2', null));
    await settle();
    await act(async () =>
      document.querySelector<HTMLButtonElement>('button[aria-label="Minimize the chats"]')!.click(),
    );
    await settle();
    expect(shown()).toHaveLength(1);
    arrange('ArrowUp');
    await settle();
    expect(layout().map((l) => l.tabs)).toEqual(['🔭Scout', '✍️Writer']);
  });

  it('keys with nothing to do keep their usual job', async () => {
    await act(async () => void openChat('agent', 'a1'));
    await settle();
    // one chat: nothing to separate or combine
    expect(arrange('ArrowUp')).toBe(false);
    expect(arrange('ArrowDown')).toBe(false);
  });

  it('the Layout menu arranges too, and shows the keys', async () => {
    await act(async () => void openChat('agent', 'a1'));
    await act(async () => void openChat('agent', 'a2'));
    await act(async () => moveChatTab('agent:a2', null));
    await settle();
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[data-win] button[aria-label="Arrange the chat windows"]')!.click(),
    );
    await settle();
    const items = [...document.querySelectorAll<HTMLElement>('.cw-layout [role="menuitem"]')];
    const k = isMac() ? '⌃⌥' : 'Ctrl+Alt+';
    expect(items.map((i) => i.textContent!.trim())).toEqual([
      `Left half${k}←`,
      `Right half${k}→`,
      'Side by side',
      `Separate tabs${k}↑`,
      `Combine all${k}↓`,
    ]);
    await act(async () => items.find((i) => i.textContent!.trim() === 'Side by side')!.click());
    await settle();
    const half = (area.w - 10) / 2;
    expect(layout().map((l) => [l.x, l.w])).toEqual([
      [area.x, half],
      [area.x + half + 10, half],
    ]);
  });
});

// Pointer events as React and the window listeners see them.
const pointer = (type: string, target: EventTarget, x: number, y: number) => {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });
  target.dispatchEvent(e);
};
const strip = (winId: number) => document.querySelector<HTMLElement>(`[data-cw-strip="${winId}"]`)!;
const tabEl = (key: string) => document.querySelector<HTMLElement>(`.cw-tab[data-key="${key}"]`)!;
/** What the pointer is over, topmost first (happy-dom can't tell). */
const over = (els: Element[]) => ((document as { elementsFromPoint?: unknown }).elementsFromPoint = () => els);
const shown = () => [...document.querySelectorAll<HTMLElement>('.cw')].filter((w) => !w.classList.contains('hidden'));

describe('dragging tabs and windows', () => {
  const twoTabs = async () => {
    await act(async () => void openChat('agent', 'a1'));
    await act(async () => void openChat('agent', 'a2'));
    await settle();
  };

  it('drags a tab out onto the map into a new window of its own', async () => {
    await twoTabs();
    over([document.body]);
    await act(async () => {
      pointer('pointerdown', tabEl('agent:a2').querySelector('[role="tab"]')!, 10, 10);
      pointer('pointermove', window, 400, 300);
    });
    // while it is dragged: the tab follows the pointer and an outline shows where its window goes
    expect(document.querySelector('.cw-ghost')!.textContent).toBe('✍️Writer');
    expect(document.querySelector('.cw-torn')).not.toBeNull();
    await act(async () => pointer('pointerup', window, 400, 300));
    await settle();
    expect(chatWindows().map((w) => w.tabs)).toEqual([['agent:a1'], ['agent:a2']]);
    expect(shown()).toHaveLength(2);
    expect(document.querySelector('.cw-ghost')).toBeNull();
    // the conversation moved with it, into the new window
    const [, second] = chatWindows();
    expect(document.querySelector(`[data-win="${second.id}"] .cw-pane:not(.hidden)`)).not.toBeNull();
    expect(JSON.parse(localStorage.getItem('dash-chatwin')!).wins.map((w: { tabs: string[] }) => w.tabs)).toEqual([
      ['agent:a1'],
      ['agent:a2'],
    ]);
  });

  it("drags a tab onto another window's tabs, and the window it left goes away", async () => {
    await twoTabs();
    await act(async () => moveChatTab('agent:a2', null));
    const [first, second] = chatWindows();
    over([strip(first.id)]);
    await act(async () => {
      pointer('pointerdown', tabEl('agent:a2'), 10, 10);
      pointer('pointermove', window, 200, 20);
    });
    // the window it would go to is outlined, with a line where the tab lands
    expect(document.querySelector(`[data-win="${first.id}"]`)!.classList.contains('border-accent')).toBe(true);
    await act(async () => pointer('pointerup', window, 200, 20));
    await settle();
    expect(chatWindows()).toEqual([{ id: first.id, tabs: ['agent:a1', 'agent:a2'], active: 'agent:a2' }]);
    expect(document.querySelector(`[data-win="${second.id}"]`)).toBeNull();
    expect(shown()).toHaveLength(1);
  });

  it("merges a window into another by dragging it by its title bar onto the other's tabs", async () => {
    await twoTabs();
    await act(async () => moveChatTab('agent:a2', null));
    const [first, second] = chatWindows();
    // the dragged window is under the pointer itself; the tabs below it count
    over([strip(second.id), strip(first.id)]);
    await act(async () => {
      pointer('pointerdown', strip(second.id), 300, 300);
      pointer('pointermove', window, 100, 80);
    });
    expect(document.querySelector(`[data-win="${second.id}"]`)!.classList.contains('opacity-60')).toBe(true);
    await act(async () => pointer('pointerup', window, 100, 80));
    await settle();
    expect(chatWindows()).toEqual([{ id: first.id, tabs: ['agent:a1', 'agent:a2'], active: 'agent:a2' }]);
  });

  it('reorders tabs, and Escape puts a dragged tab back', async () => {
    await twoTabs();
    await act(async () => moveChatTab('agent:a2', chatWindows()[0].id, 0));
    expect(chatWindows()[0].tabs).toEqual(['agent:a2', 'agent:a1']);
    over([document.body]);
    await act(async () => {
      pointer('pointerdown', tabEl('agent:a1'), 10, 10);
      pointer('pointermove', window, 400, 300);
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      pointer('pointerup', window, 400, 300);
    });
    expect(chatWindows().map((w) => w.tabs)).toEqual([['agent:a2', 'agent:a1']]);
    expect(document.querySelector('.cw-torn')).toBeNull();
  });

  it('a click on a tab is still a click, not a drag', async () => {
    await twoTabs();
    over([document.body]);
    await act(async () => {
      pointer('pointerdown', tabEl('agent:a1'), 10, 10);
      pointer('pointermove', window, 12, 11);
      pointer('pointerup', window, 12, 11);
    });
    expect(chatWindows().map((w) => w.tabs)).toEqual([['agent:a1', 'agent:a2']]);
  });

  it('brings back every window, and a save from before there were several', async () => {
    localStorage.setItem(
      'dash-chatwin',
      JSON.stringify({
        wins: [
          { tabs: ['agent:a1'], active: 'agent:a1' },
          { rect: { x: 300, y: 100, w: 500, h: 400 }, tabs: ['agent:a2'], active: 'agent:a2' },
        ],
      }),
    );
    await act(async () => restoreChats());
    await settle();
    expect(chatWindows().map((w) => w.tabs)).toEqual([['agent:a1'], ['agent:a2']]);
    expect(shown()).toHaveLength(2);
    await act(async () => closeChatsForProject());
    document.body.innerHTML = '<div class="bottom-bar"></div>';
    localStorage.setItem(
      'dash-chatwin',
      JSON.stringify({ rect: { x: 80, y: 60, w: 500, h: 400 }, tabs: ['agent:a1', 'agent:a2'], active: 'agent:a2' }),
    );
    await act(async () => restoreChats());
    await settle();
    expect(chatWindows()).toEqual([expect.objectContaining({ tabs: ['agent:a1', 'agent:a2'], active: 'agent:a2' })]);
  });
});
