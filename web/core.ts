// Shared browser helpers: API, live events, DOM builder, modals, toasts, markdown.
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import type { Agent, AppState, Approval, ServerEvent } from '../shared/types.ts';
import { openSocket, setPageProject, setProjectFolders } from './client/connection.ts';
import { rpc } from './client/rpc.ts';
import { openDialog, showToast } from './ui/overlays.tsx';
import type { ToastKind } from './ui/overlays.tsx';
// (the class functions, not web/ui/dom.ts: that module builds on h() from here)
import { CHIPS_CLASS, buttonClass, chipClass, pillClass } from './ui/classes.ts';
import { zoomView } from './zoomview.ts';
import { slideSegment } from './segmotion.ts';

// ---------- API ----------
// Requests live in web/client/; pages keep importing them from here.
export { api } from './client/http.ts';
export type { ApiOptions } from './client/http.ts';

// Run an action, show errors as toasts. Returns the result or undefined.
export async function attempt<T>(fn: () => Promise<T>, okMsg?: string | ((r: T) => string)): Promise<T | undefined> {
  try {
    const r = await fn();
    if (okMsg) toast(typeof okMsg === 'function' ? okMsg(r) : okMsg);
    return r;
  } catch (e) {
    toast((e as Error).message, 'error');
    return undefined;
  }
}

// ---------- shared state + live events ----------
export type StateListener = (data: AppState) => void;
export type EventListenerFn = (ev: ServerEvent) => void;
export interface Store {
  data: AppState | null;
  listeners: Set<StateListener>;
}
export const state: Store = { data: null, listeners: new Set() };
const eventListeners = new Set<EventListenerFn>();

export function onEvent(fn: EventListenerFn): () => void {
  eventListeners.add(fn);
  return () => eventListeners.delete(fn);
}

// The event socket came back after it dropped: the server doesn't send what was missed meanwhile,
// so views that build on events load again.
const reconnectListeners = new Set<() => void>();
export function onReconnect(fn: () => void): () => void {
  reconnectListeners.add(fn);
  return () => reconnectListeners.delete(fn);
}
let connectedOnce = false;

let eventsConnected = false;
const connectionListeners = new Set<(connected: boolean) => void>();
/** Watch whether live events are connected; the current state is sent immediately. */
export function onEventConnection(fn: (connected: boolean) => void): () => void {
  connectionListeners.add(fn);
  fn(eventsConnected);
  return () => connectionListeners.delete(fn);
}

function setEventConnection(connected: boolean): void {
  if (eventsConnected === connected) return;
  eventsConnected = connected;
  for (const fn of connectionListeners) fn(connected);
}

let refreshTimer: ReturnType<typeof setTimeout> | null = null;
export async function refreshState(): Promise<void> {
  try {
    state.data = await rpc.status.state();
    setPageProject(state.data?.project?.id);
    setProjectFolders(state.data?.projects || [], state.data?.project?.id);
    for (const fn of state.listeners) fn(state.data);
  } catch (e) {
    console.warn('state refresh failed', e);
  }
}
export function refreshSoon(ms = 250): void {
  clearTimeout(refreshTimer ?? undefined);
  refreshTimer = setTimeout(refreshState, ms);
}
export function onState(fn: StateListener): () => void {
  state.listeners.add(fn);
  return () => state.listeners.delete(fn);
}

let socket: WebSocket | undefined;
export function connectEvents(): void {
  socket = openSocket('/ws');
  socket.onmessage = (m: MessageEvent<string>) => {
    let ev: ServerEvent;
    try {
      ev = JSON.parse(m.data);
    } catch {
      return;
    }
    for (const fn of eventListeners) {
      try {
        fn(ev);
      } catch (e) {
        console.error(e);
      }
    }
  };
  socket.onclose = () => {
    setEventConnection(false);
    setTimeout(connectEvents, 1500);
  };
  socket.onopen = () => {
    setEventConnection(true);
    refreshSoon(0);
    if (connectedOnce) for (const fn of reconnectListeners) fn();
    connectedOnce = true;
  };
}

