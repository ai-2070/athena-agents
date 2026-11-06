// Overview (#/overview): every project's agents, teams, the Brain and board tasks being worked on, in one
// sidebar, with what works and what needs you; this project, all projects, or one. Chats and Brains of any project
// open side by side on a strip where each keeps its width (overviewlayout.ts): 1 to 8 columns per view, pinned columns
// stay at the left, up to three panes stack in one column, and the rail at either edge shows what is off screen. A
// pane of a project that isn't open sends its requests to that project (projectAt, /api/p/<project>/…), so a copied
// project's agents and teams (the same ids) sit beside the originals. A project's Brain is a pane too (brainpane.tsx);
// the whole Brain chat is Ctrl+K. Terminals are left out for now (their panes still work). The plan:
// docs/internal/plans/OVERVIEW_LAYOUT_2026-11-03.md.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, DragEvent as ReactDragEvent, PointerEvent as ReactPointerEvent } from 'react';
import { ENGINE_LABEL, ago, approvalCard, h, attempt, confirmBox, navigate, onEvent, onReconnect, toast } from '../core.ts';
import { rpc, rpcAt } from '../client/rpc.ts';
import { apiUrl, projectAt } from '../client/connection.ts';
import { previewFile, previewTitle, revealLabel } from '../filepreview.tsx';
import { openChat } from '../chatwin.tsx';
import { openDock } from '../dock.tsx';
import { renderAgentChat } from '../agentchat.tsx';
import { renderTeamChat } from '../teamchat.tsx';
import { XTerm } from '../terminalview.tsx';
import { BrainPane } from '../brainpane.tsx';
import { reducedMotion } from '../motion.ts';
import { icon } from '../icons.ts';
import { useDragPreview } from '../taskmotion.ts';
import { isMac } from '../shortcuts.ts';
import { Button, IconButton } from '../ui/button.tsx';
import { iconButtonClass } from '../ui/classes.ts';
import { Dropdown, DropdownCheckboxItem, DropdownContent, DropdownGroup, DropdownItem, DropdownLabel, DropdownSeparator, DropdownTrigger } from '../ui/dropdown.tsx';
import { DomNode, Icon, reactPage, useAppState } from '../ui/react.tsx';
import { Skeleton, Bone } from '../ui/skeleton.tsx';
import { Tooltip } from '../ui/tooltip.tsx';
import { PILL, Pick, STATUSES, StatusIcon, WhoMark, confirmStop, openTaskComposer, taskHref, taskKey } from '../taskboard.tsx';
import { Card, DropGhost, askWhyBlocked, byRank, cardKey, errorText, place, ref, same, startedNote } from '../taskcard.tsx';
import type { Assignee, Placement } from '../taskcard.tsx';
import type { BoardChange } from '../../shared/api/taskboard.ts';
import type { Choice } from '../taskboard.tsx';
import { PER_VIEW_MAX, PER_VIEW_MIN, STACK_MAX, closePane, dropPane, evenOut, loadLayout, movePane, openPane, paneKey, panesInOrder, prune, resizeColumn, resizeStack, saveLayout, setPerView, stackPane, togglePin, unstackPane } from '../overviewlayout.ts';
import type { PaneRef, StripLayout } from '../overviewlayout.ts';
import type { BoardStatus, BoardTask, FolderListing, OverviewData, OverviewProject, OverviewSession, TaskBoardData } from '../../shared/types.ts';

type Sort = 'needs' | 'recent' | 'kind' | 'name' | 'mine';
const ORDER_KEY = 'dash-overview-order';
/** Your own order of each project's sessions (Sort: Your order), as kind/id keys. */
type Order = Record<string, string[]>;
const readOrder = (): Order => {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(ORDER_KEY) || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).filter((e): e is [string, string[]] => Array.isArray(e[1]) && e[1].every((x) => typeof x === 'string'))) : {};
  } catch {
    return {};
  }
};
const rowKey = (s: Pick<OverviewSession, 'kind' | 'id'>) => `${s.kind}/${s.id}`;
const SCOPE_KEY = 'dash-overview-scope';
const SORT_KEY = 'dash-overview-sort';
const PINS_KEY = 'dash-overview-pins';
const FOLDED_KEY = 'dash-overview-folded';
// what changes what the Overview shows (it is read again, a moment after)
const CHANGES = new Set(['agents', 'workflows', 'approvals', 'questions', 'runs', 'run', 'team', 'brief', 'board', 'project', 'projects', 'brain-chat', 'chat', 'terminals']);

const KIND_ORDER: Record<OverviewSession['kind'], number> = { brain: 0, agent: 1, team: 2, terminal: 3, task: 4 };
const STATUS_ORDER: Record<OverviewSession['status'], number> = { 'needs-you': 0, working: 1, idle: 2 };
const sessionKey = (p: OverviewProject, s: OverviewSession) => `${p.id}/${s.kind}/${s.id}`;
/** What a session opens as a pane: a chat, a terminal, or a project's Brain (tasks open on their page). */
const paneOf = (s: OverviewSession, projectId: string): PaneRef | null => (s.kind === 'task' ? null : { kind: s.kind, id: s.id, projectId });
const STRIP = 'all';
// Terminals aren't on the Overview for now (Terminals in the menu has them): they leave the list, and their panes go.
const withoutTerminals = (d: OverviewData): OverviewData => ({ ...d, projects: d.projects.map((p) => ({ ...p, sessions: p.sessions.filter((s) => s.kind !== 'terminal') })) });
const PANEL_KEY = 'dash-overview-panel';
// the list at the left and the panel at the right: as wide as you drag them (remembered in this browser)
const SIDE_WIDTH = { key: 'dash-overview-side-width', def: 320, min: 240, max: 560 };
const PANEL_WIDTH = { key: 'dash-overview-panel-width', def: 384, min: 300, max: 720 };
type StoredWidth = typeof SIDE_WIDTH;
function useStoredWidth(w: StoredWidth): [number, (n: number) => void] {
  const fit = (n: number) => Math.round(Math.min(w.max, Math.max(w.min, n)));
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem(w.key));
    return saved ? fit(saved) : w.def;
  });
  useEffect(() => localStorage.setItem(w.key, String(width)), [w.key, width]);
  return [width, (n: number) => setWidth(fit(n))];
}
/** The line at a side panel's edge: drag it (or use ← →) to make the panel wider or narrower; a double-click resets it.
 *  edge: which side of the panel it is on. */
function EdgeHandle({ label, edge, width, set, reset }: { label: string; edge: 'left' | 'right'; width: number; set: (n: number) => void; reset: number }) {
  const out = edge === 'right' ? 1 : -1;
  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const start = e.clientX;
    const from = width;
    const body = document.body.style;
    const move = (m: PointerEvent) => set(from + out * (m.clientX - start));
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      body.cursor = '';
      body.userSelect = '';
    };
    // (the resize cursor stays, and nothing is selected, while the pointer is anywhere)
    body.cursor = 'col-resize';
    body.userSelect = 'none';
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      className="edge-handle relative z-20 -mx-[3px] w-1.5 flex-none cursor-col-resize outline-none [transition:background-color_0.15s] hover:bg-accent/30 focus-visible:bg-accent/40 max-md:hidden"
      onPointerDown={down}
      onDoubleClick={() => set(reset)}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        set(width + out * (e.key === 'ArrowRight' ? 16 : -16));
      }}
    />
  );
}
type PanelId = 'needs' | 'tasks' | 'files';
/** The panels beside the strip, one at a time. Changes and pull requests can be added as more entries later. */
const PANELS: readonly { id: PanelId; label: string; icon: string }[] = [
  { id: 'needs', label: 'Needs you', icon: 'bell' },
  { id: 'tasks', label: 'Tasks', icon: 'kanban' },
  { id: 'files', label: 'Files', icon: 'folder' },
];

