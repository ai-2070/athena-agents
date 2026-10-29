// The chat windows: floating windows over the map with a tab for every conversation you open
// (team group chats and agents). Drag a window by its title bar, resize it from any edge or corner,
// minimize it to a pill or maximize it. Drag a tab along the tabs to reorder it, onto another
// window's tabs to move it there, or out onto the map to open it in a window of its own. Drag a
// window by its title bar onto another's tabs to merge the two. The window clicked last is on top.
// The Layout menu (and Ctrl+Alt + arrows) snaps a window to half the screen, puts the windows side by
// side, gives every tab a window of its own, or puts them all back into one.
// Sizes, places and open tabs are remembered in this browser.
// The windows are React (Base UI tabs); each tab's conversation is made directly (renderTeamChat,
// renderAgentChat) so openChat() can hand its api back at once, and its window puts it in place.
// Moving a tab to another window moves that element; the chat inside keeps running.
import { StrictMode, useEffect, useRef, useSyncExternalStore } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { Menu } from '@base-ui/react/menu';
import { Tabs } from '@base-ui/react/tabs';
import { state, onState, GET } from './core.ts';
import { renderTeamChat } from './teamchat.tsx';
import { renderAgentChat } from './agentchat.tsx';
import { uiZoom } from './look.ts';
import { flipFrom, flipTo, slideIn, reducedMotion } from './motion.ts';
import { chatWindowKeys, chatWindowShortcut } from './shortcuts.ts';
import type { ChatWindowAction } from './shortcuts.ts';
import { Avatar, Icon, IconWeightProvider, useAppState } from './ui/react.tsx';
import type { TeamListing } from '../shared/types.ts';

declare global {
  interface Window {
    /** The Station's teams (it sets this on every load); the chat window reads names and colors from it. */
    __teams?: TeamListing[];
    /** Team id → ids of the members working right now (set by the Station). */
    __teamWorking?: Record<string, string[]>;
  }
}

export type ChatKind = 'team' | 'agent';
/** A tab's chat: focus it, @mention someone (team chats only), and tear it down. */
export interface ChatTabApi {
  focus: () => void;
  mention?: (name: string) => void;
  destroy: () => void;
}
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface ChatTab {
  key: string;
  kind: ChatKind;
  id: string;
  /** the conversation's own element, made outside React and put in its window's body */
  body: HTMLDivElement;
  api: ChatTabApi;
}
interface Win {
  id: number;
  tabs: ChatTab[];
  active: string | null;
  min: boolean;
  max: boolean;
  rect: Rect;
  /** stacking order: the highest is on top */
  z: number;
  el: HTMLDivElement | null;
  body: HTMLDivElement | null;
  pill: HTMLButtonElement | null;
  /** while the window shrinks into its pill, both are drawn (the pill unseen, to know where to go) */
  shrinking: boolean;
  minimizing: Promise<void> | null;
  /** when it was last minimized (higher is later), so ⌘↑ brings back the last one first */
  minAt: number;
}
/** One window, as remembered in localStorage. */
interface SavedWindow {
  rect?: Rect | null;
  tabs?: string[];
  active?: string | null;
  min?: boolean;
  max?: boolean;
}

const KEY = 'dash-chatwin';
const wins: Win[] = [];
let nextId = 1;
let zTop = 0;
let minSeq = 0;

/** The remembered windows (an older save held one window at the top level). */
const load = (): SavedWindow[] => {
  try {
    const s: unknown = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (!s || typeof s !== 'object') return [];
    const list = (s as { wins?: unknown }).wins;
    return Array.isArray(list) ? (list as SavedWindow[]) : [s as SavedWindow];
  } catch {
    return [];
  }
};
const save = () => {
  try {
    // windows with chats, bottom first (so they come back in the same order); a lone empty one keeps its place
    const open = wins.filter((w) => w.tabs.length);
    const list = (open.length ? open : wins.slice(0, 1)).sort((a, b) => a.z - b.z);
    localStorage.setItem(KEY, JSON.stringify({ wins: list.map((w) => ({ rect: w.rect, tabs: w.tabs.map((t) => t.key), active: w.active, min: w.min, max: w.max })) }));
  } catch {
    /* private window */
  }
};

const agentOf = (id: string) => state.data?.agents.find((a) => a.id === id);
const winOf = (key: string) => wins.find((w) => w.tabs.some((t) => t.key === key));
const topmost = (list: Win[]) => list.reduce<Win | null>((a, w) => (!a || w.z > a.z ? w : a), null);

// ---------- the windows' state, outside React ----------
let version = 0;
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => (listeners.add(fn), () => void listeners.delete(fn));
const snapshot = () => version;
/** Draws the windows again, at once (callers then animate or focus what was drawn). */
function changed(): void {
  version++;
  if (host) flushSync(() => listeners.forEach((fn) => fn()));
}

let host: { root: Root; el: HTMLElement } | null = null;

function defaultRect(): Rect {
  const z = uiZoom();
  const vw = window.innerWidth / z;
  const vh = window.innerHeight / z;
  // on the left, so the middle of the map stays free (the info panel is on the right)
  return { x: 74, y: 64, w: Math.min(600, vw * 0.4), h: Math.max(360, vh - 150) };
}

/** A new, empty window on top. It is drawn at once, so its body is there to put tabs in. */
function newWin(rect: Rect, min = false, max = false): Win {
  const w: Win = { id: nextId++, tabs: [], active: null, min, max, rect: { ...rect }, z: ++zTop, el: null, body: null, pill: null, shrinking: false, minimizing: null, minAt: 0 };
  wins.push(w);
  changed();
  return w;
}

