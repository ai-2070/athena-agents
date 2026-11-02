// The Tasks board (#/tasks) and a task's own page (#/tasks/<project>/<task>). These are the project's own tasks,
// not the step lists agents keep in their chats. The board has five columns (To do, In progress, In review,
// Blocked, Done) for this project or every project. Drag a card to move it (a copy follows the pointer, a gap
// opens where it will land, and the card glides from where it is let go), or focus it and press [ / ] to change
// column and Alt+↑ / Alt+↓ to move it within one; its "…" menu does the same. A change is saved in the task's own
// project.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, DragEvent as ReactDragEvent } from 'react';
import { DEL, GET, PUT, ago, confirmBox, navigate, onEvent, onReconnect, promptBox, toast } from '../core.ts';
import { reducedMotion } from '../motion.ts';
import { Button, ButtonLink, IconButton } from '../ui/button.tsx';
import { iconButtonClass } from '../ui/classes.ts';
import { Dropdown, DropdownContent, DropdownGroup, DropdownItem, DropdownLabel, DropdownSeparator, DropdownTrigger } from '../ui/dropdown.tsx';
import { Icon, reactPage, useAppState } from '../ui/react.tsx';
import { SelectControl } from '../ui/select.tsx';
import { Bone, Skeleton } from '../ui/skeleton.tsx';
import { cardCopy, grab, useDragPreview } from '../taskmotion.ts';
import { PRIORITIES, PriorityIcon, STATUSES, StatusIcon, Pick, assigneeChoices, openTaskComposer, priorityChoices, priorityOf, statusChoices, statusOf, taskHref, taskKey, usePeople } from '../taskboard.tsx';
import type { BoardPriority, BoardStatus, BoardTask, TaskBoardData } from '../../shared/types.ts';

// Done shows what was finished lately; "Show older" shows the rest
const RECENT_MS = 14 * 86_400_000;
// the board shows this project or every project (remembered on this PC)
const WHICH_KEY = 'dash-task-board';

/** Where a card goes between two others (by their ranks; either may be missing at the ends). */
export function rankBetween(above: number | undefined, below: number | undefined): number {
  if (above === undefined && below === undefined) return 0;
  if (above === undefined) return below! - 1024;
  if (below === undefined) return above + 1024;
  return (above + below) / 2;
}
const byRank = (a: BoardTask, b: BoardTask) => a.rank - b.rank || b.createdAt - a.createdAt || a.id.localeCompare(b.id);
const same = (a: BoardTask, b: BoardTask) => a.id === b.id && a.projectId === b.projectId;
const path = (t: BoardTask) => `/task-board/${encodeURIComponent(t.projectId)}/${encodeURIComponent(t.id)}`;
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Asks why a task is blocked (null: the move is called off). */
const askWhyBlocked = (t: BoardTask) => promptBox(`Why is ${taskKey(t.number)} blocked?`, { placeholder: 'e.g. Waiting for the printer\'s quote', ok: 'Move to Blocked' });

