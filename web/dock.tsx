// The global chat: one window on every page. Talk to the Brain (it answers, builds teams and agents,
// writes PROJECT.md or hands the work to an agent or team), or straight to any agent or team.
// The chat's state and what it does (sending, /queue, /loop, live events) live here in the module;
// React draws it (draw() asks for a redraw, at most once a frame).
import { StrictMode, Suspense, lazy, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useMentionBox, useMentionables } from './taskboard.tsx';
import { mentionMenuOpen } from './routinemention.ts';
import { createPortal, flushSync } from 'react-dom';
import { createAppRoot } from './ui/root.tsx';
import { h, state, attempt, md, onEvent, onState, navigate, refreshSoon, toast } from './core.ts';
import { rpc } from './client/rpc.ts';
import { openBranchBuilder } from './builder.tsx';
import { modelChip, modelInfo, brainModelChip, brainAsAgent } from './models.tsx';
import { brainQueue, chatLoop, holdQueue, latestLoad } from './brainqueue.ts';
import { queuedText } from '../shared/queue.ts';
import { learnText, parseCommand, parseLoop } from '../shared/commands.ts';
import { commandChips, slashMenu } from './chatcommands.ts';
import { flipFrom, flipTo, slideIn, slideOut, reducedMotion } from './motion.ts';
import { attachTray } from './attach.tsx';
import { pasteBox } from './pastes.ts';
import { QueuedList, keepLostEdit } from './queuedlist.tsx';
import { openMemory, BRAIN } from './memory.tsx';
import { TasksAndChats } from './chatlist.tsx';
import type { ChatListItem } from './chatlist.tsx';
import { mentionPreviews } from './filepreview.tsx';
import { useFind } from './ui/find.tsx';
import { brainKeyLabel, brainKeyTitle, brainShortcut } from './shortcuts.ts';
import { Avatar, DomNode, Icon, IconWeightProvider, useAppState } from './ui/react.tsx';
import { Dot } from './ui/marks.tsx';
import { ChipSet } from './ui/controls.tsx';
import { Button, IconButton } from './ui/button.tsx';
import { Dropdown, DropdownContent, DropdownGroup, DropdownLabel, DropdownRadioGroup, DropdownRadioItem, DropdownTrigger } from './ui/dropdown.tsx';
import type { AttachTray, PickedFile } from './attach.tsx';
import type { PasteBox } from './pastes.ts';
import type { AgentDraft, BranchDesign } from './builder.tsx';
import type { TeamEvent } from './teamchat.tsx';
import type { Agent, AppState, BrainAnswer, BrainChatMessage, BrainDelegate, BrainDone, BrainStep, ChatItem, QueuedMessage, RunEvent, ServerEvent, TeamListing, TeamMessage } from '../shared/types.ts';
import type { UIMessage } from 'ai';

// A handed-off agent's turn, streamed in as it goes: the AI SDK pieces load when first needed.
const TurnView = lazy(() => import('./chat/TurnView.tsx').then((m) => ({ default: m.TurnView })));

/** One line of the Brain's chat history. */
export type BrainHistoryEntry = BrainChatMessage;
/** A workflow run as 'workflow-run' events and GET /api/workflow-runs carry it (old step-list teams). */
interface WorkflowRun {
  id: string;
  status: string;
  steps?: unknown;
  error?: string | null;
  output?: unknown;
}
interface ToolChip {
  id: string;
  name: string;
  status: 'running' | 'done';
  isError?: boolean;
}
/** What a message was sent as (to whom, a /goal?): /resend and /resume send it again the same way. */
interface Sent {
  text: string;
  attachments: string[];
  target: string;
  goal?: boolean;
}
type UserItem = { id: string; kind: 'user'; text: string; attachments?: string[]; sent?: Sent };
/** action: a button after the text ("Send it my message") */
type NoteItem = { id: string; kind: 'note'; text: string; busy?: boolean; error?: boolean; action?: { label: string; run: () => void } };
/** started: its message went, so its turn can be streamed in (web/chat/TurnView); turn: counts the
 *  turns started since (a /resume), so the view follows the new one */
type AgentItem = { id: string; kind: 'agent'; agentId: string; chatId: string; text: string; tools: ToolChip[]; images: string[]; reason: string; done: boolean; status?: string; started?: boolean; turn?: number };
type BranchItem = { id: string; kind: 'branch'; wfId: string; name: string; reason: string; since: number; messages: TeamMessage[]; working: string[]; next?: string[]; runId?: string; steps?: unknown; error?: string | null; output?: string; briefId?: string };
/** live: the answer is still streaming in (answer: what it has written so far; steps: the tools it used) */
type BrainItem = { id: string; kind: 'brain'; answer?: string; done: BrainDone[]; delegate?: BrainDelegate | null; old?: boolean; live?: boolean; steps?: BrainStep[]; ask?: Sent };
type DraftItem = { id: string; kind: 'agent-draft'; agent: AgentDraft; task: string; attachments: string[] };
/** One message in the Brain chat. */
type DockItem = UserItem | NoteItem | AgentItem | BranchItem | BrainItem | DraftItem;
type NewItem = DockItem extends infer T ? (T extends DockItem ? Omit<T, 'id'> : never) : never;
/** A failed request, kept as a value (the .catch below). */
type Failed = { error?: string };

interface Dock {
  open: boolean;
  /** the panel is showing (it stays while it folds back into the button) */
  shown: boolean;
  /** the "Ask the Brain" button: hidden while the chat is open, see-through while the chat folds into it */
  launcherHidden: boolean;
  launcherFaded: boolean;
  /** 'auto' | 'new-agent' | 'new-branch' | 'a:<agent id>' | 'b:<team id>' */
  target: string;
  items: DockItem[];
  input: HTMLTextAreaElement | null;
  workflows: TeamListing[];
  /** the project this chat shows */
  project: string | null;
  panel: HTMLDivElement | null;
  launcher: HTMLButtonElement | null;
  /** Files waiting to go with the next message. */
  tray?: AttachTray;
  /** Long pasted text, folded into a chip until it is sent. */
  pastes?: PasteBox;
  /** What the last /stop cut off: the Brain's answer it was writing, and the agents and teams working from here. */
  stoppedAsk?: Sent | null;
  stoppedWork?: { chats: { agentId: string; chatId: string }[]; teams: string[] } | null;
}

const D: Dock = { open: false, shown: false, launcherHidden: false, launcherFaded: false, target: 'auto', items: [], input: null, workflows: [], project: null, panel: null, launcher: null };
const PLACEHOLDER = 'What do you want done?';
// what the empty chat offers to start with (click one: it goes into the box, ready to send or change)
const SUGGESTIONS = ['What is everyone working on?', 'Make me a social media team', 'Write PROJECT.md for this project'];

// ---------- looks (dock-msg, user and brain stay: tests look them up) ----------
// Answers sit on the glass with no card of their own (the name row says who wrote them); yours is a soft plate.
const MSG = 'dock-msg animate-[rise-in_0.22s_var(--ease-soft)] text-[14px] leading-[1.6] wrap-anywhere';
const MSG_AGENT = MSG;
const MSG_DRAFT = `${MSG} rounded-box border py-3 px-4 border-[color-mix(in_srgb,var(--color-accent)_40%,var(--color-line))] bg-panel`;
const MSG_USER = `${MSG} user font-chat self-end max-w-[85%] whitespace-pre-wrap rounded-[12px] border border-line bg-panel-2 py-2.5 px-3.5`;
/** who wrote it: the avatar, the name, a hint (smaller in a team's thread) */
const WHO = 'flex items-center gap-2.5 mb-2 [&_.avatar]:size-6 [&_.avatar]:text-[12px] [&_b]:text-[13px]';
const WHO_SMALL = 'flex items-center gap-2.5 mb-2.5 [&_.avatar]:size-6 [&_.avatar]:text-[12px]';
const NOTE = 'animate-[rise-in_0.22s_var(--ease-soft)] flex flex-wrap items-center gap-2.5 text-[13px] text-dim';
const NOTE_ERR = 'animate-[rise-in_0.22s_var(--ease-soft)] flex flex-wrap items-center gap-2.5 text-[13px] text-red';
/** an answer in Markdown */
const ANSWER = 'font-chat [&_p]:mx-0 [&_p]:mt-0 [&_p]:mb-2.5 [&_pre]:max-h-[220px]';
const BRAIN_AV = 'avatar bg-accent/10 text-accent';
const ACT = 'flex items-center gap-2.5 py-1.5 px-3 rounded-ctl text-[13px] border animate-[rise-in_.22s_ease-out_both]';
const ACT_OK = `${ACT} bg-panel border-line`;
const ACT_ERR = `${ACT} bg-amber/8 border-[color-mix(in_srgb,var(--color-amber)_35%,var(--color-line))]`;