/** Drops a window whose last tab went elsewhere. The last window stays (hidden), keeping its place. */
function dropWin(w: Win): void {
  if (w.tabs.length || wins.length < 2) return;
  wins.splice(wins.indexOf(w), 1);
  changed();
}

function raise(w: Win): void {
  if (w.z === zTop) return;
  w.z = ++zTop;
  changed();
}

function ensure(): void {
  if (host?.el.isConnected) return;
  const saved = load()[0] || {};
  wins.length = 0;
  zTop = 0;
  host = null;
  newWin(saved.rect || defaultRect(), !!saved.min, !!saved.max);
  const el = document.createElement('div');
  el.style.display = 'contents';
  document.body.append(el);
  const h = (host = { root: createRoot(el), el });
  flushSync(() => h.root.render(<StrictMode><IconWeightProvider value="regular"><ChatWindows /></IconWeightProvider></StrictMode>));
  // also drops the tab of an agent that was deleted
  onState(() => wins.some((w) => w.tabs.length) && refreshChatTabs());
  if (!window.__teams) GET<TeamListing[]>('/workflows').then((w) => ((window.__teams ||= w), changed())).catch(() => {});
  if (!keysOn) {
    keysOn = true;
    window.addEventListener('keydown', onWindowKey);
  }
}

// The keys (chatWindowShortcut): ⌘↓ / ⌘↑ minimize the window on top and bring back the one
// minimized last; Ctrl+Alt + arrows arrange the windows. A key only counts when there is something
// to do, so in a text box with nothing to do it keeps its usual job.
let keysOn = false;
function onWindowKey(e: KeyboardEvent): void {
  const act = e.defaultPrevented ? null : chatWindowShortcut(e);
  if (act && runAction(act)) e.preventDefault();
}

/** Does what a window key or Layout menu item says; false if there was nothing to do. */
function runAction(act: ChatWindowAction, w?: Win): boolean {
  const open = wins.filter((x) => x.tabs.length);
  const top = w || topmost(open.filter((x) => !x.min));
  switch (act) {
    case 'minimize': {
      if (!top?.el || !top.pill) return false;
      // don't leave the cursor in a chat box that is going away
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && top.el.contains(focused)) focused.blur();
      setMin(top, true);
      return true;
    }
    case 'restore': {
      const last = open.filter((x) => x.min).reduce<Win | null>((a, x) => (!a || x.minAt > a.minAt || (x.minAt === a.minAt && x.z > a.z) ? x : a), null);
      if (!last?.el) return false;
      setMin(last, false);
      if (last.active) activate(last, last.active);
      return true;
    }
    case 'left':
    case 'right':
      if (!top?.el) return false;
      snap(top, act);
      return true;
    case 'separate':
      if (open.flatMap((x) => x.tabs).length < 2) return false;
      separate();
      return true;
    case 'combine':
      if (open.length < 2) return false;
      combine();
      return true;
  }
}

// The smallest a window gets: 380 × 300, or less on a screen too small for that.
function minSize() {
  const z = uiZoom();
  return { w: Math.min(380, window.innerWidth / z - 20), h: Math.min(300, window.innerHeight / z - 20) };
}

// Room a maximized window leaves at the bottom: the bottom bar ("Ask the Brain", minimized chats)
// stays visible below it, like the Dock on a Mac (the bar sits 18px up and is about 44px tall).
const BAR_ROOM = 74;

/**
 * The room a maximized window fills, and arranged windows share: it lines up with the Station's
 * side panel, 14px in from the rail (58px) and the right edge, and stops above the bottom bar.
 */
function area(): Rect {
  const z = uiZoom();
  const vw = window.innerWidth / z;
  const vh = window.innerHeight / z;
  return { x: 72, y: 64, w: vw - 86, h: vh - 64 - BAR_ROOM };
}

/** Where a window goes: its rect kept inside the screen, or the screen less a margin when maximized. */
function placement(w: Win): CSSProperties {
  const z = uiZoom();
  const vw = window.innerWidth / z;
  const vh = window.innerHeight / z;
  const r = w.rect;
  const min = minSize();
  r.w = Math.max(min.w, Math.min(r.w, vw - 20));
  r.h = Math.max(min.h, Math.min(r.h, vh - 20));
  r.x = Math.max(4, Math.min(r.x, vw - 120));
  r.y = Math.max(4, Math.min(r.y, vh - 48));
  const zIndex = w.z;
  const a = w.max ? area() : r;
  return { zIndex, left: `${a.x}px`, top: `${a.y}px`, width: `${a.w}px`, height: `${a.h}px` };
}

/** The window whose tabs are at this point on screen (not counting `skip`), if they're not covered. */
function tabsAt(cx: number, cy: number, skip?: Win): Win | null {
  const els = typeof document.elementsFromPoint === 'function' ? document.elementsFromPoint(cx, cy) : [];
  for (const el of els) {
    if (skip?.el?.contains(el)) continue;
    // the first thing under the pointer decides: another window's body covering the tabs counts
    if (!el.closest('.cw')) return null;
    const strip = el.closest<HTMLElement>('[data-cw-strip]');
    return strip ? wins.find((w) => String(w.id) === strip.dataset.cwStrip && w.tabs.length) || null : null;
  }
  return null;
}

