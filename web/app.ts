// App shell: navigation, routing, the "Needs you" drawer and live notifications.
import { h, mount, clear, freshElement, state, onState, onEvent, refreshState, refreshSoon, connectEvents, toast, navigate, approvalCard, ago } from './core.ts';
import { rpc } from './client/rpc.ts';
import { backdropEscape } from './shortcuts.ts';
import { domBadge, domButton, domDot } from './ui/dom.ts';
import { badgeClass, buttonClass, iconButtonClass, pillClass } from './ui/classes.ts';
import type { DotTone } from './ui/classes.ts';
import * as home from './views/home.tsx';
import * as station from './views/station.ts';
import * as artifactsView from './views/artifacts.tsx';
import * as tasksView from './views/tasks.tsx';
import * as overviewView from './views/overview.tsx';
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
import { initDock } from './dock.tsx';
import { mountDrawerQuestions } from './questions.tsx';
import { guardPageDrops } from './attach.tsx';
import { applyLook, applySavedLook } from './look.ts';
import { autosizeTextareas } from './autosize.ts';
import { navLimits, panelSwitch, sidebarPanel } from './navlimits.tsx';
import { gatewayStatusLinks } from './gateway-status.ts';

applySavedLook();
autosizeTextareas();
import { icon, logo } from './icons.ts';
import { REPO } from '../shared/about.ts';
import { openProjectMenu, openLauncher } from './projects.tsx';
import { projectMark } from './projectlogo.ts';
import type { AboutInfo, AppState, EngineStatus, RunEvent, ServerEvent } from '../shared/types.ts';

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
  /** the sidebar folds to its icons, as on the Station (it opens when pointed at) */
  slimNav?: boolean;
  /** false: no "Ask the Brain" button at the bottom (Ctrl+K / ⌘K still opens the Brain chat) */
  brainButton?: boolean;
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

// The menu stays short. Other pages still open from links (branch editor, terminals, home).
const NAV: NavLink[] = [
  { path: 'station', label: 'Station', ico: 'orbit', view: station },
  { path: 'outbox', label: 'Outbox', ico: 'send', view: outboxView, count: () => (state.data?.outboxPending || 0) + (state.data?.questions?.length || 0) },
  { path: 'artifacts', label: 'Artifacts', ico: 'archive', view: artifactsView },
  { path: 'overview', label: 'Overview', ico: 'layout-grid', view: overviewView },
  { path: 'tasks', label: 'Tasks', ico: 'kanban', view: tasksView },
  // how many agents this project has
  { path: 'agents', label: 'Agents', ico: 'bot', view: agents, count: () => state.data?.agents?.length || 0 },
  { path: 'library', label: 'Agent Library', ico: 'library-big', view: library },
  { path: 'skills', label: 'Skills', ico: 'puzzle', view: skillsView },
  { path: 'routines', label: 'Routines', ico: 'repeat', view: routinesView },
  { path: 'settings', label: 'Settings', ico: 'settings', view: setup },
];
const HIDDEN: Route[] = [
  { path: 'home', label: 'Home', view: home },
  { path: 'workflows', label: 'Team editor', view: workflows },
  { path: 'programs', label: 'Programs', view: programs },
  { path: 'mcp', label: 'MCP servers', view: mcp },
  { path: 'connections', label: 'Connections', view: connections },
  { path: 'tools', label: 'Settings', view: setup },
  { path: 'terminals', label: 'Terminals', view: terminals },
];

// The page's box: padded, or flush to the edges (view.flush). Every page fades or rises in.
const VIEW_PADDED = 'mx-auto w-full max-w-[1400px] min-w-0 px-10 pt-9 pb-20 *:animate-rise-in max-md:px-4 max-md:pt-5 max-md:pb-14';
const VIEW_FLUSH = 'w-full min-w-0 *:animate-[fade_0.35s_ease-out]';

// The sidebar's links. On the Station and the Overview (body.nav-slim) the bar folds to its icons: on a wide screen it is
// clipped to the icon strip and its text fades in when it opens (body.nav-wide); on a narrow one a hovered
// icon shows its name beside it. Open, the links have the same padding as on every other page (the icons
// ease over from their place in the strip).
const NAV_LINK =
  'group flex items-center gap-3 rounded-ctl px-3 py-2 text-[14px] leading-[1.3] font-medium [transition:background-color_0.15s,color_0.15s] in-[.nav-slim]:relative max-md:in-[.nav-slim]:justify-center max-md:in-[.nav-slim]:px-0 max-md:in-[.nav-slim.nav-wide]:justify-start max-md:in-[.nav-slim.nav-wide]:px-3 md:in-[.nav-slim]:w-8.5 md:in-[.nav-slim]:justify-start md:in-[.nav-slim]:px-[6px] md:in-[.nav-slim.nav-wide]:w-auto md:in-[.nav-slim.nav-wide]:px-3 md:in-[.nav-slim]:[transition:background-color_0.15s,color_0.15s,padding_0.45s_cubic-bezier(.22,.9,.25,1)]';
