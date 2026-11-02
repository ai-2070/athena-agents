// The Tasks board: the tasks of this project, or of every project, in three columns (To do, In progress, Done).
// Drag a card to move it (between columns or up and down one), or focus it and press [ / ] to change column and
// Alt+↑ / Alt+↓ to move it within one; its "…" menu does the same. A change is saved in the task's own project.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, DragEvent as ReactDragEvent } from 'react';
import { GET, POST, PUT, ago, confirmBox, onEvent, onReconnect, toast } from '../core.ts';
import { reducedMotion } from '../motion.ts';
import { Button, IconButton } from '../ui/button.tsx';
import { buttonClass, iconButtonClass } from '../ui/classes.ts';
import { Dropdown, DropdownContent, DropdownGroup, DropdownItem, DropdownLabel, DropdownSeparator, DropdownTrigger } from '../ui/dropdown.tsx';
import { Field } from '../ui/controls.tsx';
import { Icon, reactPage, useAppState } from '../ui/react.tsx';
import { openModal } from '../ui/overlays.tsx';
import { SelectControl } from '../ui/select.tsx';
import { Bone, Skeleton } from '../ui/skeleton.tsx';
import type { BoardTask, TaskBoardData } from '../../shared/types.ts';

type Column = BoardTask['status'];
const COLUMNS: readonly { status: Column; label: string; icon: string; tone: string }[] = [
  { status: 'pending', label: 'To do', icon: 'clock', tone: 'text-dim' },
  { status: 'in_progress', label: 'In progress', icon: 'play', tone: 'text-accent' },
  { status: 'completed', label: 'Done', icon: 'circle-check', tone: 'text-ok' },
];
const labelOf = (s: Column) => COLUMNS.find((c) => c.status === s)!.label;
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

