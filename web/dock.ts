// The global chat: one window on every page. Talk to the Brain (it answers, builds teams and agents,
// writes PROJECT.md or hands the work to an agent or team), or straight to any agent or team.
import { h, mount, clear, state, GET, POST, PUT, attempt, md, onEvent, onState, navigate, refreshSoon, chipSet, toast, avatar } from './core.ts';
import { openBranchBuilder } from './builder.ts';
import { icon, logo } from './icons.ts';
import { modelChip, modelInfo, brainModelChip, brainAsAgent } from './models.ts';
import { brainQueue, chatLoop, holdQueue, latestLoad } from './brainqueue.ts';
import { queuedText } from '../shared/queue.ts';
import { parseCommand, parseLoop } from '../shared/commands.ts';
import { commandChips, slashMenu } from './chatcommands.ts';
import { flipFrom, flipTo, slideIn, reducedMotion } from './motion.ts';
import { attachTray } from './attach.ts';
import { pasteBox } from './pastes.ts';
import { openMemory, BRAIN } from './memory.ts';
import { mentionPreviews } from './filepreview.ts';
import { brainKeyLabel, brainKeyTitle, brainShortcut } from './shortcuts.ts';
import type { AttachTray, PickedFile } from './attach.ts';
import type { PasteBox } from './pastes.ts';
import type { Child } from './core.ts';
import type { AgentDraft, BranchDesign } from './builder.ts';
import type { TeamEvent } from './teamchat.tsx';
import type { ActiveRun, Agent, BrainAnswer, BrainDelegate, BrainDone, Chat, ChatItem, RunEvent, ServerEvent, TeamListing, TeamMessage } from '../shared/types.ts';
import type { UIMessage } from 'ai';

/** One line of GET /api/brain/history. */
interface BrainHistoryEntry {
  role: 'user' | 'brain';
  text: string;
  ts: number;
  attachments?: string[];
}
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
type NoteItem = { id: string; kind: 'note'; text: Child; busy?: boolean; error?: boolean };
/** started: its message went, so its turn can be streamed in (web/chat/TurnView) */
type AgentItem = { id: string; kind: 'agent'; agentId: string; chatId: string; text: string; tools: ToolChip[]; images: string[]; reason: string; done: boolean; status?: string; started?: boolean };
type BranchItem = { id: string; kind: 'branch'; wfId: string; name: string; reason: string; since: number; messages: TeamMessage[]; working: string[]; next?: string[]; runId?: string; steps?: unknown; error?: string | null; output?: string; briefId?: string };
/** A tool the Brain used while it answered (it reads the project's files). */
interface BrainStep {
  id: string;
  name: string;
  input: unknown;
  state: 'running' | 'done' | 'error';
  output: string;
}
/** live: the answer is still streaming in (answer: what it has written so far; steps: the tools it used) */
type BrainItem = { id: string; kind: 'brain'; answer?: string; done: BrainDone[]; delegate?: BrainDelegate | null; old?: boolean; live?: boolean; steps?: BrainStep[]; ask?: Sent };
type DraftItem = { id: string; kind: 'agent-draft'; agent: AgentDraft; task: string; attachments: string[] };
/** One message in the Brain chat. */
type DockItem = UserItem | NoteItem | AgentItem | BranchItem | BrainItem | DraftItem;
type NewItem = DockItem extends infer T ? (T extends DockItem ? Omit<T, 'id'> : never) : never;
/** A failed request, kept as a value (the .catch below). */
type Failed = { error?: string };

interface Dock {
  modelEl: HTMLDivElement | null;
  open: boolean;
  /** 'auto' | 'new-agent' | 'new-branch' | 'a:<agent id>' | 'b:<team id>' */
  target: string;
  items: DockItem[];
  el: null;
  list: HTMLDivElement | null;
  input: HTMLTextAreaElement | null;
  sel: HTMLSelectElement | null;
  workflows: TeamListing[];
  /** the project this chat shows */
  project: string | null;
  panel?: HTMLDivElement;
  launcher?: HTMLButtonElement;
  /** Files waiting to go with the next message. */
  tray?: AttachTray;
  /** Long pasted text, folded into a chip until it is sent. */
  pastes?: PasteBox;
  /** Your /queue messages, waiting for the chat to be done. */
  heldEl?: HTMLDivElement;
  /** Your /loop's chip. */
  chipsEl?: HTMLDivElement;
  /** What the last /stop cut off: the Brain's answer it was writing, and the agents and teams working from here. */
  stoppedAsk?: Sent | null;
  stoppedWork?: { chats: { agentId: string; chatId: string }[]; teams: string[] } | null;
}

const D: Dock = { modelEl: null, open: false, target: 'auto', items: [], el: null, list: null, input: null, sel: null, workflows: [], project: null };
const PLACEHOLDER = 'What do you want done?';

