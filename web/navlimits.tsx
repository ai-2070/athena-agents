// The sidebar's usage view, in place of the status list (the Status / Limits switch below it, or Settings > Appearance):
// how much of your Claude and Codex plans is used, when each limit starts again, and Codex's free limit resets.
// Rendered with React (createRoot) into the element app.ts mounts; the view's lines and the Codex reset card are components.
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { GET, POST, PUT, state, toast } from './core.ts';
import { Dot } from './ui/marks.tsx';
import { Button } from './ui/button.tsx';
import { DomNode } from './ui/react.tsx';
import { openModal } from './ui/overlays.tsx';
import type { DotTone } from './ui/classes.ts';
import { DEFAULT_LOOK, applyLook, currentLook, uiZoom } from './look.ts';
import { logo } from './icons.ts';
import { EASE, flipFrom, reducedMotion, slideOut } from './motion.ts';
import type { CodexResetResult, LimitWindow, ProviderLimits, SidebarPanel, UsageLimits } from '../shared/types.ts';

// what the server last said; read again when it's a minute old and the view is drawn
let limits: UsageLimits | null = null;
let loadedAt = 0;
let loading = false;
let failed = false;
let resetting = false;
// sooner while a plan isn't ready: right after the server starts it is still finding out who's signed in
const stale = () => (limits && limits.claude.ready && limits.codex.ready ? 55_000 : 15_000);

/** For tests: forget what was read. */
export function resetLimitsCache(): void {
  limits = null;
  loadedAt = 0;
  loading = false;
  failed = false;
  resetting = false;
  hidePop();
}

// each project remembers what it last showed; one that never switched follows Settings > Appearance
export const sidebarPanel = (): SidebarPanel => state.data?.project?.sidebar || state.data?.settings?.look?.sidebar || currentLook().sidebar || 'status';

/** Remembers the choice for the open project too (here now, on the server in the background). */
export function rememberSidebarPanel(p: SidebarPanel): void {
  const proj = state.data?.project;
  if (!proj) return;
  proj.sidebar = p;
  const listed = state.data?.projects?.find((x) => x.id === proj.id);
  if (listed && listed !== proj) listed.sidebar = p;
  void PUT(`/projects/${encodeURIComponent(proj.id)}`, { sidebar: p }).catch((e: unknown) => toast((e as Error).message, 'error'));
}

// Switching Status / Limits: the old lines slide out toward where they sit (Status on the left, Limits on the
// right), the new ones slide in from the other side one after another, and the selected plate glides over.
// Only on a switch: the sidebar is drawn again often, and that must not replay it.
let switching = false;
const PANEL = 'contents';
// the lines sit directly in nav-status (the status list) or inside the display:contents box navLimits returns,
// which lays them out as if they were there themselves
const lines = (host: Element | null): HTMLElement[] => {
  if (!host) return [];
  return [...host.children]
    .flatMap((el) => (el.classList.contains(PANEL) ? [...el.children] : [el]))
    .filter((el): el is HTMLElement => el instanceof HTMLElement && !el.classList.contains('sidebar-panel-switch'));
};

/** Switches what the sidebar shows, here and in Settings > Appearance. */
export function setSidebarPanel(p: SidebarPanel, redraw: () => void): void {
  if (switching) return;
  const host = document.getElementById('nav-status');
  const dir = p === 'limits' ? 1 : -1;
  const mark = host?.querySelector('.sidebar-panel-mark')?.getBoundingClientRect();
  const swap = () => {
    switching = false;
    const look = { ...DEFAULT_LOOK, ...currentLook(), ...(state.data?.settings?.look || {}), sidebar: p };
    if (state.data?.settings) state.data.settings.look = look;
    applyLook(look);
    rememberSidebarPanel(p);
    redraw();
    // also the default for projects that haven't picked one yet
    void PUT('/settings', { look: { sidebar: p } }).catch((e: unknown) => toast((e as Error).message, 'error'));
    if (reducedMotion() || typeof document.body.animate !== 'function') return;
    const now = host?.querySelector<HTMLElement>('.sidebar-panel-mark');
    if (now && mark?.width) flipFrom(now, mark, { duration: 260 });
    lines(host).forEach((el, i) => el.animate([{ opacity: 0, transform: `translateX(${dir * 12}px)` }, { opacity: 1, transform: 'none' }], { duration: 260, delay: Math.min(i, 10) * 22, easing: EASE, fill: 'backwards' }));
  };
  const old = lines(host);
  if (!old.length || reducedMotion() || typeof old[0].animate !== 'function') return swap();
  switching = true;
  // (swaps on time even if an animation never reports back)
  void Promise.race([Promise.all(old.map((el) => slideOut(el, { x: -dir * 8, duration: 110 }))), new Promise((r) => setTimeout(r, 160))]).then(swap);
}