function TaskBoardPage() {
  const app = useAppState();
  const here = app?.project?.id || '';
  const [which, setWhich] = useState(() => localStorage.getItem(WHICH_KEY) || 'here');
  const project = which === 'here' ? here : which;
  const [data, setData] = useState<TaskBoardData | null>(null);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [owner, setOwner] = useState('');
  const [older, setOlder] = useState(false);
  const [dragging, setDragging] = useState<BoardTask | null>(null);
  const [drop, setDrop] = useState<{ status: Column; index: number } | null>(null);
  const [slot, setSlot] = useState(88);
  const [adding, setAdding] = useState<Column | null>(null);
  const board = useRef<HTMLDivElement>(null);
  const serial = useRef(0);

  const load = useCallback(async () => {
    if (!project) return;
    const request = ++serial.current;
    try {
      const next = await GET<TaskBoardData>(`/task-board?project=${encodeURIComponent(project)}`);
      if (request !== serial.current) return;
      setData(next);
      setError('');
    } catch (e) {
      if (request === serial.current) setError(e instanceof Error ? e.message : String(e));
    }
  }, [project]);
  useEffect(() => {
    setData(null);
    void load();
  }, [load]);
  // kept current: any task change (in a project this board shows), another project opened, a reconnect
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const soon = () => (clearTimeout(timer), (timer = setTimeout(() => void load(), 150)));
    const off = onEvent((e) => {
      if (e.type === 'tasks' && (project === 'all' || !e.projectId || e.projectId === project)) soon();
      if (e.type === 'project' || e.type === 'projects') soon();
    });
    const offReconnect = onReconnect(soon);
    return () => (clearTimeout(timer), off(), offReconnect());
  }, [load, project]);

  // cards glide to where a move puts them: where each was, kept until the board has drawn the move
  const before = useRef<Map<string, DOMRect> | null>(null);
  const remember = () => {
    const at = new Map<string, DOMRect>();
    for (const el of board.current?.querySelectorAll<HTMLElement>('[data-task-id]') || []) at.set(el.dataset.taskId!, el.getBoundingClientRect());
    before.current = at;
  };
  useLayoutEffect(() => {
    const first = before.current;
    before.current = null;
    if (!first || reducedMotion()) return;
    for (const el of board.current?.querySelectorAll<HTMLElement>('[data-task-id]') || []) {
      const was = first.get(el.dataset.taskId!);
      if (!was || typeof el.animate !== 'function') continue;
      const now = el.getBoundingClientRect();
      const dx = was.left - now.left;
      const dy = was.top - now.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 320, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
    }
  });

  const tasks = data?.tasks || [];
  const q = search.trim().toLowerCase();
  const shown = tasks.filter((t) => (!q || `${t.subject} ${t.preview} ${t.listName} ${t.projectName}`.toLowerCase().includes(q)) && (!owner || t.ownerName === owner));
  const columns = useMemo(() => {
    const now = Date.now();
    return COLUMNS.map((c) => {
      const all = shown.filter((t) => t.status === c.status).sort(byRank);
      const list = c.status === 'completed' && !older ? all.filter((t) => now - t.updatedAt < RECENT_MS) : all;
      return { ...c, list, hidden: all.length - list.length };
    });
  }, [shown, older]);
  const owners = [...new Set(tasks.map((t) => t.ownerName))].sort((a, b) => (a === 'Unassigned' ? 1 : b === 'Unassigned' ? -1 : a.localeCompare(b)));
  const allProjects = project === 'all';

  /** Saves a move (and shows it at once); a refusal (say, a task that waits for another) puts it back. */
  const move = async (task: BoardTask, status: Column, rank: number) => {
    if (status === task.status && rank === task.rank) return;
    remember();
    setData((d) => (d ? { ...d, tasks: d.tasks.map((t) => (t.id === task.id && t.projectId === task.projectId ? { ...t, status, rank, updatedAt: Date.now() } : t)) } : d));
    try {
      await PUT(`/task-board/${encodeURIComponent(task.projectId)}/${encodeURIComponent(task.id)}`, { status, rank });
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
      remember();
      void load();
    }
    requestAnimationFrame(() => board.current?.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(task.id)}"]`)?.focus({ preventScroll: true }));
  };
  // the rank for a place in a column, among its other cards
  const rankAt = (status: Column, index: number, task: BoardTask) => {
    const others = columns.find((c) => c.status === status)!.list.filter((t) => t.id !== task.id);
    return rankBetween(others[index - 1]?.rank, others[index]?.rank);
  };
  const toColumn = (task: BoardTask, status: Column) => void move(task, status, rankAt(status, 0, task));
  const step = (task: BoardTask, dir: -1 | 1) => {
    const list = columns.find((c) => c.status === task.status)!.list;
    const i = list.findIndex((t) => t.id === task.id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    void move(task, task.status, rankAt(task.status, j, task));
  };

  const onDrop = (status: Column) => {
    const task = dragging;
    const at = drop;
    setDragging(null);
    setDrop(null);
    if (!task || !at || at.status !== status) return;
    void move(task, status, rankAt(status, at.index, task));
  };

  const remove = async (task: BoardTask) => {
    if (!(await confirmBox(`Remove the task "${task.subject}"? Its links to other tasks are removed too.`, { ok: 'Remove', danger: true }))) return;
    try {
      remember();
      setData((d) => (d ? { ...d, tasks: d.tasks.filter((t) => !(t.id === task.id && t.projectId === task.projectId)) } : d));
      await PUT(`/task-board/${encodeURIComponent(task.projectId)}/${encodeURIComponent(task.id)}`, { status: 'deleted' });
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
      void load();
    }
  };

  const add = async (status: Column, subject: string) => {
    // in "All projects", a new task goes to the project open now
    const target = allProjects ? here : project;
    const top = columns.find((c) => c.status === status)!.list[0];
    try {
      remember();
      await POST(`/task-board/${encodeURIComponent(target)}`, { subject, status, rank: rankBetween(undefined, top?.rank) });
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    }
  };

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
        <label className="relative w-64 max-sm:w-full">
          <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint"><Icon name="search" size={14} /></span>
          <input className="pl-8.5!" aria-label="Search tasks" placeholder="Search tasks…" value={search} maxLength={240} onChange={(e) => setSearch(e.currentTarget.value)} />
        </label>
        <SelectControl aria-label="Projects shown" value={which === 'here' || which === 'all' || data?.projects.some((p) => p.id === which) ? which : 'here'} options={projectOptions} onChange={pick} className="w-52! flex-none max-sm:w-full!" />
        <SelectControl aria-label="Assigned to" value={owner} options={[{ value: '', label: 'Anyone', icon: 'users' }, ...owners.map((o) => ({ value: o, label: o }))]} onChange={setOwner} className="w-48! flex-none max-sm:w-full!" />
        <span className="ml-auto text-[12.5px] text-faint max-md:hidden">{allProjects ? 'Every project\'s tasks. New ones go to the project open now.' : ''}</span>
      </div>
      {error ? (
        <div role="alert" className="flex items-center gap-3 rounded-box border border-red/30 bg-red/6 px-4 py-3 text-[13px] text-red">
          <span className="min-w-0 flex-1">{error}</span>
          <Button variant="ghost" size="small" onClick={() => void load()}>Try again</Button>
        </div>
      ) : null}
      <div ref={board} className="grid grid-cols-3 items-start gap-3.5 max-lg:grid-cols-1" aria-label="Task board">
        {columns.map((c) => {
          const index = drop?.status === c.status ? drop.index : null;
          const home = dragging && dragging.status === c.status ? c.list.findIndex((t) => t.id === dragging.id) : -1;
          // dropping a card where it already is changes nothing: no slot there
          const gap = index !== null && index !== home && !(home >= 0 && index === home) ? index : null;
          const others = c.list.filter((t) => t.id !== dragging?.id);
          return (
            <section
              key={c.status}
              data-column={c.status}
              aria-label={c.label}
              className={`flex min-h-[min(70vh,560px)] min-w-0 flex-col rounded-box border border-line bg-panel-2/45 p-2 [transition:background-color_0.15s,border-color_0.15s] ${index !== null ? 'border-accent/40 bg-accent/5' : ''}`}
              onDragOver={(e: ReactDragEvent) => {
                if (!dragging) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                const cards = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-task-id]')].filter((el) => el.dataset.taskId !== dragging.id);
                const at = cards.findIndex((el) => { const r = el.getBoundingClientRect(); return e.clientY < r.top + r.height / 2; });
                const next = at === -1 ? cards.length : at;
                setDrop((d) => (d?.status === c.status && d.index === next ? d : { status: c.status, index: next }));
              }}
              onDragLeave={(e: ReactDragEvent) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrop((d) => (d?.status === c.status ? null : d));
              }}
              onDrop={(e: ReactDragEvent) => {
                e.preventDefault();
                onDrop(c.status);
              }}
            >
              <div className="flex h-9 items-center gap-2 px-2">
                <Icon name={c.icon} size={15} className={c.tone} />
                <h2 className="m-0 text-[13.5px] font-semibold text-ink">{c.label}</h2>
                <span className="text-[12px] text-faint tabular-nums">{data ? c.list.length : '…'}</span>
                {c.status !== 'completed' ? (
                  <IconButton variant="plain" className="ml-auto" aria-label={`Add a task to ${c.label}`} title={`Add a task to ${c.label}`} onClick={() => setAdding(c.status)}>
                    <Icon name="plus" size={15} />
                  </IconButton>
                ) : null}
              </div>
              {adding === c.status ? <Composer onAdd={(s) => void add(c.status, s)} onClose={() => setAdding(null)} /> : null}
              {!data && !error ? (
                <Skeleton label="Loading tasks…" className="flex flex-col gap-2 p-0.5">
                  {[0, 1, 2].map((i) => (
                    <div key={i} className="flex flex-col gap-2.5 rounded-[10px] border border-line bg-bg p-3">
                      <Bone className="h-3 w-20" />
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
                      gap !== null && place === gap ? <DropSlot key={`slot-${t.id}`} height={slot} /> : null,
                      <Card
                        key={`${t.projectId}/${t.id}`}
                        task={t}
                        showProject={allProjects}
                        first={c.list[0] === t}
                        last={c.list[c.list.length - 1] === t}
                        dragging={dragging?.id === t.id}
                        onDragStart={(el) => (setSlot(el.getBoundingClientRect().height), setDragging(t))}
                        onDragEnd={() => (setDragging(null), setDrop(null))}
                        onColumn={(s) => toColumn(t, s)}
                        onStep={(d) => step(t, d)}
                        onOpen={() => openTask(t, load)}
                        onRemove={() => void remove(t)}
                      />,
                    ];
                  })}
                  {gap !== null && gap >= others.length ? <DropSlot height={slot} /> : null}
                  {data && !c.list.length && index === null ? (
                    <li className="flex min-h-28 flex-col items-center justify-center gap-1 rounded-[10px] border border-dashed border-line-2 px-4 text-center text-[12.5px] text-faint">
                      {q || owner ? 'Nothing here matches.' : c.status === 'completed' ? (older ? 'Nothing done yet.' : 'Nothing done in the last 14 days.') : 'Drop a card here.'}
                    </li>
                  ) : null}
                </ul>
              )}
              {c.status === 'completed' && (c.hidden || older) ? (
                <Button variant="plain" size="small" className="mt-1 self-center" onClick={() => setOlder(!older)}>
                  {older ? 'Only the last 14 days' : `Show older (${c.hidden})`}
                </Button>
              ) : null}
            </section>
          );
        })}
      </div>
      <p className="m-0 text-[12.5px] text-faint">
        Drag a card, or focus it and press <kbd>[</kbd> / <kbd>]</kbd> to change column and <kbd>Alt</kbd>+<kbd>↑</kbd> / <kbd>↓</kbd> to move it up or down. Enter opens it.
      </p>
    </div>
  );
}