/** Where a dragged tab would go among a window's other tabs, from the pointer's x. */
function indexAt(w: Win, cx: number, key: string): number {
  const tabs = [...(w.el?.querySelectorAll<HTMLElement>('.cw-tab') || [])].filter((el) => el.dataset.key !== key);
  return tabs.filter((el) => {
    const r = el.getBoundingClientRect();
    return r.left + r.width / 2 < cx;
  }).length;
}

// ---------- dragging tabs ----------
interface TabDrag {
  key: string;
  from: Win;
  /** the pointer and where it grabbed the tab, in CSS pixels */
  x: number;
  y: number;
  offX: number;
  offY: number;
  /** the window whose tabs it is over (null: out on the map, it gets a window of its own) */
  target: Win | null;
  index: number;
}
let drag: TabDrag | null = null;
/** While a window is dragged by its title bar: the window whose tabs it would merge into. */
let merging: { from: Win; into: Win | null } | null = null;

/** Where a tab dropped out on the map opens: its tab about under the pointer, the size of its old window. */
function tornRect(d: TabDrag): Rect {
  return { x: d.x - d.offX - 36, y: d.y - d.offY - 6, w: d.from.rect.w, h: d.from.rect.h };
}

function startTabDrag(e: ReactPointerEvent<HTMLElement>, w: Win, t: ChatTab) {
  if (e.button !== 0 || (e.target as Element).closest('.cw-x')) return;
  const z = uiZoom();
  const sx = e.clientX;
  const sy = e.clientY;
  const r = e.currentTarget.getBoundingClientRect();
  const d: TabDrag = { key: t.key, from: w, x: sx / z, y: sy / z, offX: (sx - r.left) / z, offY: (sy - r.top) / z, target: w, index: 0 };
  let moved = false;
  const move = (ev: PointerEvent) => {
    if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
    moved = true;
    drag = d;
    d.x = ev.clientX / z;
    d.y = ev.clientY / z;
    d.target = tabsAt(ev.clientX, ev.clientY);
    d.index = d.target ? indexAt(d.target, ev.clientX, d.key) : 0;
    changed();
  };
  const end = (drop: boolean) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', cancel);
    window.removeEventListener('keydown', onKey, true);
    if (!moved) return;
    drag = null;
    if (!drop || !winOf(d.key)) return changed();
    if (d.target) moveTab(d.key, d.target, d.index);
    else moveTab(d.key, null, 0, tornRect(d));
  };
  const up = () => end(true);
  const cancel = () => end(false);
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key !== 'Escape' || !moved) return;
    ev.stopPropagation();
    end(false);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', cancel);
  window.addEventListener('keydown', onKey, true);
}

/**
 * Moves a tab to `to` at `index` (among its other tabs), or, with `to` null, into a new window at
 * `rect` (a tab alone in its window just takes the window along).
 */
function moveTab(key: string, to: Win | null, index: number, rect?: Rect): void {
  const from = winOf(key);
  if (!from) return;
  const t = from.tabs.find((x) => x.key === key)!;
  if (!to) {
    const r = rect || { ...from.rect, x: from.rect.x + 30, y: from.rect.y + 30 };
    if (from.tabs.length === 1) {
      from.rect = { ...r };
      from.max = false;
      from.min = false;
      raise(from);
      save();
      changed();
      return;
    }
    to = newWin(r);
  }
  const i = from.tabs.indexOf(t);
  from.tabs.splice(i, 1);
  to.tabs.splice(Math.max(0, Math.min(index, to.tabs.length)), 0, t);
  if (to !== from) {
    to.body?.append(t.body);
    if (from.active === key) from.active = from.tabs[Math.min(i, from.tabs.length - 1)]?.key || null;
    if (from.active) activate(from, from.active, false);
    dropWin(from);
  }
  to.min = false;
  raise(to);
  activate(to, key);
}

/** Puts all of `from`'s tabs after `into`'s, keeps the tab that was open, and drops `from`. */
function mergeWin(from: Win, into: Win): void {
  const open = from.active;
  for (const t of from.tabs) {
    into.tabs.push(t);
    into.body?.append(t.body);
  }
  from.tabs = [];
  from.active = null;
  dropWin(from);
  into.min = false;
  raise(into);
  if (open) activate(into, open);
}