// ---------- DOM ----------
/** What h() and mount() accept as children. Arrays nest; null, undefined and false are skipped. */
export type Child = Node | string | number | null | undefined | false | readonly Child[];

/** The tag name in 'div.card#id' notation: 'div'. */
export type TagName<S extends string> = S extends `${infer A}.${string}` ? TagName<A> : S extends `${infer A}#${string}` ? TagName<A> : S;
/** The element h() makes for a tag: h('input') is an HTMLInputElement, unknown tags an HTMLElement. */
export type ElementFor<S extends string> = S extends unknown ? (TagName<S> extends keyof HTMLElementTagNameMap ? HTMLElementTagNameMap[TagName<S>] : HTMLElement) : never;

type FormControl = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
/** The event an on… handler gets: currentTarget is the element; for input/change on a form control, so is target. */
export type HandlerEvent<E extends HTMLElement, K extends keyof HTMLElementEventMap> = HTMLElementEventMap[K] & { currentTarget: E } & (K extends 'input' | 'change' ? (E extends FormControl ? { target: E } : unknown) : unknown);
export type EventAttrs<E extends HTMLElement> = {
  [K in keyof HTMLElementEventMap as `on${K}`]?: ((e: HandlerEvent<E, K>) => unknown) | null | false;
};

type CssProp = Exclude<{ [K in keyof CSSStyleDeclaration]: CSSStyleDeclaration[K] extends string ? K : never }[keyof CSSStyleDeclaration], number>;
/** style: { fontSize: '12px', zIndex: 95, '--c': '#fff' } (copied onto el.style), or a CSS string. */
// (Webkit-cased names like WebkitLineClamp work in browsers but are missing from TypeScript's DOM types.)
export type StyleAttrs = { [K in CssProp]?: string | number | null } & { [k: `--${string}` | `Webkit${string}`]: string | number | null | undefined };

export type Attrs<E extends HTMLElement = HTMLElement> = EventAttrs<E> & {
  class?: string | null | false;
  style?: StyleAttrs | string | null | false;
  html?: string | null | false;
  value?: string | number | null;
  checked?: boolean | null;
  dataset?: Record<string, string> | null;
  // anything else becomes an attribute: true → '', false/null/undefined → left out
  [k: string]: unknown;
};

