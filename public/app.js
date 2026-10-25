// App shell: navigation, routing, the "Needs you" drawer and live notifications.
import { h, mount, clear, state, onState, onEvent, refreshState, refreshSoon, connectEvents, toast, navigate, approvalCard, ago } from './core.js';
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
import { applyLook, applySavedLook } from './look.js';

applySavedLook();
import { icon } from './icons.js';
import { openProjectMenu, openLauncher } from './projects.js';

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
    mount(document.getElementById('nav-status'), navStatus(d));
  }
}

// The status list at the bottom left. Every line opens the matching setting.
function navStatus(d) {
  const e = d.engines;
  const S = (q) => `#/settings?${q}`;
  const ver = (v) => (v ? String(v).split(/\s/)[0] : '');
  const line = (dot, label, value, href, title) =>
    h('a.ns', { href, title: title || label, onclick: () => document.body.classList.remove('nav-open') }, h('span', { class: `dot ${dot}` }), h('span.ns-txt', label), value ? h('span.ns-val', value) : null);
  const cc = e['claude-code'] || {};
  const cx = e.codex || {};
  const acc = d.accounts || {};
  const x = acc.x || [];
  const rd = acc.reddit || [];
  const b = d.settings?.brain || { provider: 'claude', model: 'haiku' };
  const brainName = String(b.model || 'haiku').replace(/^anthropic\/claude-/, '').replace(/^./, (c) => c.toUpperCase());
  const lines = [
    line(cc.installed ? (cc.loggedIn ? 'on' : 'warn') : '', 'Claude Code', cc.installed ? (cc.loggedIn ? ver(cc.version) || 'ready' : 'not signed in') : 'not found', S('tab=general&find=Claude Code')),
    line(cx.installed ? (cx.loggedIn ? 'on' : 'warn') : '', 'Codex', cx.installed ? (cx.loggedIn ? ver(cx.version) || 'ready' : 'sign in') : 'not installed', S('tab=general&find=OpenAI Codex')),
    line(e.hermes?.installed ? 'on' : '', 'Hermes', e.hermes?.installed ? 'found' : 'not found', S('tab=general&find=Hermes')),
    line(e.openai?.openrouter ? 'on' : '', 'OpenRouter', e.openai?.openrouter ? 'key set' : 'no key', S('tab=general&find=OpenRouter key')),
    line('on', 'Brain', `${brainName}${b.provider === 'openrouter' ? ' · OR' : ''}`, S("tab=general&find=The Brain's model"), "The Brain's model"),
    line(x.length ? 'on' : '', 'X', x.length ? (x.length === 1 ? `@${x[0].username}` : `${x.length} accounts`) : 'not connected', S('tab=connections&sub=accounts&find=X accounts')),
    line(rd.length ? 'on' : '', 'Reddit', rd.length ? (rd.length === 1 ? `u/${rd[0].username}` : `${rd.length} accounts`) : 'not connected', S('tab=connections&sub=accounts&find=Reddit accounts')),
    line(acc.telegram?.configured ? 'on' : '', 'Telegram', acc.telegram?.configured ? 'ready' : 'off', S('tab=connections&sub=accounts&find=Telegram')),
    line((d.mcpServers || []).length ? 'on' : '', 'MCP servers', String((d.mcpServers || []).length), S('tab=mcp&find=Your MCP servers')),
    d.outboxPending ? line('busy', 'Outbox', `${d.outboxPending} waiting`, S('tab=connections&sub=outbox&find=Waiting for you')) : null,
  ];
  const sv = d.projectSaved;
  const savedLine = sv ? (sv.error ? `not saved: ${sv.error}` : `auto-saved ${ago(sv.at)}`) : 'auto-save on';
  return [...lines, h('a.ns.ns-foot', { href: S('tab=general&find=About'), title: `Agents, teams and chats are saved into the project folder (.dashboard) after every change.\n${d.project?.brainPath || ''}` }, h('span.ns-txt.faint', `${d.project?.name || 'Project'} · ${savedLine}`)), h('a.ns.ns-foot', { href: S('tab=general&find=About'), title: 'Address' }, h('span.ns-txt.faint', `localhost:${d.port} · no login`))];
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
  document.body.classList.remove('nav-wide');
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
if (state.data?.settings?.look) applyLook(state.data.settings.look);
connectEvents();
initDock();
openLauncher();
// Esc: whatever is open closes first (dialogs, menus, the Brain chat, Station panels handle it
// themselves). With nothing open, Esc opens the big sidebar, and Esc again closes it.
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  // let the open thing take it first, then decide
  setTimeout(() => {
    if (e.defaultPrevented) return;
    const pop = document.querySelector('.model-menu, .proj-menu');
    if (pop) return pop.remove();
    if (e.target.closest?.('input, textarea, select')) return e.target.blur();
    const body = document.body;
    if (body.classList.contains('nav-open')) return body.classList.remove('nav-open'); // phone menu
    if (body.classList.contains('nav-wide')) return body.classList.remove('nav-wide');
    if (body.classList.contains('station-mode')) body.classList.add('nav-wide');
  }, 0);
});
// Station: the sidebar is a thin icon bar; hovering it opens it to full width, leaving folds it back.
{
  const edge = document.createElement('div');
  edge.id = 'nav-edge';
  edge.title = 'Menu';
  document.body.append(edge);
  const nav = document.getElementById('nav');
  let byHover = false;
  let closeTimer = null;
  const open = () => {
    clearTimeout(closeTimer);
    if (!document.body.classList.contains('nav-wide')) {
      byHover = true;
      document.body.classList.add('nav-wide');
    }
  };
  edge.addEventListener('mouseenter', open);
  // hovering the icon bar opens it (only on the Station, where it is folded)
  nav.addEventListener('mouseenter', () => {
    clearTimeout(closeTimer);
    if (document.body.classList.contains('station-mode')) open();
  });
  nav.addEventListener('mouseleave', () => {
    // opened by Esc: stays until Esc or a click elsewhere
    if (!byHover) return;
    closeTimer = setTimeout(() => {
      document.body.classList.remove('nav-wide');
      byHover = false;
    }, 350);
  });
  new MutationObserver(() => {
    if (!document.body.classList.contains('nav-wide')) byHover = false;
  }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
}
// the big sidebar closes when you click anywhere else
document.addEventListener('pointerdown', (e) => {
  if (document.body.classList.contains('nav-wide') && !e.target.closest('#nav')) document.body.classList.remove('nav-wide');
}, true);
route();
