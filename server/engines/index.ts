// Runs agents. One run = one user message answered by an agent (with any tool calls in between).
// Engines stream events; this file turns them into chat history and live updates for the browser.
import { agents as agentStore, chats, emit, log, getSettings, activeProject, withProject, listProjects } from '../store.ts';
import { uid, HOME, settledWithin } from '../util.ts';
import { cancelForRun } from '../approvals.ts';
import { knowledgeContext } from '../knowledge.ts';
import { memoryContext, memoryStamp, readMemory, hasMemory } from '../memory.ts';
import { workspaceOf, toolsForAgent } from '../tools.ts';
import { worldPrompt } from '../voxel/tools.ts';
import { skillsPrompt } from '../skills.ts';
import { accountsPrompt, teamWorkServers } from '../mcp.ts';
import { withAttachments, attachmentNames } from '../uploads.ts';
import * as eve from './eve.ts';
import * as claude from './claude.ts';
import * as hermes from './hermes.ts';
import * as codex from './codex.ts';
import * as openclaw from './openclaw.ts';
import { pi, omp } from './pi.ts';
import * as contextInfo from '../context.ts';
import { keepToolImages } from '../toolimages.ts';
import { SessionGone } from './cli.ts';
import { engineCapabilities } from './capabilities.ts';
import { activeEveRuns, invalidateConversation, readRun as readEveRun, sessionBindings, sessionContext as eveSessionContext, transcriptContext } from '../eve/state.ts';
import { eveUsage } from '../eve/usage.ts';
import { eveRuntime } from '../eve/runtime.ts';
import { richFor, richSection } from '../richanswers.ts';
import { clearWork, stopChatWork } from '../briefs.ts';
import { admitExecution, interruptExecutions, readExecution, saveExecutionQueue, updateExecution } from '../execution.ts';
import type { ActiveRun, Agent, Chat, ChatItem, EngineId, EngineInfo, EngineStatus, LoopInfo, Project, QueuedMessage, RunEvent, RunAccess, TeamContextMessage } from '../../shared/types.ts';
import type { LoopRequest } from '../../shared/commands.ts';
import { queuedEdit, reorderQueued } from '../../shared/queue.ts';

/** A run was stopped (by its caller or directly, e.g. its Stop button) before it answered. */
export class RunStopped extends Error {
  constructor() {
    super('Stopped.');
    this.name = 'RunStopped';
  }
}

/** What every engine's run() gets. */
export interface EngineRunArgs {
  agent: Agent;
  chat: Chat;
  text: string;
  signal: AbortSignal;
  onEvent: (ev: RunEvent) => void;
  depth: number;
  runId: string;
  systemPrompt: string;
  attachments: string[];
}

/** What an engine's run() resolves to. cost is in USD. context: how full the model's memory was at the
 *  end, and window its size, in tokens (when the engine says). */
export interface EngineResult {
  text: string;
  cost?: number;
  tokens?: number;
  /** of those, read from the provider's prompt cache */
  cached?: number;
  context?: number;
  window?: number;
}

export interface Engine<S = unknown> {
  run(args: EngineRunArgs): Promise<EngineResult>;
  status(): S;
}

/** One chat item of a given type, e.g. ChatItemOf<'tool'>. */
export type ChatItemOf<T extends ChatItem['type']> = Extract<ChatItem, { type: T }>;

/** A run in progress (kept in memory only). */
export interface RunEntry {
  abort: () => void;
  signal: AbortSignal;
  agentId: string;
  chatId: string;
  chat: Chat;
  depth: number;
  parentRunId: string | null;
  /** The top-level chat, even after its run has ended while children still work. */
  ownerChatId: string;
  ownerAgentId: string;
  ancestors: string[];
  startedAt: number;
  agentName: string;
  /** the project the run started in: its chat, tools and files stay there */
  project: Project;
  /** (its id) */
  projectId: string;
  /** the agent as the run has it, with what a team added (tools, MCP servers): the bridge uses this one */
  agent: Agent;
  /** stopped for a new message from you: its /queue messages and loop stay */
  steered?: boolean;
  stopRequested?: boolean;
}

/** What a running agent is doing right now (liveActivity()). */
export interface LiveActivity {
  runId: string;
  agentId: string;
  agentName: string;
  chatId: string;
  seconds: number;
  task: string;
  from: string | null;
  tool: { name: string; status: ChatItemOf<'tool'>['status']; args: string } | null;
  saying: string;
}

export interface RunInfo {
  id: string;
  agentId: string;
  projectId: string;
  chatId: string;
  depth: number;
  signal: AbortSignal;
  project: Project;
  /** the agent as the run has it (see RunEntry) */
  agent: Agent;
}

export interface StartRunOptions {
  depth?: number;
  from?: string | null;
  attachments?: string[];
  parentRunId?: string | null;
  context?: TeamContextMessage[];
  /** Reserved by a saved handoff or queue admission. */
  reservedRunId?: string;
  queueId?: string;
  workAccess?: RunAccess;
}

/** What a team adds while an agent works for it (tools, MCP servers, skills). */
export type AskAgentExtra = RunAccess;

export interface AskAgentOptions {
  depth?: number;
  from?: string | null;
  title?: string | null;
  chatId?: string | null;
  parentRunId?: string | null;
  signal?: AbortSignal | null;
  extra?: AskAgentExtra | null;
  attachments?: string[];
  context?: TeamContextMessage[];
  reservedRunId?: string;
}

const ENGINES = { 'claude-code': claude, eve, hermes, codex, pi, omp, openclaw } satisfies { [K in EngineId]: Engine<EngineStatus[K]> };
export const ENGINE_LIST: EngineInfo[] = [
  { id: 'claude-code', label: 'Claude Code', description: 'The Claude Code CLI on this PC: its own coding, files, web search and your claude.ai connectors, plus the dashboard tools. Signs in with your Claude login, an Anthropic key, or OpenRouter.' },
  { id: 'eve', label: 'API model', description: 'Any OpenRouter model, or a local model in LM Studio / Ollama. Uses the dashboard tools and MCP servers directly.' },
  { id: 'hermes', label: 'Hermes', description: 'One of your Hermes Agent profiles, with its own memory, skills and tools.' },
  { id: 'codex', label: 'Codex', description: 'OpenAI Codex CLI on this PC: coding, shell and files with your ChatGPT login (codex login), plus the dashboard tools.' },
  { id: 'pi', label: 'pi', description: 'The pi coding agent on this PC: coding, shell and files on any model pi is signed in to. Runs its tools without asking.' },
  { id: 'omp', label: 'oh-my-pi', description: 'oh-my-pi (omp) on this PC: pi with more tools (LSP, Python, web search, subagents). Runs its tools without asking.' },
  { id: 'openclaw', label: 'OpenClaw', description: 'One of your OpenClaw agents, with its own memory, skills, channels and tools.' },
];

const active = new Map<string, RunEntry>(); // runId -> { abort, agentId, chatId, chat, depth, parentRunId }
// each run, done once it has ended (its last steps included): a steer waits for the run it stopped
const ends = new Map<string, Promise<void>>();
const restored = new Map<string, { promise: Promise<string>; resolve: (answer: string) => void; reject: (error: Error) => void }>();