// h('div.card#id', {onclick, class, style, ...attrs}, ...children)
export function h<T extends string>(tag: T, ...children: Child[]): ElementFor<T>;
export function h<T extends string>(tag: T, attrs?: Attrs<ElementFor<T>> | null, ...children: Child[]): ElementFor<T>;
export function h(tag: string, attrs?: unknown, ...children: Child[]): HTMLElement {
  if (attrs == null || typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs)) {
    children.unshift(attrs as Child);
    attrs = {};
  }
  const [, name = 'div', rest = ''] = /^([a-z0-9-]*)(.*)$/i.exec(tag)!;
  const el = document.createElement(name || 'div');
  for (const part of rest.match(/[.#][^.#]+/g) || []) {
    if (part[0] === '.') el.classList.add(part.slice(1));
    else el.id = part.slice(1);
  }
  for (const [k, v] of Object.entries(attrs as Record<string, unknown>)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === 'class') el.className += ` ${v}`;
    else if (k === 'style' && typeof v === 'object') {
      // CSS variables ('--c') need setProperty; Object.assign silently drops them
      for (const [sk, sv] of Object.entries(v as Record<string, unknown>)) {
        if (sv == null || sv === false) continue;
        if (sk.startsWith('--')) el.style.setProperty(sk, String(sv));
        else (el.style as unknown as Record<string, unknown>)[sk] = sv;
      }
    }
    else if (k === 'html') el.innerHTML = v as string;
    else if (k === 'value') (el as { value?: unknown }).value = v;
    else if (k === 'checked') (el as HTMLInputElement).checked = !!v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, (v === true ? '' : v) as string);
  }
  append(el, children);
  return el;
}
function append(el: ParentNode, children: readonly Child[]): void {
  for (const c of (children as unknown[]).flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}
export const clear = <E extends Node>(el: E): E => {
  while (el.firstChild) el.firstChild.remove();
  return el;
};
export const mount = <E extends ParentNode>(el: E, ...children: Child[]): E => {
  clear(el);
  append(el, children);
  return el;
};
/** Puts an empty copy of el (same tag, id and attributes) in its place and returns it. Whatever still
 *  holds the old one, like a page that finishes loading after you left it, draws out of sight. */
export const freshElement = <E extends Element>(el: E): E => {
  const fresh = el.cloneNode(false) as E;
  el.replaceWith(fresh);
  return fresh;
};

const MD_OPTIONS = { breaks: true, gfm: true } as const;
function mdDiv(): HTMLDivElement {
  const div = document.createElement('div');
  // md: the browser's usual look for headings, lists and quotes (web/styles/components.css)
  div.className = 'md';
  return div;
}
// agent output is untrusted: sanitize, and if the sanitizer can't run here, show plain text instead
function mdFill(div: HTMLDivElement, html: string, plain: string): HTMLDivElement {
  if (!DOMPurify.isSupported) {
    div.textContent = plain;
    return div;
  }
  div.innerHTML = DOMPurify.sanitize(html);
  // a wide table scrolls sideways in its own box instead of pushing the page wider
  for (const t of div.querySelectorAll('table')) {
    const wrap = document.createElement('div');
    wrap.className = 'md-table';
    t.replaceWith(wrap);
    wrap.append(t);
  }
  for (const a of div.querySelectorAll('a')) {
    a.target = '_blank';
    a.rel = 'noopener';
  }
  // a short file name or code word stays on one line (browsers break after any hyphen: "mention-" / "text.tsx")
  for (const el of div.querySelectorAll('a, code')) {
    const t = el.textContent || '';
    if (t.length <= 40 && !/\s/.test(t) && !el.closest('pre')) el.classList.add('whitespace-nowrap');
  }
  return div;
}

export function md(text: unknown): HTMLDivElement {
  const src = String(text || '');
  return mdFill(mdDiv(), DOMPurify.isSupported ? (marked.parse(src, MD_OPTIONS) as string) : '', src);
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const LINK_DEF = /^ {0,3}\[[^\]]+\]:\s*\S/;
// a line that may carry on the block above it (a list item, an indented line): no cut just before it
const CARRIES_ON = /^(\s|[-*+]\s|\d{1,9}[.)]\s)/;

/** A long Markdown text cut between its blocks into pieces of about `size` characters.
 *  The cutting only looks at lines; each piece is read as Markdown when it is drawn. (Reading the
 *  whole text up front took seconds and gigabytes on a big file, enough to crash the page.)
 *  A piece reads the same as it would inside the whole: [links][by name] still find their address,
 *  and a code block too long for one piece is closed and opened again where it is cut. */
export function mdChunks(text: string, size = 8000): { raw: string; render: () => HTMLDivElement }[] {
  // past this a piece is cut anyway, even inside a list or a code block
  const hard = Math.max(size * 25, 200_000);
  const pieces: { from: number; to: number; open: string; close: string }[] = [];
  const defs: string[] = [];
  let defChars = 0;
  let start = 0;
  let open = '';
  // the code block we are in: its marker (``` or ~~~) and its first line
  let fence = '';
  let fenceLine = '';
  const cut = (at: number) => {
    if (at <= start) return;
    pieces.push({ from: start, to: at, open, close: fence ? `\n${fence}\n` : '' });
    start = at;
    open = fence ? `${fenceLine}\n` : '';
  };
  let blank = false;
  for (let ls = 0; ls < text.length; ) {
    const nl = text.indexOf('\n', ls);
    const le = nl < 0 ? text.length : nl + 1;
    const head = text.slice(ls, Math.min(le, ls + 200));
    const isBlank = le - ls <= 200 && head.trim() === '';
    if (ls - start >= hard || (!fence && blank && !isBlank && ls - start >= size && !CARRIES_ON.test(head))) cut(ls);
    const m = FENCE.exec(head);
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && head.slice(m[0].length).trim() === '') fence = '';
    } else if (m) {
      fence = m[1];
      fenceLine = head.replace(/\r?\n$/, '');
    } else if (LINK_DEF.test(head) && defChars < 100_000) {
      const line = text.slice(ls, Math.min(le, ls + 2000)).trim();
      defs.push(line);
      defChars += line.length;
    }
    // one huge line (no line breaks at all): cut it at spaces
    for (let at = ls + hard; at < le; at += hard) {
      const sp = text.lastIndexOf(' ', at);
      cut(sp > at - 2000 ? sp + 1 : at);
    }
    blank = isBlank;
    ls = le;
  }
  cut(text.length);
  // the [name]: address lines go with every piece (they draw nothing themselves)
  const tail = defs.length ? `\n\n${defs.join('\n')}\n` : '';
  return pieces.map((p) => {
    const raw = text.slice(p.from, p.to);
    return { raw, render: () => mdFill(mdDiv(), DOMPurify.isSupported ? (marked.parse(p.open + raw + p.close + tail, MD_OPTIONS) as string) : '', raw) };
  });
}

