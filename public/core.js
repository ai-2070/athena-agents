// Shared browser helpers: API, live events, DOM builder, modals, toasts, markdown.
import { marked } from '/vendor/marked.js';
import DOMPurify from '/vendor/purify.js';

// ---------- API ----------
export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { 'x-dash': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) throw new Error((data && data.error) || `${res.status} ${res.statusText}`);
  return data;
}
export const GET = (p) => api(p);
export const POST = (p, body = {}) => api(p, { method: 'POST', body });
export const PUT = (p, body = {}) => api(p, { method: 'PUT', body });
export const DEL = (p) => api(p, { method: 'DELETE' });

// Run an action, show errors as toasts. Returns the result or undefined.
export async function attempt(fn, okMsg) {
  try {
    const r = await fn();
    if (okMsg) toast(typeof okMsg === 'function' ? okMsg(r) : okMsg);
    return r;
  } catch (e) {
    toast(e.message, 'error');
    return undefined;
  }
}

// ---------- shared state + live events ----------
export const state = { data: null, listeners: new Set() };
const eventListeners = new Set();

export function onEvent(fn) {
  eventListeners.add(fn);
  return () => eventListeners.delete(fn);
}

let refreshTimer = null;
export async function refreshState() {
  try {
    state.data = await GET('/state');
    for (const fn of state.listeners) fn(state.data);
  } catch (e) {
    console.warn('state refresh failed', e);
  }
}
export function refreshSoon(ms = 250) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refreshState, ms);
}
export function onState(fn) {
  state.listeners.add(fn);
  return () => state.listeners.delete(fn);
}

let socket;
export function connectEvents() {
  socket = new WebSocket(`ws://${location.host}/ws`);
  socket.onmessage = (m) => {
    let ev;
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
// h('div.card#id', {onclick, class, style, ...attrs}, ...children)
export function h(tag, attrs, ...children) {
  if (attrs == null || typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs)) {
    children.unshift(attrs);
    attrs = {};
  }
  const [, name = 'div', rest = ''] = /^([a-z0-9-]*)(.*)$/i.exec(tag);
  const el = document.createElement(name || 'div');
  for (const part of rest.match(/[.#][^.#]+/g) || []) {
    if (part[0] === '.') el.classList.add(part.slice(1));
    else el.id = part.slice(1);
  }
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className += ` ${v}`;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}
function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}
export const clear = (el) => {
  while (el.firstChild) el.firstChild.remove();
  return el;
};
export const mount = (el, ...children) => {
  clear(el);
  append(el, children);
  return el;
};

export function md(text) {
  const div = document.createElement('div');
  div.innerHTML = DOMPurify.sanitize(marked.parse(String(text || ''), { breaks: true, gfm: true }));
  for (const a of div.querySelectorAll('a')) {
    a.target = '_blank';
    a.rel = 'noopener';
  }
  return div;
}

// ---------- toasts ----------
export function toast(text, kind = 'info', ms = 4200) {
  const el = h(`div.toast${kind !== 'info' ? '.' + kind : ''}`, text);
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), ms);
}

// ---------- modals ----------
export function modal({ title, body, foot = [], narrow = false, onClose } = {}) {
  const root = document.getElementById('modal-root');
  const close = () => {
    back.remove();
    document.removeEventListener('keydown', onKey);
    onClose?.();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };
  const back = h(
    'div.modal-back',
    { onmousedown: (e) => e.target === back && close() },
    h(`div.modal${narrow ? '.narrow' : ''}`, h('div.modal-head', h('h2', title), h('button.icon-btn', { onclick: close, 'aria-label': 'Close' }, '✕')), h('div.modal-body', body), foot.length ? h('div.modal-foot', foot) : null),
  );
  root.append(back);
  document.addEventListener('keydown', onKey);
  return { close, el: back };
}

