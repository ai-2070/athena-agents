// Overview (#/overview): every project's agents, teams, the Brain and board tasks being worked on, in one sidebar, with
// what works and what needs you. This project, all projects, or one. A session of another project opens that project
// first (after asking). The plan: docs/internal/plans/OVERVIEW_LAYOUT_2026-11-03.md; the strip of panes comes next.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GET, POST, ago, attempt, confirmBox, navigate, onEvent, onReconnect, onState, refreshSoon, state } from '../core.ts';
import { openChat } from '../chatwin.tsx';
import { openDock } from '../dock.tsx';
import { Button, IconButton } from '../ui/button.tsx';
import { Icon, reactPage } from '../ui/react.tsx';
import { Skeleton, Bone } from '../ui/skeleton.tsx';
import { Pick, WhoMark, taskHref, taskKey } from '../taskboard.tsx';
import type { Choice } from '../taskboard.tsx';
import type { OverviewData, OverviewProject, OverviewSession } from '../../shared/types.ts';

type Sort = 'needs' | 'recent' | 'kind' | 'name';
const SCOPE_KEY = 'dash-overview-scope';
const SORT_KEY = 'dash-overview-sort';
const PINS_KEY = 'dash-overview-pins';
const FOLDED_KEY = 'dash-overview-folded';
// what changes what the Overview shows (it is read again, a moment after)
const CHANGES = new Set(['agents', 'workflows', 'approvals', 'questions', 'runs', 'run', 'team', 'brief', 'board', 'project', 'projects', 'brain-chat', 'chat']);

const KIND_ORDER: Record<OverviewSession['kind'], number> = { brain: 0, agent: 1, team: 2, task: 3 };
const STATUS_ORDER: Record<OverviewSession['status'], number> = { 'needs-you': 0, working: 1, idle: 2 };
const sessionKey = (p: OverviewProject, s: OverviewSession) => `${p.id}/${s.kind}/${s.id}`;
const readSet = (key: string): Set<string> => {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(key) || '[]');
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
};
const saveSet = (key: string, set: Set<string>) => localStorage.setItem(key, JSON.stringify([...set]));

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

/** Opens a session where it lives today: its chat window, the Brain chat, or the task's page. */
async function openSession(data: OverviewData, p: OverviewProject, s: OverviewSession): Promise<void> {
  if (p.id !== data.active) {
    if (!(await confirmBox(`Open the project ${p.name}? The dashboard switches to it, and ${s.kind === 'task' ? `${taskKey(s.number || 0)} opens` : `${s.name} opens there`}.`, { ok: `Open ${p.name}` }))) return;
    if (!(await attempt(() => POST(`/projects/${encodeURIComponent(p.id)}/activate`), `Opened ${p.name}`))) return;
    refreshSoon(0);
    await whenOpen(p.id);
  }
  if (s.kind === 'agent') openChat('agent', s.id);
  else if (s.kind === 'team') openChat('team', s.id);
  else if (s.kind === 'brain') openDock();
  else navigate(taskHref({ projectId: p.id, id: s.id }));
}