/** Recreate ownership only; the coordinator follows the existing native turn without submitting input. */
export function restoreNativeRun(runId: string, stop: () => Promise<void>): boolean {
  if (active.has(runId)) return false;
  const saved = readExecution().runs.find((run) => run.id === runId);
  const native = readEveRun(runId);
  if (!saved || saved.settled || saved.completionClaimed || !native) return false;
  const { binding, project, agent, chat } = transcriptContext(native.bindingId);
  if (saved.projectId !== project.id || saved.agentId !== agent.id || saved.chatId !== binding.chatId || saved.parentRunId !== native.parentRunId || saved.depth !== native.depth) throw new Error('The saved native run changed ownership.');
  if (runsIn(project.id, chat.id).length) throw new Error('This chat already has an active run.');
  const controller = new AbortController();
  const ancestors: string[] = [];
  const journal = readExecution();
  let parent = saved.parentRunId;
  while (parent && !ancestors.includes(parent)) {
    ancestors.push(parent);
    parent = journal.runs.find((run) => run.id === parent && run.projectId === project.id)?.parentRunId || null;
  }
  let resolve!: (answer: string) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
  const entry: RunEntry = {
    signal: controller.signal, agentId: agent.id, chatId: chat.id, chat, depth: saved.depth, parentRunId: saved.parentRunId,
    ownerChatId: saved.ownerChatId, ownerAgentId: saved.ownerAgentId, ancestors, startedAt: saved.startedAt,
    agentName: agent.name, project, projectId: project.id, agent, steered: saved.steered,
    abort: () => {
      controller.abort();
      if (closing) {
        active.delete(runId);
        restored.delete(runId);
        reject(new RunStopped());
        emit('runs');
      } else void stop().catch(() => log('error', 'Eve could not acknowledge Stop yet. The saved Stop remains in effect.', { agentId: agent.id, chatId: chat.id }));
    },
  };
  withProject(project, () => {
    if (!chat.items.some((item) => item.type === 'user' && item.runId === runId)) {
      const imported = new Set(chat.items.flatMap((item) => item.type === 'user' && item.teamMessageId ? [item.teamMessageId] : []));
      for (const item of saved.context || []) if (!imported.has(item.id)) {
        chat.items.push({ type: 'user', text: item.text, from: item.from, teamMessageId: item.id, ts: item.ts });
        imported.add(item.id);
      }
      chat.items.push({ type: 'user', text: saved.text, from: saved.from, attachments: saved.attachments, ts: saved.startedAt, runId });
      chats.save(chat);
    }
  });
  restored.set(runId, { promise, resolve, reject });
  ends.set(runId, promise.then(() => {}, () => {}).finally(() => ends.delete(runId)));
  active.set(runId, entry);
  emit('runs');
  return true;
}

export const nativeRunPromise = (runId: string): Promise<string> | undefined => restored.get(runId)?.promise;

/** Terminal facts, transcript and outcome are durable before completion is claimed. */
export function finishNativeRun(runId: string): void {
  const job = restored.get(runId);
  const entry = active.get(runId);
  const native = readEveRun(runId);
  const saved = readExecution().runs.find((run) => run.id === runId);
  if (!job || !entry || !native || !saved || ['queued', 'running', 'waiting'].includes(native.status)) return;
  withProject(entry.project, () => {
    const stopped = native.status === 'stopped';
    const failed = native.status === 'failed' || native.status === 'interrupted';
    const answer = native.answer || '';
    const error = stopped ? 'Stopped.' : native.limitReason || (native.status === 'failed' ? 'Eve could not finish this work. Check the model connection and the saved results before continuing.' : native.error || 'Eve could not finish this work. Check what was done before continuing.');
    const chat = entry.chat;
    if (!chat._deleted && agentStore.get(entry.agentId) && chats.get(entry.agentId, chat.id)) {
      if (native.status !== 'completed') {
        const sourceId = `eve:${runId}:terminal`;
        if (!chat.items.some((item) => item.sourceId === sourceId)) chat.items.push({ type: 'error', text: error, ts: Date.now(), runId, sourceId });
        for (const item of chat.items) if (item.type === 'tool' && item.status === 'running') Object.assign(item, { status: 'error', isError: true, result: stopped ? '(stopped)' : '(did not finish)' });
      }
      finishMemoryReset(chat, runId);
      chats.save(chat);
    }
    updateExecution(runId, { status: native.status as 'completed' | 'failed' | 'stopped' | 'interrupted', answer, ...(native.status === 'completed' ? {} : { error }), endedAt: native.endedAt || Date.now(), completionClaimed: true });
    active.delete(runId);
    restored.delete(runId);
    const steered = stopped && !!(entry.steered || saved.steered);
    if (native.status === 'interrupted') {
      stopChatWork(entry.ownerChatId, entry.projectId);
      const queue = waiting.get(chatKey(entry.projectId, chat.id));
      if (queue) { queue.paused = true; emitQueue(entry.agentId, chat.id, entry.projectId); }
    }
    const usage = eveUsage(runId);
    emit('run', { runId, agentId: entry.agentId, chatId: chat.id, event: native.status === 'completed' ? { kind: 'done', text: answer, ...(usage.cost === undefined ? {} : { cost: usage.cost }), seconds: Math.round((Date.now() - entry.startedAt) / 1000) } : { kind: 'error', text: error } });
    emit('runs');
    try {
      if (!steered) runEndHook?.({ runId, agentId: entry.agentId, chatId: chat.id, parentRunId: entry.parentRunId, ownerChatId: entry.ownerChatId, ownerAgentId: entry.ownerAgentId, answer, stopped, failed });
    } catch {
      /* a listener's problem is not the run's */
    } finally {
      updateExecution(runId, { settled: true });
      if (stopped) job.reject(new RunStopped());
      else if (failed) job.reject(new Error(error));
      else job.resolve(answer);
      if (stopped && !steered) unqueue(chat.id, undefined, entry.projectId);
      else if (native.status !== 'interrupted' && !steering.has(chatKey(entry.projectId, chat.id))) carryOn(entry.projectId, chat.id);
    }
  });
}

// What is kept in memory for a chat (below) is by project and chat: a cloned project keeps its chats' ids,
// so a chat id alone could mean the original's chat. Without a project: the one the work belongs to.
const chatKey = (projectId: string, chatId: string): string => `${projectId}\n${chatId}`;
const here = (): string => activeProject().id;
const runsIn = (projectId: string, chatId: string): [string, RunEntry][] => [...active.entries()].filter(([, r]) => r.projectId === projectId && r.chatId === chatId);

// chats where a new message waits for the run it stopped to end: it goes next, so nothing else starts meanwhile
const steering = new Set<string>();

export function activeRuns(): ActiveRun[] {
  return [...active.entries()].map(([id, r]) => ({ id, agentId: r.agentId, chatId: r.chatId, projectId: r.projectId, startedAt: r.startedAt, agentName: r.agentName, parentRunId: r.parentRunId || null, depth: r.depth }));
}