/** Where the dragged card will land: a gap the size of the card. */
function DropSlot({ height }: { height: number }) {
  return <li aria-hidden="true" style={{ '--slot': `${height}px` } as CSSProperties} className="h-(--slot) flex-none rounded-[10px] border border-dashed border-accent/60 bg-accent/8 animate-[fade_0.15s_ease-out]" />;
}

/** A new card's title, typed at the top of its column (Enter adds it, Escape closes). */
function Composer({ onAdd, onClose }: { onAdd: (subject: string) => void; onClose: () => void }) {
  const [text, setText] = useState('');
  return (
    <form
      className="mx-0.5 mb-2 flex flex-col gap-2 rounded-[10px] border border-accent/40 bg-bg p-2"
      onSubmit={(e) => {
        e.preventDefault();
        const s = text.trim();
        if (!s) return;
        onAdd(s);
        setText('');
      }}
    >
      <input autoFocus aria-label="New task title" placeholder="What needs doing?" maxLength={240} value={text} onChange={(e) => setText(e.currentTarget.value)} onKeyDown={(e) => e.key === 'Escape' && (e.preventDefault(), e.stopPropagation(), onClose())} />
      <div className="flex items-center justify-end gap-1.5">
        <Button type="button" variant="plain" size="tiny" onClick={onClose}>Cancel</Button>
        <Button type="submit" size="tiny" disabled={!text.trim()}>Add task</Button>
      </div>
    </form>
  );
}

