// The global chat: one window on every page. Talk to the Brain (it answers, builds teams and agents,
// writes PROJECT.md or hands the work to an agent or team), or straight to any agent or team.
import { h, mount, clear, state, GET, POST, PUT, attempt, md, onEvent, onState, navigate, refreshSoon, chipSet, toast, avatar } from './core.ts';
import { openBranchBuilder } from './builder.ts';
import { icon, logo } from './icons.ts';
import { modelChip, modelInfo, brainModelChip, brainAsAgent } from './models.ts';
import { attachTray, attachmentChips } from './attach.ts';
import type { AttachTray, PickedFile } from './attach.ts';
import type { Child } from './core.ts';
import type { AgentDraft, BranchDesign } from './builder.ts';
import type { TeamEvent } from './teamchat.ts';
import type { Agent, BrainAnswer, BrainDelegate, BrainDone, Chat, ChatItem, RunEvent, ServerEvent, TeamListing, TeamMessage } from '../shared/types.ts';

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
type UserItem = { id: string; kind: 'user'; text: string; attachments?: string[] };
type NoteItem = { id: string; kind: 'note'; text: Child; busy?: boolean; error?: boolean };
type AgentItem = { id: string; kind: 'agent'; agentId: string; chatId: string; text: string; tools: ToolChip[]; images: string[]; reason: string; done: boolean; status?: string };
type BranchItem = { id: string; kind: 'branch'; wfId: string; name: string; reason: string; since: number; messages: TeamMessage[]; working: string[]; runId?: string; steps?: unknown; error?: string | null; output?: string };
type BrainItem = { id: string; kind: 'brain'; answer?: string; done: BrainDone[]; delegate?: BrainDelegate | null; old?: boolean };
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
  panel?: HTMLDivElement;
  launcher?: HTMLButtonElement;
  /** Files waiting to go with the next message. */
  tray?: AttachTray;
}

const D: Dock = { modelEl: null, open: false, target: 'auto', items: [], el: null, list: null, input: null, sel: null, workflows: [] };
const PLACEHOLDER = 'What do you want done?';