// What the current turn of a chat is about: its message, latest tool and latest text.
// Only items after the last user message count, so an earlier run's tool or answer never shows.
export function turnActivity(items: ChatItem[]): Pick<LiveActivity, 'task' | 'from' | 'tool' | 'saying'> {
  const start = items.findLastIndex((i) => i.type === 'user');
  const turn = start === -1 ? items : items.slice(start);
  const lastUser = start === -1 ? undefined : (turn[0] as ChatItemOf<'user'>);
  const lastTool = turn.findLast((i): i is ChatItemOf<'tool'> => i.type === 'tool');
  const lastText = turn.findLast((i): i is ChatItemOf<'assistant'> => i.type === 'assistant');
  return {
    task: String(lastUser?.text || '').slice(0, 300),
    from: lastUser?.from || null,
    tool: lastTool ? { name: lastTool.name, status: lastTool.status, args: JSON.stringify(lastTool.args || {}).slice(0, 200) } : null,
    saying: String(lastText?.text || '').slice(-240),
  };
}

// What every running agent is doing right now (for the Brain's overview).
export function liveActivity(): LiveActivity[] {
  return [...active.entries()].map(([id, r]) => ({
    runId: id,
    agentId: r.agentId,
    agentName: r.agentName,
    chatId: r.chatId,
    seconds: Math.round((Date.now() - r.startedAt) / 1000),
    ...turnActivity(r.chat?.items || []),
  }));
}

export function runInfo(runId: string | null | undefined): RunInfo | null {
  const r = runId && active.get(runId);
  if (r) return { id: runId, agentId: r.agentId, projectId: r.projectId, chatId: r.chatId, depth: r.depth, signal: r.signal, project: r.project, agent: r.agent };
  const saved = runId ? readEveRun(runId) : null;
  if (!saved || !['running', 'waiting'].includes(saved.status)) return null;
  try {
    const { binding, project, agent } = eveSessionContext(saved.bindingId);
    return { id: saved.id, agentId: agent.id, projectId: project.id, chatId: binding.chatId, depth: saved.depth, signal: new AbortController().signal, project, agent };
  } catch { return null; }
}

// The chat object a running agent is writing to, so edits made meanwhile aren't overwritten.
export function liveChat(chatId: string, projectId: string = here()): Chat | null {
  for (const r of active.values()) if (r.projectId === projectId && r.chatId === chatId) return r.chat;
  return null;
}

/** The run going in an agent's chat (in this project), if any. */
export function chatRunId(agentId: string, chatId: string, projectId: string = here()): string | null {
  return runsIn(projectId, chatId).find(([, r]) => r.agentId === agentId)?.[0] ?? null;
}

/** Clear memory: the agent starts fresh after this. While a run goes, its memory is cleared again when it
 *  ends (what it answers now came from the memory you cleared). */
export function resetMemory(chat: Chat, projectId: string = here()): void {
  invalidateConversation(projectId, chat.id);
  if (projectId === here()) clearWork('agent', chat.agentId, chat.id);
  chat.items.push({ type: 'meta', text: 'Memory cleared: the agent starts fresh from here.', reset: true, ts: Date.now() });
  for (const [id] of runsIn(projectId, chat.id)) updateExecution(id, { clearMemoryOnEnd: true });
  clearMemory(chat);
  void eveRuntime.retireBindings().catch(() => {});
}

function finishMemoryReset(chat: Chat, runId: string): void {
  if (!readExecution().runs.find((run) => run.id === runId)?.clearMemoryOnEnd) return;
  const sourceId = `reset:${runId}`;
  if (!chat.items.some((item) => item.sourceId === sourceId)) chat.items.push({ type: 'meta', text: 'Memory cleared after the previous turn finished.', reset: true, ts: Date.now(), sourceId });
  clearMemory(chat);
}

function clearMemory(chat: Chat): void {
  chat.sessionId = null;
  delete chat.reseed;
  delete chat.context;
}

export function buildSystemPrompt(agent: Agent): string {
  // the day only: the instructions stay the same all day, so the provider's prompt cache can reuse them
  // and the chat after them (with the time in here, every message started a new cache)
  const date = new Date().toLocaleDateString('en-US', { dateStyle: 'full' });
  const tools = toolsForAgent(agent).map((t) => t.name);
  const project = activeProject();
  return [
    `You are ${agent.name}${agent.specialty ? `, ${agent.specialty}` : ''}.`,
    agent.systemPrompt || '',
    knowledgeContext(agent),
    memoryContext(agent),
    worldPrompt(tools),
    skillsPrompt(agent),
    'Use search_conversations to find earlier work in your own chats or your teams\' shared conversations in this project. Use read_conversation on a search hit to read the saved original; continue with nextOffset until you have the text you need. Search past decisions before guessing about earlier work.',
    'Use the dashboard TaskCreate, TaskGet, TaskList and TaskUpdate tools for work with several steps. TaskCreate/TaskUpdate accept one task or {tasks:[...]} with no per-call task-count cap, processed in order with per-item results; retry only failures because successes stay saved. Keep acceptance criteria in descriptions, claim ready tasks before starting, and mark completed only after checking the result. Read TaskList on each turn to recover saved work. Respect blockedBy dependencies and other owners. Use the dashboard MCP task tools, not a harness-local task list, so the user and team share the same records. Task creation and assignment record work; they do not start another agent. Delegate with ask_agent or team mentions when needed.',
    accountsPrompt(agent.mcpServers || []),
    `\n# Where you are
You are one of several agents on the user's personal dashboard, running on their Windows PC (user folder ${HOME}).
You work on the project "${project.name}". Its Brain is the folder ${project.brainPath}: the project's files, notes${project.repo ? ` and its GitHub repo (${project.repo})` : ''}. Look there first for context (BRAIN.md, notes/, docs) and keep your work in it.
Your workspace folder is ${workspaceOf(agent)}; save files you make there unless told otherwise.
Today is ${date}. (For the exact time, check the clock with a command if you can.)
${tools.includes('ask_user') ? 'When you need the user (a decision, a choice between options, something only they know or can do) or you are stuck, call ask_user with the question and short choices to click. Don\'t just ask in your reply: they may not be watching this chat.\n' : ''}${tools.includes('x_draft_post') ? 'Posts you write for X go to the Outbox for the user to approve; say so when you draft one.\n' : ''}${tools.includes('ask_agent') ? 'You can hand sub-tasks to teammates with ask_agent (see list_agents): it returns a handle at once, and await_agent gets the answer. Hand out independent tasks together so they run in parallel, and collect every answer before you finish. When the user writes @Name (or @Name [id] when names are shared), they mean that agent: give it its part with ask_agent.\n' : ''}Be direct. When you finish a task, say what you did and where the results are.`,
  ]
    .filter(Boolean)
    .join('\n');
}

function pushItem<T extends ChatItem>(chat: Chat, item: T): T {
  chat.items.push({ ts: Date.now(), ...item });
  return chat.items[chat.items.length - 1] as T;
}