/** Opens a pane's folder in VS Code: an agent's own workspace, or the project folder for a team or a terminal. */
async function openInVSCode(ref: PaneRef, foreign: boolean): Promise<void> {
  const at = foreign ? projectAt(ref.projectId) : '';
  const r = await attempt(() => (ref.kind === 'agent' ? rpcAt(at).agents.openWorkspace({ id: ref.id, app: 'vscode' }) : rpc.projects.open({ id: ref.projectId, app: 'vscode' })));
  if (r?.message) toast(r.message);
}
// what each shortcut key types without modifiers
const PLAIN: Record<string, string> = { Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']' };
/** Ctrl+Alt that is really AltGr typing a character (Windows and Linux: [ { \ on a German keyboard, ó ś on a
 *  Polish one), so it isn't taken as a shortcut: the key types something else than it does on its own. (Not
 *  getModifierState('AltGraph'): browsers report it for a plain Ctrl+Alt too.) On a Mac, ⌃⌥ types nothing. */
export function typesCharacter(e: Pick<KeyboardEvent, 'key' | 'code'>, mac = isMac()): boolean {
  if (mac) return false;
  const plain = PLAIN[e.code] ?? /^(?:Key|Digit)(.)$/.exec(e.code)?.[1]?.toLowerCase();
  return !!e.key && e.key.length === 1 && !!plain && e.key.toLowerCase() !== plain;
}
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

