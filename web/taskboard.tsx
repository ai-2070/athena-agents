// The Tasks board's shared parts: its five statuses and four priorities with their marks, the pill and row pickers,
// and "New task", the window that makes one (a big title, its description, and its status, priority, who has it,
// its tags and its project as pills along the bottom).
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { Popover } from '@base-ui/react/popover';
import { confirmBox, h, md, state, toast } from './core.ts';
import { rpc } from './client/rpc.ts';
import { attachTray } from './attach.tsx';
import type { AttachTray } from './attach.tsx';
import { apiUrl } from './client/connection.ts';
import { icon } from './icons.ts';
import { skillIcon } from './skillicons.ts';
import { loadSkills, skillsCache } from './skillcache.ts';
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
import { TagPicker } from './tasktags.tsx';
import type {
  BoardDraftInput,
  BoardPeople,
  BoardPriority,
  BoardStatus,
  BoardTask,
  TaskFile,
  TaskWorkState,
} from '../shared/types.ts';

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
export const taskHref = (t: Pick<BoardTask, 'projectId' | 'id'>) =>
  `#/tasks/${encodeURIComponent(t.projectId)}/${encodeURIComponent(t.id)}`;

// ---------- an agent's or team's work on a task ----------
/** How a task's work reads on its card and its page. */
export const WORK_STATES: Record<TaskWorkState, { label: string; tone: string; icon: string }> = {
  starting: { label: 'Starting', tone: 'text-accent', icon: 'play' },
  working: { label: 'Working', tone: 'text-accent', icon: 'play' },
  waiting: { label: 'Needs you', tone: 'text-amber', icon: 'hand' },
  review: { label: 'Ready for review', tone: 'text-ok', icon: 'eye' },
  blocked: { label: 'Blocked', tone: 'text-red', icon: 'circle-pause' },
  stopped: { label: 'Stopped', tone: 'text-dim', icon: 'square' },
  'needs-review': { label: 'Needs review', tone: 'text-amber', icon: 'triangle-alert' },
};
/** True while an agent or team works on the task (starting, working, or waiting for your OK). */
export const isWorking = (t: Pick<BoardTask, 'work'>): boolean =>
  !!t.work && ['starting', 'working', 'waiting'].includes(t.work.state);
/** Before a change that stops the work (moving the task away, giving it to someone else, removing it): asks first. */
export function confirmStop(t: BoardTask): Promise<boolean> {
  if (!isWorking(t)) return Promise.resolve(true);
  return confirmBox(`${t.workerName || 'Someone'} is working on ${taskKey(t.number)}. Stop it?`, {
    ok: 'Stop it',
    danger: true,
  });
}

// ---------- files ----------
/** A file on a task, from the task's own project (whichever project is open). */
export const taskFileUrl = (t: Pick<BoardTask, 'projectId' | 'id'>, f: TaskFile) =>
  apiUrl(`/task-board-file/${encodeURIComponent(t.projectId)}/${encodeURIComponent(t.id)}`, { path: f.path });
