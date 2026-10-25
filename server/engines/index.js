// Runs agents. One run = one user message answered by an agent (with any tool calls in between).
// Engines stream events; this file turns them into chat history and live updates for the browser.
import { agents as agentStore, chats, emit, log, getSettings, activeProject } from '../store.js';
import { uid, HOME } from '../util.js';
import { cancelForRun } from '../approvals.js';
import { knowledgeContext } from '../knowledge.js';
import { workspaceOf, toolsForAgent } from '../tools.js';
import * as openai from './openai.js';
import * as claude from './claude.js';
import * as hermes from './hermes.js';

const ENGINES = { 'claude-code': claude, openai, hermes };
export const ENGINE_LIST = [
  { id: 'claude-code', label: 'Claude Code', description: 'The Claude Code CLI on this PC: its own coding, files, web search and your claude.ai connectors, plus the dashboard tools. Signs in with your Claude login, an Anthropic key, or OpenRouter.' },
  { id: 'openai', label: 'API model', description: 'Any OpenRouter model, or a local model in LM Studio / Ollama. Uses the dashboard tools and MCP servers directly.' },
  { id: 'hermes', label: 'Hermes', description: 'One of your Hermes Agent profiles, with its own memory, skills and tools.' },
];

const active = new Map(); // runId -> { abort, agentId, chatId, chat, depth, parentRunId }

export function activeRuns() {
  return [...active.entries()].map(([id, r]) => ({ id, agentId: r.agentId, chatId: r.chatId, startedAt: r.startedAt, agentName: r.agentName, parentRunId: r.parentRunId || null }));
}

export function runInfo(runId) {
  const r = runId && active.get(runId);
  return r ? { id: runId, agentId: r.agentId, chatId: r.chatId, depth: r.depth, signal: r.signal } : null;
}

// The chat object a running agent is writing to, so edits made meanwhile aren't overwritten.
export function liveChat(chatId) {
  for (const r of active.values()) if (r.chatId === chatId) return r.chat;
  return null;
}

export function buildSystemPrompt(agent) {
  const date = new Date().toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short' });
  const tools = toolsForAgent(agent).map((t) => t.name);
  const project = activeProject();
  return [
    `You are ${agent.name}${agent.specialty ? `, ${agent.specialty}` : ''}.`,
    agent.systemPrompt || '',
    knowledgeContext(agent),
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

function pushItem(chat, item) {
  chat.items.push({ ts: Date.now(), ...item });
  return chat.items[chat.items.length - 1];
}

// Start answering a message in a chat. Returns immediately with the run id.
export function startRun(agent, chat, text, { depth = 0, from = null, attachments = [], parentRunId = null } = {}) {
  if ([...active.values()].some((r) => r.chatId === chat.id)) throw new Error('This chat is already working on something. Stop it or wait.');
  const engine = ENGINES[agent.engine];
  if (!engine) throw new Error(`Unknown engine "${agent.engine}".`);
  const runId = uid('r');
  const controller = new AbortController();
  const started = Date.now();
  active.set(runId, { abort: () => controller.abort(), signal: controller.signal, agentId: agent.id, chatId: chat.id, chat, depth, parentRunId, startedAt: started, agentName: agent.name });
  // Saving skips chats deleted while the run was going.
  const persist = () => {
    if (!chat._deleted) chats.save(chat);
  };

  pushItem(chat, { type: 'user', text, from, attachments });
  if (chat.title === 'New chat') chat.title = text.replace(/\s+/g, ' ').slice(0, 60);
  persist();
  const send = (event) => emit('run', { runId, agentId: agent.id, chatId: chat.id, event });
  send({ kind: 'start', text, from });
  log('run', `${agent.name} started: ${text.slice(0, 120)}`, { agentId: agent.id, chatId: chat.id });

  let current = null; // assistant item being streamed
  let lastSave = 0;
  const saveSoon = () => {
    if (Date.now() - lastSave > 1500) {
      lastSave = Date.now();
      persist();
    }
  };

  const onEvent = (ev) => {
    if (ev.kind === 'text') {
      if (!current) current = pushItem(chat, { type: 'assistant', text: '' });
      current.text += ev.text;
      saveSoon();
    } else if (ev.kind === 'tool') {
      current = null;
      pushItem(chat, { type: 'tool', id: ev.id, name: ev.name, args: ev.args, result: null, status: 'running' });
      persist();
    } else if (ev.kind === 'tool_result') {
      const it = [...chat.items].reverse().find((i) => i.type === 'tool' && i.id === ev.id);
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

  const promise = (async () => {
    try {
      const result = await engine.run({ agent, chat, text, signal: controller.signal, onEvent, depth, runId, systemPrompt: buildSystemPrompt(agent), attachments });
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
      const msg = stopped ? 'Stopped.' : e.message || String(e);
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
  })();
  emit('runs');
  return { runId, promise };
}

function lastAssistantText(chat) {
  const lastUser = chat.items.findLastIndex((i) => i.type === 'user');
  return chat.items
    .slice(lastUser + 1)
    .filter((i) => i.type === 'assistant')
    .map((i) => i.text)
    .join('\n')
    .trim();
}

// Stopping a run also stops the runs it started (ask_agent) and anything a workflow started.
export function stopRun(runId) {
  const r = active.get(runId);
  if (r) r.abort();
  cancelForRun(runId);
  stopChildren(runId);
  return !!r;
}

export function stopChildren(parentRunId) {
  for (const [id, r] of active) if (r.parentRunId === parentRunId) stopRun(id);
}

export function stopChat(chatId) {
  for (const [id, r] of active) if (r.chatId === chatId) stopRun(id);
}

// A chat deleted while running: stop it and make sure nothing writes it back.
export function forgetChat(chatId) {
  const live = liveChat(chatId);
  if (live) live._deleted = true;
  stopChat(chatId);
}

// Used by ask_agent and workflows: run to completion in a fresh chat, return the answer.
// extra: tool groups / MCP servers added for this run only (a branch's access).
export async function askAgent(agent, message, { depth = 1, from = null, title = null, chatId = null, parentRunId = null, signal = null, extra = null } = {}) {
  if (signal?.aborted) throw new Error('Stopped.');
  let fresh = agentStore.get(agent.id) || agent;
  if (extra) fresh = { ...fresh, toolGroups: [...new Set([...(fresh.toolGroups || []), ...(extra.toolGroups || [])])], mcpServers: [...new Set([...(fresh.mcpServers || []), ...(extra.mcpServers || [])])] };
  const chat = (chatId && chats.get(fresh.id, chatId)) || chats.create(fresh.id, title || (from ? `Asked by ${from}` : 'Task'));
  const { runId, promise } = startRun(fresh, chat, message, { depth, from, parentRunId });
  const onAbort = () => stopRun(runId);
  signal?.addEventListener('abort', onAbort);
  try {
    const text = await promise;
    return text || lastAssistantText(chats.get(fresh.id, chat.id) || chat) || '(no answer)';
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

export function engineStatus() {
  return {
    'claude-code': claude.status(),
    openai: openai.status(),
    hermes: hermes.status(),
  };
}

export const defaultModel = (engine) => {
  const d = getSettings().defaults;
  return engine === 'claude-code' ? d.claudeModel : engine === 'openai' ? d.openrouterModel : '';
};