// ---------- toasts ----------
// Dialogs and toasts are Base UI (web/ui/overlays.tsx); these keep the plain-DOM way of calling them.
export type { ToastKind } from './ui/overlays.tsx';
const asNodes = (c: Child): Node[] => [...mount(document.createDocumentFragment(), c).childNodes];

export function toast(text: Child, kind: ToastKind = 'info', ms = 4200): void {
  showToast(asNodes(text), kind, ms);
}

// ---------- modals ----------
export interface ModalOptions {
  title?: Child;
  body?: Child;
  foot?: Child[];
  narrow?: boolean;
  /** Animate away when closed; on unless false. */
  exit?: boolean;
  onClose?: () => void;
}
export interface ModalHandle {
  close: () => void;
  /** The backdrop (.modal-back); the dialog is the .modal inside it. */
  el: HTMLDivElement;
}
export function modal({ title, body, foot = [], narrow = false, exit = true, onClose }: ModalOptions = {}): ModalHandle {
  return openDialog({ title: asNodes(title), body: asNodes(body), foot: foot.length ? asNodes(foot) : null, narrow, exit, onClose });
}

export function confirmBox(text: Child, { ok = 'Yes', danger = false }: { ok?: string; danger?: boolean } = {}): Promise<boolean> {
  return new Promise((resolve) => {
    let m: ModalHandle;
    const done = (v: boolean) => {
      resolve(v);
      m.close();
    };
    m = modal({
      title: 'Are you sure?',
      narrow: true,
      body: h('div', { class: 'text-[14px] leading-[1.65] text-ink [&_p]:mb-3 [&_p:last-child]:mb-0' }, text),
      foot: [
        h('button', { class: buttonClass('ghost'), onclick: () => done(false) }, 'Cancel'),
        h('button', { class: buttonClass(danger ? 'danger' : 'primary'), onclick: () => done(true) }, ok),
      ],
      onClose: () => resolve(false),
    });
  });
}

export interface PromptOptions {
  label?: string;
  value?: string;
  multiline?: boolean;
  placeholder?: string;
  ok?: string;
}
export function promptBox(title: Child, { label = '', value = '', multiline = false, placeholder = '', ok = 'Save' }: PromptOptions = {}): Promise<string | null> {
  return new Promise((resolve) => {
    const input: HTMLTextAreaElement | HTMLInputElement = multiline ? h('textarea', { value, placeholder, rows: 8 }) : h('input', { value, placeholder });
    let m: ModalHandle;
    const done = (v: string | null) => {
      resolve(v);
      m.close();
    };
    m = modal({
      title,
      narrow: !multiline,
      body: h('label.field', label ? h('span', label) : null, input),
      foot: [
        h('button', { class: buttonClass('ghost'), onclick: () => done(null) }, 'Cancel'),
        h('button', { class: buttonClass(), onclick: () => done(input.value) }, ok),
      ],
      onClose: () => resolve(null),
    });
    setTimeout(() => input.focus(), 30);
    if (!multiline) (input as HTMLInputElement).addEventListener('keydown', (e) => e.key === 'Enter' && done(input.value));
  });
}

