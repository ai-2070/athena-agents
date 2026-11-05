// The agents' routes (server/api/agents.ts): the list, making, changing, copying and deleting an agent, its
// knowledge, its workspace and its harness's / commands. Also answered under /api/p/<project> for a project
// that isn't open (an Overview pane's).
import { oc, type } from '@orpc/contract';
import { z } from 'zod';
import type { Effort } from '../effort.ts';
import type { Agent, AgentDetail, Autonomy, BrainBrief, Chat, ChatSummary, EngineId, HarnessCommand, LoopInfo, QueuedMessage } from '../types.ts';

// (Records, so a new engine, autonomy or effort can't be left out here)
const ENGINES = { 'claude-code': 'claude-code', eve: 'eve', hermes: 'hermes', codex: 'codex', pi: 'pi', omp: 'omp', openclaw: 'openclaw' } as const satisfies Record<EngineId, EngineId>;
const AUTONOMY = { ask: 'ask', auto: 'auto', full: 'full' } as const satisfies Record<Autonomy, Autonomy>;
const EFFORT = { '': '', minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' } as const satisfies Record<Effort | '', Effort | ''>;

const words = (field: string) => z.string({ error: `${field} must be text.` }).optional();
const names = (field: string) => z.array(z.string(), { error: `${field} must be a list.` }).optional();

/** What can be set on an agent; every field can be left out. */
const agentFields = {
  name: words('name'),
  emoji: words('emoji'),
  color: words('color'),
  specialty: words('specialty'),
  description: words('description'),
  systemPrompt: words('systemPrompt'),
  engine: z.enum(ENGINES, { error: 'Choose an engine: claude-code, eve, hermes, codex, pi, omp or openclaw.' }).optional(),
  model: words('model'),
  provider: words('provider'),
  claudeAuth: words('claudeAuth'),
  hermesProfile: words('hermesProfile'),
  openclawAgent: words('openclawAgent'),
  autonomy: z.enum(AUTONOMY, { error: 'Choose how freely it works: ask, auto or full.' }).optional(),
  toolGroups: names('toolGroups'),
  mcpServers: names('mcpServers'),
  knowledge: z.object({ folders: z.array(z.string()) }, { error: 'knowledge must list its folders.' }).optional(),
  workspace: words('workspace'),
  temperature: z.union([z.number(), z.literal('')], { error: 'temperature must be a number, or empty for the default.' }).optional(),
  // (anything else is the model's default, as it always was)
  effort: z.enum(EFFORT).catch('').optional(),
  alwaysAllow: names('alwaysAllow'),
  skills: names('skills'),
  richAnswers: z.boolean({ error: 'richAnswers must be true or false.' }).optional(),
  pinned: z.boolean({ error: 'pinned must be true or false.' }).optional(),
};
/** A change to an agent's fields (also what hiring one from the library may set first). */
export const agentPatch = z.object(agentFields);
/** A change to an agent, as the page sends it. */
export type AgentPatch = z.input<typeof agentPatch>;

const oneAgent = z.object({ id: z.string() });
const oneChat = oneAgent.extend({ chatId: z.string() });
// what you send: words, and files you attached (uploads of the project)
const message = {
  text: z.string({ error: 'Type a message first.' }).optional(),
  attachments: z.array(z.string(), { error: 'attachments must be a list.' }).optional(),
};
/** A message sent now ({ runId }), or put in the queue because the agent is working here ({ queued }). */
type Sent = { runId: string } | { queued: QueuedMessage };
const chatPath = '/agents/{id}/chats/{chatId}';

/** An agent's chats. Its run streams are still answered by server/index.ts (…/stream). */
const chats = {
  list: oc.route({ method: 'GET', path: '/agents/{id}/chats' }).input(oneAgent).output(type<ChatSummary[]>()),
  create: oc.route({ method: 'POST', path: '/agents/{id}/chats' }).input(oneAgent).output(type<Chat>()),
  /** With your /queue messages still waiting, and your /loop and /goal there. */
  get: oc.route({ method: 'GET', path: chatPath }).input(oneChat)
    .output(type<Chat & { queued: QueuedMessage[]; loop: LoopInfo | null; goal: BrainBrief | null }>()),
  remove: oc.route({ method: 'DELETE', path: chatPath }).input(oneChat).output(type<{ ok: true }>()),
  /** A new title, or reset: the agent starts fresh from your next message. */
  change: oc.route({ method: 'PUT', path: chatPath })
    .input(oneChat.extend({ title: z.string({ error: 'title must be text.' }).optional(), reset: z.boolean({ error: 'reset must be true or false.' }).optional() }))
    .output(type<Chat>()),
  /** Sends a message ("/queue …" waits until the agent is done here). */
  send: oc.route({ method: 'POST', path: `${chatPath}/messages` }).input(oneChat.extend(message)).output(type<Sent>()),
  /** /queue: a message that goes once the agent is done in this chat (now, if it isn't working). */
  queue: oc.route({ method: 'POST', path: `${chatPath}/queue` }).input(oneChat.extend(message)).output(type<Sent>()),
  /** A queued message taken back, its words changed (queued: null when it already went), or the order they go in. */
  unqueue: oc.route({ method: 'DELETE', path: `${chatPath}/queue/{queueId}` })
    .input(oneChat.extend({ queueId: z.string() }))
    .output(type<{ unqueued: QueuedMessage[] }>()),
  editQueued: oc.route({ method: 'PUT', path: `${chatPath}/queue/{queueId}` })
    .input(oneChat.extend({ queueId: z.string(), text: z.string({ error: 'Type the message.' }) }))
    .output(type<{ queued: QueuedMessage | null }>()),
  orderQueue: oc.route({ method: 'POST', path: `${chatPath}/queue/order` })
    .input(oneChat.extend({ ids: z.array(z.string(), { error: 'ids must be a list.' }) }))
    .output(type<{ queued: QueuedMessage[] }>()),
  /** /resend: your last message again. /resume: it carries on where its last turn was cut off. */
  resend: oc.route({ method: 'POST', path: `${chatPath}/resend` }).input(oneChat).output(type<Sent>()),
  resume: oc.route({ method: 'POST', path: `${chatPath}/resume` }).input(oneChat).output(type<{ resumed: true }>()),
  /** /loop: it keeps working on the words until you stop it ("off" ends it). */
  loop: oc.route({ method: 'POST', path: `${chatPath}/loop` }).input(oneChat.extend(message)).output(type<{ loop: LoopInfo | null }>()),
  stopLoop: oc.route({ method: 'DELETE', path: `${chatPath}/loop` }).input(oneChat).output(type<{ ok: boolean }>()),
  /** /learn: it turns what it did (and the files) into a skill or a change to one. */
  learn: oc.route({ method: 'POST', path: `${chatPath}/learn` }).input(oneChat.extend(message)).output(type<Sent>()),
  /** /goal: what done looks like; the Brain follows it up. clearGoal drops it. */
  goal: oc.route({ method: 'POST', path: `${chatPath}/goal` })
    .input(oneChat.extend({ text: z.string({ error: 'Say what done looks like.' }) }))
    .output(type<{ goal: BrainBrief | null }>()),
  clearGoal: oc.route({ method: 'DELETE', path: `${chatPath}/goal` }).input(oneChat).output(type<{ goal: BrainBrief | null }>()),
  /** How full its memory of this chat is. */
  memory: oc.route({ method: 'GET', path: `${chatPath}/memory` }).input(oneChat)
    .output(type<{ tokens: number; window: number; percent: number; estimated: boolean }>()),
  /** Stops its run: your /queue messages come back to you, and a loop ends. */
  stop: oc.route({ method: 'POST', path: `${chatPath}/stop` }).input(oneChat).output(type<{ ok: true; unqueued: QueuedMessage[] }>()),
};

export const agents = {
  list: oc.route({ method: 'GET', path: '/agents' }).output(type<Agent[]>()),
  /** A new agent; what isn't given comes from Settings › Defaults. source: where it came from (a library hire, a preset…). */
  create: oc.route({ method: 'POST', path: '/agents' })
    .input(z.object({
      ...agentFields,
      source: z.object({ type: z.string(), slug: z.string().optional(), division: z.string().optional(), preset: z.string().optional(), profile: z.string().optional() }, { error: 'source must say where the agent came from.' }).optional(),
    }))
    .output(type<Agent>()),
  get: oc.route({ method: 'GET', path: '/agents/{id}' }).input(oneAgent).output(type<AgentDetail>()),
  /** Changing its engine ends its sessions with the old one. */
  change: oc.route({ method: 'PUT', path: '/agents/{id}' }).input(oneAgent.extend(agentFields)).output(type<Agent>()),
  /** Deletes it, and takes it off every team. */
  remove: oc.route({ method: 'DELETE', path: '/agents/{id}' }).input(oneAgent).output(type<{ ok: true }>()),
  duplicate: oc.route({ method: 'POST', path: '/agents/{id}/duplicate' }).input(oneAgent).output(type<Agent>()),
  /** Writes it to ~/.claude/agents, so any Claude Code session can use it. */
  exportClaude: oc.route({ method: 'POST', path: '/agents/{id}/export-claude' }).input(oneAgent).output(type<{ file: string }>()),
  /** Opens its workspace folder in VS Code (app: 'vscode', which says how it went) or the file manager. */
  openWorkspace: oc.route({ method: 'POST', path: '/agents/{id}/open-workspace' })
    .input(oneAgent.extend({ app: z.string().optional() }))
    .output(type<{ message?: string; ok?: true }>()),
  /** Its harness's own / commands (a Claude Code agent's), for the / menu. */
  commands: oc.route({ method: 'GET', path: '/agents/{id}/commands' }).input(oneAgent).output(type<HarnessCommand[]>()),
  chats,
  /** What it knows: a file you write or add (name, content), a page saved from a link (url), or a linked folder. */
  knowledge: {
    add: oc.route({ method: 'POST', path: '/agents/{id}/knowledge' })
      .input(oneAgent.extend({ folder: z.string().optional(), url: z.string().optional(), name: z.string().optional(), content: z.string().optional() }))
      .output(type<{ ok?: true; file?: string }>()),
    /** Unlinks a folder, or removes a file by its label. */
    remove: oc.route({ method: 'DELETE', path: '/agents/{id}/knowledge' })
      .input(oneAgent.extend({ folder: z.string().optional(), label: z.string().optional() }))
      .output(type<{ ok: true }>()),
  },
};