/** The sessions in the order the sort asks for, pinned ones first. mine: your order (new ones after it, by kind). */
export function sortSessions(list: OverviewSession[], sort: Sort, pinned: (s: OverviewSession) => boolean, mine: string[] = []): OverviewSession[] {
  const place = (s: OverviewSession) => {
    const i = mine.indexOf(rowKey(s));
    return i < 0 ? mine.length + KIND_ORDER[s.kind] : i;
  };
  const by: Record<Sort, (a: OverviewSession, b: OverviewSession) => number> = {
    needs: (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.updatedAt - a.updatedAt,
    recent: (a, b) => b.updatedAt - a.updatedAt,
    kind: (a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.name.localeCompare(b.name),
    name: (a, b) => a.name.localeCompare(b.name),
    mine: (a, b) => place(a) - place(b),
  };
  return [...list].sort((a, b) => +pinned(b) - +pinned(a) || by[sort](a, b) || a.name.localeCompare(b.name));
}

function OverviewPage() {
  const [sideWidth, setSideWidth] = useStoredWidth(SIDE_WIDTH);
  const [panelWidth, setPanelWidth] = useStoredWidth(PANEL_WIDTH);
  const [data, setData] = useState<OverviewData | null>(null);
  const [error, setError] = useState('');
  const [scope, setScope] = useState(() => localStorage.getItem(SCOPE_KEY) || 'all');
  const [sort, setSort] = useState<Sort>(() => (['needs', 'recent', 'kind', 'name', 'mine'].includes(localStorage.getItem(SORT_KEY) || '') ? localStorage.getItem(SORT_KEY) as Sort : 'needs'));
  const [pins, setPins] = useState(() => readSet(PINS_KEY));
  const [folded, setFolded] = useState(() => readSet(FOLDED_KEY));
  const [search, setSearch] = useState('');
  const [order, setOrder] = useState(readOrder);
  /** Puts a dragged session before or after another in its project (Your order). */
  const reorder = (p: OverviewProject, sessions: OverviewSession[], from: string, onto: string, after: boolean) => setOrder((was) => {
    const keys = sessions.map(rowKey).filter((k) => k !== from);
    const at = keys.indexOf(onto);
    if (at < 0) return was;
    keys.splice(after ? at + 1 : at, 0, from);
    const next = { ...was, [p.id]: keys };
    localStorage.setItem(ORDER_KEY, JSON.stringify(next));
    return next;
  });
  const [panel, setPanel] = useState<PanelId | null>(() => (PANELS.some((x) => x.id === localStorage.getItem(PANEL_KEY)) ? localStorage.getItem(PANEL_KEY) as PanelId : null));
  const togglePanel = (id: PanelId) => setPanel((was) => {
    const next = was === id ? null : id;
    if (next) localStorage.setItem(PANEL_KEY, next);
    else localStorage.removeItem(PANEL_KEY);
    return next;
  });
  // the strip: chats and terminals of any project, side by side (one strip, saved in this browser)
  const [layout, setLayout] = useState<StripLayout | null>(null);
  const serial = useRef(0);
  // the request the data shown came from, and for each pane the newest request asked when it was opened: a pane
  // is left out as gone only by data asked for after it opened (a new terminal isn't in the reply already on its way)
  const loadedFrom = useRef(0);
  const openedAt = useRef(new Map<string, number>());

  const load = useCallback(async () => {
    const request = ++serial.current;
    try {
      const next = withoutTerminals(await rpc.status.overview());
      if (request === serial.current) (loadedFrom.current = request, setData(next), setError(''));
    } catch (e) {
      if (request === serial.current) setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    void load();
    // a moment after the last change, and at least every 2 s while changes keep coming (a streaming reply sends
    // one every few ms)
    let timer: ReturnType<typeof setTimeout> | undefined;
    let first = 0;
    const fire = () => ((timer = undefined), void load());
    const soon = () => {
      const now = Date.now();
      if (!timer) first = now;
      clearTimeout(timer);
      timer = setTimeout(fire, Math.max(0, Math.min(300, first + 2000 - now)));
    };
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
    const restored = saved.columns.length ? saved : loadLayout(active, active);
    for (const ref of panesInOrder(restored)) openedAt.current.set(paneKey(ref), 0);
    setLayout(restored);
  }, [active, layout]);
  useEffect(() => {
    if (!data || !layout) return;
    const keys = panesInOrder(layout).map(paneKey);
    for (const key of keys) if (!openedAt.current.has(key)) openedAt.current.set(key, serial.current);
    for (const key of [...openedAt.current.keys()]) if (!keys.includes(key)) openedAt.current.delete(key);
    const known = (ref: PaneRef) => (openedAt.current.get(paneKey(ref)) ?? 0) >= loadedFrom.current;
    const pruned = prune(layout, (ref) => known(ref) || !!data.projects.find((p) => p.id === ref.projectId)?.sessions.some((s) => s.kind === ref.kind && s.id === ref.id));
    if (pruned !== layout) setLayout(pruned);
  }, [data, layout]);
  useEffect(() => {
    if (layout) saveLayout(STRIP, layout);
  }, [layout]);
  // the chats of panes that closed go; all of them once the Overview does
  useEffect(() => {
    if (layout && active) dropChats(new Set(panesInOrder(layout).map((ref) => chatKey(ref, ref.projectId !== active))));
  }, [layout, active]);
  useEffect(() => () => dropChats(new Set()), []);
  const change = useCallback((fn: (l: StripLayout) => StripLayout) => setLayout((l) => (l ? fn(l) : l)), []);

  const pickScope = (v: string) => (localStorage.setItem(SCOPE_KEY, v), setScope(v));
  const pickSort = (v: string) => (localStorage.setItem(SORT_KEY, v), setSort(v as Sort));
  const toggleSet = (key: string, set: (fn: (was: Set<string>) => Set<string>) => void, storage: string) => set((was) => {
    const next = new Set(was);
    if (!next.delete(key)) next.add(key);
    saveSet(storage, next);
    return next;
  });

  /** Opens a session: a chat, a terminal or another project's Brain (of any project) as a pane, a task on its page,
   *  the open project's Brain in the Brain chat. */
  const openSession = (p: OverviewProject, s: OverviewSession) => {
    if (!data) return;
    const ref = paneOf(s, p.id);
    if (ref) return change((l) => openPane(l, ref));
    navigate(taskHref({ projectId: p.id, id: s.id }));
  };
  /** A double-click on one in the list closes its pane. */
  const closeSession = (p: OverviewProject, s: OverviewSession) => {
    const ref = paneOf(s, p.id);
    if (ref) change((l) => closePane(l, paneKey(ref)));
  };
  // the projects this scope shows (a project picked before and since removed: all of them)
  const projects = useMemo(() => {
    if (!data) return [];
    if (scope === 'here') return data.projects.filter((p) => p.id === data.active);
    const one = data.projects.filter((p) => p.id === scope);
    return one.length ? one : data.projects;
  }, [data, scope]);
  const q = search.trim().toLowerCase();
  const shown = projects.map((p) => ({ p, sessions: sortSessions(p.sessions.filter((s) => !q || `${label(s)} ${p.name}`.toLowerCase().includes(q)), sort, (s) => pins.has(sessionKey(p, s)), order[p.id]) }));
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
    { value: 'mine', label: 'Your order (drag)' },
  ];
  const open = (p: OverviewProject, s: OverviewSession) => void openSession(p, s);
  const panes = layout ? panesInOrder(layout).length : 0;
  return (
    <div className="flex h-[calc(100vh-56px)] min-h-0 max-md:h-auto max-md:flex-col">
      <aside aria-label="Projects and sessions" className="overview-sidebar flex w-(--side-w) flex-none flex-col gap-3 overflow-y-auto border-r border-line bg-panel p-2 max-md:w-full max-md:border-r-0 max-md:border-b" style={{ '--side-w': `${sideWidth}px` } as CSSProperties}>
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
            onClose={(s) => closeSession(p, s)}
            shownAsPane={(s) => !!layout && panesInOrder(layout).some((x) => x.projectId === p.id && x.kind === s.kind && x.id === s.id)}
            onMove={sort === 'mine' && !q ? (from, onto, after) => reorder(p, sessions, from, onto, after) : undefined}
          />
        ))}
        {q && !shown.some((x) => x.sessions.length) ? <p className="m-0 px-3 py-2 text-[12.5px] text-faint">Nothing matches "{search.trim()}".</p> : null}
      </aside>
      <EdgeHandle label="List width" edge="right" width={sideWidth} set={setSideWidth} reset={SIDE_WIDTH.def} />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex min-h-0 min-w-0 flex-1">
          {layout && panes ? (
            <Strip layout={layout} change={change} projects={data.projects} active={active} onNextNeeding={nextNeeding} />
          ) : (
            <main className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-8 py-7 max-md:px-4">
              <p className="m-0 text-[13px] text-dim">Click an agent, a team or the Brain, of any project, to open it here. They sit side by side and keep their width. A double-click in the list closes one.</p>
              <Section title="Needs you" empty="Nothing waits for you." items={needing} showProject={projects.length > 1} onOpen={open} />
              <Section title="Working now" empty="Nothing is working right now." items={working} showProject={projects.length > 1} onOpen={open} />
            </main>
          )}
          {panel ? <EdgeHandle label="Panel width" edge="left" width={panelWidth} set={setPanelWidth} reset={PANEL_WIDTH.def} /> : null}
          {panel ? (
            <aside aria-label={PANELS.find((x) => x.id === panel)!.label} className="overview-panel flex w-(--panel-w) flex-none flex-col border-l border-line bg-panel max-md:w-80" style={{ '--panel-w': `${panelWidth}px` } as CSSProperties}>
              <div className="flex flex-none items-center gap-2 border-b border-line px-3 py-2">
                <Icon name={PANELS.find((x) => x.id === panel)!.icon} size={14} className="text-dim" />
                <h2 className="m-0 flex-1 text-[13.5px] font-semibold text-ink">{PANELS.find((x) => x.id === panel)!.label}</h2>
                <IconButton variant="plain" className="size-7!" aria-label="Close the panel" title="Close" onClick={() => togglePanel(panel)}><Icon name="x" size={13} /></IconButton>
              </div>
              <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
                {panel === 'needs' ? <NeedsPanel projects={projects} active={active} needing={needing} onOpen={open} /> : null}
                {panel === 'tasks' ? <TasksPanel key={scope} scope={scope} data={data} /> : null}
                {panel === 'files' ? <FilesPanel projects={projects} active={active} /> : null}
              </div>
            </aside>
          ) : null}
        </div>
        <footer aria-label="Status" className="overview-status flex flex-none flex-wrap items-center gap-4 border-t border-line bg-bg px-4 py-1 text-[12.5px] text-dim">
          <Button variant="plain" size="tiny" className="-ml-2" onClick={nextNeeding} disabled={!needing.length} title={needing.length ? 'Open the next one that needs you (Ctrl+Alt+N)' : undefined}>
            <span className={`size-1.5 rounded-full ${needing.length ? 'bg-amber' : 'bg-line-2'}`} />
            <span className={needing.length ? 'text-amber' : ''}>{needing.length ? `${needing.length} need${needing.length === 1 ? 's' : ''} you` : 'Nothing needs you'}</span>
          </Button>
          <span className="inline-flex items-center gap-1.5">
            <span className={`size-1.5 rounded-full ${working.length ? 'bg-accent motion-safe:animate-pulse' : 'bg-line-2'}`} />
            {`${working.length} of ${all.filter((x) => x.s.kind !== 'brain' && x.s.kind !== 'terminal').length} working`}
          </span>
          {projects.length > 1 ? <span>{`${projects.length} projects`}</span> : null}
          <span className="ml-auto inline-flex items-center gap-1" aria-label="Panels">
            {PANELS.map((x) => (
              <Button key={x.id} variant="plain" size="tiny" aria-pressed={panel === x.id} className="aria-pressed:bg-panel-2 aria-pressed:text-ink" onClick={() => togglePanel(x.id)}>
                <Icon name={x.icon} size={12} />
                {x.label}
              </Button>
            ))}
          </span>
          {layout && panes ? <StripControls layout={layout} change={change} /> : null}
        </footer>
      </div>
    </div>
  );
}

