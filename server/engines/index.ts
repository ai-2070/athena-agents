// Runs agents. One run = one user message answered by an agent (with any tool calls in between).
// Engines stream events; this file turns them into chat history and live updates for the browser.
import { agents as agentStore, chats, emit, log, getSettings, activeProject, withProject, listProjects } from '../store.ts';
import { uid, HOME, settledWithin } from '../util.ts';
import { privateTeamRecord } from '../private-conversations.ts';
import { cancelForRun } from '../approvals.ts';
import { knowledgeContext } from '../knowledge.ts';
import { memoryContext, memoryStamp, readMemory, hasMemory } from '../memory.ts';
import { workspaceOf, toolsForAgent } from '../tools.ts';
import { worldPrompt } from '../voxel/tools.ts';
import { skillsPrompt } from '../skills.ts';
import { accountsPrompt, teamWorkServers } from '../mcp.ts';
import { withAttachmentsRead, attachmentNames } from '../uploads.ts';
import * as eve from './eve.ts';
import * as claude from './claude.ts';
import * as hermes from './hermes.ts';
import * as codex from './codex.ts';
import * as openclaw from './openclaw.ts';
import { pi, omp } from './pi.ts';
import * as contextInfo from '../context.ts';
import { defaultModelForEngine } from '../../shared/modeldefaults.ts';
import { keepToolImages } from '../toolimages.ts';
import { SessionGone } from './cli.ts';
import { engineCapabilities } from './capabilities.ts';
import { activeEveRuns, invalidateConversation, lateSteers, updateSteer, readRun as readEveRun, sessionBindings, sessionContext as eveSessionContext, transcriptContext } from '../eve/state.ts';
import { eveBillingItem, eveUsage } from '../eve/usage.ts';
import { eveRuntime } from '../eve/runtime.ts';
import { missedSteers } from '../eve/steer.ts';
import { richFor, richSection } from '../richanswers.ts';
import { clearWork, stopChatWork } from '../briefs.ts';
import { admitExecution, interruptExecutions, readExecution, saveExecutionQueue, updateExecution } from '../execution.ts';
import type { ActiveRun, Agent, Chat, ChatItem, EngineId, EveSteer, EngineInfo, EngineStatus, LoopInfo, Project, QueuedMessage, RunBilling, RunEvent, RunAccess, TeamContextMessage } from '../../shared/types.ts';
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
  /** Eve: follow a turn Eve already started with a late steer's message, instead of sending one */
  adopt?: Adoption;
}

/** A turn Eve started with a message that missed the turn before it (see takeOverSteers). */
export interface Adoption {
  bindingId: string;
  deliveryId: string;
  /** later messages that also missed it: the new turn may take them in */
  steers: EveSteer[];
}

/** What an engine's run() resolves to. cost is in USD (or a labeled USD-equivalent estimate). context: how full the model's memory was at the
 *  end, and window its size, in tokens (when the engine says). */
export interface EngineResult {
  text: string;
  cost?: number;
  billing?: RunBilling;
  tokens?: number;
  /** of those, read from the provider's prompt cache */
  cached?: number;
  context?: number;
  window?: number;
}

export interface Engine<S = unknown> {
  run(args: EngineRunArgs): Promise<EngineResult>;
  status(): S;
  /** an engine that can take a message into the turn going on (steering), instead of stopping it */
  steer?: TurnSteering;
}

/** A message for the turn going on. */
export interface TurnMessage {
  id: string;
  text: string;
  attachments?: string[];
  from?: string | null;
  /** a team message's id: the agent's next turn doesn't bring it again */
  teamMessageId?: string;
}

export interface TurnSteering {
  /** whether this run's turn can take a message right now */
  can(runId: string): boolean;
  /** sends it into the turn; throws when it wasn't taken (it then goes the ordinary way) */
  send(runId: string, message: TurnMessage): Promise<void>;
  /** the engine says when it reads the message (a steer event): the chat shows it then, where it came in.
   *  Otherwise the chat shows it as it is sent. */
  saysWhenRead?: boolean;
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
  /** stopped for a new message that a team steer takes care of (its chat's queue and loop go as for Stop) */
  forMessage?: boolean;
  stopRequested?: boolean;
  /** messages sent into its turn that its engine hasn't read yet (one that says when it reads them) */
  unread?: Map<string, JoiningMessage>;
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
  conversationId?: string;
  depth: number;
  signal: AbortSignal;
  project: Project;
  /** the agent as the run has it (see RunEntry) */
  agent: Agent;
}

