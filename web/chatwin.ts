// The chat window: one floating window over the map with a tab for every conversation you open
// (team group chats and agents). Drag it by its title bar, resize it from any edge or corner,
// minimize it to a pill or maximize it. Size, place and open tabs are remembered in this browser.
import { h, mount, state, avatar, onState, GET } from './core.ts';
import { icon } from './icons.ts';
import { renderTeamChat } from './teamchat.ts';
import { renderAgentChat } from './agentchat.ts';
import { uiZoom } from './look.ts';
import { flipFrom, flipTo, slideIn, reducedMotion } from './motion.ts';
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
  body: HTMLDivElement;
  api: ChatTabApi;
}
/** What is remembered in localStorage. */
interface SavedWindow {
  rect?: Rect | null;
  tabs?: string[];
  active?: string | null;
  min?: boolean;
  max?: boolean;
}
interface ChatWindow {
  el: HTMLDivElement | null;
  tabsEl: HTMLDivElement | null;
  bodyEl: HTMLDivElement | null;
  pill: HTMLButtonElement | null;
  tabs: ChatTab[];
  active: string | null;
  min: boolean;
  max: boolean;
  rect: Rect | null;
}

const KEY = 'dash-chatwin';
const W: ChatWindow = { el: null, tabsEl: null, bodyEl: null, pill: null, tabs: [], active: null, min: false, max: false, rect: null };

const load = (): SavedWindow => {
  try {
    return JSON.parse(localStorage.getItem(KEY) || 'null') || {};
  } catch {
    return {};
  }
};
const save = () => {
  try {
    localStorage.setItem(KEY, JSON.stringify({ rect: W.rect, tabs: W.tabs.map((t) => t.key), active: W.active, min: W.min, max: W.max }));
  } catch {
    /* private window */
  }
};

const teamOf = (id: string) => state.data && (window.__teams || []).find((w) => w.id === id);
const agentOf = (id: string) => state.data?.agents.find((a) => a.id === id);

function ensure() {
  if (W.el) return;
  const saved = load();
  const vw = window.innerWidth / uiZoom();
  const vh = window.innerHeight / uiZoom();
  // first time: on the left, so the middle of the map stays free (the info panel is on the right)
  W.rect = saved.rect || { x: 74, y: 64, w: Math.min(600, vw * 0.4), h: Math.max(360, vh - 150) };
  W.min = !!saved.min;
  W.max = !!saved.max;
  W.tabsEl = h('div.cw-tabs');
  W.bodyEl = h('div.cw-body');
  const head = h(
    'div.cw-head',
    icon('message-square', 15),
    W.tabsEl,
    h('span.grow'),
    h('button.cw-btn', { title: 'Minimize', onclick: () => setMin(true) }, '–'),
    h('button.cw-btn', { title: 'Maximize / restore', onclick: () => setMax(!W.max) }, icon('maximize-2', 13)),
    h('button.cw-btn', { title: 'Close all chats', onclick: closeAll }, '✕'),
  );
  // resize from every edge and corner
  const edges = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].map((dir) => {
    const g = h(`div.cw-grip.${dir}`);
    g.addEventListener('pointerdown', (e) => startResize(e, dir));
    return g;
  });
  W.el = h('div.cw.hidden', head, W.bodyEl, ...edges);
  W.pill = h('button.cw-pill.hidden', { onclick: () => setMin(false), title: 'Open the chats' }, icon('message-square', 15), h('span.cw-pill-n'));
  document.body.append(W.el);
  // the pill sits next to "Ask the Brain" at the bottom
  (document.querySelector('.bottom-bar') || document.body).append(W.pill);
  head.addEventListener('pointerdown', startDrag);
  head.addEventListener('dblclick', (e) => !(e.target as Element).closest('button') && setMax(!W.max));
  window.addEventListener('resize', () => place());
  // also drops the tab of an agent that was deleted
  onState(() => W.tabs.length && refreshChatTabs());
  if (!window.__teams) GET<TeamListing[]>('/workflows').then((w) => ((window.__teams ||= w), drawTabs())).catch(() => {});
  place();
}

// The smallest the window gets: 380 × 300, or less on a screen too small for that.
function minSize() {
  const z = uiZoom();
  return { w: Math.min(380, window.innerWidth / z - 20), h: Math.min(300, window.innerHeight / z - 20) };
}