// ---------- the sidebar ----------
function ProjectGroup({ project: p, sessions, open, folded, onFold, pinned, onPin, onOpen, onClose, shownAsPane, onMove }: {
  project: OverviewProject;
  sessions: OverviewSession[];
  open: boolean;
  folded: boolean;
  onFold: () => void;
  pinned: (s: OverviewSession) => boolean;
  onPin: (s: OverviewSession) => void;
  onOpen: (s: OverviewSession) => void;
  /** closes its pane (a double-click) */
  onClose: (s: OverviewSession) => void;
  shownAsPane: (s: OverviewSession) => boolean;
  /** Your order: a row dragged onto another goes before it (upper half) or after it */
  onMove?: (from: string, onto: string, after: boolean) => void;
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
      </div>
      {folded ? null : (
        <ul className="m-0 mt-0.5 flex list-none flex-col gap-0.5 p-0">
          {sessions.map((s) => <SessionRow key={rowKey(s)} session={s} pinned={pinned(s)} shown={shownAsPane(s)} onPin={() => onPin(s)} onOpen={() => onOpen(s)} onClose={() => onClose(s)} onMove={onMove ? (from, after) => onMove(from, rowKey(s), after) : undefined} />)}
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

/** A row's mark: the agent's emoji on a tint of its colour (an icon for the rest), with how it is doing on its
 *  corner: a breathing dot while it works, amber when it needs you. */
function SessionAvatar({ session: s }: { session: OverviewSession }) {
  const ico = s.kind === 'brain' ? 'brain' : s.kind === 'team' ? 'users' : s.kind === 'terminal' ? 'terminal' : s.kind === 'task' ? 'kanban' : 'bot';
  const tint = s.kind === 'agent' && s.color ? { background: `color-mix(in srgb, ${s.color} 16%, var(--color-panel-2))`, borderColor: `color-mix(in srgb, ${s.color} 35%, var(--color-line))` } : undefined;
  return (
    <span className="relative flex-none">
      <span aria-hidden="true" className="grid size-8 place-items-center rounded-[9px] border border-line bg-panel-2 text-[17px] leading-none text-dim" style={tint}>
        {s.kind === 'agent' && s.emoji ? s.emoji : <Icon name={ico} size={15} />}
      </span>
      {s.status === 'working' ? (
        <span className="session-status absolute -right-0.5 -bottom-0.5 grid size-2.5 place-items-center rounded-full bg-panel" title="Working" aria-label="Working"><span className="size-1.5 rounded-full bg-accent motion-safe:animate-pulse" /></span>
      ) : s.status === 'needs-you' ? (
        <span className="session-status absolute -right-0.5 -bottom-0.5 grid size-2.5 place-items-center rounded-full bg-panel" title={s.why || 'Needs you'} aria-label={`Needs you${s.why ? `: ${s.why}` : ''}`}><span className="size-1.5 rounded-full bg-amber" /></span>
      ) : null}
    </span>
  );
}

const KIND_LABEL: Record<OverviewSession['kind'], string> = { agent: 'Agent', team: 'Team', brain: 'Brain', terminal: 'Terminal', task: 'Task' };
/** A row's second line: what needs you, that it works, or what it is and when it last changed. */
function SessionLine({ session: s }: { session: OverviewSession }) {
  if (s.status === 'needs-you') return <span className="truncate text-amber">{s.why || 'Needs you'}</span>;
  if (s.status === 'working') return <span className="truncate text-accent">Working…</span>;
  const what = s.kind === 'agent' ? (s.engine && ENGINE_LABEL[s.engine]) || 'Agent' : KIND_LABEL[s.kind];
  return <span className="truncate">{[what, s.ended ? 'ended' : '', ago(s.updatedAt)].filter(Boolean).join(' · ')}</span>;
}

const ROW_DRAG = 'text/x-overview-session';
function SessionRow({ session: s, pinned, shown, onPin, onOpen, onClose, onMove }: { session: OverviewSession; pinned: boolean; shown: boolean; onPin: () => void; onOpen: () => void; onClose: () => void; onMove?: (from: string, after: boolean) => void }) {
  const [over, setOver] = useState<'before' | 'after' | null>(null);
  const half = (e: ReactDragEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return e.clientY - r.top > r.height / 2 ? 'after' : 'before';
  };
  const drag = onMove
    ? {
        draggable: true,
        onDragStart: (e: ReactDragEvent<HTMLLIElement>) => {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData(ROW_DRAG, rowKey(s));
        },
        onDragOver: (e: ReactDragEvent<HTMLLIElement>) => {
          if (!e.dataTransfer.types.includes(ROW_DRAG)) return;
          e.preventDefault();
          setOver(half(e));
        },
        onDragLeave: () => setOver(null),
        onDrop: (e: ReactDragEvent<HTMLLIElement>) => {
          const from = e.dataTransfer.getData(ROW_DRAG);
          const where = half(e);
          setOver(null);
          if (!from || from === rowKey(s)) return;
          e.preventDefault();
          onMove(from, where === 'after');
        },
      }
    : {};
  return (
    <li {...drag} className={`group relative flex items-center gap-1 rounded-box pr-1.5 pl-2 [transition:background-color_0.15s] hover:bg-ink/5 ${shown ? 'bg-ink/4' : ''} ${onMove ? 'cursor-grab' : ''} ${over === 'before' ? 'shadow-[inset_0_2px_0_var(--color-accent)]' : over === 'after' ? 'shadow-[inset_0_-2px_0_var(--color-accent)]' : ''}`}>
      {/* (open on the strip: a line of the accent at its left) */}
      {shown ? <span aria-hidden="true" className="absolute top-2.5 bottom-2.5 left-0 w-0.5 rounded-full bg-accent" /> : null}
      <button type="button" className="session-open flex min-w-0 flex-1 cursor-pointer items-center gap-3 border-0 bg-transparent py-2 text-left" title={s.why || (s.updatedAt ? `Last change ${ago(s.updatedAt)}` : '')} aria-current={shown ? 'true' : undefined} onClick={onOpen} onDoubleClick={onClose}>
        <SessionAvatar session={s} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="session-name truncate text-[13.5px] leading-5 font-medium text-ink">{label(s)}</span>
          <span className="flex min-w-0 text-[11.5px] leading-4 text-faint"><SessionLine session={s} /></span>
        </span>
      </button>
      <IconButton variant="plain" className={`size-6! flex-none ${pinned ? 'text-accent' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'}`} aria-label={pinned ? `Unpin ${label(s)}` : `Pin ${label(s)}`} aria-pressed={pinned} title={pinned ? 'Unpin' : 'Pin to the top'} onClick={onPin}>
        <Icon name="star" size={12} />
      </IconButton>
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

// ---------- the panels ----------
/** Needs you: approvals to decide right here, then the rest that waits for you (questions, stopped work, tasks). */
function NeedsPanel({ projects, active, needing, onOpen }: { projects: OverviewProject[]; active: string; needing: { p: OverviewProject; s: OverviewSession }[]; onOpen: (p: OverviewProject, s: OverviewSession) => void }) {
  const app = useAppState();
  const shown = new Set(projects.map((p) => p.id));
  const approvals = (app?.approvals || []).filter((a) => shown.has(a.projectId || active));
  const rest = needing.filter(({ s }) => !s.why?.startsWith('Approval: '));
  return (
    <div className="flex flex-col gap-4 p-3">
      {approvals.map((a) => <DomNode key={a.id} className="overview-approval" make={() => approvalCard(a)} deps={[a.id]} />)}
      {rest.length || !approvals.length ? <Section title={approvals.length ? 'And' : 'Waiting for you'} empty="Nothing waits for you." items={rest} showProject={projects.length > 1} onOpen={onOpen} /> : null}
    </div>
  );
}

// the panel's statuses, in the order it lists them (what is being worked on first); the open ones unless you pick
const TASK_GROUPS: BoardStatus[] = ['in_progress', 'todo', 'in_review', 'blocked', 'done'];
const OPEN_GROUPS = TASK_GROUPS.filter((x) => x !== 'done');
const TASK_STATUS_KEY = 'dash-overview-task-statuses';
// Done shows what was finished lately, as on the board
const DONE_RECENT_MS = 14 * 86_400_000;
function loadStatuses(): BoardStatus[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(TASK_STATUS_KEY) || 'null');
    if (Array.isArray(saved)) return TASK_GROUPS.filter((x) => saved.includes(x));
  } catch {
    // (unreadable: the open ones)
  }
  return OPEN_GROUPS;
}
const statusLabel = (x: BoardStatus) => STATUSES.find((o) => o.value === x)!.label;

/** Which statuses the Tasks panel shows: several at once, each with a check; the menu stays open while you pick. */
function StatusFilter({ value, onChange }: { value: BoardStatus[]; onChange: (v: BoardStatus[]) => void }) {
  const all = value.length === TASK_GROUPS.length;
  const open = !all && value.length === OPEN_GROUPS.length && OPEN_GROUPS.every((x) => value.includes(x));
  const label = all ? 'All statuses' : open ? 'Open tasks' : value.length === 1 ? statusLabel(value[0]) : value.length ? `${value.length} statuses` : 'No status';
  return (
    <Dropdown>
      <DropdownTrigger className={PILL} aria-label={`Statuses shown: ${label}`}>
        {value.length === 1 ? <StatusIcon status={value[0]} size={14} /> : <Icon name="list-checks" size={14} className="text-faint" />}
        <span className="min-w-0 truncate">{label}</span>
      </DropdownTrigger>
      <DropdownContent align="start" className="min-w-52">
        <DropdownGroup>
          <DropdownLabel>Show</DropdownLabel>
          {STATUSES.map((o) => (
            <DropdownCheckboxItem key={o.value} checked={value.includes(o.value)} onCheckedChange={(on) => onChange(on ? [...value, o.value] : value.filter((x) => x !== o.value))} icon={<StatusIcon status={o.value} size={14} />}>
              {o.value === 'done' ? 'Done (last 14 days)' : o.label}
            </DropdownCheckboxItem>
          ))}
        </DropdownGroup>
        <DropdownSeparator />
        <DropdownItem onClick={() => onChange(OPEN_GROUPS)}>Open tasks only</DropdownItem>
        <DropdownItem onClick={() => onChange(TASK_GROUPS)}>Every status</DropdownItem>
      </DropdownContent>
    </Dropdown>
  );
}

/** Tasks: the board's tasks for what is shown (this project, all of them or one), by status, on the Tasks board's own
 *  cards. A click opens one, its menu moves or removes it, the mark at its corner gives it to someone, and a card
 *  dragged to another status moves it there. Each change shows at once, is saved, then read again. */
function TasksPanel({ scope, data }: { scope: string; data: OverviewData }) {
  const project = scope === 'here' ? data.active : scope === 'all' || !data.projects.some((p) => p.id === scope) ? 'all' : scope;
  const [board, setBoard] = useState<TaskBoardData | null>(null);
  const [statuses, setStatuses] = useState(loadStatuses);
  const pickStatuses = (v: BoardStatus[]) => {
    const ordered = TASK_GROUPS.filter((x) => v.includes(x));
    setStatuses(ordered);
    localStorage.setItem(TASK_STATUS_KEY, JSON.stringify(ordered));
  };
  const [dragging, setDragging] = useState<BoardTask | null>(null);
  const [drop, setDrop] = useState<{ status: BoardStatus; index: number } | null>(null);
  const [slot, setSlot] = useState(80);
  const root = useRef<HTMLDivElement>(null);
  useDragPreview(root);
  // (not read again under a card being dragged: once the drag is over)
  const held = useRef({ drag: false, missed: false });
  const load = useCallback(() => {
    if (held.current.drag) return void (held.current.missed = true);
    void rpc.taskBoard.list({ project }).then(setBoard, () => setBoard({ projects: [], tasks: [], tags: {} }));
  }, [project]);
  useEffect(() => {
    load();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = onEvent((e) => e.type === 'board' && (clearTimeout(timer), (timer = setTimeout(load, 200))));
    return () => (clearTimeout(timer), off());
  }, [load]);
  useEffect(() => {
    held.current.drag = !!dragging;
    if (!dragging && held.current.missed) (held.current.missed = false, load());
    if (!dragging) return;
    // (a drag whose end never came: the next press ends it)
    const end = () => (setDragging(null), setDrop(null));
    document.addEventListener('pointerdown', end, true);
    return () => document.removeEventListener('pointerdown', end, true);
  }, [dragging, load]);

  const many = project === 'all' && data.projects.length > 1;
  const where = scope === 'here' ? 'This project' : project === 'all' ? 'All projects' : data.projects.find((p) => p.id === project)?.name || 'This project';
  const tasks = board?.tasks || [];
  const columnOf = (status: BoardStatus, without?: BoardTask) => tasks.filter((t) => t.status === status && !(without && same(t, without))).sort(byRank);
  const now = Date.now();
  const shownOf = (status: BoardStatus) => columnOf(status).filter((t) => status !== 'done' || now - (t.doneAt || t.updatedAt) < DONE_RECENT_MS);
  const shownCount = statuses.reduce((n, x) => n + shownOf(x).length, 0);
  const save = async (t: BoardTask, patch: BoardChange, respaced: Placement['respaced'] = []) => {
    try {
      if (respaced.length) await rpc.taskBoard.rerank({ ranks: respaced.map((r) => ({ projectId: r.task.projectId, id: r.task.id, status: r.task.status, rank: r.rank })) });
      startedNote(t, (await rpc.taskBoard.change({ ...ref(t), ...patch, expectedUpdatedAt: t.updatedAt })).task);
    } catch (e) {
      toast(errorText(e), 'error');
    }
    load();
  };
  /** Moves a card (shown at once). As on the board: leaving In progress stops the work, after asking; Blocked asks why. */
  const move = async (t: BoardTask, status: BoardStatus, { rank, respaced }: Placement) => {
    if (status === t.status && rank === t.rank && !respaced.length) return;
    if (status !== 'in_progress' && !(await confirmStop(t))) return;
    const why = status === 'blocked' && t.status !== 'blocked' ? await askWhyBlocked(t) : undefined;
    if (why === null) return;
    const patch = { status, rank, ...(why !== undefined ? { blockedReason: why } : {}) };
    const room = new Map(respaced.map((r) => [cardKey(r.task), r.rank]));
    setBoard((b) => (b ? { ...b, tasks: b.tasks.map((x) => (same(x, t) ? { ...x, ...patch, ...(status === 'done' && x.status !== 'done' ? { doneAt: Date.now() } : {}) } : room.has(cardKey(x)) ? { ...x, rank: room.get(cardKey(x))! } : x)) } : b));
    await save(t, patch, respaced);
  };
  // a place in a status as it is shown: between the shown cards either side of it, among all of that status's cards
  const placeAt = (status: BoardStatus, index: number, t: BoardTask) => {
    const others = shownOf(status).filter((x) => !same(x, t));
    return place(columnOf(status, t), others[index - 1], others[index]);
  };
  const toColumn = (t: BoardTask, status: BoardStatus) => void move(t, status, placeAt(status, 0, t));
  const step = (t: BoardTask, dir: -1 | 1) => {
    const list = shownOf(t.status);
    const j = list.findIndex((x) => same(x, t)) + dir;
    if (j >= 0 && j < list.length) void move(t, t.status, placeAt(t.status, j, t));
  };
  const onDrop = (status: BoardStatus) => {
    const t = dragging;
    const at = drop;
    setDragging(null);
    setDrop(null);
    if (t && at && at.status === status) void move(t, status, placeAt(status, at.index, t));
  };
  const assign = async (t: BoardTask, who: Assignee) => {
    if (who.assignee === t.assignee || !(await confirmStop(t))) return;
    setBoard((b) => (b ? { ...b, tasks: b.tasks.map((x) => (same(x, t) ? { ...x, ...who } : x)) } : b));
    await save(t, { assignee: who.assignee });
  };
  const remove = async (t: BoardTask) => {
    if (!(await confirmStop(t)) || !(await confirmBox(`Remove ${taskKey(t.number)} "${t.title}"?`, { ok: 'Remove', danger: true }))) return;
    setBoard((b) => (b ? { ...b, tasks: b.tasks.filter((x) => !same(x, t)) } : b));
    await attempt(() => rpc.taskBoard.remove(ref(t)));
    load();
  };
  const compose = () => openTaskComposer({ projectId: project === 'all' ? data.active : project, projects: data.projects.map((p) => ({ id: p.id, name: p.name })), onCreated: load });
  return (
    <div ref={root} className="flex flex-col gap-5 p-3">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" size="small" onClick={compose}>
            <Icon name="plus" size={13} />
            New task
          </Button>
          <StatusFilter value={statuses} onChange={pickStatuses} />
        </div>
        {/* (the Show picker at the top of the list decides which projects) */}
        <p className="m-0 px-0.5 text-[12px] text-faint">{board ? `${where} · ${shownCount} task${shownCount === 1 ? '' : 's'}` : where}</p>
      </div>
      {!board ? (
        <Skeleton label="Loading the tasks…" className="flex flex-col gap-1.5">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex flex-col gap-3 rounded-[10px] border border-line bg-bg p-3">
              <Bone className={`h-4 ${i % 2 ? 'w-1/2' : 'w-4/5'}`} />
              <Bone className="h-3 w-20" />
            </div>
          ))}
        </Skeleton>
      ) : !statuses.length ? (
        <p className="m-0 rounded-box border border-dashed border-line-2 px-4 py-8 text-center text-[13px] text-dim">Pick a status above to see its tasks.</p>
      ) : (
        statuses.map((status) => {
          const list = shownOf(status);
          const label = statusLabel(status);
          const index = drop?.status === status ? drop.index : null;
          const others = list.filter((t) => !dragging || !same(t, dragging));
          const home = dragging && dragging.status === status ? list.findIndex((t) => same(t, dragging)) : -1;
          // dropping a card where it already is changes nothing: no gap there
          const gap = index !== null && index !== home ? index : null;
          return (
            <section
              key={status}
              aria-label={label}
              data-status={status}
              className="flex flex-col gap-1.5"
              onDragOver={(e) => {
                if (!dragging) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                const cards = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-task-id]')].filter((el) => el.dataset.taskId !== cardKey(dragging));
                const at = cards.findIndex((el) => {
                  const r = el.getBoundingClientRect();
                  return e.clientY < r.top + r.height / 2;
                });
                const next = at === -1 ? cards.length : at;
                setDrop((d) => (d?.status === status && d.index === next ? d : { status, index: next }));
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrop((d) => (d?.status === status ? null : d));
              }}
              onDrop={(e) => {
                e.preventDefault();
                onDrop(status);
              }}
            >
              <h3 className="m-0 flex items-center gap-2 px-1 text-[13px] font-semibold text-ink">
                <StatusIcon status={status} size={14} />
                {label}
                <span className="rounded-full bg-ink/6 px-1.5 text-[11px] leading-[18px] font-normal text-dim tabular-nums">{list.length}</span>
              </h3>
              <ul className={`m-0 flex list-none flex-col gap-1.5 rounded-box p-1.5 [transition:background-color_0.15s,box-shadow_0.15s] ${index !== null ? 'bg-accent/6 shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-accent)_35%,transparent)]' : 'bg-ink/[0.025]'}`}>
                {list.map((t, i) => [
                  gap !== null && dragging && others.indexOf(t) === gap ? <DropGhost key={`slot-${cardKey(t)}`} task={dragging} height={slot} /> : null,
                  <Card
                    key={cardKey(t)}
                    task={t}
                    showProject={many}
                    first={i === 0}
                    last={i === list.length - 1}
                    dragging={!!dragging && same(dragging, t)}
                    onDragStart={(el) => (setSlot(el.getBoundingClientRect().height), setDragging(t))}
                    onDragEnd={() => (setDragging(null), setDrop(null))}
                    onColumn={(x) => toColumn(t, x)}
                    onStep={(d) => step(t, d)}
                    onRemove={() => void remove(t)}
                    onAssign={(who) => void assign(t, who)}
                  />,
                ])}
                {gap !== null && dragging && gap >= others.length ? <DropGhost task={dragging} height={slot} /> : null}
                {!list.length && gap === null ? <li className="px-3 py-3 text-center text-[12px] text-faint">{dragging ? 'Drop here' : status === 'done' ? 'Nothing done in the last 14 days' : 'No tasks'}</li> : null}
              </ul>
            </section>
          );
        })
      )}
    </div>
  );
}