// Start answering a message in a chat. Returns immediately with the run id.
// The run belongs to the project it starts in (see withProject): opening another project meanwhile
// doesn't move its chat, tool calls or files there.
export function startRun(agent: Agent, chat: Chat, text: string, { depth = 0, from = null, attachments = [], parentRunId = null, context, reservedRunId, queueId, workAccess }: StartRunOptions = {}): { runId: string; promise: Promise<string>; signal: AbortSignal } {
  if (closing) throw new Error('The dashboard is stopping.');
  const project = activeProject();
  const key = chatKey(project.id, chat.id);
  if (runsIn(project.id, chat.id).length) throw new Error('This chat is already working on something. Stop it or wait.');
  // agent.engine comes from a JSON file, so it may be something unknown.
  const engine: Engine | undefined = (ENGINES as Partial<Record<string, Engine>>)[agent.engine];
  if (!engine) throw new Error(`Unknown engine "${agent.engine}".`);
  const runId = reservedRunId || uid('r');
  const controller = new AbortController();
  const started = Date.now();
  const inProject = <T>(fn: () => T): T => withProject(project, fn);
  const parent = parentRunId ? active.get(parentRunId) : null;
  const entry: RunEntry = { abort: () => controller.abort(), signal: controller.signal, agentId: agent.id, chatId: chat.id, chat, depth, parentRunId, ownerChatId: parent?.ownerChatId || chat.id, ownerAgentId: parent?.ownerAgentId || agent.id, ancestors: [...(parent?.ancestors || []), ...(parentRunId ? [parentRunId] : [])], startedAt: started, agentName: agent.name, project, projectId: project.id, agent };
  admitExecution({ id: runId, projectId: project.id, agentId: agent.id, chatId: chat.id, engine: agent.engine, parentRunId, ownerChatId: entry.ownerChatId, ownerAgentId: entry.ownerAgentId, depth, text, from, attachments, context, workAccess, startedAt: started, status: 'running' }, queueId);
  const queued = waiting.get(key);
  if (queued) {
    queued.paused = false;
    if (queueId) {
      queued.items = queued.items.filter((q) => q.id !== queueId);
      queued.priority = queued.priority.filter((id) => id !== queueId);
      if (!queued.items.length) waiting.delete(key);
    }
  }
  active.set(runId, entry);
  if (!from && depth === 0 && !parentRunId) userWorkHook?.(agent, chat, text || `Work on the attached files: ${attachmentNames(attachments)}`);
  // Saving skips chats deleted while the run was going.
  const persist = () =>
    inProject(() => {
      if (!chat._deleted) chats.save(chat);
    });

  const reset = chat.items.findLastIndex((i) => i.type === 'meta' && i.reset);
  const imported = new Set(chat.items.slice(reset + 1).flatMap((i) => i.type === 'user' && i.teamMessageId ? [i.teamMessageId] : []));
  const added: TeamContextMessage[] = [];
  for (const m of context || []) {
    if (imported.has(m.id)) continue;
    imported.add(m.id);
    added.push(m);
  }
  for (const m of added) {
    pushItem(chat, { type: 'user', text: m.text, from: m.from, ts: m.ts, teamMessageId: m.id });
  }
  // the chat shows what was written (with the files as chips); the agent also gets where the files are
  pushItem(chat, { type: 'user', text, from, runId, ...(attachments.length ? { attachments } : {}) });
  if (chat.title === 'New chat') chat.title = (text || attachmentNames(attachments)).replace(/\s+/g, ' ').slice(0, 60) || 'New chat';
  persist();
  const send = (event: RunEvent) => emit('run', { runId, agentId: agent.id, chatId: chat.id, event });
  send({ kind: 'start', text, from, ...(attachments.length ? { attachments } : {}) });
  log('run', `${agent.name} started: ${(text || attachmentNames(attachments)).slice(0, 120)}`, { agentId: agent.id, chatId: chat.id });
  // API models can't open files without the Files tools: small text files go along in full
  const prompt = withAttachments(text, attachments, { inline: engineCapabilities(agent.engine).inlineAttachmentText ? 24000 : 0 });

  let current: ChatItemOf<'assistant'> | null = null; // assistant item being streamed
  let lastSave = 0;
  const saveSoon = () => {
    if (Date.now() - lastSave > 1500) {
      lastSave = Date.now();
      persist();
    }
  };

  // (engines call this from their own callbacks: pinned again so it never depends on where they come from)
  const onEvent = (ev: RunEvent) => inProject(() => onEventIn(ev));
  const onEventIn = (ev: RunEvent) => {
    if (ev.kind === 'text') {
      if (!current) current = pushItem(chat, { type: 'assistant', text: '' });
      current.text += ev.text;
      saveSoon();
    } else if (ev.kind === 'tool') {
      current = null;
      pushItem(chat, { type: 'tool', id: ev.id, name: ev.name, args: ev.args, result: null, status: 'running' });
      persist();
    } else if (ev.kind === 'tool_result') {
      // its images as files next to the chat: the chat (and what's streamed) keeps only their links
      if (ev.images?.length) ev.images = keepToolImages(agent.id, chat.id, ev.images);
      const it = [...chat.items].reverse().find((i): i is ChatItemOf<'tool'> => i.type === 'tool' && i.id === ev.id);
      if (it) {
        const result = String(ev.text ?? '');
        const taskResult = /(?:^|[_:])Task(?:Create|Update)$/.test(it.name);
        Object.assign(it, { result: taskResult ? result : result.slice(0, 30000), images: ev.images || [], isError: !!ev.isError, status: ev.isError ? 'error' : 'done' });
      }
      persist();
    } else if (ev.kind === 'model') {
      const fresh = agentStore.get(agent.id);
      if (fresh && fresh.lastModel !== ev.model) agentStore.save({ ...fresh, lastModel: ev.model, lastModelAt: Date.now() });
    } else if (ev.kind === 'compacted') {
      // the engine compacted its own memory (Claude Code): mark the spot, keep everything else as it is
      current = null;
      const item = pushItem(chat, { type: 'compaction', id: uid('k'), text: '', mode: 'engine', trigger: ev.trigger === 'manual' ? 'manual' : 'auto', upto: chat.items.length, ...(ev.tokensBefore ? { tokensBefore: ev.tokensBefore } : {}) });
      delete chat.context;
      persist();
      emit('compacted', { agentId: agent.id, chatId: chat.id, itemId: item.id });
      return;
    } else if (ev.kind === 'status') {
      // progress only, not stored
    }
    send(ev);
  };

  // (for whoever looks at the run once it ended: see onRunEnd)
  let answer = '';
  let failed = false;
  let suspended = false;
  const promise = inProject(async () => {
    try {
      const systemPrompt = buildSystemPrompt(agent) + (await richSection(agent, chat, depth));
      // (the memory meter counts its instructions the same way: see memoryOf)
      chat.rich = richFor(agent, chat, depth);
      const cli = !engineCapabilities(agent.engine).directTools;
      if (chat.sessionEngine && chat.sessionEngine !== agent.engine) invalidateConversation(project.id, chat.id);
      if (cli && (!chat.sessionId || chat.sessionEngine !== agent.engine)) {
        chat.sessionId = null;
        chat.reseed = true;
      }
      chat.sessionEngine = agent.engine;
      controller.signal.throwIfAborted();
      // Codex, Hermes and OpenClaw get the instructions only when their session starts: a session that is
      // already going is told when MEMORY.md changed since its last run (by you, or in another chat)
      const memoryAt = hasMemory(agent) ? memoryStamp(agent.id) : 0;
      const memoryNote = !chat.reseed && chat.sessionId && (agent.engine === 'codex' || agent.engine === 'hermes' || agent.engine === 'openclaw') && memoryAt > (chat.memoryAt || 0) ? `<memory-update>\nYour MEMORY.md changed since your last message here. It now says:\n${readMemory(agent.id).trim() || '(empty)'}\n</memory-update>\n\n` : '';
      chat.memoryAt = memoryAt;
      // (prompt: the message with its attachments, as the engine gets it)
      const seeded = async () => {
        if (!cli) return prompt;
        const window = await contextInfo.contextWindow(agent, chat);
        const input = chat.reseed ? contextInfo.seedPrompt(chat.items, prompt, window, systemPrompt)
          : memoryNote + (added.length ? `${added.map((m) => m.text).join('\n\n')}\n\n` : '') + prompt;
        if (contextInfo.estimateTokens(systemPrompt + input) > window * 0.85) throw new Error('The full request does not fit this model. Choose a larger-context model or clear memory. No original messages were discarded.');
        return input;
      };
      const go = async () => engine.run({ agent, chat, text: await seeded(), signal: controller.signal, onEvent, depth, runId, systemPrompt, attachments });
      let result: EngineResult;
      try { result = await go(); }
      catch (error) {
        if (controller.signal.aborted || !(error instanceof SessionGone)) throw error;
        chat.reseed = true;
        result = await go();
      }
      if (controller.signal.aborted) throw new Error('Stopped.');
      // the new CLI session has the saved original conversation now
      if (cli && chat.sessionId) delete chat.reseed;
      // (what it wrote to its own memory meanwhile, it knows)
      if (memoryAt) chat.memoryAt = memoryStamp(agent.id);
      if (result?.context) chat.context = { tokens: result.context, ...(result.window ? { window: result.window } : {}), items: chat.items.length, at: Date.now(), by: contextInfo.measuredBy(agent) };
      if (result?.text && !chat.items.some((i, idx) => idx > chat.items.findLastIndex((x) => x.type === 'user') && i.type === 'assistant')) {
        pushItem(chat, { type: 'assistant', text: result.text });
      }
      if (!engineCapabilities(agent.engine).durableSession && result?.cost != null) pushItem(chat, { type: 'meta', text: `$${result.cost.toFixed(4)}${result.tokens ? ` · ${result.tokens} tokens` : ''}${result.cached ? ` · ${result.cached} from cache` : ''}` });
      persist();
      send({ kind: 'done', text: result?.text || '', ...(result.cost === undefined ? {} : { cost: result.cost }), seconds: Math.round((Date.now() - started) / 1000) });
      log('run', `${agent.name} finished (${Math.round((Date.now() - started) / 1000)}s)`, { agentId: agent.id, chatId: chat.id });
      answer = result?.text || lastAssistantText(chat);
      updateExecution(runId, { status: 'completed', answer, endedAt: Date.now() });
      return answer;
    } catch (e) {
      if (closing && !entry.stopRequested && readEveRun(runId) && engineCapabilities(agent.engine).durableSession) {
        suspended = true;
        return '';
      }
      const stopped = controller.signal.aborted;
      failed = !stopped;
      // A failed CLI turn may never have received its imported messages. Replay saved memory on retry.
      if (context && !engineCapabilities(agent.engine).directTools) {
        chat.sessionId = null;
        chat.reseed = true;
      }
      const interrupted = closing && !entry.stopRequested;
      const msg = interrupted ? 'The dashboard closed before this work finished. Check what was done before continuing.' : stopped ? (entry.steered ? 'Stopped to take your new message.' : 'Stopped.') : (e as Error).message || String(e);
      updateExecution(runId, { status: interrupted ? 'interrupted' : stopped ? 'stopped' : 'failed', error: msg, endedAt: Date.now() });
      for (const it of chat.items) if (it.type === 'tool' && it.status === 'running') Object.assign(it, { status: 'error', isError: true, result: stopped ? '(stopped)' : '(did not finish)' });
      pushItem(chat, { type: 'error', text: msg, runId });
      persist();
      send({ kind: 'error', text: msg });
      if (!stopped) log('error', `${agent.name}: ${msg}`, { agentId: agent.id, chatId: chat.id });
      if (depth > 0 && !stopped) throw e;
      return '';
    } finally {
      // you cleared its memory meanwhile: what this run added to it goes too
      if (!suspended) {
        finishMemoryReset(chat, runId);
        persist();
      }
      void eveRuntime.retireBindings().catch(() => {});
      active.delete(runId);
      if (!suspended) cancelForRun(runId);
      emit('runs');
      const stopped = controller.signal.aborted;
      // stopped for a new message from you: that message is next, and a /goal is checked after it instead
      const steered = stopped && !!entry.steered;
      try {
        if (!steered && !suspended) {
          updateExecution(runId, { completionClaimed: true });
          runEndHook?.({ agentId: agent.id, chatId: chat.id, runId, parentRunId, ownerChatId: entry.ownerChatId, ownerAgentId: entry.ownerAgentId, answer, stopped, failed });
        }
      } catch {
        /* a listener's problem is not the run's */
      }
      if (!closing) updateExecution(runId, { settled: true });
      // done: your next /queue message goes now, then the loop's next one (a stopped run takes them with it: you said stop)
      if (closing) {
        stopLoop(chat.id, null, project.id);
      } else if (steered) {
        // the queue and the loop carry on after your new message (a loop turn it cut counts as done)
        loopRunEnded(project.id, chat.id, runId, false);
        // (it waits for this run to end and goes now; one that gave up waiting is first in the queue)
        if (!steering.has(key)) carryOn(project.id, chat.id);
      } else if (stopped) {
        unqueue(chat.id, undefined, project.id);
        stopLoop(chat.id, 'Loop stopped.', project.id);
      } else {
        loopRunEnded(project.id, chat.id, runId, failed);
        carryOn(project.id, chat.id);
      }
    }
  });
  ends.set(
    runId,
    promise.then(
      () => {},
      () => {},
    ).finally(() => ends.delete(runId)),
  );
  emit('runs');
  return { runId, promise, signal: controller.signal };
}