export function initDock(): void {
  const key = h('kbd');
  const onStation = () => document.body.classList.contains('station-mode');
  const drawKey = () => (key.textContent = brainKeyLabel(onStation()));
  const launcher = h('button.dock-launcher', { onclick: () => toggle(true), title: brainKeyTitle() }, icon('sparkles', 17), h('span', 'Ask the Brain…'), key);
  drawKey();
  // the Station (where Space opens it) comes and goes with the page
  new MutationObserver(drawKey).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  D.list = h('div.dock-list');
  watchList(D.list);
  D.input = h('textarea.dock-input', { rows: 2, placeholder: PLACEHOLDER });
  D.tray = attachTray({ onChange: () => (D.input!.placeholder = D.tray?.count() ? 'What should be done with these files?' : PLACEHOLDER) });
  D.pastes = pasteBox();
  D.pastes.attach(D.input);
  const slash = slashMenu(D.input, 'brain', { run: () => void send() });
  D.input.addEventListener('input', () => slash.update());
  D.input.addEventListener('keydown', (e) => {
    if (slash.key(e)) return;
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });
  D.sel = h('select.dock-target');
  D.sel.addEventListener('change', () => {
    D.target = D.sel!.value;
    drawModel();
  });
  D.modelEl = h('div.dock-model');
  D.panel = h(
    'div.dock.hidden',
    h('div.dock-head', h('b', icon('brain', 16), 'Brain chat'), h('span.grow'), h('span.dock-to', 'to'), D.sel, D.modelEl, h('button.icon-btn', { onclick: () => openMemory(BRAIN), title: "The Brain's MEMORY.md: what it remembers across conversations", 'aria-label': "The Brain's MEMORY.md" }, icon('file-text', 15)), h('button.icon-btn', { onclick: newConversation, title: 'New conversation (the Brain forgets this chat)', 'aria-label': 'New conversation' }, icon('rotate-ccw', 15)), h('button.icon-btn', { onclick: () => toggle(false), 'aria-label': 'Close' }, '✕')),
    D.list,
    (D.chipsEl = h('div.cmd-chips.compact.dock-held.hidden')),
    (D.heldEl = h('div.queued-list.compact.dock-held.hidden')),
    h('div.dock-tray-wrap', D.tray.el, D.pastes.el),
    h('div.dock-compose', D.tray.picker, h('div.dock-field', D.input, slash.el), h('button.btn', { onclick: () => send(), title: 'Send (Enter)' }, icon('send', 15))),
  );
  D.tray.dropZone(D.panel, 'Drop files or folders for the Brain');
  // files dragged onto the launcher open the chat with them
  launcher.addEventListener('dragenter', (e) => e.dataTransfer?.types.includes('Files') && toggle(true));
  D.launcher = launcher;
  document.body.append(h('div.bottom-bar', launcher), D.panel);
  D.project = state.data?.project?.id || null;
  onState(drawTargets);
  onState(projectChanged);
  // Ctrl+K (⌘K) opens or closes the chat from anywhere; Space opens it on the Station
  document.addEventListener('keydown', (e) => {
    const shortcut = brainShortcut(e, { open: D.open, onStation: onStation() });
    if (shortcut) {
      e.preventDefault();
      toggle(shortcut === 'open' ? true : !D.open);
    } else if (e.key === 'Escape' && D.open && !e.defaultPrevented && !document.querySelector('.modal-back, .model-menu')) {
      e.preventDefault();
      toggle(false);
    }
  });
  onEvent(handleEvent);
  loadWorkflows();
  loadHistory();
  draw();
}

// Ask the Brain from anywhere (e.g. right after creating a project), with files already uploaded.
export function askBrain(text: string, attachments: string[] = []): void {
  D.target = 'auto';
  toggle(true);
  drawTargets();
  D.input!.value = text;
  send(attachments);
}

// Files dropped on the Brain on the map: open the Brain chat with them attached, ready for what to do.
export function attachToBrain(picked: PickedFile[]): void {
  D.target = 'auto';
  toggle(true);
  drawTargets();
  D.tray!.add(picked);
  setTimeout(() => D.input!.focus(), 40);
}

// The last few turns with the Brain, so the chat picks up where it left off.
// (only the newest load counts: one from a project you have since left must not fill this one's chat)
const historyLoads = latestLoad();
async function loadHistory() {
  const current = historyLoads.start();
  const project = D.project;
  const msgs = await GET<BrainHistoryEntry[]>('/brain/history').catch((): BrainHistoryEntry[] => []);
  if (!current() || project !== D.project || D.items.length) return;
  for (const m of msgs.slice(-6)) D.items.push(m.role === 'user' ? { id: `h${m.ts}u`, kind: 'user', text: m.text, attachments: m.attachments } : { id: `h${m.ts}b`, kind: 'brain', answer: m.text, done: [], old: true });
  draw();
}

