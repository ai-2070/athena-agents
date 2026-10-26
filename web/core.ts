// Shared browser helpers: API, live events, DOM builder, modals, toasts, markdown.
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import type { Agent, AppState, Approval, ServerEvent } from '../shared/types.ts';

// ---------- API ----------
export interface ApiOptions {
  method?: string;
  body?: unknown;
}
// The JSON the server sent back. T is what the caller expects: GET<Agent[]>('/agents').
export async function api<T = unknown>(path: string, { method = 'GET', body }: ApiOptions = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { 'x-dash': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) throw new Error(((data && (data as { error?: string }).error) || `${res.status} ${res.statusText}`) as string);
  return data as T;
}
export const GET = <T = unknown>(p: string): Promise<T> => api<T>(p);
export const POST = <T = unknown>(p: string, body: unknown = {}): Promise<T> => api<T>(p, { method: 'POST', body });
export const PUT = <T = unknown>(p: string, body: unknown = {}): Promise<T> => api<T>(p, { method: 'PUT', body });
export const DEL = <T = unknown>(p: string): Promise<T> => api<T>(p, { method: 'DELETE' });

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

let refreshTimer: ReturnType<typeof setTimeout> | null = null;
export async function refreshState(): Promise<void> {
  try {
    state.data = await GET<AppState>('/state');
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
  socket = new WebSocket(`ws://${location.host}/ws`);
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
  socket.onclose = () => setTimeout(connectEvents, 1500);
  socket.onopen = () => refreshSoon(0);
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

export function md(text: unknown): HTMLDivElement {
  const div = document.createElement('div');
  // agent output is untrusted: sanitize, and if the sanitizer can't run here, show plain text instead
  if (!DOMPurify.isSupported) {
    div.textContent = String(text || '');
    return div;
  }
  div.innerHTML = DOMPurify.sanitize(marked.parse(String(text || ''), { breaks: true, gfm: true }) as string);
  for (const a of div.querySelectorAll('a')) {
    a.target = '_blank';
    a.rel = 'noopener';
  }
  return div;
}

// ---------- toasts ----------
export type ToastKind = 'info' | 'warn' | 'error';
export function toast(text: Child, kind: ToastKind = 'info', ms = 4200): void {
  const el = h(`div.toast${kind !== 'info' ? '.' + kind : ''}`, text);
  document.getElementById('toasts')!.append(el);
  setTimeout(() => el.remove(), ms);
}

// ---------- modals ----------
export interface ModalOptions {
  title?: Child;
  body?: Child;
  foot?: Child[];
  narrow?: boolean;
  onClose?: () => void;
}
export interface ModalHandle {
  close: () => void;
  el: HTMLDivElement;
}
export function modal({ title, body, foot = [], narrow = false, onClose }: ModalOptions = {}): ModalHandle {
  const root = document.getElementById('modal-root')!;
  const close = () => {
    back.remove();
    document.removeEventListener('keydown', onKey);
    onClose?.();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  };
  const back: HTMLDivElement = h(
    'div.modal-back',
    { onmousedown: (e) => e.target === back && close() },
    h(`div.modal${narrow ? '.narrow' : ''}`, h('div.modal-head', h('h2', title), h('button.icon-btn', { onclick: close, 'aria-label': 'Close' }, '✕')), h('div.modal-body', body), foot.length ? h('div.modal-foot', foot) : null),
  );
  root.append(back);
  document.addEventListener('keydown', onKey);
  return { close, el: back };
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
      body: h('p', text),
      foot: [h('button.btn.ghost', { onclick: () => done(false) }, 'Cancel'), h(`button.btn${danger ? '.danger' : ''}`, { onclick: () => done(true) }, ok)],
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
      foot: [h('button.btn.ghost', { onclick: () => done(null) }, 'Cancel'), h('button.btn', { onclick: () => done(input.value) }, ok)],
      onClose: () => resolve(null),
    });
    setTimeout(() => input.focus(), 30);
    if (!multiline) (input as HTMLInputElement).addEventListener('keydown', (e) => e.key === 'Enter' && done(input.value));
  });
}

