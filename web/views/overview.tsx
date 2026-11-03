// Overview (#/overview): every project's agents, teams, the Brain, terminals and board tasks being worked on, in one
// sidebar, with what works and what needs you; this project, all projects, or one. Chats and terminals of any project
// open side by side on a strip where each keeps its width (overviewlayout.ts): 1 to 8 columns per view, pinned columns
// stay at the left, up to three panes stack in one column, and the rail at either edge shows what is off screen. A
// pane of a project that isn't open sends its requests to that project (scopeTo, /api/p/<project>/…). The Brain of
// another project opens that project first (after asking). The plan:
// docs/internal/plans/OVERVIEW_LAYOUT_2026-11-03.md.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, DragEvent as ReactDragEvent, PointerEvent as ReactPointerEvent } from 'react';
import { DEL, GET, POST, ago, attempt, confirmBox, navigate, onEvent, onReconnect, onState, refreshSoon, state, toast } from '../core.ts';
import { scopeTo } from '../client/connection.ts';
import { openChat } from '../chatwin.tsx';
import { openDock } from '../dock.tsx';
import { renderAgentChat } from '../agentchat.tsx';
import { renderTeamChat } from '../teamchat.tsx';
import { XTerm } from '../terminalview.tsx';
import { reducedMotion } from '../motion.ts';
import { Button, IconButton } from '../ui/button.tsx';
import { iconButtonClass } from '../ui/classes.ts';
import { Dropdown, DropdownContent, DropdownItem, DropdownSeparator, DropdownTrigger } from '../ui/dropdown.tsx';
import { Icon, reactPage } from '../ui/react.tsx';
import { Skeleton, Bone } from '../ui/skeleton.tsx';
import { Pick, WhoMark, taskHref, taskKey } from '../taskboard.tsx';
import type { Choice } from '../taskboard.tsx';
import { PER_VIEW_MAX, PER_VIEW_MIN, STACK_MAX, closePane, dropPane, evenOut, loadLayout, movePane, openPane, paneKey, panesInOrder, prune, resizeColumn, resizeStack, saveLayout, setPerView, stackPane, togglePin, unstackPane } from '../overviewlayout.ts';
import type { PaneRef, StripLayout } from '../overviewlayout.ts';
import type { OverviewData, OverviewProject, OverviewSession } from '../../shared/types.ts';

type Sort = 'needs' | 'recent' | 'kind' | 'name';
const SCOPE_KEY = 'dash-overview-scope';
const SORT_KEY = 'dash-overview-sort';
const PINS_KEY = 'dash-overview-pins';
const FOLDED_KEY = 'dash-overview-folded';
// what changes what the Overview shows (it is read again, a moment after)
const CHANGES = new Set(['agents', 'workflows', 'approvals', 'questions', 'runs', 'run', 'team', 'brief', 'board', 'project', 'projects', 'brain-chat', 'chat', 'terminals']);

const KIND_ORDER: Record<OverviewSession['kind'], number> = { brain: 0, agent: 1, team: 2, terminal: 3, task: 4 };
const STATUS_ORDER: Record<OverviewSession['status'], number> = { 'needs-you': 0, working: 1, idle: 2 };
const sessionKey = (p: OverviewProject, s: OverviewSession) => `${p.id}/${s.kind}/${s.id}`;
/** What a session opens as a pane (the Brain and tasks open where they live). */
const paneOf = (s: OverviewSession, projectId: string): PaneRef | null => (s.kind === 'agent' || s.kind === 'team' || s.kind === 'terminal' ? { kind: s.kind, id: s.id, projectId } : null);
const STRIP = 'all';
const readSet = (key: string): Set<string> => {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(key) || '[]');
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
};
const saveSet = (key: string, set: Set<string>) => localStorage.setItem(key, JSON.stringify([...set]));
const label = (s: OverviewSession) => (s.kind === 'task' ? `${taskKey(s.number || 0)} ${s.name}` : s.name);

