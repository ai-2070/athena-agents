// The floating chat windows (React shell, Base UI tabs): opening chats as tabs, closing, minimizing,
// remembering, and dragging tabs between windows, out into new ones, and windows into each other.
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { state } from '../../web/core.ts';
import { chatWindows, closeChatsForProject, moveChatTab, openChat, restoreChats } from '../../web/chatwin.tsx';
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
      { id: 'a1', name: 'Scout', emoji: '🔭', engine: 'openai', model: 'm', provider: 'custom' },
      { id: 'a2', name: 'Writer', emoji: '✍️', engine: 'openai', model: 'm', provider: 'custom' },
    ],
  } as unknown as AppState;
  window.__teams = [];
  vi.stubGlobal('fetch', async (url: string) => new Response(JSON.stringify(url.endsWith('/chats') ? [] : url.endsWith('/commands') ? [] : {}), { headers: { 'content-type': 'application/json' } }));
  // (no animations in happy-dom)
  Element.prototype.animate ??= function () {
    return { finished: Promise.resolve(), cancel() {}, onfinish: null } as unknown as Animation;
  };
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
    expect(tabs().map((t) => `${t.textContent}${t.getAttribute('aria-selected') === 'true' ? '*' : ''}`)).toEqual(['🔭Scout', '✍️Writer*']);
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
    expect(JSON.parse(localStorage.getItem('dash-chatwin')!).wins.map((w: { tabs: string[] }) => w.tabs)).toEqual([['agent:a1']]);
  });

  it('minimizes to a pill in the bottom bar, and opens again from it', async () => {
    await act(async () => void openChat('agent', 'a1'));
    await settle();
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Minimize the chats"]')!.click());
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

  it('a lone team chat\'s pill says the team\'s name', async () => {
    window.__teams = [{ id: 't1', name: 'Research', color: '#7350c8' }] as unknown as typeof window.__teams;
    await act(async () => void openChat('team', 't1'));
    await settle();
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Minimize the chats"]')!.click());
    await settle();
    expect(document.querySelector('.bottom-bar .cw-pill')!.textContent).toBe('Research');
  });

  it('lets the tabs shrink and scroll when they don\'t fit, also with a mouse wheel', async () => {
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
    expect(JSON.parse(localStorage.getItem('dash-chatwin')!).wins.map((w: { tabs: string[] }) => w.tabs)).toEqual([['agent:a1'], ['agent:a2']]);
  });

  it('drags a tab onto another window\'s tabs, and the window it left goes away', async () => {
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

  it('merges a window into another by dragging it by its title bar onto the other\'s tabs', async () => {
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
    localStorage.setItem('dash-chatwin', JSON.stringify({ wins: [{ tabs: ['agent:a1'], active: 'agent:a1' }, { rect: { x: 300, y: 100, w: 500, h: 400 }, tabs: ['agent:a2'], active: 'agent:a2' }] }));
    await act(async () => restoreChats());
    await settle();
    expect(chatWindows().map((w) => w.tabs)).toEqual([['agent:a1'], ['agent:a2']]);
    expect(shown()).toHaveLength(2);
    await act(async () => closeChatsForProject());
    document.body.innerHTML = '<div class="bottom-bar"></div>';
    localStorage.setItem('dash-chatwin', JSON.stringify({ rect: { x: 80, y: 60, w: 500, h: 400 }, tabs: ['agent:a1', 'agent:a2'], active: 'agent:a2' }));
    await act(async () => restoreChats());
    await settle();
    expect(chatWindows()).toEqual([expect.objectContaining({ tabs: ['agent:a1', 'agent:a2'], active: 'agent:a2' })]);
  });
});
