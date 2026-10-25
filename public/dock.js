// The global chat: one window on every page. Send to Auto (the Brain picks an agent or branch),
// to a new agent or branch designed from your message, or straight to any agent or branch.
import { h, mount, clear, state, GET, POST, attempt, md, onEvent, onState, navigate, refreshSoon, chipSet, toast, avatar } from './core.js';
import { openBranchBuilder } from './builder.js';
import { icon } from './icons.js';

const D = { open: false, target: 'auto', items: [], el: null, list: null, input: null, sel: null, workflows: [] };

export function initDock() {
  const launcher = h('button.dock-launcher', { onclick: () => toggle(true) }, icon('sparkles', 17), h('span', 'Ask the Brain…'), h('kbd', 'Ctrl K'));
  D.list = h('div.dock-list');
  D.input = h('textarea.dock-input', { rows: 2, placeholder: 'What do you want done?' });
  D.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });
  D.sel = h('select.dock-target');
  D.sel.addEventListener('change', () => (D.target = D.sel.value));
  D.panel = h(
    'div.dock.hidden',
    h('div.dock-head', h('b', icon('brain', 16), 'Brain chat'), h('span.grow'), h('span.dock-to', 'to'), D.sel, h('button.icon-btn', { onclick: () => toggle(false), 'aria-label': 'Close' }, '✕')),
    D.list,
    h('div.dock-compose', D.input, h('button.btn', { onclick: send, title: 'Send (Enter)' }, icon('send', 15))),
  );
  D.launcher = launcher;
  document.body.append(launcher, D.panel);
  onState(drawTargets);
  // Ctrl+K opens the chat from anywhere
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      toggle(!D.open);
    } else if (e.key === 'Escape' && D.open && D.panel.contains(document.activeElement)) toggle(false);
  });
  onEvent(handleEvent);
  loadWorkflows();
  draw();
}

export function openDock(target = null, text = '') {
  if (target) D.target = target;
  toggle(true);
  if (text) D.input.value = text;
}

function toggle(open) {
  D.open = open;
  D.panel.classList.toggle('hidden', !open);
  D.launcher.classList.toggle('hidden', open);
  if (open) {
    drawTargets();
    setTimeout(() => D.input.focus(), 30);
  }
}

async function loadWorkflows() {
  D.workflows = await GET('/workflows').catch(() => D.workflows);
  drawTargets();
}

function drawTargets() {
  const agents = state.data?.agents || [];
  const opts = [h('option', { value: 'auto' }, '✨ Auto: pick for me'), h('option', { value: 'new-agent' }, '+ New agent from this'), h('option', { value: 'new-branch' }, '+ New team from this')];
  if (agents.length) opts.push(h('optgroup', { label: 'Agents' }, agents.map((a) => h('option', { value: `a:${a.id}` }, `${a.emoji || ''} ${a.name}`))));
  const wfs = D.workflows.filter((w) => w.steps?.length);
  if (wfs.length) opts.push(h('optgroup', { label: 'Teams' }, wfs.map((w) => h('option', { value: `b:${w.id}` }, `⇢ ${w.name}`))));
  mount(D.sel, opts);
  if (![...D.sel.options].some((o) => o.value === D.target)) D.target = 'auto';
  D.sel.value = D.target;
}

// ---------- messages ----------
function add(item) {
  D.items.push({ id: Math.random().toString(36).slice(2), ...item });
  draw();
  return D.items[D.items.length - 1];
}

let frame = false;
function draw() {
  if (frame) return;
  frame = true;
  requestAnimationFrame(() => {
    frame = false;
    mount(D.list, D.items.length ? D.items.map(renderItem) : h('div.dock-empty', icon('sparkles', 26), h('p', 'Ask for anything: an image, a video cut, an email, research, a post or DM.'), h('p.hint', 'Auto picks the right agent or team. New designs one for the job.')));
    D.list.scrollTop = D.list.scrollHeight;
  });
}