export function initDock(): void {
  const launcher = h('button.dock-launcher', { onclick: () => toggle(true) }, icon('sparkles', 17), h('span', 'Ask the Brain…'), h('kbd', 'Ctrl K'));
  D.list = h('div.dock-list');
  D.input = h('textarea.dock-input', { rows: 2, placeholder: PLACEHOLDER });
  D.tray = attachTray({ onChange: () => (D.input!.placeholder = D.tray?.count() ? 'What should be done with these files?' : PLACEHOLDER) });
  D.input.addEventListener('keydown', (e) => {
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
    h('div.dock-head', h('b', icon('brain', 16), 'Brain chat'), h('span.grow'), h('span.dock-to', 'to'), D.sel, D.modelEl, h('button.icon-btn', { onclick: newConversation, title: 'New conversation (the Brain forgets this chat)', 'aria-label': 'New conversation' }, icon('rotate-ccw', 15)), h('button.icon-btn', { onclick: () => toggle(false), 'aria-label': 'Close' }, '✕')),
    D.list,
    h('div.dock-tray-wrap', D.tray.el),
    h('div.dock-compose', D.tray.picker, D.input, h('button.btn', { onclick: () => send(), title: 'Send (Enter)' }, icon('send', 15))),
  );
  D.tray.dropZone(D.panel, 'Drop files or folders for the Brain');
  // files dragged onto the launcher open the chat with them
  launcher.addEventListener('dragenter', (e) => e.dataTransfer?.types.includes('Files') && toggle(true));
  D.launcher = launcher;
  document.body.append(launcher, D.panel);
  onState(drawTargets);
  // Ctrl+K opens the chat from anywhere
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      toggle(!D.open);
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
async function loadHistory() {
  const msgs = await GET<BrainHistoryEntry[]>('/brain/history').catch((): BrainHistoryEntry[] => []);
  if (D.items.length) return;
  for (const m of msgs.slice(-6)) D.items.push(m.role === 'user' ? { id: `h${m.ts}u`, kind: 'user', text: m.text, attachments: m.attachments } : { id: `h${m.ts}b`, kind: 'brain', answer: m.text, done: [], old: true });
  draw();
}

async function newConversation() {
  // keep the transcript if the Brain still remembers it
  if (!(await attempt(() => POST('/brain/clear')))) return;
  D.items = [];
  draw();
}

export function openDock(target: string | null = null, text = ''): void {
  if (target) D.target = target;
  toggle(true);
  if (text) D.input!.value = text;
}

function toggle(open: boolean) {
  D.open = open;
  D.panel!.classList.toggle('hidden', !open);
  D.launcher!.classList.toggle('hidden', open);
  if (open) {
    drawTargets();
    setTimeout(() => D.input!.focus(), 30);
  }
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
function draw() {
  if (frame) return;
  frame = true;
  requestAnimationFrame(() => {
    frame = false;
    const list = D.list!;
    mount(list, D.items.length ? D.items.map(renderItem) : h('div.dock-empty', icon('sparkles', 26), h('p', 'Ask the Brain anything about the project, or for anything to be done.'), h('p.hint', 'It sees every agent and team and what they are doing. It answers questions itself, builds teams from the library ("make me a social media team"), and hands work to the right agent or team.')));
    list.scrollTop = list.scrollHeight;
  });
}

function renderItem(it: DockItem): HTMLElement | null {
  if (it.kind === 'user') return h('div.dock-msg.user', it.text || null, attachmentChips(it.attachments));
  if (it.kind === 'note') return h('div.dock-note', { class: it.error ? 'err' : '' }, it.busy ? h('span.dot.busy') : null, it.text);
  if (it.kind === 'agent') {
    const a = state.data?.agents.find((x) => x.id === it.agentId);
    const body = it.text ? md(it.text) : h('div.hint', it.done ? '(no answer)' : 'Working…');
    body.classList?.add('dock-answer');
    return h(
      'div.dock-msg.agent',
      h('div.dock-who', a ? avatar(a) : null, h('b', a?.name || 'Agent'), a ? h('span.dock-answer-model', modelInfo(a).short) : null, it.reason ? h('span.hint', it.reason) : null, h('span.grow'), h('button.btn.tiny.ghost', { onclick: () => navigate(`#/agents/${it.agentId}/${it.chatId}`) }, 'Open chat')),
      it.tools?.length ? h('div.dock-tools', it.tools.map((t) => h('span', { class: t.status === 'running' ? 'run' : t.isError ? 'err' : '' }, `${t.status === 'running' ? '●' : t.isError ? '✕' : '✓'} ${t.name}`))) : null,
      body,
      it.images?.length ? h('div.st-imgs', it.images.slice(0, 4).map((src) => h('img', { src }))) : null,
      !it.done ? h('div.dock-note', h('span.dot.busy'), it.status || 'Working…') : null,
    );
  }
  if (it.kind === 'branch') {
    const agentOf = (id: string) => state.data?.agents.find((a) => a.id === id);
    return h(
      'div.dock-msg.agent',
      h('div.dock-who', h('div.avatar', icon('users', 14)), h('b', it.name), it.reason ? h('span.hint', it.reason) : null, h('span.grow'), h('button.btn.tiny.ghost', { onclick: () => navigate('#/station') }, 'Open team')),
      (it.messages || []).map((m) => {
        const a = agentOf(m.from);
        const body = md(String(m.text).slice(0, 3000));
        body.classList.add('dock-answer');
        return h('div.dock-team-msg', h('div.dock-who', a ? avatar(a) : null, h('b', a?.name || 'Team'), m.mentions?.length ? h('span.hint', `→ ${m.mentions.map((id) => agentOf(id)?.name).filter(Boolean).join(', ')}`) : null), body);
      }),
      it.working?.length ? h('div.dock-note', h('span.dot.busy'), `${it.working.map((id) => agentOf(id)?.name || 'Agent').join(', ')} working…`) : !it.messages?.length ? h('div.dock-note', h('span.dot.busy'), 'Sent to the team…') : null,
    );
  }
  if (it.kind === 'brain') {
    const b = state.data?.settings?.brain || { model: 'haiku' };
    const body = md(it.answer || (it.done?.length ? '' : '(no answer)'));
    body.classList?.add('dock-answer');
    const ico = { team: 'users', hired: 'user-plus', file: 'file-text', error: 'triangle-alert', note: 'check' };
    return h(
      'div.dock-msg.agent.brain',
      h('div.dock-who', h('div.avatar.brain-av', icon('brain', 14)), h('b', 'Brain'), h('span.dock-answer-model', modelInfo(brainAsAgent(b)).short)),
      body,
      it.done?.length
        ? h('div.brain-done', it.done.map((d) => h(`div.brain-act${d.kind === 'error' ? '.err' : ''}`, icon(ico[d.kind] || 'check', 13), h('span', d.text), d.teamId ? h('button.btn.tiny.ghost', { onclick: () => navigate(`#/station?team=${d.teamId}`) }, 'Show') : null)))
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
// One Brain ask at a time: the server saves each turn on top of the history it read, so overlapping asks would drop one.
let brainTurn: Promise<unknown> = Promise.resolve();

let sending = false;

// given: files uploaded elsewhere (a new project), sent along with what's in the tray
async function send(given: string[] = []) {
  const input = D.input!;
  const tray = D.tray!;
  const text = input.value.trim();
  if ((!text && !tray.count() && !given.length) || sending) return;
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
  input.value = '';
  tray.take();
  add({ kind: 'user', text, attachments });
  const t = D.target;
  if (t.startsWith('a:')) return toAgent(t.slice(2), text, '', attachments);
  if (t.startsWith('b:')) return toBranch(t.slice(2), text, '', attachments);
  if (t === 'new-agent') return newAgent(text, attachments);
  if (t === 'new-branch') return newBranch(text, attachments);
  // The Brain: answers, changes the roster, or hands the work on
  const thinking = add({ kind: 'note', text: 'The Brain is looking at the project…', busy: true });
  const ask = brainTurn.then(() => POST<BrainAnswer>('/brain/ask', { text, attachments }).catch((e: Error): Failed => ({ error: e.message })));
  brainTurn = ask;
  const r: Partial<BrainAnswer> & Failed = await ask;
  D.items.splice(D.items.indexOf(thinking), 1);
  if (r.error) return add({ kind: 'note', text: `The Brain couldn't answer: ${r.error}`, error: true });
  add({ kind: 'brain', answer: r.answer, done: r.done || [], delegate: r.delegate });
  if (r.done?.length) {
    refreshSoon(0);
    loadWorkflows();
  }
  if (r.delegate?.kind === 'agent') return toAgent(r.delegate.id, r.delegate.message || text, 'from the Brain', r.delegate.attachments);
  if (r.delegate?.kind === 'branch') return toBranch(r.delegate.id, r.delegate.message || text, 'from the Brain', r.delegate.attachments);
}

async function toAgent(agentId: string, text: string, reason = '', attachments: string[] = []) {
  const c = await attempt(() => POST<Chat>(`/agents/${agentId}/chats`));
  if (!c) return;
  const it = add({ kind: 'agent', agentId, chatId: c.id, text: '', tools: [], images: [], reason, done: false });
  const r = await attempt(() => POST(`/agents/${agentId}/chats/${c.id}/messages`, { text, attachments }));
  if (!r) {
    it.done = true;
    it.text = '(could not start)';
    draw();
  }
}

async function toBranch(wfId: string, text: string, reason = '', attachments: string[] = []) {
  const wf = D.workflows.find((w) => w.id === wfId);
  const msg = await attempt(() => POST<TeamMessage>(`/teams/${wfId}/messages`, { text, attachments }));
  if (!msg) return;
  add({ kind: 'branch', wfId, name: wf?.name || 'Team', reason, since: msg.ts, messages: [], working: [] });
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
    if (e.kind === 'message' && e.message.from !== 'user' && e.message.ts >= it.since) it.messages.push(e.message);
    if (e.kind === 'state') it.working = e.working;
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
