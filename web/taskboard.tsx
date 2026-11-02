// The Tasks board's shared parts: its five statuses and four priorities with their marks, the pill and row pickers,
// and "New task", the window that makes one (a big title, its description, and its status, priority, who has it
// and its project as pills along the bottom).
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { Popover } from '@base-ui/react/popover';
import { GET, POST, h, md, state, toast } from './core.ts';
import { icon } from './icons.ts';
import { loadSkills, skillsCache } from './skillpick.ts';
import { attachMentions } from './routinemention.ts';
import type { Candidate } from './routinemention.ts';
import { attachMentionEditor } from './chat/mentioneditor.ts';
import { mentionPattern } from '../shared/routines.ts';
import { Button } from './ui/button.tsx';
import { Switch } from './ui/controls.tsx';
import { Dropdown, DropdownContent, DropdownRadioGroup, DropdownRadioItem, DropdownTrigger } from './ui/dropdown.tsx';
import { DomNode, Icon } from './ui/react.tsx';
import { buttonClass } from './ui/classes.ts';
import { openModal } from './ui/overlays.tsx';
import type { BoardDraft, BoardDraftInput, BoardPeople, BoardPriority, BoardStatus, BoardTask } from '../shared/types.ts';

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
  { value: 'low', label: 'Low', icon: 'arrow-down', tone: 'text-faint' },
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

// ---------- mentions: @ an agent, a team or a skill (in descriptions and comments) ----------
/** What a task's text can mention: the project's agents and teams, and the skills in the library. */
export function useMentionables(projectId: string): Candidate[] {
  const people = usePeople(projectId);
  const [skills, setSkills] = useState(skillsCache);
  useEffect(() => {
    let live = true;
    void loadSkills().then((s) => live && setSkills(Array.isArray(s) ? s : []));
    return () => void (live = false);
  }, []);
  return useMemo(() => [
    ...(people?.agents || []).map((a): Candidate => ({ kind: 'agent', id: a.id, name: a.name, lead: h('span', { class: 'w-3.5 flex-none text-center' }, a.emoji || '🤖'), sub: '', color: a.color })),
    ...(people?.teams || []).map((t): Candidate => ({ kind: 'team', id: t.id, name: t.name, lead: icon('users', 14), sub: 'Team' })),
    ...skills.map((s): Candidate => ({ kind: 'skill', id: s.slug, name: s.name, lead: icon('puzzle', 14), sub: s.description || '' })),
  ], [people, skills]);
}

/** Gives a text box the @ menu and shows its mentions as pills, as a routine's text does (while on is true). */
export function useMentionBox(box: RefObject<HTMLTextAreaElement | null>, candidates: Candidate[], on = true): void {
  const latest = useRef(candidates);
  latest.current = candidates;
  useEffect(() => {
    const ta = box.current;
    if (!on || !ta) return;
    const offEditor = attachMentionEditor(ta, () => latest.current.map((c) => ({ tag: `@${c.name}`, icon: c.kind === 'team' ? 'users' : c.kind === 'skill' ? 'puzzle' : undefined })));
    const offMenu = attachMentions(ta, () => latest.current, () => {});
    return () => (offMenu(), offEditor());
  }, [box, on]);
}

const PILL_MENTION = 'inline-flex items-center gap-1 rounded-ctl bg-accent/10 px-1.5 font-medium text-accent align-baseline';
/** @Name in drawn Markdown as a pill (a team's and a skill's with their icon); never inside code or a link. */
export function pillMentions(root: HTMLElement, candidates: readonly Candidate[]): void {
  if (!candidates.length) return;
  const names = [...candidates].sort((a, b) => b.name.length - a.name.length);
  // (the rules the server reads mentions by)
  const re = mentionPattern(names.map((c) => c.name));
  const walk = (node: Node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 3) {
        const text = child.textContent || '';
        re.lastIndex = 0;
        if (!re.test(text)) continue;
        re.lastIndex = 0;
        const frag = document.createDocumentFragment();
        let last = 0;
        for (let m = re.exec(text); m; m = re.exec(text)) {
          const at = m.index + m[1].length;
          const c = names.find((x) => x.name.toLowerCase() === m![2].toLowerCase())!;
          frag.append(text.slice(last, at));
          const pill = h('span', { class: `task-mention ${PILL_MENTION}`, title: c.kind === 'agent' ? 'Agent' : c.kind === 'team' ? 'Team' : 'Skill' });
          if (c.kind !== 'agent') pill.append(icon(c.kind === 'team' ? 'users' : 'puzzle', 12));
          pill.append(`@${c.name}`);
          frag.append(pill);
          last = at + 1 + m[2].length;
        }
        frag.append(text.slice(last));
        child.replaceWith(frag);
      } else if (child instanceof Element && !['CODE', 'PRE', 'A'].includes(child.tagName)) walk(child);
    }
  };
  walk(root);
}

