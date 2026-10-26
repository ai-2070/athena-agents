// App shell: navigation, routing, the "Needs you" drawer and live notifications.
import { h, mount, clear, freshElement, state, onState, onEvent, refreshState, refreshSoon, connectEvents, toast, navigate, approvalCard, ago } from './core.ts';
import * as home from './views/home.tsx';
import * as station from './views/station.ts';
import * as artifactsView from './views/artifacts.tsx';
import * as agents from './views/agents.tsx';
import * as chat from './views/chat.tsx';
import * as library from './views/library.tsx';
import * as workflows from './views/workflows.tsx';
import * as programs from './views/programs.tsx';
import * as mcp from './views/mcp.tsx';
import * as connections from './views/connections.tsx';
import * as outboxView from './views/outbox.tsx';
import * as terminals from './views/terminals.tsx';
import * as setup from './views/setup.tsx';
import * as skillsView from './views/skills.tsx';
import * as routinesView from './views/routines.tsx';
import { initDock } from './dock.ts';
import { guardPageDrops } from './attach.ts';
import { applyLook, applySavedLook } from './look.ts';

applySavedLook();
import { icon } from './icons.ts';
import { openProjectMenu, openLauncher } from './projects.ts';
import { projectMark } from './projectlogo.ts';
import type { AppState, EngineStatus, RunEvent, ServerEvent } from '../shared/types.ts';

/** What a view gets as its third render() argument. */
export interface ViewContext {
  setTitle: (t: string) => void;
}
/** A page module in web/views/: render() draws it into the view element; the rest is optional.
 *  (Methods, so a view may take fewer or narrower arguments.) */
export interface View {
  render(el: HTMLElement, params: string[], ctx: ViewContext): unknown;
  unmount?(): unknown;
  onEvent?(ev: ServerEvent): unknown;
  title?(params: string[]): string | null | undefined;
  /** no padding around the page */
  flush?: boolean;
  /** the Station: full-screen map, folded sidebar */
  station?: boolean;
}
interface Route {
  path: string;
  label: string;
  view: View;
}
interface NavLink extends Route {
  ico: string;
  count?: () => number | undefined;
}

// The menu stays short. Other pages still open from links (branch editor, terminals, overview).
const NAV: NavLink[] = [
  { path: 'station', label: 'Station', ico: 'orbit', view: station },
  { path: 'outbox', label: 'Outbox', ico: 'send', view: outboxView, count: () => state.data?.outboxPending },
  { path: 'artifacts', label: 'Artifacts', ico: 'archive', view: artifactsView },
  { path: 'agents', label: 'Agents', ico: 'bot', view: agents },
  { path: 'library', label: 'Library', ico: 'library-big', view: library },
  { path: 'skills', label: 'Skills', ico: 'puzzle', view: skillsView },
  { path: 'routines', label: 'Routines', ico: 'repeat', view: routinesView },
  { path: 'settings', label: 'Settings', ico: 'settings', view: setup },
];
const HIDDEN: Route[] = [
  { path: 'home', label: 'Overview', view: home },
  { path: 'workflows', label: 'Team editor', view: workflows },
  { path: 'programs', label: 'Programs', view: programs },
  { path: 'mcp', label: 'MCP servers', view: mcp },
  { path: 'connections', label: 'Connections', view: connections },
  { path: 'tools', label: 'Settings', view: setup },
  { path: 'terminals', label: 'Terminals', view: terminals },
];

let viewEl = document.getElementById('view')!;
const titleEl = document.getElementById('page-title')!;
let current: { view: View; params: string[] } | null = null;