export function lightbox(src: string): void {
  modal({ title: 'Image', body: h('div.lightbox', h('img', { src }), h('p.mt', h('a', { href: src, target: '_blank' }, 'Open full size'))) });
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
  const render = (v: V | null | undefined) => {
    clear(wrap);
    for (const o of options) {
      const opt: Option<V> = typeof o === 'string' ? { value: o, label: o } : o;
      wrap.append(h(`button${opt.value === v ? '.on' : ''}`, { type: 'button', title: opt.title || '', onclick: () => (render(opt.value), onChange(opt.value)) }, opt.label));
    }
  };
  render(value);
  return wrap;
}

export function chipSet<V extends string>(options: OptionList<V>, selected: readonly V[] | null | undefined, onChange: (v: V[]) => void): HTMLDivElement {
  const set = new Set<V>(selected || []);
  const wrap = h('div.chips');
  for (const o of options) {
    const opt: Option<V> = typeof o === 'string' ? { value: o, label: o } : o;
    const chip = h(`label.chip${set.has(opt.value) ? '.on' : ''}`, { title: opt.title || '' }, opt.label);
    chip.addEventListener('click', () => {
      if (set.has(opt.value)) set.delete(opt.value);
      else set.add(opt.value);
      chip.classList.toggle('on', set.has(opt.value));
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
  return h(`div.row${cls}`, t, h('label.toggle-text', { for: input.id }, text));
}

export function field(label: Child, control: Child, hint?: Child): HTMLLabelElement {
  return h('label.field', h('span', label), control, hint ? h('span.hint', hint) : null);
}

// onChange gets the picked option's value (the select's .value).
export function select<V extends string>(options: OptionList<V>, value: V | null | undefined, onChange: (v: V) => void): HTMLSelectElement {
  const el = h(
    'select',
    options.map((o) => {
      const opt: Option<V> = typeof o === 'string' ? { value: o, label: o } : o;
      return h('option', { value: opt.value, selected: opt.value === value }, opt.label);
    }),
  );
  el.value = value ?? '';
  el.addEventListener('change', () => onChange(el.value as V));
  return el;
}

export function ago(ts: number | null | undefined): string {
  if (!ts) return '';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export const ENGINE_LABEL: Partial<Record<string, string>> = { 'claude-code': 'Claude Code', openai: 'API model', hermes: 'Hermes', codex: 'Codex', pi: 'pi', omp: 'oh-my-pi', openclaw: 'OpenClaw' };
export function engineBadge(agent: Pick<Agent, 'engine'> & Partial<Pick<Agent, 'provider' | 'hermesProfile' | 'openclawAgent'>>): HTMLSpanElement {
  const label = ENGINE_LABEL[agent.engine] || agent.engine;
  const extra = agent.engine === 'openai' ? ` · ${agent.provider}` : agent.engine === 'hermes' && agent.hermesProfile ? ` · ${agent.hermesProfile}` : agent.engine === 'openclaw' && agent.openclawAgent ? ` · ${agent.openclawAgent}` : '';
  return h('span.pill', `${label}${extra}`);
}

export function avatar(agent: Partial<Pick<Agent, 'color' | 'emoji'>>, lg = false): HTMLDivElement {
  return h(`div.avatar${lg ? '.lg' : ''}`, { style: { '--agent-color': agent.color || 'var(--accent)' } }, agent.emoji || '🤖');
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
      await POST(`/approvals/${a.id}`, { approved, always, message: note.value, edited: editor ? editor.value : null });
      refreshSoon(0);
    });
  return h(
    'div.approval',
    h('div.t', a.title),
    h('div.label', a.kind === 'claude' ? 'Claude Code permission' : a.kind === 'workflow' ? 'Workflow checkpoint' : 'Tool call'),
    a.brainNote ? h('div.hint', `The Brain passed this to you: ${a.brainNote}`) : null,
    a.detail && !editor ? h('pre', a.detail) : null,
    editor ? h('div', h('div.hint', 'You can edit this before it continues:'), editor) : null,
    h('div.mt', note),
    h(
      'div.row.mt',
      h('button.btn.small', { onclick: () => decide(true) }, editor ? 'Approve' : 'Allow'),
      a.kind !== 'workflow' ? h('button.btn.ghost.small', { onclick: () => decide(true, true), title: 'Allow this tool for this agent from now on' }, 'Always allow') : null,
      h('button.btn.danger.small', { onclick: () => decide(false) }, editor ? 'Stop' : 'Deny'),
    ),
  );
}

export function navigate(hash: string): void {
  location.hash = hash;
}

export function copy(text: string): void {
  navigator.clipboard?.writeText(text).then(() => toast('Copied'));
}
