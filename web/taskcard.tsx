// A task's card, as the Tasks board shows it (views/tasks.tsx) and the Overview's Tasks panel too: its title, tags,
// number, priority, comments and files, who has it (a button to give it to someone) and how its work goes, with a
// "…" menu to open, move or remove it. The ranks that order a column, and the small helpers both use, live here too.
import { useState } from 'react';
import { h, navigate, promptBox, toast } from './core.ts';
import { rpc } from './client/rpc.ts';
import { domButton } from './ui/dom.ts';
import { iconButtonClass } from './ui/classes.ts';
import { Dropdown, DropdownContent, DropdownGroup, DropdownItem, DropdownLabel, DropdownRadioGroup, DropdownRadioItem, DropdownSeparator, DropdownTrigger } from './ui/dropdown.tsx';
import { Icon } from './ui/react.tsx';
import { PriorityIcon, STATUSES, WORK_STATES, WhoMark, assigneeChoices, isWorking, priorityOf, statusOf, taskHref, taskKey, usePeople } from './taskboard.tsx';
import { TagMarks } from './tasktags.tsx';
import type { BoardStatus, BoardTag, BoardTask } from '../shared/types.ts';

/** Where a card goes between two others (by their ranks; either may be missing at the ends). */
export function rankBetween(above: number | undefined, below: number | undefined): number {
  if (above === undefined && below === undefined) return 0;
  if (above === undefined) return below! - 1024;
  if (below === undefined) return above + 1024;
  return (above + below) / 2;
}
export const byRank = (a: BoardTask, b: BoardTask) => a.rank - b.rank || b.createdAt - a.createdAt || a.id.localeCompare(b.id);
export const same = (a: BoardTask, b: BoardTask) => a.id === b.id && a.projectId === b.projectId;

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
export const ref = (t: Pick<BoardTask, 'projectId' | 'id'>) => ({ projectId: t.projectId, id: t.id });
export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
export const cardKey = (t: BoardTask) => `${t.projectId}/${t.id}`;

/** Asks why a task is blocked (null: the move is called off). */
export const askWhyBlocked = (t: BoardTask) => promptBox(`Why is ${taskKey(t.number)} blocked?`, { placeholder: 'e.g. Waiting for the printer\'s quote', ok: 'Move to Blocked' });

export function Card({ task: t, showProject, first, last, dragging, onDragStart, onDragEnd, onColumn, onStep, onRemove, onAssign, onTag }: {
  task: BoardTask;
  showProject: boolean;
  first: boolean;
  last: boolean;
  /** (the board's drag; a card without it isn't dragged) */
  dragging?: boolean;
  onDragStart?: (el: HTMLElement) => void;
  onDragEnd?: () => void;
  onColumn: (s: BoardStatus) => void;
  onStep: (dir: -1 | 1) => void;
  onRemove: () => void;
  onAssign: (who: Assignee) => void;
  /** a tag clicked: show its tasks (without it, tags are only shown) */
  onTag?: (tag: BoardTag) => void;
}) {
  const column = STATUSES.findIndex((s) => s.value === t.status);
  const open = () => navigate(taskHref(t));
  const pr = priorityOf(t.priority);
  return (
    <li
      data-task-id={cardKey(t)}
      tabIndex={0}
      draggable={!!onDragStart}
      aria-label={`${taskKey(t.number)} ${t.title}, ${statusOf(t.status).label}${showProject ? `, ${t.projectName}` : ''}`}
      className={`group relative flex cursor-pointer flex-col gap-2 rounded-[10px] border border-line bg-bg px-3 py-2.5 text-[13px] shadow-card outline-none [transition:border-color_0.15s,box-shadow_0.15s,opacity_0.15s] hover:border-line-2 hover:shadow-lift focus-visible:border-accent focus-visible:shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-accent)_18%,transparent)] ${dragging ? 'opacity-40' : ''}`}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', t.id);
        onDragStart?.(e.currentTarget);
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

export type Assignee = Pick<BoardTask, 'assignee' | 'assigneeName' | 'assigneeEmoji' | 'assigneeColor'>;

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
export function startedNote(before: BoardTask, after: BoardTask): void {
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