function Card({ task: t, showProject, first, last, dragging, onDragStart, onDragEnd, onColumn, onStep, onOpen, onRemove }: {
  task: BoardTask;
  showProject: boolean;
  first: boolean;
  last: boolean;
  dragging: boolean;
  onDragStart: (el: HTMLElement) => void;
  onDragEnd: () => void;
  onColumn: (s: Column) => void;
  onStep: (dir: -1 | 1) => void;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const column = COLUMNS.findIndex((c) => c.status === t.status);
  const blocked = t.blockedBy.length > 0 && t.status !== 'completed';
  return (
    <li
      data-task-id={t.id}
      tabIndex={0}
      draggable
      aria-label={`${t.subject}, ${labelOf(t.status)}${showProject ? `, ${t.projectName}` : ''}`}
      className={`group flex cursor-grab flex-col gap-2 rounded-[10px] border border-line bg-bg p-3 text-[13px] shadow-card outline-none [transition:border-color_0.15s,box-shadow_0.15s,opacity_0.15s] hover:border-line-2 hover:shadow-lift focus-visible:border-accent focus-visible:shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-accent)_18%,transparent)] active:cursor-grabbing ${dragging ? 'opacity-40' : ''}`}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', t.id);
        onDragStart(e.currentTarget);
      }}
      onDragEnd={onDragEnd}
      onClick={(e) => {
        // the menu does its own thing
        if ((e.target as HTMLElement).closest('button,a,[role=menu]')) return;
        onOpen();
      }}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter') return (e.preventDefault(), onOpen());
        if (e.key === '[' && column > 0) return (e.preventDefault(), onColumn(COLUMNS[column - 1].status));
        if (e.key === ']' && column < COLUMNS.length - 1) return (e.preventDefault(), onColumn(COLUMNS[column + 1].status));
        if (e.altKey && e.key === 'ArrowUp') return (e.preventDefault(), onStep(-1));
        if (e.altKey && e.key === 'ArrowDown') return (e.preventDefault(), onStep(1));
      }}
    >
      <div className="flex min-h-5 items-center gap-1.5 text-[11.5px] text-faint">
        {showProject ? (
          <span className="inline-flex min-w-0 items-center gap-1 truncate" title={`Project: ${t.projectName}`}>
            <Icon name="folder" size={12} className="flex-none" />
            <span className="truncate">{t.projectName}</span>
            <span aria-hidden="true">·</span>
          </span>
        ) : null}
        <span className="truncate" title={`List: ${t.listName}`}>{t.listName}</span>
        <span className="ml-auto flex-none">
          <CardMenu task={t} first={first} last={last} onColumn={onColumn} onStep={onStep} onOpen={onOpen} onRemove={onRemove} />
        </span>
      </div>
      <div className={`line-clamp-3 leading-snug font-medium break-words ${t.status === 'completed' ? 'text-dim line-through decoration-faint' : 'text-ink'}`}>{t.subject}</div>
      {t.status === 'in_progress' && t.activeForm ? <div className="truncate text-[12px] text-accent">{t.activeForm}</div> : t.preview && t.preview !== t.subject ? <div className="line-clamp-2 text-[12px] leading-normal text-dim">{t.preview}</div> : null}
      {blocked ? (
        <div className="inline-flex items-center gap-1.5 text-[12px] text-amber">
          <Icon name="triangle-alert" size={12} />
          {`Waiting for ${t.blockedBy.length} task${t.blockedBy.length === 1 ? '' : 's'}`}
        </div>
      ) : null}
      <div className="flex items-center gap-2 pt-0.5 text-[12px] text-dim">
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          {t.owner ? (
            <span aria-hidden="true" className="grid size-5 flex-none place-items-center rounded-[6px] border border-line bg-panel-2 text-[11px]" style={t.ownerColor ? { boxShadow: `inset 0 -2px 0 ${t.ownerColor}` } : undefined}>
              {t.ownerEmoji || (t.owner === 'brain' ? <Icon name="brain" size={11} /> : t.owner.startsWith('team:') ? <Icon name="users" size={11} /> : <Icon name="bot" size={11} />)}
            </span>
          ) : null}
          <span className={`truncate ${t.owner ? 'text-ink' : ''}`}>{t.ownerName}</span>
        </span>
        <span className="flex-none text-[11.5px] text-faint tabular-nums" title={new Date(t.updatedAt).toLocaleString()}>{ago(t.updatedAt)}</span>
      </div>
    </li>
  );
}