// ---------- the board ----------
function TaskBoardPage() {
  const app = useAppState();
  const here = app?.project?.id || '';
  const [which, setWhich] = useState(() => localStorage.getItem(WHICH_KEY) || 'here');
  const project = which === 'here' ? here : which;
  const [data, setData] = useState<TaskBoardData | null>(null);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [assignee, setAssignee] = useState('');
  const [priority, setPriority] = useState('');
  const [older, setOlder] = useState(false);
  const [dragging, setDragging] = useState<BoardTask | null>(null);
  const [drop, setDrop] = useState<{ status: BoardStatus; index: number } | null>(null);
  const [slot, setSlot] = useState(96);
  const board = useRef<HTMLDivElement>(null);
  const serial = useRef(0);
  useDragPreview(board);

  const load = useCallback(async () => {
    if (!project) return;
    const request = ++serial.current;
    try {
      const next = await GET<TaskBoardData>(`/task-board?project=${encodeURIComponent(project)}`);
      if (request !== serial.current) return;
      setData(next);
      setError('');
    } catch (e) {
      if (request === serial.current) setError(errorText(e));
    }
  }, [project]);
  useEffect(() => {
    setData(null);
    void load();
  }, [load]);
  // kept current: a change to a board this shows, another project opened, a reconnect
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const soon = () => (clearTimeout(timer), (timer = setTimeout(() => void load(), 150)));
    const off = onEvent((e) => {
      if (e.type === 'board' && (project === 'all' || !e.projectId || e.projectId === project)) soon();
      if (e.type === 'project' || e.type === 'projects' || e.type === 'agents' || e.type === 'workflows') soon();
    });
    const offReconnect = onReconnect(soon);
    return () => (clearTimeout(timer), off(), offReconnect());
  }, [load, project]);

  // Cards glide to where a move puts them: where each was is kept until the board has drawn the move. A dropped
  // card starts from where it was let go.
  const before = useRef<Map<string, { left: number; top: number }> | null>(null);
  const remember = (moved?: string, at?: { x: number; y: number }) => {
    const was = new Map<string, { left: number; top: number }>();
    for (const el of board.current?.querySelectorAll<HTMLElement>('[data-task-id]') || []) {
      const r = el.getBoundingClientRect();
      was.set(el.dataset.taskId!, { left: r.left, top: r.top });
    }
    if (moved && at) was.set(moved, { left: at.x - grab.x, top: at.y - grab.y });
    before.current = was;
  };
  useLayoutEffect(() => {
    const was = before.current;
    before.current = null;
    if (!was || reducedMotion()) return;
    for (const el of board.current?.querySelectorAll<HTMLElement>('[data-task-id]') || []) {
      const first = was.get(el.dataset.taskId!);
      if (!first || typeof el.animate !== 'function') continue;
      const now = el.getBoundingClientRect();
      const dx = first.left - now.left;
      const dy = first.top - now.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      // (the one that crosses columns rides above the others)
      el.style.position = 'relative';
      el.style.zIndex = '20';
      const a = el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 360, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
      void a.finished.catch(() => {}).finally(() => ((el.style.position = ''), (el.style.zIndex = '')));
    }
  });

  const tasks = data?.tasks || [];
  const q = search.trim().toLowerCase();
  const shown = tasks.filter((t) => (!q || `${taskKey(t.number)} ${t.title} ${t.description} ${t.projectName}`.toLowerCase().includes(q)) && (!assignee || t.assigneeName === assignee) && (!priority || t.priority === priority));
  const columns = useMemo(() => {
    const now = Date.now();
    return STATUSES.map((s) => {
      const all = shown.filter((t) => t.status === s.value).sort(byRank);
      const list = s.value === 'done' && !older ? all.filter((t) => now - (t.doneAt || t.updatedAt) < RECENT_MS) : all;
      return { ...s, list, hidden: all.length - list.length };
    });
  }, [shown, older]);
  const people = [...new Set(tasks.map((t) => t.assigneeName))].sort((a, b) => (a === 'Unassigned' ? 1 : b === 'Unassigned' ? -1 : a.localeCompare(b)));
  const allProjects = project === 'all';
  const filtered = !!(q || assignee || priority);

  /** Saves a move (and shows it at once); one the server refuses goes back. Moving to Blocked asks why first. */
  const move = async (task: BoardTask, status: BoardStatus, rank: number, at?: { x: number; y: number }) => {
    if (status === task.status && rank === task.rank) return;
    let blockedReason: string | undefined;
    if (status === 'blocked' && task.status !== 'blocked') {
      const why = await askWhyBlocked(task);
      if (why === null) return;
      blockedReason = why;
    }
    remember(`${task.projectId}/${task.id}`, at);
    setData((d) => (d ? { ...d, tasks: d.tasks.map((t) => (same(t, task) ? { ...t, status, rank, updatedAt: Date.now(), ...(blockedReason !== undefined ? { blockedReason } : {}) } : t)) } : d));
    try {
      await PUT(path(task), { status, rank, ...(blockedReason !== undefined ? { blockedReason } : {}) });
    } catch (e) {
      toast(errorText(e), 'error');
      remember();
      void load();
    }
    requestAnimationFrame(() => board.current?.querySelector<HTMLElement>(`[data-task-id="${task.projectId}/${task.id}"]`)?.focus({ preventScroll: true }));
  };
  // the rank for a place in a column, among its other cards
  const rankAt = (status: BoardStatus, index: number, task: BoardTask) => {
    const others = columns.find((c) => c.value === status)!.list.filter((t) => !same(t, task));
    return rankBetween(others[index - 1]?.rank, others[index]?.rank);
  };
  const toColumn = (task: BoardTask, status: BoardStatus) => void move(task, status, rankAt(status, 0, task));
  const step = (task: BoardTask, dir: -1 | 1) => {
    const list = columns.find((c) => c.value === task.status)!.list;
    const i = list.findIndex((t) => same(t, task));
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    void move(task, task.status, rankAt(task.status, j, task));
  };
  const onDrop = (status: BoardStatus, at: { x: number; y: number }) => {
    const task = dragging;
    const target = drop;
    setDragging(null);
    setDrop(null);
    if (!task || !target || target.status !== status) return;
    void move(task, status, rankAt(status, target.index, task), at);
  };
  const remove = async (task: BoardTask) => {
    if (!(await confirmBox(`Remove ${taskKey(task.number)} "${task.title}"?`, { ok: 'Remove', danger: true }))) return;
    try {
      remember();
      setData((d) => (d ? { ...d, tasks: d.tasks.filter((t) => !same(t, task)) } : d));
      await DEL(path(task));
    } catch (e) {
      toast(errorText(e), 'error');
      void load();
    }
  };
  const compose = (status?: BoardStatus) =>
    openTaskComposer({
      // in "All projects" a new task goes to the project open now (the window can pick another)
      projectId: allProjects ? here : project,
      status,
      projects: data?.projects || [],
      onCreated: () => (remember(), load()),
    });

  const pick = (v: string) => {
    localStorage.setItem(WHICH_KEY, v);
    setWhich(v);
  };
  const projectOptions = [
    { value: 'here', label: 'This project', icon: 'folder-open' },
    { value: 'all', label: 'All projects', icon: 'layers' },
    ...(data?.projects || []).filter((p) => p.id !== here).map((p) => ({ value: p.id, label: `${p.name}${p.open ? ` (${p.open})` : ''}`, icon: 'folder' })),
  ];

  return (
    <div className="flex flex-col gap-5 pb-10">
      <div className="flex flex-wrap items-center gap-2.5">
        <label className="relative w-60 max-sm:w-full">
          <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint"><Icon name="search" size={14} /></span>
          <input className="pl-8.5!" aria-label="Search tasks" placeholder="Search tasks…" value={search} maxLength={240} onChange={(e) => setSearch(e.currentTarget.value)} />
        </label>
        <SelectControl aria-label="Projects shown" value={which === 'here' || which === 'all' || data?.projects.some((p) => p.id === which) ? which : 'here'} options={projectOptions} onChange={pick} className="w-48! flex-none max-sm:w-full!" />
        <SelectControl aria-label="Assigned to" value={assignee} options={[{ value: '', label: 'Anyone', icon: 'users' }, ...people.map((o) => ({ value: o, label: o }))]} onChange={setAssignee} className="w-44! flex-none max-sm:w-full!" />
        <SelectControl aria-label="Priority" value={priority} options={[{ value: '', label: 'Any priority', icon: 'chevrons-up' }, ...PRIORITIES.map((p) => ({ value: p.value, label: p.label, icon: p.icon }))]} onChange={setPriority} className="w-40! flex-none max-sm:w-full!" />
        <Button className="ml-auto" onClick={() => compose()}>
          <Icon name="plus" size={15} />
          New task
        </Button>
      </div>
      {error ? (
        <div role="alert" className="flex items-center gap-3 rounded-box border border-red/30 bg-red/6 px-4 py-3 text-[13px] text-red">
          <span className="min-w-0 flex-1">{error}</span>
          <Button variant="ghost" size="small" onClick={() => void load()}>Try again</Button>
        </div>
      ) : null}
      {/* (the board scrolls sideways when the window is narrower than its five columns) */}
      <div ref={board} className="relative grid auto-cols-[minmax(14rem,1fr)] grid-flow-col items-start gap-3 overflow-x-auto pb-2" aria-label="Task board">
        {columns.map((c) => {
          const index = drop?.status === c.value ? drop.index : null;
          const others = c.list.filter((t) => !dragging || !same(t, dragging));
          const home = dragging && dragging.status === c.value ? c.list.findIndex((t) => same(t, dragging)) : -1;
          // dropping a card where it already is changes nothing: no gap there
          const gap = index !== null && index !== home ? index : null;
          return (
            <section
              key={c.value}
              data-column={c.value}
              aria-label={c.label}
              className={`flex min-h-[min(70vh,600px)] min-w-0 flex-col rounded-box border border-line bg-panel-2/45 p-2 [transition:background-color_0.15s,border-color_0.15s] ${index !== null ? 'border-accent/40 bg-accent/5' : ''}`}
              onDragOver={(e: ReactDragEvent) => {
                if (!dragging) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                const cards = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-task-id]')].filter((el) => el.dataset.taskId !== `${dragging.projectId}/${dragging.id}`);
                const at = cards.findIndex((el) => { const r = el.getBoundingClientRect(); return e.clientY < r.top + r.height / 2; });
                const next = at === -1 ? cards.length : at;
                setDrop((d) => (d?.status === c.value && d.index === next ? d : { status: c.value, index: next }));
              }}
              onDragLeave={(e: ReactDragEvent) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrop((d) => (d?.status === c.value ? null : d));
              }}
              onDrop={(e: ReactDragEvent) => {
                e.preventDefault();
                onDrop(c.value, { x: e.clientX, y: e.clientY });
              }}
            >
              <div className="flex h-9 items-center gap-2 px-2">
                <StatusIcon status={c.value} />
                <h2 className="m-0 text-[13.5px] font-semibold text-ink">{c.label}</h2>
                <span className="text-[12px] text-faint tabular-nums">{data ? c.list.length : '…'}</span>
                {/* a task starts in one of the first three; Blocked and Done are moved to */}
                {c.value === 'todo' || c.value === 'in_progress' || c.value === 'in_review' ? (
                  <IconButton variant="plain" className="ml-auto" aria-label={`Create a task in ${c.label}`} title={`Create a task in ${c.label}`} onClick={() => compose(c.value)}>
                    <Icon name="plus" size={15} />
                  </IconButton>
                ) : null}
              </div>
              {!data && !error ? (
                <Skeleton label="Loading tasks…" className="flex flex-col gap-2 p-0.5">
                  {[0, 1, 2].map((i) => (
                    <div key={i} className="flex flex-col gap-3 rounded-[10px] border border-line bg-bg p-3">
                      <Bone className="h-3 w-14" />
                      <Bone className={`h-4 ${i % 2 ? 'w-1/2' : 'w-4/5'}`} />
                      <Bone className="h-3 w-24" />
                    </div>
                  ))}
                </Skeleton>
              ) : (
                <ul className="m-0 flex flex-1 list-none flex-col gap-2 p-0.5">
                  {c.list.map((t) => {
                    const place = others.indexOf(t);
                    return [
                      gap !== null && dragging && place === gap ? <DropGhost key={`slot-${t.projectId}/${t.id}`} task={dragging} height={slot} /> : null,
                      <Card
                        key={`${t.projectId}/${t.id}`}
                        task={t}
                        showProject={allProjects}
                        first={c.list[0] === t}
                        last={c.list[c.list.length - 1] === t}
                        dragging={!!dragging && same(dragging, t)}
                        onDragStart={(el) => (setSlot(el.getBoundingClientRect().height), setDragging(t))}
                        onDragEnd={() => (setDragging(null), setDrop(null))}
                        onColumn={(s) => toColumn(t, s)}
                        onStep={(d) => step(t, d)}
                        onRemove={() => void remove(t)}
                      />,
                    ];
                  })}
                  {gap !== null && dragging && gap >= others.length ? <DropGhost task={dragging} height={slot} /> : null}
                  {data && !c.list.length && index === null ? (
                    <li className="flex min-h-24 items-center justify-center rounded-[10px] border border-dashed border-line-2 px-4 text-center text-[12.5px] text-faint">
                      {filtered ? 'Nothing here matches the filters.' : c.value === 'done' ? (older ? 'Nothing done yet.' : 'Nothing done in the last 14 days.') : 'Drop a card here.'}
                    </li>
                  ) : null}
                </ul>
              )}
              {c.value === 'done' && (c.hidden || older) ? (
                <Button variant="plain" size="small" className="mt-1 self-center" onClick={() => setOlder(!older)}>
                  {older ? 'Only the last 14 days' : `Show older (${c.hidden})`}
                </Button>
              ) : null}
            </section>
          );
        })}
      </div>
      <p className="m-0 text-[12.5px] text-faint">
        Drag a card, or focus it and press <kbd>[</kbd> / <kbd>]</kbd> to change column and <kbd>Alt</kbd>+<kbd>↑</kbd> / <kbd>↓</kbd> to move it up or down. Enter opens it. {allProjects ? 'New tasks go to the project open now, unless you pick another.' : ''}
      </p>
    </div>
  );
}