/** A picture shown big, fitted to the window, that zooms (web/zoomview.ts). */
export function lightbox(src: string, name = 'Image'): void {
  const view = zoomView(src, name);
  const m = modal({ title: name, body: view.el });
  m.el.classList.add('wide');
  m.el.addEventListener('keydown', view.onKey);
}

// ---------- small widgets ----------
/** An option for seg(), select() and chipSet(): a plain string is both value and label. */
export interface Option<V extends string = string> {
  value: V;
  label: Child;
  title?: string;
}
export type OptionList<V extends string = string> = readonly (V | Option<V>)[];

export function seg<V extends string>(options: OptionList<V>, value: V | null | undefined, onChange: (v: V) => void): HTMLDivElement {
  const wrap = h('div.seg');
  for (const o of options) {
    const opt: Option<V> = typeof o === 'string' ? { value: o, label: o } : o;
    const button = h(`button${opt.value === value ? '.on' : ''}`, {
      type: 'button', title: opt.title || '', onclick: () => {
        const previous = wrap.querySelector<HTMLButtonElement>('button.on');
        previous?.classList.remove('on');
        button.classList.add('on');
        slideSegment(previous, button);
        onChange(opt.value);
      },
    }, opt.label);
    wrap.append(button);
  }
  return wrap;
}

export function chipSet<V extends string>(options: OptionList<V>, selected: readonly V[] | null | undefined, onChange: (v: V[]) => void): HTMLDivElement {
  const set = new Set<V>(selected || []);
  const wrap = h('div', { class: CHIPS_CLASS });
  for (const o of options) {
    const opt: Option<V> = typeof o === 'string' ? { value: o, label: o } : o;
    const chip = h('label', { class: chipClass(set.has(opt.value)), title: opt.title || '' }, opt.label);
    chip.addEventListener('click', () => {
      if (set.has(opt.value)) set.delete(opt.value);
      else set.add(opt.value);
      chip.className = chipClass(set.has(opt.value));
      onChange([...set]);
    });
    wrap.append(chip);
  }
  return wrap;
}

export function toggle(checked: boolean | null | undefined, onChange: (checked: boolean) => void): HTMLLabelElement {
  const input = h('input', { type: 'checkbox', checked });
  input.addEventListener('change', () => onChange(input.checked));
  return h('label.toggle', input, h('span'));
}

// A switch with its text next to it. The text is its own <label for=…>, so clicking it flips the
// switch (a toggle() inside another <label> nests labels, and the outer one then does nothing).
let toggleIds = 0;
export function toggleRow(checked: boolean | null | undefined, onChange: (checked: boolean) => void, text: Child, cls = ''): HTMLDivElement {
  const t = toggle(checked, onChange);
  const input = t.querySelector('input')!;
  input.id = `toggle-${++toggleIds}`;
  // (cls is in h() notation: '.a.b')
  return h('div', { class: `flex flex-wrap items-center gap-2.5 ${cls.split('.').join(' ')}` }, t, h('label.toggle-text', { class: 'cursor-pointer', for: input.id }, text));
}

export function field(label: Child, control: Child, hint?: Child): HTMLLabelElement {
  return h('label.field', h('span', label), control, hint ? h('span.hint', hint) : null);
}