/** Follows the pointer until it is let go, then remembers where the window is. */
function track(w: Win, onMove: (dx: number, dy: number) => void, e: ReactPointerEvent, canMerge = false) {
  const z = uiZoom();
  const sx = e.clientX;
  const sy = e.clientY;
  const win = w.el!;
  win.classList.add('moving');
  const move = (ev: PointerEvent) => {
    onMove((ev.clientX - sx) / z, (ev.clientY - sy) / z);
    if (canMerge) merging = { from: w, into: tabsAt(ev.clientX, ev.clientY, w) };
    changed();
  };
  const up = () => {
    win.classList.remove('moving');
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    const into = merging?.into;
    merging = null;
    if (into && into !== w && wins.includes(into)) mergeWin(w, into);
    else {
      save();
      changed();
    }
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

function startDrag(e: ReactPointerEvent, w: Win) {
  if (e.button !== 0 || (e.target as Element).closest('button, .cw-tab') || w.max) return;
  e.preventDefault();
  const { x, y } = w.rect;
  track(w, (dx, dy) => ((w.rect.x = x + dx), (w.rect.y = y + dy)), e, true);
}

function startResize(e: ReactPointerEvent, w: Win, dir: string) {
  if (w.max) return;
  e.preventDefault();
  e.stopPropagation();
  const r0 = { ...w.rect };
  const min = minSize();
  track(w, (dx, dy) => {
    const r = { ...r0 };
    if (dir.includes('e')) r.w = r0.w + dx;
    if (dir.includes('s')) r.h = r0.h + dy;
    if (dir.includes('w')) {
      r.w = Math.max(min.w, r0.w - dx);
      r.x = r0.x + (r0.w - r.w);
    }
    if (dir.includes('n')) {
      r.h = Math.max(min.h, r0.h - dy);
      r.y = r0.y + (r0.h - r.h);
    }
    w.rect = r;
  }, e);
}

// Minimize: the window shrinks into its pill. Open again: it grows back out of the pill.
function setMin(w: Win, v: boolean) {
  if (v === w.min && !w.minimizing) return;
  w.min = v;
  save();
  const el = w.el!;
  if (v) {
    w.minAt = ++minSeq;
    w.shrinking = true;
    changed();
    const to = w.pill!.getBoundingClientRect();
    const done = (w.minimizing = flipTo(el, to, { duration: 320 }).then(() => {
      if (w.minimizing !== done) return;
      w.minimizing = null;
      w.shrinking = false;
      changed();
      if (w.pill) slideIn(w.pill, { scale: 0.7, duration: 320 });
    }));
    return;
  }
  w.minimizing = null;
  w.shrinking = false;
  el.getAnimations().forEach((a) => a.cancel());
  const from = w.pill?.getBoundingClientRect();
  raise(w);
  changed();
  if (from?.width) {
    flipFrom(el, from, { duration: 460, fade: true });
    animateChatParts(el);
  }
}
// Maximize / restore: the window glides from its old size to the new one.
function setMax(w: Win, v: boolean) {
  const el = w.el!;
  const from = el.getBoundingClientRect();
  w.max = v;
  w.min = false;
  save();
  changed();
  if (from.width && !reducedMotion()) flipFrom(el, from, { duration: 380 });
}

// ---------- arranging the windows ----------
/** Space between arranged windows. */
const GAP = 10;
/** Pressing the same snap again steps through these widths, as Rectangle does. */
const SNAP_WIDTHS = [1 / 2, 2 / 3, 1 / 3];

const byPlace = (a: Win, b: Win) => a.rect.x - b.rect.x || a.rect.y - b.rect.y || a.z - b.z;

/**
 * Puts windows at new places, shown and not maximized. Each glides there from where it was, out of
 * its pill if it was minimized, or out of `from` (a window that just got made).
 */
function arrange(list: { w: Win; rect: Rect; from?: DOMRect }[]): void {
  const starts = list.map(({ w, from }) => {
    const shown = w.el && !w.el.classList.contains('hidden') && !w.shrinking;
    const box = from || (shown ? w.el!.getBoundingClientRect() : w.min ? w.pill?.getBoundingClientRect() : undefined);
    w.el?.getAnimations().forEach((x) => x.cancel());
    return { box, fade: !shown };
  });
  for (const { w, rect } of list) {
    w.rect = { ...rect };
    w.max = false;
    w.min = false;
    w.minimizing = null;
    w.shrinking = false;
  }
  save();
  changed();
  list.forEach(({ w }, i) => {
    const { box, fade } = starts[i];
    if (w.el && box?.width) flipFrom(w.el, box, { duration: 380, fade });
    else pop(w);
  });
}

/** A window's place on the left or right side of the screen, this share of it wide. */
function snapRect(side: 'left' | 'right', share: number): Rect {
  const a = area();
  const w = (a.w - GAP) * share;
  return { x: side === 'left' ? a.x : a.x + a.w - w, y: a.y, w, h: a.h };
}

/** Snaps a window to half the screen; snapping it to the same side again makes it ⅔, then ⅓ wide. */
function snap(w: Win, side: 'left' | 'right'): void {
  const near = (r: Rect) => Math.abs(r.x - w.rect.x) < 1 && Math.abs(r.y - w.rect.y) < 1 && Math.abs(r.w - w.rect.w) < 1 && Math.abs(r.h - w.rect.h) < 1;
  const i = w.max || w.min ? -1 : SNAP_WIDTHS.findIndex((share) => near(snapRect(side, share)));
  arrange([{ w, rect: snapRect(side, SNAP_WIDTHS[(i + 1) % SNAP_WIDTHS.length]) }]);
  raise(w);
}

/** n places side by side in the work area, in even rows when they don't all fit across. */
function grid(n: number): Rect[] {
  const a = area();
  const fit = Math.max(1, Math.floor((a.w + GAP) / (minSize().w + GAP)));
  const rows = Math.ceil(n / fit);
  const h = (a.h - GAP * (rows - 1)) / rows;
  const out: Rect[] = [];
  for (let row = 0, left = n; row < rows; row++) {
    const cols = Math.ceil(left / (rows - row));
    const w = (a.w - GAP * (cols - 1)) / cols;
    for (let c = 0; c < cols; c++) out.push({ x: a.x + c * (w + GAP), y: a.y + row * (h + GAP), w, h });
    left -= cols;
  }
  return out;
}

/** Back to typing in the chat you were on, in its window on top. */
function focusChat(key: string | null | undefined): void {
  const w = key ? winOf(key) : null;
  if (!w || !key) return;
  raise(w);
  activate(w, key);
}

/** Puts every window (minimized ones too) side by side, keeping their left-to-right order. */
function sideBySide(): void {
  const list = wins.filter((w) => w.tabs.length).sort(byPlace);
  const at = grid(list.length);
  const top = topmost(list.filter((w) => !w.min));
  arrange(list.map((w, i) => ({ w, rect: at[i] })));
  focusChat(top?.active);
}

/** Gives every tab a window of its own, side by side in the order the tabs were in. */
function separate(): void {
  const before = wins.filter((w) => w.tabs.length).sort(byPlace);
  const current = (topmost(before.filter((w) => !w.min)) || topmost(before))?.active;
  const list: { w: Win; from?: DOMRect }[] = [];
  for (const w of before) {
    // the tab that was open stays in its window; the others come out of it
    const keep = w.tabs.find((t) => t.key === w.active) || w.tabs[0];
    const from = w.el && !w.el.classList.contains('hidden') && !w.min ? w.el.getBoundingClientRect() : undefined;
    for (const t of [...w.tabs]) {
      if (t === keep) {
        list.push({ w });
        continue;
      }
      w.tabs.splice(w.tabs.indexOf(t), 1);
      const n = newWin(w.rect);
      n.tabs.push(t);
      n.body!.append(t.body);
      n.active = t.key;
      t.body.classList.remove('hidden');
      list.push({ w: n, from });
    }
    w.active = keep.key;
  }
  const at = grid(list.length);
  arrange(list.map((x, i) => ({ ...x, rect: at[i] })));
  focusChat(current);
}

/** Puts all the windows' tabs into the window on top, keeping the chat you were on. */
function combine(): void {
  const list = wins.filter((w) => w.tabs.length);
  const into = topmost(list.filter((w) => !w.min)) || topmost(list)!;
  const current = into.active;
  for (const w of list.sort(byPlace)) {
    if (w === into) continue;
    for (const t of w.tabs) {
      into.tabs.push(t);
      into.body?.append(t.body);
    }
    w.tabs = [];
    w.active = null;
    dropWin(w);
  }
  if (into.min) setMin(into, false);
  else pop(into);
  focusChat(current);
}

/** Let the window shape lead, then bring in its contents like the Brain chat. */
function animateChatParts(el: HTMLElement): void {
  if (reducedMotion()) return;
  const parts = [el.querySelector('[data-cw-strip]'), el.querySelector('.cw-pane:not(.hidden) .tc-list'), el.querySelector('.cw-pane:not(.hidden) .dock-composer')];
  parts.forEach((part, i) => {
    if (part?.getAnimations().length) return;
    const animation = part && slideIn(part, { y: 10, duration: 360 + i * 60 });
    void animation?.finished.catch(() => {});
    animation?.effect?.updateTiming({ delay: 120 + i * 40, fill: 'backwards' });
  });
}

function pop(w: Win) {
  const el = w.el;
  if (!el || el.classList.contains('hidden')) return;
  const animation = slideIn(el, { scale: 0.96, duration: 460 });
  void animation?.finished.catch(() => {});
  animateChatParts(el);
}

function activate(w: Win, key: string, focus = true) {
  const t = w.tabs.find((x) => x.key === key);
  if (!t) return;
  w.active = key;
  for (const x of w.tabs) x.body.classList.toggle('hidden', x.key !== key);
  save();
  changed();
  if (focus) setTimeout(() => t.api?.focus?.(), 30);
}

function makeTab(w: Win, kind: ChatKind, id: string): ChatTab {
  const key = `${kind}:${id}`;
  const body = document.createElement('div');
  body.className = 'cw-pane absolute inset-0 flex flex-col pt-1 px-5 pb-4 max-sm:px-4 *:flex-1 *:min-h-0 hidden';
  w.body!.append(body);
  const api: ChatTabApi = kind === 'team' ? renderTeamChat(body, id, { fill: true }) : renderAgentChat(body, id);
  const t: ChatTab = { key, kind, id, body, api };
  w.tabs.push(t);
  return t;
}

function closeTab(key: string) {
  const w = winOf(key);
  if (!w) return;
  const i = w.tabs.findIndex((x) => x.key === key);
  const [t] = w.tabs.splice(i, 1);
  t.api?.destroy?.();
  t.body.remove();
  if (w.active === key) w.active = w.tabs[Math.min(i, w.tabs.length - 1)]?.key || null;
  if (w.active) activate(w, w.active);
  dropWin(w);
  save();
  changed();
}

function closeWin(w: Win) {
  for (const t of [...w.tabs]) closeTab(t.key);
}

// ---------- the windows ----------
// The resize grips sit just outside the rounded edge, so they can be grabbed.
const GRIPS: Record<string, string> = {
  n: 'absolute z-2 left-2.5 right-2.5 h-1.5 cursor-ns-resize -top-0.75',
  s: 'absolute z-2 left-2.5 right-2.5 h-1.5 cursor-ns-resize -bottom-0.75',
  e: 'absolute z-2 top-2.5 bottom-2.5 w-1.5 cursor-ew-resize -right-0.75',
  w: 'absolute z-2 top-2.5 bottom-2.5 w-1.5 cursor-ew-resize -left-0.75',
  ne: 'absolute z-2 size-3.5 -top-1 -right-1 cursor-nesw-resize',
  nw: 'absolute z-2 size-3.5 -top-1 -left-1 cursor-nwse-resize',
  // (with the corner lines)
  se: "absolute z-2 size-4.5 -bottom-1.5 -right-1.5 cursor-nwse-resize after:content-[''] after:absolute after:right-2.25 after:bottom-2.25 after:size-2.5 after:bg-[linear-gradient(135deg,transparent_0_48%,var(--color-line-2)_48%_58%,transparent_58%_70%,var(--color-line-2)_70%_80%,transparent_80%)]",
  sw: 'absolute z-2 size-3.5 -bottom-1 -left-1 cursor-nesw-resize',
};
const TAB = 'group/tab relative flex items-center gap-2 px-2.5 py-1.5 max-w-[200px] cursor-pointer flex-none rounded-ctl text-[13px] font-medium select-none [transition:background_.15s,color_.15s,opacity_.15s]';
const BTN = 'icon-btn plain flex-none';
/** Where a dragged tab would land: a line in the gap before (or after) a tab. */
const MARK = 'absolute top-1.5 bottom-1.5 w-0.5 rounded-full bg-accent pointer-events-none';

/** A tab's name, its picture and whether it is working. */
function tabInfo(t: ChatTab, busyAgents: Set<string>): { label: string; lead: ReactNode; busy: boolean } {
  if (t.kind === 'team') {
    const w = (window.__teams || []).find((x) => x.id === t.id);
    const lead = (
      <span className="st-badge size-5" style={{ '--c': w?.color || '#7350c8' } as CSSProperties}>
        <Icon name="users" size={11} />
      </span>
    );
    return { label: w?.name || 'Team', lead, busy: (window.__teamWorking?.[t.id] || []).length > 0 };
  }
  const a = agentOf(t.id);
  return { label: a?.name || 'Agent', lead: a ? <Avatar agent={a} /> : null, busy: busyAgents.has(t.id) };
}

function ChatWindows() {
  useSyncExternalStore(subscribe, snapshot);
  const d = useAppState();
  // the windows keep inside the screen as it changes size
  useEffect(() => {
    const onResize = () => changed();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const busyAgents = new Set((d?.runs || []).map((r) => r.agentId));
  // the pills sit next to "Ask the Brain" at the bottom
  const bar = document.querySelector('.bottom-bar') || document.body;
  const pilled = wins.filter((w) => w.tabs.length && (w.min || w.shrinking));
  const dragged = drag ? drag.from.tabs.find((t) => t.key === drag!.key) : null;
  const ghost = drag && dragged ? tabInfo(dragged, busyAgents) : null;
  const torn = drag && !drag.target ? tornRect(drag) : null;
  const keys = chatWindowKeys();
  return (
    <>
      {/* one layer for all the windows, so they stack among themselves (by z) and not over the rest */}
      <div className="fixed inset-0 z-44 pointer-events-none">
        {wins.map((w) => (
          <ChatWindow key={w.id} w={w} busyAgents={busyAgents} />
        ))}
        {torn ? (
          <div
            className="cw-torn fixed rounded-[14px] border-2 border-dashed border-accent/60 bg-accent/5"
            style={{ zIndex: zTop + 1, left: `${torn.x}px`, top: `${torn.y}px`, width: `${torn.w}px`, height: `${torn.h}px` }}
            aria-hidden="true"
          />
        ) : null}
      </div>
      {wins.map((w) => {
        // with more than one window down there, each pill says which chat it holds; a lone team chat says its team
        const open = w.tabs.find((t) => t.key === w.active) || w.tabs[0];
        const named = open && (pilled.length > 1 || (w.tabs.length === 1 && open.kind === 'team'));
        const label = named ? `${tabInfo(open, busyAgents).label}${w.tabs.length > 1 ? ` +${w.tabs.length - 1}` : ''}` : `${w.tabs.length} chat${w.tabs.length === 1 ? '' : 's'}`;
        return createPortal(
          <button
            ref={(el) => void (w.pill = el)}
            // (in the bottom bar, next to Ask the Brain, it sits in line there)
            className={`cw-pill glass fixed z-44 right-[84px] bottom-[22px] flex items-center gap-2.5 py-2.5 px-4 rounded-full text-ink cursor-pointer font-sans text-[13px] font-medium leading-[normal] animate-[cw-pop_.25s_ease-out] in-[.bottom-bar]:relative in-[.bottom-bar]:right-auto in-[.bottom-bar]:bottom-auto in-[.bottom-bar]:z-auto in-[.bottom-bar]:animate-none in-[.bottom-bar]:hover:[transform:translateY(-1px)] ${w.tabs.length && (w.min || w.shrinking) ? '' : ' hidden'}`}
            style={w.shrinking ? { opacity: 0 } : undefined}
            onClick={() => setMin(w, false)}
            title={`${w.tabs.length > 1 ? `Open the chats: ${w.tabs.map((t) => tabInfo(t, busyAgents).label).join(', ')}` : 'Open the chats'} (${keys.restore} brings back the last one)`}
          >
            <Icon name="message-square" size={15} />
            <span className="max-w-[180px] truncate">{label}</span>
          </button>,
          bar,
          String(w.id),
        );
      })}
      {drag && ghost
        ? createPortal(
            <div
              className="cw-ghost glass fixed z-100 pointer-events-none flex items-center gap-2 pt-2 pr-3.5 pb-2 pl-2.5 max-w-[200px] rounded-[10px] text-ink text-[13px] [&_.avatar]:size-5 [&_.avatar]:text-[11px]"
              style={{ left: `${drag.x - drag.offX}px`, top: `${drag.y - drag.offY}px` }}
              aria-hidden="true"
            >
              {ghost.lead}
              <span className="truncate">{ghost.label}</span>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

function ChatWindow({ w, busyAgents }: { w: Win; busyAgents: Set<string> }) {
  // The tabs scroll sideways when they don't fit. Their scrollbar is hidden, so a mouse wheel
  // scrolls them too, and the open tab is kept in view.
  const listRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const onWheel = (e: WheelEvent) => {
      if (list.scrollWidth <= list.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      e.preventDefault();
      list.scrollLeft += e.deltaY;
    };
    list.addEventListener('wheel', onWheel, { passive: false });
    return () => list.removeEventListener('wheel', onWheel);
  }, []);
  useEffect(() => {
    const list = listRef.current;
    const tab = w.active ? list?.querySelector<HTMLElement>(`[data-key="${CSS.escape(w.active)}"]`) : null;
    if (!list || !tab) return;
    const l = tab.offsetLeft;
    if (l < list.scrollLeft) list.scrollLeft = l;
    else if (l + tab.offsetWidth > list.scrollLeft + list.clientWidth) list.scrollLeft = l + tab.offsetWidth - list.clientWidth;
  }, [w.active, w.tabs.length, w.max]);
  const any = w.tabs.length > 0;
  // a tab or a window dragged over this window's tabs: show where it goes
  const dropping = (drag?.target === w && drag.from !== w) || merging?.into === w;
  const others = drag?.target === w ? w.tabs.filter((t) => t.key !== drag!.key) : [];
  const markBefore = drag?.target === w && others.length ? (others[drag.index]?.key ?? null) : undefined;
  const lastOther = others[others.length - 1]?.key;
  const r = w.max ? 'rounded-[12px]' : 'rounded-[16px]';
  return (
    <div
      ref={(el) => void (w.el = el)}
      // pop and moving are set by script (pop(), track())
      className={`cw glass group/cw fixed pointer-events-auto flex flex-col overflow-visible [&.moving]:select-none [&.moving]:transition-none ${r}${dropping ? ' border-accent outline-2 outline-accent' : ''}${merging?.from === w && merging.into ? ' opacity-60' : ''}${!any || (w.min && !w.shrinking) ? ' hidden' : ''}`}
      style={placement(w)}
      role="dialog"
      aria-label="Chats"
      aria-modal="false"
      data-win={w.id}
      onPointerDownCapture={() => raise(w)}
    >
      <div
        className={`flex items-center gap-1.5 px-5 pt-4 pb-2 max-sm:px-4 cursor-grab group-[.moving]/cw:cursor-grabbing text-dim min-h-[46px] ${w.max ? 'rounded-t-[12px]' : 'rounded-t-[16px]'}`}
        data-cw-strip={w.id}
        onPointerDown={(e) => startDrag(e, w)}
        onDoubleClick={(e) => !(e.target as Element).closest('button, .cw-tab') && setMax(w, !w.max)}
      >
        <Icon name="message-square" size={15} />
        {/* Let tabs scroll instead of pushing past the window's buttons. */}
        <Tabs.Root className="flex min-w-0" value={w.active} onValueChange={(v) => activate(w, String(v))}>
          <Tabs.List ref={listRef} className="relative flex gap-0.5 overflow-x-auto overflow-y-hidden overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden min-w-0" aria-label="Open chats">
            {w.tabs.map((t) => {
              const { label, lead, busy } = tabInfo(t, busyAgents);
              const on = t.key === w.active;
              const lifted = drag?.key === t.key;
              // cw-tab: startDrag() leaves the tabs alone by it; dragging one moves the tab instead
              return (
                <div
                  key={t.key}
                  data-key={t.key}
                  className={`cw-tab ${TAB} [&_.avatar]:size-5 [&_.avatar]:text-[11px] ${on ? 'text-ink bg-panel' : 'text-dim hover:text-ink hover:bg-panel-2'}${lifted ? ' opacity-35' : ''}`}
                  title={label}
                  onPointerDown={(e) => startTabDrag(e, w, t)}
                  onAuxClick={(e) => e.button === 1 && closeTab(t.key)}
                >
                  {markBefore === t.key ? <span className={`${MARK} -left-0.5`} /> : null}
                  {markBefore === null && t.key === lastOther ? <span className={`${MARK} -right-0.5`} /> : null}
                  <Tabs.Tab value={t.key} className="flex items-center gap-2 min-w-0 cursor-pointer">
                    {lead}
                    <span className="truncate">{label}</span>
                    {busy ? <span className="dot busy" aria-label="working" /> : null}
                  </Tabs.Tab>
                  <button
                    className={`cw-x text-faint cursor-pointer px-0.5 text-[11px] [transition:opacity_.15s] hover:text-ink ${on ? 'opacity-100' : 'opacity-0 group-hover/tab:opacity-100'}`}
                    title="Close" aria-label={`Close ${label}`} onClick={() => closeTab(t.key)}>
                    <Icon name="x" size={12} />
                  </button>
                </div>
              );
            })}
          </Tabs.List>
        </Tabs.Root>
        <span className="flex-1 min-w-0" />
        <LayoutMenu w={w} />
        <button className={BTN} title={`Minimize (${chatWindowKeys().minimize})`} aria-label="Minimize the chats" onClick={() => setMin(w, true)}>
          –
        </button>
        <button className={BTN} title="Maximize / restore" aria-label={w.max ? 'Restore the chats' : 'Maximize the chats'} onClick={() => setMax(w, !w.max)}>
          <Icon name="maximize-2" size={13} />
        </button>
        <button className="icon-btn flex-none" title="Close this window's chats" aria-label="Close all chats in this window" onClick={() => closeWin(w)}>
          <Icon name="x" size={15} />
        </button>
      </div>
      {/* the conversations' own elements go in here (made outside React) */}
      <div className={`flex-1 min-h-0 relative overflow-hidden ${w.max ? 'rounded-b-[12px]' : 'rounded-b-[16px]'}`} ref={(el) => void (w.body = el)} />
      {Object.entries(GRIPS).map(([dir, cls]) => (
        <div key={dir} className={w.max ? `${cls} hidden` : cls} aria-hidden="true" onPointerDown={(e) => startResize(e, w, dir)} />
      ))}
    </div>
  );
}

/** The Layout menu in a window's title bar: the arranging, with their keys. */
function LayoutMenu({ w }: { w: Win }) {
  const keys = chatWindowKeys();
  const open = wins.filter((x) => x.tabs.length);
  const items: { act: ChatWindowAction | 'side'; label: string; icon: string; off?: boolean; line?: boolean }[] = [
    { act: 'left', label: 'Left half', icon: 'panel-left' },
    { act: 'right', label: 'Right half', icon: 'panel-right' },
    { act: 'side', label: 'Side by side', icon: 'columns-2', off: open.length < 2 },
    { act: 'separate', label: 'Separate tabs', icon: 'layout-grid', off: open.flatMap((x) => x.tabs).length < 2, line: true },
    { act: 'combine', label: 'Combine all', icon: 'combine', off: open.length < 2 },
  ];
  return (
    <Menu.Root modal={false}>
      <Menu.Trigger className={BTN} title="Arrange windows" aria-label="Arrange the chat windows">
        <Icon name="layout-panel-left" size={14} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner className="z-96 outline-none" side="bottom" align="end" sideOffset={4} collisionPadding={8}>
          <Menu.Popup className="cw-layout st-menu dd static min-w-60 max-w-80">
            <Menu.Group>
              <Menu.GroupLabel className="st-menu-head">Arrange</Menu.GroupLabel>
              {items.map((it) => [
                it.line ? <Menu.Separator key={`${it.act}-line`} className="st-menu-sep" /> : null,
                <Menu.Item key={it.act} className="st-menu-item data-disabled:opacity-40 data-disabled:pointer-events-none" disabled={it.off} onClick={() => (it.act === 'side' ? sideBySide() : runAction(it.act, w))}>
                  <Icon name={it.icon} size={15} />
                  {it.label}
                  {it.act !== 'side' ? <span className="ml-auto pl-4 text-[12px] text-faint">{keys[it.act]}</span> : null}
                </Menu.Item>,
              ])}
            </Menu.Group>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

// Open (or focus) a chat. kind: 'team' | 'agent'. Returns the tab's chat API (focus, mention).
// A chat already open is shown in its own window; a new one goes in the window on top.
export function openChat(kind: ChatKind, id: string, { focus = true }: { focus?: boolean } = {}): ChatTabApi {
  ensure();
  const key = `${kind}:${id}`;
  const w = winOf(key) || topmost(wins.filter((x) => x.tabs.length && !x.min)) || topmost(wins.filter((x) => x.tabs.length)) || wins[0];
  const was = !w.el || w.el.classList.contains('hidden');
  const t = w.tabs.find((x) => x.key === key) || makeTab(w, kind, id);
  w.min = false;
  raise(w);
  activate(w, t.key, focus);
  if (was) pop(w);
  return t.api;
}

export function refreshChatTabs(): void {
  if (!host) return;
  // drop tabs whose agent or team is gone
  const teams = window.__teams;
  for (const t of wins.flatMap((w) => w.tabs)) {
    if (t.kind === 'agent' && state.data && !agentOf(t.id)) closeTab(t.key);
    if (t.kind === 'team' && teams && !teams.some((w) => w.id === t.id)) closeTab(t.key);
  }
  changed();
}

// Bring back the windows and tabs that were open last time.
export function restoreChats(): void {
  const saved = load().filter((s) => s.tabs?.length);
  if (!saved.length) return;
  ensure();
  saved.forEach((s, i) => {
    const w = i === 0 ? wins[0] : newWin(s.rect || defaultRect(), !!s.min, !!s.max);
    for (const key of s.tabs!) {
      const [kind, id] = key.split(':') as [ChatKind, string];
      if (kind === 'agent' && !agentOf(id)) continue;
      if (kind === 'team' && window.__teams && !window.__teams.some((x) => x.id === id)) continue;
      if (!winOf(key)) makeTab(w, kind, id);
    }
    if (!w.tabs.length) return dropWin(w);
    activate(w, w.tabs.some((x) => x.key === s.active) ? s.active! : w.tabs[0].key, false);
    pop(w);
  });
  const top = topmost(wins.filter((w) => w.tabs.length));
  if (top?.active) activate(top, top.active);
}

export function closeChatsForProject(): void {
  if (host) for (const w of [...wins]) closeWin(w);
}

/** Minimizes the maximized windows: the Station's side panel or map buttons under them were clicked. */
export function minimizeMaximizedChats(): void {
  for (const w of wins) if (w.max && !w.min && w.tabs.length) setMin(w, true);
}

/** The open windows' tabs, bottom window first (for tests). */
export function chatWindows(): { id: number; tabs: string[]; active: string | null }[] {
  return [...wins].sort((a, b) => a.z - b.z).filter((w) => w.tabs.length).map((w) => ({ id: w.id, tabs: w.tabs.map((t) => t.key), active: w.active }));
}

/** Moves a tab to the window with this id (for tests), or with no id into a new window. */
export function moveChatTab(key: string, winId: number | null, index = Infinity): void {
  moveTab(key, winId === null ? null : wins.find((w) => w.id === winId) || null, index);
}