function renderNav() {
  const route = (location.hash.replace(/^#\/?/, '').split('/')[0] || 'station').split('?')[0];
  mount(
    document.getElementById('nav-links')!,
    NAV.map((n) => {
      const c = n.count?.();
      return h(`a${route === n.path ? '.active' : ''}`, { href: `#/${n.path}`, onclick: () => document.body.classList.remove('nav-open') }, h('span.ico', icon(n.ico, 18)), h('span.txt', n.label), c ? h('span.badge.count', String(c)) : null);
    }),
  );
  const d = state.data;
  if (d) {
    mount(document.getElementById('nav-status')!, navStatus(d));
  }
}

// The status list at the bottom left. Every line opens the matching setting.
function navStatus(d: AppState) {
  const e: Partial<EngineStatus> = d.engines;
  const S = (q: string) => `#/settings?${q}`;
  const ver = (v: string | null | undefined) => (v ? String(v).split(/\s/)[0] : '');
  const line = (dot: string, label: string, value: string, href: string, title?: string) =>
    h('a.ns', { href, title: title || label, onclick: () => document.body.classList.remove('nav-open') }, h('span', { class: `dot ${dot}` }), h('span.ns-txt', label), value ? h('span.ns-val', value) : null);
  const cc: Partial<EngineStatus['claude-code']> = e['claude-code'] || {};
  const cx: Partial<EngineStatus['codex']> = e.codex || {};
  const acc: Partial<AppState['accounts']> = d.accounts || {};
  const x = acc.x || [];
  const rd = acc.reddit || [];
  const b = d.settings?.brain || { provider: 'claude', model: 'haiku' };
  const brainName = String(b.model || 'haiku').replace(/^anthropic\/claude-/, '').replace(/^./, (c) => c.toUpperCase());
  const lines = [
    line(cc.installed ? (cc.loggedIn ? 'on' : 'warn') : '', 'Claude Code', cc.installed ? (cc.loggedIn ? ver(cc.version) || 'ready' : 'not signed in') : 'not found', S('tab=general&find=Claude Code')),
    line(cx.installed ? (cx.loggedIn ? 'on' : 'warn') : '', 'Codex', cx.installed ? (cx.loggedIn ? ver(cx.version) || 'ready' : 'sign in') : 'not installed', S('tab=general&find=OpenAI Codex')),
    line(e.hermes?.installed ? 'on' : '', 'Hermes', e.hermes?.installed ? 'found' : 'not found', S('tab=general&find=Hermes')),
    // (only when installed: most PCs have none of these)
    e.pi?.installed ? line('on', 'pi', ver(e.pi.version) || 'found', S('tab=general&find=pi coding agent')) : null,
    e.omp?.installed ? line('on', 'oh-my-pi', ver(e.omp.version) || 'found', S('tab=general&find=oh-my-pi')) : null,
    e.openclaw?.installed ? line('on', 'OpenClaw', ver(e.openclaw.version) || 'found', S('tab=general&find=OpenClaw')) : null,
    line(e.openai?.openrouter ? 'on' : '', 'OpenRouter', e.openai?.openrouter ? 'key set' : 'no key', S('tab=general&find=OpenRouter key')),
    line('on', 'Brain', `${brainName}${b.provider === 'openrouter' ? ' · OR' : ''}`, S("tab=general&find=The Brain's model"), "The Brain's model"),
    line(x.length ? 'on' : '', 'X', x.length ? (x.length === 1 ? `@${x[0].username}` : `${x.length} accounts`) : 'not connected', S('tab=connections&sub=accounts&find=X accounts')),
    line(rd.length ? 'on' : '', 'Reddit', rd.length ? (rd.length === 1 ? `u/${rd[0].username}` : `${rd.length} accounts`) : 'not connected', S('tab=connections&sub=accounts&find=Reddit accounts')),
    line(acc.telegram?.configured ? 'on' : '', 'Telegram', acc.telegram?.configured ? 'ready' : 'off', S('tab=connections&sub=accounts&find=Telegram')),
    line((d.mcpServers || []).length ? 'on' : '', 'MCP servers', String((d.mcpServers || []).length), S('tab=mcp&find=Your MCP servers')),
    d.outboxPending ? line('busy', 'Outbox', `${d.outboxPending} waiting`, '#/outbox') : null,
  ];
  const sv = d.projectSaved;
  const savedLine = sv ? (sv.error ? `not saved: ${sv.error}` : `auto-saved ${ago(sv.at)}`) : 'auto-save on';
  return [...lines, h('a.ns.ns-foot', { href: S('tab=general&find=About'), title: `Agents, teams and chats are saved into the project folder (.dashboard) after every change.\n${d.project?.brainPath || ''}` }, h('span.ns-txt.faint', `${d.project?.name || 'Project'} · ${savedLine}`)), h('a.ns.ns-foot', { href: S('tab=general&find=About'), title: 'Address' }, h('span.ns-txt.faint', `localhost:${d.port} · no login`))];
}

async function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('?')[0].split('/').filter(Boolean);
  const top = parts[0] || 'station';
  let view: View;
  let params = parts.slice(1);
  if (top === 'agents' && params[0] && params[1] !== 'edit') view = chat;
  else view = [...NAV, ...HIDDEN].find((n) => n.path === top)?.view || station;
  if (current?.view?.unmount) current.view.unmount();
  const here = (current = { view, params });
  // Each page gets its own element: one still loading when you leave draws into the old one, unseen.
  const el = (viewEl = freshElement(viewEl));
  el.className = view.flush ? 'flush' : '';
  document.body.classList.toggle('station-mode', !!view.station);
  document.body.classList.remove('nav-wide');
  // a full chat page has its own message box
  document.body.classList.toggle('in-chat', view === chat);
  titleEl.textContent = view.title?.(params) || [...NAV, ...HIDDEN].find((n) => n.path === top)?.label || '';
  renderNav();
  try {
    await view.render(el, params, { setTitle: (t) => current === here && (titleEl.textContent = t) });
  } catch (e) {
    console.error(e);
    if (current === here) mount(el, h('div.panel', h('p.red', `Something went wrong: ${(e as Error).message}`)));
  }
}

// ---------- Needs you ----------
const drawer = document.getElementById('drawer')!;
const drawerBody = document.getElementById('drawer-body')!;
let seenApprovals = new Set<string>();
// Cards are kept while their approval is unchanged, so a typed note or edit survives other refreshes.
let drawnApprovals = '';
let approvalCards = new Map<string, { key: string; el: HTMLElement }>();

function renderApprovals() {
  const list = state.data?.approvals || [];
  const n = list.length + (state.data?.outboxPending || 0);
  const count = document.getElementById('needs-count')!;
  count.textContent = String(n);
  count.classList.toggle('hot', n > 0);
  const drawn = JSON.stringify([list, state.data?.outboxPending || 0]);
  if (drawn === drawnApprovals) return;
  drawnApprovals = drawn;
  approvalCards = new Map(
    list.map((a) => {
      const key = JSON.stringify(a);
      const old = approvalCards.get(a.id);
      return [a.id, old?.key === key ? old : { key, el: approvalCard(a) }];
    }),
  );
  clear(drawerBody);
  if (state.data?.outboxPending) {
    drawerBody.append(
      h('div.approval', h('div.t', `${state.data.outboxPending} post${state.data.outboxPending > 1 ? 's' : ''} waiting in the Outbox`), h('button.btn.small', { onclick: () => (navigate('#/outbox'), drawer.classList.add('hidden')) }, 'Review posts')),
    );
  }
  for (const c of approvalCards.values()) drawerBody.append(c.el);
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
  const pill = document.getElementById('running-pill')!;
  const runs = state.data?.runs || [];
  pill.classList.toggle('hidden', !runs.length);
  mount(pill, h('span.dot.busy'), runs.length === 1 ? `${runs[0].agentName} working` : `${runs.length} agents working`);
  pill.className = `pill warn${runs.length ? '' : ' hidden'}`;
}

document.getElementById('needs-btn')!.onclick = () => drawer.classList.toggle('hidden');
// project switcher in the top bar (pages other than the Station)
const projBtn = h('button.btn.ghost.small.topbar-project', { onclick: (e) => openProjectMenu(e.currentTarget) });
document.querySelector('.top-actions')!.prepend(projBtn);
onState((d) => mount(projBtn, projectMark(d.project, 15), d.project?.name || 'Project', icon('chevron-down', 13)));
document.getElementById('drawer-close')!.onclick = () => drawer.classList.add('hidden');
document.getElementById('nav-toggle')!.onclick = () => document.body.classList.toggle('nav-open');
document.getElementById('running-pill')!.onclick = () => {
  const r = state.data?.runs?.[0];
  if (r) navigate(`#/agents/${r.agentId}/${r.chatId}`);
};

onState(() => {
  renderNav();
  renderApprovals();
  renderRunning();
});

const STATE_EVENTS = new Set(['agents', 'approvals', 'outbox', 'runs', 'settings', 'accounts', 'terminals', 'mcp', 'project', 'project-logo', 'projects']);
onEvent((ev) => {
  if (STATE_EVENTS.has(ev.type)) refreshSoon();
  if (ev.type === 'toast') toast(ev.text as string);
  if (ev.type === 'run' && (ev.event as RunEvent).kind === 'done' && !location.hash.includes(ev.chatId as string)) {
    const a = state.data?.agents?.find((x) => x.id === ev.agentId);
    if (a) toast(`${a.emoji || ''} ${a.name} finished`);
  }
  current?.view?.onEvent?.(ev);
});

window.addEventListener('hashchange', route);
// files dropped where nothing takes them must not open in the tab (from the start, not once the state loads)
guardPageDrops();
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
    const target = e.target as HTMLElement;
    if (target.closest?.('input, textarea, select')) return target.blur();
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
  const nav = document.getElementById('nav')!;
  let byHover = false;
  let closeTimer: ReturnType<typeof setTimeout> | undefined = undefined;
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
  if (document.body.classList.contains('nav-wide') && !(e.target as Element).closest('#nav')) document.body.classList.remove('nav-wide');
}, true);
route();