function renderItem(it) {
  if (it.kind === 'user') return h('div.dock-msg.user', it.text);
  if (it.kind === 'note') return h('div.dock-note', { class: it.error ? 'err' : '' }, it.busy ? h('span.dot.busy') : null, it.text);
  if (it.kind === 'agent') {
    const a = state.data?.agents.find((x) => x.id === it.agentId);
    const body = it.text ? md(it.text) : h('div.hint', it.done ? '(no answer)' : 'Working…');
    body.classList?.add('dock-answer');
    return h(
      'div.dock-msg.agent',
      h('div.dock-who', a ? avatar(a) : null, h('b', a?.name || 'Agent'), it.reason ? h('span.hint', it.reason) : null, h('span.grow'), h('button.btn.tiny.ghost', { onclick: () => navigate(`#/agents/${it.agentId}/${it.chatId}`) }, 'Open chat')),
      it.tools?.length ? h('div.dock-tools', it.tools.map((t) => h('span', { class: t.status === 'running' ? 'run' : t.isError ? 'err' : '' }, `${t.status === 'running' ? '●' : t.isError ? '✕' : '✓'} ${t.name}`))) : null,
      body,
      it.images?.length ? h('div.st-imgs', it.images.slice(0, 4).map((src) => h('img', { src }))) : null,
      !it.done ? h('div.dock-note', h('span.dot.busy'), it.status || 'Working…') : null,
    );
  }
  if (it.kind === 'branch') {
    return h(
      'div.dock-msg.agent',
      h('div.dock-who', h('div.avatar', '⇢'), h('b', it.name), it.reason ? h('span.hint', it.reason) : null, h('span.grow'), h('button.btn.tiny.ghost', { onclick: () => navigate(`#/workflows/${it.wfId}`) }, 'Open')),
      h(
        'div.dock-steps',
        (it.steps || []).map((s, i) => h('div', { class: s.status }, h('span', s.status === 'done' ? '✓' : s.status === 'failed' ? '✕' : s.status === 'running' ? '●' : s.status === 'needs-you' ? '!' : '·'), ` ${i + 1}. ${s.label}`, s.status === 'needs-you' ? h('span.amber', ' · waiting for you in Needs you') : null)),
      ),
      it.output ? md(it.output) : null,
      it.error ? h('div.dock-note.err', it.error) : null,
    );
  }
  if (it.kind === 'agent-draft') return draftCard(it);
  return null;
}

// A new agent the Brain designed: check it, then create it.
function draftCard(it) {
  const a = it.agent;
  const name = h('input', { value: a.name });
  const spec = h('input', { value: a.specialty });
  name.addEventListener('input', () => (a.name = name.value));
  spec.addEventListener('input', () => (a.specialty = spec.value));
  const create = async (thenRun) => {
    const created = await attempt(() => POST('/agents', a));
    if (!created) return;
    it.kind = 'note';
    it.text = `Created ${created.emoji || ''} ${created.name}.`;
    refreshSoon(0);
    draw();
    if (thenRun) toAgent(created.id, it.task, 'new agent');
  };
  return h(
    'div.dock-msg.agent.draft',
    h('div.dock-who', h('div.avatar', a.emoji), h('b', 'New agent'), h('span.hint', 'designed from your message')),
    h('div.col', { style: { gap: '6px' } }, name, spec),
    h('div.mt', chipSet((state.data?.toolGroups || []).map((g) => ({ value: g.id, label: g.label, title: g.description })), a.toolGroups, (v) => (a.toolGroups = v))),
    h('details.mt', h('summary.hint', { style: { cursor: 'pointer' } }, 'Instructions'), h('pre', a.systemPrompt)),
    h('div.row.mt', h('button.btn.small', { onclick: () => create(true) }, 'Create & do it'), h('button.btn.ghost.small', { onclick: () => create(false) }, 'Create only'), h('button.btn.ghost.small', { onclick: () => ((it.kind = 'note'), (it.text = 'Skipped.'), draw()) }, 'Cancel')),
  );
}

// ---------- sending ----------
async function send() {
  const text = D.input.value.trim();
  if (!text) return;
  D.input.value = '';
  add({ kind: 'user', text });
  const t = D.target;
  if (t.startsWith('a:')) return toAgent(t.slice(2), text);
  if (t.startsWith('b:')) return toBranch(t.slice(2), text);
  if (t === 'new-agent') return newAgent(text);
  if (t === 'new-branch') return newBranch(text);
  // Auto
  const thinking = add({ kind: 'note', text: 'Looking at your agents and teams…', busy: true });
  const r = await POST('/assist/route', { text }).catch((e) => ({ kind: 'error', reason: e.message }));
  D.items.splice(D.items.indexOf(thinking), 1);
  if (r.kind === 'agent') return toAgent(r.id, text, r.reason);
  if (r.kind === 'branch') return toBranch(r.id, text, r.reason);
  add({ kind: 'note', text: r.kind === 'error' ? `Couldn't decide: ${r.reason}` : `None of your agents fits this (${r.reason}).`, error: r.kind === 'error' });
  add({ kind: 'note', text: h('span', 'Make one for it: ', h('button.btn.tiny', { onclick: () => newAgent(text) }, 'New agent'), ' ', h('button.btn.tiny.ghost', { onclick: () => newBranch(text) }, 'New team')) });
}

