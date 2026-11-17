// The scene look in the Station (docs/internal/plans/HTML_SCENE_PLAN.md §3, §8): the project's scene in a sandboxed
// iframe, fed the Station's state, and kept from ever showing a broken version in place of one that works.
//
// The iframe always shows a kept version of the scene (or the starter), never the live folder. A new version is
// loaded in a second, hidden iframe; it takes the place of the shown one when it says `ready`, and goes back out if
// it throws in its first 5 seconds. Each tab tells the server how versions loaded, so every tab (and the builders,
// through scene_check) know which ones work.
import { h } from '../core.ts';
import { rpc } from '../client/rpc.ts';
import { domButton, domDot } from '../ui/dom.ts';
import { modal, toast } from '../core.ts';
import { accentFor, accentTone, currentLook } from '../look.ts';
import { isDark, onThemeChange } from '../theme.ts';
import { readSceneMessage, SCENE_PROTOCOL } from '../../shared/scene.ts';
import type {
  FromScene,
  SceneEvent,
  ScenePickKind,
  SceneQuality,
  SceneState,
  SceneTheme,
  ToScene,
} from '../../shared/scene.ts';
import type {
  ActiveRun,
  Agent,
  AgentQuestion,
  Approval,
  SceneVersion,
  SceneVersions,
  TeamListing,
} from '../../shared/types.ts';

/** How long a scene has to say `ready`, and how long after that an uncaught error still means it doesn't load. */
export const READY_MS = 10_000;
export const SETTLE_MS = 5_000;
/** No frame rate from the shown scene for this long (while it is visible): it froze the tab. */
export const FREEZE_MS = 15_000;
const FREEZE_EVERY_MS = 5000;

/** What one tick of the freeze check finds. `late`: the tick itself came late (the PC slept, a debugger or a long
 *  stall held the page), so frames missed meanwhile say nothing about the scene and the wait starts over. `frozen`:
 *  the page ran on time but the scene sent no frame rate for FREEZE_MS. */
export function freezeCheck(now: number, lastTick: number, lastFps: number): 'late' | 'frozen' | 'fine' {
  if (now - lastTick > FREEZE_EVERY_MS * 2) return 'late';
  return now - lastFps > FREEZE_MS ? 'frozen' : 'fine';
}
const STATE_EVERY_MS = 250;
const QUALITY: SceneQuality[] = ['low', 'medium', 'high'];
const LOGS_KEPT = 200;

// ---------- the state a scene is sent ----------
export interface SceneSource {
  project: { id: string; name: string };
  agents: Agent[];
  teams: TeamListing[];
  teamState: Record<string, { working?: string[]; queued?: string[] } | undefined>;
  approvals: Approval[];
  questions: AgentQuestion[];
  runs: ActiveRun[];
  /** a Brain turn is going on in this project (runs leaves the Brain's own turns out) */
  brainThinking: boolean;
  /** what the map says an agent is doing */
  now: (agentId: string) => string;
  /** a colour for a team without one */
  teamColor: (index: number) => string;
}

const BRAIN = 'brain';
const HEX = /^#[0-9a-f]{6}$/i;

/** What the Station shows, as a scene gets it: no chat text, no files, nothing the map doesn't show. */
export function sceneStateFrom(src: SceneSource): SceneState {
  const needs = (id: string) =>
    src.approvals.some((a) => a.agentId === id) || src.questions.some((q) => q.agentId === id);
  const working = (id: string) => src.runs.some((r) => r.agentId === id);
  const teams = src.teams.map((t, i) => ({
    id: t.id,
    name: t.name,
    color: HEX.test(t.color || '') ? t.color! : src.teamColor(i),
    ...(t.mark ? { emoji: t.mark } : {}),
    members: [...(t.members || [])],
    ...(t.lead ? { lead: t.lead } : {}),
    working: [...(src.teamState[t.id]?.working || [])],
    queued: [...(src.teamState[t.id]?.queued || [])],
  }));
  const agents = src.agents
    .filter((a) => a.id !== BRAIN)
    .map((a) => ({
      id: a.id,
      name: a.name,
      emoji: a.emoji || '🤖',
      color: HEX.test(a.color || '') ? a.color : '#888888',
      engine: String(a.engine || ''),
      status: needs(a.id) ? ('needs' as const) : working(a.id) ? ('working' as const) : ('idle' as const),
      now: (needs(a.id) ? 'Waiting for your OK' : working(a.id) ? src.now(a.id) || 'Thinking…' : '').slice(0, 120),
      teams: teams.filter((t) => t.members.includes(a.id)).map((t) => t.id),
    }));
  return {
    project: { id: src.project.id, name: src.project.name },
    brain: { name: 'Brain', status: needs(BRAIN) ? 'needs' : src.brainThinking ? 'thinking' : 'idle' },
    teams,
    agents,
    needsYou: src.approvals.length + src.questions.length,
  };
}