async function newConversation() {
  // keep the transcript if the Brain still remembers it
  if (!(await attempt(() => POST('/brain/clear')))) return;
  brainAsks.reset(); // answers still on their way belong to the old conversation
  held.clear();
  loop.stop();
  historyLoads.reset();
  D.items = [];
  dropTurns();
  draw();
}

// Another project was opened: this chat was about the old one. Drop it (and anything still waiting
// to be sent or answered there) and show the new project's Brain chat.
function projectChanged(d: { project?: { id: string } | null }) {
  const id = d.project?.id || null;
  if (!id || id === D.project) return;
  const first = D.project === null;
  D.project = id;
  if (first) return;
  brainAsks.reset();
  held.clear();
  loop.stop();
  D.items = [];
  dropTurns();
  draw();
  loadHistory();
  loadWorkflows();
}

export function openDock(target: string | null = null, text = ''): void {
  if (target) D.target = target;
  toggle(true);
  if (text) {
    D.input!.value = text;
    D.pastes!.sync();
  }
}

// Opening grows the chat out of the "Ask the Brain" button; closing folds it back into it.
let closing: Promise<void> | null = null;
function toggle(open: boolean) {
  if (open === D.open && !closing) return;
  D.open = open;
  const panel = D.panel!;
  const launcher = D.launcher!;
  if (open) {
    const from = launcher.getBoundingClientRect();
    closing = null;
    panel.getAnimations().forEach((a) => a.cancel());
    panel.classList.remove('hidden');
    launcher.classList.add('hidden');
    drawTargets();
    if (from.width && !reducedMotion()) {
      flipFrom(panel, from, { duration: 460, fade: true });
      // the inside arrives a moment later, so the shape leads
      for (const [i, part] of [...panel.children].entries()) slideIn(part, { y: 10, duration: 360 + i * 60 })?.effect?.updateTiming({ delay: 120 + i * 40, fill: 'backwards' });
    }
    setTimeout(() => D.input!.focus(), 30);
    return;
  }
  // closing: show the button again (invisible) so we know where to fold into
  launcher.classList.remove('hidden');
  const to = launcher.getBoundingClientRect();
  launcher.style.opacity = '0';
  const done = (closing = flipTo(panel, to, { duration: 300 }).then(() => {
    if (closing !== done) return;
    closing = null;
    panel.classList.add('hidden');
    launcher.style.opacity = '';
    slideIn(launcher, { scale: 0.92, duration: 260 });
  }));
}

async function loadWorkflows() {
  D.workflows = await GET<TeamListing[]>('/workflows').catch(() => D.workflows);
  drawTargets();
}

function drawTargets() {
  const agents = state.data?.agents || [];
  const opts: HTMLElement[] = [h('option', { value: 'auto' }, '🧠 The Brain: answers, builds, hands off'), h('option', { value: 'new-agent' }, '+ New agent from this'), h('option', { value: 'new-branch' }, '+ New team from this')];
  if (agents.length) opts.push(h('optgroup', { label: 'Agents' }, agents.map((a) => h('option', { value: `a:${a.id}` }, `${a.emoji || ''} ${a.name}`))));
  const wfs = D.workflows.filter((w) => w.members?.length || w.steps?.length);
  if (wfs.length) opts.push(h('optgroup', { label: 'Teams' }, wfs.map((w) => h('option', { value: `b:${w.id}` }, `⇢ ${w.name}`))));
  const sel = D.sel!;
  mount(sel, opts);
  if (![...sel.options].some((o) => o.value === D.target)) D.target = 'auto';
  sel.value = D.target;
  drawModel();
}

// The model that will answer: the agent's (switchable), the Brain's own for Auto / New, or the team's lead.
function drawModel() {
  if (!D.modelEl) return;
  const t = D.target;
  const agents = state.data?.agents || [];
  if (t.startsWith('a:')) {
    const a = agents.find((x) => x.id === t.slice(2));
    return mount(D.modelEl, a ? modelChip(a, { compact: true }) : null);
  }
  if (t.startsWith('b:')) {
    const wf = D.workflows.find((w) => w.id === t.slice(2));
    const lead = wf?.lead ? agents.find((x) => x.id === wf.lead) : null;
    return mount(D.modelEl, lead ? h('span.dock-model-note', { title: 'The team lead answers first' }, '★ ', modelChip(lead, { compact: true })) : h('span.dock-model-note.hint', 'each agent its own model'));
  }
  // The Brain itself (and New agent / New team): the Brain's own model
  mount(D.modelEl, brainModelChip());
}

// ---------- messages ----------
function add<K extends DockItem['kind']>(item: NewItem & { kind: K }): Extract<DockItem, { kind: K }> {
  D.items.push({ id: Math.random().toString(36).slice(2), ...item } as DockItem);
  draw();
  return D.items[D.items.length - 1] as Extract<DockItem, { kind: K }>;
}