async function toAgent(agentId, text, reason = '') {
  const c = await attempt(() => POST(`/agents/${agentId}/chats`));
  if (!c) return;
  const it = add({ kind: 'agent', agentId, chatId: c.id, text: '', tools: [], images: [], reason, done: false });
  const r = await attempt(() => POST(`/agents/${agentId}/chats/${c.id}/messages`, { text }));
  if (!r) {
    it.done = true;
    it.text = '(could not start)';
    draw();
  }
}

async function toBranch(wfId, text, reason = '') {
  const wf = D.workflows.find((w) => w.id === wfId);
  const run = await attempt(() => POST(`/workflows/${wfId}/run`, { input: text }));
  if (!run) return;
  add({ kind: 'branch', wfId, runId: run.id, name: wf?.name || 'Team', reason, steps: run.steps });
}

async function newAgent(text) {
  const n = add({ kind: 'note', text: 'Designing an agent for this…', busy: true });
  const a = await POST('/assist/agent', { text }).catch((e) => ({ error: e.message }));
  D.items.splice(D.items.indexOf(n), 1);
  if (a.error) return add({ kind: 'note', text: `Couldn't design it: ${a.error}`, error: true });
  add({ kind: 'agent-draft', agent: a, task: text });
}

async function newBranch(text) {
  const n = add({ kind: 'note', text: 'Building a team from your agents…', busy: true });
  const design = await POST('/assist/branch', { text }).catch((e) => ({ error: e.message }));
  D.items.splice(D.items.indexOf(n), 1);
  if (design.error) return add({ kind: 'note', text: `Couldn't build it: ${design.error}`, error: true });
  draw();
  openBranchBuilder({
    prefill: { ...design, steps: design.steps.map((s) => ({ id: Math.random().toString(36).slice(2), ...s })) },
    onSaved: async (wf) => {
      await loadWorkflows();
      D.items.push({ id: 'ran' + wf.id, kind: 'note', text: h('span', `Team "${wf.name}" is ready. `, h('button.btn.tiny', { onclick: () => toBranch(wf.id, text) }, 'Run it with my message')) });
      draw();
    },
  });
}

// ---------- live updates ----------
function handleEvent(ev) {
  if (ev.type === 'workflows') loadWorkflows();
  if (ev.type === 'run') {
    const it = D.items.find((x) => x.kind === 'agent' && x.chatId === ev.chatId);
    if (!it) return;
    const e = ev.event;
    if (e.kind === 'text') {
      it.text += e.text;
      it.status = 'Writing…';
    } else if (e.kind === 'tool') {
      it.tools.push({ id: e.id, name: e.name, status: 'running' });
      it.status = `Using ${e.name}…`;
    } else if (e.kind === 'tool_result') {
      const t = it.tools.find((x) => x.id === e.id);
      if (t) Object.assign(t, { status: 'done', isError: e.isError });
      if (e.images?.length) it.images.push(...e.images);
    } else if (e.kind === 'status') it.status = e.text;
    else if (e.kind === 'done' || e.kind === 'error') {
      it.done = true;
      if (e.kind === 'error') it.text += `\n\n**Error:** ${e.text}`;
      // the saved chat has the full answer
      GET(`/agents/${it.agentId}/chats/${it.chatId}`)
        .then((c) => {
          const lastUser = c.items.findLastIndex((x) => x.type === 'user');
          const answer = c.items.slice(lastUser + 1).filter((x) => x.type === 'assistant').map((x) => x.text).join('\n\n');
          if (answer) it.text = answer;
          draw();
        })
        .catch(() => {});
    }
    draw();
  }
  if (ev.type === 'workflow-run' && ev.run) {
    const it = D.items.find((x) => x.kind === 'branch' && x.runId === ev.run.id);
    if (!it) return;
    it.steps = ev.run.steps;
    if (ev.run.status !== 'running') {
      it.error = ev.run.error || null;
      GET(`/workflow-runs?workflowId=${it.wfId}`)
        .then((runs) => {
          const r = runs.find((x) => x.id === it.runId);
          if (r?.output) it.output = String(r.output).slice(0, 4000);
          draw();
        })
        .catch(() => {});
    }
    draw();
  }
}