function CardMenu({ task, first, last, onColumn, onStep, onOpen, onRemove }: { task: BoardTask; first: boolean; last: boolean; onColumn: (s: Column) => void; onStep: (dir: -1 | 1) => void; onOpen: () => void; onRemove: () => void }) {
  return (
    <Dropdown>
      <DropdownTrigger className={iconButtonClass('plain', 'size-6! opacity-60 group-hover:opacity-100 focus-visible:opacity-100')} aria-label={`Actions for ${task.subject}`}>
        <Icon name="ellipsis" size={14} />
      </DropdownTrigger>
      <DropdownContent align="end" className="min-w-48">
        <DropdownItem icon="file-text" onClick={onOpen}>Open</DropdownItem>
        <DropdownItem icon="arrow-up" disabled={first} onClick={() => onStep(-1)}>Move up</DropdownItem>
        <DropdownItem icon="arrow-down" disabled={last} onClick={() => onStep(1)}>Move down</DropdownItem>
        <DropdownSeparator />
        <DropdownGroup>
          <DropdownLabel>Move to</DropdownLabel>
          {COLUMNS.filter((c) => c.status !== task.status).map((c) => (
            <DropdownItem key={c.status} icon={c.icon} onClick={() => onColumn(c.status)}>{c.label}</DropdownItem>
          ))}
        </DropdownGroup>
        <DropdownSeparator />
        <DropdownItem icon="trash-2" danger onClick={onRemove}>Remove</DropdownItem>
      </DropdownContent>
    </Dropdown>
  );
}