const IMAGE = /\.(png|jpe?g|webp|gif)$/i;
/** A task's or comment's files: pictures as thumbnails, the rest as chips; each opens in a new tab. */
export function TaskFiles({
  task,
  files,
  onRemove,
}: {
  task: Pick<BoardTask, 'projectId' | 'id'>;
  files: readonly TaskFile[] | undefined;
  onRemove?: (f: TaskFile) => void;
}) {
  if (!files?.length) return null;
  return (
    <div className="task-files flex flex-wrap gap-2">
      {files.map((f) => {
        const url = taskFileUrl(task, f);
        const remove = onRemove ? (
          // biome-ignore lint/correctness/useJsxKeyInIterable: one child of the keyed element below, not a list item
          <button
            type="button"
            className="att-x"
            title="Remove"
            aria-label={`Remove ${f.name}`}
            onClick={() => onRemove(f)}
          >
            <Icon name="x" size={12} />
          </button>
        ) : null;
        return IMAGE.test(f.name) ? (
          <span key={f.path} className="relative inline-flex">
            <a className="att-img group block leading-[0]" href={url} target="_blank" rel="noopener" title={f.name}>
              <img
                className="h-18 w-24 rounded-[8px] border border-line-2 object-cover group-hover:shadow-lift"
                src={url}
                alt={f.name}
                loading="lazy"
              />
            </a>
            {remove ? <span className="absolute -top-1.5 -right-1.5 rounded-full bg-bg">{remove}</span> : null}
          </span>
        ) : (
          <span key={f.path} className="att-chip sent">
            <a
              className="flex min-w-0 items-center gap-1.5 text-inherit no-underline hover:text-accent"
              href={url}
              target="_blank"
              rel="noopener"
              title={f.name}
            >
              <span className="att-ico">
                <Icon name="file" size={13} />
              </span>
              <span className="att-name">{f.name}</span>
            </a>
            {remove}
          </span>
        );
      })}
    </div>
  );
}
/** The app's attachment tray (paperclip, drop, paste) for a React box; what it holds is thrown away when the box goes. */
export function useTray(): AttachTray {
  const [tray] = useState(() => attachTray());
  useEffect(() => () => tray.discard(), [tray]);
  return tray;
}

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
  return useMemo(
    () => [
      ...(people?.agents || []).map((a): Candidate => ({
        kind: 'agent',
        id: a.id,
        name: a.name,
        lead: h('span', { class: 'w-3.5 flex-none text-center' }, a.emoji || '🤖'),
        sub: '',
        color: a.color,
      })),
      ...(people?.teams || []).map((t): Candidate => ({
        kind: 'team',
        id: t.id,
        name: t.name,
        lead: icon('users', 14),
        sub: 'Team',
      })),
      ...skills.map((s): Candidate => ({
        kind: 'skill',
        id: s.slug,
        name: s.name,
        lead: skillIcon(s.slug, 14),
        sub: s.description || '',
      })),
    ],
    [people, skills],
  );
}

/** Gives a text box the @ menu and shows its mentions as pills, as a routine's text does (while on is true). */
export function useMentionBox(box: RefObject<HTMLTextAreaElement | null>, candidates: Candidate[], on = true): void {
  const latest = useRef(candidates);
  latest.current = candidates;
  useEffect(() => {
    const ta = box.current;
    if (!on || !ta) return;
    const offEditor = attachMentionEditor(ta, () =>
      latest.current.map((c) => ({
        tag: `@${c.name}`,
        icon: c.kind === 'team' ? 'users' : c.kind === 'skill' ? 'puzzle' : undefined,
      })),
    );
    const offMenu = attachMentions(
      ta,
      () => latest.current,
      () => {},
    );
    return () => (offMenu(), offEditor());
  }, [box, on]);
}

const PILL_MENTION =
  'inline-flex items-center gap-1 rounded-ctl bg-accent/10 px-1.5 font-medium text-accent align-baseline';
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
          const pill = h('span', {
            class: `task-mention ${PILL_MENTION}`,
            title: c.kind === 'agent' ? 'Agent' : c.kind === 'team' ? 'Team' : 'Skill',
          });
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
export function Markdown({
  text,
  mentions = [],
  className = '',
}: {
  text: string;
  mentions?: readonly Candidate[];
  className?: string;
}) {
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
export function WhoMark({
  who: ref,
  emoji,
  color,
  size = 20,
}: {
  who: string;
  emoji?: string;
  color?: string;
  size?: number;
}) {
  return (
    <span
      aria-hidden="true"
      className="grid flex-none place-items-center rounded-[7px] border border-line bg-panel-2 text-dim"
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.55),
        ...(color ? { boxShadow: `inset 0 -2px 0 ${color}` } : {}),
      }}
    >
      {emoji || (
        <Icon
          name={
            ref === 'brain' ? 'brain' : ref.startsWith('team:') ? 'users' : ref.startsWith('agent:') ? 'bot' : 'user'
          }
          size={Math.round(size * 0.55)}
        />
      )}
    </span>
  );
}

/** Asks the Brain for a draft (nothing is saved). */
export const askForDraft = (input: BoardDraftInput) => rpc.taskBoard.draft(input);

