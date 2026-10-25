// The Brain's own thinking: pick the right agent or branch for a message, design a new agent, or build a branch.
// Uses a small, fast model with no tools: OpenRouter if you have a key, otherwise Claude Code (Haiku).
import fs from 'node:fs';
import { agents, workflows, getSecrets } from './store.js';
import { TOOL_GROUPS } from './tools.js';
import { listServers } from './mcp.js';
import { run, which, tmpFile } from './util.js';

const GROUP_IDS = TOOL_GROUPS.map((g) => g.id);

async function think(system, user) {
  const key = getSecrets().openrouterKey;
  if (key) {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'X-Title': 'My Dashboard' },
      body: JSON.stringify({ model: 'anthropic/claude-haiku-5.5', messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: 2500 }),
      signal: AbortSignal.timeout(60000),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error?.message || `OpenRouter said ${r.status}`);
    return j.choices?.[0]?.message?.content || '';
  }
  if (!which('claude')) throw new Error('Auto needs Claude Code or an OpenRouter key.');
  const promptFile = tmpFile('brain-system.md');
  fs.writeFileSync(promptFile, system);
  const r = await run(
    'claude',
    ['-p', '--model', 'haiku', '--output-format', 'json', '--no-session-persistence', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--tools', '', '--system-prompt-file', promptFile],
    { input: user, timeout: 90000 },
  );
  fs.rm(promptFile, { force: true }, () => {});
  let out;
  try {
    out = JSON.parse(r.stdout);
  } catch {
    throw new Error(`Claude Code didn't answer (${(r.stderr || r.stdout).trim().slice(-300)})`);
  }
  if (out.is_error) throw new Error(out.result || 'Claude Code reported an error');
  return out.result || '';
}

function parseJSON(text) {
  const m = /\{[\s\S]*\}/.exec(String(text));
  if (!m) throw new Error('The answer was not JSON.');
  return JSON.parse(m[0]);
}

const agentLine = (a) => `- id=${a.id} | ${a.name} | ${a.specialty || a.description || ''} | tools: ${(a.toolGroups || []).join(',')} | brain: ${a.engine}`;
const branchLine = (w, byId) =>
  `- id=${w.id} | ${w.name} | ${w.description || ''} | steps: ${w.steps.map((s) => (s.type === 'agent' ? byId.get(s.agentId)?.name || '?' : s.type)).join(' -> ')}`;

const TOOLS_TEXT = TOOL_GROUPS.map((g) => `${g.id}: ${g.description}`).join('\n');

// ---------- Auto: who should handle this? ----------
export async function route(text) {
  const all = agents.list();
  const wfs = workflows.list().filter((w) => w.steps.length);
  if (!all.length) return { kind: 'none', reason: 'You have no agents yet.' };
  const byId = new Map(all.map((a) => [a.id, a]));
  const system = `You route a user's request to ONE of their existing agents or teams (a team is a multi-step workflow whose agents run in order; in the JSON a team is kind "branch").
Pick a team only when the request clearly matches what the whole team does; otherwise pick the single best agent.
If nothing fits at all, answer kind "none".
Answer with JSON only: {"kind":"agent"|"branch"|"none","id":"<id>","reason":"<max 12 words>"}`;
  const user = `Agents:\n${all.map(agentLine).join('\n')}\n\nTeams (kind "branch"):\n${wfs.map((w) => branchLine(w, byId)).join('\n') || '(none)'}\n\nRequest:\n${text}`;
  const j = parseJSON(await think(system, user));
  if (j.kind === 'agent' && byId.has(j.id)) return { kind: 'agent', id: j.id, name: byId.get(j.id).name, reason: j.reason || '' };
  if (j.kind === 'branch' && wfs.some((w) => w.id === j.id)) return { kind: 'branch', id: j.id, name: wfs.find((w) => w.id === j.id).name, reason: j.reason || '' };
  return { kind: 'none', reason: j.reason || 'No good match.' };
}

// ---------- New agent ----------
function cleanAgent(j) {
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

export async function designAgent(text) {
  const system = `You design one AI agent for the user's personal dashboard from their description.
Available tool groups (use only these ids, only what the job needs):
${TOOLS_TEXT}
Available MCP servers: ${Object.keys(listServers()).join(', ') || '(none)'}
Rules: posts and DMs always wait for the user's approval; never invent facts or numbers.
Answer with JSON only: ${AGENT_SCHEMA}`;
  return cleanAgent(parseJSON(await think(system, text)));
}

// ---------- New branch ----------
export async function designBranch(text, { allowNew = true } = {}) {
  const all = agents.list();
  const byId = new Map(all.map((a) => [a.id, a]));
  const system = `You build a team for the user's personal dashboard: a workflow whose agents run in order, each agent getting the previous step's result.
Use the user's existing agents wherever they fit.${allowNew ? ' If an essential role is missing, add a new agent for it (at most 2 new agents).' : ' Use ONLY existing agents.'}
Prompts can use {{input}} (what the user gives when running) and {{prev}} (result of the step before). Step 1 normally uses {{input}}.
Add a final "approval" step before anything is posted or sent.
Tool groups for the team's "access" (ids only): ${GROUP_IDS.join(', ')}
MCP servers: ${Object.keys(listServers()).join(', ') || '(none)'}
Answer with JSON only:
{"name":"short name","description":"one sentence: what this team does","access":{"tools":["ids"],"mcpServers":["names"]},
 "steps":[{"type":"agent","agentId":"<existing id>","label":"short","prompt":"..."} | {"type":"agent","newAgent":${AGENT_SCHEMA},"label":"short","prompt":"..."} | {"type":"approval","label":"short","message":"{{prev}}"} | {"type":"x_post","label":"short","text":"{{prev}}"} | {"type":"notify","label":"short","text":"..."}]}`;
  const user = `Existing agents:\n${all.map(agentLine).join('\n') || '(none)'}\n\nWhat the team should do:\n${text}`;
  const j = parseJSON(await think(system, user));
  const steps = [];
  for (const s of j.steps || []) {
    if (s.type === 'agent' && s.agentId && byId.has(s.agentId)) steps.push({ type: 'agent', agentId: s.agentId, label: String(s.label || '').slice(0, 40), prompt: String(s.prompt || '{{prev}}') });
    else if (s.type === 'agent' && s.newAgent && allowNew) steps.push({ type: 'agent', newAgent: cleanAgent(s.newAgent), label: String(s.label || '').slice(0, 40), prompt: String(s.prompt || '{{prev}}') });
    else if (['approval', 'x_post', 'notify'].includes(s.type)) steps.push({ type: s.type, label: String(s.label || '').slice(0, 40), message: s.message, text: s.text || '{{prev}}' });
  }
  return {
    name: String(j.name || 'New team').slice(0, 50),
    description: String(j.description || '').slice(0, 300),
    access: { toolGroups: (j.access?.tools || []).filter((t) => GROUP_IDS.includes(t)), mcpServers: (j.access?.mcpServers || []).filter((m) => m in listServers()) },
    steps,
  };
}