/**
 * Where the dragged card will land: a faded copy of it that opens the gap as it is reached. The copy is the card's
 * own markup, cloned with nothing in it focusable or carrying the card's id, so the board never mistakes it for
 * the card.
 */
function DropGhost({ task, height }: { task: BoardTask; height: number }) {
  const slot = useRef<HTMLLIElement>(null);
  useLayoutEffect(() => {
    const host = slot.current;
    const card = document.querySelector<HTMLElement>(`[data-task-id="${task.projectId}/${task.id}"]`);
    if (!host || !card) return;
    host.replaceChildren(cardCopy(card));
    return () => host.replaceChildren();
  }, [task]);
  return <li ref={slot} aria-hidden="true" inert style={{ '--slot': `${height}px` } as CSSProperties} className="pointer-events-none h-(--slot) flex-none overflow-hidden rounded-[10px] opacity-35 animate-[open-slot_0.16s_var(--ease-soft)_both]" />;
}

function Card({ task: t, showProject, first, last, dragging, onDragStart, onDragEnd, onColumn, onStep, onRemove }: {
  task: BoardTask;
  showProject: boolean;
  first: boolean;
  last: boolean;
  dragging: boolean;
  onDragStart: (el: HTMLElement) => void;
  onDragEnd: () => void;
  onColumn: (s: BoardStatus) => void;
  onStep: (dir: -1 | 1) => void;
  onRemove: () => void;
}) {
  const column = STATUSES.findIndex((s) => s.value === t.status);
  const open = () => navigate(taskHref(t));
  return (
    <li
      data-task-id={`${t.projectId}/${t.id}`}
      tabIndex={0}
      draggable
      aria-label={`${taskKey(t.number)} ${t.title}, ${statusOf(t.status).label}${showProject ? `, ${t.projectName}` : ''}`}
      className={`group flex cursor-pointer flex-col gap-2 rounded-[10px] border border-line bg-bg p-3 text-[13px] shadow-card outline-none [transition:border-color_0.15s,box-shadow_0.15s,background-color_0.15s,opacity_0.15s] hover:border-line-2 hover:bg-panel hover:shadow-lift focus-visible:border-accent focus-visible:shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-accent)_18%,transparent)] ${dragging ? 'opacity-40' : ''}`}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', t.id);
        onDragStart(e.currentTarget);
      }}
      onDragEnd={onDragEnd}
      onClick={(e) => {
        // the menu does its own thing
        if ((e.target as HTMLElement).closest('button,[role=menu]')) return;
        e.preventDefault();
        open();
      }}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter') return (e.preventDefault(), open());
        if (e.key === '[' && column > 0) return (e.preventDefault(), onColumn(STATUSES[column - 1].value));
        if (e.key === ']' && column < STATUSES.length - 1) return (e.preventDefault(), onColumn(STATUSES[column + 1].value));
        if (e.altKey && e.key === 'ArrowUp') return (e.preventDefault(), onStep(-1));
        if (e.altKey && e.key === 'ArrowDown') return (e.preventDefault(), onStep(1));
      }}
    >
      <div className="flex h-5 items-center gap-1.5 text-[11.5px] text-faint">
        <span title={`${priorityOf(t.priority).label} priority`} className="inline-flex"><PriorityIcon priority={t.priority} size={13} /></span>
        <span className="font-medium tabular-nums">{taskKey(t.number)}</span>
        {showProject ? (
          <span className="inline-flex min-w-0 items-center gap-1 truncate" title={`Project: ${t.projectName}`}>
            <span aria-hidden="true">·</span>
            <span className="truncate">{t.projectName}</span>
          </span>
        ) : null}
        <span className="ml-auto flex-none">
          <CardMenu task={t} first={first} last={last} onColumn={onColumn} onStep={onStep} onOpen={open} onRemove={onRemove} />
        </span>
      </div>
      <a href={taskHref(t)} tabIndex={-1} draggable={false} className="line-clamp-3 leading-snug font-medium break-words text-ink no-underline hover:text-ink">{t.title}</a>
      {t.status === 'blocked' && t.blockedReason ? <p className="m-0 line-clamp-2 text-[12px] text-red">{t.blockedReason}</p> : null}
      <div className="flex items-center gap-2 pt-0.5 text-[12px] text-dim">
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          {t.assignee ? <Who task={t} /> : null}
          <span className={`truncate ${t.assignee ? 'font-medium text-ink' : ''}`}>{t.assigneeName}</span>
        </span>
        <span className="flex-none text-[11.5px] text-faint tabular-nums" title={new Date(t.updatedAt).toLocaleString()}>{ago(t.updatedAt)}</span>
      </div>
    </li>
  );
}