export function ago(ts: number | null | undefined): string {
  if (!ts) return '';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Which group a chat goes in by when it was last used: Today, Yesterday, This week, This month or Older. */
export function dayOf(t: number, now = Date.now()): string {
  const start = (x: number) => new Date(x).setHours(0, 0, 0, 0);
  const days = Math.round((start(now) - start(t)) / 86_400_000);
  return days <= 0 ? 'Today' : days === 1 ? 'Yesterday' : days < 7 ? 'This week' : days < 31 ? 'This month' : 'Older';
}

/** Chats grouped under their heading (dayOf, unless heading says otherwise), the groups in the order their first
 *  chat comes. (A chat out of place joins its group, never a second one of the same name.) */
export function dayGroups<T extends { updatedAt: number }>(list: T[], heading: (c: T) => string = (c) => dayOf(c.updatedAt)): { day: string; list: T[] }[] {
  const groups = new Map<string, T[]>();
  for (const c of list) {
    const day = heading(c);
    const g = groups.get(day);
    if (g) g.push(c);
    else groups.set(day, [c]);
  }
  return [...groups].map(([day, list]) => ({ day, list }));
}

export const ENGINE_LABEL: Partial<Record<string, string>> = { 'claude-code': 'Claude Code', eve: 'Eve', hermes: 'Hermes', codex: 'Codex', pi: 'pi', omp: 'oh-my-pi', openclaw: 'OpenClaw' };
export function engineBadge(agent: Pick<Agent, 'engine'> & Partial<Pick<Agent, 'provider' | 'hermesProfile' | 'openclawAgent'>>): HTMLSpanElement {
  const label = ENGINE_LABEL[agent.engine] || agent.engine;
  const extra = agent.engine === 'eve' ? ` · ${agent.provider}` : agent.engine === 'hermes' && agent.hermesProfile ? ` · ${agent.hermesProfile}` : agent.engine === 'openclaw' && agent.openclawAgent ? ` · ${agent.openclawAgent}` : '';
  return h('span', { class: pillClass('dim') }, `${label}${extra}`);
}

export function avatar(agent: Partial<Pick<Agent, 'color' | 'emoji'>>, lg = false): HTMLDivElement {
  return h(`div.avatar${lg ? '.lg' : ''}`, { style: { '--agent-color': agent.color || 'var(--color-accent)' } }, agent.emoji || '🤖');
}

export function isRunning(agentId: string): boolean {
  return (state.data?.runs || []).some((r) => r.agentId === agentId);
}

// One "Needs you" item: Allow / Always allow / Deny (or Approve / Stop with an editable text for workflows).
export function approvalCard(a: Approval): HTMLDivElement {
  const editor = a.editable != null ? h('textarea', { value: a.editable as string }) : null;
  const note = h('input', { placeholder: 'Optional note for the agent (why not, what instead)' });
  const decide = (approved: boolean, always = false) =>
    attempt(async () => {
      await rpc.approvals.decide({ id: a.id, approved, always, message: note.value, edited: editor ? editor.value : null });
      refreshSoon(0);
    });
  return h(
    'div.approval',
    h('div.t', a.title),
    h('div.label', { class: 'mb-3' }, a.kind === 'claude' ? 'Claude Code permission' : a.kind === 'workflow' ? 'Workflow checkpoint' : a.kind === 'setting' ? 'A setting' : a.kind === 'tools' ? 'Asks for tools' : 'Tool call'),
    a.brainNote ? h('div.hint', `The Brain passed this to you: ${a.brainNote}`) : null,
    a.detail && !editor ? h('pre', a.detail) : null,
    editor ? h('div', h('div.hint', 'You can edit this before it continues:'), editor) : null,
    h('div', { class: 'mt-4' }, note),
    h(
      'div',
      { class: 'mt-4 flex flex-wrap items-center gap-2' },
      // a setting says what its button does ("Turn on the voxel look"); it is asked each time, never always allowed
      h('button', { class: buttonClass('primary', 'small'), onclick: () => decide(true) }, a.kind === 'setting' && typeof a.data.allow === 'string' ? a.data.allow : editor ? 'Approve' : 'Allow'),
      a.kind !== 'workflow' && a.kind !== 'setting' && a.kind !== 'tools' ? h('button', { class: buttonClass('ghost', 'small'), onclick: () => decide(true, true), title: 'Allow this tool for this agent from now on' }, 'Always allow') : null,
      h('button', { class: buttonClass('danger', 'small'), onclick: () => decide(false) }, a.kind === 'setting' ? 'Not now' : editor ? 'Stop' : 'Deny'),
    ),
  );
}

export function navigate(hash: string): void {
  location.hash = hash;
}

export function copy(text: string): void {
  navigator.clipboard?.writeText(text).then(() => toast('Copied'));
}