// ---------- drawing ----------
// React reads the module's state; notify() draws it again now, draw() at most once a frame.
let version = 0;
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));
const notify = () => {
  version++;
  for (const l of listeners) l();
};
const useDock = () => useSyncExternalStore(subscribe, () => version);
const now = () => flushSync(notify);
let frame = false;
function draw() {
  if (frame) return;
  frame = true;
  requestAnimationFrame(() => {
    frame = false;
    notify();
    // something may have finished: a /queue message can go now, then the loop's next one
    held.check();
    loop.check();
  });
}

export function initDock(): void {
  D.tray = attachTray({ onChange: draw, iconWeight: 'regular' });
  D.pastes = pasteBox();
  // the bottom bar holds the "Ask the Brain" button (and the minimized chats, web/chatwin.tsx)
  const bar = h('div.bottom-bar', { class: 'fixed z-45 left-1/2 bottom-4.5 [transform:translateX(-50%)] flex items-center gap-2.5 pointer-events-none *:pointer-events-auto' });
  const host = h('div.dom-contents');
  document.body.append(bar, host);
  D.project = state.data?.project?.id || null;
  // (drawn at once: askBrain() and openDock() may come right after)
  const root = createAppRoot(host);
  flushSync(() =>
    root.render(
      <StrictMode>
        {/* the chat's icons are a step stronger, like the Station panel's */}
        <IconWeightProvider value="regular">
          <DockView bar={bar} />
        </IconWeightProvider>
      </StrictMode>,
    ),
  );
  onState(() => {
    checkTarget();
    draw();
  });
  onState(projectChanged);
  // Ctrl+K (⌘K) opens or closes the chat from anywhere; Space opens it on the Station
  document.addEventListener('keydown', (e) => {
    const shortcut = brainShortcut(e, { open: D.open, onStation: onStation() });
    if (shortcut) {
      e.preventDefault();
      toggle(shortcut === 'open' ? true : !D.open);
    } else if (e.key === 'Escape' && D.open && !e.defaultPrevented && !document.querySelector('.modal-back, .model-menu, .st-menu')) {
      // (a menu that is open takes the Esc: it closes, and the chat stays)
      e.preventDefault();
      toggle(false);
    }
  });
  onEvent(handleEvent);
  loadWorkflows();
  loadHistory();
}

const onStation = () => document.body.classList.contains('station-mode');
// the Station (where Space opens it) comes and goes with the page
const watchBody = (tick: () => void) => {
  const o = new MutationObserver(tick);
  o.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  return () => o.disconnect();
};

// Ask the Brain from anywhere (e.g. right after creating a project), with files already uploaded.
export function askBrain(text: string, attachments: string[] = []): void {
  D.target = 'auto';
  toggle(true);
  now();
  D.input!.value = text;
  send(attachments);
}

// Files dropped on the Brain on the map: open the Brain chat with them attached, ready for what to do.
export function attachToBrain(picked: PickedFile[]): void {
  D.target = 'auto';
  toggle(true);
  draw();
  D.tray!.add(picked);
  setTimeout(() => D.input?.focus(), 40);
}

// The last few turns with the Brain, so the chat picks up where it left off.
// (only the newest load counts: one from a project you have since left must not fill this one's chat)
// whole: a chat you opened from the list shows all that was kept of it (the work it handed on is followed for the last few)
const historyLoads = latestLoad();
async function loadHistory({ whole = false }: { whole?: boolean } = {}) {
  const current = historyLoads.start();
  const project = D.project;
  const msgs = await rpc.brain.history().catch((): BrainHistoryEntry[] => []);
  if (!current() || project !== D.project || D.items.length) return;
  const shown = whole ? msgs : msgs.slice(-6);
  shown.forEach((m, i) => {
    if (m.role === 'user') D.items.push({ id: `h${m.ts}u`, kind: 'user', text: m.text, attachments: m.attachments });
    else {
      const b = savedAnswer(m);
      D.items.push({ id: `h${m.ts}b`, kind: 'brain', ...b, old: true });
      // the agent or team it handed the work to, followed below it again
      if (b.delegate && i >= shown.length - 6) follow(b.delegate);
    }
  });
  draw();
}

// A saved Brain answer with the files it read and what it did shown as they were live. Answers saved before the actions were
// kept apart have them in the text as "(…)" lines at the end; those are split off as plain notes.
export function savedAnswer(m: BrainHistoryEntry): { answer: string; done: BrainDone[]; delegate?: BrainDelegate; steps?: BrainStep[] } {
  const delegate = m.delegate ? { ...m.delegate } : undefined;
  if (m.done || m.delegate || m.steps) return { answer: m.text, done: m.done || [], delegate, steps: m.steps };
  const lines = m.text.split('\n');
  const done: BrainDone[] = [];
  let legacy: BrainDelegate | undefined;
  // (a whole answer in brackets, like "(stopped before answering…)", stays the answer)
  while (lines.length > 1 && /^\(.+\)$/.test(lines.at(-1)!.trim())) {
    const t = lines.pop()!.trim().slice(1, -1);
    const to = /^handed to (.+?): /.exec(t);
    if (to && !legacy) legacy = { kind: 'agent', id: '', name: to[1], message: t.slice(to[0].length) };
    else done.unshift({ kind: 'note', text: t });
  }
  return { answer: lines.join('\n').trimEnd(), done, delegate: legacy };
}

// ---------- the Brain chat's conversations ----------
// New chat keeps the conversation with the earlier ones (the list beside it opens them again); the Brain starts
// on an empty one. (The server swaps them: server/overseer.ts newBrainThread.)
/** The conversation shown (null until this chat started or opened one), and switches on their way from here. */
let thread: string | null = null;
let switching = 0;
async function switchThread(go: () => Promise<{ id: string }>, { whole = false }: { whole?: boolean } = {}): Promise<boolean> {
  switching++;
  const r = await attempt(go).finally(() => switching--);
  if (!r) return false;
  thread = r.id;
  leaveConversation();
  loadHistory({ whole });
  return true;
}
const newConversation = () => switchThread(() => rpc.brain.newThread()).then((ok) => ok && D.input?.focus());
const openConversation = (id: string) => switchThread(() => rpc.brain.openThread({ chatId: id }), { whole: true });
async function removeConversation(c: ChatListItem): Promise<boolean> {
  if ((await attempt(() => rpc.brain.removeThread({ chatId: c.id }))) === undefined) return false;
  // (the open one was emptied: so is the chat)
  if (c.open) {
    leaveConversation();
    draw();
  }
  return true;
}
// what was going on in the conversation just left goes with it
function leaveConversation() {
  brainAsks.reset(); // answers still on their way belong to the old conversation
  held.clear();
  loop.stop();
  historyLoads.reset();
  forgetConversation();
  draw();
}
// another tab opened another conversation, or started a new one
function threadChanged(id: string) {
  if (switching || id === thread) return;
  thread = id;
  leaveConversation();
  loadHistory({ whole: true });
}

// What belonged to the conversation just left: what /resume would pick up again, and (by the
// generation) the agent and team designs still on their way.
let conversation = 0;
function forgetConversation() {
  conversation++;
  D.stoppedAsk = null;
  D.stoppedWork = null;
  D.items = [];
}
/** Take an item out of the chat, if it is still there (a new conversation may have cleared it). */
function remove(it: DockItem) {
  const at = D.items.indexOf(it);
  if (at !== -1) D.items.splice(at, 1);
}

// Another project was opened: this chat was about the old one. Drop it (and anything still waiting
// to be sent or answered there) and show the new project's Brain chat.
function projectChanged(d: { project?: { id: string } | null }) {
  const id = d.project?.id || null;
  if (!id || id === D.project) return;
  const first = D.project === null;
  D.project = id;
  if (first) return;
  thread = null;
  brainAsks.reset();
  held.clear();
  loop.stop();
  forgetConversation();
  draw();
  loadHistory();
  loadWorkflows();
}

export function openDock(target: string | null = null, text = ''): void {
  if (target) D.target = target;
  toggle(true);
  checkTarget();
  now();
  if (text) {
    D.input!.value = text;
    D.pastes!.sync();
  }
}

