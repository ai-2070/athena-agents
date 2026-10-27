// The sidebar's usage view, in place of the status list (the Status / Limits switch above it, or Settings > Look):
// how much of your Claude and Codex plans is used, when each limit starts again, and Codex's free limit resets.
import { h, GET, POST, PUT, state, confirmBox, toast } from './core.ts';
import { DEFAULT_LOOK, applyLook, currentLook } from './look.ts';
import { logo } from './icons.ts';
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
}

export const sidebarPanel = (): SidebarPanel => state.data?.settings?.look?.sidebar || currentLook().sidebar || 'status';

/** Switches what the sidebar shows, here and in Settings > Look. */
export function setSidebarPanel(p: SidebarPanel, redraw: () => void): void {
  const look = { ...DEFAULT_LOOK, ...currentLook(), ...(state.data?.settings?.look || {}), sidebar: p };
  if (state.data?.settings) state.data.settings.look = look;
  applyLook(look);
  redraw();
  void PUT('/settings', { look: { sidebar: p } }).catch((e: unknown) => toast((e as Error).message, 'error'));
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

const ROW = '-mx-1.5 flex items-center gap-1.75 rounded-[6px] px-1.5 py-0.75 text-[11.5px] text-dim no-underline [transition:background_0.15s,color_0.15s] hover:bg-accent/12 hover:text-ink';
const close = () => document.body.classList.remove('nav-open');

function head(name: string, brand: string, color: string | undefined, p: ProviderLimits, href: string, right: string) {
  const dot = !p.ready ? (p.why === 'not signed in' ? 'warn' : '') : p.blocked ? 'warn' : 'on';
  return h(
    'a',
    { class: ROW, href, title: p.ready ? `${name} plan limits` : `${name}: ${p.why}`, onclick: close },
    h('span', { class: `dot ${dot}` }),
    h('span', { class: 'flex min-w-0 flex-1 items-center gap-1.5 truncate' }, logo(brand, 11, color), h('span', { class: 'truncate' }, name)),
    right ? h('span', { class: 'text-[10.5px] whitespace-nowrap text-faint' }, right) : null,
  );
}

function meter(w: LimitWindow) {
  const hot = w.percent >= 90 ? 'bg-red' : w.percent >= 75 ? 'bg-amber' : 'bg-accent';
  return h(
    'div',
    { class: 'limit-row flex items-center gap-1.5 py-0.5 pl-3.5 text-[10.5px] text-dim', title: w.resetsAt ? `${w.label}: ${w.percent}% used · starts again ${when(w.resetsAt)}` : `${w.label}: ${w.percent}% used` },
    h('span', { class: 'w-7.5 flex-none text-faint' }, w.label),
    h('span', { class: 'relative h-1 min-w-4 flex-1 overflow-hidden rounded-full bg-line-2' }, h('i', { class: `absolute inset-y-0 left-0 rounded-full ${hot}`, style: { width: `${w.percent}%` } })),
    h('b', { class: 'w-8 flex-none text-right font-medium text-ink tabular-nums' }, `${w.percent}%`),
    h('span', { class: 'w-11 flex-none text-right text-faint tabular-nums' }, w.resetsAt ? timeUntil(w.resetsAt) : ''),
  );
}

function windowsOf(p: ProviderLimits) {
  if (!p.ready) return [];
  if (!p.windows.length) return [h('div', { class: 'py-0.5 pl-3.5 text-[10.5px] text-faint' }, failed ? "couldn't read the limits" : limits ? 'no numbers yet' : 'reading…')];
  return p.windows.map(meter);
}

async function useReset(redraw: () => void): Promise<void> {
  const r = limits?.codex.resets;
  if (!r || resetting) return;
  const next = r.credits[0];
  const used = Math.max(0, ...(limits?.codex.windows || []).map((w) => w.percent));
  const ok = await confirmBox(
    h(
      'div',
      { class: 'flex flex-col gap-2' },
      h('p', { class: 'm-0' }, 'Use a free Codex limit reset now? Your Codex usage limits start again from 0%.'),
      h('p', { class: 'hint m-0' }, `You have ${r.available}.${next?.expiresAt ? ` This one runs out in ${timeUntil(next.expiresAt)} if you don't use it.` : ''}`),
      used < 50 ? h('p', { class: 'hint m-0' }, `You have only used ${used}% so far, so you may want to keep it for later.`) : null,
    ),
    { ok: 'Reset now' },
  );
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

function resetsOf(redraw: () => void) {
  const r = limits?.codex.resets;
  if (!limits?.codex.ready || !r || !r.available) return [];
  const next = r.credits[0];
  return [
    h(
      'div',
      { class: 'codex-resets mt-1 ml-3.5 flex flex-col gap-0.5 rounded-[6px] border border-line px-2 py-1.5' },
      h('span', { class: 'font-sans text-[11px] font-semibold text-ink' }, `${r.available} rate-limit reset${r.available === 1 ? '' : 's'} available`),
      next?.expiresAt ? h('span', { class: 'text-[10.5px] text-faint', title: `Runs out ${when(next.expiresAt)}` }, `Next expires in ${timeUntil(next.expiresAt)}`) : null,
      h('button', { class: 'btn ghost tiny mt-1 self-start', disabled: resetting, onclick: () => void useReset(redraw) }, resetting ? 'Resetting…' : 'Reset now'),
    ),
  ];
}

/** The usage view's lines. redraw: draw the sidebar again (after a read or a reset). */
export function navLimits(redraw: () => void): HTMLElement[] {
  load(redraw);
  const S = (q: string) => `#/settings?${q}`;
  const cc: ProviderLimits = limits?.claude || { ready: !!state.data?.engines?.['claude-code']?.installed, windows: [] };
  const cx = limits?.codex || { ready: !!state.data?.engines?.codex?.loggedIn, windows: [], resets: null };
  const plan = (p: string | null | undefined) => (p ? p.replace(/lite$/i, ' lite').replace(/^./, (c) => c.toUpperCase()) : '');
  return [
    head('Claude', 'claude', undefined, cc, S('tab=general&find=Claude Code'), cc.ready ? '' : cc.why || ''),
    ...windowsOf(cc),
    h('div', { class: 'h-1.5' }),
    head('Codex', 'openai', '#e6e8e0', cx, S('tab=general&find=OpenAI Codex'), cx.ready ? (cx.blocked ? 'limit reached' : plan(cx.plan)) : cx.why || ''),
    ...windowsOf(cx),
    ...resetsOf(redraw),
  ];
}

/** The Status / Limits switch at the top of the sidebar's list. */
export function panelSwitch(redraw: () => void): HTMLElement {
  const now = sidebarPanel();
  const tab = (p: SidebarPanel, label: string, title: string) =>
    h('button', { type: 'button', class: `sidebar-panel-tab cursor-pointer border-0 bg-transparent p-0 font-mono text-[9.5px] tracking-[0.14em] uppercase ${now === p ? 'on text-accent' : 'text-faint hover:text-ink'}`, title, 'aria-pressed': String(now === p), onclick: () => now !== p && setSidebarPanel(p, redraw) }, label);
  return h('div', { class: 'mb-1 flex items-center gap-3' }, tab('status', 'Status', "What's set up"), tab('limits', 'Limits', 'How much of your Claude and Codex plans is used'));
}