// ---------- which version to show ----------
export type ShowChoice = { version: string | 'starter'; bar: 'none' | 'broken' | 'never-loaded' | 'forced' };

/** What the Station should show: the newest version unless it doesn't load, then the newest one that does (or the
 *  starter). `forced`: the user asked to see that version anyway. */
export function chooseVersion(o: SceneVersions, forced: string | null = null): ShowChoice {
  const newest = o.versions[0];
  if (!o.present || !newest) return { version: 'starter', bar: 'none' };
  if (forced && forced === newest.id) return { version: forced, bar: 'forced' };
  if (newest.loads !== 'broken') return { version: newest.id, bar: 'none' };
  return o.newestGood ? { version: o.newestGood, bar: 'broken' } : { version: 'starter', bar: 'never-loaded' };
}

// ---------- the host ----------
export interface SceneLogLine {
  at: number;
  version: string;
  level: 'error' | 'warn' | 'info';
  text: string;
}
export interface SceneHostOptions {
  projectId: string;
  /** where the iframes go (fills it) */
  container: HTMLElement;
  state: () => SceneState;
  onPick: (kind: ScenePickKind, id: string | undefined) => void;
  /** x, y: in the page */
  onMenu: (kind: ScenePickKind, id: string | undefined, x: number, y: number) => void;
  onHover: (pick: { kind: ScenePickKind; id?: string } | null) => void;
}
export interface SceneHost {
  /** the Station's state changed (sent at most 4 times a second) */
  update(): void;
  event(e: SceneEvent): void;
  select(pick: { kind: ScenePickKind; id?: string } | null): void;
  /** a 'scene' event from the server: versions changed */
  changed(): void;
  /** the versions list */
  showVersions(): void;
  /** what the shown scene logged lately, newest last */
  logs(): SceneLogLine[];
  /** a builder asked for a picture (scene_look): the shown scene draws one, and it goes to the server */
  look(request: string, width: number, height: number): void;
  /** the version shown now ('starter' for the starter), or null while nothing is */
  shown(): string | null;
  dispose(): void;
}

interface Frame {
  el: HTMLIFrameElement;
  version: string;
  readyAt: number | null;
  lastFps: number;
  timers: ReturnType<typeof setTimeout>[];
  /** messages in the current second, for the rate limit */
  budget: { at: number; n: number; logs: number };
  error: string | null;
}