// Opening grows the chat out of the "Ask the Brain" button; closing folds it back into it. A page without the button
// (the Overview, a full chat page) has it rise and sink where it is instead.
const noButton = () => document.body.classList.contains('no-brain-button') || document.body.classList.contains('in-chat');
let closing: Promise<void> | null = null;
function toggle(open: boolean) {
  if (open === D.open && !closing) return;
  D.open = open;
  const { panel, launcher } = D;
  if (open) {
    const from = launcher?.getBoundingClientRect();
    closing = null;
    panel?.getAnimations().forEach((a) => a.cancel());
    Object.assign(D, { shown: true, launcherHidden: true, launcherFaded: false });
    checkTarget();
    now();
    if (panel && !noButton() && from?.width && !reducedMotion()) {
      flipFrom(panel, from, { duration: 460, fade: true });
      // the inside arrives a moment later, so the shape leads
      for (const [i, part] of [...panel.children].entries()) slideIn(part, { y: 10, duration: 360 + i * 60 })?.effect?.updateTiming({ delay: 120 + i * 40, fill: 'backwards' });
    }
    else if (panel && noButton()) slideIn(panel, { y: 12, scale: 0.98, duration: 300 });
    setTimeout(() => D.input?.focus(), 30);
    return;
  }
  // closing: show the button again (invisible) so we know where to fold into
  Object.assign(D, { launcherHidden: false, launcherFaded: true });
  now();
  if (!panel || !launcher) return void (Object.assign(D, { shown: false, launcherFaded: false }), now());
  const fold = noButton() ? slideOut(panel, { y: 12, scale: 0.98 }) : flipTo(panel, launcher.getBoundingClientRect(), { duration: 300 });
  const done = (closing = fold.then(() => {
    if (closing !== done) return;
    closing = null;
    Object.assign(D, { shown: false, launcherFaded: false });
    now();
    slideIn(launcher, { scale: 0.92, duration: 260 });
  }));
}

async function loadWorkflows() {
  D.workflows = await rpc.workflows.list().catch(() => D.workflows);
  checkTarget();
  draw();
}

// Who you can write to: the Brain, a new agent or team, any agent, any team.
const teamsToPick = () => D.workflows.filter((w) => w.members?.length || w.steps?.length);
function checkTarget() {
  const t = D.target;
  const ok = t === 'auto' || t === 'new-agent' || t === 'new-branch' || (t.startsWith('a:') && !!state.data?.agents.some((a) => a.id === t.slice(2))) || (t.startsWith('b:') && teamsToPick().some((w) => w.id === t.slice(2)));
  if (!ok) D.target = 'auto';
}

// The model that will answer: the agent's (switchable), the Brain's own for Auto / New, or the team's lead.
function modelNode(t: string, agents: readonly Agent[]): Node | null {
  if (t.startsWith('a:')) {
    const a = agents.find((x) => x.id === t.slice(2));
    return a ? modelChip(a, { compact: true }) : null;
  }
  if (t.startsWith('b:')) {
    const wf = D.workflows.find((w) => w.id === t.slice(2));
    const lead = wf?.lead ? agents.find((x) => x.id === wf.lead) : null;
    return lead ? h('span', { class: 'inline-flex items-center gap-1 text-[11px]', title: 'The team lead answers first' }, '★ ', modelChip(lead, { compact: true })) : h('span.hint', { class: 'inline-flex items-center gap-1 text-[11px]' }, 'each agent its own model');
  }
  // The Brain itself (and New agent / New team): the Brain's own model
  return brainModelChip();
}

// ---------- messages ----------
function add<K extends DockItem['kind']>(item: NewItem & { kind: K }): Extract<DockItem, { kind: K }> {
  D.items.push({ id: Math.random().toString(36).slice(2), ...item } as DockItem);
  draw();
  return D.items[D.items.length - 1] as Extract<DockItem, { kind: K }>;
}

const agentOf = (id: string) => state.data?.agents.find((a) => a.id === id);

/** Markdown, as a plain-DOM piece, with the chat's classes. */
function Markdown({ text, className }: { text: string; className: string }) {
  return (
    <DomNode
      className="dom-contents"
      make={() => {
        const el = md(text);
        el.classList.add(...className.split(' ').filter(Boolean));
        return el;
      }}
      deps={[text, className]}
    />
  );
}
function Previews({ text, attachments, id }: { text: string; attachments?: string[]; id: string }) {
  return <DomNode className="dom-contents" make={() => mentionPreviews(text, attachments, { compact: true, key: `dock:${id}` })} deps={[id, text, JSON.stringify(attachments || [])]} />;
}

// A tool call the Brain made, as the chats show them (open it for its input and result).
export function StepCard({ st }: { st: BrainStep }) {
  const input = typeof st.input === 'string' ? st.input : JSON.stringify(st.input ?? {}, null, 2);
  const brief = st.input && typeof st.input === 'object' ? Object.values(st.input as Record<string, unknown>).filter((v) => typeof v === 'string').join(' · ').slice(0, 120) : '';
  return (
    <details className={`tool small${st.state === 'error' ? ' error' : ''}`}>
      <summary>
        {st.state === 'running' ? <Dot tone="busy" /> : st.state === 'error' ? <span className="text-red">✕</span> : <span className="text-accent">✓</span>}
        <span className="tname">{st.name}</span>
        <span className="targ">{brief}</span>
      </summary>
      <div className="tbody">
        <div className="label">Input</div>
        <pre>{input}</pre>
        {st.state === 'running' ? (
          <div className="hint">Running…</div>
        ) : (
          <>
            <div className="label">{st.state === 'error' ? 'Error' : 'Result'}</div>
            <pre>{st.output || '(empty)'}</pre>
          </>
        )}
      </div>
    </details>
  );
}

const DONE_ICONS: Record<string, string> = { team: 'users', hired: 'user-plus', file: 'file-text', routine: 'repeat', skill: 'puzzle', model: 'cpu', mcp: 'plug', stop: 'square', memory: 'file-text', error: 'triangle-alert', note: 'check' };
// What the Brain did, with where to see it.
function DoneAction({ d }: { d: BrainDone }) {
  const suffix = d.kind === 'task' && d.taskId ? ` [${d.taskId}]` : '';
  const text = suffix && d.text.endsWith(suffix) ? d.text.slice(0, -suffix.length) : d.text;
  const open = d.boardTask
    ? { label: 'Open', go: () => navigate(`#/tasks/${encodeURIComponent(d.boardTask!.projectId)}/${encodeURIComponent(d.boardTask!.id)}`) }
    : d.teamId
    ? { label: 'Show', go: () => navigate(`#/station?team=${d.teamId}`) }
    : d.routineId
      ? { label: 'Open', go: () => navigate(`#/routines/${d.routineId}`) }
      : d.skillId
        ? { label: 'Open', go: () => navigate(`#/skills/${d.skillId}`) }
        : d.kind === 'mcp'
          ? { label: 'Open', go: () => navigate('#/settings?tab=mcp') }
          : d.memory
            ? { label: 'Open', go: () => openMemory(d.memory!, d.memory === BRAIN ? 'The Brain' : agentOf(d.memory!)?.name) }
            : null;
  return (
    <div className={d.kind === 'error' ? ACT_ERR : ACT_OK}>
      <Icon name={DONE_ICONS[d.kind] || 'check'} size={13} />
      <span className="flex-1">{text}</span>
      {open ? (
        <Button size="tiny" variant="ghost" onClick={open.go}>
          {open.label}
        </Button>
      ) : null}
    </div>
  );
}

function BrainMessage({ it, settings }: { it: BrainItem; settings: AppState['settings'] | undefined }) {
  const b = settings?.brain || { model: 'haiku' };
  return (
    <div className={`${MSG_AGENT} brain`}>
      <div className={WHO}>
        <div className={BRAIN_AV}>
          <Icon name="brain" size={14} />
        </div>
        <b>Brain</b>
        <span className="text-[11.5px] text-faint font-mono">{modelInfo(brainAsAgent(b)).short}</span>
      </div>
      {it.steps?.length ? (
        <div className="flex flex-col gap-1.5 my-2 font-mono text-[12.5px] leading-[normal] font-normal text-dim">
          {it.steps.map((st) => (
            <StepCard key={st.id} st={st} />
          ))}
        </div>
      ) : null}
      {/* (still streaming: what it has written so far; nothing yet: it is looking at the project) */}
      {it.live && !it.answer ? (
        <div className={NOTE}>
          <Dot tone="busy" />
          The Brain is looking at the project…
        </div>
      ) : (
        <Markdown text={it.answer || (it.done?.length ? '' : '(no answer)')} className={it.live ? `${ANSWER} cursor` : ANSWER} />
      )}
      {it.answer && !it.live ? <Previews text={it.answer} id={it.id} /> : null}
      {it.done?.length ? (
        <div className="flex flex-col gap-2 mt-3">
          {it.done.map((d, i) => (
            <DoneAction key={i} d={d} />
          ))}
        </div>
      ) : null}
      {it.delegate ? (
        <div className={`${ACT_OK} mt-2`}>
          <Icon name="send" size={13} />
          <span className="flex-1">
            Handed to <b>{it.delegate.name}</b>
          </span>
        </div>
      ) : null}
    </div>
  );
}

