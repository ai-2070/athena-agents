// The Tasks board (#/tasks) and a task's own page (#/tasks/<project>/<task>). These are the project's own tasks,
// not the step lists agents keep in their chats. The board has five columns (To do, In progress, In review,
// Blocked, Done) for this project or every project. Drag a card to move it (a copy follows the pointer, a gap
// opens where it will land, and the card glides from where it is let go), or focus it and press [ / ] to change
// column and Alt+↑ / Alt+↓ to move it within one; its "…" menu does the same. A change is saved in the task's own
// project. A task's page shows its description (Markdown) and its comments, with "Draft with the Brain" for both.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent } from 'react';
import { ago, confirmBox, h, navigate, onEvent, onReconnect, promptBox, toast } from '../core.ts';
import { rpc } from '../client/rpc.ts';
import type { BoardChange } from '../../shared/api/taskboard.ts';
import { domButton } from '../ui/dom.ts';
import { reducedMotion } from '../motion.ts';
import { Button, ButtonLink, IconButton } from '../ui/button.tsx';
import { iconButtonClass } from '../ui/classes.ts';
import { Dropdown, DropdownContent, DropdownGroup, DropdownItem, DropdownLabel, DropdownRadioGroup, DropdownRadioItem, DropdownSeparator, DropdownTrigger } from '../ui/dropdown.tsx';
import { DomNode, Icon, reactPage, useAppState } from '../ui/react.tsx';
import { Bone, Skeleton } from '../ui/skeleton.tsx';
import { cardCopy, grab, useDragPreview } from '../taskmotion.ts';
import { openChat } from '../chatwin.tsx';
import { DraftWithBrain, Markdown, useMentionBox, useMentionables, PRIORITIES, Pick, PriorityIcon, STATUSES, StatusIcon, TaskFiles, WORK_STATES, WhoMark, askForDraft, assigneeChoices, confirmStop, isWorking, openTaskComposer, priorityChoices, priorityOf, statusChoices, statusOf, taskHref, taskKey, usePeople, useTray } from '../taskboard.tsx';
import type { Choice } from '../taskboard.tsx';
import { TagFilter, TagMarks, TagPicker, knownTagFilter, tagOptions } from '../tasktags.tsx';
import type { TagFilterValue } from '../tasktags.tsx';
import { tagKey, tagsMatch } from '../../shared/boardtags.ts';
import type { Candidate } from '../routinemention.ts';
import type { BoardComment, BoardPriority, BoardStatus, BoardTag, BoardTask, TaskBoardData } from '../../shared/types.ts';

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

export interface Placement {
  rank: number;
  /** other cards of the column that move to make room */
  respaced: { task: BoardTask; rank: number }[];
}
/**
 * Where a card goes between two others (column: its cards in order, without the card). When there is no room between
 * the two (the same rank, as every project's first card has in "All projects", or ranks too close to split), the
 * column is spaced out again.
 */
export function place(column: BoardTask[], above: BoardTask | undefined, below: BoardTask | undefined): Placement {
  const rank = rankBetween(above?.rank, below?.rank);
  if ((!above || rank > above.rank) && (!below || rank < below.rank)) return { rank, respaced: [] };
  const at = above ? column.findIndex((t) => same(t, above)) + 1 : 0;
  const respaced: Placement['respaced'] = [];
  column.forEach((t, i) => {
    const r = (i < at ? i : i + 1) * 1024;
    if (r !== t.rank) respaced.push({ task: t, rank: r });
  });
  return { rank: at * 1024, respaced };
}
// a task's address in calls: its project and its id
const ref = (t: Pick<BoardTask, 'projectId' | 'id'>) => ({ projectId: t.projectId, id: t.id });
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const cardKey = (t: BoardTask) => `${t.projectId}/${t.id}`;

/** Double-clicking text you can change opens its editor (not on a link or a button in it). */
const editOnDoubleClick = (edit: () => void) => (e: ReactMouseEvent) => {
  if ((e.target as HTMLElement).closest('a,button')) return;
  // (the word the double-click selected)
  window.getSelection()?.removeAllRanges();
  edit();
};