export interface StartRunOptions {
  userInitiated?: boolean;
  depth?: number;
  from?: string | null;
  attachments?: string[];
  parentRunId?: string | null;
  context?: TeamContextMessage[];
  /** Reserved by a saved handoff or queue admission. */
  reservedRunId?: string;
  queueId?: string;
  workAccess?: RunAccess;
  adopt?: Adoption;
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
      const imported = new Set(chat.items.flatMap((item) => (item.type === 'user' || item.type === 'steer') && item.teamMessageId ? [item.teamMessageId] : []));
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
    const forMessage = stopped && !!(entry.steered || entry.forMessage || saved.steered);
    const error = stopped ? (forMessage ? 'Stopped to take your new message.' : 'Stopped.') : native.limitReason || (native.status === 'failed' ? 'Eve could not finish this work. Check the model connection and the saved results before continuing.' : native.error || 'Eve could not finish this work. Check what was done before continuing.');
    const chat = entry.chat;
    if (!chat._deleted && agentStore.get(entry.agentId) && chats.get(entry.agentId, chat.id)) {
      if (native.status !== 'completed') {
        const sourceId = `eve:${runId}:terminal`;
        if (!chat.items.some((item) => item.sourceId === sourceId)) chat.items.push({ type: 'error', text: error, ts: Date.now(), runId, sourceId, ...(stopped ? { stopped: forMessage ? 'steer' as const : 'stop' as const } : {}) });
        for (const item of chat.items) if (item.type === 'tool' && item.status === 'running') Object.assign(item, { status: 'error', isError: true, result: stopped ? '(stopped)' : '(did not finish)' });
      }
      finishMemoryReset(chat, runId);
      const billing = eveBillingItem(runId);
      if (billing && !chat.items.some((item) => item.sourceId === billing.sourceId)) chat.items.push(billing);
      chats.save(chat);
    }
    updateExecution(runId, { status: native.status as 'completed' | 'failed' | 'stopped' | 'interrupted', answer, ...(native.status === 'completed' ? {} : { error }), endedAt: native.endedAt || Date.now(), completionClaimed: true });
    active.delete(runId);
    restored.delete(runId);
    const steered = stopped && !!(entry.steered || saved.steered);
    const tookOver = !stopped && !steering.has(chatKey(entry.projectId, chat.id)) && !!takeOverSteers(runId, entry);
    if (native.status === 'interrupted') {
      stopChatWork(entry.ownerChatId, entry.projectId);
      const queue = waiting.get(chatKey(entry.projectId, chat.id));
      if (queue) { queue.paused = true; emitQueue(entry.agentId, chat.id, entry.projectId); }
    }
    const usage = eveUsage(runId);
    emit('run', { runId, agentId: entry.agentId, chatId: chat.id, projectId: entry.projectId, event: native.status === 'completed' ? { kind: 'done', text: answer, ...(usage.cost === undefined ? {} : { cost: usage.cost }), ...(usage.billing ? { billing: usage.billing } : {}), seconds: Math.round((Date.now() - entry.startedAt) / 1000) } : { kind: 'error', text: error } });
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
      else if (native.status !== 'interrupted' && !tookOver && !steering.has(chatKey(entry.projectId, chat.id))) carryOn(entry.projectId, chat.id);
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

/** Whether this run is going now (in this dashboard). */
export const runActive = (runId: string): boolean => active.has(runId);

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
  if (r) return { id: runId, agentId: r.agentId, projectId: r.projectId, chatId: r.chatId, conversationId: r.chat.conversationId, depth: r.depth, signal: r.signal, project: r.project, agent: r.agent };
  const saved = runId ? readEveRun(runId) : null;
  if (!saved || !['running', 'waiting'].includes(saved.status)) return null;
  try {
    const { binding, project, agent, chat } = eveSessionContext(saved.bindingId);
    return { id: saved.id, agentId: agent.id, projectId: project.id, chatId: binding.chatId, conversationId: chat.conversationId, depth: saved.depth, signal: new AbortController().signal, project, agent };
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

const COMPUTER = process.platform === 'win32' ? 'Windows PC' : process.platform === 'darwin' ? 'Mac' : 'Linux computer';
/** Added after the instructions of an agent hired from the Agent library (and no other): its role is a starting point. */
export const LIBRARY_ROLE_LINE = "Your role is where you are strongest, not a limit: take on nearby work you can do well with the tools you have, and when the work needs a tool you don't have, ask for it with request_tool.";

export function buildSystemPrompt(agent: Agent): string {
  // the day only: the instructions stay the same all day, so the provider's prompt cache can reuse them
  // and the chat after them (with the time in here, every message started a new cache)
  const date = new Date().toLocaleDateString('en-US', { dateStyle: 'full' });
  const tools = toolsForAgent(agent).map((t) => t.name);
  const project = activeProject();
  return [
    `You are ${agent.name}${agent.specialty ? `, ${agent.specialty}` : ''}.`,
    agent.systemPrompt || '',
    agent.source?.type === 'library' ? LIBRARY_ROLE_LINE : '',
    knowledgeContext(agent),
    memoryContext(agent),
    worldPrompt(tools),
    skillsPrompt(agent),
    // (what each tool does is in its own description: only what no description says goes here)
    'Before guessing about earlier work, look it up with search_conversations and read_conversation.',
    'Plan work with several steps in the dashboard\'s task tools (TaskCreate, TaskList, TaskUpdate), not a task list of your own, so the user and your team see the same records. Read TaskList at the start of each turn.',
    'When the user\'s message asks for real work, call set_goal once at the start (in a team chat, the lead does).',
    accountsPrompt(agent.mcpServers || []),
    `\n# Where you are
You are one of several agents on the user's personal dashboard, running on their ${COMPUTER} (user folder ${HOME}).
You work on the project "${project.name}". Its Brain is the folder ${project.brainPath}: the project's files, notes${project.repo ? ` and its GitHub repo (${project.repo})` : ''}. Look there first for context (BRAIN.md, notes/, docs) and keep your work in it.
Your workspace folder is ${workspaceOf(agent)}; save files you make there unless told otherwise.
Today is ${date}. (For the exact time, check the clock with a command if you can.)
${tools.includes('ask_user') ? 'When you need the user (a decision, a choice between options, something only they know or can do) or you are stuck, call ask_user with the question and short choices to click. Don\'t just ask in your reply: they may not be watching this chat.\n' : ''}${tools.includes('x_draft_post') ? 'Posts you write for X wait in the Outbox for the user to approve, unless that account has auto-post on (then they go out at once); replies and DMs always wait. Say which happened when you draft one.\n' : ''}${tools.includes('ask_agent') ? 'You can hand sub-tasks to teammates with ask_agent (see list_agents): it returns a handle at once, and await_agent gets the answer. Hand out independent tasks together so they run in parallel, and collect every answer before you finish. When the user writes @Name (or @Name [id] when names are shared), they mean that agent: give it its part with ask_agent.\n' : ''}Be direct. When you finish a task, say what you did and where the results are.`,
  ]
    .filter(Boolean)
    .join('\n');
}

function pushItem<T extends ChatItem>(chat: Chat, item: T): T {
  chat.items.push({ ts: Date.now(), ...item });
  return chat.items[chat.items.length - 1] as T;
}

/** What an agent is told when its last turn was stopped partway (its steps so far are in its session). */
export const STOP_NOTE: Record<'stop' | 'steer', string> = {
  steer: '<turn-note>\nYour last turn was stopped partway so you could read the new message below. What you did before the stop is done and kept: build on it, change course where the message says to, and don\'t start over or redo finished steps.\n</turn-note>\n\n',
  stop: '<turn-note>\nThe user stopped your last turn before it finished. What you did before the stop is kept; check it before redoing anything.\n</turn-note>\n\n',
};

/** Whether the turn before the next one was stopped partway (the last thing in the chat, cost lines aside). */
export function stoppedBefore(items: readonly ChatItem[]): 'stop' | 'steer' | null {
  const last = items.findLast((i) => i.type !== 'meta');
  return last?.type === 'error' && last.stopped ? last.stopped : null;
}

// Start answering a message in a chat. Returns immediately with the run id.
// The run belongs to the project it starts in (see withProject): opening another project meanwhile
// doesn't move its chat, tool calls or files there.
export function startRun(agent: Agent, chat: Chat, text: string, { depth = 0, from = null, attachments = [], parentRunId = null, context, reservedRunId, queueId, workAccess, userInitiated = false, adopt }: StartRunOptions = {}): { runId: string; promise: Promise<string>; signal: AbortSignal } {
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
  if ((!from || userInitiated) && depth === 0 && !parentRunId) userWorkHook?.(agent, chat, text || `Work on the attached files: ${attachmentNames(attachments)}`);
  // Saving skips chats deleted while the run was going.
  // Tool calls and their results are saved a moment later, together: a run with many tool calls rewrote
  // the whole chat file for every one of them. (Open tabs see each event at once either way.)
  let toolSave: ReturnType<typeof setTimeout> | null = null;
  const persist = () => {
    if (toolSave) clearTimeout(toolSave);
    toolSave = null;
    inProject(() => {
      if (!chat._deleted) chats.save(chat);
    });
  };
  const persistSoon = () => {
    toolSave ??= setTimeout(persist, 1000);
  };

  // the turn before this one was stopped partway: the agent is told, so it builds on what it did
  const cut = stoppedBefore(chat.items);
  const reset = chat.items.findLastIndex((i) => i.type === 'meta' && i.reset);
  const imported = new Set(chat.items.slice(reset + 1).flatMap((i) => (i.type === 'user' || i.type === 'steer') && i.teamMessageId ? [i.teamMessageId] : []));
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
  const send = (event: RunEvent) => emit('run', { runId, agentId: agent.id, chatId: chat.id, projectId: entry.projectId, event });
  send({ kind: 'start', text, from, ...(attachments.length ? { attachments } : {}) });
  log('run', `${agent.name} started: ${(text || attachmentNames(attachments)).slice(0, 120)}`, { agentId: agent.id, chatId: chat.id });

  let current: ChatItemOf<'assistant'> | null = null; // assistant item being streamed
  // the engine has started on the message (written or called a tool): its own session has it
  let heard = false;
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
    if (ev.kind === 'text' || ev.kind === 'tool') heard = true;
    if (ev.kind === 'steer') {
      // the engine read a message sent while it worked: it shows here, where it came in (and no longer waits to go next)
      entry.unread?.delete(ev.id);
      if (depth === 0) unqueue(chat.id, ev.id, project.id);
      current = null;
      pushItem(chat, { type: 'steer', steerId: ev.id, text: ev.text, runId, ...(ev.attachments?.length ? { attachments: ev.attachments } : {}), ...(ev.from ? { from: ev.from } : {}), ...(ev.teamMessageId ? { teamMessageId: ev.teamMessageId } : {}) });
      persist();
    } else if (ev.kind === 'text') {
      if (!current) current = pushItem(chat, { type: 'assistant', text: '' });
      current.text += ev.text;
      saveSoon();
    } else if (ev.kind === 'tool') {
      current = null;
      pushItem(chat, { type: 'tool', id: ev.id, name: ev.name, args: ev.args, result: null, status: 'running' });
      persistSoon();
    } else if (ev.kind === 'tool_result') {
      // its images as files next to the chat: the chat (and what's streamed) keeps only their links
      if (ev.images?.length) ev.images = keepToolImages(agent.id, chat.id, ev.images);
      const it = chat.items.findLast((i): i is ChatItemOf<'tool'> => i.type === 'tool' && i.id === ev.id);
      if (it) {
        const result = String(ev.text ?? '');
        const taskResult = /(?:^|[_:])Task(?:Create|Update)$/.test(it.name);
        Object.assign(it, { result: taskResult ? result : result.slice(0, 30000), images: ev.images || [], isError: !!ev.isError, status: ev.isError ? 'error' : 'done' });
      }
      persistSoon();
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
        // API models can't open files without the Files tools: small text files and documents' text go along
        const prompt = await withAttachmentsRead(text, attachments, { inline: engineCapabilities(agent.engine).inlineAttachmentText ? 24000 : 0 });
        if (!cli) return prompt;
        const window = await contextInfo.contextWindow(agent, chat);
        const input = chat.reseed ? contextInfo.seedPrompt(chat.items, prompt, window, systemPrompt)
          : memoryNote + (cut ? STOP_NOTE[cut] : '') + (added.length ? `${added.map((m) => m.text).join('\n\n')}\n\n` : '') + prompt;
        if (contextInfo.estimateTokens(systemPrompt + input) > window * 0.85) throw new Error('The full request does not fit this model. Choose a larger-context model or clear memory. No original messages were discarded.');
        return input;
      };
      const go = async () => engine.run({ agent, chat, text: await seeded(), signal: controller.signal, onEvent, depth, runId, systemPrompt, attachments, ...(adopt ? { adopt } : {}) });
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
      if (!engineCapabilities(agent.engine).durableSession && (result.cost != null || result.billing)) {
        const billing = result.billing;
        const amount = billing?.source === 'unavailable' ? 'Cost unavailable' : `${billing?.source === 'estimated' ? 'Estimated ' : ''}$${(result.cost || 0).toFixed(4)}${billing?.source === 'estimated' ? ' USD equivalent' : ''}`;
        const charged = [billing?.chargedUsd != null ? `$${billing.chargedUsd.toFixed(4)} USD charged` : '', billing?.chargedDiem != null ? `${billing.chargedDiem.toFixed(4)} DIEM charged` : ''].filter(Boolean);
        pushItem(chat, { type: 'meta', text: `${amount}${charged.length ? ` · ${charged.join(' · ')}` : ''}${result.tokens ? ` · ${result.tokens} tokens` : ''}${result.cached ? ` · ${result.cached} from cache` : ''}`, ...(billing ? { billing } : {}) });
      }
      persist();
      send({ kind: 'done', text: result?.text || '', ...(result?.billing ? { billing: result.billing, ...(result.cost != null ? { cost: result.cost } : {}) } : result.cost === undefined ? {} : { cost: result.cost }), seconds: Math.round((Date.now() - started) / 1000) });
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
      // One stopped after it got going had them: its session keeps what it did (a steer carries on from there).
      const cliTurn = !engineCapabilities(agent.engine).directTools;
      if (cliTurn && stopped && heard && chat.sessionId) delete chat.reseed;
      else if (cliTurn && added.length) {
        chat.sessionId = null;
        chat.reseed = true;
      }
      const interrupted = closing && !entry.stopRequested;
      const forMessage = !!(entry.steered || entry.forMessage);
      const msg = interrupted ? 'The dashboard closed before this work finished. Check what was done before continuing.' : stopped ? (forMessage ? 'Stopped to take your new message.' : 'Stopped.') : (e as Error).message || String(e);
      updateExecution(runId, { status: interrupted ? 'interrupted' : stopped ? 'stopped' : 'failed', error: msg, endedAt: Date.now() });
      for (const it of chat.items) if (it.type === 'tool' && it.status === 'running') Object.assign(it, { status: 'error', isError: true, result: stopped ? '(stopped)' : '(did not finish)' });
      pushItem(chat, { type: 'error', text: msg, runId, ...(stopped && !interrupted ? { stopped: forMessage ? 'steer' as const : 'stop' as const } : {}) });
      persist();
      send({ kind: 'error', text: msg });
      if (!stopped) log('error', `${agent.name}: ${msg}`, { agentId: agent.id, chatId: chat.id });
      if (depth > 0 && !stopped) throw e;
      return '';
    } finally {
      // you cleared its memory meanwhile: what this run added to it goes too
      if (!suspended) {
        finishMemoryReset(chat, runId);
        const billing = eveBillingItem(runId);
        if (billing && !chat.items.some((item) => item.sourceId === billing.sourceId)) chat.items.push(billing);
        persist();
      } else if (toolSave) persist();
      void eveRuntime.retireBindings().catch(() => {});
      active.delete(runId);
      unreadAtEnd(runId, entry);
      if (!suspended) cancelForRun(runId, { keepOutcomeChecks: true });
      emit('runs');
      const stopped = controller.signal.aborted;
      // stopped for a new message from you: that message is next, and a /goal is checked after it instead
      const steered = stopped && !!entry.steered;
      // a message you sent into this turn arrived as it ended: the next turn starts with it, and a run follows that
      const tookOver = !stopped && !suspended && !steering.has(key) && !!takeOverSteers(runId, entry);
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
        if (!tookOver) carryOn(project.id, chat.id);
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
  /** it joined the turn going on: its id (the stream that sent it already shows it) */
  steerId?: string;
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
  // an agent whose engine can take a message mid-turn (Eve): it joins the turn going on, nothing stops.
  // (decided at once: a message that can't join is saved in the queue below before anything waits)
  const joining = joinTurn(runs, text, attachments, projectId);
  const joined = joining && (await joining);
  if (joined) return joined;
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

/** The message joins the turn going on, when its engine can take one mid-turn: the chat shows it in the
 *  turn, and the run carries on with it. null: it can't (the caller stops the run and sends it next). */
function joinTurn(runs: [string, RunEntry][], text: string, attachments: string[], projectId: string): Promise<Steered | null> | null {
  if (runs.length !== 1 || !canJoin(...runs[0]!)) return null;
  const [runId, entry] = runs[0]!;
  // (the message is in the chat and on the run before this returns: nothing waits before it is saved)
  return joinRun(runId, entry, { text, attachments }).then((steerId): Steered | null => {
    if (!steerId) return null;
    if (active.has(runId)) return { runId, steerId };
    // it ended while the message went: the stream follows the run Eve's next turn starts with it, or
    // (none: the turn took it after all, or it goes the ordinary way) ends at once
    const next = takeOverSteers(runId, entry) ?? readEveRun(runId)?.steers?.find((s) => s.id === steerId)?.adoptedBy ?? null;
    if (!next) carryOn(projectId, entry.chatId);
    return { runId: next ?? Promise.resolve(null), steerId };
  });
}

/** Whether this run's engine can take a message into its turn right now. */
const steeringOf = (engine: EngineId): TurnSteering | undefined => (ENGINES[engine] as Engine | undefined)?.steer;
const canJoin = (runId: string, entry: RunEntry): boolean => !entry.stopRequested && !!steeringOf(entry.agent.engine)?.can(runId);

/** What a message that joins a turn says, and where it came from (a team message's id, so the agent's
 *  next turn doesn't bring it again). */
export interface JoiningMessage {
  text: string;
  attachments?: string[];
  from?: string | null;
  teamMessageId?: string;
}

/** A team's message for the turn this chat's agent is working on now, when its engine can take one
 *  mid-turn. False: it can't, or didn't (stop it and send the message the ordinary way). */
export function joinChatTurn(chatId: string, message: JoiningMessage, projectId: string = here()): Promise<boolean> {
  const runs = runsIn(projectId, chatId);
  return runs.length === 1 && canJoin(...runs[0]!) ? joinRun(runs[0]![0], runs[0]![1], message).then((id) => !!id) : Promise.resolve(false);
}

/** Sends the message into the run's turn. Its id when the turn took it; null when it didn't. */
async function joinRun(runId: string, entry: RunEntry, { text, attachments = [], from = null, teamMessageId }: JoiningMessage): Promise<string | null> {
  const steering_ = steeringOf(entry.agent.engine)!;
  const key = chatKey(entry.projectId, entry.chatId);
  const chat = entry.chat;
  const steerId = uid('s');
  const extra = { ...(attachments.length ? { attachments } : {}), ...(from ? { from } : {}) };
  // nothing else starts in the chat while it is sent; an engine that doesn't say when it reads it: saved at
  // once, and shown once the engine has it (one it didn't take is never shown in the turn)
  steering.add(key);
  if (!steering_.saysWhenRead) withProject(entry.project, () => {
    pushItem(chat, { type: 'steer', steerId, text, runId, ...extra, ...(teamMessageId ? { teamMessageId } : {}) });
    if (!chat._deleted) chats.save(chat);
  });
  // one shown when read: kept until then (in the queue, first, for your own chat), so it is never lost
  else holdUnread(runId, entry, steerId, { text, attachments, from, ...(teamMessageId ? { teamMessageId } : {}) });
  try {
    await steering_.send(runId, { id: steerId, text, attachments, ...(from ? { from } : {}), ...(teamMessageId ? { teamMessageId } : {}) });
    if (!steering_.saysWhenRead) emit('run', { runId, agentId: entry.agentId, chatId: chat.id, projectId: entry.projectId, event: { kind: 'steer', id: steerId, text, ...extra, ...(teamMessageId ? { teamMessageId } : {}) } });
    return steerId;
  } catch {
    // not taken: it goes the ordinary way, and the chat shows it there instead
    if (!steering_.saysWhenRead) withProject(entry.project, () => {
      chat.items = chat.items.filter((item) => !(item.type === 'steer' && item.steerId === steerId));
      if (!chat._deleted) chats.save(chat);
    });
    else {
      entry.unread?.delete(steerId);
      if (entry.depth === 0) unqueue(chat.id, steerId, entry.projectId);
    }
    return null;
  } finally {
    steering.delete(key);
  }
}

/** A message the engine will say it read: until then it waits first in your chat's queue, marked as sent, so
 *  Stop gives it back, a restart keeps it, and a turn that ends without reading it sends it next. */
function holdUnread(runId: string, entry: RunEntry, steerId: string, message: JoiningMessage): void {
  (entry.unread ||= new Map()).set(steerId, message);
  if (entry.depth > 0) return;
  const key = chatKey(entry.projectId, entry.chatId);
  const w = waiting.get(key) || { agentId: entry.agentId, project: entry.project, items: [], priority: [], paused: false };
  const q: QueuedMessage = { id: steerId, text: message.text, ...(message.attachments?.length ? { attachments: message.attachments } : {}), ...(message.from ? { from: message.from } : {}), ts: Date.now(), reading: runId };
  const at = w.items.findIndex((x) => !w.priority.includes(x.id));
  w.items.splice(at === -1 ? w.items.length : at, 0, q);
  w.priority.push(q.id);
  waiting.set(key, w);
  emitQueue(entry.agentId, entry.chatId, entry.projectId);
}

// a team's messages its member's turn ended without reading (by run): the team sends them again (missedMessages)
const missedReads = new Map<string, JoiningMessage[]>();

/** The run ended: messages it never read go next. In your chat they are first in the queue already (as
 *  ordinary queued messages now); a team's come back to the team. */
function unreadAtEnd(runId: string, entry: RunEntry): void {
  if (!entry.unread?.size) return;
  const left = [...entry.unread.values()];
  entry.unread.clear();
  if (entry.depth > 0) {
    missedReads.set(runId, left);
    // (collected as the team's turn ends; never kept for long)
    setTimeout(() => missedReads.delete(runId), 10 * 60_000).unref?.();
    return;
  }
  const w = waiting.get(chatKey(entry.projectId, entry.chatId));
  if (!w?.items.some((q) => q.reading === runId)) return;
  w.items = w.items.map((q) => (q.reading === runId ? (({ reading: _, ...rest }) => rest)(q) : q));
  emitQueue(entry.agentId, entry.chatId, entry.projectId);
}

/** A team turn's messages from you that its agent ended without reading (they missed its turn): Eve's, which
 *  leave its session, and those an engine that says when it reads them never did. They go to it next. */
export async function missedMessages(runId: string): Promise<{ steerId?: string; teamMessageId?: string }[]> {
  const eve = await missedSteers(runId);
  const read = missedReads.get(runId) || [];
  missedReads.delete(runId);
  // (Eve's are in the turn's work as steer items: steerId says which)
  return [...eve.map((s) => ({ steerId: s.id, ...(s.teamMessageId ? { teamMessageId: s.teamMessageId } : {}) })), ...read.map((m) => (m.teamMessageId ? { teamMessageId: m.teamMessageId } : {}))];
}

/** Messages sent into a turn that ended before it took them: Eve starts the next turn with the first (and
 *  may take the rest into that turn). A new run follows it, so its work shows and counts like any turn.
 *  The new run's id when one did. Not for work for a team or another agent: they wait on the answer they asked for. */
function takeOverSteers(runId: string, entry: Pick<RunEntry, 'agentId' | 'chat' | 'project' | 'depth'>): string | null {
  if (entry.depth > 0 || closing) return null;
  const late = lateSteers(runId);
  const chat = entry.chat;
  const agent = agentStore.get(entry.agentId);
  const eve = readEveRun(runId);
  if (!late.length || !agent || !eve || chat._deleted || runsIn(entry.project.id, chat.id).length) return null;
  const [first, ...rest] = late as [EveSteer, ...EveSteer[]];
  return withProject(entry.project, () => {
    // the messages move from the turn that missed them to the one they start
    const ids = new Set(late.map((s) => s.id));
    chat.items = chat.items.filter((item) => !(item.type === 'steer' && ids.has(item.steerId)));
    const next = startRun(agent, chat, first.text, { attachments: first.attachments, from: first.from || null, adopt: { bindingId: eve.bindingId, deliveryId: first.deliveryId!, steers: rest } });
    for (const s of late) updateSteer(runId, s.id, { adoptedBy: next.runId });
    for (const s of rest) pushItem(chat, { type: 'steer', steerId: s.id, text: s.text, runId: next.runId, ...(s.attachments.length ? { attachments: s.attachments } : {}), ...(s.from ? { from: s.from } : {}), ...(s.teamMessageId ? { teamMessageId: s.teamMessageId } : {}) });
    if (rest.length) chats.save(chat);
    return next.runId;
  });
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
/** Something is going in this chat: a turn or pending work. */
export const isChatBusy = (chatId: string, projectId: string = here()): boolean => chatBusy(projectId, chatId);
export const hasBackgroundWork = (chatId: string, projectId: string = here()): boolean => [...active.values()].some((r) => r.projectId === projectId && r.ownerChatId === chatId && r.chatId !== chatId);
const emitQueue = (agentId: string, chatId: string, projectId: string) => {
  const w = waiting.get(chatKey(projectId, chatId));
  saveExecutionQueue({ agentId, chatId, projectId, items: w?.items || [], priority: w?.priority || [], paused: w?.paused || false });
  emit('queue', { agentId, chatId, projectId, queued: queuedMessages(chatId, projectId) });
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
        const imported = new Set(chat.items.flatMap((item) => (item.type === 'user' || item.type === 'steer') && item.teamMessageId ? [item.teamMessageId] : []));
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
    // (one a run had been sent and not read: that run is gone, so it is an ordinary queued message now)
    const items = queue.items.map((q) => (q.reading ? (({ reading: _, ...rest }) => rest)(q) : q));
    if (items.length) waiting.set(chatKey(project.id, queue.chatId), { agentId: queue.agentId, project, items, priority: queue.priority, paused: queue.paused });
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
  // (one sent into the turn already: changing it here wouldn't change what it reads)
  if (!w || !q || q.reading) return null;
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
const emitLoop = (agentId: string, chatId: string, projectId: string) => emit('loop', { agentId, chatId, projectId, loop: loopOf(chatId, projectId) });

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

/** forMessage: stopped to take a new message (a team steer): the chat says so, and its next turn builds on this one. */
export function stopChat(chatId: string, projectId: string = here(), { forMessage = false }: { forMessage?: boolean } = {}) {
  unqueue(chatId, undefined, projectId);
  stopChatWork(chatId, projectId);
  for (const [id, run] of active) if (run.projectId === projectId && (run.chatId === chatId || run.ownerChatId === chatId)) {
    if (forMessage) run.forMessage = true;
    stopRun(id);
  }
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
  const teamPrefix = `team:${activeProject().id}/`;
  const parentConversation = parentRunId?.startsWith(teamPrefix) ? privateTeamRecord(parentRunId.slice(teamPrefix.length))?.conversationId : parentRunId ? runInfo(parentRunId)?.conversationId : undefined;
  const existing = chatId ? chats.get(fresh.id, chatId) : null;
  if (existing && parentRunId && existing.conversationId !== parentConversation) throw new Error('Delegated work cannot leave its private conversation.');
  const chat = existing || chats.create(fresh.id, title || (from ? `Asked by ${from}` : 'Task'), null, parentConversation);
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

export const defaultModel = (engine: string, provider?: string): string => defaultModelForEngine(engine, getSettings().defaults, provider);