/** Who has a task: an agent's emoji on its colour, or the mark for you, the Brain or a team. */
function Who({ task: t, size = 20 }: { task: BoardTask; size?: number }) {
  return (
    <span aria-hidden="true" className="grid flex-none place-items-center rounded-[6px] border border-line bg-panel-2 text-[11px] text-dim" style={{ width: size, height: size, ...(t.assigneeColor ? { boxShadow: `inset 0 -2px 0 ${t.assigneeColor}` } : {}) }}>
      {t.assigneeEmoji || <Icon name={t.assignee === 'brain' ? 'brain' : t.assignee.startsWith('team:') ? 'users' : t.assignee.startsWith('agent:') ? 'bot' : 'user'} size={11} />}
    </span>
  );
}

function CardMenu({ task, first, last, onColumn, onStep, onOpen, onRemove }: { task: BoardTask; first: boolean; last: boolean; onColumn: (s: BoardStatus) => void; onStep: (dir: -1 | 1) => void; onOpen: () => void; onRemove: () => void }) {
  return (
    <Dropdown>
      <DropdownTrigger className={iconButtonClass('plain', '-mt-0.5 -mr-1 size-6! opacity-60 group-hover:opacity-100 focus-visible:opacity-100')} aria-label={`Actions for ${task.title}`}>
        <Icon name="ellipsis" size={14} />
      </DropdownTrigger>
      <DropdownContent align="end" className="min-w-48">
        <DropdownItem icon="file-text" onClick={onOpen}>Open</DropdownItem>
        <DropdownItem icon="arrow-up" disabled={first} onClick={() => onStep(-1)}>Move up</DropdownItem>
        <DropdownItem icon="arrow-down" disabled={last} onClick={() => onStep(1)}>Move down</DropdownItem>
        <DropdownSeparator />
        <DropdownGroup>
          <DropdownLabel>Move to</DropdownLabel>
          {STATUSES.filter((s) => s.value !== task.status).map((s) => (
            <DropdownItem key={s.value} icon={s.icon} onClick={() => onColumn(s.value)}>{s.label}</DropdownItem>
          ))}
        </DropdownGroup>
        <DropdownSeparator />
        <DropdownItem icon="trash-2" danger onClick={onRemove}>Remove</DropdownItem>
      </DropdownContent>
    </Dropdown>
  );
}