function AgentMessage({ it }: { it: AgentItem }) {
  const a = agentOf(it.agentId);
  return (
    <div className={MSG_AGENT}>
      <div className={WHO}>
        {a ? <Avatar agent={a} /> : null}
        <b>{a?.name || 'Agent'}</b>
        {a ? <span className="text-[11.5px] text-faint font-mono">{modelInfo(a).short}</span> : null}
        {it.reason ? <span className="hint">{it.reason}</span> : null}
        <span className="flex-1 min-w-0" />
        <Button size="tiny" variant="ghost" onClick={() => navigate(`#/agents/${it.agentId}/${it.chatId}`)}>
          Open chat
        </Button>
      </div>
      {/* its turn, streamed in: text as written, tool calls you can open (and file previews) */}
      {it.started ? (
        <div className="flex flex-col gap-2 min-w-0">
          <Suspense fallback={null}>
            <TurnView key={it.turn || 0} agentId={it.agentId} chatId={it.chatId} live onSend={(t) => void continueAgent(it, t)} />
          </Suspense>
        </div>
      ) : it.text ? (
        <Markdown text={it.text} className={ANSWER} />
      ) : (
        <div className="hint">{it.done ? '(no answer)' : 'Working…'}</div>
      )}
      {!it.done ? (
        <div className={NOTE}>
          <Dot tone="busy" />
          {it.status || 'Working…'}
        </div>
      ) : null}
    </div>
  );
}

function TeamThreadMessage({ m }: { m: TeamMessage }) {
  const a = agentOf(m.from);
  // (the Brain follows up in the thread too)
  const brain = m.from === 'brain';
  return (
    <div className="border-t border-line pt-3 mt-3">
      <div className={WHO_SMALL}>
        {a ? (
          <Avatar agent={a} />
        ) : brain ? (
          <div className={BRAIN_AV}>
            <Icon name="brain" size={14} />
          </div>
        ) : null}
        <b>{a?.name || (brain ? 'Brain' : 'Team')}</b>
        {m.mentions?.length ? <span className="hint">{`→ ${m.mentions.map((id) => agentOf(id)?.name).filter(Boolean).join(', ')}`}</span> : null}
      </div>
      <Markdown text={String(m.text).slice(0, 3000)} className={ANSWER} />
      <Previews text={m.text} attachments={m.attachments} id={m.id} />
    </div>
  );
}

function TeamMessageView({ it }: { it: BranchItem }) {
  const nameOf = (id: string) => (id === 'brain' ? 'Brain' : agentOf(id)?.name);
  return (
    <div className={MSG_AGENT}>
      <div className={WHO}>
        <div className="avatar">
          <Icon name="users" size={14} />
        </div>
        <b>{it.name}</b>
        {it.reason ? <span className="hint">{it.reason}</span> : null}
        <span className="flex-1 min-w-0" />
        <Button size="tiny" variant="ghost" onClick={() => navigate('#/station')}>
          Open team
        </Button>
      </div>
      {(it.messages || []).map((m) => (
        <TeamThreadMessage key={m.id} m={m} />
      ))}
      {it.working?.length ? (
        <div className={NOTE}>
          <Dot tone="busy" />
          {`${it.working.map((id) => nameOf(id) || 'Agent').join(', ')} working…`}
        </div>
      ) : !it.messages?.length ? (
        <div className={NOTE}>
          <Dot tone="busy" />
          Sent to the team…
        </div>
      ) : null}
    </div>
  );
}