/** The sessions in the order the sort asks for, pinned ones first. */
export function sortSessions(list: OverviewSession[], sort: Sort, pinned: (s: OverviewSession) => boolean): OverviewSession[] {
  const by: Record<Sort, (a: OverviewSession, b: OverviewSession) => number> = {
    needs: (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.updatedAt - a.updatedAt,
    recent: (a, b) => b.updatedAt - a.updatedAt,
    kind: (a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.name.localeCompare(b.name),
    name: (a, b) => a.name.localeCompare(b.name),
  };
  return [...list].sort((a, b) => +pinned(b) - +pinned(a) || by[sort](a, b) || a.name.localeCompare(b.name));
}

/** Waits until the page shows the given project (after opening it), at most a few seconds. */
function whenOpen(projectId: string): Promise<void> {
  return new Promise((resolve) => {
    if (state.data?.project?.id === projectId) return resolve();
    const off = onState((d) => {
      if (d.project?.id !== projectId) return;
      off();
      clearTimeout(timer);
      resolve();
    });
    const timer = setTimeout(() => (off(), resolve()), 5000);
  });
}

function OverviewPage() {
  const [data, setData] = useState<OverviewData | null>(null);
  const [error, setError] = useState('');
  const [scope, setScope] = useState(() => localStorage.getItem(SCOPE_KEY) || 'all');
  const [sort, setSort] = useState<Sort>(() => (['needs', 'recent', 'kind', 'name'].includes(localStorage.getItem(SORT_KEY) || '') ? localStorage.getItem(SORT_KEY) as Sort : 'needs'));
  const [pins, setPins] = useState(() => readSet(PINS_KEY));
  const [folded, setFolded] = useState(() => readSet(FOLDED_KEY));
  const [search, setSearch] = useState('');
  // the strip: chats and terminals of any project, side by side (one strip, saved in this browser)
  const [layout, setLayout] = useState<StripLayout | null>(null);
  const serial = useRef(0);

  const load = useCallback(async () => {
    const request = ++serial.current;
    try {
      const next = await GET<OverviewData>('/overview');
      if (request === serial.current) (setData(next), setError(''));
    } catch (e) {
      if (request === serial.current) setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    void load();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const soon = () => (clearTimeout(timer), (timer = setTimeout(() => void load(), 300)));
    const off = onEvent((e) => CHANGES.has(e.type) && soon());
    const offReconnect = onReconnect(soon);
    // (times like "2 min ago" move on)
    const tick = setInterval(soon, 60_000);
    return () => (clearTimeout(timer), clearInterval(tick), off(), offReconnect());
  }, [load]);

  // the strip: loaded once, saved with every change, and without panes whose agent, team, terminal or project is gone
  const active = data?.active || '';
  useEffect(() => {
    if (layout || !active) return;
    const saved = loadLayout(STRIP);
    // (a strip saved for the open project before panes could come from any project)
    setLayout(saved.columns.length ? saved : loadLayout(active, active));
  }, [active, layout]);
  useEffect(() => {
    if (!data || !layout) return;
    const pruned = prune(layout, (ref) => !!data.projects.find((p) => p.id === ref.projectId)?.sessions.some((s) => s.kind === ref.kind && s.id === ref.id));
    if (pruned !== layout) setLayout(pruned);
  }, [data, layout]);
  useEffect(() => {
    if (layout) saveLayout(STRIP, layout);
  }, [layout]);
  const change = useCallback((fn: (l: StripLayout) => StripLayout) => setLayout((l) => (l ? fn(l) : l)), []);

  const pickScope = (v: string) => (localStorage.setItem(SCOPE_KEY, v), setScope(v));
  const pickSort = (v: string) => (localStorage.setItem(SORT_KEY, v), setSort(v as Sort));
  const toggleSet = (key: string, set: (fn: (was: Set<string>) => Set<string>) => void, storage: string) => set((was) => {
    const next = new Set(was);
    if (!next.delete(key)) next.add(key);
    saveSet(storage, next);
    return next;
  });

  /** Opens a session: a chat or terminal (of any project) as a pane, a task on its page, the Brain in its chat. The
   *  Brain of another project opens that project first, after asking. */
  const openSession = async (p: OverviewProject, s: OverviewSession) => {
    if (!data) return;
    const ref = paneOf(s, p.id);
    if (ref) {
      // (a copy of the open project has the same ids: the page can't tell their requests apart)
      const twin = p.id !== data.active && s.kind !== 'terminal' && !!data.projects.find((x) => x.id === data.active)?.sessions.some((x) => x.kind === s.kind && x.id === s.id);
      if (twin) return toast(`${s.name} has a twin in the open project (one is a copy of the other). Open ${p.name} to use this one.`, 'warn', 7000);
      return change((l) => openPane(l, ref));
    }
    if (s.kind === 'task') return navigate(taskHref({ projectId: p.id, id: s.id }));
    if (p.id !== data.active) {
      if (!(await confirmBox(`Open the project ${p.name}? The Brain's chat is the open project's: the dashboard switches to ${p.name}, and its Brain opens.`, { ok: `Open ${p.name}` }))) return;
      if (!(await attempt(() => POST(`/projects/${encodeURIComponent(p.id)}/activate`), `Opened ${p.name}`))) return;
      refreshSoon(0);
      await whenOpen(p.id);
      void load();
    }
    openDock();
  };
  /** A new terminal in the open project's folder, opened as a pane. */
  const newTerminal = async () => {
    const t = await attempt(() => POST<{ id: string; title: string }>('/terminals', { kind: 'shell', cwd: state.data?.project?.brainPath }));
    if (!t) return;
    change((l) => openPane(l, { kind: 'terminal', id: t.id, projectId: active }));
    void load();
  };

  // the projects this scope shows (a project picked before and since removed: all of them)
  const projects = useMemo(() => {
    if (!data) return [];
    if (scope === 'here') return data.projects.filter((p) => p.id === data.active);
    const one = data.projects.filter((p) => p.id === scope);
    return one.length ? one : data.projects;
  }, [data, scope]);
  const q = search.trim().toLowerCase();
  const shown = projects.map((p) => ({ p, sessions: sortSessions(p.sessions.filter((s) => !q || `${label(s)} ${p.name}`.toLowerCase().includes(q)), sort, (s) => pins.has(sessionKey(p, s))) }));
  const all = projects.flatMap((p) => p.sessions.map((s) => ({ p, s })));
  const needing = all.filter(({ s }) => s.status === 'needs-you');
  const working = all.filter(({ s }) => s.status === 'working');

  // Ctrl+Alt+N: the next session that needs you (after the one in use)
  const nextNeeding = () => {
    if (!needing.length) return;
    const focus = layout?.focus;
    const i = needing.findIndex(({ p, s }) => focus === `${p.id}/${s.kind}:${s.id}`);
    const { p, s } = needing[(i + 1) % needing.length];
    void openSession(p, s);
  };

  if (error && !data)
    return (
      <div className="mx-auto flex max-w-xl flex-col items-center gap-3 py-16 text-center">
        <p className="m-0 text-[13.5px] text-red">{error}</p>
        <Button variant="ghost" size="small" onClick={() => void load()}>Try again</Button>
      </div>
    );
  if (!data)
    return (
      <Skeleton label="Loading the overview…" className="flex gap-6 p-6">
        <Bone className="h-96 w-80" />
        <Bone className="h-96 flex-1" />
      </Skeleton>
    );

  const scopeChoices: Choice[] = [
    { value: 'here', label: 'This project', mark: <Icon name="folder-open" size={14} className="text-faint" /> },
    { value: 'all', label: 'All projects', mark: <Icon name="layers" size={14} className="text-faint" /> },
    ...data.projects.filter((p) => p.id !== data.active).map((p) => ({ value: p.id, label: p.name, mark: <Icon name="folder" size={14} className="text-faint" /> })),
  ];
  const sortChoices: Choice[] = [
    { value: 'needs', label: 'Needs you first' },
    { value: 'recent', label: 'Last update' },
    { value: 'kind', label: 'By kind' },
    { value: 'name', label: 'By name' },
  ];
  const open = (p: OverviewProject, s: OverviewSession) => void openSession(p, s);
  const panes = layout ? panesInOrder(layout).length : 0;
  return (
    <div className="flex h-[calc(100vh-56px)] min-h-0 max-md:h-auto max-md:flex-col">
      <aside aria-label="Projects and sessions" className="overview-sidebar flex w-80 flex-none flex-col gap-3 overflow-y-auto border-r border-line bg-panel p-2 max-md:w-full max-md:border-r-0 max-md:border-b">
        <div className="flex flex-wrap items-center gap-1.5 px-1 pt-1">
          <Pick label="Show" value={scope} choices={scopeChoices} onChange={pickScope} />
          <Pick label="Sort" value={sort} choices={sortChoices} onChange={pickSort} />
        </div>
        <div className="relative px-1">
          <Icon name="search" size={13} className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-faint" />
          <input className="h-8! w-full rounded-full! py-0! pl-8! text-[12.5px]!" aria-label="Search sessions" placeholder="Search" value={search} onChange={(e) => setSearch(e.currentTarget.value)} />
        </div>
        {shown.map(({ p, sessions }) => (
          <ProjectGroup
            key={p.id}
            project={p}
            sessions={sessions}
            open={p.id === data.active}
            folded={folded.has(p.id) && !q}
            onFold={() => toggleSet(p.id, setFolded, FOLDED_KEY)}
            pinned={(s) => pins.has(sessionKey(p, s))}
            onPin={(s) => toggleSet(sessionKey(p, s), setPins, PINS_KEY)}
            onOpen={(s) => open(p, s)}
            onNewTerminal={p.id === data.active ? () => void newTerminal() : undefined}
            shownAsPane={(s) => !!layout && panesInOrder(layout).some((x) => x.projectId === p.id && x.kind === s.kind && x.id === s.id)}
          />
        ))}
        {q && !shown.some((x) => x.sessions.length) ? <p className="m-0 px-3 py-2 text-[12.5px] text-faint">Nothing matches "{search.trim()}".</p> : null}
      </aside>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {layout && panes ? (
          <Strip layout={layout} change={change} projects={data.projects} active={active} onNextNeeding={nextNeeding} />
        ) : (
          <main className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-8 py-7 max-md:px-4">
            <p className="m-0 text-[13px] text-dim">Click an agent, a team or a terminal, of any project, to open it here. They sit side by side and keep their width.</p>
            <Section title="Needs you" empty="Nothing waits for you." items={needing} showProject={projects.length > 1} onOpen={open} />
            <Section title="Working now" empty="Nothing is working right now." items={working} showProject={projects.length > 1} onOpen={open} />
          </main>
        )}
        <footer aria-label="Status" className="overview-status flex flex-none flex-wrap items-center gap-4 border-t border-line bg-bg px-4 py-1.5 text-[12.5px] text-dim">
          <button type="button" className={`inline-flex cursor-pointer items-center gap-1.5 border-0 bg-transparent p-0 text-inherit ${needing.length ? 'text-amber' : ''}`} onClick={nextNeeding} disabled={!needing.length} title={needing.length ? 'Open the next one that needs you (Ctrl+Alt+N)' : undefined}>
            <span className={`size-1.5 rounded-full ${needing.length ? 'bg-amber' : 'bg-line-2'}`} />
            {needing.length ? `${needing.length} need${needing.length === 1 ? 's' : ''} you` : 'Nothing needs you'}
          </button>
          <span className="inline-flex items-center gap-1.5">
            <span className={`size-1.5 rounded-full ${working.length ? 'bg-accent motion-safe:animate-pulse' : 'bg-line-2'}`} />
            {`${working.length} of ${all.filter((x) => x.s.kind !== 'brain' && x.s.kind !== 'terminal').length} working`}
          </span>
          {projects.length > 1 ? <span>{`${projects.length} projects`}</span> : null}
          {layout && panes ? <StripControls layout={layout} change={change} /> : null}
        </footer>
      </div>
    </div>
  );
}

// ---------- the sidebar ----------
function ProjectGroup({ project: p, sessions, open, folded, onFold, pinned, onPin, onOpen, onNewTerminal, shownAsPane }: {
  project: OverviewProject;
  sessions: OverviewSession[];
  open: boolean;
  folded: boolean;
  onFold: () => void;
  pinned: (s: OverviewSession) => boolean;
  onPin: (s: OverviewSession) => void;
  onOpen: (s: OverviewSession) => void;
  onNewTerminal?: () => void;
  shownAsPane: (s: OverviewSession) => boolean;
}) {
  const summary = [p.needsYou ? `${p.needsYou} need${p.needsYou === 1 ? 's' : ''} you` : '', p.working ? `${p.working} working` : ''].filter(Boolean).join(' · ') || 'idle';
  return (
    <section aria-label={p.name} className="overview-project group/proj flex flex-col">
      <div className="flex items-center">
        <button type="button" className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-ctl border-0 bg-transparent px-2 py-1.5 text-left hover:bg-ink/4" aria-expanded={!folded} onClick={onFold}>
          <span aria-hidden="true" className="grid size-6 flex-none place-items-center rounded-[7px] border border-line bg-panel-2 text-[12px] font-semibold text-dim">{p.name.slice(0, 1).toUpperCase()}</span>
          <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-ink">{p.name}</span>
          {open ? <span className="flex-none rounded-full border border-line px-1.5 text-[10.5px] text-faint">Open</span> : null}
          <span className={`flex-none text-[11.5px] ${p.needsYou ? 'text-amber' : 'text-faint'}`}>{summary}</span>
          <Icon name="chevron-down" size={12} className={`flex-none text-faint [transition:transform_0.15s] ${folded ? '-rotate-90' : ''}`} />
        </button>
        {onNewTerminal ? (
          <IconButton variant="plain" className="size-7! flex-none" aria-label={`New terminal in ${p.name}`} title="New terminal in the project's folder" onClick={onNewTerminal}>
            <Icon name="terminal" size={13} />
          </IconButton>
        ) : null}
      </div>
      {folded ? null : (
        <ul className="m-0 flex list-none flex-col p-0">
          {sessions.map((s) => <SessionRow key={`${s.kind}/${s.id}`} session={s} pinned={pinned(s)} shown={shownAsPane(s)} onPin={() => onPin(s)} onOpen={() => onOpen(s)} />)}
        </ul>
      )}
    </section>
  );
}

/** A session's mark: the agent's emoji and colour, a team, the Brain, a terminal or a task. */
function SessionMark({ session: s, size = 20 }: { session: Pick<OverviewSession, 'kind' | 'id' | 'emoji' | 'color'>; size?: number }) {
  const box = (name: string) => <span aria-hidden="true" className="grid flex-none place-items-center rounded-[7px] border border-line bg-panel-2 text-dim" style={{ width: size, height: size }}><Icon name={name} size={Math.round(size * 0.55)} /></span>;
  if (s.kind === 'task') return box('kanban');
  if (s.kind === 'terminal') return box('terminal');
  return <WhoMark who={s.kind === 'brain' ? 'brain' : `${s.kind}:${s.id}`} emoji={s.emoji} color={s.color} size={size} />;
}

/** How a session is doing: a breathing dot while it works, ! when it needs you, "ended" for a finished terminal. */
function SessionStatus({ session: s }: { session: OverviewSession }) {
  if (s.status === 'working') return <span className="session-status inline-flex size-4 flex-none items-center justify-center" title="Working" aria-label="Working"><span className="size-1.5 rounded-full bg-accent motion-safe:animate-pulse" /></span>;
  if (s.status === 'needs-you') return <span className="session-status grid size-4 flex-none place-items-center rounded-full bg-amber/15 text-[10.5px] font-bold text-amber" title={s.why || 'Needs you'} aria-label={`Needs you${s.why ? `: ${s.why}` : ''}`}>!</span>;
  if (s.ended) return <span className="session-status flex-none text-[11px] text-faint" title={s.why}>ended</span>;
  return null;
}

function SessionRow({ session: s, pinned, shown, onPin, onOpen }: { session: OverviewSession; pinned: boolean; shown: boolean; onPin: () => void; onOpen: () => void }) {
  return (
    <li className={`group relative flex items-center gap-2 rounded-ctl pr-1.5 pl-4 hover:bg-ink/4 ${shown ? 'bg-ink/4' : ''}`}>
      <button type="button" className="session-open flex min-w-0 flex-1 cursor-pointer items-center gap-2 border-0 bg-transparent py-1.5 text-left text-[13px] text-ink" title={s.why || (s.updatedAt ? `Last change ${ago(s.updatedAt)}` : '')} aria-current={shown ? 'true' : undefined} onClick={onOpen}>
        <SessionMark session={s} />
        <span className="session-name min-w-0 flex-1 truncate">{label(s)}</span>
      </button>
      <IconButton variant="plain" className={`size-6! flex-none ${pinned ? 'text-accent' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'}`} aria-label={pinned ? `Unpin ${label(s)}` : `Pin ${label(s)}`} aria-pressed={pinned} title={pinned ? 'Unpin' : 'Pin to the top'} onClick={onPin}>
        <Icon name="star" size={12} />
      </IconButton>
      <SessionStatus session={s} />
    </li>
  );
}

/** A list across the scope (what needs you, what works), each with its project and an Open button. */
function Section({ title, empty, items, showProject, onOpen }: { title: string; empty: string; items: { p: OverviewProject; s: OverviewSession }[]; showProject: boolean; onOpen: (p: OverviewProject, s: OverviewSession) => void }) {
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <h2 className="m-0 flex items-baseline gap-2 text-[14px] font-semibold text-ink">
        {title}
        {items.length ? <span className="text-[12px] font-normal text-faint">{items.length}</span> : null}
      </h2>
      {items.length ? (
        <ul className="m-0 flex list-none flex-col divide-y divide-line rounded-box border border-line bg-panel p-0 shadow-card">
          {items.map(({ p, s }) => (
            <li key={`${p.id}/${s.kind}/${s.id}`} className="flex items-center gap-3 px-3.5 py-2.5">
              <SessionMark session={s} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13.5px] text-ink">{label(s)}{showProject ? <span className="text-faint">{` · ${p.name}`}</span> : null}</div>
                <div className="truncate text-[12px] text-dim">{s.why || (s.updatedAt ? `Last change ${ago(s.updatedAt)}` : '')}</div>
              </div>
              <Button variant="ghost" size="small" onClick={() => onOpen(p, s)}>Open</Button>
            </li>
          ))}
        </ul>
      ) : <p className="m-0 rounded-box border border-dashed border-line px-3.5 py-3 text-[12.5px] text-faint">{empty}</p>}
    </section>
  );
}

// ---------- the strip ----------
type Change = (fn: (l: StripLayout) => StripLayout) => void;

/** The columns control and the minimap, in the status line. */
function StripControls({ layout, change }: { layout: StripLayout; change: Change }) {
  return (
    <span className="ml-auto inline-flex items-center gap-3">
      <span className="strip-minimap inline-flex items-center gap-1" aria-label="Panes">
        {layout.columns.map((c, i) => (
          <button
            key={c.panes.map(paneKey).join('|')}
            type="button"
            title={`Go to pane ${i + 1}`}
            aria-label={`Go to pane ${i + 1}`}
            className={`h-1 cursor-pointer rounded-full border-0 p-0 ${c.panes.some((p) => paneKey(p) === layout.focus) ? 'w-4 bg-ink' : 'w-2.5 bg-line-2 hover:bg-dim'}`}
            onClick={() => change((l) => ({ ...l, focus: paneKey(c.panes[0]) }))}
          />
        ))}
      </span>
      <span className="inline-flex items-center gap-1" aria-label="Columns per view">
        <IconButton variant="plain" className="size-6!" aria-label="Fewer columns" title="Fewer columns (Ctrl+Alt+−)" disabled={layout.perView <= PER_VIEW_MIN} onClick={() => change((l) => setPerView(l, l.perView - 1))}><Icon name="minus" size={12} /></IconButton>
        <span className="strip-per-view min-w-3 text-center tabular-nums">{layout.perView}</span>
        <IconButton variant="plain" className="size-6!" aria-label="More columns" title="More columns (Ctrl+Alt+=)" disabled={layout.perView >= PER_VIEW_MAX} onClick={() => change((l) => setPerView(l, l.perView + 1))}><Icon name="plus" size={12} /></IconButton>
      </span>
    </span>
  );
}

/** The strip of panes: columns that keep their width and slide sideways, pinned ones at the left. */
function Strip({ layout, change, projects, active, onNextNeeding }: { layout: StripLayout; change: Change; projects: OverviewProject[]; active: string; onNextNeeding: () => void }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ width: 0, left: 0 });
  useLayoutEffect(() => {
    const el = scroller.current!;
    const measure = () => setView({ width: el.clientWidth, left: el.scrollLeft });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    let frame = 0;
    const onScroll = () => (cancelAnimationFrame(frame), (frame = requestAnimationFrame(measure)));
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => (ro.disconnect(), el.removeEventListener('scroll', onScroll), cancelAnimationFrame(frame));
  }, []);
  const colPx = Math.max(240, (view.width || 960) / layout.perView);
  // where each column sits, and which ones are in view (pinned ones always are)
  const spans = useMemo(() => {
    let x = 0;
    return layout.columns.map((c) => {
      const w = colPx * c.width;
      const span = { x, w, pinned: c.pinned };
      x += w;
      return span;
    });
  }, [layout.columns, colPx]);
  const pinnedWidth = spans.filter((s) => s.pinned).reduce((n, s) => n + s.w, 0);
  // (before its width is known, every pane counts as in view)
  const visible = (i: number) => !view.width || spans[i].pinned || (spans[i].x + spans[i].w > view.left + pinnedWidth + 1 && spans[i].x < view.left + view.width - 1);
  // chats more than a view away aren't drawn (their header and status stay); terminals always are
  const near = (i: number) => !view.width || spans[i].pinned || (spans[i].x + spans[i].w > view.left - view.width && spans[i].x < view.left + 2 * view.width);
  const status = (ref: PaneRef) => projects.find((p) => p.id === ref.projectId)?.sessions.find((s) => s.kind === ref.kind && s.id === ref.id);
  // (a pane of a project that isn't open says which project it is)
  const projectName = (ref: PaneRef) => (ref.projectId === active ? undefined : projects.find((p) => p.id === ref.projectId)?.name || 'Another project');

  // the pane in use slides into view
  useEffect(() => {
    const el = scroller.current;
    const at = layout.columns.findIndex((c) => c.panes.some((p) => paneKey(p) === layout.focus));
    if (!el || at < 0 || spans[at].pinned) return;
    const { x, w } = spans[at];
    let left = el.scrollLeft;
    if (x < left + pinnedWidth) left = x - pinnedWidth;
    else if (x + w > left + el.clientWidth) left = x + w - el.clientWidth;
    if (left !== el.scrollLeft) el.scrollTo({ left, behavior: reducedMotion() ? 'auto' : 'smooth' });
  }, [layout.focus, layout.columns, spans, pinnedWidth]);

  // the keys (Ctrl+Alt, ⌃⌥ on a Mac): panes by number, previous and next, move, columns, pin, stack, close
  const keys = useRef({ layout, change, onNextNeeding });
  keys.current = { layout, change, onNextNeeding };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || !e.altKey || e.metaKey) return;
      const { layout: l, change: set } = keys.current;
      const order = panesInOrder(l).map(paneKey);
      const focus = l.focus && order.includes(l.focus) ? l.focus : order[0];
      const i = order.indexOf(focus);
      const act = (fn: (l: StripLayout) => StripLayout) => (e.preventDefault(), set(fn));
      const digit = /^Digit([1-9])$/.exec(e.code);
      if (digit && order[Number(digit[1]) - 1]) return act((x) => ({ ...x, focus: order[Number(digit[1]) - 1] }));
      if (e.code === 'BracketLeft') return act((x) => (e.shiftKey ? movePane(x, focus, -1) : { ...x, focus: order[Math.max(0, i - 1)] }));
      if (e.code === 'BracketRight') return act((x) => (e.shiftKey ? movePane(x, focus, 1) : { ...x, focus: order[Math.min(order.length - 1, i + 1)] }));
      if (e.code === 'Minus') return act((x) => setPerView(x, x.perView - 1));
      if (e.code === 'Equal') return act((x) => setPerView(x, x.perView + 1));
      if (e.code === 'Digit0') return act(evenOut);
      if (e.code === 'KeyP') return act((x) => togglePin(x, focus));
      if (e.code === 'KeyS') return act((x) => (x.columns.find((c) => c.panes.some((p) => paneKey(p) === focus))!.panes.length > 1 ? unstackPane(x, focus) : stackPane(x, focus)));
      if (e.code === 'KeyW') return act((x) => closePane(x, focus));
      if (e.code === 'KeyN') return (e.preventDefault(), keys.current.onNextNeeding());
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // off screen: marks at either edge (with their status), a click slides to them
  const offLeft = layout.columns.flatMap((c, i) => (!spans[i] || spans[i].pinned || visible(i) || spans[i].x >= view.left ? [] : c.panes));
  const offRight = layout.columns.flatMap((c, i) => (!spans[i] || spans[i].pinned || visible(i) || spans[i].x < view.left ? [] : c.panes));
  const rail = (list: PaneRef[], side: 'left' | 'right') =>
    list.length ? (
      <div className={`strip-rail strip-rail-${side} pointer-events-none absolute top-1/2 z-20 flex -translate-y-1/2 flex-col gap-1.5 ${side === 'left' ? 'left-1' : 'right-1'}`} style={side === 'left' ? { left: pinnedWidth + 4 } : undefined}>
        {list.map((ref) => {
          const s = status(ref);
          return (
            <button key={paneKey(ref)} type="button" className="pointer-events-auto relative cursor-pointer rounded-[8px] border-0 bg-transparent p-0 shadow-raised" title={`${s?.name || ref.id}${s?.status === 'needs-you' ? ' · needs you' : s?.status === 'working' ? ' · working' : ''}`} aria-label={`Go to ${s?.name || ref.id}`} onClick={() => change((l) => ({ ...l, focus: paneKey(ref) }))}>
              <SessionMark session={s || { kind: ref.kind, id: ref.id }} size={22} />
              {s?.status === 'needs-you' ? <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-amber" /> : s?.status === 'working' ? <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-accent" /> : null}
            </button>
          );
        })}
      </div>
    ) : null;

  return (
    <div className="relative flex min-h-0 flex-1">
      <div ref={scroller} className="strip flex min-h-0 flex-1 overflow-x-auto overflow-y-hidden [scrollbar-width:thin]">
        {layout.columns.map((c, i) => (
          <StripColumnView
            key={paneKey(c.panes[0])}
            index={i}
            column={c}
            style={{ width: spans[i]?.w || colPx, ...(c.pinned ? { position: 'sticky', left: spans.slice(0, i).filter((s) => s.pinned).reduce((n, s) => n + s.w, 0), zIndex: 10 } : {}) }}
            focus={layout.focus}
            drawn={(ref) => ref.kind === 'terminal' || near(i)}
            status={status}
            projectName={projectName}
            change={change}
            colPx={colPx}
            canStack={i > 0 && layout.columns[i - 1].panes.length < STACK_MAX}
          />
        ))}
      </div>
      {rail(offLeft, 'left')}
      {rail(offRight, 'right')}
    </div>
  );
}