function place() {
  if (!W.el) return;
  const z = uiZoom();
  const vw = window.innerWidth / z;
  const vh = window.innerHeight / z;
  const r = W.rect!;
  const min = minSize();
  r.w = Math.max(min.w, Math.min(r.w, vw - 20));
  r.h = Math.max(min.h, Math.min(r.h, vh - 20));
  r.x = Math.max(4, Math.min(r.x, vw - 120));
  r.y = Math.max(4, Math.min(r.y, vh - 48));
  W.el.classList.toggle('max', W.max);
  Object.assign(W.el.style, W.max ? { left: '70px', top: '64px', width: `${vw - 90}px`, height: `${vh - 84}px` } : { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
}

function startDrag(e: PointerEvent) {
  if (e.button !== 0 || (e.target as Element).closest('button, .cw-tab')) return;
  if (W.max) return;
  e.preventDefault();
  const z = uiZoom();
  const sx = e.clientX;
  const sy = e.clientY;
  const { x, y } = W.rect!;
  W.el!.classList.add('moving');
  const move = (ev: PointerEvent) => {
    W.rect!.x = x + (ev.clientX - sx) / z;
    W.rect!.y = y + (ev.clientY - sy) / z;
    place();
  };
  const up = () => {
    W.el!.classList.remove('moving');
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    save();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

function startResize(e: PointerEvent, dir: string) {
  if (W.max) return;
  e.preventDefault();
  e.stopPropagation();
  const z = uiZoom();
  const sx = e.clientX;
  const sy = e.clientY;
  const r0 = { ...W.rect! };
  const min = minSize();
  W.el!.classList.add('moving');
  const move = (ev: PointerEvent) => {
    const dx = (ev.clientX - sx) / z;
    const dy = (ev.clientY - sy) / z;
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
    W.rect = r;
    place();
  };
  const up = () => {
    W.el!.classList.remove('moving');
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    save();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

// Minimize: the window shrinks into its pill. Open again: it grows back out of the pill.
let minimizing: Promise<void> | null = null;
function setMin(v: boolean) {
  const el = W.el!;
  const pill = W.pill!;
  const bar = document.querySelector('.bottom-bar');
  if (bar && pill.parentElement !== bar) bar.append(pill);
  if (v === W.min && !minimizing) return;
  W.min = v;
  save();
  if (v) {
    // show the pill (invisible) to know where to shrink into
    pill.classList.remove('hidden');
    pill.style.opacity = '0';
    const to = pill.getBoundingClientRect();
    const done = (minimizing = flipTo(el, to, { duration: 320 }).then(() => {
      if (minimizing !== done) return;
      minimizing = null;
      pill.style.opacity = '';
      show(false);
      slideIn(pill, { scale: 0.7, duration: 320 });
    }));
    return;
  }
  minimizing = null;
  el.getAnimations().forEach((a) => a.cancel());
  const from = pill.getBoundingClientRect();
  show(false);
  if (from.width) flipFrom(el, from, { duration: 420, fade: true });
}
// Maximize / restore: the window glides from its old size to the new one.
function setMax(v: boolean) {
  const el = W.el!;
  const from = el.getBoundingClientRect();
  W.max = v;
  W.min = false;
  place();
  show(false);
  save();
  if (from.width && !reducedMotion()) flipFrom(el, from, { duration: 380 });
}

function show(pop = true) {
  const any = W.tabs.length > 0;
  const el = W.el!;
  const bar = document.querySelector('.bottom-bar');
  if (bar && W.pill!.parentElement !== bar) bar.append(W.pill!);
  W.el!.classList.toggle('hidden', !any || W.min);
  W.pill!.classList.toggle('hidden', !any || !W.min);
  W.pill!.querySelector('.cw-pill-n')!.textContent = `${W.tabs.length} chat${W.tabs.length === 1 ? '' : 's'}`;
  if (any && !W.min && pop) {
    el.classList.remove('pop');
    void el.offsetWidth;
    el.classList.add('pop');
  }
}

function drawTabs() {
  const teams = window.__teams || [];
  const d = state.data;
  const busyAgents = new Set((d?.runs || []).map((r) => r.agentId));
  mount(
    W.tabsEl!,
    W.tabs.map((t) => {
      let label = '';
      let lead: HTMLElement | null = null;
      let busy = false;
      if (t.kind === 'team') {
        const w = teams.find((x) => x.id === t.id);
        label = w?.name || 'Team';
        lead = h('span.cw-tab-dot', { style: { '--c': w?.color || '#7350c8' } }, icon('users', 11));
        busy = (window.__teamWorking?.[t.id] || []).length > 0;
      } else {
        const a = agentOf(t.id);
        label = a?.name || 'Agent';
        lead = a ? avatar(a) : null;
        busy = busyAgents.has(t.id);
      }
      return h(
        `div.cw-tab${t.key === W.active ? '.on' : ''}${busy ? '.busy' : ''}`,
        { title: label, onclick: () => activate(t.key), onauxclick: (e) => e.button === 1 && closeTab(t.key) },
        lead,
        h('span.cw-tab-name', label),
        busy ? h('span.dot.busy') : null,
        h('button.cw-tab-x', { title: 'Close', onclick: (e) => (e.stopPropagation(), closeTab(t.key)) }, '✕'),
      );
    }),
  );
}

function activate(key: string, focus = true) {
  const t = W.tabs.find((x) => x.key === key);
  if (!t) return;
  W.active = key;
  for (const x of W.tabs) x.body.classList.toggle('hidden', x.key !== key);
  drawTabs();
  save();
  if (focus) setTimeout(() => t.api?.focus?.(), 30);
}

function makeTab(kind: ChatKind, id: string): ChatTab {
  const key = `${kind}:${id}`;
  const body = h('div.cw-pane.hidden');
  W.bodyEl!.append(body);
  const api: ChatTabApi = kind === 'team' ? renderTeamChat(body, id, { fill: true }) : renderAgentChat(body, id);
  const t: ChatTab = { key, kind, id, body, api };
  W.tabs.push(t);
  return t;
}

function closeTab(key: string) {
  const i = W.tabs.findIndex((x) => x.key === key);
  if (i < 0) return;
  const [t] = W.tabs.splice(i, 1);
  t.api?.destroy?.();
  t.body.remove();
  if (W.active === key) W.active = W.tabs[Math.min(i, W.tabs.length - 1)]?.key || null;
  if (W.active) activate(W.active);
  drawTabs();
  show();
  save();
}

function closeAll() {
  for (const t of [...W.tabs]) closeTab(t.key);
}

// Open (or focus) a chat. kind: 'team' | 'agent'. Returns the tab's chat API (focus, mention).
export function openChat(kind: ChatKind, id: string, { focus = true }: { focus?: boolean } = {}): ChatTabApi {
  ensure();
  const key = `${kind}:${id}`;
  const t = W.tabs.find((x) => x.key === key) || makeTab(kind, id);
  const was = W.el!.classList.contains('hidden');
  W.min = false;
  activate(t.key, focus);
  if (was) show();
  else drawTabs();
  return t.api;
}

export function refreshChatTabs(): void {
  if (!W.el) return;
  // drop tabs whose agent or team is gone
  const teams = window.__teams;
  for (const t of [...W.tabs]) {
    if (t.kind === 'agent' && state.data && !agentOf(t.id)) closeTab(t.key);
    if (t.kind === 'team' && teams && !teams.some((w) => w.id === t.id)) closeTab(t.key);
  }
  drawTabs();
}

// Bring back the tabs that were open last time.
export function restoreChats(): void {
  const saved = load();
  if (!saved.tabs?.length) return;
  ensure();
  for (const key of saved.tabs) {
    const [kind, id] = key.split(':') as [ChatKind, string];
    if (kind === 'agent' && !agentOf(id)) continue;
    if (kind === 'team' && window.__teams && !window.__teams.some((w) => w.id === id)) continue;
    if (!W.tabs.some((x) => x.key === key)) makeTab(kind, id);
  }
  if (!W.tabs.length) return;
  activate(W.tabs.some((x) => x.key === saved.active) ? saved.active! : W.tabs[0].key);
  show();
}

export function closeChatsForProject(): void {
  if (W.el) closeAll();
}