/** Text written in Markdown (a description, a comment), drawn the way chats draw it, with its mentions as pills. */
export function Markdown({ text, mentions = [], className = '' }: { text: string; mentions?: readonly Candidate[]; className?: string }) {
  const key = mentions.map((c) => `${c.kind}:${c.name}`).join('|');
  return (
    <DomNode
      className={`min-w-0 text-[14px] leading-relaxed text-ink [&_.md>:first-child]:mt-0 [&_.md>:last-child]:mb-0 ${className}`.trim()}
      make={() => {
        const el = md(text);
        pillMentions(el, mentions);
        return el;
      }}
      deps={[text, key]}
    />
  );
}

/** Who wrote or has something: an agent's emoji, or the mark for you, the Brain or a team. */
export function WhoMark({ who: ref, emoji, color, size = 20 }: { who: string; emoji?: string; color?: string; size?: number }) {
  return (
    <span aria-hidden="true" className="grid flex-none place-items-center rounded-[7px] border border-line bg-panel-2 text-dim" style={{ width: size, height: size, fontSize: Math.round(size * 0.55), ...(color ? { boxShadow: `inset 0 -2px 0 ${color}` } : {}) }}>
      {emoji || <Icon name={ref === 'brain' ? 'brain' : ref.startsWith('team:') ? 'users' : ref.startsWith('agent:') ? 'bot' : 'user'} size={Math.round(size * 0.55)} />}
    </span>
  );
}

/** Asks the Brain for a draft (POST /api/task-board-draft). */
export const askForDraft = (input: BoardDraftInput) => POST<BoardDraft>('/task-board-draft', input);

/**
 * "Draft with the Brain": what it should say (optional), then the draft goes into the box. use() puts it there and
 * gives back how to take it out again; Undo shows for a while after.
 */
export function DraftWithBrain({ draft, disabled }: { draft: (instruction: string) => Promise<(() => void) | null>; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState(false);
  const [undo, setUndo] = useState<(() => void) | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const go = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const back = await draft(instruction.trim());
      setOpen(false);
      setInstruction('');
      if (back) {
        clearTimeout(timer.current);
        setUndo(() => back);
        timer.current = setTimeout(() => setUndo(null), 15000);
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="inline-flex items-center gap-1">
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger className={buttonClass('ghost', 'small')} disabled={disabled || busy}>
          <Icon name="sparkles" size={14} className={busy ? 'animate-pulse text-accent' : 'text-accent'} />
          {busy ? 'Drafting…' : 'Draft with the Brain'}
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner side="top" align="start" sideOffset={6} collisionPadding={8} positionMethod="fixed" className="z-96 outline-none">
            <Popover.Popup className="st-menu dd static w-80! max-w-[calc(100vw-16px)]! p-3!">
              {/* (its own form: a submit here must not reach the form the button sits in, through React's tree) */}
              <form className="flex flex-col gap-2.5" onSubmit={(e) => (e.preventDefault(), e.stopPropagation(), void go())}>
                <label className="flex flex-col gap-1.5 text-[12.5px] text-dim">
                  What should it say? <span className="text-faint">(optional)</span>
                  <input autoFocus value={instruction} maxLength={2000} placeholder="e.g. make it a checklist, ask for the quote" onChange={(e) => setInstruction(e.currentTarget.value)} disabled={busy} />
                </label>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11.5px] text-faint">It reads what is here and the task.</span>
                  <button type="submit" className={buttonClass('primary', 'small')} disabled={busy}>
                    <Icon name="sparkles" size={13} />
                    {busy ? 'Drafting…' : 'Draft'}
                  </button>
                </div>
              </form>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
      {undo ? (
        <Button type="button" variant="plain" size="small" onClick={() => (undo(), setUndo(null), clearTimeout(timer.current))}>
          <Icon name="rotate-ccw" size={13} />
          Undo
        </Button>
      ) : null}
    </span>
  );
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
  const descBox = useRef<HTMLTextAreaElement>(null);
  const people = usePeople(projectId);
  useMentionBox(descBox, useMentionables(projectId));
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
          ref={descBox}
          aria-label="Description"
          rows={6}
          maxLength={8000}
          placeholder="Add a description: what needs to happen, and how you'll know it's done. Type @ to mention an agent, a team or a skill. Markdown works."
          value={description}
          disabled={busy}
          onChange={(e) => setDescription(e.currentTarget.value)}
          className="min-h-36 resize-none border-0! bg-transparent! px-0! text-[14.5px]! leading-relaxed whitespace-pre-wrap text-ink shadow-none! outline-none focus:shadow-none! empty:before:pointer-events-none empty:before:text-faint empty:before:content-[attr(data-placeholder)]"
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
        <DraftWithBrain
          disabled={busy || !projectId}
          draft={async (instruction) => {
            const d = await askForDraft({ projectId, kind: 'task', title, description, instruction });
            if (d.kind !== 'task') return null;
            const before = { title, description };
            setTitle(d.title);
            setDescription(d.description);
            return () => (setTitle(before.title), setDescription(before.description));
          }}
        />
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