function StripColumnView({ index, column: c, style, focus, drawn, status, projectName, change, colPx, canStack }: {
  index: number;
  column: StripLayout['columns'][number];
  style: CSSProperties;
  focus: string | null;
  drawn: (ref: PaneRef) => boolean;
  status: (ref: PaneRef) => OverviewSession | undefined;
  projectName: (ref: PaneRef) => string | undefined;
  change: Change;
  colPx: number;
  canStack: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  // the line at the right edge: drag it to make the column wider or narrower
  const resizeWidth = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const start = e.clientX;
    const width = c.width;
    const move = (m: PointerEvent) => change((l) => resizeColumn(l, index, width + (m.clientX - start) / colPx));
    const up = () => (document.removeEventListener('pointermove', move), document.removeEventListener('pointerup', up));
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  };
  // the line between two stacked panes
  const resizeHeight = (row: number) => (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const el = box.current!;
    const panes = [...el.querySelectorAll<HTMLElement>(':scope > .strip-pane')];
    const top = panes[row].getBoundingClientRect().top;
    const both = panes[row].getBoundingClientRect().height + panes[row + 1].getBoundingClientRect().height;
    const move = (m: PointerEvent) => change((l) => resizeStack(l, index, row, (m.clientY - top) / both));
    const up = () => (document.removeEventListener('pointermove', move), document.removeEventListener('pointerup', up));
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  };
  return (
    <div ref={box} className={`strip-column relative flex h-full flex-none flex-col bg-bg ${c.pinned ? 'border-r border-line shadow-card' : ''}`} style={style} data-pinned={c.pinned || undefined}>
      {c.panes.map((ref, row) => (
        <Pane key={paneKey(ref)} paneRef={ref} projectName={projectName(ref)} share={c.heights[row] ?? 1 / c.panes.length} stacked={c.panes.length > 1} pinned={c.pinned} focused={focus === paneKey(ref)} drawn={drawn(ref)} session={status(ref)} change={change} canStack={row === 0 && canStack} resizeBelow={row < c.panes.length - 1 ? resizeHeight(row) : undefined} />
      ))}
      <div role="separator" aria-orientation="vertical" aria-label="Column width" className="absolute top-0 right-0 bottom-0 z-10 w-1.5 cursor-col-resize hover:bg-accent/30" onPointerDown={resizeWidth} />
    </div>
  );
}