// ---------- a task's own page ----------
function TaskPage({ projectId, id }: { projectId: string; id: string }) {
  const [task, setTask] = useState<BoardTask | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      const r = await GET<{ task?: BoardTask }>(`/task-board/${encodeURIComponent(projectId)}/${encodeURIComponent(id)}`);
      if (!r.task) return setError('That task is unavailable.');
      setTask(r.task);
      setError('');
    } catch (e) {
      setError(errorText(e));
    }
  }, [projectId, id]);
  useEffect(() => void load(), [load]);
  // (changed somewhere else: on the board in another tab, say)
  useEffect(() => onEvent((e) => e.type === 'board' && e.projectId === projectId && Array.isArray(e.ids) && e.ids.includes(id) && void load()), [load, projectId, id]);
  if (error)
    return (
      <div className="mx-auto flex max-w-xl flex-col items-center gap-3 py-16 text-center">
        <p className="m-0 text-[13.5px] text-red">{error}</p>
        <ButtonLink variant="ghost" size="small" href="#/tasks">Back to tasks</ButtonLink>
      </div>
    );
  if (!task)
    return (
      <Skeleton label="Loading the task…" className="mx-auto flex max-w-3xl flex-col gap-4 py-12">
        <Bone className="h-9 w-2/3" />
        <Bone className="h-32 w-full" />
      </Skeleton>
    );
  return <TaskDocument key={task.id} task={task} onChange={setTask} />;
}