const NAV_LINK_OFF = 'text-dim hover:bg-ink/5 hover:text-ink';
const NAV_LINK_ON = 'bg-ink/7 text-ink';
const NAV_ICO = 'grid w-5 flex-none place-items-center text-center in-[.nav-slim]:group-hover:text-accent';
const NAV_ICO_OFF = 'text-icon group-hover:text-ink';
const NAV_ICO_ON = 'text-accent';
// the menu's own labels read in capitals (the text stays as written, so lookups and screen readers are unmoved)
const NAV_TXT =
  'uppercase tracking-[0.025em] in-[.nav-slim]:[display:none] in-[.nav-slim]:group-hover:absolute in-[.nav-slim]:group-hover:left-[58px] in-[.nav-slim]:group-hover:z-90 in-[.nav-slim]:group-hover:block in-[.nav-slim]:group-hover:rounded-ctl in-[.nav-slim]:group-hover:border in-[.nav-slim]:group-hover:border-line in-[.nav-slim]:group-hover:bg-raise in-[.nav-slim]:group-hover:shadow-pop in-[.nav-slim]:group-hover:px-3 in-[.nav-slim]:group-hover:py-1.5 in-[.nav-slim]:group-hover:whitespace-nowrap in-[.nav-slim]:group-hover:text-ink in-[.nav-slim.nav-wide]:inline in-[.nav-slim.nav-wide]:group-hover:static in-[.nav-slim.nav-wide]:group-hover:border-0 in-[.nav-slim.nav-wide]:group-hover:bg-transparent in-[.nav-slim.nav-wide]:group-hover:p-0 in-[.nav-slim.nav-wide]:group-hover:shadow-none in-[.nav-slim.nav-wide]:group-hover:text-inherit md:in-[.nav-slim]:inline md:in-[.nav-slim]:whitespace-nowrap md:in-[.nav-slim]:opacity-0 md:in-[.nav-slim]:[transition:opacity_0.2s_ease] md:in-[.nav-slim]:group-hover:static md:in-[.nav-slim]:group-hover:border-0 md:in-[.nav-slim]:group-hover:bg-transparent md:in-[.nav-slim]:group-hover:p-0 md:in-[.nav-slim]:group-hover:text-inherit md:in-[.nav-slim.nav-wide]:opacity-100 md:in-[.nav-slim.nav-wide]:[transition:opacity_0.3s_ease_0.15s]';
const NAV_COUNT =
  'ml-auto in-[.nav-slim]:[display:none] in-[.nav-slim.nav-wide]:inline-grid md:in-[.nav-slim]:inline md:in-[.nav-slim]:whitespace-nowrap md:in-[.nav-slim]:opacity-0 md:in-[.nav-slim]:[transition:opacity_0.2s_ease] md:in-[.nav-slim.nav-wide]:inline-grid md:in-[.nav-slim.nav-wide]:opacity-100 md:in-[.nav-slim.nav-wide]:[transition:opacity_0.3s_ease_0.15s]';
// the status list's scrolling part: its top and bottom fade instead of cutting off
const NAV_LIST = 'nav-list flex min-h-0 min-w-0 flex-1 flex-col gap-px overflow-x-hidden overflow-y-auto pb-2 [mask-image:linear-gradient(to_bottom,transparent_0,#000_12px,#000_calc(100%-16px),transparent_100%)]';
// a line of the status list at the bottom left
const NS_LINE = 'group flex min-w-0 w-full items-center gap-2.5 rounded-ctl px-2 py-1 text-[12.5px] leading-5 text-dim no-underline [transition:background-color_0.15s,color_0.15s] hover:bg-ink/5 hover:text-ink focus-visible:outline-offset-[-2px]';

let viewEl = document.getElementById('view')!;
const titleEl = document.getElementById('page-title')!;
let current: { view: View; params: string[] } | null = null;