const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
/** Files: a project's folder, one level at a time; files open with the previews (another project's in a new tab). */
function FilesPanel({ projects, active }: { projects: OverviewProject[]; active: string }) {
  // the project picked and the folder in it; a project the scope no longer shows gives way to one it does (from its top)
  const first = () => (projects.some((p) => p.id === active) ? active : projects[0]?.id || active);
  const [place, setPlace] = useState(() => ({ project: first(), rel: '' }));
  const projectId = projects.some((p) => p.id === place.project) ? place.project : first();
  const rel = place.project === projectId ? place.rel : '';
  const setRel = (next: string) => setPlace({ project: projectId, rel: next });
  const setProjectId = (next: string) => setPlace({ project: next, rel: '' });
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    setListing(null);
    rpc.projects.folder({ id: projectId, path: rel }).then((l) => live && (setListing(l), setError('')), (e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => void (live = false);
  }, [projectId, rel]);
  const project = projects.find((p) => p.id === projectId);
  const parts = rel ? rel.split('/') : [];
  const openFile = (path: string, name: string) => {
    if (projectId === active && previewTitle(name)) return previewFile(path, name);
    window.open(apiUrl(`${projectId === active ? '' : projectAt(projectId)}/file`, { path }), '_blank', 'noopener');
  };
  const openFolder = async (app?: 'vscode') => {
    const r = await attempt(() => rpc.projects.open({ id: projectId, path: rel, ...(app ? { app } : {}) }));
    if (r?.message) toast(r.message);
  };
  return (
    <div className="flex flex-col gap-2 p-3">
      {projects.length > 1 ? <Pick label="Project" value={projectId} choices={projects.map((p) => ({ value: p.id, label: p.name, mark: <Icon name="folder" size={14} className="text-faint" /> }))} onChange={setProjectId} /> : null}
      <nav aria-label="Folder" className="flex min-w-0 flex-wrap items-center gap-1 text-[12.5px]">
        <button type="button" className="cursor-pointer border-0 bg-transparent p-0 font-medium text-dim hover:text-ink" onClick={() => setRel('')}>{project?.name || 'Project'}</button>
        {parts.map((part, i) => (
          <span key={`${i}/${part}`} className="inline-flex items-center gap-1">
            <Icon name="chevron-right" size={11} className="text-faint" />
            <button type="button" className="cursor-pointer border-0 bg-transparent p-0 text-dim hover:text-ink" onClick={() => setRel(parts.slice(0, i + 1).join('/'))}>{part}</button>
          </span>
        ))}
      </nav>
      <div className="flex flex-wrap gap-1.5">
        <Button variant="ghost" size="tiny" onClick={() => void openFolder('vscode')}><Icon name="code" size={12} />Open in VS Code</Button>
        <Button variant="ghost" size="tiny" onClick={() => void openFolder()}><Icon name="folder-open" size={12} />{revealLabel()}</Button>
      </div>
      {error ? <p className="m-0 text-[12.5px] text-red">{error}</p> : null}
      {!listing && !error ? <p className="m-0 text-[12.5px] text-faint">Loading…</p> : null}
      {listing ? (
        <ul className="overview-files m-0 flex list-none flex-col p-0">
          {listing.entries.map((e) => (
            <li key={e.rel}>
              <button type="button" className="flex w-full cursor-pointer items-center gap-2 rounded-ctl border-0 bg-transparent px-2 py-1.5 text-left text-[13px] text-ink hover:bg-ink/4" onClick={() => (e.dir ? setRel(e.rel) : openFile(e.path, e.name))} title={e.dir ? `Open ${e.name}` : previewTitle(e.name) || `Open ${e.name}`}>
                <Icon name={e.dir ? 'folder' : 'file'} size={13} className="flex-none text-faint" />
                <span className="min-w-0 flex-1 truncate">{e.name}</span>
                {e.dir ? <Icon name="chevron-right" size={11} className="flex-none text-faint" /> : <span className="flex-none text-[11.5px] text-faint tabular-nums">{size(e.size || 0)}</span>}
              </button>
            </li>
          ))}
          {!listing.entries.length ? <li className="px-2 py-1.5 text-[12.5px] text-faint">This folder is empty.</li> : null}
          {listing.more ? <li className="px-2 py-1.5 text-[12px] text-faint">{`${listing.more} more not listed.`}</li> : null}
        </ul>
      ) : null}
    </div>
  );
}