/** A task's details: its title and description to change, its column, where it is and who has it. */
function openTask(task: BoardTask, reload: () => Promise<void>): void {
  openModal(task.subject, (close) => <TaskDialog task={task} close={close} reload={reload} />, { medium: true });
}

function TaskDialog({ task, close, reload }: { task: BoardTask; close: () => void; reload: () => Promise<void> }) {
  const [subject, setSubject] = useState(task.subject);
  const [description, setDescription] = useState<string | null>(null);
  const [status, setStatus] = useState<Column>(task.status);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  // the whole description (the card has only its start), read in the task's own project
  useEffect(() => {
    let live = true;
    GET<{ task: { description: string } }>(`/task-board/${encodeURIComponent(task.projectId)}/${encodeURIComponent(task.id)}`).then(
      (r) => live && setDescription(r.task.description),
      () => live && setFailed(true),
    );
    return () => void (live = false);
  }, [task]);
  const save = async () => {
    setBusy(true);
    try {
      await PUT(`/task-board/${encodeURIComponent(task.projectId)}/${encodeURIComponent(task.id)}`, { subject, ...(description !== null && description.trim() ? { description } : {}), ...(status !== task.status ? { status } : {}) });
      close();
      await reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  const meta = (icon: string, label: string, value: string) => (
    <div className="flex items-center gap-2 text-[12.5px]">
      <Icon name={icon} size={13} className="text-faint" />
      <span className="w-20 flex-none text-dim">{label}</span>
      <span className="min-w-0 truncate text-ink">{value}</span>
    </div>
  );
  return (
    <>
      <div className="modal-body">
        <form id="task-dialog" className="flex flex-col gap-5" onSubmit={(e) => (e.preventDefault(), void save())}>
          <Field label="Title">
            <input required maxLength={240} value={subject} onChange={(e) => setSubject(e.currentTarget.value)} />
          </Field>
          <Field label="Description">
            <textarea rows={5} maxLength={8000} value={description ?? (failed ? task.preview : '')} placeholder={description === null ? (failed ? '' : 'Loading…') : 'What needs to be done, and how to check it'} disabled={description === null} onChange={(e) => setDescription(e.currentTarget.value)} />
          </Field>
          <div role="radiogroup" aria-label="Column" className="grid grid-cols-3 gap-2">
            {COLUMNS.map((c) => (
              <button key={c.status} type="button" role="radio" aria-checked={status === c.status} onClick={() => setStatus(c.status)} className="flex items-center gap-2 rounded-ctl border border-line bg-panel/60 px-3 py-2 text-[13px] text-dim [transition:border-color_0.15s,background-color_0.15s] hover:border-line-2 hover:text-ink aria-checked:border-accent aria-checked:bg-accent/8 aria-checked:text-ink">
                <Icon name={c.icon} size={14} className={c.tone} />
                {c.label}
              </button>
            ))}
          </div>
          <div className="flex flex-col gap-2 rounded-box border border-line bg-panel-2/40 px-4 py-3">
            {meta('folder', 'Project', task.projectName)}
            {meta('list-checks', 'List', task.listName)}
            {meta('users', 'Assigned to', task.ownerName)}
            {task.blockedBy.length ? meta('triangle-alert', 'Waiting for', `${task.blockedBy.length} task${task.blockedBy.length === 1 ? '' : 's'}`) : null}
            {meta('clock', 'Changed', ago(task.updatedAt))}
          </div>
        </form>
      </div>
      <div className="modal-foot">
        <Button variant="ghost" onClick={close}>Cancel</Button>
        <button type="submit" form="task-dialog" className={buttonClass('primary')} disabled={busy || !subject.trim()}>{busy ? 'Saving…' : 'Save task'}</button>
      </div>
    </>
  );
}

export const title = () => 'Tasks';
export const { render, unmount } = reactPage(() => <TaskBoardPage />);