let frame = false;
// Items are drawn once and kept while they stay the same, and the list is put in order in place: a
// redraw (each piece of a streaming answer) must not rebuild every message, or each one replays its
// entrance and the chat flickers. An item that changed is drawn again, without the entrance.
const drawn = new Map<string, { sig: string; el: HTMLElement }>();
// (what an item is drawn from: a handed-off agent whose turn streams in its own view is drawn from
// its status only, not from the words that pile up in its fields)
const itemSig = (it: DockItem): string =>
  it.kind === 'agent' && it.started ? JSON.stringify([it.agentId, it.chatId, it.reason, it.done, it.status]) : JSON.stringify(it, (_k, v) => (v instanceof Node ? v.textContent : v));
let emptyEl: HTMLElement | null = null;
// stays at the newest message while you are there (by where you scrolled), following what grows
let stick = true;
const follow = () => {
  if (stick && D.list) D.list.scrollTop = D.list.scrollHeight;
};
function watchList(list: HTMLElement): void {
  list.addEventListener('scroll', () => (stick = list.scrollHeight - list.scrollTop - list.clientHeight < 80));
  new MutationObserver(follow).observe(list, { childList: true, subtree: true, characterData: true });
  list.addEventListener('load', follow, true);
  list.addEventListener('loadedmetadata', follow, true);
}

function draw() {
  if (frame) return;
  frame = true;
  requestAnimationFrame(() => {
    frame = false;
    const list = D.list!;
    for (const id of [...drawn.keys()]) if (!D.items.some((it) => it.id === id)) drawn.delete(id);
    let nodes: HTMLElement[];
    if (!D.items.length) {
      emptyEl ||= h('div.dock-empty', icon('sparkles', 26), h('p', 'Ask the Brain anything about the project, or for anything to be done.'), h('p.hint', 'It sees every agent and team and what they are doing. It answers questions itself, builds teams from the library ("make me a social media team"), and hands work to the right agent or team.'));
      nodes = [emptyEl];
    } else {
      nodes = D.items.flatMap((it) => {
        const sig = itemSig(it);
        const hit = drawn.get(it.id);
        if (hit && hit.sig === sig) return [hit.el];
        const el = renderItem(it);
        if (!el) return [];
        // (shown before: no entrance again)
        if (hit) [el, ...el.querySelectorAll('.dock-msg, .dock-note')].forEach((x) => x.classList.add('kept'));
        drawn.set(it.id, { sig, el });
        return [el];
      });
    }
    nodes.forEach((n, i) => {
      if (list.childNodes[i] !== n) list.insertBefore(n, list.childNodes[i] ?? null);
    });
    while (list.childNodes.length > nodes.length) list.lastChild!.remove();
    follow();
    // something may have finished: a /queue message can go now, then the loop's next one
    held.check();
    loop.check();
    if (!D.tray?.count()) D.input!.placeholder = dockIdle() ? PLACEHOLDER : 'Working… /queue a message to send when this is done';
  });
}

// A handed-off agent's turn, streamed in as it goes (web/chat/TurnView), kept across redraws.
const turns = new Map<string, { el: HTMLElement; destroy?: () => void }>();
function turnFor(it: AgentItem): HTMLElement {
  let t = turns.get(it.id);
  if (!t) {
    const el = h('div.dock-turn');
    const entry: { el: HTMLElement; destroy?: () => void } = { el };
    t = entry;
    turns.set(it.id, entry);
    void import('./chat/mount.tsx').then(({ mountTurn }) => {
      if (turns.get(it.id) === entry) entry.destroy = mountTurn(el, { agentId: it.agentId, chatId: it.chatId, live: true }).destroy;
    });
  }
  return t.el;
}
function dropTurns(): void {
  for (const t of turns.values()) t.destroy?.();
  turns.clear();
}

// A tool call the Brain made, as the chats show them (open it for its input and result).
function stepCard(st: BrainStep): HTMLElement {
  const input = typeof st.input === 'string' ? st.input : JSON.stringify(st.input ?? {}, null, 2);
  const brief = st.input && typeof st.input === 'object' ? Object.values(st.input as Record<string, unknown>).filter((v) => typeof v === 'string').join(' · ').slice(0, 120) : '';
  return h(
    `details.tool.small${st.state === 'error' ? '.error' : ''}`,
    h('summary', st.state === 'running' ? h('span.dot.busy') : st.state === 'error' ? h('span.red', '✕') : h('span.accent', '✓'), h('span.tname', st.name), h('span.targ', brief)),
    h('div.tbody', h('div.label', 'Input'), h('pre', input), st.state === 'running' ? h('div.hint', 'Running…') : [h('div.label', st.state === 'error' ? 'Error' : 'Result'), h('pre', st.output || '(empty)')]),
  );
}