/** "2d 13h", "4h 10m", "12m" until the given time (ms). */
export function timeUntil(at: number, now = Date.now()): string {
  const mins = Math.max(1, Math.round((at - now) / 60_000));
  const d = Math.floor(mins / 1440);
  const hr = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d) return `${d}d ${hr}h`;
  if (hr) return `${hr}h ${m}m`;
  return `${m}m`;
}

const when = (at: number) => new Date(at).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });

function load(redraw: () => void): void {
  if (loading || Date.now() - loadedAt < stale()) return;
  loading = true;
  GET<UsageLimits>('/usage-limits').then(
    (l) => ((limits = l), (failed = false)),
    () => (failed = true),
  ).finally(() => {
    loading = false;
    loadedAt = Date.now();
    redraw();
  });
}

const ROW = 'group flex min-w-0 w-full items-center gap-2.5 rounded-ctl px-2 py-1 text-[12.5px] leading-5 text-dim no-underline [transition:background-color_0.15s,color_0.15s] hover:bg-ink/5 hover:text-ink focus-visible:outline-offset-[-2px]';
const close = () => document.body.classList.remove('nav-open');

function ProviderHead({ name, brand, color, p, href, right }: { name: string; brand: string; color: string | undefined; p: ProviderLimits; href: string; right: string }) {
  const dot: DotTone | '' = !p.ready ? (p.why === 'not signed in' ? 'warn' : '') : p.blocked ? 'warn' : 'on';
  return (
    <a className={ROW} href={href} title={p.ready ? `${name} plan limits` : `${name}: ${p.why}`} onClick={close}>
      <Dot tone={dot} className="size-1.5 [box-shadow:none]" />
      <span className="flex min-w-0 flex-1 items-center gap-1.5 text-ink"><DomNode as="span" className="contents" make={() => logo(brand, 12, color)} deps={[brand, color]} /><span className="min-w-0 truncate">{name}</span></span>
      {right ? <span className="max-w-[48%] min-w-0 truncate text-right text-[11.5px] text-faint" title={right}>{right}</span> : null}
    </a>
  );
}

function Meter({ w }: { w: LimitWindow }) {
  const hot = w.percent >= 90 ? 'bg-red' : w.percent >= 75 ? 'bg-amber' : 'bg-accent';
  return (
    <div className="limit-row flex items-center gap-2 py-1 pl-4 text-[11.5px] text-dim" title={w.resetsAt ? `${w.label}: ${w.percent}% used · starts again ${when(w.resetsAt)}` : `${w.label}: ${w.percent}% used`}>
      <span className="w-8 flex-none text-faint">{w.label}</span>
      <span className="relative h-1 min-w-4 flex-1 overflow-hidden rounded-full bg-ink/10"><i className={`absolute inset-y-0 left-0 rounded-full ${hot}`} style={{ width: `${w.percent}%` }} /></span>
      <b className="w-9 flex-none text-right font-medium text-ink tabular-nums">{`${w.percent}%`}</b>
      <span className="w-11 flex-none text-right text-faint tabular-nums">{w.resetsAt ? timeUntil(w.resetsAt) : ''}</span>
    </div>
  );
}

function Windows({ p }: { p: ProviderLimits }) {
  if (!p.ready) return null;
  if (!p.windows.length) return <div className="py-1 pl-4 text-[11.5px] text-faint">{failed ? "couldn't read the limits" : limits ? 'no numbers yet' : 'reading…'}</div>;
  return <>{p.windows.map((w, i) => <Meter key={i} w={w} />)}</>;
}

function LimitsView({ redraw }: { redraw: () => void }) {
  const S = (q: string) => `#/settings?${q}`;
  const cc: ProviderLimits = limits?.claude || { ready: !!state.data?.engines?.['claude-code']?.installed, windows: [] };
  const cx: ProviderLimits = limits?.codex || { ready: !!state.data?.engines?.codex?.loggedIn, windows: [] };
  const plan = (p: string | null | undefined) => (p ? p.replace(/lite$/i, ' lite').replace(/^./, (c) => c.toUpperCase()) : '');
  // a native mouseenter/focusin (React's onMouseEnter only comes from mouseover), so the reset card still opens
  let own: HTMLDivElement | null = null;
  const codexRef = (el: HTMLDivElement | null) => {
    if (el) {
      own = el;
      codexEl = el;
      el.addEventListener('mouseenter', () => showPop(el, redraw));
      el.addEventListener('focusin', () => showPop(el, redraw));
    } else if (codexEl === own) codexEl = null;
  };
  return (
    <>
      <ProviderHead name="Claude" brand="claude" color={undefined} p={cc} href={S('tab=general&find=Claude Code')} right={cc.ready ? '' : cc.why || ''} />
      <Windows p={cc} />
      <div className="h-2" />
      <div className="codex-limits flex flex-col" ref={codexRef}>
        <ProviderHead name="Codex" brand="openai" color="currentColor" p={cx} href={S('tab=general&find=OpenAI Codex')} right={cx.ready ? (cx.blocked ? 'limit reached' : plan(cx.plan)) : cx.why || ''} />
        <Windows p={cx} />
      </div>
    </>
  );
}