function renderNav() {
  const route = (location.hash.replace(/^#\/?/, '').split('/')[0] || 'station').split('?')[0];
  mount(
    document.getElementById('nav-links')!,
    NAV.map((n) => {
      const c = n.count?.();
      return h('a', { class: `${NAV_LINK} ${route === n.path ? NAV_LINK_ON : NAV_LINK_OFF}`, href: `#/${n.path}`, onclick: () => document.body.classList.remove('nav-open') }, h('span', { class: `${NAV_ICO} ${route === n.path ? NAV_ICO_ON : NAV_ICO_OFF}` }, icon(n.ico, 18)), h('span', { class: NAV_TXT }, n.label), c ? domBadge({ class: NAV_COUNT }, String(c)) : null);
    }),
  );
  const d = state.data;
  if (d) {
    // the status list, or (Status / Limits switch) your Claude and Codex usage limits
    // only the list scrolls, its ends fading out (like a chat's), and the switch stays under it
    mount(
      document.getElementById('nav-status')!,
      h('div', { class: NAV_LIST }, sidebarPanel() === 'limits' ? navLimits(renderNav) : navStatus(d)),
      panelSwitch(renderNav),
    );
  }
  // the version is asked for once (no GitHub call here: the star count is only fetched in Settings > About)
  if (!aboutAsked) {
    aboutAsked = true;
    void rpc.status.about({}).then((a) => ((about = a), renderNav()), () => {});
  }
  mount(document.getElementById('nav-about')!, navAbout());
}

let about: AboutInfo | null = null;
let aboutAsked = false;
// Bottom of the sidebar: the version (opens Settings > About) and a link to star Athena Agents on GitHub.
const NAV_VER = 'flex min-w-0 items-baseline gap-1.5 -ml-2 rounded-ctl px-2 py-1 font-sans text-[12.5px] leading-[1.3] font-medium text-dim [transition:background_0.15s,color_0.15s] hover:bg-ink/5 hover:text-ink';
const NAV_STAR = 'inline-flex h-7 flex-none items-center gap-1.5 rounded-ctl border border-line-2 bg-panel px-2.5 font-sans text-[12px] leading-none font-medium text-ink [transition:background-color_0.15s,border-color_0.15s] hover:bg-panel-2 [&_svg]:flex-none';
function navAbout() {
  return [
    h('a', { class: NAV_VER, href: '#/settings?tab=about', title: `About ${REPO.name}`, onclick: () => document.body.classList.remove('nav-open') }, h('span', 'About'), about ? h('span', { class: 'text-[11.5px] leading-[1.3] font-normal text-faint tabular-nums' }, `v${about.version}`) : null),
    h('a', { class: NAV_STAR, href: REPO.url, target: '_blank', rel: 'noopener', title: `${REPO.slug} on GitHub: star it there` }, logo('github', 13, 'currentColor'), h('span', 'Star')),
  ];
}

// The status list at the bottom left. Every line opens the matching setting.
function navStatus(d: AppState) {
  const e: Partial<EngineStatus> = d.engines;
  const S = (q: string) => `#/settings?${q}`;
  const ver = (v: string | null | undefined) => (v ? String(v).split(/\s/)[0] : '');
  const line = (dot: DotTone | '', label: string, value: string, href: string, title?: string) =>
    h('a', { class: NS_LINE, href, title: title || label, onclick: () => document.body.classList.remove('nav-open') }, domDot(dot, { class: 'size-1.5 [box-shadow:none]' }), h('span', { class: 'min-w-0 flex-1 truncate text-ink' }, label), value ? h('span', { class: 'max-w-[48%] min-w-0 truncate text-right text-[11.5px] text-faint tabular-nums', title: value }, value) : null);
  const cc: Partial<EngineStatus['claude-code']> = e['claude-code'] || {};
  const cx: Partial<EngineStatus['codex']> = e.codex || {};
  const b = d.settings?.brain || { provider: 'claude', model: 'haiku' };
  const brainName = String(b.model || 'haiku').replace(/^anthropic\/claude-/, '').replace(/^./, (c) => c.toUpperCase());
  const heading = 'mt-3 px-2 pb-1 text-[11px] leading-4 font-medium text-faint';
  const sv = d.projectSaved;
  const savedLine = sv ? (sv.error ? `not saved: ${sv.error}` : `auto-saved ${ago(sv.at)}`) : 'auto-save on';
  const footer = 'flex min-w-0 w-full items-start gap-2.5 rounded-ctl px-2 py-1.5 text-[11.5px] leading-4 text-faint hover:bg-ink/5 hover:text-ink focus-visible:outline-offset-[-2px]';
  const gatewayLinks = gatewayStatusLinks(d.gateways || []);
  return [
    h('div', { class: heading }, 'Engines'),
    line(cc.installed ? (cc.loggedIn ? 'on' : 'warn') : '', 'Claude Code', cc.installed ? (cc.loggedIn ? ver(cc.version) || 'ready' : 'not signed in') : 'not found', S('tab=general&find=Claude Code')),
    line(cx.installed ? (cx.loggedIn ? 'on' : 'warn') : '', 'Codex', cx.installed ? (cx.loggedIn ? ver(cx.version) || 'ready' : 'sign in') : 'not installed', S('tab=general&find=OpenAI Codex')),
    // the optional engines only show once they are installed (Settings still lists them with how to install)
    e.hermes?.installed ? line('on', 'Hermes', 'found', S('tab=general&find=Hermes')) : null,
    e.pi?.installed ? line('on', 'pi coding agent', ver(e.pi.version) || 'found', S('tab=general&find=pi coding agent')) : null,
    e.omp?.installed ? line('on', 'oh-my-pi', ver(e.omp.version) || 'found', S('tab=general&find=oh-my-pi')) : null,
    e.openclaw?.installed ? line('on', 'OpenClaw', ver(e.openclaw.version) || 'found', S('tab=general&find=OpenClaw')) : null,
    h('div', { class: heading }, 'Models and connections'),
    line('on', 'Brain', `${brainName}${b.provider === 'openrouter' ? ' · OR' : b.provider === 'venice' ? ' · Venice' : ''}`, S("tab=general&find=The Brain's model"), "The Brain's model"),
    line((d.mcpServers || []).length ? 'on' : '', 'MCP servers', String((d.mcpServers || []).length), S('tab=mcp&find=Your MCP servers')),
    d.outboxPending || d.questions?.length ? line('busy', 'Outbox', `${d.outboxPending + (d.questions?.length || 0)} waiting`, '#/outbox') : null,
    // (gateways are out of Settings for now: only ones already set up show here)
    gatewayLinks.length ? h('div', { class: heading }, 'Chat gateways') : null,
    ...gatewayLinks.map((gateway) => line(gateway.dot, gateway.label, gateway.value, gateway.href, gateway.title)),
    gatewayLinks.length && (d.gateways || []).length > gatewayLinks.length
      ? line('', 'All gateways', String(d.gateways.length), S('tab=gateways')) : null,
    h('div', { class: 'mt-2 border-t border-line pt-2' },
      h('a', { class: footer, href: S('tab=about&find=This PC'), title: `Agents, teams and chats are saved into the project folder (.dashboard) after every change.\n${d.project?.brainPath || ''}` },
        icon('folder-open', 13), h('span', { class: 'flex min-w-0 flex-1 flex-col gap-0.5' },
          h('span', { class: 'truncate text-dim' }, d.project?.name || 'Project'),
          h('span', { class: 'truncate', title: savedLine }, savedLine)))),
  ];
}

async function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('?')[0].split('/').filter(Boolean);
  const top = parts[0] || 'station';
  let view: View;
  const params = parts.slice(1);
  if (top === 'agents' && params[0] && params[1] !== 'edit') view = chat;
  else view = [...NAV, ...HIDDEN].find((n) => n.path === top)?.view || station;
  if (current?.view?.unmount) current.view.unmount();
  const here = (current = { view, params });
  // Each page gets its own element: one still loading when you leave draws into the old one, unseen.
  const el = (viewEl = freshElement(viewEl));
  el.className = view.flush ? VIEW_FLUSH : VIEW_PADDED;
  document.body.classList.toggle('station-mode', !!view.station);
  document.body.classList.toggle('nav-slim', !!(view.station || view.slimNav));
  document.body.classList.remove('nav-wide');
  // a full chat page has its own message box
  document.body.classList.toggle('in-chat', view === chat);
  document.body.classList.toggle('no-brain-button', view.brainButton === false);
  titleEl.textContent = view.title?.(params) || [...NAV, ...HIDDEN].find((n) => n.path === top)?.label || '';
  renderNav();
  try {
    await view.render(el, params, { setTitle: (t) => current === here && (titleEl.textContent = t) });
  } catch (e) {
    console.error(e);
    if (current === here) mount(el, h('div.panel', h('p', { class: 'text-red' }, `Something went wrong: ${(e as Error).message}`)));
  }
}

// ---------- Needs you ----------
const drawer = document.getElementById('drawer')!;
const drawerBody = document.getElementById('drawer-body')!;
let seenApprovals = new Set<string>();
let seenQuestions: Set<string> | null = null;
// Questions are React cards (choices to click, a box to answer): one place kept across redraws, so typing isn't lost.
let questionsHost: HTMLElement | null = null;
// Cards are kept while their approval is unchanged, so a typed note or edit survives other refreshes.
let drawnApprovals = '';
let approvalCards = new Map<string, { key: string; el: HTMLElement }>();

function renderApprovals() {
  const list = state.data?.approvals || [];
  const asked = state.data?.questions || [];
  const n = list.length + (state.data?.outboxPending || 0) + asked.length;
  const count = document.getElementById('needs-count')!;
  count.textContent = String(n);
  count.className = badgeClass(n > 0);
  const drawn = JSON.stringify([list, state.data?.outboxPending || 0, asked.map((q) => q.id)]);
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
  const toOutbox = () => (navigate('#/outbox'), drawer.classList.add('hidden'));
  if (asked.length) {
    if (!questionsHost) {
      questionsHost = h('div', { class: 'flex flex-col gap-3' });
      mountDrawerQuestions(questionsHost);
    }
    drawerBody.append(questionsHost);
  }
  if (state.data?.outboxPending) {
    drawerBody.append(
      h('div.approval', h('div.t', `${state.data.outboxPending} post${state.data.outboxPending > 1 ? 's' : ''} waiting in the Outbox`), domButton({ size: 'small', onclick: toOutbox }, 'Review posts')),
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
  // a new question from an agent: say so (not for the ones already there when the page opened)
  const newQ = seenQuestions ? asked.filter((q) => !seenQuestions!.has(q.id)) : [];
  if (newQ.length && !fresh.length) {
    if (!location.hash.startsWith('#/outbox')) drawer.classList.remove('hidden');
    toast(`${newQ[0].agentName || 'An agent'} asks: ${newQ[0].question}`, 'warn');
  }
  seenQuestions = new Set(asked.map((q) => q.id));
}

function renderRunning() {
  const pill = document.getElementById('running-pill')!;
  const runs = state.data?.runs || [];
  pill.classList.toggle('hidden', !runs.length);
  mount(pill, domDot('busy'), runs.length === 1 ? `${runs[0].agentName} working` : `${runs.length} agents working`);
  pill.className = pillClass('warn', runs.length ? '' : 'hidden');
}

// the controls that live in public/index.html: they keep their names there, and get their look here
const needsBtn = document.getElementById('needs-btn')!;
needsBtn.className = buttonClass('ghost', 'small');
document.getElementById('drawer-close')!.className = iconButtonClass();
document.getElementById('nav-toggle')!.className = iconButtonClass('default', 'md:hidden');
document.getElementById('needs-count')!.className = badgeClass();
needsBtn.onclick = () => drawer.classList.toggle('hidden');
// project switcher in the top bar (pages other than the Station)
const projBtn = domButton({ variant: 'ghost', size: 'small', class: 'gap-1.5 [&_.proj-logo]:mr-0.5', onclick: (e) => openProjectMenu(e.currentTarget) });
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
// the usage limits count down, and are read again now and then while they're shown
setInterval(() => sidebarPanel() === 'limits' && !document.hidden && renderNav(), 20_000);

const STATE_EVENTS = new Set(['agents', 'approvals', 'outbox', 'questions', 'runs', 'settings', 'accounts', 'terminals', 'mcp', 'project', 'project-logo', 'projects', 'engines', 'gateways', 'gateway-health', 'gateway-inbox']);
onEvent((ev) => {
  if (STATE_EVENTS.has(ev.type)) refreshSoon();
  if (ev.type === 'toast') toast(ev.text as string);
  if (ev.type === 'world-look') void station.answerLook(ev);
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
// themselves). With nothing open it goes back to the Station, and there it opens the big sidebar
// instead, and Esc again closes it. See backdropEscape for the order.
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
    switch (backdropEscape(document)) {
      case 'phone-menu':
        return body.classList.remove('nav-open');
      case 'close-sidebar':
        return body.classList.remove('nav-wide');
      case 'open-sidebar':
        return body.classList.add('nav-wide');
      // a page: back to the Station
      case 'station':
        return navigate('#/station');
      default:
        return;
    }
  }, 0);
});
// Station: the sidebar is a thin icon bar; hovering it opens it to full width, leaving folds it back.
{
  const edge = document.createElement('div');
  edge.id = 'nav-edge';
  edge.className = 'md:hidden';
  edge.title = 'Menu';
  document.body.append(edge);
  const nav = document.getElementById('nav')!;
  let byHover = false;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  const open = () => {
    clearTimeout(closeTimer);
    if (!document.body.classList.contains('nav-wide')) {
      byHover = true;
      document.body.classList.add('nav-wide');
    }
  };
  edge.addEventListener('mouseenter', open);
  // hovering the icon bar opens it (only where it is folded)
  nav.addEventListener('mouseenter', () => {
    clearTimeout(closeTimer);
    if (document.body.classList.contains('nav-slim')) open();
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