function renderItem(it: DockItem): HTMLElement | null {
  if (it.kind === 'user') return h('div.col', { style: { gap: '6px' } }, h('div.dock-msg.user', it.text || null), mentionPreviews(it.text, it.attachments, { compact: true, key: `dock:${it.id}` }));
  if (it.kind === 'note') return h('div.dock-note', { class: it.error ? 'err' : '' }, it.busy ? h('span.dot.busy') : null, it.text);
  if (it.kind === 'agent') {
    const a = state.data?.agents.find((x) => x.id === it.agentId);
    const who = h('div.dock-who', a ? avatar(a) : null, h('b', a?.name || 'Agent'), a ? h('span.dock-answer-model', modelInfo(a).short) : null, it.reason ? h('span.hint', it.reason) : null, h('span.grow'), h('button.btn.tiny.ghost', { onclick: () => navigate(`#/agents/${it.agentId}/${it.chatId}`) }, 'Open chat'));
    const working = !it.done ? h('div.dock-note', h('span.dot.busy'), it.status || 'Working…') : null;
    // its turn, streamed in: text as written, tool calls you can open (and file previews)
    if (it.started) return h('div.dock-msg.agent', who, turnFor(it), working);
    const body = it.text ? md(it.text) : h('div.hint', it.done ? '(no answer)' : 'Working…');
    body.classList?.add('dock-answer');
    return h('div.dock-msg.agent', who, body, working);
  }
  if (it.kind === 'branch') {
    const agentOf = (id: string) => state.data?.agents.find((a) => a.id === id);
    const nameOf = (id: string) => (id === 'brain' ? 'Brain' : agentOf(id)?.name);
    return h(
      'div.dock-msg.agent',
      h('div.dock-who', h('div.avatar', icon('users', 14)), h('b', it.name), it.reason ? h('span.hint', it.reason) : null, h('span.grow'), h('button.btn.tiny.ghost', { onclick: () => navigate('#/station') }, 'Open team')),
      (it.messages || []).map((m) => {
        const a = agentOf(m.from);
        const body = md(String(m.text).slice(0, 3000));
        body.classList.add('dock-answer');
        // (the Brain follows up in the thread too)
        const brain = m.from === 'brain';
        return h('div.dock-team-msg', h('div.dock-who', a ? avatar(a) : brain ? h('div.avatar.brain-av', icon('brain', 14)) : null, h('b', a?.name || (brain ? 'Brain' : 'Team')), m.mentions?.length ? h('span.hint', `→ ${m.mentions.map((id) => agentOf(id)?.name).filter(Boolean).join(', ')}`) : null), body, mentionPreviews(m.text, m.attachments, { compact: true, key: `dock:${m.id}` }));
      }),
      it.working?.length ? h('div.dock-note', h('span.dot.busy'), `${it.working.map((id) => nameOf(id) || 'Agent').join(', ')} working…`) : !it.messages?.length ? h('div.dock-note', h('span.dot.busy'), 'Sent to the team…') : null,
    );
  }
  if (it.kind === 'brain') {
    const b = state.data?.settings?.brain || { model: 'haiku' };
    // (still streaming: what it has written so far; nothing yet: it is looking at the project)
    const body = it.live && !it.answer ? h('div.dock-note', h('span.dot.busy'), 'The Brain is looking at the project…') : md(it.answer || (it.done?.length ? '' : '(no answer)'));
    body.classList?.add('dock-answer');
    if (it.live && it.answer) body.classList.add('cursor');
    const ico = { team: 'users', hired: 'user-plus', file: 'file-text', routine: 'repeat', skill: 'puzzle', model: 'cpu', mcp: 'plug', stop: 'square', memory: 'file-text', error: 'triangle-alert', note: 'check' };
    return h(
      'div.dock-msg.agent.brain',
      h('div.dock-who', h('div.avatar.brain-av', icon('brain', 14)), h('b', 'Brain'), h('span.dock-answer-model', modelInfo(brainAsAgent(b)).short)),
      it.steps?.length ? h('div.dock-steps', it.steps.map(stepCard)) : null,
      body,
      it.answer && !it.live ? mentionPreviews(it.answer, [], { compact: true, key: `dock:${it.id}` }) : null,
      it.done?.length
        ? h('div.brain-done', it.done.map((d) => h(`div.brain-act${d.kind === 'error' ? '.err' : ''}`, icon(ico[d.kind] || 'check', 13), h('span', d.text), d.teamId ? h('button.btn.tiny.ghost', { onclick: () => navigate(`#/station?team=${d.teamId}`) }, 'Show') : d.routineId ? h('button.btn.tiny.ghost', { onclick: () => navigate(`#/routines/${d.routineId}`) }, 'Open') : d.skillId ? h('button.btn.tiny.ghost', { onclick: () => navigate(`#/skills/${d.skillId}`) }, 'Open') : d.kind === 'mcp' ? h('button.btn.tiny.ghost', { onclick: () => navigate('#/settings?tab=mcp') }, 'Open') : d.memory ? h('button.btn.tiny.ghost', { onclick: () => openMemory(d.memory!, d.memory === BRAIN ? 'The Brain' : state.data?.agents.find((a) => a.id === d.memory)?.name) }, 'Open') : null)))
        : null,
      it.delegate ? h('div.brain-act.handoff', icon('send', 13), h('span', 'Handed to ', h('b', it.delegate.name))) : null,
    );
  }
  if (it.kind === 'agent-draft') return draftCard(it);
  return null;
}