// ---------- steering: a message while the chat works ----------
/** How long a steer waits for the run it stopped to end. Longer than that, it goes first in the queue instead. */
const STEER_WAIT_MS = 10_000;
// the steers in each chat, one after the other (a second one waits for the first to start its run)
const steers = new Map<string, Promise<unknown>>();

/** What a steer started: its run, or (the run it stopped is slow to end) the run it will be once that
 *  ends; null if it was taken back first (/stop). */
export interface Steered {
  runId: string | Promise<string | null>;
}

/** A message sent while the chat works changes its course: the run going now stops (its /queue messages
 *  and loop stay), and this message starts next, with what was done so far. Nothing going: sent as usual.
 *  Not while it works for a team or another agent: they wait on that answer. */
export function steerChat(agent: Agent, chat: Chat, text: string, { attachments = [], waitMs = STEER_WAIT_MS }: { attachments?: string[]; waitMs?: number } = {}): Promise<Steered> {
  // (the wait outlives the request: what comes after it stays in this project)
  const project = activeProject();
  const key = chatKey(project.id, chat.id);
  const mine = (steers.get(key) || Promise.resolve()).then(() => withProject(project, () => steerNow(agent, chat, text, attachments, waitMs, project.id)));
  const tail = mine.then(
    () => {},
    () => {},
  );
  steers.set(key, tail);
  void tail.then(() => steers.get(key) === tail && steers.delete(key));
  return mine;
}