/** Puts the caret at the end of the text when its editor opens (after the mention box is attached). */
function useCaretAtEnd(box: { current: HTMLTextAreaElement | null }, editing: boolean): void {
  useEffect(() => {
    const ta = box.current;
    if (!editing || !ta) return;
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }, [box, editing]);
}

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
  const [tagFilter, setTagFilter] = useState<TagFilterValue>({ keys: [], untagged: false, match: 'any' });
  const [older, setOlder] = useState(false);
  const [dragging, setDragging] = useState<BoardTask | null>(null);
  const [drop, setDrop] = useState<{ status: BoardStatus; index: number } | null>(null);
  const [slot, setSlot] = useState(96);
  const board = useRef<HTMLDivElement>(null);
  const serial = useRef(0);
  useDragPreview(board);

  // While a card is dragged or a move is being saved, the board isn't loaded again under it: a dragged card that
  // moved to another column would leave the drag with no end (and its copy on the screen). It loads once that is over.
  const held = useRef({ drag: false, moves: 0, missed: false });
  const holding = () => held.current.drag || held.current.moves > 0;
  const load = useCallback(async () => {
    if (!project) return;
    if (holding()) return void (held.current.missed = true);
    const request = ++serial.current;
    try {
      const next = await rpc.taskBoard.list({ project });
      if (request !== serial.current) return;
      if (holding()) return void (held.current.missed = true);
      setData(next);
      setError('');
    } catch (e) {
      if (request !== serial.current) return;
      // a project picked here before that has since been removed: back to this project
      if (which !== 'here' && which !== 'all' && e instanceof Error && 'status' in e && e.status === 404) {
        localStorage.removeItem(WHICH_KEY);
        return setWhich('here');
      }
      setError(errorText(e));
    }
  }, [project, which]);
  useEffect(() => {
    setData(null);
    void load();
  }, [load]);
  const release = useCallback(() => {
    if (holding() || !held.current.missed) return;
    held.current.missed = false;
    void load();
  }, [load]);
  useEffect(() => {
    held.current.drag = !!dragging;
    release();
    if (!dragging) return;
    // (a drag whose end never came: the next press of the pointer ends it)
    const end = () => (setDragging(null), setDrop(null));
    document.addEventListener('pointerdown', end, true);
    return () => document.removeEventListener('pointerdown', end, true);
  }, [dragging, release]);
  // kept current: a change to a board this shows, another project opened, a reconnect, and an agent or team a card
  // here is assigned to (its name; agents are saved after most runs, so not on every save)
  const current = useRef(data);
  current.current = data;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const soon = () => (clearTimeout(timer), (timer = setTimeout(() => void load(), 150)));
    const assigned = (ref: string) => !!current.current?.tasks.some((t) => t.assignee === ref);
    const off = onEvent((e) => {
      if (e.type === 'board' && (project === 'all' || !e.projectId || e.projectId === project)) soon();
      if (e.type === 'project' || e.type === 'projects') soon();
      if ((e.type === 'agents' || e.type === 'workflows') && (typeof e.id !== 'string' || assigned(`${e.type === 'agents' ? 'agent' : 'team'}:${e.id}`))) soon();
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
  const shown = tasks.filter((t) => (!q || `${taskKey(t.number)} ${t.title} ${t.description} ${t.projectName} ${t.tagList.map((x) => x.name).join(' ')}`.toLowerCase().includes(q)) && (!assignee || t.assigneeName === assignee) && (!priority || t.priority === priority) && tagsMatch(t.tagList.map((x) => x.name), tagFilter.keys, tagFilter.match, tagFilter.untagged));
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
  const filtered = !!(q || assignee || priority || tagFilter.keys.length || tagFilter.untagged);
  const tagChoices = useMemo(() => tagOptions(data?.tags), [data]);
  // tags renamed, deleted or not in the projects shown now come out of the filter
  useEffect(() => {
    if (data) setTagFilter((f) => knownTagFilter(f, tagChoices));
  }, [data, tagChoices]);
  // a tag on a card shows its tasks (only those)
  const filterByTag = (tag: BoardTag) => setTagFilter({ keys: [tagKey(tag.name)], untagged: false, match: 'any' });
  const open = tasks.filter((t) => t.status !== 'done').length;

  // A card's moves are saved one after another, each on the version of the task the last one left (null: that one
  // failed, and the moves after it are dropped), so a quick second move isn't taken for someone else's change.
  const saving = useRef(new Map<string, Promise<number | null>>());
  /** Saves a change to a card already shown (first the column's new ranks, when it was spaced out again). */
  const saveCard = (task: BoardTask, patch: BoardChange, respaced: Placement['respaced'] = []) => {
    const key = cardKey(task);
    held.current.moves++;
    const saved = (saving.current.get(key) ?? Promise.resolve<number | null>(task.updatedAt)).then(async (version) => {
      if (version === null) return null;
      try {
        if (respaced.length) await rpc.taskBoard.rerank({ ranks: respaced.map((r) => ({ projectId: r.task.projectId, id: r.task.id, status: r.task.status, rank: r.rank })) });
        const r = await rpc.taskBoard.change({ ...ref(task), ...patch, expectedUpdatedAt: version });
        // the server's version (and the names of who has it), leaving the rest as shown
        const named = 'assignee' in patch ? { assigneeName: r.task.assigneeName, assigneeEmoji: r.task.assigneeEmoji, assigneeColor: r.task.assigneeColor } : {};
        const work = { work: r.task.work, workerName: r.task.workerName };
        setData((d) => (d ? { ...d, tasks: d.tasks.map((t) => (same(t, task) ? { ...t, ...named, ...work, updatedAt: r.task.updatedAt } : t)) } : d));
        startedNote(task, r.task);
        return r.task.updatedAt;
      } catch (e) {
        toast(errorText(e), 'error');
        remember();
        void load();
        return null;
      }
    });
    saving.current.set(key, saved);
    void saved.then(() => {
      if (saving.current.get(key) === saved) saving.current.delete(key);
      held.current.moves--;
      release();
    });
    return saved;
  };
  /** Saves a move (and shows it at once); one the server refuses goes back. Moving to Blocked asks why first. */
  const move = async (task: BoardTask, status: BoardStatus, { rank, respaced }: Placement, at?: { x: number; y: number }) => {
    if (status === task.status && rank === task.rank && !respaced.length) return;
    // (only asks while someone works on it: a quick second move must not wait behind a question)
    if (status !== 'in_progress' && isWorking(task) && !(await confirmStop(task))) return;
    let blockedReason: string | undefined;
    if (status === 'blocked' && task.status !== 'blocked') {
      const why = await askWhyBlocked(task);
      if (why === null) return;
      blockedReason = why;
    }
    remember(cardKey(task), at);
    const patch = { status, rank, ...(blockedReason !== undefined ? { blockedReason } : {}) };
    // (the version stays the server's; a card moved to Done counts as done now)
    const room = new Map(respaced.map((r) => [cardKey(r.task), r.rank]));
    setData((d) => (d ? { ...d, tasks: d.tasks.map((t) => (same(t, task) ? { ...t, ...patch, ...(status === 'done' && t.status !== 'done' ? { doneAt: Date.now() } : {}) } : room.has(cardKey(t)) ? { ...t, rank: room.get(cardKey(t))! } : t)) } : d));
    const saved = saveCard(task, patch, respaced);
    requestAnimationFrame(() => board.current?.querySelector<HTMLElement>(`[data-task-id="${cardKey(task)}"]`)?.focus({ preventScroll: true }));
    await saved;
  };
  /** Gives a card to someone (shown at once, with their name and mark). */
  const assign = async (task: BoardTask, who: Assignee) => {
    if (who.assignee === task.assignee || (isWorking(task) && !(await confirmStop(task)))) return;
    setData((d) => (d ? { ...d, tasks: d.tasks.map((t) => (same(t, task) ? { ...t, ...who } : t)) } : d));
    void saveCard(task, { assignee: who.assignee });
  };
  // where a place in a column as it is shown puts a card: between the shown cards either side of it, among all of
  // the column's cards (the ones filtered out or older keep their order too)
  const placeAt = (status: BoardStatus, index: number, task: BoardTask) => {
    const others = columns.find((c) => c.value === status)!.list.filter((t) => !same(t, task));
    return place(tasks.filter((t) => t.status === status && !same(t, task)).sort(byRank), others[index - 1], others[index]);
  };
  const toColumn = (task: BoardTask, status: BoardStatus) => void move(task, status, placeAt(status, 0, task));
  const step = (task: BoardTask, dir: -1 | 1) => {
    const list = columns.find((c) => c.value === task.status)!.list;
    const i = list.findIndex((t) => same(t, task));
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    void move(task, task.status, placeAt(task.status, j, task));
  };
  const onDrop = (status: BoardStatus, at: { x: number; y: number }) => {
    const task = dragging;
    const target = drop;
    setDragging(null);
    setDrop(null);
    if (!task || !target || target.status !== status) return;
    // let go where it already was: nothing moves (and no gap was drawn there)
    if (task.status === status && target.index === columns.find((c) => c.value === status)!.list.findIndex((t) => same(t, task))) return;
    void move(task, status, placeAt(status, target.index, task), at);
  };
  const remove = async (task: BoardTask) => {
    if (!(await confirmStop(task)) || !(await confirmBox(`Remove ${taskKey(task.number)} "${task.title}"?`, { ok: 'Remove', danger: true }))) return;
    try {
      remember();
      setData((d) => (d ? { ...d, tasks: d.tasks.filter((t) => !same(t, task)) } : d));
      await rpc.taskBoard.remove(ref(task));
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
  const projectChoices: Choice[] = [
    { value: 'here', label: 'This project', mark: <Icon name="folder-open" size={14} className="text-faint" /> },
    { value: 'all', label: 'All projects', mark: <Icon name="layers" size={14} className="text-faint" /> },
    ...(data?.projects || []).filter((p) => p.id !== here).map((p) => ({ value: p.id, label: `${p.name}${p.open ? ` (${p.open})` : ''}`, mark: <Icon name="folder" size={14} className="text-faint" /> })),
  ];

  return (
    <div className="flex flex-col gap-4">
      {/* filters as one quiet row of pills; New task on the right */}
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative w-56 max-sm:w-full">
          <span className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-faint"><Icon name="search" size={13} /></span>
          <input className="h-8! rounded-full! py-0! pl-8! text-[12.5px]!" aria-label="Search tasks" placeholder="Search tasks" value={search} maxLength={240} onChange={(e) => setSearch(e.currentTarget.value)} />
        </label>
        <Pick label="Projects shown" value={which === 'here' || which === 'all' || data?.projects.some((p) => p.id === which) ? which : 'here'} choices={projectChoices} onChange={pick} />
        <Pick label="Assigned to" value={assignee} choices={[{ value: '', label: 'Anyone', mark: <Icon name="users" size={14} className="text-faint" /> }, ...people.map((o) => ({ value: o, label: o }))]} onChange={setAssignee} />
        <Pick label="Priority" value={priority} choices={[{ value: '', label: 'Any priority', mark: <Icon name="chevrons-up" size={14} className="text-faint" /> }, ...PRIORITIES.map((p) => ({ value: p.value, label: p.label, mark: <PriorityIcon priority={p.value} /> }))]} onChange={setPriority} />
        <TagFilter options={tagChoices} value={tagFilter} onChange={setTagFilter} projectId={allProjects ? undefined : project} />
        {filtered ? (
          <Button variant="plain" size="small" onClick={() => (setSearch(''), setAssignee(''), setPriority(''), setTagFilter({ keys: [], untagged: false, match: 'any' }))}>
            <Icon name="x" size={13} />
            Clear
          </Button>
        ) : null}
        <span className="ml-auto text-[12.5px] text-faint tabular-nums max-sm:hidden">{data ? `${open} open${allProjects ? ' in all projects' : ''}` : ''}</span>
        <Button size="small" onClick={() => compose()}>
          <Icon name="plus" size={14} />
          New task
        </Button>
      </div>
      {error ? (
        <div role="alert" className="flex items-center gap-3 rounded-box border border-red/30 bg-red/6 px-4 py-3 text-[13px] text-red">
          <span className="min-w-0 flex-1">{error}</span>
          <Button variant="ghost" size="small" onClick={() => void load()}>Try again</Button>
        </div>
      ) : null}
      {/* the columns fill the window and each scrolls on its own; the board scrolls sideways when it is narrow */}
      <div ref={board} className="relative grid h-[calc(100dvh-13.5rem)] min-h-96 auto-cols-[minmax(13.5rem,1fr)] grid-flow-col gap-3 overflow-x-auto pb-1" aria-label="Task board">
        {columns.map((c) => {
          const index = drop?.status === c.value ? drop.index : null;
          const others = c.list.filter((t) => !dragging || !same(t, dragging));
          const home = dragging && dragging.status === c.value ? c.list.findIndex((t) => same(t, dragging)) : -1;
          // dropping a card where it already is changes nothing: no gap there
          const gap = index !== null && index !== home ? index : null;
          const canAdd = c.value === 'todo' || c.value === 'in_progress' || c.value === 'in_review';
          return (
            <section
              key={c.value}
              data-column={c.value}
              aria-label={c.label}
              className="group/col flex min-h-0 min-w-0 flex-col"
              onDragOver={(e: ReactDragEvent) => {
                if (!dragging) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                const cards = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-task-id]')].filter((el) => el.dataset.taskId !== cardKey(dragging));
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
              <div className="flex h-9 flex-none items-center gap-2 px-1.5">
                <StatusIcon status={c.value} />
                <h2 className="m-0 text-[13px] font-semibold text-ink">{c.label}</h2>
                <span className="rounded-full bg-ink/6 px-1.5 text-[11px] leading-[18px] text-dim tabular-nums">{data ? c.list.length : '…'}</span>
                {/* a task starts in one of the first three; Blocked and Done are moved to */}
                {canAdd ? (
                  <IconButton variant="plain" className="ml-auto opacity-0 group-hover/col:opacity-100 focus-visible:opacity-100" aria-label={`Create a task in ${c.label}`} title={`Create a task in ${c.label}`} onClick={() => compose(c.value)}>
                    <Icon name="plus" size={15} />
                  </IconButton>
                ) : null}
              </div>
              <div className={`flex min-h-0 flex-1 flex-col overflow-y-auto rounded-box p-1.5 [transition:background-color_0.15s,box-shadow_0.15s] ${index !== null ? 'bg-accent/6 shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-accent)_35%,transparent)]' : 'bg-ink/[0.025]'}`}>
                {!data && !error ? (
                  <Skeleton label="Loading tasks…" className="flex flex-col gap-1.5">
                    {[0, 1, 2].map((i) => (
                      <div key={i} className="flex flex-col gap-3 rounded-[10px] border border-line bg-bg p-3">
                        <Bone className={`h-4 ${i % 2 ? 'w-1/2' : 'w-4/5'}`} />
                        <Bone className="h-3 w-20" />
                      </div>
                    ))}
                  </Skeleton>
                ) : (
                  <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                    {c.list.map((t) => {
                      const place = others.indexOf(t);
                      return [
                        gap !== null && dragging && place === gap ? <DropGhost key={`slot-${cardKey(t)}`} task={dragging} height={slot} /> : null,
                        <Card
                          key={cardKey(t)}
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
                          onAssign={(who) => assign(t, who)}
                          onTag={filterByTag}
                        />,
                      ];
                    })}
                    {gap !== null && dragging && gap >= others.length ? <DropGhost task={dragging} height={slot} /> : null}
                    {data && !c.list.length && index === null ? (
                      <li className="flex flex-col items-center gap-2 px-3 py-8 text-center text-[12.5px] text-faint">
                        {filtered ? 'Nothing here matches.' : c.value === 'done' ? (older ? 'Nothing done yet.' : 'Nothing done in the last 14 days.') : 'No tasks'}
                        {canAdd && !filtered ? (
                          <Button variant="plain" size="tiny" onClick={() => compose(c.value)}>
                            <Icon name="plus" size={12} />
                            Add one
                          </Button>
                        ) : null}
                      </li>
                    ) : null}
                  </ul>
                )}
                {c.value === 'done' && (c.hidden || older) ? (
                  <Button variant="plain" size="tiny" className="mt-1 self-center" onClick={() => setOlder(!older)}>
                    {older ? 'Only the last 14 days' : `Show ${c.hidden} older`}
                  </Button>
                ) : null}
              </div>
            </section>
          );
        })}
      </div>
      <p className="m-0 text-[12px] text-faint">
        Drag a card, or focus it and press <kbd>[</kbd> / <kbd>]</kbd> to change column and <kbd>Alt</kbd>+<kbd>↑</kbd> / <kbd>↓</kbd> to move it up or down. Enter opens it.
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
    const card = document.querySelector<HTMLElement>(`[data-task-id="${cardKey(task)}"]`);
    if (!host || !card) return;
    host.replaceChildren(cardCopy(card));
    return () => host.replaceChildren();
  }, [task]);
  return <li ref={slot} aria-hidden="true" inert style={{ '--slot': `${height}px` } as CSSProperties} className="pointer-events-none h-(--slot) flex-none overflow-hidden rounded-[10px] opacity-35 animate-[open-slot_0.16s_var(--ease-soft)_both]" />;
}

function Card({ task: t, showProject, first, last, dragging, onDragStart, onDragEnd, onColumn, onStep, onRemove, onAssign, onTag }: {
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
  onAssign: (who: Assignee) => void;
  onTag: (tag: BoardTag) => void;
}) {
  const column = STATUSES.findIndex((s) => s.value === t.status);
  const open = () => navigate(taskHref(t));
  const pr = priorityOf(t.priority);
  return (
    <li
      data-task-id={cardKey(t)}
      tabIndex={0}
      draggable
      aria-label={`${taskKey(t.number)} ${t.title}, ${statusOf(t.status).label}${showProject ? `, ${t.projectName}` : ''}`}
      className={`group relative flex cursor-pointer flex-col gap-2 rounded-[10px] border border-line bg-bg px-3 py-2.5 text-[13px] shadow-card outline-none [transition:border-color_0.15s,box-shadow_0.15s,opacity_0.15s] hover:border-line-2 hover:shadow-lift focus-visible:border-accent focus-visible:shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-accent)_18%,transparent)] ${dragging ? 'opacity-40' : ''}`}
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
      <div className="flex items-start gap-2">
        <a href={taskHref(t)} tabIndex={-1} draggable={false} className="line-clamp-3 min-w-0 flex-1 leading-snug font-medium break-words text-ink no-underline hover:text-ink">{t.title}</a>
        {/* (shows when you point at the card) */}
        <span className="-mt-0.5 -mr-1.5 flex-none opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 has-data-popup-open:opacity-100">
          <CardMenu task={t} first={first} last={last} onColumn={onColumn} onStep={onStep} onOpen={open} onRemove={onRemove} />
        </span>
      </div>
      {t.status === 'blocked' && t.blockedReason ? <p className="m-0 line-clamp-2 text-[12px] leading-snug text-red">{t.blockedReason}</p> : null}
      {t.tagList.length ? <TagMarks tags={t.tagList} onPick={onTag} /> : null}
      <div className="flex min-w-0 items-center gap-2 text-[11.5px] text-faint">
        <span className="font-medium tabular-nums">{taskKey(t.number)}</span>
        {t.priority !== 'normal' ? (
          <span className={`inline-flex items-center gap-1 ${pr.tone}`} title={`${pr.label} priority`}>
            <PriorityIcon priority={t.priority} size={12} />
            {t.priority === 'urgent' || t.priority === 'high' ? pr.label : null}
          </span>
        ) : null}
        {t.commentCount ? (
          <span className="inline-flex items-center gap-1 tabular-nums" title={`${t.commentCount} comment${t.commentCount === 1 ? '' : 's'}`}>
            <Icon name="message-square" size={12} />
            {t.commentCount}
          </span>
        ) : null}
        {t.fileCount ? (
          <span className="inline-flex items-center gap-1 tabular-nums" title={`${t.fileCount} file${t.fileCount === 1 ? '' : 's'}`}>
            <Icon name="paperclip" size={12} />
            {t.fileCount}
          </span>
        ) : null}
        {showProject ? <span className="min-w-0 truncate" title={`Project: ${t.projectName}`}>{t.projectName}</span> : null}
        <span className="ml-auto flex flex-none items-center gap-2">
          <WorkMark task={t} />
          <AssignMenu task={t} onAssign={onAssign} />
        </span>
      </div>
    </li>
  );
}

type Assignee = Pick<BoardTask, 'assignee' | 'assigneeName' | 'assigneeEmoji' | 'assigneeColor'>;

/** On a card, how its work goes: a small dot that breathes while someone works on it, Needs you while it waits for
 *  your OK, and Check when it needs a look. Settled work shows nothing (the column says it). */
function WorkMark({ task: t }: { task: BoardTask }) {
  const w = t.work;
  if (!w || !['starting', 'working', 'waiting', 'needs-review'].includes(w.state)) return null;
  const s = WORK_STATES[w.state];
  const who = t.workerName || 'Someone';
  if (w.state === 'starting' || w.state === 'working')
    return (
      <span className="work-mark inline-flex flex-none items-center" title={`${who} is working on it`} aria-label={`${who} is working on it`}>
        <span className="size-1.5 rounded-full bg-accent motion-safe:animate-pulse" />
      </span>
    );
  return (
    <span className={`work-mark inline-flex flex-none items-center gap-1 font-medium ${s.tone}`} title={w.state === 'waiting' ? `${who} needs your OK for a step` : w.note || s.label}>
      <Icon name={s.icon} size={12} />
      {w.state === 'waiting' ? 'Needs you' : 'Check'}
    </span>
  );
}

/** "Writer started on #4", with Stop, when a change you made started someone's work. */
function startedNote(before: BoardTask, after: BoardTask): void {
  if (!after.work || !isWorking(after) || before.work?.operationId === after.work.operationId) return;
  const stop = domButton({ variant: 'ghost', size: 'tiny', class: 'ml-2', onclick: () => void rpc.taskBoard.stop(ref(after)).then(() => toast(`Stopped the work on ${taskKey(after.number)}`), (e: unknown) => toast(errorText(e), 'error')) }, 'Stop');
  toast(h('span', {}, `${after.workerName || 'Someone'} started on ${taskKey(after.number)}`, stop), 'info', 8000);
}

/** Who has the card, as a button: it opens the people of the card's project (loaded when it opens) to give it to. */
function AssignMenu({ task: t, onAssign }: { task: BoardTask; onAssign: (who: Assignee) => void }) {
  const [open, setOpen] = useState(false);
  const people = usePeople(open ? t.projectId : '');
  const pick = (v: string) => {
    const agent = people?.agents.find((a) => `agent:${a.id}` === v);
    const team = people?.teams.find((x) => `team:${x.id}` === v);
    const name = v === '' ? 'Unassigned' : v === 'you' ? 'You' : v === 'brain' ? 'The Brain' : agent?.name || team?.name || v;
    onAssign({ assignee: v, assigneeName: name, assigneeEmoji: agent?.emoji, assigneeColor: agent?.color });
  };
  const label = t.assignee ? `Assigned to ${t.assigneeName}` : 'Unassigned';
  return (
    <Dropdown open={open} onOpenChange={setOpen}>
      <DropdownTrigger className="flex flex-none cursor-pointer items-center rounded-[8px] border-0 bg-transparent p-0 outline-offset-2 [transition:opacity_0.15s] hover:opacity-80" aria-label={`${label}. Assign to…`} title={label}>
        {t.assignee ? <WhoMark who={t.assignee} emoji={t.assigneeEmoji} color={t.assigneeColor} size={20} /> : <span className="grid size-5 place-items-center rounded-[7px] border border-dashed border-line-2 text-faint"><Icon name="user" size={10} /></span>}
      </DropdownTrigger>
      <DropdownContent align="end" className="min-w-48">
        <DropdownRadioGroup value={t.assignee} onValueChange={(v) => pick(String(v))}>
          <DropdownLabel>Assign to</DropdownLabel>
          {assigneeChoices(people).map((c) => (
            <DropdownRadioItem key={c.value} value={c.value} icon={c.mark}>{c.label}</DropdownRadioItem>
          ))}
        </DropdownRadioGroup>
        {!people ? <div className="px-2.5 py-1.5 text-[12px] text-faint">Loading agents and teams…</div> : null}
      </DropdownContent>
    </Dropdown>
  );
}

function CardMenu({ task, first, last, onColumn, onStep, onOpen, onRemove }: { task: BoardTask; first: boolean; last: boolean; onColumn: (s: BoardStatus) => void; onStep: (dir: -1 | 1) => void; onOpen: () => void; onRemove: () => void }) {
  return (
    <Dropdown>
      <DropdownTrigger className={iconButtonClass('plain', 'size-6!')} aria-label={`Actions for ${task.title}`}>
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
      const r = await rpc.taskBoard.get({ projectId, id });
      if (!r.task) return setError('That task is unavailable.');
      setTask(r.task);
      setError('');
    } catch (e) {
      setError(errorText(e));
    }
  }, [projectId, id]);
  useEffect(() => void load(), [load]);
  // (changed somewhere else: on the board, by the Brain, in another tab)
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
  // what @ can mention here: this project's agents and teams, and the skills
  const mentions = useMentionables(task.projectId);
  // Every save says which version of the task it was made on, so a change made meanwhile (the Brain, another
  // tab) is refused rather than overwritten.
  const save = async (patch: BoardChange) => {
    try {
      const r = await rpc.taskBoard.change({ ...ref(task), ...patch, expectedUpdatedAt: task.updatedAt });
      onChange(r.task);
      startedNote(task, r.task);
      return true;
    } catch (e) {
      toast(errorText(e), 'error');
      return false;
    }
  };
  // Tag clicks are saved one after another, each as what it added or took off, on the version of the task the last
  // save left: quick clicks all count, and a change made meanwhile somewhere else is still refused. tagView is what
  // the clicks made, shown until they are saved.
  const latest = useRef(task);
  if (task.updatedAt >= latest.current.updatedAt) latest.current = task;
  const tagSaves = useRef({ chain: Promise.resolve(), pending: 0 });
  const [tagView, setTagView] = useState<string[] | null>(null);
  const saveTags = (ids: string[]) => {
    const before = tagView ?? task.tags ?? [];
    const addTags = ids.filter((id) => !before.includes(id));
    const removeTags = before.filter((id) => !ids.includes(id));
    if (!addTags.length && !removeTags.length) return;
    setTagView(ids);
    const q = tagSaves.current;
    q.pending++;
    q.chain = q.chain.then(async () => {
      try {
        const r = await rpc.taskBoard.change({ ...ref(latest.current), ...(addTags.length ? { addTags } : {}), ...(removeTags.length ? { removeTags } : {}), expectedUpdatedAt: latest.current.updatedAt });
        latest.current = r.task;
        onChange(r.task);
      } catch (e) {
        toast(errorText(e), 'error');
      }
      if (!--q.pending) setTagView(null);
    });
  };
  const changeStatus = async (s: BoardStatus) => {
    if (s === task.status || (s !== 'in_progress' && !(await confirmStop(task)))) return;
    if (s === 'blocked') {
      const why = await askWhyBlocked(task);
      if (why === null) return;
      return void save({ status: s, blockedReason: why });
    }
    void save({ status: s });
  };
  const remove = async () => {
    if (!(await confirmStop(task)) || !(await confirmBox(`Remove ${taskKey(task.number)} "${task.title}"?`, { ok: 'Remove', danger: true }))) return;
    try {
      await rpc.taskBoard.remove(ref(task));
      navigate('#/tasks');
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };
  const copyLink = () => void navigator.clipboard?.writeText(location.href).then(() => toast(`Link to ${taskKey(task.number)} copied`), () => toast('Could not copy the link', 'error'));
  const detail = (label: string, value: string, title?: string) => (
    <div className="flex items-center justify-between gap-3 py-1 text-[12.5px]">
      <dt className="text-dim">{label}</dt>
      <dd className="m-0 min-w-0 truncate text-ink" title={title}>{value}</dd>
    </div>
  );
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col">
      <div className="mb-8 flex items-center gap-2">
        <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-[13px]">
          <a href="#/tasks" className="inline-flex items-center gap-1.5 text-dim no-underline hover:text-ink">
            <Icon name="kanban" size={14} />
            Tasks
          </a>
          <Icon name="chevron-right" size={13} className="text-faint" />
          <span aria-current="page" className="flex-none font-medium text-ink tabular-nums">{taskKey(task.number)}</span>
        </nav>
        <div className="ml-auto flex items-center gap-1">
          <IconButton variant="plain" aria-label="Copy a link to this task" title="Copy a link to this task" onClick={copyLink}>
            <Icon name="link" size={15} />
          </IconButton>
          <Dropdown>
            <DropdownTrigger className={iconButtonClass('plain')} aria-label="More for this task">
              <Icon name="ellipsis" size={15} />
            </DropdownTrigger>
            <DropdownContent align="end" className="min-w-44">
              <DropdownItem icon="link" onClick={copyLink}>Copy link</DropdownItem>
              <DropdownSeparator />
              <DropdownItem icon="trash-2" danger onClick={() => void remove()}>Remove task</DropdownItem>
            </DropdownContent>
          </Dropdown>
        </div>
      </div>
      <div className="grid items-start gap-10 lg:grid-cols-[minmax(0,1fr)_300px]">
        <article className="flex w-full max-w-3xl min-w-0 flex-col gap-6 max-lg:order-2">
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
          <DescriptionEditor task={task} mentions={mentions} onSave={save} />
          <TaskFiles task={task} files={task.files} onRemove={(f) => void save({ files: (task.files || []).filter((x) => x.path !== f.path).map((x) => x.path) })} />
          <Activity task={task} mentions={mentions} onChange={onChange} />
        </article>
        <aside aria-label="Properties" className="flex flex-col gap-4 lg:sticky lg:top-20 max-lg:order-1">
          <div className="flex flex-col gap-0.5 rounded-box border border-line bg-panel p-2 shadow-card">
            <Pick look="row" label="Status" value={task.status} choices={statusChoices()} onChange={(v) => void changeStatus(v as BoardStatus)} />
            <Pick look="row" label="Priority" value={task.priority} choices={priorityChoices()} onChange={(v) => void save({ priority: v as BoardPriority })} />
            <Pick look="row" label="Assigned to" value={task.assignee} choices={assigneeChoices(people)} onChange={(v) => void confirmStop(task).then((ok) => ok && save({ assignee: v }))} />
            <TagPicker look="row" projectId={task.projectId} value={tagView ?? task.tags ?? []} known={task.tagList} onChange={saveTags} />
          </div>
          <WorkBox task={task} onChange={onChange} />
          <dl className="m-0 flex flex-col px-2">
            {detail('Project', task.projectName)}
            {detail('Created', ago(task.createdAt), new Date(task.createdAt).toLocaleString())}
            {detail('By', task.creatorName)}
            {detail('Updated', ago(task.updatedAt), new Date(task.updatedAt).toLocaleString())}
            {task.doneAt ? detail('Done', ago(task.doneAt), new Date(task.doneAt).toLocaleString()) : null}
          </dl>
        </aside>
      </div>
    </div>
  );
}

/** The agent's or team's work on the task: who, how it goes, and Stop, Start or Check saved work. Shown once the
 *  task is given to an agent or team. */
function WorkBox({ task, onChange }: { task: BoardTask; onChange: (t: BoardTask) => void }) {
  const app = useAppState();
  const [busy, setBusy] = useState(false);
  const w = task.work;
  const canWork = /^(agent|team):/.test(task.assignee);
  if (!w && !canWork) return null;
  const going = isWorking(task);
  const act = async (what: 'start' | 'stop' | 'check') => {
    setBusy(true);
    try {
      const r = await (what === 'check' ? rpc.taskBoard.check({ ...ref(task), operationId: w?.operationId }) : rpc.taskBoard[what](ref(task)));
      onChange(r.task);
      if (what === 'start') startedNote(task, r.task);
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  const state = w ? WORK_STATES[w.state] : null;
  const who = w ? task.workerName || 'Someone' : task.assigneeName;
  // (its chat lives in the task's project: it opens from there)
  const here = app?.project?.id === task.projectId;
  const openWork = w && here ? (w.chatId ? () => navigate(`#/agents/${w.target.id}/${w.chatId}`) : w.teamId ? () => void openChat('team', w.teamId!) : null) : null;
  return (
    <section aria-label="Work" className="work-box flex flex-col gap-2.5 rounded-box border border-line bg-panel p-3 shadow-card">
      <div className="flex items-center gap-2 text-[12.5px]">
        <WhoMark who={w ? `${w.target.kind}:${w.target.id}` : task.assignee} emoji={w ? undefined : task.assigneeEmoji} color={w ? undefined : task.assigneeColor} size={20} />
        <b className="min-w-0 truncate font-medium text-ink">{who}</b>
        {state ? (
          <span className={`work-state ml-auto inline-flex flex-none items-center gap-1 font-medium ${state.tone}`}>
            {going && w!.state !== 'waiting' ? <span className="size-1.5 rounded-full bg-accent motion-safe:animate-pulse" /> : <Icon name={state.icon} size={12} />}
            {state.label}
          </span>
        ) : <span className="ml-auto text-faint">Not started</span>}
      </div>
      {w?.note && (w.state === 'needs-review' || w.state === 'blocked') ? <p className="m-0 text-[12.5px] leading-snug text-dim">{w.note}</p> : null}
      {!w ? <p className="m-0 text-[12.5px] leading-snug text-dim">Moving the task to In progress starts it.</p> : null}
      {w ? <p className="m-0 text-[11.5px] text-faint" title={new Date(w.startedAt).toLocaleString()}>Started {ago(w.startedAt)}{w.endedAt ? ` · ended ${ago(w.endedAt)}` : ''}</p> : null}
      <div className="flex flex-wrap gap-1.5">
        {going ? <Button variant="ghost" size="small" disabled={busy} onClick={() => void act('stop')}><Icon name="square" size={12} />Stop</Button> : null}
        {!going && canWork ? <Button variant="ghost" size="small" disabled={busy} onClick={() => void act('start')}><Icon name="play" size={12} />{w ? 'Start again' : 'Start'}</Button> : null}
        {w?.state === 'needs-review' ? <Button variant="ghost" size="small" disabled={busy} onClick={() => void act('check')}><Icon name="rotate-ccw" size={12} />Check saved work</Button> : null}
        {openWork ? <Button variant="plain" size="small" onClick={openWork}><Icon name="message-square" size={12} />{w!.teamId ? 'Open thread' : 'Open chat'}</Button> : null}
      </div>
    </section>
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
        value={value}
        onChange={(e) => setValue(e.currentTarget.value.replace(/\n/g, ' '))}
        onBlur={() => void commit()}
        onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), e.currentTarget.blur())}
        className="field-sizing-content -mx-2 min-h-0! w-[calc(100%+1rem)] resize-none border-transparent! bg-transparent! px-2! py-1! text-[26px]! leading-tight! font-semibold tracking-tight shadow-none! hover:bg-ink/4! focus:border-accent!"
      />
    </h1>
  );
}