export function confirmBox(text, { ok = 'Yes', danger = false } = {}) {
  return new Promise((resolve) => {
    let m;
    const done = (v) => {
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

export function promptBox(title, { label = '', value = '', multiline = false, placeholder = '', ok = 'Save' } = {}) {
  return new Promise((resolve) => {
    const input = multiline ? h('textarea', { value, placeholder, rows: 8 }) : h('input', { value, placeholder });
    let m;
    const done = (v) => {
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
    if (!multiline) input.addEventListener('keydown', (e) => e.key === 'Enter' && done(input.value));
  });
}

export function lightbox(src) {
  modal({ title: 'Image', body: h('div.lightbox', h('img', { src }), h('p.mt', h('a', { href: src, target: '_blank' }, 'Open full size'))) });
}

// ---------- small widgets ----------
export function seg(options, value, onChange) {
  const wrap = h('div.seg');
  const render = (v) => {
    clear(wrap);
    for (const o of options) {
      const opt = typeof o === 'string' ? { value: o, label: o } : o;
      wrap.append(h(`button${opt.value === v ? '.on' : ''}`, { type: 'button', title: opt.title || '', onclick: () => (render(opt.value), onChange(opt.value)) }, opt.label));
    }
  };
  render(value);
  return wrap;
}

export function chipSet(options, selected, onChange) {
  const set = new Set(selected || []);
  const wrap = h('div.chips');
  for (const o of options) {
    const opt = typeof o === 'string' ? { value: o, label: o } : o;
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

export function toggle(checked, onChange) {
  const input = h('input', { type: 'checkbox', checked });
  input.addEventListener('change', () => onChange(input.checked));
  return h('label.toggle', input, h('span'));
}

export function field(label, control, hint) {
  return h('label.field', h('span', label), control, hint ? h('span.hint', hint) : null);
}

export function select(options, value, onChange) {
  const el = h(
    'select',
    options.map((o) => {
      const opt = typeof o === 'string' ? { value: o, label: o } : o;
      return h('option', { value: opt.value, selected: opt.value === value }, opt.label);
    }),
  );
  el.value = value ?? '';
  el.addEventListener('change', () => onChange(el.value));
  return el;
}

export function ago(ts) {
  if (!ts) return '';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export const ENGINE_LABEL = { 'claude-code': 'Claude Code', openai: 'API model', hermes: 'Hermes' };
export function engineBadge(agent) {
  const label = ENGINE_LABEL[agent.engine] || agent.engine;
  const extra = agent.engine === 'openai' ? ` · ${agent.provider}` : agent.engine === 'hermes' && agent.hermesProfile ? ` · ${agent.hermesProfile}` : '';
  return h('span.pill', `${label}${extra}`);
}

export function avatar(agent, lg = false) {
  return h(`div.avatar${lg ? '.lg' : ''}`, { style: { '--agent-color': agent.color || 'var(--accent)' } }, agent.emoji || '🤖');
}

export function isRunning(agentId) {
  return (state.data?.runs || []).some((r) => r.agentId === agentId);
}

// One "Needs you" item: Allow / Always allow / Deny (or Approve / Stop with an editable text for workflows).
export function approvalCard(a) {
  const editor = a.editable != null ? h('textarea', { value: a.editable }) : null;
  const note = h('input', { placeholder: 'Optional note for the agent (why not, what instead)' });
  const decide = (approved, always = false) =>
    attempt(async () => {
      await POST(`/approvals/${a.id}`, { approved, always, message: note.value, edited: editor ? editor.value : null });
      refreshSoon(0);
    });
  return h(
    'div.approval',
    h('div.t', a.title),
    h('div.label', a.kind === 'claude' ? 'Claude Code permission' : a.kind === 'workflow' ? 'Workflow checkpoint' : 'Tool call'),
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

export function navigate(hash) {
  location.hash = hash;
}

export function copy(text) {
  navigator.clipboard?.writeText(text).then(() => toast('Copied'));
}