// A new agent the Brain designed: check it, then create it.
function draftCard(it: DraftItem) {
  const a = it.agent;
  // the card turns into a plain note once it is done
  const becomeNote = (text: string) => {
    const n = it as unknown as NoteItem;
    n.kind = 'note';
    n.text = text;
  };
  const name = h('input', { value: a.name });
  const spec = h('input', { value: a.specialty });
  name.addEventListener('input', () => (a.name = name.value));
  spec.addEventListener('input', () => (a.specialty = spec.value));
  const create = async (thenRun: boolean) => {
    const created = await attempt(() => POST<Agent>('/agents', a));
    if (!created) return;
    becomeNote(`Created ${created.emoji || ''} ${created.name}.`);
    refreshSoon(0);
    draw();
    if (thenRun) toAgent(created.id, it.task, 'new agent', it.attachments);
  };
  return h(
    'div.dock-msg.agent.draft',
    h('div.dock-who', h('div.avatar', a.emoji), h('b', 'New agent'), h('span.hint', 'designed from your message')),
    h('div.col', { style: { gap: '6px' } }, name, spec),
    h('div.mt', chipSet((state.data?.toolGroups || []).map((g) => ({ value: g.id, label: g.label, title: g.description })), a.toolGroups, (v) => (a.toolGroups = v))),
    h('details.mt', h('summary.hint', { style: { cursor: 'pointer' } }, 'Instructions'), h('pre', a.systemPrompt)),
    h('div.row.mt', h('button.btn.small', { onclick: () => create(true) }, 'Create & do it'), h('button.btn.ghost.small', { onclick: () => create(false) }, 'Create only'), h('button.btn.ghost.small', { onclick: () => (becomeNote('Skipped.'), draw()) }, 'Cancel')),
  );
}

// ---------- sending ----------
// One Brain ask at a time, each tied to the project and conversation it was typed in (see brainqueue.ts).
// The Brain's answer streams in (Vercel AI SDK: its transport and stream reader; server/uistream.ts
// streamBrain): onUpdate sees the message so far, and the whole answer comes at the end (data-answer).
interface BrainAsk {
  attachments: string[];
  onUpdate: (m: UIMessage) => void;
  /** your /goal: the Brain hands it on and follows up until it is met */
  goal?: boolean;
}
async function streamBrainAnswer(text: string, project: string | null, { attachments, onUpdate, goal }: BrainAsk): Promise<BrainAnswer> {
  const [{ readUIMessageStream }, { brainTransport }] = await Promise.all([import('ai'), import('./chat/transport.ts')]);
  const stream = await brainTransport({ text, project, attachments, ...(goal ? { goal: true } : {}) }).sendMessages({ chatId: 'brain', messages: [], trigger: 'submit-message', messageId: undefined, abortSignal: undefined });
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

// given: files uploaded elsewhere (a new project), sent along with what's in the tray
async function send(given: string[] = []) {
  const input = D.input!;
  const tray = D.tray!;
  // /stop, /resume, /resend, /goal: done now (files in the tray stay for your next message)
  // (with pasted text put back: a long goal pasted in goes in full)
  const now = parseCommand(D.pastes!.text(), 'brain');
  if (now && ['stop', 'resume', 'resend', 'goal'].includes(now.name)) {
    input.value = '';
    D.pastes!.sync();
    return command(now.name, now.rest);
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
      D.items.splice(D.items.indexOf(uploading), 1);
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
      input.value = '';
      D.pastes!.sync();
      return void (loop.stop() ? add({ kind: 'note', text: 'Loop stopped.' }) : toast('No loop is going here.'));
    }
    const spec = parseLoop(cmd.rest);
    if ('error' in spec) return toast(spec.error);
    if (D.target === 'auto' && !(D.project || openProject())) return toast('The project is still loading. Try again in a moment.');
    input.value = '';
    D.pastes!.sync();
    tray.take();
    return loop.start(spec, { attachments, target: D.target });
  }
  if (cmd && cmd.name !== 'queue') {
    input.value = '';
    D.pastes!.sync();
    return command(cmd.name, cmd.rest);
  }
  // "/queue …": waits until everything in this chat is done (goes now if nothing is working)
  const queued = queuedText(typed);
  const text = queued ?? typed;
  if (!text && !attachments.length) return void (typed && toast('Write the message after /queue'));
  // a Brain message belongs to a project: wait until the page knows which one is open
  if (D.target === 'auto' && !(D.project || openProject())) return toast('The project is still loading. Send it again in a moment.');
  input.value = '';
  D.pastes!.sync();
  tray.take();
  if (queued != null) return void held.add(text, { attachments, target: D.target });
  return track(() => dispatch(text, attachments, D.target));
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
const held = holdQueue<HeldExtra>({ idle: dockIdle, send: (m) => track(() => dispatch(m.text, m.extra.attachments, m.extra.target, { goal: m.extra.goal })), onChange: () => drawHeld() });
// /loop: kept in the page; a due one waits for /queue messages and for the chat to be idle
const loop = chatLoop<HeldExtra>({
  idle: () => dockIdle() && !held.items().length,
  send: (text, x) => track(() => dispatch(text, x.attachments, x.target)),
  onChange: () => drawChips(),
  onEnd: (l) => add({ kind: 'note', text: `Loop done: sent ${l.times} time${l.times > 1 ? 's' : ''}.` }),
});
function drawChips() {
  if (!D.chipsEl) return;
  commandChips(D.chipsEl, { loop: loop.info(), goal: null, onStopLoop: () => loop.stop() && add({ kind: 'note', text: 'Loop stopped.' }), onClearGoal: () => {} });
}

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
  for (const x of live) D.items.splice(D.items.indexOf(x), 1);
  const back = held.clear();
  if (back.length) D.pastes!.restore(back.map((m) => m.text).filter(Boolean).join('\n\n'));
  const looped = loop.stop();
  const chats = D.items.filter((x): x is AgentItem => x.kind === 'agent' && !x.done).map((x) => ({ agentId: x.agentId, chatId: x.chatId }));
  const teams = [...new Set(D.items.filter((x): x is BranchItem => x.kind === 'branch' && !!(x.working.length || x.next?.length)).map((x) => x.wfId))];
  D.stoppedWork = { chats, teams };
  const r = await attempt(() => POST<{ stopped: string[] }>('/brain/stop', { chats, teams }));
  const what = [live.length ? 'the Brain' : '', ...(r?.stopped || []), looped ? 'the loop' : ''].filter(Boolean);
  add({ kind: 'note', text: what.length ? `Stopped ${what.join(', ')}. /resume picks it up again.` : 'Nothing was working.' });
}