function OverviewPage() {
  const [data, setData] = useState<OverviewData | null>(null);
  const [error, setError] = useState('');
  const [scope, setScope] = useState(() => localStorage.getItem(SCOPE_KEY) || 'all');
  const [sort, setSort] = useState<Sort>(() => (['needs', 'recent', 'kind', 'name'].includes(localStorage.getItem(SORT_KEY) || '') ? localStorage.getItem(SORT_KEY) as Sort : 'needs'));
  const [pins, setPins] = useState(() => readSet(PINS_KEY));
  const [folded, setFolded] = useState(() => readSet(FOLDED_KEY));
  const [search, setSearch] = useState('');
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

  const pickScope = (v: string) => (localStorage.setItem(SCOPE_KEY, v), setScope(v));
  const pickSort = (v: string) => (localStorage.setItem(SORT_KEY, v), setSort(v as Sort));
  const togglePin = (key: string) => setPins((was) => {
    const next = new Set(was);
    if (!next.delete(key)) next.add(key);
    saveSet(PINS_KEY, next);
    return next;
  });
  const toggleFold = (id: string) => setFolded((was) => {
    const next = new Set(was);
    if (!next.delete(id)) next.add(id);
    saveSet(FOLDED_KEY, next);
    return next;
  });

  // the projects this scope shows (a project picked before and since removed: all of them)
  const projects = useMemo(() => {
    if (!data) return [];
    if (scope === 'here') return data.projects.filter((p) => p.id === data.active);
    const one = data.projects.filter((p) => p.id === scope);
    return one.length ? one : data.projects;
  }, [data, scope]);
  const q = search.trim().toLowerCase();
  const shown = projects.map((p) => ({ p, sessions: sortSessions(p.sessions.filter((s) => !q || `${s.name} ${p.name} ${s.number ? taskKey(s.number) : ''}`.toLowerCase().includes(q)), sort, (s) => pins.has(sessionKey(p, s))) }));
  const all = projects.flatMap((p) => p.sessions.map((s) => ({ p, s })));
  const needing = all.filter(({ s }) => s.status === 'needs-you');
  const working = all.filter(({ s }) => s.status === 'working');

  if (error && !data)
    return (
      <div className="mx-auto flex max-w-xl flex-col items-center gap-3 py-16 text-center">
        <p className="m-0 text-[13.5px] text-red">{error}</p>
        <Button variant="ghost" size="small" onClick={() => void load()}>Try again</Button>
      </div>
    );
  if (!data)
    return (
      <Skeleton label="Loading the overview…" className="flex gap-6">
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
  const open = (p: OverviewProject, s: OverviewSession) => void openSession(data, p, s);
  return (
    <div className="flex min-h-[calc(100vh-10rem)] flex-col gap-4">
      <div className="grid flex-1 items-start gap-6 lg:grid-cols-[320px_minmax(0,1fr)]">
        <aside aria-label="Projects and sessions" className="overview-sidebar flex flex-col gap-3 rounded-box border border-line bg-panel p-2 shadow-card lg:sticky lg:top-20">
          <div className="flex flex-wrap items-center gap-1.5 px-1 pt-1">
            <Pick label="Show" value={scope} choices={scopeChoices} onChange={pickScope} />
            <Pick label="Sort" value={sort} choices={sortChoices} onChange={pickSort} />
          </div>
          <div className="relative px-1">
            <Icon name="search" size={13} className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-faint" />
            <input className="h-8! w-full rounded-full! py-0! pl-8! text-[12.5px]!" aria-label="Search sessions" placeholder="Search" value={search} onChange={(e) => setSearch(e.currentTarget.value)} />
          </div>
          {shown.map(({ p, sessions }) => (
            <ProjectGroup key={p.id} project={p} sessions={sessions} open={p.id === data.active} folded={folded.has(p.id) && !q} onFold={() => toggleFold(p.id)} pinned={(s) => pins.has(sessionKey(p, s))} onPin={(s) => togglePin(sessionKey(p, s))} onOpen={(s) => open(p, s)} />
          ))}
          {q && !shown.some((x) => x.sessions.length) ? <p className="m-0 px-3 py-2 text-[12.5px] text-faint">Nothing matches "{search.trim()}".</p> : null}
        </aside>
        <main className="flex min-w-0 flex-col gap-6">
          <Section title="Needs you" empty="Nothing waits for you." items={needing} showProject={projects.length > 1} onOpen={open} />
          <Section title="Working now" empty="Nothing is working right now." items={working} showProject={projects.length > 1} onOpen={open} />
        </main>
      </div>
      <footer aria-label="Status" className="overview-status sticky bottom-0 flex flex-wrap items-center gap-4 border-t border-line bg-bg/90 px-1 py-2 text-[12.5px] text-dim backdrop-blur">
        <span className={`inline-flex items-center gap-1.5 ${needing.length ? 'text-amber' : ''}`}>
          <span className={`size-1.5 rounded-full ${needing.length ? 'bg-amber' : 'bg-line-2'}`} />
          {needing.length ? `${needing.length} need${needing.length === 1 ? 's' : ''} you` : 'Nothing needs you'}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className={`size-1.5 rounded-full ${working.length ? 'bg-accent motion-safe:animate-pulse' : 'bg-line-2'}`} />
          {`${working.length} of ${all.filter((x) => x.s.kind !== 'brain').length} working`}
        </span>
        {projects.length > 1 ? <span>{`${projects.length} projects`}</span> : null}
      </footer>
    </div>
  );
}

function ProjectGroup({ project: p, sessions, open, folded, onFold, pinned, onPin, onOpen }: {
  project: OverviewProject;
  sessions: OverviewSession[];
  open: boolean;
  folded: boolean;
  onFold: () => void;
  pinned: (s: OverviewSession) => boolean;
  onPin: (s: OverviewSession) => void;
  onOpen: (s: OverviewSession) => void;
}) {
  const summary = [p.needsYou ? `${p.needsYou} need${p.needsYou === 1 ? 's' : ''} you` : '', p.working ? `${p.working} working` : ''].filter(Boolean).join(' · ') || 'idle';
  return (
    <section aria-label={p.name} className="overview-project flex flex-col">
      <button type="button" className="flex w-full cursor-pointer items-center gap-2 rounded-ctl border-0 bg-transparent px-2 py-1.5 text-left hover:bg-ink/4" aria-expanded={!folded} onClick={onFold}>
        <span aria-hidden="true" className="grid size-6 flex-none place-items-center rounded-[7px] border border-line bg-panel-2 text-[12px] font-semibold text-dim">{p.name.slice(0, 1).toUpperCase()}</span>
        <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-ink">{p.name}</span>
        {open ? <span className="flex-none rounded-full border border-line px-1.5 text-[10.5px] text-faint">Open</span> : null}
        <span className={`flex-none text-[11.5px] ${p.needsYou ? 'text-amber' : 'text-faint'}`}>{summary}</span>
        <Icon name="chevron-down" size={12} className={`flex-none text-faint [transition:transform_0.15s] ${folded ? '-rotate-90' : ''}`} />
      </button>
      {folded ? null : (
        <ul className="m-0 flex list-none flex-col p-0">
          {sessions.map((s) => <SessionRow key={`${s.kind}/${s.id}`} session={s} pinned={pinned(s)} onPin={() => onPin(s)} onOpen={() => onOpen(s)} />)}
        </ul>
      )}
    </section>
  );
}

/** A session's mark: the agent's emoji and colour, a team, the Brain, or a task. */
function SessionMark({ session: s }: { session: OverviewSession }) {
  if (s.kind === 'task') return <span aria-hidden="true" className="grid size-5 flex-none place-items-center rounded-[7px] border border-line bg-panel-2 text-dim"><Icon name="kanban" size={11} /></span>;
  return <WhoMark who={s.kind === 'brain' ? 'brain' : `${s.kind}:${s.id}`} emoji={s.emoji} color={s.color} size={20} />;
}

/** How a session is doing: a breathing dot while it works, ! when it needs you. */
function SessionStatus({ session: s }: { session: OverviewSession }) {
  if (s.status === 'working') return <span className="session-status inline-flex size-4 flex-none items-center justify-center" title="Working" aria-label="Working"><span className="size-1.5 rounded-full bg-accent motion-safe:animate-pulse" /></span>;
  if (s.status === 'needs-you') return <span className="session-status grid size-4 flex-none place-items-center rounded-full bg-amber/15 text-[10.5px] font-bold text-amber" title={s.why || 'Needs you'} aria-label={`Needs you${s.why ? `: ${s.why}` : ''}`}>!</span>;
  return null;
}

function SessionRow({ session: s, pinned, onPin, onOpen }: { session: OverviewSession; pinned: boolean; onPin: () => void; onOpen: () => void }) {
  const label = s.kind === 'task' ? `${taskKey(s.number || 0)} ${s.name}` : s.name;
  return (
    <li className="group relative flex items-center gap-2 rounded-ctl pl-4 pr-1.5 hover:bg-ink/4">
      <button type="button" className="session-open flex min-w-0 flex-1 cursor-pointer items-center gap-2 border-0 bg-transparent py-1.5 text-left text-[13px] text-ink" title={s.why || (s.updatedAt ? `Last change ${ago(s.updatedAt)}` : '')} onClick={onOpen}>
        <SessionMark session={s} />
        <span className="session-name min-w-0 flex-1 truncate">{label}</span>
      </button>
      <IconButton variant="plain" className={`size-6! flex-none ${pinned ? 'text-accent' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'}`} aria-label={pinned ? `Unpin ${label}` : `Pin ${label}`} aria-pressed={pinned} title={pinned ? 'Unpin' : 'Pin to the top'} onClick={onPin}>
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
                <div className="truncate text-[13.5px] text-ink">{s.kind === 'task' ? `${taskKey(s.number || 0)} ${s.name}` : s.name}{showProject ? <span className="text-faint">{` · ${p.name}`}</span> : null}</div>
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

export const title = () => 'Overview';
export const { render, unmount } = reactPage(() => <OverviewPage />);
