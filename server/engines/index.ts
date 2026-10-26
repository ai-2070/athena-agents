// Runs agents. One run = one user message answered by an agent (with any tool calls in between).
// Engines stream events; this file turns them into chat history and live updates for the browser.
import { agents as agentStore, chats, emit, log, getSettings, activeProject, withProject } from '../store.ts';
import { uid, HOME } from '../util.ts';
import { cancelForRun } from '../approvals.ts';
import { knowledgeContext } from '../knowledge.ts';
import { workspaceOf, toolsForAgent } from '../tools.ts';
import { skillsPrompt } from '../skills.ts';
import { withAttachments, attachmentNames } from '../uploads.ts';
import * as openai from './openai.ts';
import * as claude from './claude.ts';
import * as hermes from './hermes.ts';
import * as codex from './codex.ts';
import type { ActiveRun, Agent, Chat, ChatItem, EngineId, EngineInfo, EngineStatus, Project, RunEvent } from '../../shared/types.ts';

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

/** What an engine's run() resolves to. cost is in USD. */
export interface EngineResult {
  text: string;
  cost?: number;
  tokens?: number;
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
  startedAt: number;
  agentName: string;
  /** the project the run started in: its chat, tools and files stay there */
  project: Project;
  /** (its id) */
  projectId: string;
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
}

export interface StartRunOptions {
  depth?: number;
  from?: string | null;
  attachments?: string[];
  parentRunId?: string | null;
}

/** What a team adds while an agent works for it (tools, MCP servers, skills). */
export interface AskAgentExtra {
  toolGroups?: string[];
  mcpServers?: string[];
  skills?: string[];
}

export interface AskAgentOptions {
  depth?: number;
  from?: string | null;
  title?: string | null;
  chatId?: string | null;
  parentRunId?: string | null;
  signal?: AbortSignal | null;
  extra?: AskAgentExtra | null;
  attachments?: string[];
}

const ENGINES = { 'claude-code': claude, openai, hermes, codex } satisfies { [K in EngineId]: Engine<EngineStatus[K]> };
export const ENGINE_LIST: EngineInfo[] = [
  { id: 'claude-code', label: 'Claude Code', description: 'The Claude Code CLI on this PC: its own coding, files, web search and your claude.ai connectors, plus the dashboard tools. Signs in with your Claude login, an Anthropic key, or OpenRouter.' },
  { id: 'openai', label: 'API model', description: 'Any OpenRouter model, or a local model in LM Studio / Ollama. Uses the dashboard tools and MCP servers directly.' },
  { id: 'hermes', label: 'Hermes', description: 'One of your Hermes Agent profiles, with its own memory, skills and tools.' },
  { id: 'codex', label: 'Codex', description: 'OpenAI Codex CLI on this PC: coding, shell and files with your ChatGPT login (codex login), plus the dashboard tools.' },
];

const active = new Map<string, RunEntry>(); // runId -> { abort, agentId, chatId, chat, depth, parentRunId }

export function activeRuns(): ActiveRun[] {
  return [...active.entries()].map(([id, r]) => ({ id, agentId: r.agentId, chatId: r.chatId, startedAt: r.startedAt, agentName: r.agentName, parentRunId: r.parentRunId || null }));
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
  return r ? { id: runId, agentId: r.agentId, projectId: r.projectId, chatId: r.chatId, depth: r.depth, signal: r.signal, project: r.project } : null;
}

// The chat object a running agent is writing to, so edits made meanwhile aren't overwritten.
export function liveChat(chatId: string): Chat | null {
  for (const r of active.values()) if (r.chatId === chatId) return r.chat;
  return null;
}