/** The description: Markdown to read, and Edit to write it (with Draft with the Brain); Ctrl+Enter saves. */
function DescriptionEditor({ task, mentions, onSave }: { task: BoardTask; mentions: Candidate[]; onSave: (patch: { description: string; files?: string[] }) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false);
  const tray = useTray();
  const frame = useRef<HTMLDivElement>(null);
  useEffect(() => (editing && frame.current ? tray.dropZone(frame.current, 'Drop files to attach them to the task') : undefined), [editing, tray]);
  const box = useRef<HTMLTextAreaElement>(null);
  useMentionBox(box, mentions, editing);
  useCaretAtEnd(box, editing);
  const [value, setValue] = useState(task.description);
  const [busy, setBusy] = useState(false);
  // the description as it was when editing started (the page keeps loading changes made meanwhile)
  const start = useRef(task.description);
  useEffect(() => { if (!editing) setValue(task.description); }, [task.description, editing]);
  const edit = () => {
    start.current = task.description;
    setEditing(true);
  };
  const save = async () => {
    if (value === task.description && !tray.count()) return setEditing(false);
    // changed while you were writing: replace it only if you say so
    if (value !== task.description && task.description !== start.current && !(await confirmBox('Someone changed this description while you were editing it. Replace their version with yours?', { ok: 'Replace' }))) return;
    setBusy(true);
    const added = await tray.ready();
    if (added === null) return setBusy(false);
    const files = added.length ? { files: [...(task.files || []).map((f) => f.path), ...added] } : {};
    if (await onSave({ description: value, ...files })) {
      tray.take();
      setEditing(false);
    }
    setBusy(false);
  };
  if (!editing)
    return task.description ? (
      <div className="group relative -mx-3 rounded-box px-3 py-2 [transition:background-color_0.15s] hover:bg-ink/3" onDoubleClick={editOnDoubleClick(edit)}>
        <Markdown text={task.description} mentions={mentions} />
        <Button variant="ghost" size="tiny" className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 focus-visible:opacity-100" onClick={edit}>
          <Icon name="pencil" size={12} />
          Edit
        </Button>
      </div>
    ) : (
      <Button variant="plain" className="-ml-3 self-start" onClick={edit}>
        <Icon name="pen-line" size={14} />
        Add a description…
      </Button>
    );
  return (
    <div ref={frame} className="relative flex flex-col overflow-hidden rounded-box border border-accent/50 bg-bg shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-accent)_12%,transparent)]">
      <textarea
        ref={box}
        aria-label="Description"
        autoFocus
        rows={10}
        placeholder="What needs to happen, and how you'll know it's done. Type @ to mention an agent, a team or a skill."
        value={value}
        disabled={busy}
        onChange={(e) => setValue(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) return (e.preventDefault(), void save());
          if (e.key === 'Escape') return (e.preventDefault(), e.stopPropagation(), setValue(task.description), setEditing(false));
        }}
        className="min-h-48 resize-y overflow-y-auto rounded-none! border-0! bg-transparent! px-4! py-3! text-[14px]! leading-relaxed shadow-none! focus:shadow-none! whitespace-pre-wrap text-ink outline-none empty:before:pointer-events-none empty:before:text-faint empty:before:content-[attr(data-placeholder)]"
      />
      <DomNode className="px-3 empty:hidden" make={() => tray.el} deps={[tray]} />
      <div className="flex flex-wrap items-center gap-2 border-t border-line bg-panel-2/50 px-2 py-1.5">
        <DomNode as="span" make={() => tray.picker} deps={[tray]} />
        <DraftWithBrain
          disabled={busy}
          draft={async (instruction) => {
            const d = await askForDraft({ projectId: task.projectId, kind: 'task', taskId: task.id, title: task.title, description: value, instruction });
            if (d.kind !== 'task') return null;
            const was = value;
            setValue(d.description);
            return () => setValue(was);
          }}
        />
        <span className="text-[11.5px] text-faint max-sm:hidden">Markdown supported</span>
        <span className="ml-auto flex items-center gap-1.5">
          <Button variant="plain" size="small" onClick={() => (setValue(task.description), setEditing(false))} disabled={busy}>Cancel</Button>
          <Button size="small" onClick={() => void save()} disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>
        </span>
      </div>
    </div>
  );
}