/** What the "Draft with the Brain" box says where it is used: a heading, what the Brain reads, and a hint. */
export interface DraftWording {
  heading: string;
  about: string;
  placeholder: string;
}

/**
 * "Draft with the Brain": what it should say (optional), then the draft goes into the box. draft() puts it there and
 * gives back how to take it out again; Undo shows for a while after. blank: nothing is written yet, so the Brain has
 * to be told what to write (with nothing at all to go on it can't draft).
 */
export function DraftWithBrain({
  draft,
  disabled,
  blank,
  wording,
}: {
  draft: (instruction: string) => Promise<(() => void) | null>;
  disabled?: boolean;
  blank?: boolean;
  wording: DraftWording;
}) {
  const [open, setOpen] = useState(false);
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState(false);
  const [undo, setUndo] = useState<(() => void) | null>(null);
  const id = useId();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const ready = !blank || instruction.trim() !== '';
  const go = async () => {
    if (busy || !ready) return;
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
          <Popover.Positioner
            side="top"
            align="start"
            sideOffset={6}
            collisionPadding={8}
            positionMethod="fixed"
            className="z-96 outline-none"
          >
            <Popover.Popup className="st-menu dd static w-88! max-w-[calc(100vw-16px)]! p-4!">
              {/* (its own form: a submit here must not reach the form the button sits in, through React's tree) */}
              <form
                className="flex flex-col gap-3"
                onSubmit={(e) => (e.preventDefault(), e.stopPropagation(), void go())}
              >
                <div className="flex flex-col gap-1">
                  <h3 id={`${id}-heading`} className="text-[14px] font-medium text-ink">
                    {wording.heading}
                  </h3>
                  <p id={`${id}-about`} className="text-[12.5px] leading-snug text-dim">
                    {wording.about} <span className="text-faint">(optional)</span>
                  </p>
                </div>
                <textarea
                  autoFocus
                  rows={3}
                  value={instruction}
                  maxLength={2000}
                  aria-labelledby={`${id}-heading`}
                  aria-describedby={`${id}-about`}
                  placeholder={wording.placeholder}
                  onChange={(e) => setInstruction(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    // Enter drafts and Shift+Enter starts a new line; the window behind must not see Enter (Ctrl+Enter there saves)
                    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
                    e.stopPropagation();
                    if (!e.shiftKey) (e.preventDefault(), e.currentTarget.form?.requestSubmit());
                  }}
                  disabled={busy}
                  className="min-h-20 resize-y text-[13px] leading-relaxed"
                />
                <Button type="submit" variant="ghost" size="small" className="self-end" disabled={busy || !ready}>
                  <Icon name="sparkles" size={13} />
                  {busy ? 'Drafting…' : 'Draft'}
                </Button>
              </form>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
      {undo ? (
        <Button
          type="button"
          variant="plain"
          size="small"
          onClick={() => (undo(), setUndo(null), clearTimeout(timer.current))}
        >
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
    ...(people?.agents || []).map((a) => ({
      value: `agent:${a.id}`,
      label: a.name,
      mark: <span className="w-3.5 text-center text-[12px]">{a.emoji || '🤖'}</span>,
    })),
    ...(people?.teams || []).map((t) => ({
      value: `team:${t.id}`,
      label: t.name,
      mark: <Icon name="users" size={14} />,
    })),
  ];
}

export const PILL =
  'inline-flex h-7 max-w-56 cursor-pointer items-center gap-1.5 rounded-full border border-line bg-panel/60 px-2.5 text-[12.5px] text-ink [transition:border-color_0.15s,background-color_0.15s] hover:border-line-2 hover:bg-panel-2 disabled:cursor-default disabled:opacity-60 data-popup-open:border-accent';
export const ROW =
  'flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-ctl px-2 py-1.5 text-left text-[13px] text-ink [transition:background-color_0.15s] hover:bg-panel-2 disabled:cursor-default data-popup-open:bg-panel-2';

/** A property as a pill (the new task window) or a row (the task page), opening its choices. */
export function Pick({
  label,
  value,
  choices,
  onChange,
  look = 'pill',
  disabled,
}: {
  label: string;
  value: string;
  choices: readonly Choice[];
  onChange: (v: string) => void;
  look?: 'pill' | 'row';
  disabled?: boolean;
}) {
  const picked = choices.find((c) => c.value === value) || choices[0];
  return (
    <Dropdown>
      <DropdownTrigger
        className={look === 'pill' ? PILL : ROW}
        aria-label={`${label}: ${picked?.label}`}
        disabled={disabled}
      >
        {look === 'row' ? <span className="w-24 flex-none text-dim">{label}</span> : null}
        {picked?.mark}
        <span className="min-w-0 truncate">{picked?.label}</span>
      </DropdownTrigger>
      <DropdownContent align="start" className="min-w-48">
        <DropdownRadioGroup value={value} onValueChange={(v) => onChange(String(v))}>
          {choices.map((c) => (
            <DropdownRadioItem key={c.value} value={c.value} icon={c.mark}>
              {c.label}
            </DropdownRadioItem>
          ))}
        </DropdownRadioGroup>
      </DropdownContent>
    </Dropdown>
  );
}
export const statusChoices = (list = STATUSES): Choice[] =>
  list.map((s) => ({ value: s.value, label: s.label, mark: <StatusIcon status={s.value} size={14} /> }));
export const priorityChoices = (): Choice[] =>
  PRIORITIES.map((p) => ({ value: p.value, label: p.label, mark: <PriorityIcon priority={p.value} /> }));

/** The agents and teams of a project (for who has a task), loaded when the project changes. */
export function usePeople(projectId: string): BoardPeople | null {
  const [people, setPeople] = useState<BoardPeople | null>(null);
  useEffect(() => {
    let live = true;
    setPeople(null);
    if (projectId)
      void rpc.taskBoard.people({ projectId }).then(
        (p) => live && setPeople(p),
        () => live && setPeople({ agents: [], teams: [] }),
      );
    return () => void (live = false);
  }, [projectId]);
  return people;
}

/**
 * Under a new task: whether who it's given to starts on it once it's made. Only an agent, a team or the Brain picks
 * work up, and only from In progress (as the server decides, boardwork.ts canPickUp).
 */
function StartNote({
  assignee,
  status,
  people,
}: {
  assignee: string;
  status: BoardStatus;
  people: BoardPeople | null;
}) {
  const agent = assignee.startsWith('agent:') ? people?.agents.find((a) => `agent:${a.id}` === assignee) : undefined;
  const team = assignee.startsWith('team:') ? people?.teams.find((t) => `team:${t.id}` === assignee) : undefined;
  const name = assignee === 'brain' ? 'The Brain' : agent?.name || team?.name;
  if (!name) return null;
  return (
    <p className="start-note m-0 flex items-center gap-2 pt-1 text-[12.5px] text-dim" aria-live="polite">
      <WhoMark who={assignee} emoji={agent?.emoji} color={agent?.color} size={22} />
      {status === 'in_progress'
        ? `${name} will start working right after creation.`
        : `Assigned — won't start working in ${statusOf(status).label}.`}
    </p>
  );
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

function Composer({
  projectId: startProject,
  status: startStatus = 'todo',
  projects = [],
  onCreated,
  close,
}: ComposerOptions & { close: () => void }) {
  const here = state.data?.project?.id || '';
  const [projectId, setProjectId] = useState(startProject || here);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<BoardStatus>(
    START_STATUSES.some((s) => s.value === startStatus) ? startStatus : 'todo',
  );
  const [priority, setPriority] = useState<BoardPriority>('normal');
  const [assignee, setAssignee] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [another, setAnother] = useState(false);
  const [busy, setBusy] = useState(false);
  const titleBox = useRef<HTMLInputElement>(null);
  const descBox = useRef<HTMLTextAreaElement>(null);
  const people = usePeople(projectId);
  useMentionBox(descBox, useMentionables(projectId));
  const tray = useTray();
  const frame = useRef<HTMLFormElement>(null);
  useEffect(
    () => (frame.current ? tray.dropZone(frame.current, 'Drop files to attach them to the task') : undefined),
    [tray],
  );
  const choices = projects.length ? projects : [{ id: here, name: state.data?.project?.name || 'This project' }];

  const submit = async () => {
    // (the shortcut reaches here too: the button's guard has to hold for it)
    if (busy || !title.trim() || !projectId) return;
    setBusy(true);
    try {
      const files = await tray.ready();
      if (files === null) return;
      const { task } = await rpc.taskBoard.add({
        projectId,
        title,
        description,
        status,
        priority,
        assignee,
        tags,
        files,
      });
      tray.take();
      toast(
        `Created ${taskKey(task.number)}: ${task.title}${task.work && task.workerName ? `. ${task.workerName} started on it.` : ''}`,
      );
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
      ref={frame}
      className="relative flex min-h-0 flex-col"
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
          placeholder="Add a description: what needs to happen, and how you'll know it's done. Type @ to mention an agent, a team or a skill. Markdown supported."
          value={description}
          disabled={busy}
          onChange={(e) => setDescription(e.currentTarget.value)}
          className="min-h-36 resize-none border-0! bg-transparent! px-0! text-[14.5px]! leading-relaxed whitespace-pre-wrap text-ink shadow-none! outline-none focus:shadow-none! empty:before:pointer-events-none empty:before:text-faint empty:before:content-[attr(data-placeholder)]"
        />
        <DomNode make={() => tray.el} deps={[tray]} />
        <StartNote assignee={assignee} status={status} people={people} />
        <div className="flex flex-wrap items-center gap-1.5 pt-2">
          <DomNode as="span" make={() => tray.picker} deps={[tray]} />
          <Pick
            label="Status"
            value={status}
            choices={statusChoices(START_STATUSES)}
            onChange={(v) => setStatus(v as BoardStatus)}
            disabled={busy}
          />
          <Pick
            label="Priority"
            value={priority}
            choices={priorityChoices()}
            onChange={(v) => setPriority(v as BoardPriority)}
            disabled={busy}
          />
          <Pick
            label="Assigned to"
            value={assignee}
            choices={assigneeChoices(people)}
            onChange={setAssignee}
            disabled={busy}
          />
          <TagPicker projectId={projectId} value={tags} onChange={setTags} disabled={busy} />
          {choices.length > 1 ? (
            <Pick
              label="Project"
              value={projectId}
              choices={choices.map((p) => ({
                value: p.id,
                label: p.name,
                mark: <Icon name="folder" size={14} className="text-faint" />,
              }))}
              onChange={(v) => (setProjectId(v), setAssignee(''), setTags([]))}
              disabled={busy}
            />
          ) : null}
        </div>
      </div>
      <div className="modal-foot items-center">
        {/* (two groups, so Undo showing up wraps the left one, never Create task away from Cancel) */}
        <div className="flex min-w-44 flex-1 flex-wrap items-center gap-x-2.5 gap-y-2">
          <DraftWithBrain
            disabled={busy || !projectId}
            wording={{
              heading: 'Draft this task',
              about: 'The Brain reads what you have typed and writes a title and description. Tell it what you want',
              placeholder: 'e.g. Get three quotes for the venue by Friday',
            }}
            blank={!title.trim() && !description.trim()}
            draft={async (instruction) => {
              const d = await askForDraft({ projectId, kind: 'task', title, description, instruction });
              if (d.kind !== 'task') return null;
              const before = { title, description };
              setTitle(d.title);
              setDescription(d.description);
              return () => (setTitle(before.title), setDescription(before.description));
            }}
          />
          <Switch checked={another} onChange={setAnother} className="text-[13px] text-dim" disabled={busy}>
            Create another
          </Switch>
        </div>
        <div className="ml-auto flex flex-none items-center gap-2.5">
          <Button type="button" variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy || !title.trim()}>
            {busy ? 'Creating…' : 'Create task'}
            <kbd className="ml-1 rounded border border-current/25 px-1 font-sans text-[10px] opacity-70">Ctrl ↵</kbd>
          </Button>
        </div>
      </div>
    </form>
  );
}