// A new agent the Brain designed: check it, then create it.
function DraftCard({ it }: { it: DraftItem }) {
  const a = it.agent;
  const [name, setName] = useState(a.name);
  const [spec, setSpec] = useState(a.specialty);
  const [groups, setGroups] = useState<string[]>(a.toolGroups || []);
  // the card turns into a plain note once it is done
  const becomeNote = (text: string) => {
    Object.assign(it as unknown as NoteItem, { kind: 'note', text });
    draw();
  };
  const create = async (thenRun: boolean) => {
    const created = await attempt(() => rpc.agents.create(a));
    if (!created) return;
    becomeNote(`Created ${created.emoji || ''} ${created.name}.`);
    refreshSoon(0);
    if (thenRun) void toAgent(created.id, it.task, 'new agent', it.attachments);
  };
  return (
    <div className={MSG_DRAFT}>
      <div className={WHO}>
        <div className="avatar">{a.emoji}</div>
        <b>New agent</b>
        <span className="hint">designed from your message</span>
      </div>
      <div className="flex flex-col gap-2.5">
        <input aria-label="Name" value={name} onChange={(e) => setName((a.name = e.target.value))} />
        <input aria-label="What it does" value={spec} onChange={(e) => setSpec((a.specialty = e.target.value))} />
      </div>
      <div className="mt-4">
        <ChipSet label="Tools" options={(state.data?.toolGroups || []).map((g) => ({ value: g.id, label: g.label, title: g.description }))} value={groups} onChange={(v) => setGroups((a.toolGroups = v))} />
      </div>
      <details className="mt-4">
        <summary className="hint cursor-pointer">Instructions</summary>
        <pre>{a.systemPrompt}</pre>
      </details>
      <div className="flex flex-wrap items-center gap-3 mt-4">
        <Button size="small" onClick={() => void create(true)}>
          Create &amp; do it
        </Button>
        <Button variant="ghost" size="small" onClick={() => void create(false)}>
          Create only
        </Button>
        <Button variant="ghost" size="small" onClick={() => becomeNote('Skipped.')}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function Item({ it, settings }: { it: DockItem; settings: AppState['settings'] | undefined }) {
  if (it.kind === 'user')
    return (
      <div className="flex flex-col gap-2">
        <div className={MSG_USER}>{it.text || null}</div>
        <Previews text={it.text} attachments={it.attachments} id={it.id} />
      </div>
    );
  if (it.kind === 'note')
    return (
      <div className={it.error ? NOTE_ERR : NOTE}>
        {it.busy ? <Dot tone="busy" /> : null}
        {it.text}
        {it.action ? (
          <Button size="tiny" onClick={it.action.run}>
            {it.action.label}
          </Button>
        ) : null}
      </div>
    );
  if (it.kind === 'agent') return <AgentMessage it={it} />;
  if (it.kind === 'branch') return <TeamMessageView it={it} />;
  if (it.kind === 'brain') return <BrainMessage it={it} settings={settings} />;
  if (it.kind === 'agent-draft') return <DraftCard it={it} />;
  return null;
}

// The messages. They stay the same elements while the chat changes (each piece of a streaming answer
// draws them again), so none replays its entrance.
function DockList({ settings }: { settings: AppState['settings'] | undefined }) {
  const list = useRef<HTMLDivElement>(null);
  // stays at the newest message while you are there (by where you scrolled), following what grows
  const stick = useRef(true);
  const follow = () => {
    const el = list.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  };
  useLayoutEffect(follow);
  useEffect(() => {
    const el = list.current!;
    const grows = new MutationObserver(follow);
    grows.observe(el, { childList: true, subtree: true, characterData: true });
    el.addEventListener('load', follow, true);
    el.addEventListener('loadedmetadata', follow, true);
    return () => {
      grows.disconnect();
      el.removeEventListener('load', follow, true);
      el.removeEventListener('loadedmetadata', follow, true);
    };
  }, []);
  // Ctrl+F (⌘F)
  const find = useFind(list);
  return (
    <>
      {find}
      <div
        className="dock-list flex-1 min-h-0 overflow-y-auto px-5 pt-4 pb-5 flex flex-col gap-6 [mask-image:linear-gradient(to_bottom,transparent_0,#000_12px,#000_calc(100%-14px),transparent_100%)]"
        ref={list}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {D.items.length ? (
          D.items.map((it) => <Item key={it.id} it={it} settings={settings} />)
        ) : (
          <div className="m-auto flex w-full max-w-[380px] flex-col items-center py-6 text-center">
            <div className="mb-4 grid size-11 place-items-center rounded-[12px] border border-line bg-panel text-accent shadow-[inset_0_1px_0_var(--glass-spec)]">
              <Icon name="sparkles" size={20} />
            </div>
            <h3 className="m-0 text-[16px] leading-[1.3] font-semibold text-ink">Ask the Brain</h3>
            <p className="mt-1.5 mb-0 text-[13.5px] leading-[1.55] text-dim">Ask about the project, or ask for anything to be done. It sees every agent and team, builds teams from the Agent library, and hands work to the right one.</p>
            <div className="mt-5 flex w-full flex-col gap-1.5">
              {SUGGESTIONS.map((s) => (
                <button type="button" key={s} className="dock-suggest" onClick={() => suggest(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </>
  );
}

// Who the next message goes to: the Brain, a new agent or team, any agent, any team. One pick; its check marks it.
function TargetMenu({ agents, teams }: { agents: readonly Agent[]; teams: readonly TeamListing[] }) {
  const t = D.target;
  const agent = t.startsWith('a:') ? agents.find((a) => a.id === t.slice(2)) : undefined;
  const team = t.startsWith('b:') ? teams.find((w) => w.id === t.slice(2)) : undefined;
  const shown = agent?.name || team?.name || (t === 'new-agent' ? 'New agent' : t === 'new-branch' ? 'New team' : 'The Brain');
  // an agent's badge (a plain <select> could only show its emoji as small text)
  const badge = (a: Agent, size: string) => (
    <span className={`flex flex-none ${size}`}>
      <Avatar agent={a} />
    </span>
  );
  return (
    <Dropdown>
      <DropdownTrigger className="dock-target" aria-label="Send to" title="Who gets your message. The Brain answers, builds teams and agents, and hands work on.">
        {agent ? badge(agent, '[&_.avatar]:size-4 [&_.avatar]:text-[10px]') : null}
        <span className="min-w-0 truncate">{shown}</span>
        <Icon name="chevron-down" size={12} className="flex-none text-faint" />
      </DropdownTrigger>
      <DropdownContent side="top" align="start" className="max-h-96 min-w-52">
        <DropdownRadioGroup
          value={t}
          onValueChange={(v) => {
            D.target = String(v);
            now();
          }}
        >
          <DropdownRadioItem value="auto" icon={<Icon name="brain" size={16} />}>
            The Brain
          </DropdownRadioItem>
          <DropdownRadioItem value="new-agent" icon={<Icon name="user-plus" size={16} />}>
            New agent from this
          </DropdownRadioItem>
          <DropdownRadioItem value="new-branch" icon={<Icon name="users" size={16} />}>
            New team from this
          </DropdownRadioItem>
          {agents.length ? (
            <DropdownGroup>
              <DropdownLabel>Agents</DropdownLabel>
              {agents.map((a) => (
                <DropdownRadioItem key={a.id} value={`a:${a.id}`} icon={badge(a, '[&_.avatar]:size-5 [&_.avatar]:text-[12px]')}>
                  {a.name}
                </DropdownRadioItem>
              ))}
            </DropdownGroup>
          ) : null}
          {teams.length ? (
            <DropdownGroup>
              <DropdownLabel>Teams</DropdownLabel>
              {teams.map((w) => (
                <DropdownRadioItem key={w.id} value={`b:${w.id}`} icon={<Icon name="users" size={16} />}>
                  {w.name}
                </DropdownRadioItem>
              ))}
            </DropdownGroup>
          ) : null}
        </DropdownRadioGroup>
      </DropdownContent>
    </Dropdown>
  );
}

// An example from the empty chat goes into the box (as if typed: the / menu and Send see it), ready to send or change.
function suggest(text: string) {
  const box = D.input;
  if (!box) return;
  box.value = text;
  box.dispatchEvent(new Event('input', { bubbles: true }));
  box.focus();
  box.setSelectionRange(text.length, text.length);
}

// whether the box had words in it when the chat was last drawn (typing redraws only when that changes)
let drawnFilled = false;

function DockView({ bar }: { bar: HTMLElement }) {
  useDock();
  const data = useAppState();
  const station = useSyncExternalStore(watchBody, onStation);
  const input = useRef<HTMLTextAreaElement>(null);
  const slashHost = useRef<HTMLSpanElement>(null);
  const chips = useRef<HTMLDivElement>(null);
  // the queued message being changed (its id)
  const [editing, setEditing] = useState<string | null>(null);

  // @ an agent, a team or a skill of this project: a menu, and pills while you write (as in tasks and routines)
  useMentionBox(input, useMentionables(data?.project?.id || ''));

  // the box: the / menu, long pastes, Enter to send; files dropped anywhere on the chat
  useLayoutEffect(() => {
    const box = input.current!;
    D.input = box;
    const slash = slashMenu(box, 'brain', { run: () => void send() });
    slashHost.current!.replaceChildren(slash.el);
    const offPastes = D.pastes!.attach(box);
    const onInput = () => {
      slash.update();
      // (Send or Stop: drawn again only when the box goes from empty to not, or back)
      if (!!box.value.trim() !== drawnFilled) draw();
    };
    const onKey = (e: KeyboardEvent) => {
      // (while the @ menu is open, its keys are its own: Enter or Tab picks a name)
      if (mentionMenuOpen(box) || slash.key(e)) return;
      // Up in an empty box: change the last queued message
      const waiting = held.items();
      if (e.key === 'ArrowUp' && !box.value && waiting.length && !e.altKey && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        return setEditing(waiting[waiting.length - 1].id);
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        void send();
      }
    };
    box.addEventListener('input', onInput);
    box.addEventListener('keydown', onKey);
    const offDrop = D.tray!.dropZone(D.panel!, 'Drop files or folders for the Brain');
    return () => {
      box.removeEventListener('input', onInput);
      box.removeEventListener('keydown', onKey);
      offPastes();
      offDrop();
    };
  }, []);

  // your /loop's chip
  const loopSig = JSON.stringify(loop.info());
  useEffect(() => {
    commandChips(chips.current!, { loop: loop.info(), goal: null, onStopLoop: () => loop.stop() && add({ kind: 'note', text: 'Loop stopped.' }), onClearGoal: () => {} });
  }, [loopSig]);

  const agents = data?.agents || [];
  const teams = teamsToPick();
  const waiting = held.items();
  const idle = dockIdle();
  // the button says so while the Brain writes an answer
  const brainBusy = D.items.some((it) => it.kind === 'brain' && it.live);
  const placeholder = D.tray?.count() ? 'What should be done with these files?' : idle ? PLACEHOLDER : 'Working… Write to change course now, or /queue a message for when this is done';
  // nothing to send while something works: Stop in Send's place
  drawnFilled = !!D.input?.value.trim();
  const stopInstead = !idle && !drawnFilled && !D.tray?.count();
  // (the list works with queued messages: the files a held one carries, and whom it goes to)
  const queuedItems: QueuedMessage[] = waiting.map((m) => ({ id: m.id, text: m.text, ts: 0, ...(m.extra.attachments.length ? { attachments: m.extra.attachments } : {}) }));
  const targetOf = new Map(waiting.map((m) => [m.id, m.extra.target]));
  return (
    <>
      {createPortal(
        <button
          type="button"
          ref={(el) => void (D.launcher = el)}
          className={`dock-launcher glass relative flex items-center gap-2.5 py-2.5 pr-3 pl-3.5 whitespace-nowrap cursor-pointer rounded-full text-ink font-sans text-[14px] font-medium leading-[normal] [transition:transform_0.18s_var(--ease-soft),opacity_0.2s] hover:[transform:translateY(-1px)] in-[.in-chat]:hidden in-[.no-brain-button]:hidden max-md:in-[.nav-open]:hidden ${D.launcherHidden ? ' hidden' : ''}`}
          style={D.launcherFaded ? { opacity: 0 } : undefined}
          title={brainKeyTitle()}
          onClick={() => toggle(true)}
          // files dragged onto the button open the chat with them
          onDragEnter={(e) => e.dataTransfer?.types.includes('Files') && toggle(true)}
        >
          <Icon name="sparkles" size={17} className="text-dim" />
          {brainBusy ? (
            <span className="brain-working flex items-center gap-2 text-dim" role="status">
              <Dot tone="busy" />
              Brain is working…
            </span>
          ) : (
            <span>Ask the Brain…</span>
          )}
          <kbd className="max-md:hidden font-sans text-[11.5px] font-medium leading-[normal] text-faint border border-line rounded-[6px] px-1.5 py-0.5 ml-1">{brainKeyLabel(station)}</kbd>
        </button>,
        bar,
      )}
      <div
        className={`dock fixed z-46 left-1/2 bottom-4 -translate-x-1/2 w-[min(680px,calc(100vw-32px))] h-[min(70vh,640px)] flex flex-col overflow-hidden rounded-[16px] ${D.shown ? '' : ' hidden'}`}
        ref={(el) => void (D.panel = el)}
      >
        <div className="flex items-center gap-1.5 px-5 pt-4 pb-2 max-sm:px-4">
          <b className="flex items-center gap-2.5 text-[14px] whitespace-nowrap">
            <Icon name="brain" size={17} className="text-dim" />
            Brain chat
          </b>
          <span className="flex-1 min-w-0" />
          <IconButton variant="plain" onClick={() => void newConversation()} title="New chat (this one is kept under Chats)" aria-label="New chat">
            <Icon name="square-pen" size={16} />
          </IconButton>
          <IconButton variant="plain" onClick={() => openMemory(BRAIN)} title="The Brain's MEMORY.md: what it remembers across conversations" aria-label="The Brain's MEMORY.md">
            <Icon name="file-text" size={16} />
          </IconButton>
          <IconButton variant="inset" onClick={() => toggle(false)} aria-label="Close">
            <Icon name="x" size={15} />
          </IconButton>
        </div>
        <div className="px-5 max-sm:px-4">
          <TasksAndChats tasks={{ filters: true }} chats={{ load: () => rpc.brain.threads(), onOpen: (c) => void openConversation(c.id), onRemove: removeConversation }} />
        </div>
        <DockList settings={data?.settings} />
        <div className="cmd-chips compact pt-2 px-5 pb-0 max-sm:pt-1 max-sm:px-0 hidden" ref={chips} />
        {/* your /queue messages, in the order they will go (click one to change it, drag to reorder, × takes one back) */}
        <div className="px-5 dock-held empty:hidden">
          <QueuedList
            items={queuedItems}
            head="Sends when everything above is done"
            compact
            editing={editing}
            onEditing={setEditing}
            onSave={(q, text) => void (held.edit(q.id, text) || keepEdit(text))}
            onRemove={(q) => held.remove(q.id)}
            onOrder={(ids) => held.order(ids)}
            onLeave={() => input.current?.focus()}
            onLost={(_q, text) => keepEdit(text)}
            hint={(q) => {
              const t = targetOf.get(q.id);
              return t && t !== 'auto' ? `to ${targetName(t)}` : null;
            }}
          />
        </div>
        <div className="px-5 [&_.att-tray]:pt-3">
          <DomNode className="dom-contents" make={() => D.tray!.el} deps={[]} />
          <DomNode className="dom-contents" make={() => D.pastes!.el} deps={[]} />
        </div>
        <div className="px-5 pt-1 pb-4 max-sm:px-4">
          {/* one glass field: the text on top, and under it who it goes to, which model answers, the paperclip and Send */}
          <div className="dock-composer relative">
            <textarea className="dock-input block field-sizing-content min-h-[56px] max-h-[max(160px,20vh)] w-full resize-none" ref={input} rows={2} aria-label="Message the Brain" placeholder={placeholder} />
            <span className="dom-contents" ref={slashHost} />
            <div className="flex items-center gap-1 px-2 pt-1 pb-2">
              {/* who it goes to and which model answers (these wrap on a narrow screen; the buttons stay on the right) */}
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1">
                <span className="pl-1.5 text-[12.5px] text-faint">To</span>
                <TargetMenu agents={agents} teams={teams} />
                <DomNode
                  className="dock-model inline-flex min-w-0 items-center [&_.model-chip]:rounded-ctl [&_.model-chip]:border-transparent [&_.model-chip]:bg-transparent [&_.model-chip]:h-7 [&_.model-chip]:px-2 [&_.model-chip]:py-0 [&_.model-chip]:text-[12.5px] [&_.model-chip]:text-dim [&_.model-chip]:hover:bg-panel-2 [&_.model-chip]:hover:text-ink"
                  make={() => modelNode(D.target, agents)}
                  deps={[D.target, data, D.workflows]}
                />
              </div>
              <div className="flex flex-none items-center gap-1">
                <DomNode as="span" className="dom-contents" make={() => D.tray!.picker} deps={[]} />
                {/* (Stop in Send's place while something works and the box is empty) */}
                {stopInstead ? (
                  <Button variant="danger" className="size-8! px-0!" onClick={() => void brainStop()} title="Stop the Brain and the work it handed on" aria-label="Stop">
                    <Icon name="square" size={14} />
                  </Button>
                ) : (
                  <Button className="size-8! px-0!" onClick={() => void send()} title={idle ? 'Send (Enter)' : 'Send now: the Brain stops the answer it is writing and takes this up (Enter)'} aria-label="Send">
                    <Icon name="arrow-up" size={16} />
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

// ---------- sending ----------
// One Brain ask at a time, each tied to the project and conversation it was typed in (see brainqueue.ts).
// The Brain's answer streams in (an oRPC call read with the Vercel AI SDK's stream reader; server/uistream.ts
// streamBrain): onUpdate sees the message so far, and the whole answer comes at the end (data-answer).
interface BrainAsk {
  attachments: string[];
  onUpdate: (m: UIMessage) => void;
  /** your /goal: the Brain hands it on and follows up until it is met */
  goal?: boolean;
  /** stop reading its answer (you sent a new message meanwhile) */
  signal?: AbortSignal;
}
async function streamBrainAnswer(text: string, project: string | null, { attachments, onUpdate, goal, signal }: BrainAsk): Promise<BrainAnswer> {
  const [{ readUIMessageStream }, { brainStream }] = await Promise.all([import('ai'), import('./chat/transport.ts')]);
  const stream = await brainStream({ text, project, attachments, ...(goal ? { goal: true } : {}) }, { signal });
  let answer: BrainAnswer | null = null;
  const errors: string[] = [];
  for await (const m of readUIMessageStream({ stream, onError: (e) => errors.push((e as Error).message || String(e)) })) {
    onUpdate(m);
    const d = m.parts.find((p) => p.type === 'data-answer') as { data?: BrainAnswer } | undefined;
    if (d?.data) answer = d.data;
  }
  if (!answer) throw new Error(errors[0] || "The Brain didn't answer.");
  return answer;
}
/** What a Brain message shows while it streams: the text and tools since it last started over. */
export function brainProgress(m: UIMessage): { answer: string; steps: BrainStep[] } {
  const parts = m.parts.slice(m.parts.findLastIndex((p) => p.type === 'data-restart') + 1);
  const answer = parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
  const steps = parts.flatMap((p): BrainStep[] => {
    if (p.type !== 'dynamic-tool') return [];
    const out = p.state === 'output-available' ? p.output : null;
    return [{ id: p.toolCallId, name: p.toolName, input: p.input, state: p.state === 'output-error' ? 'error' : p.state === 'output-available' ? 'done' : 'running', output: p.state === 'output-error' ? p.errorText : out && typeof out === 'object' && 'text' in out ? String((out as { text: unknown }).text) : '' }];
  });
  return { answer, steps };
}
const brainAsks = brainQueue<BrainAnswer, BrainAsk>((text, project, extra) => streamBrainAnswer(text, project, extra ?? { attachments: [], onUpdate: () => {} }));
const openProject = () => state.data?.project?.id || null;

let sending = false;
const emptyBox = () => {
  D.input!.value = '';
  D.pastes!.sync();
  draw();
};
function keepEdit(text: string) {
  keepLostEdit(text, D.input, (t) => {
    D.pastes!.restore(t);
    draw();
  });
}

// given: files uploaded elsewhere (a new project), sent along with what's in the tray
async function send(given: string[] = []) {
  const input = D.input!;
  const tray = D.tray!;
  // /stop, /resume, /resend, /goal: done now (files in the tray stay for your next message)
  // (with pasted text put back: a long goal pasted in goes in full)
  const quick = parseCommand(D.pastes!.text(), 'brain');
  if (quick && ['stop', 'resume', 'resend', 'goal'].includes(quick.name)) {
    emptyBox();
    return command(quick.name, quick.rest);
  }
  if ((!input.value.trim() && !tray.count() && !given.length) || sending) return;
  sending = true;
  let attachments: string[] | null;
  let uploading: NoteItem | null = null;
  try {
    if (tray.busy()) uploading = add({ kind: 'note', text: 'Uploading files…', busy: true });
    attachments = await tray.ready();
  } finally {
    sending = false;
    if (uploading) {
      remove(uploading);
      draw();
    }
  }
  if (!attachments) return;
  attachments = [...given, ...attachments];
  // what is in the box now (more may have been typed while the files uploaded)
  const typed = D.pastes!.text().trim();
  // "/loop [15m] [5x] …" (with the files), or /loop off
  const cmd = parseCommand(typed, 'brain');
  if (cmd?.name === 'loop') {
    if (/^(off|stop|end|cancel)$/i.test(cmd.rest)) {
      emptyBox();
      return void (loop.stop() ? add({ kind: 'note', text: 'Loop stopped.' }) : toast('No loop is going here.'));
    }
    const spec = parseLoop(cmd.rest);
    if ('error' in spec) return toast(spec.error);
    if (D.target === 'auto' && !(D.project || openProject())) return toast('The project is still loading. Try again in a moment.');
    emptyBox();
    tray.take();
    return loop.start(spec, { attachments, target: D.target });
  }
  // "/learn …": the Brain (or the agent or team it's addressed to) turns it, and the files, into a skill
  if (cmd?.name === 'learn') {
    if (D.target === 'auto' && !(D.project || openProject())) return toast('The project is still loading. Try again in a moment.');
    emptyBox();
    tray.take();
    return void held.add(learnText(cmd.rest, D.target === 'auto' ? 'brain' : 'agent'), { attachments, target: D.target });
  }
  if (cmd && cmd.name !== 'queue') {
    emptyBox();
    return command(cmd.name, cmd.rest);
  }
  // "/queue …": waits until everything in this chat is done (goes now if nothing is working)
  const queued = queuedText(typed);
  const text = queued ?? typed;
  if (!text && !attachments.length) return void (typed && toast('Write the message after /queue'));
  // who it goes to: as chosen now (not whoever is picked while the Brain's answer is being stopped)
  const target = D.target;
  // a Brain message belongs to a project: wait until the page knows which one is open
  if (target === 'auto' && !(D.project || openProject())) return toast('The project is still loading. Send it again in a moment.');
  emptyBox();
  tray.take();
  if (queued != null) return void held.add(text, { attachments, target });
  // to the Brain while it writes an answer: that answer stops, and this one is answered now
  if (target === 'auto') await steerBrain();
  return track(() => dispatch(text, attachments, target));
}

// The answers the Brain is writing now, to cut off when you send a new message meanwhile.
const answering = new Map<BrainItem, AbortController>();
/** A new message to the Brain while it answers: that answer is dropped (it changes nothing, like /stop) and
 *  the question it was answering stays in the Brain's history, so the new answer knows it. Your waiting
 *  messages, the loop, and the agents and teams it handed work to carry on. (One too far along to stop
 *  still comes, by itself: brain-late.) */
async function steerBrain() {
  const live = D.items.filter((x): x is BrainItem => x.kind === 'brain' && !!x.live);
  if (!live.length) return;
  // (what is still on its way is no longer wanted)
  brainAsks.reset();
  for (const x of live) {
    answering.get(x)?.abort();
    answering.delete(x);
    remove(x);
  }
  add({ kind: 'note', text: "Stopped the Brain's answer to take your new message." });
  await attempt(() => rpc.brain.steer());
}

// ---------- /queue ----------
// Waiting messages, sent one at a time once nothing in the chat is working: no Brain answer on its
// way, no agent or team still on work from here, no message being sent.
interface HeldExtra {
  attachments: string[];
  target: string;
  goal?: boolean;
}
let pending = 0;
async function track(work: () => Promise<unknown>): Promise<void> {
  pending++;
  try {
    await work();
  } finally {
    pending--;
    draw();
  }
}
const working = (it: DockItem) => (it.kind === 'brain' && !!it.live) || (it.kind === 'agent' && !it.done) || (it.kind === 'branch' && !!(it.working.length || it.next?.length));
const dockIdle = () => !pending && !D.items.some(working);
const held = holdQueue<HeldExtra>({ idle: dockIdle, send: (m) => track(() => dispatch(m.text, m.extra.attachments, m.extra.target, { goal: m.extra.goal })), onChange: draw });
// /loop: kept in the page; a due one waits for /queue messages and for the chat to be idle
const loop = chatLoop<HeldExtra>({
  idle: () => dockIdle() && !held.items().length,
  send: (text, x) => track(() => dispatch(text, x.attachments, x.target)),
  onChange: draw,
  onEnd: (l) => add({ kind: 'note', text: `Loop done: sent ${l.times} time${l.times > 1 ? 's' : ''}.` }),
});

// ---------- /stop, /resume, /resend, /goal ----------
async function command(name: string, rest: string) {
  if (name === 'stop') return brainStop();
  if (name === 'resume') return brainResume();
  if (name === 'resend') {
    const last = D.items.findLast((x): x is UserItem => x.kind === 'user' && !!x.sent)?.sent;
    if (!last) return toast('Nothing to send again yet.');
    return void held.add(last.text, { attachments: last.attachments, target: last.target, goal: last.goal });
  }
  if (name === 'goal') {
    if (!rest) return toast('Type /goal and what done looks like. The Brain hands it on and follows up until it is met.');
    if (D.target === 'auto' && !(D.project || openProject())) return toast('The project is still loading. Try again in a moment.');
    // (waits like a /queue message if something is working)
    return void held.add(rest, { attachments: [], target: D.target, goal: true });
  }
}

// /stop: the answer the Brain is writing (it changes nothing), your waiting messages (back to the box),
// the loop, and the agents and teams working from here.
async function brainStop() {
  const live = D.items.filter((x): x is BrainItem => x.kind === 'brain' && !!x.live);
  D.stoppedAsk = live.find((x) => x.ask)?.ask || null;
  brainAsks.reset();
  for (const x of live) remove(x);
  const back = held.clear();
  if (back.length) D.pastes!.restore(back.map((m) => m.text).filter(Boolean).join('\n\n'));
  const looped = loop.stop();
  const chats = D.items.filter((x): x is AgentItem => x.kind === 'agent' && !x.done).map((x) => ({ agentId: x.agentId, chatId: x.chatId }));
  const teams = [...new Set(D.items.filter((x): x is BranchItem => x.kind === 'branch' && !!(x.working.length || x.next?.length)).map((x) => x.wfId))];
  D.stoppedWork = { chats, teams };
  const r = await attempt(() => rpc.brain.stop({ chats, teams }));
  const what = [live.length ? 'the Brain' : '', ...(r?.stopped || []), looped ? 'the loop' : ''].filter(Boolean);
  add({ kind: 'note', text: what.length ? `Stopped ${what.join(', ')}. /resume picks it up again.` : 'Nothing was working.' });
}

// /resume: the answer /stop cut off is asked again; the agents and teams it stopped carry on.
async function brainResume() {
  const ask = D.stoppedAsk;
  D.stoppedAsk = null;
  if (ask) void track(() => dispatch(ask.text, ask.attachments, ask.target, { goal: ask.goal }));
  const r = await rpc.brain.resume(D.stoppedWork || {}).catch((e: Error) => e);
  if (r instanceof Error) return void (ask || toast(r.message || 'Nothing to resume.'));
  D.stoppedWork = null;
  // (they work again: the chat waits for them before a /queue message or the loop's next one)
  // (the newest card of each chat follows it: an older one shows a turn already done)
  const cards = new Map<string, AgentItem>();
  for (const x of D.items) if (x.kind === 'agent') cards.set(x.chatId, x);
  for (const x of cards.values()) if (r.chats.includes(x.chatId)) again(x);
  add({ kind: 'note', text: `Resumed: ${r.resumed.join(', ')}.` });
}

function targetName(t: string): string {
  if (t.startsWith('a:')) return agentOf(t.slice(2))?.name || 'an agent';
  if (t.startsWith('b:')) return D.workflows.find((w) => w.id === t.slice(2))?.name || 'a team';
  return t === 'new-agent' ? 'a new agent' : t === 'new-branch' ? 'a new team' : 'the Brain';
}

// Sends one message: to the chosen agent or team, or to the Brain (which may hand it on).
// goal: your /goal: an agent or team gets it as its goal; the Brain hands it on and follows up.
async function dispatch(text: string, attachments: string[], t: string, { goal = false }: { goal?: boolean } = {}) {
  const sent: Sent = { text, attachments, target: t, ...(goal ? { goal } : {}) };
  add({ kind: 'user', text: goal ? `Goal: ${text}` : text, attachments, sent });
  if (t.startsWith('a:')) return toAgent(t.slice(2), text, goal ? 'goal' : '', attachments, goal);
  if (t.startsWith('b:')) return toBranch(t.slice(2), text, goal ? 'goal' : '', attachments, goal);
  if (t === 'new-agent' && !goal) return newAgent(text, attachments);
  if (t === 'new-branch' && !goal) return newBranch(text, attachments);
  // The Brain: answers, changes the roster, or hands the work on
  // its answer streams into this message as it is written
  const live = add({ kind: 'brain', answer: '', done: [], live: true, steps: [], ask: sent }) as BrainItem;
  const cutOff = new AbortController();
  answering.set(live, cutOff);
  const turn = await brainAsks.ask(text, D.project || openProject(), () => D.project || openProject(), {
    goal,
    attachments,
    signal: cutOff.signal,
    onUpdate: (m) => {
      if (!D.items.includes(live)) return;
      Object.assign(live, brainProgress(m));
      draw();
    },
  });
  answering.delete(live);
  const drop = () => {
    const at = D.items.indexOf(live);
    if (at !== -1) D.items.splice(at, 1);
  };
  // a new conversation or another project since: this answer is no longer wanted here
  if (turn.kind === 'stale') return drop(), draw();
  if (turn.kind === 'error') return drop(), add({ kind: 'note', text: `The Brain couldn't answer: ${turn.error}`, error: true });
  showAnswer(live, turn.answer, goal);
}

/** The Brain's answer in its message, and the agent or team it handed the work to, followed here. */
function showAnswer(live: BrainItem, r: BrainAnswer, goal: boolean) {
  if (!D.items.includes(live)) D.items.push(live);
  Object.assign(live, { answer: r.answer, done: r.done || [], delegate: r.delegate, live: false });
  draw();
  if (r.done?.length) {
    refreshSoon(0);
    loadWorkflows();
  }
  // the server already handed it on, as the Brain: follow the agent's chat or the team's thread here
  const d = r.delegate;
  if (goal && !d) add({ kind: 'note', text: "The Brain didn't hand this goal to anyone, so there is nothing to follow up. Pick an agent or team above, or ask it to hand it on." });
  if (d) follow(d);
}

/** The agent's chat or the team's thread the Brain handed work to, followed in the chat (live, or once
 *  more in a reopened chat). */
function follow(d: BrainDelegate) {
  if (d.kind === 'agent' && d.sent?.chatId) {
    const chatId = d.sent.chatId;
    const it = add({ kind: 'agent', agentId: d.id, chatId, text: '', tools: [], images: [], reason: 'from the Brain', done: false, started: true });
    // it may have finished before this answer got here (then no 'done' comes for this card)
    void rpc.runs.list()
      .then((runs) => {
        if (!runs.some((x) => x.chatId === chatId)) (it.done = true), draw();
      })
      .catch(() => {});
  }
  if (d?.kind === 'branch' && d.sent?.ts) {
    const it = add({ kind: 'branch', wfId: d.id, name: d.name, reason: 'from the Brain', since: d.sent.ts, messages: [], working: [], briefId: d.sent.messageId });
    // the team may have answered before this answer got here: those messages came before the item did
    void rpc.teams.chat({ id: d.id })
      .then((t) => {
        if (!D.items.includes(it)) return;
        mergeTeamMessages(it, t.messages);
        it.working = t.working;
        it.next = t.queued;
        draw();
      })
      // (a team deleted since: nothing to follow)
      .catch(() => {
        const at = D.items.indexOf(it);
        if (at !== -1) D.items.splice(at, 1), draw();
      });
  }
}

// Team messages for a dock item: the ones since its brief (not yours, not the brief itself), each once, in order.
export function mergeTeamMessages(it: Pick<BranchItem, 'messages' | 'since' | 'briefId'>, messages: TeamMessage[]): void {
  const have = new Set(it.messages.map((m) => m.id));
  for (const m of messages) if (!have.has(m.id) && m.from !== 'user' && m.id !== it.briefId && m.ts >= it.since) it.messages.push(m);
  it.messages.sort((a, b) => a.ts - b.ts);
}

// goal: sent as its /goal (the Brain checks each turn and follows up)
async function toAgent(agentId: string, text: string, reason = '', attachments: string[] = [], goal = false) {
  const c = await attempt(() => rpc.agents.chats.create({ id: agentId }));
  if (!c) return;
  const it = add({ kind: 'agent', agentId, chatId: c.id, text: '', tools: [], images: [], reason, done: false });
  const r = await attempt(async () => (goal ? await rpc.agents.chats.goal({ id: agentId, chatId: c.id, text }) : await rpc.agents.chats.send({ id: agentId, chatId: c.id, text, attachments })));
  if (!r) {
    it.done = true;
    it.text = '(could not start)';
  } else it.started = true;
  draw();
}

/** Its chat works again (a new turn): the card follows that turn. */
function again(it: AgentItem) {
  it.done = false;
  it.status = '';
  it.turn = (it.turn || 0) + 1;
}

// A button in an agent's Rich answer: what it sends goes to that agent's chat, followed here.
async function continueAgent(it: AgentItem, text: string) {
  if (!it.done) return toast('It is still working. Wait for it to finish.');
  const r = await attempt(() => rpc.agents.chats.send({ id: it.agentId, chatId: it.chatId, text, attachments: [] }));
  if (!r || !D.items.includes(it)) return;
  add({ kind: 'user', text });
  add({ kind: 'agent', agentId: it.agentId, chatId: it.chatId, text: '', tools: [], images: [], reason: it.reason, done: false, started: true });
}

async function toBranch(wfId: string, text: string, reason = '', attachments: string[] = [], goal = false) {
  const wf = D.workflows.find((w) => w.id === wfId);
  // (shown before it is sent, so it hears who starts working: the team starts before the reply comes)
  const it = add({ kind: 'branch', wfId, name: wf?.name || 'Team', reason, since: Date.now(), messages: [], working: [] });
  if (goal) {
    if (!(await attempt(() => rpc.teams.goal({ id: wfId, text })))) remove(it);
    return draw();
  }
  // (while the team works, it changes its course: whoever is working takes it up now)
  const msg = await attempt(() => rpc.teams.steer({ id: wfId, text, attachments }));
  if (!msg) {
    remove(it);
    return draw();
  }
  it.since = msg.ts;
  it.messages = it.messages.filter((m) => m.ts >= msg.ts);
  draw();
}

async function newAgent(text: string, attachments: string[] = []) {
  const n = add({ kind: 'note', text: 'Designing an agent for this…', busy: true });
  const gen = conversation;
  const a: Partial<AgentDraft> & Failed = await rpc.assist.agent({ text, attachments }).catch((e: Error) => ({ error: e.message }));
  // (a new conversation or another project since: the design belongs to the old one)
  if (gen !== conversation) return;
  remove(n);
  if (a.error) return add({ kind: 'note', text: `Couldn't design it: ${a.error}`, error: true });
  add({ kind: 'agent-draft', agent: a as AgentDraft, task: text, attachments });
}

async function newBranch(text: string, attachments: string[] = []) {
  const n = add({ kind: 'note', text: 'Building a team from your agents…', busy: true });
  const gen = conversation;
  const design: Partial<BranchDesign> & Failed = await rpc.assist.branch({ text, attachments }).catch((e: Error) => ({ error: e.message }));
  if (gen !== conversation) return;
  remove(n);
  if (design.error) return add({ kind: 'note', text: `Couldn't build it: ${design.error}`, error: true });
  draw();
  openBranchBuilder({
    prefill: design,
    files: attachments,
    onSaved: async (wf) => {
      await loadWorkflows();
      D.items.push({ id: 'ran' + wf.id, kind: 'note', text: `Team "${wf.name}" is ready.`, action: { label: 'Send it my message', run: () => void toBranch(wf.id, text, '', attachments) } });
      draw();
    },
  });
}

// ---------- live updates ----------
function handleEvent(ev: ServerEvent) {
  if (ev.type === 'workflows') loadWorkflows();
  if (ev.type === 'brain-chat' && ev.projectId === D.project && !ev.conversationId && typeof ev.thread === 'string') threadChanged(ev.thread);
  // the Brain reviewed finished work by itself and recorded or improved a skill, or checked on work it
  // handed out (brain-note: done, stuck, or a team needs you)
  if ((ev.type === 'brain-learned' || ev.type === 'brain-note') && ev.projectId === D.project) {
    add({ kind: 'brain', answer: String(ev.answer || ''), done: (ev.done as BrainDone[]) || [] });
    return;
  }
  // an answer your new message cut off, but too far along to stop: what it did shows, and the work it handed on is followed
  if (ev.type === 'brain-late' && ev.projectId === D.project && ev.answer && typeof ev.answer === 'object') {
    showAnswer(add({ kind: 'brain', answer: '', done: [], steps: [] }) as BrainItem, ev.answer as BrainAnswer, ev.goal === true);
    return;
  }
  if (ev.type === 'run') {
    // (the newest card for the chat: a button in an answer adds one for the turn it starts)
    const it = D.items.findLast((x): x is AgentItem => x.kind === 'agent' && x.chatId === ev.chatId);
    if (!it) return;
    const e = ev.event as RunEvent;
    // a new turn in its chat (a /resume, a button in its answer): follow that one
    if (e.kind === 'start' && it.done) again(it);
    else if (e.kind === 'text') {
      it.text += e.text;
      it.status = 'Writing…';
    } else if (e.kind === 'tool') {
      it.tools.push({ id: e.id, name: e.name, status: 'running' });
      it.status = `Using ${e.name}…`;
    } else if (e.kind === 'tool_result') {
      const t = it.tools.find((x) => x.id === e.id);
      if (t) Object.assign(t, { status: 'done', isError: e.isError });
      if (e.images?.length) it.images.push(...e.images);
    } else if (e.kind === 'status') it.status = e.text;
    else if (e.kind === 'done' || e.kind === 'error') {
      it.done = true;
      if (e.kind === 'error') it.text += `\n\n**Error:** ${e.text}`;
      // the saved chat has the full answer
      rpc.agents.chats.get({ id: it.agentId, chatId: it.chatId })
        .then((c) => {
          const lastUser = c.items.findLastIndex((x) => x.type === 'user');
          const answer = c.items.slice(lastUser + 1).filter((x): x is Extract<ChatItem, { type: 'assistant' }> => x.type === 'assistant').map((x) => x.text).join('\n\n');
          if (answer) it.text = answer;
          draw();
        })
        .catch(() => {});
    }
    draw();
  }
  if (ev.type === 'team') {
    const items = D.items.filter((x): x is BranchItem => x.kind === 'branch' && x.wfId === ev.teamId);
    const it = items[items.length - 1];
    if (!it) return;
    const e = ev.event as TeamEvent;
    if (e.kind === 'message') mergeTeamMessages(it, [e.message]);
    // (every message to this team shows who works on it now, so none looks busy forever)
    if (e.kind === 'state')
      for (const b of items) {
        b.working = e.working;
        b.next = e.queued;
      }
    draw();
    return;
  }
  if (ev.type === 'workflow-run' && ev.run) {
    const run = ev.run as WorkflowRun;
    const it = D.items.find((x): x is BranchItem => x.kind === 'branch' && x.runId === run.id);
    if (!it) return;
    it.steps = run.steps;
    if (run.status !== 'running') {
      it.error = run.error || null;
      rpc.workflows.runs.list({ workflowId: it.wfId })
        .then((runs) => {
          const r = runs.find((x) => x.id === it.runId);
          if (r?.output) it.output = String(r.output).slice(0, 4000);
          draw();
        })
        .catch(() => {});
    }
    draw();
  }
}