// asks before spending a free reset; resolves true when the user picks Reset now
function askReset(available: number, expiresAt: number | null, used: number): Promise<boolean> {
  return new Promise((resolve) => {
    openModal('Are you sure?', (close) => (
      <>
        <div className="modal-body text-[14px] leading-[1.65] text-ink [&_p]:mb-3 [&_p:last-child]:mb-0">
          <div className="flex flex-col gap-2">
            <p className="m-0">Use a free Codex limit reset now? Your Codex usage limits start again from 0%.</p>
            <p className="hint m-0">{`You have ${available}.${expiresAt ? ` This one runs out in ${timeUntil(expiresAt)} if you don't use it.` : ''}`}</p>
            {used < 50 ? <p className="hint m-0">{`You have only used ${used}% so far, so you may want to keep it for later.`}</p> : null}
          </div>
        </div>
        <div className="modal-foot">
          <Button variant="ghost" onClick={() => { resolve(false); close(); }}>Cancel</Button>
          <Button variant="primary" onClick={() => { resolve(true); close(); }}>Reset now</Button>
        </div>
      </>
    ), { narrow: true, onClose: () => resolve(false) });
  });
}

async function useReset(redraw: () => void): Promise<void> {
  const r = limits?.codex.resets;
  if (!r || resetting) return;
  const next = r.credits[0];
  const used = Math.max(0, ...(limits?.codex.windows || []).map((w) => w.percent));
  const ok = await askReset(r.available, next?.expiresAt ?? null, used);
  if (!ok) return;
  resetting = true;
  redraw();
  try {
    const res = await POST<CodexResetResult>('/codex/reset', { creditId: next?.id || null });
    limits = res.limits;
    loadedAt = Date.now();
    const left = res.limits.codex.resets?.available ?? 0;
    const say: Record<CodexResetResult['outcome'], string> = {
      reset: `Codex limits reset. ${left === 1 ? '1 free reset' : `${left} free resets`} left.`,
      nothingToReset: 'Nothing to reset yet: your Codex limits are unused. The reset was kept.',
      noCredit: 'No free Codex resets left.',
      alreadyRedeemed: 'That reset was already used.',
    };
    toast(say[res.outcome], res.outcome === 'reset' ? 'info' : 'warn');
  } catch (e) {
    toast((e as Error).message, 'error');
  } finally {
    resetting = false;
    redraw();
  }
}

// Codex's free resets: a card beside the sidebar while you point at Codex (signed in, with resets to use).
// It lives in <body>, so the sidebar redrawing under it (every state change) doesn't close it.
let pop: HTMLElement | null = null;
let popRoot: Root | null = null;
let anchor: HTMLElement | null = null;
// the codex row of the drawn panel (the card is placed beside it)
let codexEl: HTMLElement | null = null;
let hideTimer: ReturnType<typeof setTimeout> | undefined;
// (above the sidebar, which is z-80 on the Station)
const POP = 'codex-resets glass fixed z-[85] flex w-60 flex-col gap-1 rounded-box px-4 py-3.5 animate-[fade_0.15s_ease-out]';

const hasResets = () => !!(limits?.codex.ready && limits.codex.resets?.available);

function hidePop(): void {
  clearTimeout(hideTimer);
  document.removeEventListener('pointermove', watchPointer);
  const el = pop;
  const root = popRoot;
  pop = null;
  popRoot = null;
  el?.remove();
  // unmount after detaching so React doesn't paint into a removed node
  if (root) queueMicrotask(() => root.unmount());
}

// closes the card once the pointer is off both Codex's rows and the card
function watchPointer(e: PointerEvent): void {
  const t = e.target instanceof Element ? e.target : null;
  if (t?.closest('.codex-limits, .codex-resets')) clearTimeout(hideTimer);
  else if (pop) {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hidePop, 200);
  }
}

function ResetCard({ redraw }: { redraw: () => void }) {
  const r = limits?.codex.resets;
  const next = r?.credits[0];
  if (!r) return null;
  return (
    <>
      <span className="text-[13px] font-semibold text-ink">{`${r.available} rate-limit reset${r.available === 1 ? '' : 's'} available`}</span>
      {next?.expiresAt ? <span className="text-[12px] text-faint" title={`Runs out ${when(next.expiresAt)}`}>{`Next expires in ${timeUntil(next.expiresAt)}`}</span> : null}
      <Button variant="ghost" size="tiny" className="mt-1.5 self-start" disabled={resetting} onClick={() => void useReset(redraw)}>{resetting ? 'Resetting…' : 'Reset now'}</Button>
    </>
  );
}

