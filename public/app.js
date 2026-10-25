// App shell: navigation, routing, the "Needs you" drawer and live notifications.
import { h, mount, clear, state, onState, onEvent, refreshState, refreshSoon, connectEvents, toast, navigate, approvalCard } from './core.js';
import * as home from './views/home.js';
import * as station from './views/station.js';
import * as agents from './views/agents.js';
import * as chat from './views/chat.js';
import * as library from './views/library.js';
import * as workflows from './views/workflows.js';
import * as programs from './views/programs.js';
import * as mcp from './views/mcp.js';
import * as connections from './views/connections.js';
import * as terminals from './views/terminals.js';
import * as settings from './views/settings.js';
import * as setup from './views/setup.js';
import { initDock } from './dock.js';
import { icon } from './icons.js';
import { openProjectMenu } from './projects.js';

// The menu stays short. Other pages still open from links (branch editor, terminals, overview).
const NAV = [
  { path: 'station', label: 'Station', ico: 'orbit', view: station },
  { path: 'agents', label: 'Agents', ico: 'bot', view: agents },
  { path: 'library', label: 'Library', ico: 'library-big', view: library },
  { path: 'settings', label: 'Settings', ico: 'settings', view: setup, count: () => state.data?.outboxPending },
];
const HIDDEN = [
  { path: 'home', label: 'Overview', view: home },
  { path: 'workflows', label: 'Team editor', view: workflows },
  { path: 'programs', label: 'Programs', view: programs },
  { path: 'mcp', label: 'MCP servers', view: mcp },
  { path: 'connections', label: 'Connections', view: connections },
  { path: 'tools', label: 'Settings', view: setup },
  { path: 'terminals', label: 'Terminals', view: terminals },
];

const viewEl = document.getElementById('view');
const titleEl = document.getElementById('page-title');
let current = null;

function renderNav() {
  const route = (location.hash.replace(/^#\/?/, '').split('/')[0] || 'station').split('?')[0];
  mount(
    document.getElementById('nav-links'),
    NAV.map((n) => {
      const c = n.count?.();
      return h(`a${route === n.path ? '.active' : ''}`, { href: `#/${n.path}`, onclick: () => document.body.classList.remove('nav-open') }, h('span.ico', icon(n.ico, 18)), h('span.txt', n.label), c ? h('span.badge.count', String(c)) : null);
    }),
  );
  const d = state.data;
  if (d) {
    const e = d.engines;
    mount(
      document.getElementById('nav-status'),
      h('div', h('span', { class: `dot ${e['claude-code'].installed ? 'on' : ''}` }), ' Claude Code'),
      h('div', h('span', { class: `dot ${e.hermes.installed ? 'on' : ''}` }), ' Hermes'),
      h('div', h('span', { class: `dot ${e.openai.openrouter ? 'on' : ''}` }), ' OpenRouter'),
      h('div.faint', `localhost:${d.port} · no login`),
    );
  }
}

async function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('?')[0].split('/').filter(Boolean);
  const top = parts[0] || 'station';
  let view;
  let params = parts.slice(1);
  if (top === 'agents' && params[0] && params[1] !== 'edit') view = chat;
  else view = [...NAV, ...HIDDEN].find((n) => n.path === top)?.view || station;
  if (current?.view?.unmount) current.view.unmount();
  current = { view, params };
  viewEl.className = view.flush ? 'flush' : '';
  document.body.classList.toggle('station-mode', !!view.station);
  // a full chat page has its own message box
  document.body.classList.toggle('in-chat', view === chat);
  clear(viewEl);
  titleEl.textContent = view.title?.(params) || [...NAV, ...HIDDEN].find((n) => n.path === top)?.label || '';
  renderNav();
  try {
    await view.render(viewEl, params, { setTitle: (t) => (titleEl.textContent = t) });
  } catch (e) {
    mount(viewEl, h('div.panel', h('p.red', `Something went wrong: ${e.message}`)));
    console.error(e);
  }
}

// ---------- Needs you ----------
const drawer = document.getElementById('drawer');
const drawerBody = document.getElementById('drawer-body');
let seenApprovals = new Set();

function renderApprovals() {
  const list = state.data?.approvals || [];
  const n = list.length + (state.data?.outboxPending || 0);
  const count = document.getElementById('needs-count');
  count.textContent = String(n);
  count.classList.toggle('hot', n > 0);
  clear(drawerBody);
  if (state.data?.outboxPending) {
    drawerBody.append(
      h('div.approval', h('div.t', `${state.data.outboxPending} post${state.data.outboxPending > 1 ? 's' : ''} waiting in the Outbox`), h('button.btn.small', { onclick: () => (navigate('#/settings?tab=connections&sub=outbox'), drawer.classList.add('hidden')) }, 'Review posts')),
    );
  }
  for (const a of list) drawerBody.append(approvalCard(a));
  if (!n) drawerBody.append(h('p.empty', 'Nothing needs you right now.'));
  // Open the drawer when something new arrives.
  const fresh = list.filter((a) => !seenApprovals.has(a.id));
  if (fresh.length) {
    drawer.classList.remove('hidden');
    toast(fresh[0].title, 'warn');
  }
  seenApprovals = new Set(list.map((a) => a.id));
}

function renderRunning() {
  const pill = document.getElementById('running-pill');
  const runs = state.data?.runs || [];
  pill.classList.toggle('hidden', !runs.length);
  mount(pill, h('span.dot.busy'), runs.length === 1 ? `${runs[0].agentName} working` : `${runs.length} agents working`);
  pill.className = `pill warn${runs.length ? '' : ' hidden'}`;
}

document.getElementById('needs-btn').onclick = () => drawer.classList.toggle('hidden');
// project switcher in the top bar (pages other than the Station)
const projBtn = h('button.btn.ghost.small.topbar-project', { onclick: (e) => openProjectMenu(e.currentTarget) });
document.querySelector('.top-actions').prepend(projBtn);
onState((d) => mount(projBtn, icon('folder', 14), d.project?.name || 'Project', icon('chevron-down', 13)));
document.getElementById('drawer-close').onclick = () => drawer.classList.add('hidden');
document.getElementById('nav-toggle').onclick = () => document.body.classList.toggle('nav-open');
document.getElementById('running-pill').onclick = () => {
  const r = state.data?.runs?.[0];
  if (r) navigate(`#/agents/${r.agentId}/${r.chatId}`);
};

onState(() => {
  renderNav();
  renderApprovals();
  renderRunning();
});

const STATE_EVENTS = new Set(['agents', 'approvals', 'outbox', 'runs', 'settings', 'accounts', 'terminals', 'mcp', 'project', 'projects']);
onEvent((ev) => {
  if (STATE_EVENTS.has(ev.type)) refreshSoon();
  if (ev.type === 'toast') toast(ev.text);
  if (ev.type === 'run' && ev.event.kind === 'done' && !location.hash.includes(ev.chatId)) {
    const a = state.data?.agents?.find((x) => x.id === ev.agentId);
    if (a) toast(`${a.emoji || ''} ${a.name} finished`);
  }
  current?.view?.onEvent?.(ev);
});

window.addEventListener('hashchange', route);
await refreshState();
connectEvents();
initDock();
route();
