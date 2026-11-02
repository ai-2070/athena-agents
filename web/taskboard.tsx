// The Tasks board's shared parts: its five statuses and four priorities with their marks, the pill and row pickers,
// and "New task", the window that makes one (a big title, its description, and its status, priority, who has it
// and its project as pills along the bottom).
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { GET, POST, state, toast } from './core.ts';
import { Button } from './ui/button.tsx';
import { Switch } from './ui/controls.tsx';
import { Dropdown, DropdownContent, DropdownRadioGroup, DropdownRadioItem, DropdownTrigger } from './ui/dropdown.tsx';
import { Icon } from './ui/react.tsx';
import { openModal } from './ui/overlays.tsx';
import type { BoardPeople, BoardPriority, BoardStatus, BoardTask } from '../shared/types.ts';

export const STATUSES: readonly { value: BoardStatus; label: string; icon: string; tone: string }[] = [
  { value: 'todo', label: 'To do', icon: 'circle-dashed', tone: 'text-dim' },
  { value: 'in_progress', label: 'In progress', icon: 'circle-half', tone: 'text-amber' },
  { value: 'in_review', label: 'In review', icon: 'eye', tone: 'text-ok' },
  { value: 'blocked', label: 'Blocked', icon: 'circle-pause', tone: 'text-red' },
  { value: 'done', label: 'Done', icon: 'circle-check', tone: 'text-accent' },
];
/** A task starts in one of the first three; Blocked and Done are moved to. */
export const START_STATUSES = STATUSES.slice(0, 3);
export const PRIORITIES: readonly { value: BoardPriority; label: string; icon: string; tone: string }[] = [
  { value: 'urgent', label: 'Urgent', icon: 'triangle-alert', tone: 'text-red' },
  { value: 'high', label: 'High', icon: 'chevrons-up', tone: 'text-amber' },
  { value: 'normal', label: 'Normal', icon: 'minus', tone: 'text-faint' },
  { value: 'low', label: 'Low', icon: 'chevron-down', tone: 'text-faint' },
];
export const statusOf = (s: BoardStatus) => STATUSES.find((x) => x.value === s)!;
export const priorityOf = (p: BoardPriority) => PRIORITIES.find((x) => x.value === p)!;
export const taskKey = (n: number) => `#${n}`;
export const taskHref = (t: Pick<BoardTask, 'projectId' | 'id'>) => `#/tasks/${encodeURIComponent(t.projectId)}/${encodeURIComponent(t.id)}`;

export function StatusIcon({ status, size = 15 }: { status: BoardStatus; size?: number }) {
  const s = statusOf(status);
  return <Icon name={s.icon} size={size} className={`flex-none ${s.tone}`} />;
}
export function PriorityIcon({ priority, size = 14 }: { priority: BoardPriority; size?: number }) {
  const p = priorityOf(priority);
  return <Icon name={p.icon} size={size} className={`flex-none ${p.tone}`} />;
}

export interface Choice {
  value: string;
  label: string;
  mark?: ReactNode;
}
/** Who a project's tasks can go to: no one, you, the Brain, its agents and teams. */
export function assigneeChoices(people: BoardPeople | null): Choice[] {
  return [
    { value: '', label: 'Unassigned', mark: <Icon name="user" size={14} className="text-faint" /> },
    { value: 'you', label: 'You', mark: <Icon name="user" size={14} /> },
    { value: 'brain', label: 'The Brain', mark: <Icon name="brain" size={14} /> },
    ...(people?.agents || []).map((a) => ({ value: `agent:${a.id}`, label: a.name, mark: <span className="w-3.5 text-center text-[12px]">{a.emoji || '🤖'}</span> })),
    ...(people?.teams || []).map((t) => ({ value: `team:${t.id}`, label: t.name, mark: <Icon name="users" size={14} /> })),
  ];
}

const PILL = 'inline-flex h-7 max-w-56 cursor-pointer items-center gap-1.5 rounded-full border border-line bg-panel/60 px-2.5 text-[12.5px] text-ink [transition:border-color_0.15s,background-color_0.15s] hover:border-line-2 hover:bg-panel-2 disabled:cursor-default disabled:opacity-60 data-popup-open:border-accent';
const ROW = 'flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-ctl px-2 py-1.5 text-left text-[13px] text-ink [transition:background-color_0.15s] hover:bg-panel-2 disabled:cursor-default data-popup-open:bg-panel-2';

/** A property as a pill (the new task window) or a row (the task page), opening its choices. */
export function Pick({ label, value, choices, onChange, look = 'pill', disabled }: { label: string; value: string; choices: readonly Choice[]; onChange: (v: string) => void; look?: 'pill' | 'row'; disabled?: boolean }) {
  const picked = choices.find((c) => c.value === value) || choices[0];
  return (
    <Dropdown>
      <DropdownTrigger className={look === 'pill' ? PILL : ROW} aria-label={`${label}: ${picked?.label}`} disabled={disabled}>
        {look === 'row' ? <span className="w-24 flex-none text-dim">{label}</span> : null}
        {picked?.mark}
        <span className="min-w-0 truncate">{picked?.label}</span>
      </DropdownTrigger>
      <DropdownContent align="start" className="min-w-48">
        <DropdownRadioGroup value={value} onValueChange={(v) => onChange(String(v))}>
          {choices.map((c) => (
            <DropdownRadioItem key={c.value} value={c.value} icon={c.mark}>{c.label}</DropdownRadioItem>
          ))}
        </DropdownRadioGroup>
      </DropdownContent>
    </Dropdown>
  );
}
export const statusChoices = (list = STATUSES): Choice[] => list.map((s) => ({ value: s.value, label: s.label, mark: <StatusIcon status={s.value} size={14} /> }));
export const priorityChoices = (): Choice[] => PRIORITIES.map((p) => ({ value: p.value, label: p.label, mark: <PriorityIcon priority={p.value} /> }));