export function createSceneHost(opts: SceneHostOptions): SceneHost {
  let alive = true;
  let base: string | null = null;
  let overview: SceneVersions | null = null;
  let forced: string | null = null;
  let shown: Frame | null = null;
  let trial: Frame | null = null;
  /** the frame shown before the trial took its place: back if the trial breaks in its first seconds */
  let previous: Frame | null = null;
  let lastState: SceneState | null = null;
  let selected: { kind: ScenePickKind; id?: string } | null = null;
  let paused = document.visibilityState !== 'visible';
  let stateTimer: ReturnType<typeof setTimeout> | null = null;
  const logs: SceneLogLine[] = [];
  /** versions reported as broken by this tab, before the server's answer came back */
  const brokenHere = new Set<string>();

  const layer = h('div.st-scene', { class: 'absolute inset-0' });
  const bar = h('div.st-scene-bar', {
    class:
      'absolute left-4 top-18 z-4 hidden items-center gap-3 rounded-box border border-line bg-panel px-4 py-2.5 text-[13px] text-ink shadow-lg max-w-[calc(100%-32px)]',
  });
  // the Station's own labels, where the scene says things are (Athena.anchors): above the scene, under the bar
  const labelLayer = h('div.st-scene-labels', { class: 'pointer-events-none absolute inset-0 overflow-hidden' });
  opts.container.append(layer, labelLayer, bar);

  /** the best quality this computer kept up with on this visit (it steps down when the scene stays slow) */
  let qualityCap: SceneQuality | null = null;
  const fpsSeen: number[] = [];
  const theme = (): SceneTheme => {
    const look = currentLook();
    return {
      theme: isDark() ? 'dark' : 'light',
      accent: accentTone(accentFor(look.accent)).c,
      reducedMotion:
        look.motion === 'reduced' ||
        (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches),
      quality:
        qualityCap && QUALITY.indexOf(qualityCap) < QUALITY.indexOf(look.worldQuality) ? qualityCap : look.worldQuality,
    };
  };
  const send = (f: Frame | null, msg: ToScene) => {
    try {
      f?.el.contentWindow?.postMessage(msg, '*');
    } catch {
      /* gone */
    }
  };
  const msg = <T extends ToScene['type']>(m: Omit<Extract<ToScene, { type: T }>, 'athena'>): ToScene =>
    ({ athena: SCENE_PROTOCOL, ...m }) as ToScene;

  function makeFrame(version: string): Frame {
    const src = version === 'starter' ? `${base}/starter/index.html` : `${base}/v/${version}/index.html`;
    const el = h('iframe', {
      class: 'absolute inset-0 h-full w-full border-0 bg-transparent opacity-0 pointer-events-none',
      title: 'Station scene',
      src,
    }) as HTMLIFrameElement;
    // agent-written code: its own origin (none), no popups, no navigating the page, no forms
    el.setAttribute('sandbox', 'allow-scripts');
    el.setAttribute('referrerpolicy', 'no-referrer');
    el.dataset.version = version;
    layer.append(el);
    return { el, version, readyAt: null, lastFps: 0, timers: [], budget: { at: 0, n: 0, logs: 0 }, error: null };
  }
  function dropFrame(f: Frame | null): void {
    if (!f) return;
    for (const t of f.timers) clearTimeout(t);
    f.el.remove();
  }
  function showFrame(f: Frame): void {
    f.el.classList.remove('opacity-0', 'pointer-events-none');
    layer.dataset.shown = f.version;
    clearLabels();
  }
  function hideFrame(f: Frame): void {
    f.el.classList.add('opacity-0', 'pointer-events-none');
  }

  async function report(version: string, loads: 'ok' | 'broken', error?: string): Promise<void> {
    if (version === 'starter') return;
    if (loads === 'broken') brokenHere.add(version);
    await rpc.scene.loaded({ project: opts.projectId, version, loads, ...(error ? { error } : {}) }).catch(() => null);
  }

  // a version failed in this tab: back to what worked, and tell everyone
  function broke(f: Frame, why: string): void {
    if (!alive || f.error) return;
    f.error = why;
    // the user asked to see this one anyway: it stays, and the logs say what is wrong
    if (forced === f.version) {
      if (f === trial) onReady(f);
      return;
    }
    void report(f.version, 'broken', why).then(() => void refresh());
    if (f === trial) {
      dropFrame(trial);
      trial = null;
    } else if (f === shown) {
      dropFrame(shown);
      shown = previous;
      previous = null;
      if (shown) showFrame(shown);
    }
    if (overview) {
      // (at once, without waiting for the server)
      const v = overview.versions.find((x) => x.id === f.version);
      if (v) v.loads = 'broken';
      reconcile();
    }
  }

  function startTrial(version: string): void {
    dropFrame(trial);
    const f = makeFrame(version);
    trial = f;
    f.timers.push(
      setTimeout(() => {
        if (trial === f && f.readyAt === null)
          broke(f, `The scene did not say it was ready within ${READY_MS / 1000} seconds (Athena.ready()).`);
      }, READY_MS),
    );
  }

  function onReady(f: Frame): void {
    if (f.readyAt !== null) return;
    f.readyAt = Date.now();
    f.lastFps = Date.now();
    send(f, msg<'hello'>({ type: 'hello', protocol: SCENE_PROTOCOL, ...theme() }));
    if (lastState) send(f, msg<'state'>({ type: 'state', state: lastState }));
    send(f, msg<'select'>({ type: 'select', pick: selected }));
    if (paused) send(f, msg<'pause'>({ type: 'pause' }));
    if (f !== trial) return;
    // it takes the shown one's place now; the old one waits out the first seconds, in case this one breaks
    dropFrame(previous);
    previous = shown;
    if (previous) hideFrame(previous);
    shown = f;
    trial = null;
    showFrame(f);
    f.timers.push(
      setTimeout(() => {
        if (f.error || !alive) return;
        dropFrame(previous);
        previous = null;
        const v = overview?.versions.find((x) => x.id === f.version);
        if (v && !v.loads) void report(f.version, 'ok');
        // a small picture for the versions list, once per version
        if (v && !v.thumb && f.version !== 'starter')
          send(f, msg<'look'>({ type: 'look', request: `thumb:${f.version}`, width: 320, height: 200 }));
      }, SETTLE_MS),
    );
    drawBar();
  }

  function reconcile(): void {
    if (!alive || !overview || !base) return;
    const want = chooseVersion(overview, forced);
    drawBar(want);
    if (trial?.version === want.version) return;
    if (shown?.version === want.version) {
      dropFrame(trial);
      trial = null;
      return;
    }
    startTrial(want.version);
  }

  async function refresh(): Promise<void> {
    const o = await rpc.scene.versions({ project: opts.projectId }).catch(() => null);
    if (!alive || !o) return;
    for (const v of o.versions) if (brokenHere.has(v.id) && !v.loads) v.loads = 'broken';
    overview = o;
    if (forced && o.versions[0]?.id !== forced) forced = null;
    reconcile();
  }

  function drawBar(want: ShowChoice | null = overview ? chooseVersion(overview, forced) : null): void {
    bar.replaceChildren();
    const text =
      want?.bar === 'broken'
        ? "The latest change to this scene doesn't load, so you're seeing the last version that worked."
        : want?.bar === 'never-loaded'
          ? "This project's scene doesn't load yet, so you're seeing the starter scene."
          : want?.bar === 'forced'
            ? "You're seeing the latest version, which doesn't load properly."
            : overview?.problem
              ? `The scene's latest change isn't shown: ${overview.problem}`
              : '';
    bar.classList.toggle('hidden', !text);
    bar.classList.toggle('flex', !!text);
    if (!text) return;
    const newest = overview?.versions[0];
    const parts: (Node | null)[] = [
      domDot('warn'),
      h('span', { class: 'min-w-0' }, text),
      want?.bar === 'broken' && newest
        ? domButton(
            {
              variant: 'ghost',
              size: 'small',
              onclick: () => {
                forced = newest.id;
                reconcile();
              },
            },
            'Show the latest anyway',
          )
        : want?.bar === 'forced'
          ? domButton(
              {
                variant: 'ghost',
                size: 'small',
                onclick: () => {
                  forced = null;
                  reconcile();
                },
              },
              'Show the one that works',
            )
          : null,
      domButton({ variant: 'ghost', size: 'small', onclick: () => showVersions() }, 'Versions'),
    ];
    bar.append(...parts.filter((x): x is Node => !!x));
  }

  // ---------- messages from the scenes ----------
  const known = (kind: ScenePickKind, id: string | undefined): boolean =>
    kind === 'brain' ||
    (!!id &&
      !!lastState &&
      (kind === 'agent' ? lastState.agents.some((a) => a.id === id) : lastState.teams.some((t) => t.id === id)));

  function within(f: Frame, m: FromScene): boolean {
    const now = Date.now();
    if (now - f.budget.at >= 1000) f.budget = { at: now, n: 0, logs: 0 };
    f.budget.n++;
    if (m.type === 'log') f.budget.logs++;
    return f.budget.n <= 60 && f.budget.logs <= 20;
  }

  function onMessage(ev: MessageEvent): void {
    // (only from one of our iframes: a message without a sender, or from anywhere else, is not a scene's)
    if (!ev.source) return;
    const f = [shown, trial, previous].find((x) => x && ev.source === x.el.contentWindow);
    if (!f) return;
    const m = readSceneMessage(ev.data);
    if (!m || !within(f, m)) return;
    if (m.type === 'ready') return onReady(f);
    if (m.type === 'fps') {
      f.lastFps = Date.now();
      if (f === shown) slowCheck(m.fps);
      return;
    }
    if (m.type === 'anchors') {
      if (f === shown) placeLabels(m.items);
      return;
    }
    if (m.type === 'capture') {
      if (m.request === `thumb:${f.version}` && f === shown) {
        void shrink(m.image).then((image) => {
          if (image) void rpc.scene.saveThumb({ project: opts.projectId, version: f.version, image }).catch(() => null);
        });
        return;
      }
      const want = looks.get(m.request);
      if (!want || f !== shown) return;
      looks.delete(m.request);
      clearTimeout(want);
      void rpc.scene.snapshot({ request: m.request, image: m.image, note: `version:${f.version}` }).catch(() => null);
      return;
    }
    if (m.type === 'log') {
      const line = { at: Date.now(), version: f.version, level: m.level, text: m.text };
      logs.push(line);
      if (logs.length > LOGS_KEPT) logs.splice(0, logs.length - LOGS_KEPT);
      unsent.push(line);
      // errors go to the server at once (a builder checking its change reads them), the rest every few seconds
      if (m.level === 'error') flushSoon();
      // an uncaught error before ready, or in the first seconds after: it doesn't load
      const early = f.readyAt === null || Date.now() - f.readyAt < SETTLE_MS;
      if (m.uncaught && m.level === 'error' && early && f.version !== 'starter' && !f.error) broke(f, m.text);
      return;
    }
    // what the user does only counts in the scene they see
    if (f !== shown) return;
    if (m.type === 'pick') {
      if (known(m.kind, m.id)) opts.onPick(m.kind, m.id);
    } else if (m.type === 'menu') {
      if (!known(m.kind, m.id)) return;
      const r = f.el.getBoundingClientRect();
      opts.onMenu(
        m.kind,
        m.id,
        r.left + Math.max(0, Math.min(m.x, r.width)),
        r.top + Math.max(0, Math.min(m.y, r.height)),
      );
    } else if (m.type === 'hover') {
      opts.onHover(m.pick && known(m.pick.kind, m.pick.id) ? m.pick : null);
    }
  }
  window.addEventListener('message', onMessage);

  // ---------- pause, theme, freezes ----------
  function onVisibility(): void {
    const now = document.visibilityState !== 'visible';
    if (now === paused) return;
    paused = now;
    for (const f of [shown, trial]) {
      if (!f?.readyAt) continue;
      send(
        f,
        msg<'pause'>({ type: paused ? 'pause' : 'resume' } as Omit<Extract<ToScene, { type: 'pause' }>, 'athena'>),
      );
      f.lastFps = Date.now();
    }
  }
  document.addEventListener('visibilitychange', onVisibility);
  const offTheme = onThemeChange(() => {
    for (const f of [shown, trial]) if (f?.readyAt) send(f, msg<'theme'>({ type: 'theme', ...theme() }));
  });
  // ---------- for builders: what the scene logged, and pictures ----------
  /** log lines not yet sent to the server (scene_logs) */
  const unsent: SceneLogLine[] = [];
  const flush = () => {
    const lines = unsent.splice(0, 100);
    void rpc.scene.log({ project: opts.projectId, lines }).catch(() => null);
  };
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  function flushSoon(): void {
    flushTimer ??= setTimeout(() => {
      flushTimer = null;
      if (alive) flush();
    }, 300);
  }
  const logTimer = setInterval(() => {
    // (sent every few seconds while a scene is shown, even with nothing new: the server then knows a tab shows it)
    if (shown && !paused) flush();
  }, 3000);
  const looks = new Map<string, ReturnType<typeof setTimeout>>();
  function look(request: string, width: number, height: number): void {
    const f = shown;
    const refuse = (error: string) => void rpc.scene.snapshot({ request, error }).catch(() => null);
    if (!f?.readyAt) return refuse("This tab's scene isn't ready yet.");
    looks.set(
      request,
      setTimeout(() => {
        if (!looks.delete(request)) return;
        refuse(
          f.version === 'starter'
            ? "The starter scene didn't make a picture."
            : "The scene didn't make a picture in time (it may not call Athena.setCapture).",
        );
      }, 8000),
    );
    send(f, msg<'look'>({ type: 'look', request, width, height }));
  }

  /** what the scene was last told about each agent and the Brain: changes become events */
  let before: SceneState | null = null;
  function diffEvents(next: SceneState): void {
    const prev = before;
    before = next;
    if (!prev) return;
    const at = Date.now();
    for (const a of next.agents) {
      const was = prev.agents.find((x) => x.id === a.id);
      if (a.status === 'needs' && was?.status !== 'needs')
        if (shown?.readyAt) send(shown, msg<'event'>({ type: 'event', event: { kind: 'needs', agentId: a.id, at } }));
    }
    if (next.brain.status !== prev.brain.status && shown?.readyAt)
      send(shown, msg<'event'>({ type: 'event', event: { kind: 'brain', status: next.brain.status, at } }));
  }

  // ---------- labels where the scene says things are ----------
  const labelEls = new Map<string, { el: HTMLElement; sig: string; at: number }>();
  function clearLabels(): void {
    labelEls.clear();
    labelLayer.replaceChildren();
  }
  function labelContent(kind: ScenePickKind, id: string | undefined): { sig: string; nodes: Node[] } | null {
    if (kind === 'brain') return { sig: 'brain', nodes: [h('span', { class: 'font-semibold' }, 'Brain')] };
    if (!lastState || !id) return null;
    if (kind === 'team') {
      const t = lastState.teams.find((x) => x.id === id);
      if (!t) return null;
      const name = `${t.emoji ? `${t.emoji} ` : ''}${t.name}`;
      return { sig: `t:${name}`, nodes: [h('span', { class: 'font-semibold' }, name)] };
    }
    const a = lastState.agents.find((x) => x.id === id);
    if (!a) return null;
    return {
      sig: `a:${a.emoji}${a.name}:${a.status}:${a.now}`,
      nodes: [
        domDot(a.status === 'working' ? 'on' : a.status === 'needs' ? 'warn' : 'off'),
        h('span', {}, `${a.emoji} ${a.name}`),
        a.now ? h('span', { class: 'max-w-55 truncate text-dim' }, ` · ${a.now}`) : null,
      ].filter((x): x is HTMLElement => !!x),
    };
  }
  function placeLabels(items: { kind: ScenePickKind; id?: string; x: number; y: number }[]): void {
    const now = Date.now();
    const seen = new Set<string>();
    for (const it of items) {
      if (!known(it.kind, it.id)) continue;
      const key = `${it.kind}:${it.id || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const content = labelContent(it.kind, it.id);
      if (!content) continue;
      let l = labelEls.get(key);
      if (!l) {
        const el = h('button.st-scene-label', {
          type: 'button',
          class:
            'pointer-events-auto absolute left-0 top-0 flex max-w-80 items-center gap-1.5 rounded-ctl border border-line bg-panel/90 px-2 py-0.5 text-[12px] leading-[1.5] whitespace-nowrap text-ink shadow-sm will-change-transform cursor-pointer',
          'data-key': key,
          onclick: () => opts.onPick(it.kind, it.id),
          oncontextmenu: (e: MouseEvent) => {
            e.preventDefault();
            opts.onMenu(it.kind, it.id, e.clientX, e.clientY);
          },
          onmouseenter: () => opts.onHover({ kind: it.kind, ...(it.id ? { id: it.id } : {}) }),
          onmouseleave: () => opts.onHover(null),
        });
        labelLayer.append(el);
        l = { el, sig: '', at: now };
        labelEls.set(key, l);
      }
      if (l.sig !== content.sig) {
        l.sig = content.sig;
        l.el.replaceChildren(...content.nodes);
      }
      l.at = now;
      l.el.style.display = '';
      l.el.style.transform = `translate(${Math.round(it.x)}px, ${Math.round(it.y)}px) translate(-50%, -100%)`;
    }
    for (const [key, l] of labelEls) if (!seen.has(key)) l.el.style.display = 'none';
  }

  // ---------- a slow scene draws less ----------
  function slowCheck(fps: number): void {
    fpsSeen.push(fps);
    if (fpsSeen.length > 4) fpsSeen.shift();
    const q = theme().quality;
    if (fpsSeen.length < 4 || q === 'low' || fpsSeen.some((x) => x >= 20)) return;
    qualityCap = QUALITY[QUALITY.indexOf(q) - 1];
    fpsSeen.length = 0;
    for (const fr of [shown, trial]) if (fr?.readyAt) send(fr, msg<'theme'>({ type: 'theme', ...theme() }));
    toast(
      `The scene was slow here, so it now draws at ${qualityCap === 'low' ? 'Low' : 'Medium'} quality. You can change it in Settings › Appearance.`,
    );
  }

  let lastTick = Date.now();
  const freezeTimer = setInterval(() => {
    const now = Date.now();
    const found = freezeCheck(now, lastTick, shown?.lastFps ?? now);
    lastTick = now;
    const f = shown;
    if (!f?.readyAt || paused || f.version === 'starter' || f.error) return;
    if (found === 'late') f.lastFps = now;
    else if (found === 'frozen')
      broke(f, `The scene stopped drawing (no frames for ${FREEZE_MS / 1000} seconds): it may be stuck in a loop.`);
  }, FREEZE_EVERY_MS);

  const showVersions = () => showSceneVersions(opts.projectId);

  void rpc.scene
    .open({ project: opts.projectId })
    .then((o) => {
      if (!alive) return;
      base = o.base;
      overview = o;
      reconcile();
    })
    .catch(() => {
      if (alive) toast("Couldn't load this project's scene.", 'warn');
    });

  return {
    update() {
      if (stateTimer) return;
      stateTimer = setTimeout(() => {
        stateTimer = null;
        if (!alive) return;
        lastState = opts.state();
        for (const f of [shown, trial]) if (f?.readyAt) send(f, msg<'state'>({ type: 'state', state: lastState }));
        diffEvents(lastState);
      }, STATE_EVERY_MS);
    },
    event(e) {
      if (shown?.readyAt) send(shown, msg<'event'>({ type: 'event', event: e }));
    },
    select(pick) {
      selected = pick;
      if (shown?.readyAt) send(shown, msg<'select'>({ type: 'select', pick }));
    },
    changed() {
      void refresh();
    },
    showVersions,
    logs: () => [...logs],
    look,
    shown: () => shown?.version ?? null,
    dispose() {
      alive = false;
      window.removeEventListener('message', onMessage);
      document.removeEventListener('visibilitychange', onVisibility);
      offTheme();
      clearInterval(freezeTimer);
      clearInterval(logTimer);
      if (flushTimer) clearTimeout(flushTimer);
      for (const t of looks.values()) clearTimeout(t);
      if (stateTimer) clearTimeout(stateTimer);
      dropFrame(shown);
      dropFrame(trial);
      dropFrame(previous);
      layer.remove();
      bar.remove();
      labelLayer.remove();
    },
  };
}

// ---------- the versions list ----------
/** The project's scene versions, with going back to one and keeping one (the Station's bar, Settings › Appearance). */
export function showSceneVersions(projectId: string): void {
  const list = h('div', { class: 'flex max-h-[60vh] flex-col gap-1 overflow-auto' });
  const draw = (o: SceneVersions) => {
    list.replaceChildren(
      ...(o.versions.length
        ? o.versions.map((v) => versionRow(v, o))
        : [h('p', { class: 'text-dim' }, 'This project has no scene yet. Ask an agent to make one.')]),
    );
  };
  const versionRow = (v: SceneVersion, o: SceneVersions) =>
    h(
      'div.scene-version',
      {
        class: 'flex items-center gap-3 rounded-ctl px-2 py-2 hover:bg-ink/4',
        'data-version': v.id,
      },
      v.thumb ? thumbImage(projectId, v.id) : h('span', { class: 'h-10 w-16 flex-none rounded-ctl bg-ink/4' }),
      domDot(v.loads === 'ok' ? 'on' : v.loads === 'broken' ? 'warn' : 'off', {
        title: v.loads === 'ok' ? 'Loads' : v.loads === 'broken' ? "Doesn't load" : 'Not loaded yet',
      }),
      h(
        'div',
        { class: 'min-w-0 flex-1' },
        h(
          'div',
          { class: 'text-[13.5px] text-ink' },
          new Date(v.at).toLocaleString(undefined, {
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
          }),
          ' · ',
          authorText(v),
          v.id === o.versions[0]?.id ? h('span', { class: 'text-dim' }, ' · latest') : null,
        ),
        v.note || v.error
          ? h('div', { class: 'truncate text-[12.5px] text-dim', title: v.error || v.note }, v.error || v.note)
          : null,
      ),
      domButton(
        {
          variant: 'ghost',
          size: 'small',
          title: v.pinned ? 'Kept however old it gets. Click to let it go.' : 'Keep this version however old it gets',
          onclick: () =>
            void rpc.scene
              .pin({ project: projectId, version: v.id, pinned: !v.pinned })
              .then(draw)
              .catch((e: unknown) => toast(String((e as Error)?.message || e), 'warn')),
        },
        v.pinned ? 'Kept' : 'Keep',
      ),
      v.id === o.versions[0]?.id
        ? null
        : domButton(
            {
              variant: 'ghost',
              size: 'small',
              onclick: () =>
                void rpc.scene
                  .restore({ project: projectId, version: v.id })
                  .then((next) => {
                    draw(next);
                    toast('Went back to that version. The one before is kept too.');
                  })
                  .catch((e: unknown) => toast(String((e as Error)?.message || e), 'warn')),
            },
            'Go back to this',
          ),
    );
  void rpc.scene
    .versions({ project: projectId })
    .then(draw)
    .catch(() => null);
  modal({
    title: 'Scene versions',
    body: h(
      'div',
      { class: 'flex flex-col gap-3' },
      h(
        'p',
        { class: 'text-[13px] text-dim' },
        'Every change to the scene is kept. Green: it loads. Amber: it doesn’t. Going back keeps the later versions too.',
      ),
      list,
    ),
  });
}

// A version's small picture, loaded when the list shows it.
function thumbImage(projectId: string, version: string): HTMLElement {
  const img = h('img', {
    class: 'scene-thumb h-10 w-16 flex-none rounded-ctl border border-line object-cover',
    alt: '',
  }) as HTMLImageElement;
  void rpc.scene
    .thumb({ project: projectId, version })
    .then((r) => {
      if (r.image) img.src = r.image;
    })
    .catch(() => null);
  return img;
}

// A capture made small for the versions list: 320 × 200, cropped to fill, as JPEG.
function shrink(dataUrl: string): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = 320;
      c.height = 200;
      const ctx = c.getContext('2d');
      if (!ctx || !img.width || !img.height) return resolve(null);
      const k = Math.max(320 / img.width, 200 / img.height);
      ctx.drawImage(img, (320 - img.width * k) / 2, (200 - img.height * k) / 2, img.width * k, img.height * k);
      resolve(c.toDataURL('image/jpeg', 0.75));
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

function authorText(v: SceneVersion): string {
  const by = v.by;
  if (by.kind === 'user') return 'You';
  if (by.kind === 'backup') return 'From a backup';
  if (by.name) return by.name;
  if (by.kind === 'brain') return 'The Brain';
  return 'Changed in the folder';
}
