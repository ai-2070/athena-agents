// The Brain's own thinking: pick the right agent or branch for a message, design a new agent, or build a branch.
// Runs on the model you pick for it: Claude Code, OpenRouter, Hermes or Codex.
import fs from 'node:fs';
import { agents, workflows, getSecrets, getSettings } from './store.ts';
import { TOOL_GROUPS } from './tools.ts';
import { listServers } from './mcp.ts';
import { run, which, tmpFile } from './util.ts';
import type { Agent, BrainSetting, Team, TeamAccess } from '../shared/types.ts';

// ---------- what the models send back (JSON boundaries) ----------
interface OpenRouterChat {
  error?: { message?: string };
  choices?: { message?: { content?: string } }[];
}
interface CodexLine {
  type?: string;
  item?: { type?: string; text?: string };
  error?: { message?: string };
  message?: string;
}
interface HermesLine {
  type?: string;
  text?: string;
}
interface ClaudeResult {
  is_error?: boolean;
  result?: string;
}
/** An agent as the model describes it (any field may be missing or the wrong shape). */
interface AgentAnswer {
  name?: unknown;
  emoji?: unknown;
  specialty?: unknown;
  instructions?: unknown;
  systemPrompt?: unknown;
  tools?: string[];
  toolGroups?: string[];
  mcpServers?: string[];
}
interface RouteAnswer {
  kind?: string;
  id?: string;
  reason?: string;
}
interface BranchAnswer {
  name?: unknown;
  description?: unknown;
  lead?: unknown;
  access?: { tools?: string[]; mcpServers?: string[] };
  members?: { agentId?: string; newAgent?: AgentAnswer }[];
  steps?: { agentId?: string; newAgent?: AgentAnswer }[];
}

// ---------- what this file returns ----------
export interface BrainModel {
  provider: BrainSetting['provider'];
  model: string;
  fallback: boolean;
}
export type BrainRoute = { kind: 'none'; reason: string } | { kind: 'agent' | 'branch'; id: string; name: string; reason: string };
/** A new agent the Brain designed (not saved yet). */
export type AgentDraft = Pick<Agent, 'name' | 'emoji' | 'specialty' | 'systemPrompt' | 'toolGroups' | 'mcpServers' | 'engine'>;
export type BranchMember = { agentId: string; newAgent?: undefined } | { newAgent: AgentDraft; agentId?: undefined };
/** A team the Brain designed. leadIndex points into members (-1 = no lead). */
export interface BranchDesign {
  name: string;
  description: string;
  access: TeamAccess;
  members: BranchMember[];
  leadIndex: number;
}
export interface ThinkOptions {
  tools?: string;
  cwd?: string;
  timeout?: number;
  maxTokens?: number;
}

const GROUP_IDS = TOOL_GROUPS.map((g) => g.id);

// Which model the Brain uses (Settings > General > The Brain's model, or the chip in the Brain chat).
// Claude Code, OpenRouter, Hermes or Codex. Falls back to whatever is available.
export function brainModel(): BrainModel {
  const b: Partial<BrainSetting> = getSettings().brain || {};
  const key = !!getSecrets().openrouterKey;
  const ok: Record<BrainSetting['provider'], boolean> = { claude: !!which('claude'), openrouter: key, hermes: !!which('hermes'), codex: !!which('codex') };
  const p: BrainSetting['provider'] = ok[b.provider as BrainSetting['provider']] ? (b.provider as BrainSetting['provider']) : (['claude', 'openrouter', 'hermes', 'codex'] as const).find((x) => ok[x]) || b.provider || 'claude';
  const model = p === b.provider ? b.model ?? '' : '';
  const dflt = { claude: 'haiku', openrouter: 'anthropic/claude-haiku-5.5', hermes: '', codex: '' }[p];
  return { provider: p, model: model || dflt, fallback: p !== (b.provider || 'claude') };
}