/** What happened on the task: when it was made, and the comments, with a box to add one. */
function Activity({ task, mentions, onChange }: { task: BoardTask; mentions: Candidate[]; onChange: (t: BoardTask) => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const form = useRef<HTMLFormElement>(null);
  useMentionBox(box, mentions);
  const tray = useTray();
  const [, setFiles] = useState(0);
  useEffect(() => tray.listen(() => setFiles(tray.count())), [tray]);
  useEffect(() => (form.current ? tray.dropZone(form.current, 'Drop files to attach them to your comment') : undefined), [tray]);
  const comments = task.comments || [];
  const empty = !text.trim() && !tray.count();
  const send = async () => {
    if (busy || empty) return;
    setBusy(true);
    try {
      const files = await tray.ready();
      if (files === null) return;
      onChange((await rpc.taskBoard.comments.add({ ...ref(task), text, files })).task);
      tray.take();
      setText('');
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label="Activity" className="mt-4 flex flex-col gap-5 border-t border-line pt-6">
      <div className="flex items-baseline gap-2">
        <h2 className="m-0 text-[14px] font-semibold text-ink">Activity</h2>
        {comments.length ? <span className="text-[12px] text-faint">{`${comments.length} comment${comments.length === 1 ? '' : 's'}`}</span> : null}
      </div>
      <ol className="m-0 flex list-none flex-col gap-4 p-0">
        <li className="flex items-center gap-2.5 text-[12.5px] text-dim">
          <span className="grid size-6 flex-none place-items-center"><Icon name="plus" size={13} className="text-faint" /></span>
          <span><b className="font-medium text-ink">{task.creatorName}</b> created the task</span>
          <span className="text-faint" title={new Date(task.createdAt).toLocaleString()}>· {ago(task.createdAt)}</span>
        </li>
        {comments.map((c) => <Comment key={c.id} task={task} comment={c} mentions={mentions} onChange={onChange} />)}
      </ol>
      <form ref={form} className="relative flex flex-col overflow-hidden rounded-box border border-line bg-bg shadow-card [transition:border-color_0.15s] focus-within:border-accent/60" onSubmit={(e) => (e.preventDefault(), void send())}>
        <textarea
          ref={box}
          aria-label="Comment"
          rows={3}
          placeholder="Leave a comment… Type @ to mention someone. Markdown supported."
          value={text}
          disabled={busy}
          onChange={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && (e.preventDefault(), void send())}
          className="min-h-20 resize-y overflow-y-auto rounded-none! border-0! bg-transparent! px-4! py-3! text-[14px]! leading-relaxed shadow-none! focus:shadow-none! whitespace-pre-wrap text-ink outline-none empty:before:pointer-events-none empty:before:text-faint empty:before:content-[attr(data-placeholder)]"
        />
        <DomNode className="px-3 empty:hidden" make={() => tray.el} deps={[tray]} />
        <div className="flex items-center gap-2 border-t border-line bg-panel-2/50 px-2 py-1.5">
          <DomNode as="span" make={() => tray.picker} deps={[tray]} />
          <DraftWithBrain
            disabled={busy}
            draft={async (instruction) => {
              const d = await askForDraft({ projectId: task.projectId, kind: 'comment', taskId: task.id, text, instruction });
              if (d.kind !== 'comment') return null;
              const was = text;
              setText(d.text);
              return () => setText(was);
            }}
          />
          <Button type="submit" size="small" className="ml-auto" disabled={busy || empty}>
            {busy ? 'Sending…' : 'Comment'}
            <kbd className="ml-1 rounded border border-current/25 px-1 font-sans text-[10px] opacity-70">Ctrl ↵</kbd>
          </Button>
        </div>
      </form>
    </section>
  );
}

/** One comment: who wrote it and when, in Markdown; yours can be changed or removed. */
function Comment({ task, comment: c, mentions, onChange }: { task: BoardTask; comment: BoardComment; mentions: Candidate[]; onChange: (t: BoardTask) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(c.text);
  const box = useRef<HTMLTextAreaElement>(null);
  useMentionBox(box, mentions, editing);
  useCaretAtEnd(box, editing);
  const at = { ...ref(task), commentId: c.id };
  const edit = () => (setValue(c.text), setEditing(true));
  const save = async () => {
    try {
      onChange((await rpc.taskBoard.comments.change({ ...at, text: value })).task);
      setEditing(false);
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };
  const remove = async () => {
    if (!(await confirmBox('Remove this comment?', { ok: 'Remove', danger: true }))) return;
    try {
      onChange((await rpc.taskBoard.comments.remove(at)).task);
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };
  return (
    <li className="group flex gap-2.5">
      <WhoMark who={c.by} emoji={c.byEmoji} size={24} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-[12.5px]">
          <b className="font-medium text-ink">{c.byName}</b>
          <span className="text-faint" title={new Date(c.at).toLocaleString()}>{ago(c.at)}{c.editedAt ? ' · edited' : ''}</span>
          {c.by === 'you' && !editing ? (
            <span className="ml-auto flex gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
              <IconButton variant="plain" aria-label="Edit comment" title="Edit" onClick={edit}><Icon name="pencil" size={13} /></IconButton>
              <IconButton variant="plain" aria-label="Remove comment" title="Remove" onClick={() => void remove()}><Icon name="trash-2" size={13} /></IconButton>
            </span>
          ) : null}
        </div>
        {editing ? (
          <div className="mt-1.5 flex flex-col gap-2">
            <textarea ref={box} aria-label="Edit comment" autoFocus rows={3} className="min-h-20 w-full rounded-ctl border border-line-2 bg-bg px-3 py-2 text-[14px] leading-relaxed whitespace-pre-wrap text-ink outline-none empty:before:pointer-events-none empty:before:text-faint empty:before:content-[attr(data-placeholder)]" value={value} onChange={(e) => setValue(e.currentTarget.value)} onKeyDown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && (e.preventDefault(), void save())} />
            <div className="flex justify-end gap-1.5">
              <Button variant="plain" size="small" onClick={() => setEditing(false)}>Cancel</Button>
              <Button size="small" onClick={() => void save()} disabled={!value.trim()}>Save</Button>
            </div>
          </div>
        ) : (
          <div className="mt-1 flex flex-col gap-2 rounded-box border border-line bg-panel/60 px-3.5 py-2.5" onDoubleClick={c.by === 'you' ? editOnDoubleClick(edit) : undefined}>
            {c.text ? <Markdown text={c.text} mentions={mentions} /> : null}
            <TaskFiles task={task} files={c.files} />
          </div>
        )}
      </div>
    </li>
  );
}

export const title = (p: string[]) => (p[1] ? 'Task' : 'Tasks');
export const { render, unmount } = reactPage((p) => (p[0] && p[1] ? <TaskPage projectId={decodeURIComponent(p[0])} id={decodeURIComponent(p[1])} /> : <TaskBoardPage />));