// ---------- the strip ----------
type Change = (fn: (l: StripLayout) => StripLayout) => void;

/** The columns control and the minimap, in the status line. */
function StripControls({ layout, change }: { layout: StripLayout; change: Change }) {
  return (
    <span className="inline-flex items-center gap-3">
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
  const keys = useRef({ layout, change, onNextNeeding, active });
  keys.current = { layout, change, onNextNeeding, active };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || !e.altKey || e.metaKey || typesCharacter(e)) return;
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
      if (e.code === 'KeyO') {
        const ref = panesInOrder(l).find((p) => paneKey(p) === focus);
        if (ref) (e.preventDefault(), void openInVSCode(ref, ref.projectId !== keys.current.active));
      }
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
            <Tooltip key={paneKey(ref)} side={side === 'left' ? 'right' : 'left'} label={`${s?.name || ref.id}${s?.status === 'needs-you' ? ' · needs you' : s?.status === 'working' ? ' · working' : ''}`}>
            <button type="button" className="pointer-events-auto relative cursor-pointer rounded-[8px] border-0 bg-transparent p-0 shadow-raised" aria-label={`Go to ${s?.name || ref.id}`} onClick={() => change((l) => ({ ...l, focus: paneKey(ref) }))}>
              <SessionMark session={s || { kind: ref.kind, id: ref.id }} size={22} />
              {s?.status === 'needs-you' ? <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-amber" /> : s?.status === 'working' ? <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-accent" /> : null}
            </button>
            </Tooltip>
          );
        })}
      </div>
    ) : null;

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1">
      {/* (it comes to rest at a pane's edge, never half-way through one; pinned ones stay out of the way) */}
      <div ref={scroller} className="strip flex min-h-0 min-w-0 flex-1 snap-x snap-mandatory overflow-x-auto overflow-y-hidden [scrollbar-width:thin]" style={{ scrollPaddingLeft: pinnedWidth }}>
        {layout.columns.map((c, i) => (
          <StripColumnView
            key={paneKey(c.panes[0])}
            index={i}
            column={c}
            style={{ width: spans[i]?.w || colPx, ...(c.pinned ? { position: 'sticky', left: spans.slice(0, i).filter((s) => s.pinned).reduce((n, s) => n + s.w, 0), zIndex: 10 } : {}) }}
            focus={layout.focus}
            drawn={(ref) => ref.kind === 'terminal' || ref.kind === 'brain' || near(i)}
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
    <div ref={box} className={`strip-column relative flex h-full flex-none flex-col bg-bg ${c.pinned ? 'border-r border-line shadow-card' : 'snap-start'}`} style={style} data-pinned={c.pinned || undefined}>
      {c.panes.map((ref, row) => (
        <Pane key={paneKey(ref)} paneRef={ref} projectName={projectName(ref)} share={c.heights[row] ?? 1 / c.panes.length} stacked={c.panes.length > 1} pinned={c.pinned} focused={focus === paneKey(ref)} drawn={drawn(ref)} session={status(ref)} change={change} canStack={row === 0 && canStack} resizeBelow={row < c.panes.length - 1 ? resizeHeight(row) : undefined} />
      ))}
      <div role="separator" aria-orientation="vertical" aria-label="Column width" className="absolute top-0 right-0 bottom-0 z-10 w-1.5 cursor-col-resize hover:bg-accent/30" onPointerDown={resizeWidth} />
    </div>
  );
}

const DRAG_TYPE = 'text/x-overview-pane';
const DROP_LABEL = 'rounded-full bg-accent px-2.5 py-1 text-[12px] font-medium whitespace-nowrap text-on-accent shadow-raised';

/** What a dragged pane will do where it is: a line of the accent at the side it goes to, or a dashed place in the
 *  lower half to stack under this one, each with a label. */
function DropMark({ how, name }: { how: 'before' | 'after' | 'stack'; name: string }) {
  return (
    <div aria-hidden="true" className="drop-mark pointer-events-none absolute inset-0 z-20 animate-[fade_0.12s_ease-out]">
      {how === 'stack' ? (
        <div className="absolute inset-x-2 top-1/2 bottom-2 grid place-items-center rounded-box border-2 border-dashed border-accent/60 bg-accent/8">
          <span className={DROP_LABEL}>{`Stack under ${name}`}</span>
        </div>
      ) : (
        <>
          <div className={`absolute inset-y-2 w-[3px] rounded-full bg-accent ${how === 'before' ? 'left-1' : 'right-1'}`} />
          <span className={`${DROP_LABEL} absolute top-1/2 -translate-y-1/2 ${how === 'before' ? 'left-3' : 'right-3'}`}>{how === 'before' ? 'Put before' : 'Put after'}</span>
        </>
      )}
    </div>
  );
}

/** The card a dragged pane shows under the pointer: its mark and name (off screen; the browser takes a picture of it). */
function dragChip(s: Pick<OverviewSession, 'kind' | 'id' | 'emoji'>, name: string): HTMLElement {
  const mark = s.kind === 'agent' && s.emoji ? h('span', { class: 'text-[15px] leading-none' }, s.emoji) : icon(s.kind === 'brain' ? 'brain' : s.kind === 'team' ? 'users' : s.kind === 'terminal' ? 'terminal' : 'bot', 15, 'text-dim');
  return h('div', { class: 'fixed -top-[200px] left-0 flex items-center gap-2 rounded-full border border-line bg-raise py-1.5 pr-3.5 pl-2.5 text-[13px] font-medium text-ink shadow-pop' }, mark, name);
}

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
  // being dragged: it fades, and shows no drop marks of its own
  const [lifted, setLifted] = useState(false);
  const name = s?.name || (ref.kind === 'terminal' ? 'Terminal' : ref.id);
  const zone = (e: ReactDragEvent<HTMLElement>): 'before' | 'after' | 'stack' => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - r.left) / (r.width || 1);
    return x < 0.25 ? 'before' : x > 0.75 ? 'after' : 'stack';
  };
  const endTerminal = async () => {
    if (!(await confirmBox(`End the terminal "${name}"? What runs in it stops.`, { ok: 'End terminal', danger: true }))) return;
    if (await attempt(() => rpc.terminals.close({ id: ref.id }))) change((l) => closePane(l, key));
  };
  return (
    <>
      <section
        aria-label={name}
        data-pane={key}
        className={`strip-pane relative flex min-h-0 flex-col border-l border-line [transition:opacity_0.15s] ${focused ? 'outline-1 -outline-offset-1 outline-accent/60' : ''} ${lifted ? 'opacity-40' : ''}`}
        style={{ flex: `${share} 1 0` }}
        onPointerDownCapture={() => !focused && change((l) => ({ ...l, focus: key }))}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes(DRAG_TYPE) || lifted) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          const next = zone(e);
          setOver((was) => (was === next ? was : next));
        }}
        // (moving onto something inside the pane isn't leaving it)
        onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setOver(null)}
        onDrop={(e) => {
          const from = e.dataTransfer.getData(DRAG_TYPE);
          const how = zone(e);
          setOver(null);
          if (!from || from === key) return;
          e.preventDefault();
          change((l) => dropPane(l, from, key, how) ?? l);
        }}
      >
        {/* the header is the handle: drag it onto another pane */}
        <header
          className="flex flex-none cursor-grab items-center gap-2 border-b border-line bg-panel px-2 py-1.5 active:cursor-grabbing"
          draggable
          title="Drag onto another pane: its sides put it before or after, its middle stacks it"
          onDragStart={(e) => {
            if ((e.target as HTMLElement).closest('button')) return e.preventDefault();
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData(DRAG_TYPE, key);
            // (a small card with its name under the pointer, not the browser's see-through copy of the whole pane)
            const chip = dragChip(s || { kind: ref.kind, id: ref.id }, name);
            document.body.append(chip);
            e.dataTransfer.setDragImage?.(chip, 16, 16);
            setTimeout(() => chip.remove());
            setLifted(true);
          }}
          onDragEnd={() => setLifted(false)}
        >
          <span className="grid size-5 flex-none place-items-center text-faint hover:text-ink" aria-hidden="true">
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
              <DropdownItem icon="arrow-left" onClick={() => change((l) => movePane(l, key, -1))}>Move left</DropdownItem>
              <DropdownItem icon="arrow-right" onClick={() => change((l) => movePane(l, key, 1))}>Move right</DropdownItem>
              {ref.kind === 'brain' && !projectName ? <DropdownItem icon="sparkles" onClick={() => openDock()}>Open in the Brain chat</DropdownItem> : null}
              {(ref.kind === 'agent' || ref.kind === 'team') && !projectName ? <DropdownItem icon="external-link" onClick={() => (openChat(ref.kind === 'agent' ? 'agent' : 'team', ref.id), change((l) => closePane(l, key)))}>Open in a chat window</DropdownItem> : null}
              <DropdownItem icon="code" onClick={() => void openInVSCode(ref, !!projectName)}>Open folder in VS Code</DropdownItem>
              <DropdownSeparator />
              {ref.kind === 'terminal' && !s?.ended ? <DropdownItem icon="square" danger onClick={() => void endTerminal()}>End terminal</DropdownItem> : null}
              <DropdownItem icon="x" onClick={() => change((l) => closePane(l, key))}>Close</DropdownItem>
            </DropdownContent>
          </Dropdown>
        </header>
        <div className="flex min-h-0 flex-1 flex-col">
          {drawn ? <PaneBody paneRef={ref} foreign={!!projectName} projectName={projectName || 'This project'} change={change} /> : <div className="grid flex-1 place-items-center text-[12px] text-faint">{name}</div>}
        </div>
        {over ? <DropMark how={over} name={name} /> : null}
      </section>
      {resizeBelow ? <div role="separator" aria-orientation="horizontal" aria-label="Pane height" className="h-1.5 flex-none cursor-row-resize border-l border-line bg-line/40 hover:bg-accent/30" onPointerDown={resizeBelow} /> : null}
    </>
  );
}