function TaskDocument({ task, onChange }: { task: BoardTask; onChange: (t: BoardTask) => void }) {
  const people = usePeople(task.projectId);
  const save = async (patch: Record<string, unknown>) => {
    try {
      const r = await PUT<{ task: BoardTask }>(path(task), patch);
      onChange(r.task);
      return true;
    } catch (e) {
      toast(errorText(e), 'error');
      return false;
    }
  };
  const changeStatus = async (s: BoardStatus) => {
    if (s === task.status) return;
    if (s === 'blocked') {
      const why = await askWhyBlocked(task);
      if (why === null) return;
      return void save({ status: s, blockedReason: why });
    }
    void save({ status: s });
  };
  const remove = async () => {
    if (!(await confirmBox(`Remove ${taskKey(task.number)} "${task.title}"?`, { ok: 'Remove', danger: true }))) return;
    try {
      await DEL(path(task));
      navigate('#/tasks');
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };
  const detail = (label: string, value: string, title?: string) => (
    <div className="grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-2 px-2 py-1.5 text-[13px]">
      <dt className="text-dim">{label}</dt>
      <dd className="m-0 min-w-0 truncate text-ink" title={title}>{value}</dd>
    </div>
  );
  return (
    <div className="flex flex-col">
      <div className="mb-6 flex items-center gap-2 border-b border-line pb-3">
        <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-[13px]">
          <a href="#/tasks" className="text-dim no-underline hover:text-ink">Tasks</a>
          <Icon name="chevron-right" size={13} className="text-faint" />
          <span className="flex-none text-dim">{task.projectName}</span>
          <Icon name="chevron-right" size={13} className="text-faint" />
          <span className="flex-none text-dim tabular-nums">{taskKey(task.number)}</span>
          <span aria-current="page" className="truncate font-medium text-ink">{task.title}</span>
        </nav>
        <IconButton
          variant="plain"
          className="ml-auto"
          aria-label="Copy a link to this task"
          title="Copy a link to this task"
          onClick={() => void navigator.clipboard?.writeText(location.href).then(() => toast(`Link to ${taskKey(task.number)} copied`), () => toast('Could not copy the link', 'error'))}
        >
          <Icon name="link" size={15} />
        </IconButton>
      </div>
      <div className="grid items-start gap-10 lg:grid-cols-[minmax(0,1fr)_320px]">
        <article className="flex min-w-0 flex-col gap-6 max-lg:order-2">
          <TitleEditor task={task} onSave={(title) => save({ title })} />
          {task.status === 'blocked' ? (
            <div className="flex items-start gap-3 rounded-box border border-red/25 bg-red/6 px-4 py-3">
              <StatusIcon status="blocked" size={16} />
              <div className="min-w-0 flex-1 text-[13px]">
                <div className="font-medium text-ink">Blocked</div>
                <div className="text-dim">{task.blockedReason || 'No reason given.'}</div>
              </div>
              <Button variant="ghost" size="tiny" onClick={async () => { const why = await askWhyBlocked(task); if (why !== null) void save({ blockedReason: why }); }}>Change</Button>
            </div>
          ) : null}
          <DescriptionEditor task={task} onSave={(description) => save({ description })} />
        </article>
        <aside aria-label="Properties" className="flex flex-col gap-6 lg:border-l lg:border-line lg:pl-6 max-lg:order-1">
          <section className="flex flex-col gap-0.5">
            <h2 className="m-0 px-2 pb-1 text-[12px] font-medium text-dim">Properties</h2>
            <Pick look="row" label="Status" value={task.status} choices={statusChoices()} onChange={(v) => void changeStatus(v as BoardStatus)} />
            <Pick look="row" label="Priority" value={task.priority} choices={priorityChoices()} onChange={(v) => void save({ priority: v as BoardPriority })} />
            <Pick look="row" label="Assigned to" value={task.assignee} choices={assigneeChoices(people)} onChange={(v) => void save({ assignee: v })} />
          </section>
          <section>
            <h2 className="m-0 px-2 pb-1 text-[12px] font-medium text-dim">Details</h2>
            <dl className="m-0">
              {detail('Project', task.projectName)}
              {detail('Created', ago(task.createdAt), new Date(task.createdAt).toLocaleString())}
              {detail('By', task.creatorName)}
              {detail('Updated', ago(task.updatedAt), new Date(task.updatedAt).toLocaleString())}
              {task.doneAt ? detail('Done', ago(task.doneAt), new Date(task.doneAt).toLocaleString()) : null}
            </dl>
          </section>
          <Button variant="danger" size="small" className="self-start" onClick={() => void remove()}>
            <Icon name="trash-2" size={14} />
            Remove task
          </Button>
        </aside>
      </div>
    </div>
  );
}

/** The title as a heading you type into: Enter or leaving it saves (an empty one goes back). */
function TitleEditor({ task, onSave }: { task: BoardTask; onSave: (title: string) => Promise<boolean> }) {
  const [value, setValue] = useState(task.title);
  useEffect(() => setValue(task.title), [task.title]);
  const commit = async () => {
    const v = value.trim();
    if (!v) return setValue(task.title);
    if (v !== task.title && !(await onSave(v))) setValue(task.title);
  };
  return (
    <h1 className="m-0">
      <textarea
        aria-label="Title"
        rows={1}
        maxLength={200}
        value={value}
        onChange={(e) => setValue(e.currentTarget.value.replace(/\n/g, ' '))}
        onBlur={() => void commit()}
        onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), e.currentTarget.blur())}
        className="field-sizing-content -mx-2 min-h-0! w-[calc(100%+1rem)] resize-none border-transparent! bg-transparent! px-2! py-1! text-[24px]! leading-tight! font-semibold tracking-tight shadow-none! hover:bg-panel-2/60! focus:border-accent!"
      />
    </h1>
  );
}