const DRAG_TYPE = 'text/x-overview-pane';

function Pane({ paneRef: ref, projectName, share, stacked, pinned, focused, drawn, session: s, change, canStack, resizeBelow }: {
  paneRef: PaneRef;
  /** set when the pane's project isn't the open one */
  projectName?: string;
  share: number;
  stacked: boolean;
  pinned: boolean;
  focused: boolean;
  drawn: boolean;
  session: OverviewSession | undefined;
  change: Change;
  canStack: boolean;
  resizeBelow?: (e: ReactPointerEvent<HTMLDivElement>) => void;
}) {
  const key = paneKey(ref);
  const [over, setOver] = useState<'before' | 'after' | 'stack' | null>(null);
  const name = s?.name || (ref.kind === 'terminal' ? 'Terminal' : ref.id);
  const zone = (e: ReactDragEvent<HTMLElement>): 'before' | 'after' | 'stack' => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - r.left) / (r.width || 1);
    return x < 0.25 ? 'before' : x > 0.75 ? 'after' : 'stack';
  };
  const endTerminal = async () => {
    if (!(await confirmBox(`End the terminal "${name}"? What runs in it stops.`, { ok: 'End terminal', danger: true }))) return;
    if (await attempt(() => DEL(`/terminals/${encodeURIComponent(ref.id)}`))) change((l) => closePane(l, key));
  };
  return (
    <>
      <section
        aria-label={name}
        data-pane={key}
        className={`strip-pane relative flex min-h-0 flex-col border-l border-line ${focused ? 'outline-1 -outline-offset-1 outline-accent/60' : ''}`}
        style={{ flex: `${share} 1 0` }}
        onPointerDownCapture={() => !focused && change((l) => ({ ...l, focus: key }))}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
          e.preventDefault();
          setOver(zone(e));
        }}
        onDragLeave={() => setOver(null)}
        onDrop={(e) => {
          const from = e.dataTransfer.getData(DRAG_TYPE);
          const how = zone(e);
          setOver(null);
          if (!from || from === key) return;
          e.preventDefault();
          change((l) => dropPane(l, from, key, how) ?? l);
        }}
      >
        <header className="flex flex-none items-center gap-2 border-b border-line bg-panel px-2 py-1.5">
          <span
            className="grid size-5 flex-none cursor-grab place-items-center text-faint hover:text-ink"
            draggable
            title="Drag onto another pane: its sides put it before or after, its middle stacks it"
            aria-hidden="true"
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData(DRAG_TYPE, key);
            }}
          >
            <Icon name="grip-vertical" size={12} />
          </span>
          <SessionMark session={s || { kind: ref.kind, id: ref.id }} size={18} />
          <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink">
            {name}
            {projectName ? <span className="font-normal text-faint">{` · ${projectName}`}</span> : null}
          </span>
          {pinned ? <Icon name="star" size={11} className="flex-none text-accent" /> : null}
          {s?.status === 'needs-you' ? <span className="flex-none rounded-full bg-amber/15 px-1.5 text-[11px] font-medium text-amber" title={s.why}>Needs you</span> : s?.status === 'working' ? <span className="inline-flex flex-none items-center gap-1 text-[11px] text-accent"><span className="size-1.5 rounded-full bg-accent motion-safe:animate-pulse" />Working</span> : s?.ended ? <span className="flex-none text-[11px] text-faint">ended</span> : null}
          <Dropdown>
            <DropdownTrigger className={iconButtonClass('plain', 'size-6!')} aria-label={`Actions for ${name}`}>
              <Icon name="ellipsis" size={13} />
            </DropdownTrigger>
            <DropdownContent align="end" className="min-w-52">
              <DropdownItem icon="star" onClick={() => change((l) => togglePin(l, key))}>{pinned ? 'Unpin' : 'Pin at the left'}</DropdownItem>
              {stacked ? <DropdownItem icon="columns-2" onClick={() => change((l) => unstackPane(l, key))}>Take out of the stack</DropdownItem> : canStack ? <DropdownItem icon="layers" onClick={() => change((l) => stackPane(l, key))}>Stack under the one before</DropdownItem> : null}
              <DropdownItem onClick={() => change((l) => movePane(l, key, -1))}>Move left</DropdownItem>
              <DropdownItem onClick={() => change((l) => movePane(l, key, 1))}>Move right</DropdownItem>
              {ref.kind !== 'terminal' && !projectName ? <DropdownItem icon="external-link" onClick={() => (openChat(ref.kind === 'agent' ? 'agent' : 'team', ref.id), change((l) => closePane(l, key)))}>Open in a chat window</DropdownItem> : null}
              <DropdownSeparator />
              {ref.kind === 'terminal' && !s?.ended ? <DropdownItem icon="square" danger onClick={() => void endTerminal()}>End terminal</DropdownItem> : null}
              <DropdownItem icon="x" onClick={() => change((l) => closePane(l, key))}>Close</DropdownItem>
            </DropdownContent>
          </Dropdown>
        </header>
        <div className="flex min-h-0 flex-1 flex-col">
          {drawn ? <PaneBody paneRef={ref} foreign={!!projectName} /> : <div className="grid flex-1 place-items-center text-[12px] text-faint">{name}</div>}
        </div>
        {over ? <div aria-hidden="true" className={`pointer-events-none absolute z-20 rounded-[6px] bg-accent/15 outline-2 -outline-offset-2 outline-accent/60 ${over === 'before' ? 'inset-y-0 left-0 w-1/4' : over === 'after' ? 'inset-y-0 right-0 w-1/4' : 'inset-x-0 bottom-0 h-1/2'}`} /> : null}
      </section>
      {resizeBelow ? <div role="separator" aria-orientation="horizontal" aria-label="Pane height" className="h-1.5 flex-none cursor-row-resize border-l border-line bg-line/40 hover:bg-accent/30" onPointerDown={resizeBelow} /> : null}
    </>
  );
}