/** The agents and teams of a project (for who has a task), loaded when the project changes. */
export function usePeople(projectId: string): BoardPeople | null {
  const [people, setPeople] = useState<BoardPeople | null>(null);
  useEffect(() => {
    let live = true;
    setPeople(null);
    if (projectId) void GET<BoardPeople>(`/task-board-people/${encodeURIComponent(projectId)}`).then((p) => live && setPeople(p), () => live && setPeople({ agents: [], teams: [] }));
    return () => void (live = false);
  }, [projectId]);
  return people;
}

export interface ComposerOptions {
  /** the project it goes to (the open one when left out) */
  projectId?: string;
  status?: BoardStatus;
  /** the projects to choose from (the board's list) */
  projects?: { id: string; name: string }[];
  onCreated?: (t: BoardTask) => unknown;
}

/** "New task": a window with the title and description up top and the task's properties as pills at the bottom. */
export function openTaskComposer(o: ComposerOptions = {}): void {
  openModal(
    <span className="inline-flex items-center gap-1.5 text-[14px]">
      <span className="font-normal text-dim">Tasks</span>
      <Icon name="chevron-right" size={13} className="text-faint" />
      New task
    </span>,
    (close) => <Composer {...o} close={close} />,
    { medium: true },
  );
}

function Composer({ projectId: startProject, status: startStatus = 'todo', projects = [], onCreated, close }: ComposerOptions & { close: () => void }) {
  const here = state.data?.project?.id || '';
  const [projectId, setProjectId] = useState(startProject || here);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<BoardStatus>(START_STATUSES.some((s) => s.value === startStatus) ? startStatus : 'todo');
  const [priority, setPriority] = useState<BoardPriority>('normal');
  const [assignee, setAssignee] = useState('');
  const [another, setAnother] = useState(false);
  const [busy, setBusy] = useState(false);
  const titleBox = useRef<HTMLInputElement>(null);
  const people = usePeople(projectId);
  const choices = projects.length ? projects : [{ id: here, name: state.data?.project?.name || 'This project' }];

  const submit = async () => {
    // (the shortcut reaches here too: the button's guard has to hold for it)
    if (busy || !title.trim() || !projectId) return;
    setBusy(true);
    try {
      const { task } = await POST<{ task: BoardTask }>(`/task-board/${encodeURIComponent(projectId)}`, { title, description, status, priority, assignee });
      toast(`Created ${taskKey(task.number)}: ${task.title}`);
      await onCreated?.(task);
      if (another) {
        // the properties stay for the next one; its words start afresh
        setTitle('');
        setDescription('');
        titleBox.current?.focus();
      } else close();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="flex min-h-0 flex-col"
      onSubmit={(e) => (e.preventDefault(), void submit())}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          void submit();
        }
      }}
    >
      <div className="modal-body flex flex-col gap-2 pt-5!">
        <input
          ref={titleBox}
          aria-label="Title"
          autoFocus
          required
          maxLength={200}
          placeholder="Task title"
          value={title}
          disabled={busy}
          onChange={(e) => setTitle(e.currentTarget.value)}
          className="border-0! bg-transparent! px-0! text-[20px]! font-semibold tracking-tight shadow-none! placeholder:text-faint focus:shadow-none!"
        />
        <textarea
          aria-label="Description"
          rows={6}
          maxLength={8000}
          placeholder="Add a description: what needs to happen, and how you'll know it's done."
          value={description}
          disabled={busy}
          onChange={(e) => setDescription(e.currentTarget.value)}
          className="min-h-36 resize-none border-0! bg-transparent! px-0! text-[14.5px]! leading-relaxed shadow-none! focus:shadow-none!"
        />
        <div className="flex flex-wrap items-center gap-1.5 pt-2">
          <Pick label="Status" value={status} choices={statusChoices(START_STATUSES)} onChange={(v) => setStatus(v as BoardStatus)} disabled={busy} />
          <Pick label="Priority" value={priority} choices={priorityChoices()} onChange={(v) => setPriority(v as BoardPriority)} disabled={busy} />
          <Pick label="Assigned to" value={assignee} choices={assigneeChoices(people)} onChange={setAssignee} disabled={busy} />
          {choices.length > 1 ? (
            <Pick label="Project" value={projectId} choices={choices.map((p) => ({ value: p.id, label: p.name, mark: <Icon name="folder" size={14} className="text-faint" /> }))} onChange={(v) => (setProjectId(v), setAssignee(''))} disabled={busy} />
          ) : null}
        </div>
      </div>
      <div className="modal-foot">
        <Switch checked={another} onChange={setAnother} className="mr-auto text-[13px] text-dim" disabled={busy}>Create another</Switch>
        <Button type="button" variant="ghost" onClick={close}>Cancel</Button>
        <Button type="submit" disabled={busy || !title.trim()}>
          {busy ? 'Creating…' : 'Create task'}
          <kbd className="ml-1 rounded border border-current/25 px-1 font-sans text-[10px] opacity-70">Ctrl ↵</kbd>
        </Button>
      </div>
    </form>
  );
}