/** The description: edited in place, saved when you leave it. */
function DescriptionEditor({ task, onSave }: { task: BoardTask; onSave: (description: string) => Promise<boolean> }) {
  const [value, setValue] = useState(task.description);
  const [saved, setSaved] = useState(false);
  useEffect(() => setValue(task.description), [task.description]);
  return (
    <div className="flex flex-col gap-1.5">
      <textarea
        aria-label="Description"
        rows={8}
        maxLength={8000}
        placeholder="Add a description: what needs to happen, and how you'll know it's done."
        value={value}
        onChange={(e) => (setValue(e.currentTarget.value), setSaved(false))}
        onBlur={async () => {
          if (value === task.description) return;
          if (await onSave(value)) setSaved(true);
          else setValue(task.description);
        }}
        className="min-h-48 -mx-2 w-[calc(100%+1rem)] resize-y border-transparent! bg-transparent! px-2! text-[14.5px]! leading-relaxed shadow-none! hover:bg-panel-2/60! focus:border-accent!"
      />
      <span className="h-4 text-[12px] text-faint" aria-live="polite">{saved ? 'Saved' : ''}</span>
    </div>
  );
}

export const title = (p: string[]) => (p[1] ? 'Task' : 'Tasks');
export const { render, unmount } = reactPage((p) => (p[0] && p[1] ? <TaskPage projectId={decodeURIComponent(p[0])} id={decodeURIComponent(p[1])} /> : <TaskBoardPage />));
