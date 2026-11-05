// The agents' routes (server/api/agents.ts): the list, making, changing, copying and deleting an agent, its
// knowledge, its workspace and its harness's / commands. Also answered under /api/p/<project> for a project
// that isn't open (an Overview pane's).
import { oc, type } from '@orpc/contract';
import { z } from 'zod';
import type { Effort } from '../effort.ts';
import type { Agent, AgentDetail, Autonomy, EngineId, HarnessCommand } from '../types.ts';

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
const agentPatch = z.object(agentFields);
/** A change to an agent, as the page sends it. */
export type AgentPatch = z.input<typeof agentPatch>;

const oneAgent = z.object({ id: z.string() });

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
