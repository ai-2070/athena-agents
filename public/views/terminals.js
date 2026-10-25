// Live terminals: PowerShell, Claude Code, Hermes, Orca, or any Claude Code / Hermes agent.
import { Terminal } from '/vendor/xterm.js';
import { FitAddon } from '/vendor/addon-fit.js';
import { h, mount, clear, state, GET, POST, DEL, attempt, navigate, select, onState } from '../core.js';

export const flush = true;
export const title = () => 'Terminals';

let root;
let active = null; // { id, term, ws, fit, ro }
let off;

export async function render(el, params) {
  root = el;
  await draw(params[0]);
  off = onState(() => drawTabs(active?.id));
}

export function unmount() {
  off?.();
  detach();
}

function detach() {
  if (!active) return;
  active.ro?.disconnect();
  active.ws?.close();
  active.term?.dispose();
  active = null;
}

let tabsEl;
let hostEl;

async function draw(id) {
  const list = await GET('/terminals');
  tabsEl = h('div.term-tabs');
  hostEl = h('div.term-host');
  mount(root, h('div.term-layout', tabsEl, hostEl));
  const target = id === 'new' ? null : id && list.find((t) => t.id === id) ? id : list[0]?.id;
  drawTabs(target, list);
  if (target) attach(target);
  else drawLauncher();
}

function drawTabs(currentId, list = state.data?.terminals || []) {
  if (!tabsEl) return;
  mount(
    tabsEl,
    list.map((t) =>
      h(
        `div.tt${t.id === currentId ? '.on' : ''}`,
        { onclick: () => navigate(`#/terminals/${t.id}`) },
        h('span', { class: `dot ${t.exited ? '' : 'on'}` }),
        t.title,
        h('button.x', { title: 'Close', onclick: (e) => (e.stopPropagation(), close(t.id)) }, '✕'),
      ),
    ),
    h(`div.tt${!currentId ? '.on' : ''}`, { onclick: () => navigate('#/terminals/new') }, '+ New'),
  );
}

async function close(id) {
  await attempt(() => DEL(`/terminals/${id}`));
  if (active?.id === id) navigate('#/terminals');
}

function drawLauncher() {
  detach();
  const agents = (state.data?.agents || []).filter((a) => a.engine !== 'openai');
  let agentId = agents[0]?.id || '';
  const open = async (body) => {
    const t = await attempt(() => POST('/terminals', body));
    if (t) navigate(`#/terminals/${t.id}`);
  };
  const e = state.data.engines;
  mount(
    hostEl,
    h(
      'div',
      { style: { padding: '28px', maxWidth: '760px' } },
      h('p.lede', 'Open a real terminal right here. Everything keeps running when you switch pages; come back any time.'),
      h(
        'div.cards',
        card('PowerShell', 'A normal shell in your user folder.', () => open({ kind: 'shell' })),
        e['claude-code'].installed ? card('Claude Code', 'Plain interactive Claude Code session.', () => open({ kind: 'command', command: 'claude', title: 'Claude Code' })) : null,
        e.hermes.installed ? card('Hermes', 'Interactive Hermes (default profile).', () => open({ kind: 'command', command: 'hermes', title: 'Hermes' })) : null,
        card('Orca', 'Orca CLI: status, worktrees, agent sessions.', () => open({ kind: 'command', command: 'orca', args: ['status'], title: 'Orca' })),
      ),
      agents.length
        ? h(
            'div.panel.mt-lg',
            h('div.panel-head', h('h2', 'Open an agent in a terminal')),
            h('p.hint', 'Runs the agent interactively with its instructions, model, tools and MCP servers. Great for long hands-on sessions.'),
            h('div.row.mt', h('div', { style: { width: '300px' } }, select(agents.map((a) => ({ value: a.id, label: `${a.emoji || ''} ${a.name}` })), agentId, (v) => (agentId = v))), h('button.btn', { onclick: () => open({ kind: 'agent', agentId }) }, 'Open')),
          )
        : null,
    ),
  );
}

function card(t, d, onclick) {
  return h('div.card.clickable', { onclick }, h('div.card-title', t), h('div.card-sub', d));
}

function attach(id) {
  detach();
  clear(hostEl);
  const term = new Terminal({
    fontFamily: "'JetBrains Mono', Consolas, monospace",
    fontSize: 13,
    cursorBlink: true,
    allowProposedApi: true,
    scrollback: 10000,
    theme: { background: '#070807', foreground: '#e6e8e0', cursor: '#c4ff3d', selectionBackground: '#c4ff3d55', green: '#c4ff3d', brightGreen: '#d4ff6e', yellow: '#f0b04a', cyan: '#a9d3e2' },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(hostEl);
  const ws = new WebSocket(`ws://${location.host}/ws/term?id=${encodeURIComponent(id)}`);
  const sendSize = () => {
    try {
      fit.fit();
    } catch {
      return;
    }
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
  };
  ws.onopen = () => {
    sendSize();
    term.focus();
  };
  ws.onmessage = (m) => term.write(typeof m.data === 'string' ? m.data : new Uint8Array(m.data));
  ws.onclose = (e) => {
    if (e.code === 4004) term.write('\r\n\x1b[90m[this terminal is gone]\x1b[0m\r\n');
  };
  term.onData((data) => ws.readyState === 1 && ws.send(JSON.stringify({ type: 'input', data })));
  const ro = new ResizeObserver(() => sendSize());
  ro.observe(hostEl);
  active = { id, term, ws, fit, ro };
}

export function onEvent() {}