// tools: read-only Claude Code tools (e.g. "Read,Glob,Grep") the Brain may use inside cwd.
// Codex reads the folder in a read-only sandbox instead.
export async function think(system: string, user: string, { tools = '', cwd, timeout = 90000, maxTokens = 2500 }: ThinkOptions = {}): Promise<string> {
  const key = getSecrets().openrouterKey;
  const bm = brainModel();
  if (bm.provider === 'openrouter' && key) {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'X-Title': 'My Dashboard' },
      body: JSON.stringify({ model: bm.model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: maxTokens }),
      signal: AbortSignal.timeout(timeout),
    });
    const j = (await r.json()) as OpenRouterChat;
    if (!r.ok) throw new Error(j.error?.message || `OpenRouter said ${r.status}`);
    return j.choices?.[0]?.message?.content || '';
  }
  if (bm.provider === 'codex') {
    const args = ['exec', '--json', '--skip-git-repo-check', '--ephemeral', '-s', 'read-only', ...(cwd ? ['-C', cwd] : []), ...(bm.model ? ['-m', bm.model] : []), '-'];
    const r = await run('codex', args, { input: `<instructions>\n${system}\n</instructions>\n\n${user}`, timeout, cwd });
    let answer = '';
    let err = '';
    for (const line of r.stdout.split('\n')) {
      if (!line.trim().startsWith('{')) continue;
      try {
        const ev = JSON.parse(line) as CodexLine;
        if (ev.type === 'item.completed' && ev.item?.type === 'agent_message') answer += (answer ? '\n\n' : '') + (ev.item.text || '');
        else if (ev.type === 'turn.failed') err = ev.error?.message || 'Codex failed.';
        else if (ev.type === 'error' && !/Reconnecting/.test(ev.message || '')) err = ev.message || err;
      } catch {
        /* not JSON */
      }
    }
    if (!answer) throw new Error(/login|auth|401/i.test(err + r.stderr) ? 'Codex is not signed in (Settings > General > OpenAI Codex > Sign in).' : `Codex didn't answer (${(err || r.stderr || '').trim().slice(-300)})`);
    return answer;
  }
  if (bm.provider === 'hermes') {
    const r = await run('hermes', ['chat', '--query-file', '-', '--format', 'stream-json', ...(bm.model ? ['-m', bm.model] : [])], { input: `${system}\n\n---\n\n${user}`, timeout, cwd, env: { PYTHONIOENCODING: 'utf-8' } });
    let text = '';
    let result: HermesLine | null = null;
    for (const line of r.stdout.split('\n')) {
      if (!line.trim().startsWith('{')) continue;
      try {
        const m = JSON.parse(line) as HermesLine;
        if (m.type === 'text' && m.text) text += m.text;
        else if (m.type === 'result') result = m;
      } catch {
        /* not JSON */
      }
    }
    const out = result?.text || text;
    if (!out) throw new Error(`Hermes didn't answer (${(r.stderr || '').trim().slice(-300)})`);
    return out;
  }
  if (!which('claude')) throw new Error('The Brain needs Claude Code, an OpenRouter key, Hermes or Codex.');
  const promptFile = tmpFile('brain-system.md');
  fs.writeFileSync(promptFile, system);
  const r = await run(
    'claude',
    ['-p', '--model', bm.model, '--output-format', 'json', '--no-session-persistence', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--tools', tools, ...(tools ? ['--allowedTools', ...tools.split(',')] : []), '--system-prompt-file', promptFile],
    { input: user, timeout, cwd },
  );
  fs.rm(promptFile, { force: true }, () => {});
  let out: ClaudeResult;
  try {
    out = JSON.parse(r.stdout) as ClaudeResult;
  } catch {
    throw new Error(`Claude Code didn't answer (${(r.stderr || r.stdout).trim().slice(-300)})`);
  }
  if (out.is_error) throw new Error(out.result || 'Claude Code reported an error');
  return out.result || '';
}

export function parseJSON<T>(text: unknown): T {
  const m = /\{[\s\S]*\}/.exec(String(text));
  if (!m) throw new Error('The answer was not JSON.');
  return JSON.parse(m[0]) as T;
}

const agentLine = (a: Agent) => `- id=${a.id} | ${a.name} | ${a.specialty || a.description || ''} | tools: ${(a.toolGroups || []).join(',')} | brain: ${a.engine}`;
const teamMembers = (w: Team): string[] => (Array.isArray(w.members) ? w.members : [...new Set((w.steps || []).filter((s) => s.type === 'agent').map((s) => s.agentId as string))]);
const branchLine = (w: Team, byId: Map<string, Agent>) =>
  `- id=${w.id} | ${w.name} | ${w.description || ''} | members: ${teamMembers(w).map((id) => `${byId.get(id)?.name || '?'}${w.lead === id ? ' (lead)' : ''}`).join(', ')}`;

const TOOLS_TEXT = TOOL_GROUPS.map((g) => `${g.id}: ${g.description}`).join('\n');

// ---------- Auto: who should handle this? ----------
export async function route(text: string): Promise<BrainRoute> {
  const all = agents.list();
  const wfs = workflows.list().filter((w) => teamMembers(w).length);
  if (!all.length) return { kind: 'none', reason: 'You have no agents yet.' };
  const byId = new Map(all.map((a) => [a.id, a]));
  const system = `You route a user's request to ONE of their existing agents or teams (a team is a group chat of agents with a shared goal; in the JSON a team is kind "branch").
Pick a team only when the request clearly matches what the whole team does; otherwise pick the single best agent.
If nothing fits at all, answer kind "none".
Answer with JSON only: {"kind":"agent"|"branch"|"none","id":"<id>","reason":"<max 12 words>"}`;
  const user = `Agents:\n${all.map(agentLine).join('\n')}\n\nTeams (kind "branch"):\n${wfs.map((w) => branchLine(w, byId)).join('\n') || '(none)'}\n\nRequest:\n${text}`;
  const j = parseJSON<RouteAnswer>(await think(system, user));
  if (j.kind === 'agent' && byId.has(j.id as string)) return { kind: 'agent', id: j.id as string, name: byId.get(j.id as string)!.name, reason: j.reason || '' };
  if (j.kind === 'branch' && wfs.some((w) => w.id === j.id)) return { kind: 'branch', id: j.id as string, name: wfs.find((w) => w.id === j.id)!.name, reason: j.reason || '' };
  return { kind: 'none', reason: j.reason || 'No good match.' };
}