async function steerNow(agent: Agent, chat: Chat, text: string, attachments: string[], waitMs: number, projectId: string): Promise<Steered> {
  const key = chatKey(projectId, chat.id);
  const runs = runsIn(projectId, chat.id);
  if (runs.some(([, r]) => r.depth > 0)) throw httpError(409, `${agent.name} is working for a team or another agent in this chat. Stop it there, or /queue your message for when it is done.`);
  if (!runs.length) return { runId: startRun(agent, chat, text, { attachments }).runId };
  steering.add(key);
  // Save the new input before stopping its predecessor, including a crash during the wait.
  const started = queueFirst(agent, chat, text, attachments);
  let ended: boolean;
  try {
    for (const [id, r] of runs) {
      r.steered = true;
      updateExecution(id, { steered: true });
      stopRun(id);
    }
    ended = await settledWithin(
      runs.map(([id]) => ends.get(id)),
      waitMs,
    );
  } finally {
    steering.delete(key);
  }
  // deleted while it waited: never make it again
  const now = liveChat(chat.id, projectId) || chats.get(agent.id, chat.id);
  if (!now || now._deleted || chat._deleted) throw httpError(404, 'This chat was deleted.');
  // still ending: this message goes first, the moment it has
  carryOn(projectId, chat.id);
  return { runId: ended ? (await started) ?? Promise.resolve(null) : started };
}

// ---------- /queue: messages that wait for the chat to be free ----------
// Saved by project and chat. A restarted queue waits for a new message before carrying on.
const waiting = new Map<string, { agentId: string; project: Project; items: QueuedMessage[]; priority: string[]; paused: boolean }>();
// queued messages someone waits on: told the run each one started, or null if it never will
const starts = new Map<string, (runId: string | null) => void>();
const told = (id: string, runId: string | null) => {
  starts.get(id)?.(runId);
  starts.delete(id);
};
const chatBusy = (projectId: string, chatId: string) => runsIn(projectId, chatId).length > 0 || steering.has(chatKey(projectId, chatId));
/** Something is going in this chat: a run, or a compaction. */
export const isChatBusy = (chatId: string, projectId: string = here()): boolean => chatBusy(projectId, chatId);
export const hasBackgroundWork = (chatId: string, projectId: string = here()): boolean => [...active.values()].some((r) => r.projectId === projectId && r.ownerChatId === chatId && r.chatId !== chatId);
const emitQueue = (agentId: string, chatId: string, projectId: string) => {
  const w = waiting.get(chatKey(projectId, chatId));
  saveExecutionQueue({ agentId, chatId, projectId, items: w?.items || [], priority: w?.priority || [], paused: w?.paused || false });
  emit('queue', { agentId, chatId, queued: queuedMessages(chatId, projectId) });
};

/** Restore ownership before the Brain, schedules or incoming requests can start work. */
export function recoverExecution(): void {
  const projects = listProjects();
  const resumable = new Set([...activeEveRuns().map((r) => r.id), ...restored.keys()]);
  for (const run of interruptExecutions(resumable)) {
    const project = projects.find((p) => p.id === run.projectId);
    if (project) withProject(project, () => {
      stopChatWork(run.ownerChatId, run.projectId);
      const chat = chats.get(run.agentId, run.chatId);
      if (!chat) return;
      if (!chat.items.some((item) => item.type === 'user' && item.runId === run.id)) {
        const imported = new Set(chat.items.flatMap((item) => item.type === 'user' && item.teamMessageId ? [item.teamMessageId] : []));
        for (const m of run.context || []) if (!imported.has(m.id)) {
          chat.items.push({ type: 'user', text: m.text, from: m.from, ts: m.ts, teamMessageId: m.id });
          imported.add(m.id);
        }
        chat.items.push({ type: 'user', text: run.text, from: run.from, attachments: run.attachments, ts: run.startedAt, runId: run.id });
      }
      if (!chat.items.some((item) => item.type === 'error' && item.runId === run.id)) chat.items.push({ type: 'error', runId: run.id, text: run.error || 'This work finished before the dashboard restarted. Follow-up work is paused. Send a message to continue.', ts: run.endedAt || Date.now() });
      if (run.status !== 'completed') {
        for (const item of chat.items) if (item.type === 'tool' && item.status === 'running') Object.assign(item, { status: 'error', isError: true, result: '(interrupted)' });
        chat.sessionId = null;
              chat.reseed = true;
      }
      chats.save(chat);
    });
    updateExecution(run.id, { settled: true });
  }
  waiting.clear();
  for (const queue of readExecution().queues) {
    const project = projects.find((p) => p.id === queue.projectId);
    const valid = project && withProject(project, () => !!agentStore.get(queue.agentId) && !!chats.get(queue.agentId, queue.chatId));
    if (!project || !valid) {
      saveExecutionQueue({ ...queue, items: [], paused: false });
      continue;
    }
    if (queue.paused) stopChatWork(queue.chatId, project.id);
    if (queue.items.length) waiting.set(chatKey(project.id, queue.chatId), { agentId: queue.agentId, project, items: queue.items, priority: queue.priority, paused: queue.paused });
  }
}

export function queuedMessages(chatId: string, projectId: string = here()): QueuedMessage[] {
  return [...(waiting.get(chatKey(projectId, chatId))?.items || [])];
}

/** Send now if the chat is free, else once it is done with what it is doing. from: who it is from, when not you. */
export function queueMessage(agent: Agent, chat: Chat, text: string, attachments: string[] = [], { from, resume = false }: { from?: string; resume?: boolean } = {}): { runId: string } | { queued: QueuedMessage } {
  const project = activeProject();
  const key = chatKey(project.id, chat.id);
  if (!chatBusy(project.id, chat.id) && (!waiting.has(key) || resume)) return { runId: startRun(agent, chat, text, { attachments, from: from || null }).runId };
  const w = waiting.get(key) || { agentId: agent.id, project, items: [], priority: [], paused: false };
  const queued: QueuedMessage = { id: uid('q'), text, ...(attachments.length ? { attachments } : {}), ...(from ? { from } : {}), ts: Date.now() };
  w.items.push(queued);
  waiting.set(key, w);
  emitQueue(agent.id, chat.id, project.id);
  // (free after all: the oldest goes now)
  sendQueued(project.id, chat.id);
  return { queued };
}

/** A steer whose stopped run is slow to end: first in the queue (after earlier ones like it), so it goes
 *  the moment that run has. Resolves with the run it starts, or null if it never does. */