// /resume: the answer /stop cut off is asked again; the agents and teams it stopped carry on.
async function brainResume() {
  const ask = D.stoppedAsk;
  D.stoppedAsk = null;
  if (ask) void track(() => dispatch(ask.text, ask.attachments, ask.target, { goal: ask.goal }));
  const r = await POST<{ resumed: string[]; chats: string[] }>('/brain/resume', D.stoppedWork || {}).catch((e: Error) => e);
  if (r instanceof Error) return void (ask || toast(r.message || 'Nothing to resume.'));
  D.stoppedWork = null;
  // (they work again: the chat waits for them before a /queue message or the loop's next one)
  for (const x of D.items) if (x.kind === 'agent' && r.chats.includes(x.chatId)) x.done = false;
  add({ kind: 'note', text: `Resumed: ${r.resumed.join(', ')}.` });
}

function targetName(t: string): string {
  if (t.startsWith('a:')) return state.data?.agents.find((a) => a.id === t.slice(2))?.name || 'an agent';
  if (t.startsWith('b:')) return D.workflows.find((w) => w.id === t.slice(2))?.name || 'a team';
  return t === 'new-agent' ? 'a new agent' : t === 'new-branch' ? 'a new team' : 'the Brain';
}
function drawHeld() {
  const el = D.heldEl;
  if (!el) return;
  const items = held.items();
  el.classList.toggle('hidden', !items.length);
  mount(
    el,
    items.length ? h('div.queued-head', 'Sends when everything above is done') : null,
    items.map((m) =>
      h(
        'div.queued-msg',
        icon('clock', 12),
        h('span.queued-text', m.text || `${m.extra.attachments.length} file(s)`),
        m.extra.target === 'auto' ? null : h('span.hint', `to ${targetName(m.extra.target)}`),
        h('button.tc-act', { title: "Don't send this", 'aria-label': "Don't send this", onclick: () => held.remove(m.id) }, icon('x', 12)),
      ),
    ),
  );
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
  const turn = await brainAsks.ask(text, D.project || openProject(), () => D.project || openProject(), {
    goal,
    attachments,
    onUpdate: (m) => {
      if (!D.items.includes(live)) return;
      Object.assign(live, brainProgress(m));
      draw();
    },
  });
  const drop = () => {
    const at = D.items.indexOf(live);
    if (at !== -1) D.items.splice(at, 1);
  };
  // a new conversation or another project since: this answer is no longer wanted here
  if (turn.kind === 'stale') return drop(), draw();
  if (turn.kind === 'error') return drop(), add({ kind: 'note', text: `The Brain couldn't answer: ${turn.error}`, error: true });
  const r = turn.answer;
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
  if (d?.kind === 'agent' && d.sent?.chatId) {
    const chatId = d.sent.chatId;
    const it = add({ kind: 'agent', agentId: d.id, chatId, text: '', tools: [], images: [], reason: 'from the Brain', done: false, started: true });
    // it may have finished before this answer got here (then no 'done' comes for this card)
    void GET<ActiveRun[]>('/runs')
      .then((runs) => {
        if (!runs.some((x) => x.chatId === chatId)) (it.done = true), draw();
      })
      .catch(() => {});
  }
  if (d?.kind === 'branch' && d.sent?.ts) {
    const it = add({ kind: 'branch', wfId: d.id, name: d.name, reason: 'from the Brain', since: d.sent.ts, messages: [], working: [], briefId: d.sent.messageId });
    // the team may have answered before this answer got here: those messages came before the item did
    void GET<{ messages: TeamMessage[]; working: string[]; queued: string[] }>(`/teams/${d.id}/chat`)
      .then((t) => {
        if (!D.items.includes(it)) return;
        mergeTeamMessages(it, t.messages);
        it.working = t.working;
        it.next = t.queued;
        draw();
      })
      .catch(() => {});
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
  const c = await attempt(() => POST<Chat>(`/agents/${agentId}/chats`));
  if (!c) return;
  const it = add({ kind: 'agent', agentId, chatId: c.id, text: '', tools: [], images: [], reason, done: false });
  const r = await attempt(() => (goal ? POST(`/agents/${agentId}/chats/${c.id}/goal`, { text }) : POST(`/agents/${agentId}/chats/${c.id}/messages`, { text, attachments })));
  if (!r) {
    it.done = true;
    it.text = '(could not start)';
  } else it.started = true;
  draw();
}

async function toBranch(wfId: string, text: string, reason = '', attachments: string[] = [], goal = false) {
  const wf = D.workflows.find((w) => w.id === wfId);
  // (shown before it is sent, so it hears who starts working: the team starts before the reply comes)
  const it = add({ kind: 'branch', wfId, name: wf?.name || 'Team', reason, since: Date.now(), messages: [], working: [] });
  if (goal) {
    if (!(await attempt(() => POST(`/teams/${wfId}/goal`, { text })))) D.items.splice(D.items.indexOf(it), 1);
    return draw();
  }
  const msg = await attempt(() => POST<TeamMessage>(`/teams/${wfId}/messages`, { text, attachments }));
  if (!msg) {
    D.items.splice(D.items.indexOf(it), 1);
    return draw();
  }
  it.since = msg.ts;
  it.messages = it.messages.filter((m) => m.ts >= msg.ts);
  draw();
}

async function newAgent(text: string, attachments: string[] = []) {
  const n = add({ kind: 'note', text: 'Designing an agent for this…', busy: true });
  const a: Partial<AgentDraft> & Failed = await POST<AgentDraft>('/assist/agent', { text, attachments }).catch((e: Error) => ({ error: e.message }));
  D.items.splice(D.items.indexOf(n), 1);
  if (a.error) return add({ kind: 'note', text: `Couldn't design it: ${a.error}`, error: true });
  add({ kind: 'agent-draft', agent: a as AgentDraft, task: text, attachments });
}

async function newBranch(text: string, attachments: string[] = []) {
  const n = add({ kind: 'note', text: 'Building a team from your agents…', busy: true });
  const design: Partial<BranchDesign> & Failed = await POST<BranchDesign>('/assist/branch', { text, attachments }).catch((e: Error) => ({ error: e.message }));
  D.items.splice(D.items.indexOf(n), 1);
  if (design.error) return add({ kind: 'note', text: `Couldn't build it: ${design.error}`, error: true });
  draw();
  openBranchBuilder({
    prefill: design,
    files: attachments,
    onSaved: async (wf) => {
      await loadWorkflows();
      D.items.push({ id: 'ran' + wf.id, kind: 'note', text: h('span', `Team "${wf.name}" is ready. `, h('button.btn.tiny', { onclick: () => toBranch(wf.id, text, '', attachments) }, 'Send it my message')) });
      draw();
    },
  });
}

// ---------- live updates ----------
function handleEvent(ev: ServerEvent) {
  if (ev.type === 'workflows') loadWorkflows();
  // the Brain reviewed finished work by itself and recorded or improved a skill, or checked on work it
  // handed out (brain-note: done, stuck, or a team needs you)
  if ((ev.type === 'brain-learned' || ev.type === 'brain-note') && ev.projectId === D.project) {
    add({ kind: 'brain', answer: String(ev.answer || ''), done: (ev.done as BrainDone[]) || [] });
    return;
  }
  if (ev.type === 'run') {
    const it = D.items.find((x): x is AgentItem => x.kind === 'agent' && x.chatId === ev.chatId);
    if (!it) return;
    const e = ev.event as RunEvent;
    if (e.kind === 'text') {
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
      GET<Chat>(`/agents/${it.agentId}/chats/${it.chatId}`)
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
      GET<WorkflowRun[]>(`/workflow-runs?workflowId=${it.wfId}`)
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