// ---------- New agent ----------
function cleanAgent(j: AgentAnswer): AgentDraft {
  return {
    name: String(j.name || 'New agent').slice(0, 40),
    emoji: String(j.emoji || '🤖').slice(0, 4),
    specialty: String(j.specialty || '').slice(0, 140),
    systemPrompt: String(j.instructions || j.systemPrompt || '').slice(0, 8000),
    toolGroups: (Array.isArray(j.tools) ? j.tools : j.toolGroups || []).filter((t) => GROUP_IDS.includes(t)),
    mcpServers: (Array.isArray(j.mcpServers) ? j.mcpServers : []).filter((m) => m in listServers()),
    engine: 'claude-code',
  };
}

const AGENT_SCHEMA = `{"name":"short role name","emoji":"one emoji","specialty":"one line: what it is good at","instructions":"how it works: process, rules, what good output looks like (5-12 sentences, second person)","tools":["tool group ids"],"mcpServers":["names"]}`;

export async function designAgent(text: string): Promise<AgentDraft> {
  const system = `You design one AI agent for the user's personal dashboard from their description.
Available tool groups (use only these ids, only what the job needs):
${TOOLS_TEXT}
Available MCP servers: ${Object.keys(listServers()).join(', ') || '(none)'}
Rules: posts and DMs always wait for the user's approval; never invent facts or numbers.
Answer with JSON only: ${AGENT_SCHEMA}`;
  return cleanAgent(parseJSON<AgentAnswer>(await think(system, text)));
}

// ---------- New branch ----------
// A team is a group chat of agents: pick members (existing first) and a lead who coordinates.
export async function designBranch(text: string, { allowNew = true }: { allowNew?: boolean } = {}): Promise<BranchDesign> {
  const all = agents.list();
  const byId = new Map(all.map((a) => [a.id, a]));
  const system = `You put together a team for the user's personal dashboard. A team is a group chat of 2-6 AI agents who share one goal: the user writes in the chat, a lead coordinates, and agents hand work to each other by @mentioning a teammate.
Use the user's existing agents wherever they fit.${allowNew ? ' If an essential role is missing, add a new agent for it (at most 2 new agents).' : ' Use ONLY existing agents.'}
Pick a lead only when 3 or more agents need coordinating (a planner/chief-of-staff type if available).
Tool groups for the team's "access" (ids only): ${GROUP_IDS.join(', ')}
MCP servers: ${Object.keys(listServers()).join(', ') || '(none)'}
Answer with JSON only:
{"name":"short name","description":"one sentence: the team's shared goal","lead":"<existing agent id, or the 'name' of a new agent, or empty>","access":{"tools":["ids"],"mcpServers":["names"]},
 "members":[{"agentId":"<existing id>"} | {"newAgent":${AGENT_SCHEMA}}]}`;
  const user = `Existing agents:\n${all.map(agentLine).join('\n') || '(none)'}\n\nWhat the team should do:\n${text}`;
  const j = parseJSON<BranchAnswer>(await think(system, user));
  const members: BranchMember[] = [];
  for (const m of j.members || j.steps || []) {
    if (m.agentId && byId.has(m.agentId) && !members.some((x) => x.agentId === m.agentId)) members.push({ agentId: m.agentId });
    else if (m.newAgent && allowNew) members.push({ newAgent: cleanAgent(m.newAgent) });
  }
  const leadKey = String(j.lead || '');
  const leadIndex = members.findIndex((m) => m.agentId === leadKey || (m.newAgent && m.newAgent.name.toLowerCase() === leadKey.toLowerCase()));
  return {
    name: String(j.name || 'New team').slice(0, 50),
    description: String(j.description || '').slice(0, 300),
    access: { toolGroups: (j.access?.tools || []).filter((t) => GROUP_IDS.includes(t)), mcpServers: (j.access?.mcpServers || []).filter((m) => m in listServers()) },
    members,
    leadIndex,
  };
}

// In a team without a lead: which member should answer this message?
export async function pickMember(text: string, members: (Agent | null | undefined)[]): Promise<string | null> {
  const list = members.filter((a): a is Agent => Boolean(a));
  if (list.length <= 1) return list[0]?.id || null;
  const system = 'Pick the ONE team member best suited to handle the message. Answer with JSON only: {"id":"<member id>"}';
  const user = `Members:\n${list.map(agentLine).join('\n')}\n\nMessage:\n${text}`;
  const j = parseJSON<{ id?: string }>(await think(system, user));
  return list.some((a) => a.id === j.id) ? (j.id as string) : null;
}