function queueFirst(agent: Agent, chat: Chat, text: string, attachments: string[]): Promise<string | null> {
  const project = activeProject();
  const key = chatKey(project.id, chat.id);
  const w = waiting.get(key) || { agentId: agent.id, project, items: [], priority: [], paused: false };
  const q: QueuedMessage = { id: uid('q'), text, ...(attachments.length ? { attachments } : {}), ts: Date.now() };
  const at = w.items.findIndex((x) => !w.priority.includes(x.id));
  w.items.splice(at === -1 ? w.items.length : at, 0, q);
  w.priority.push(q.id);
  waiting.set(key, w);
  const started = new Promise<string | null>((resolve) => starts.set(q.id, resolve));
  emitQueue(agent.id, chat.id, project.id);
  // (it ended meanwhile after all)
  carryOn(project.id, chat.id);
  return started;
}

/** Change the text of a queued message before it goes. null: it already went. */
export function editQueued(chatId: string, id: string, text: unknown, projectId: string = here()): QueuedMessage | null {
  const w = waiting.get(chatKey(projectId, chatId));
  const q = w?.items.find((x) => x.id === id);
  if (!w || !q) return null;
  q.text = queuedEdit(text, !!q.attachments?.length);
  emitQueue(w.agentId, chatId, projectId);
  return q;
}

/** Put the queued messages in this order (ids it doesn't name keep their place after the ones it does). */
export function orderQueued(chatId: string, ids: unknown, projectId: string = here()): QueuedMessage[] {
  const w = waiting.get(chatKey(projectId, chatId));
  if (!w) return [];
  w.items = reorderQueued(w.items, ids);
  emitQueue(w.agentId, chatId, projectId);
  return [...w.items];
}

/** Take back one queued message (id), or all of them. Returns what was taken. */
export function unqueue(chatId: string, id?: string, projectId: string = here()): QueuedMessage[] {
  const key = chatKey(projectId, chatId);
  const w = waiting.get(key);
  if (!w) return [];
  const taken = id ? w.items.filter((q) => q.id === id) : w.items;
  w.items = id ? w.items.filter((q) => q.id !== id) : [];
  w.priority = w.priority.filter((id) => w.items.some((q) => q.id === id));
  if (!w.items.length) waiting.delete(key);
  for (const q of taken) told(q.id, null);
  if (taken.length) emitQueue(w.agentId, chatId, projectId);
  return taken;
}

/** The chat is free: your next /queue message goes now, else the loop's next one. */
function carryOn(projectId: string, chatId: string) {
  sendQueued(projectId, chatId);
  fireLoop(projectId, chatId);
}

function sendQueued(projectId: string, chatId: string) {
  const key = chatKey(projectId, chatId);
  const w = waiting.get(key);
  if (!w || w.paused || !w.items.length || chatBusy(projectId, chatId)) return;
  const next = w.items[0]!;
  // in the project it was typed in, like the run before it
  withProject(w.project, () => {
    const agent = agentStore.get(w.agentId);
    const chat = chats.get(w.agentId, chatId);
    if (!agent || !chat) {
      for (const q of [next, ...w.items]) told(q.id, null);
      waiting.delete(key);
      return;
    }
    try {
      told(next.id, startRun(agent, chat, next.text, { attachments: next.attachments || [], from: next.from || null, queueId: next.id }).runId);
    } catch (e) {
      told(next.id, null);
      w.paused = true;
      log('error', `${agent.name}: a queued message couldn't be sent: ${(e as Error).message}`, { agentId: agent.id, chatId });
    }
  });
  // (after the run's start event, so an open chat knows that turn came from its queue)
  emitQueue(w.agentId, chatId, projectId);
}

// ---------- after a run ----------
/** How a run ended, for whoever watches (the Brain's /goal checks). */
export interface RunEnd {
  agentId: string;
  chatId: string;
  runId: string;
  parentRunId?: string | null;
  ownerChatId?: string;
  ownerAgentId?: string;
  answer: string;
  stopped: boolean;
  failed: boolean;
}
let runEndHook: ((e: RunEnd) => void) | null = null;
let userWorkHook: ((agent: Agent, chat: Chat, text: string) => void) | null = null;
export function onUserWork(fn: typeof userWorkHook): void {
  userWorkHook = fn;
}
/** Called (in the run's project) whenever a run ends. One listener. */
export function onRunEnd(fn: ((e: RunEnd) => void) | null): void {
  runEndHook = fn;
}

/** A line in a chat from the dashboard (a loop that ended, a goal reached), shown to you, not sent to the agent. */
export function addChatNote(agentId: string, chatId: string, text: string): void {
  // while it runs, into the copy the run writes (it saves it); else into the saved chat
  const live = liveChat(chatId);
  if (live) live.items.push({ type: 'meta', text, ts: Date.now() });
  else {
    const chat = chats.get(agentId, chatId);
    if (!chat) return;
    chat.items.push({ type: 'meta', text, ts: Date.now() });
    chats.save(chat);
  }
  emit('chat-note', { agentId, chatId });
}

// ---------- /loop: a message sent again and again ----------
// Kept in memory by chat. A timed loop sends every so often (never while a turn is going: a due one
// waits for it to end); the other kind sends again right after each of its answers. Queued messages go first.
interface ChatLoop extends LoopInfo {
  agentId: string;
  project: Project;
  attachments: string[];
  due: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  /** the run it started last, while it goes */
  runId: string | null;
}
const loops = new Map<string, ChatLoop>();

export function loopOf(chatId: string, projectId: string = here()): LoopInfo | null {
  const l = loops.get(chatKey(projectId, chatId));
  return l ? { text: l.text, every: l.every, times: l.times, done: l.done, next: l.next } : null;
}
const emitLoop = (agentId: string, chatId: string, projectId: string) => emit('loop', { agentId, chatId, loop: loopOf(chatId, projectId) });

/** Start a loop in this chat (instead of one going there): the first one goes now, or when the chat is free. */
export function startLoop(agent: Agent, chat: Chat, req: LoopRequest, attachments: string[] = []): LoopInfo {
  const project = activeProject();
  stopLoop(chat.id, null, project.id);
  loops.set(chatKey(project.id, chat.id), { ...req, done: 0, next: null, agentId: agent.id, project, attachments, due: true, timer: null, runId: null });
  fireLoop(project.id, chat.id);
  emitLoop(agent.id, chat.id, project.id);
  return loopOf(chat.id, project.id)!;
}

/** End the loop in this chat. why: the note left in the chat (null: none). */
export function stopLoop(chatId: string, why: string | null, projectId: string = here()): boolean {
  const key = chatKey(projectId, chatId);
  const l = loops.get(key);
  if (!l) return false;
  if (l.timer) clearTimeout(l.timer);
  loops.delete(key);
  if (why) withProject(l.project, () => addChatNote(l.agentId, chatId, why));
  emitLoop(l.agentId, chatId, projectId);
  return true;
}