function renderPop(redraw: () => void): void {
  if (!pop || !popRoot || !anchor) return;
  const r = limits?.codex.resets;
  if (!hasResets() || !r || !anchor.isConnected) return hidePop();
  flushSync(() => popRoot!.render(<ResetCard redraw={redraw} />));
  // beside the sidebar, level with Codex, kept on screen (the sidebar is as tall as the window)
  const a = anchor.getBoundingClientRect();
  const nav = anchor.closest('aside')?.getBoundingClientRect() ?? a;
  const tall = pop.getBoundingClientRect().height;
  placeFixed(pop, nav.right + 8, Math.max(nav.top + 8, Math.min(a.top, nav.bottom - tall - 8)));
}

// Puts a fixed element's top left corner at x, y as getBoundingClientRect measures. With the UI scale
// (zoom on <html>) browsers differ in whether rects and left/top are in screen or page pixels, so this
// places it once and measures how the two compare instead of assuming.
export function placeFixed(el: HTMLElement, x: number, y: number): void {
  const z = uiZoom();
  el.style.left = `${x / z}px`;
  el.style.top = `${y / z}px`;
  const r = el.getBoundingClientRect();
  const kx = x > 0 && r.left > 0 ? r.left / (x / z) : z;
  const ky = y > 0 && r.top > 0 ? r.top / (y / z) : z;
  if (Math.abs(r.left - x) > 0.5) el.style.left = `${x / kx}px`;
  if (Math.abs(r.top - y) > 0.5) el.style.top = `${y / ky}px`;
}

function showPop(el: HTMLElement, redraw: () => void): void {
  clearTimeout(hideTimer);
  anchor = el;
  if (!hasResets()) return;
  if (!pop) {
    const host = document.createElement('div');
    host.className = POP;
    host.setAttribute('role', 'dialog');
    host.setAttribute('aria-label', 'Codex limit resets');
    document.body.append(host);
    pop = host;
    popRoot = createRoot(host);
    document.addEventListener('pointermove', watchPointer);
  }
  renderPop(redraw);
}

let panelRoot: Root | null = null;

/** The usage view's lines. redraw: draw the sidebar again (after a read or a reset). */
export function navLimits(redraw: () => void): HTMLElement[] {
  load(redraw);
  // a display:contents box, so its lines lay out in nav-status as if they were its own children
  const host = document.createElement('div');
  host.className = PANEL;
  // drop the panel the caller replaced before drawing the new one (its refs would clear the new element's)
  panelRoot?.unmount();
  panelRoot = createRoot(host);
  flushSync(() => panelRoot!.render(<LimitsView redraw={redraw} />));
  // the sidebar was drawn again under an open card: keep it next to the new rows
  if (pop) {
    anchor = codexEl;
    queueMicrotask(() => renderPop(redraw));
  }
  return [host];
}

const SWITCH = 'sidebar-panel-switch sticky bottom-0 z-10 mt-2 flex gap-0.5 rounded-[10px] border border-line bg-side p-1';
let switchRoot: Root | null = null;

/** The Status / Limits switch at the bottom of the sidebar's list. */
export function panelSwitch(redraw: () => void): HTMLElement {
  const host = document.createElement('div');
  host.className = SWITCH;
  switchRoot?.unmount();
  switchRoot = createRoot(host);
  flushSync(() => switchRoot!.render(<PanelTabs redraw={redraw} />));
  return host;
}

function PanelTabs({ redraw }: { redraw: () => void }) {
  const now = sidebarPanel();
  const tab = (p: SidebarPanel, label: string, title: string) => (
    <button type="button" className={`sidebar-panel-tab relative flex-1 cursor-pointer rounded-[7px] border-0 bg-transparent px-2 py-1.5 text-[12px] leading-4 font-medium transition-colors duration-150 ${now === p ? 'on text-ink' : 'text-faint hover:text-ink'}`} title={title} aria-pressed={now === p} onClick={() => now !== p && setSidebarPanel(p, redraw)}>
      <span className="relative z-1">{label}</span>
      {/* the selected plate glides to the other tab on a switch */}
      {now === p ? <span className="sidebar-panel-mark pointer-events-none absolute inset-0 rounded-[7px] border border-line-2 bg-panel-2 shadow-[inset_0_1px_0_var(--glass-spec)]" aria-hidden="true" /> : null}
    </button>
  );
  return (
    <>
      {tab('status', 'Status', "What's set up")}
      {tab('limits', 'Limits', 'How much of your Claude and Codex plans is used')}
    </>
  );
}