export function buildSystemPrompt(agent: Agent): string {
  const date = new Date().toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short' });
  const tools = toolsForAgent(agent).map((t) => t.name);
  const project = activeProject();
  return [
    `You are ${agent.name}${agent.specialty ? `, ${agent.specialty}` : ''}.`,
    agent.systemPrompt || '',
    knowledgeContext(agent),
    skillsPrompt(agent),
    `\n# Where you are
You are one of several agents on the user's personal dashboard, running on their Windows PC (user folder ${HOME}).
You work on the project "${project.name}". Its Brain is the folder ${project.brainPath}: the project's files, notes${project.repo ? ` and its GitHub repo (${project.repo})` : ''}. Look there first for context (BRAIN.md, notes/, docs) and keep your work in it.
Your workspace folder is ${workspaceOf(agent)}; save files you make there unless told otherwise.
Today is ${date}.
${tools.includes('x_draft_post') ? 'Posts you write for X go to the Outbox for the user to approve; say so when you draft one.\n' : ''}${tools.includes('ask_agent') ? 'You can hand sub-tasks to teammates with ask_agent (see list_agents).\n' : ''}Be direct. When you finish a task, say what you did and where the results are.`,
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
export function startRun(agent: Agent, chat: Chat, text: string, { depth = 0, from = null, attachments = [], parentRunId = null }: StartRunOptions = {}): { runId: string; promise: Promise<string>; signal: AbortSignal } {
  if ([...active.values()].some((r) => r.chatId === chat.id)) throw new Error('This chat is already working on something. Stop it or wait.');
  // agent.engine comes from a JSON file, so it may be something unknown.
  const engine: Engine | undefined = (ENGINES as Partial<Record<string, Engine>>)[agent.engine];
  if (!engine) throw new Error(`Unknown engine "${agent.engine}".`);
  const runId = uid('r');
  const controller = new AbortController();
  const started = Date.now();
  const project = activeProject();
  const inProject = <T>(fn: () => T): T => withProject(project, fn);
  active.set(runId, { abort: () => controller.abort(), signal: controller.signal, agentId: agent.id, chatId: chat.id, chat, depth, parentRunId, startedAt: started, agentName: agent.name, project, projectId: project.id });
  // Saving skips chats deleted while the run was going.
  const persist = () =>
    inProject(() => {
      if (!chat._deleted) chats.save(chat);
    });

  // the chat shows what was written (with the files as chips); the agent also gets where the files are
  pushItem(chat, { type: 'user', text, from, ...(attachments.length ? { attachments } : {}) });
  if (chat.title === 'New chat') chat.title = (text || attachmentNames(attachments)).replace(/\s+/g, ' ').slice(0, 60) || 'New chat';
  persist();
  const send = (event: RunEvent) => emit('run', { runId, agentId: agent.id, chatId: chat.id, event });
  send({ kind: 'start', text, from, ...(attachments.length ? { attachments } : {}) });
  log('run', `${agent.name} started: ${(text || attachmentNames(attachments)).slice(0, 120)}`, { agentId: agent.id, chatId: chat.id });
  // API models can't open files without the Files tools: small text files go along in full
  const prompt = withAttachments(text, attachments, { inline: agent.engine === 'openai' ? 24000 : 0 });

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
      const it = [...chat.items].reverse().find((i): i is ChatItemOf<'tool'> => i.type === 'tool' && i.id === ev.id);
      if (it) Object.assign(it, { result: String(ev.text ?? '').slice(0, 30000), images: ev.images || [], isError: !!ev.isError, status: ev.isError ? 'error' : 'done' });
      persist();
    } else if (ev.kind === 'model') {
      const fresh = agentStore.get(agent.id);
      if (fresh && fresh.lastModel !== ev.model) agentStore.save({ ...fresh, lastModel: ev.model, lastModelAt: Date.now() });
    } else if (ev.kind === 'status') {
      // progress only, not stored
    }
    send(ev);
  };

  const promise = inProject(async () => {
    try {
      const result = await engine.run({ agent, chat, text: prompt, signal: controller.signal, onEvent, depth, runId, systemPrompt: buildSystemPrompt(agent), attachments });
      if (controller.signal.aborted) throw new Error('Stopped.');
      if (result?.text && !chat.items.some((i, idx) => idx > chat.items.findLastIndex((x) => x.type === 'user') && i.type === 'assistant')) {
        pushItem(chat, { type: 'assistant', text: result.text });
      }
      if (result?.cost) pushItem(chat, { type: 'meta', text: `$${result.cost.toFixed(4)}${result.tokens ? ` · ${result.tokens} tokens` : ''}` });
      persist();
      send({ kind: 'done', text: result?.text || '', cost: result?.cost || 0, seconds: Math.round((Date.now() - started) / 1000) });
      log('run', `${agent.name} finished (${Math.round((Date.now() - started) / 1000)}s)`, { agentId: agent.id, chatId: chat.id });
      return result?.text || lastAssistantText(chat);
    } catch (e) {
      const stopped = controller.signal.aborted;
      const msg = stopped ? 'Stopped.' : (e as Error).message || String(e);
      for (const it of chat.items) if (it.type === 'tool' && it.status === 'running') Object.assign(it, { status: 'error', isError: true, result: stopped ? '(stopped)' : '(did not finish)' });
      pushItem(chat, { type: 'error', text: msg });
      persist();
      send({ kind: 'error', text: msg });
      if (!stopped) log('error', `${agent.name}: ${msg}`, { agentId: agent.id, chatId: chat.id });
      if (depth > 0 && !stopped) throw e;
      return '';
    } finally {
      active.delete(runId);
      cancelForRun(runId);
      emit('runs');
    }
  });
  emit('runs');
  return { runId, promise, signal: controller.signal };
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

// Stopping a run also stops the runs it started (ask_agent) and anything a workflow started.
export function stopRun(runId: string): boolean {
  const r = active.get(runId);
  if (r) r.abort();
  cancelForRun(runId);
  stopChildren(runId);
  return !!r;
}

export function stopChildren(parentRunId: string) {
  for (const [id, r] of active) if (r.parentRunId === parentRunId) stopRun(id);
}

export function stopChat(chatId: string) {
  for (const [id, r] of active) if (r.chatId === chatId) stopRun(id);
}

// A chat deleted while running: stop it and make sure nothing writes it back.
export function forgetChat(chatId: string) {
  const live = liveChat(chatId);
  if (live) live._deleted = true;
  stopChat(chatId);
}

// Used by ask_agent and workflows: run to completion in a fresh chat, return the answer.
// extra: tool groups / MCP servers added for this run only (a branch's access).
export async function askAgent(agent: Agent, message: string, { depth = 1, from = null, title = null, chatId = null, parentRunId = null, signal = null, extra = null, attachments = [] }: AskAgentOptions = {}): Promise<string> {
  if (signal?.aborted) throw new RunStopped();
  let fresh = agentStore.get(agent.id) || agent;
  // extra: what a team adds while the agent works for it (tools, MCP servers, skills)
  if (extra) fresh = { ...fresh, toolGroups: [...new Set([...(fresh.toolGroups || []), ...(extra.toolGroups || [])])], mcpServers: [...new Set([...(fresh.mcpServers || []), ...(extra.mcpServers || [])])], _teamSkills: extra.skills || [] };
  const chat = (chatId && chats.get(fresh.id, chatId)) || chats.create(fresh.id, title || (from ? `Asked by ${from}` : 'Task'));
  const { runId, promise, signal: runSignal } = startRun(fresh, chat, message, { depth, from, parentRunId, attachments });
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

export function engineStatus(): EngineStatus {
  return {
    'claude-code': claude.status(),
    openai: openai.status(),
    hermes: hermes.status(),
    codex: codex.status(),
  };
}

export const defaultModel = (engine: string): string => {
  const d = getSettings().defaults;
  return engine === 'claude-code' ? d.claudeModel : engine === 'openai' ? d.openrouterModel : '';
};