/** What a pane shows: an agent's chat or a team's thread (the components the chat windows use), or a terminal. A
 *  chat of a project that isn't open (foreign) sends its requests to that project while it shows. */
function PaneBody({ paneRef: ref, foreign }: { paneRef: PaneRef; foreign: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.kind === 'terminal') return;
    const el = host.current!;
    const scoped = foreign ? { projectId: ref.projectId } : {};
    const release = foreign ? scopeTo(ref.projectId, ref.kind === 'agent' ? 'agents' : 'teams', ref.id) : () => {};
    const api = ref.kind === 'agent' ? renderAgentChat(el, ref.id, scoped) : renderTeamChat(el, ref.id, { fill: true, ...scoped });
    // (the chat is its own React root: it is taken down after this render)
    return () => void setTimeout(() => (api.destroy(), release()));
  }, [ref.kind, ref.id, ref.projectId, foreign]);
  if (ref.kind === 'terminal') return <XTerm id={ref.id} className="min-h-0 flex-1 bg-bg px-2 py-1" />;
  return <div ref={host} className="strip-chat flex min-h-0 flex-1 flex-col px-3 pt-1 pb-3 *:min-h-0 *:flex-1" />;
}

export const flush = true;
export const title = () => 'Overview';
export const { render, unmount } = reactPage(() => <OverviewPage />);