// The chats on the strip. Each is its own React root, drawn into an element of its own that outlives the pane's
// place: moving the pane to another column, stacking it or scrolling it out of reach moves that element, so a
// half-written message and the files attached to it stay. A chat is taken down when its pane closes, or the Overview.
const liveChats = new Map<string, { el: HTMLDivElement; api: { destroy: () => void } }>();
const chatKey = (ref: PaneRef, foreign: boolean) => `${paneKey(ref)}${foreign ? '|elsewhere' : ''}`;
function liveChat(ref: PaneRef, foreign: boolean): HTMLDivElement {
  const key = chatKey(ref, foreign);
  const known = liveChats.get(key);
  if (known) return known.el;
  const el = document.createElement('div');
  el.className = 'flex min-h-0 flex-1 flex-col *:min-h-0 *:flex-1';
  const scoped = foreign ? { projectId: ref.projectId } : {};
  const api = ref.kind === 'agent' ? renderAgentChat(el, ref.id, scoped) : renderTeamChat(el, ref.id, { fill: true, ...scoped });
  liveChats.set(key, { el, api });
  return el;
}
/** Takes down the chats whose pane is gone (keep: the chat keys of the panes there are). */
function dropChats(keep: ReadonlySet<string>): void {
  for (const [key, chat] of liveChats) {
    if (keep.has(key)) continue;
    liveChats.delete(key);
    chat.el.remove();
    // (its own React root: taken down after the render that closed the pane)
    setTimeout(() => chat.api.destroy());
  }
}