function fireLoop(projectId: string, chatId: string) {
  const key = chatKey(projectId, chatId);
  const l = loops.get(key);
  if (!l || !l.due || chatBusy(projectId, chatId) || waiting.has(key)) return;
  l.due = false;
  l.done++;
  l.next = null;
  const started = withProject(l.project, () => {
    const agent = agentStore.get(l.agentId);
    const chat = chats.get(l.agentId, chatId);
    if (!agent || !chat) return 'The chat or its agent is gone.';
    try {
      l.runId = startRun(agent, chat, l.text, { attachments: l.attachments, from: `/loop ${l.done} of ${l.times}` }).runId;
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  });
  if (started) return void stopLoop(chatId, `Loop ended: ${started}`, projectId);
  if (l.every != null && l.done < l.times) {
    l.next = Date.now() + l.every;
    l.timer = setTimeout(() => {
      l.timer = null;
      l.due = true;
      fireLoop(projectId, chatId);
    }, l.every);
    l.timer.unref?.();
  }
  emitLoop(l.agentId, chatId, projectId);
}

function loopRunEnded(projectId: string, chatId: string, runId: string, failed: boolean) {
  const l = loops.get(chatKey(projectId, chatId));
  if (!l || l.runId !== runId) return;
  l.runId = null;
  if (failed) return void stopLoop(chatId, `Loop ended: turn ${l.done} of ${l.times} failed.`, projectId);
  if (l.done >= l.times) return void stopLoop(chatId, `Loop done: sent ${l.times} time${l.times > 1 ? 's' : ''}.`, projectId);
  if (l.every == null) l.due = true;
  emitLoop(l.agentId, chatId, projectId);
}

function lastAssistantText(chat: Chat): string {
  const lastUser = chat.items.findLastIndex((i) => i.type === 'user');
  return chat.items
    .slice(lastUser + 1)
    .filter((i): i is ChatItemOf<'assistant'> => i.type === 'assistant')
    .map((i) => i.text)
    .join('\n')
    .trim();
}

// Stopping a run also stops the runs it started (ask_agent, even while nobody awaits them) and anything a workflow started.
export function stopRun(runId: string): boolean {
  const r = active.get(runId);
  if (r) {
    if (!closing) {
      r.stopRequested = true;
      updateExecution(runId, { stopRequested: true });
      if (!r.steered) unqueue(r.chatId, undefined, r.projectId);
    }
    r.abort();
  }
  if (!closing) cancelForRun(runId);
  stopChildren(runId);
  return !!r;
}

let closing = false;
export const isStopping = (): boolean => closing;
/** The server is stopping: stop every run (an agent's CLI and everything it started with it), start no
 *  new ones, and wait up to `ms` for them to end, so nothing keeps working in a project after we're gone. */
export async function stopAllRuns(ms = 3000): Promise<void> {
  closing = true;
  for (const id of [...active.keys()]) stopRun(id);
  const until = Date.now() + ms;
  while (active.size && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
}

export function stopChildren(parentRunId: string) {
  for (const [id, r] of active) if (r.ancestors.includes(parentRunId)) stopRun(id);
}

export function stopChat(chatId: string, projectId: string = here()) {
  unqueue(chatId, undefined, projectId);
  stopChatWork(chatId, projectId);
  for (const [id, run] of active) if (run.projectId === projectId && (run.chatId === chatId || run.ownerChatId === chatId)) stopRun(id);
}

// A chat deleted while running: stop it and make sure nothing writes it back.
export function forgetChat(chatId: string, projectId: string = here()) {
  invalidateConversation(projectId, chatId);
  const live = liveChat(chatId, projectId);
  if (live && projectId === here()) clearWork('agent', live.agentId, chatId);
  if (live) live._deleted = true;
  unqueue(chatId, undefined, projectId);
  stopLoop(chatId, null, projectId);
  stopChat(chatId, projectId);
  void eveRuntime.retireBindings().catch(() => {});
}

export function retireAgentSessions(agentId: string, projectId: string = here()): void {
  for (const binding of sessionBindings()) if (binding.projectId === projectId && binding.agentId === agentId) invalidateConversation(projectId, binding.chatId);
  void eveRuntime.retireBindings().catch(() => {});
}

// Used by ask_agent and workflows: run to completion in a fresh chat, return the answer.
// extra: tool groups / MCP servers added for this run only (a branch's access).
export async function askAgent(agent: Agent, message: string, { depth = 1, from = null, title = null, chatId = null, parentRunId = null, signal = null, extra = null, attachments = [], context, reservedRunId }: AskAgentOptions = {}): Promise<string> {
  if (signal?.aborted) throw new RunStopped();
  let fresh = agentStore.get(agent.id) || agent;
  // extra: what a team adds while the agent works for it (tools, MCP servers, skills)
  // (the team's copy of a service, its account, replaces the agent's own copies of it)
  if (extra) fresh = { ...fresh, toolGroups: [...new Set([...(fresh.toolGroups || []), ...(extra.toolGroups || [])])], mcpServers: teamWorkServers(fresh.mcpServers || [], extra.mcpServers || []), _teamSkills: extra.skills || [] };
  const chat = (chatId && chats.get(fresh.id, chatId)) || chats.create(fresh.id, title || (from ? `Asked by ${from}` : 'Task'));
  const { runId, promise, signal: runSignal } = startRun(fresh, chat, message, { depth, from, parentRunId, attachments, context, reservedRunId, workAccess: extra || undefined });
  const onAbort = () => stopRun(runId);
  signal?.addEventListener('abort', onAbort);
  try {
    const text = await promise;
    // A stopped run resolves with no answer: tell the caller it was stopped instead, whether the caller
    // stopped it or someone stopped the run itself.
    if (signal?.aborted || runSignal.aborted) throw new RunStopped();
    return text || lastAssistantText(chats.get(fresh.id, chat.id) || chat) || '(no answer)';
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

const httpError = (status: number, msg: string) => Object.assign(new Error(msg), { status });

/** How full the agent's memory of a chat is (the meter in the chat). */
export async function memoryOf(agent: Agent, chatId: string): Promise<{ tokens: number; window: number; percent: number; estimated: boolean }> {
  const chat = liveChat(chatId) || chats.get(agent.id, chatId);
  if (!chat) throw httpError(404, 'Not found');
  const window = await contextInfo.contextWindow(agent, chat);
  // as its runs go: a chat that is handed work (or a team's) never has Rich answers' instructions
  const rich = chat.rich ?? richFor(agent, chat, 0);
  const tokens = contextInfo.memoryTokens(chat, agent, buildSystemPrompt(agent) + (rich ? await richSection(agent, {}, 0) : ''));
  // (an engine that compacts by itself does it when the window is nearly full, not at the threshold here)
  return { tokens, window, percent: Math.round((tokens / window) * 100), estimated: !chat.context || chat.context.by !== contextInfo.measuredBy(agent) };
}

export function engineStatus(): EngineStatus {
  return {
    'claude-code': claude.status(),
    eve: eve.status(),
    hermes: hermes.status(),
    codex: codex.status(),
    pi: pi.status(),
    omp: omp.status(),
    openclaw: openclaw.status(),
  };
}

export const defaultModel = (engine: string): string => {
  const d = getSettings().defaults;
  return engine === 'claude-code' ? d.claudeModel : engine === 'eve' ? d.openrouterModel : '';
};