/** What a pane shows: an agent's chat or a team's thread (the components the chat windows use), a terminal, or a
 *  project's Brain. A chat of a project that isn't open (foreign) sends its requests to that project. */
function PaneBody({ paneRef: ref, foreign, projectName, change }: { paneRef: PaneRef; foreign: boolean; projectName: string; change: Change }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.kind === 'terminal' || ref.kind === 'brain') return;
    const at = host.current!;
    const el = liveChat(ref, foreign);
    at.appendChild(el);
    return () => void (el.parentNode === at && el.remove());
  }, [ref.kind, ref.id, ref.projectId, foreign]);
  if (ref.kind === 'terminal') return <XTerm id={ref.id} className="min-h-0 flex-1 bg-bg px-2 py-1" />;
  if (ref.kind === 'brain') return <div className="flex min-h-0 flex-1 flex-col px-3 pt-1 pb-3"><BrainPane projectId={ref.projectId} projectName={projectName} here={!foreign} onOpen={(kind, id) => change((l) => openPane(l, { kind, id, projectId: ref.projectId }))} /></div>;
  return <div ref={host} className="strip-chat flex min-h-0 flex-1 flex-col px-3 pt-1 pb-3" />;
}

export const flush = true;
// (the sidebar folds to its icons: room for one more pane)
export const slimNav = true;
// (the Brain opens as a pane here, or with Ctrl+K / ⌘K: its button would cover the panes' message boxes)
export const brainButton = false;
export const title = () => 'Overview';
export const { render, unmount } = reactPage(() => <OverviewPage />);
