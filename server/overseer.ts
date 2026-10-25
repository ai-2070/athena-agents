// The Brain as overseer: it sees the whole project (folder, notes, Git), every agent and team,
// what each one is doing right now and what waits for you. It answers questions itself and
// hands real work to the best agent or team.
import fs from 'node:fs';
import path from 'node:path';
import { agents, workflows, activeProject, getSettings, outbox, activity, log, emit } from './store.ts';
import { agencyAgents, hireFromAgency, createStarter, newAgent, STARTERS } from './library.ts';
import { TOOL_GROUPS } from './tools.ts';
import { listServers } from './mcp.ts';
import { ensureBrain, brainInfo } from './projects.ts';
import { listTeams, teamState, getThread, getTeam, teamSteps } from './teams.ts';
import { liveActivity, defaultModel } from './engines/index.ts';
import { listApprovals } from './approvals.ts';
import { think, brainModel } from './brain.ts';
import { readJSON, writeJSON, run, dataPath } from './util.ts';
import type { Agent, BrainAnswer, BrainDelegate, BrainDone, Project, Team } from '../shared/types.ts';

/** One line of the Brain chat history (data/projects/<id>/brain-chat.json). */
export interface BrainChatMessage {
  role: 'user' | 'brain';
  text: string;
  ts: number;
}

/** A new agent the Brain invents in an action (any field may be missing). */
interface NewAgentRef {
  name?: unknown;
  emoji?: unknown;
  specialty?: unknown;
  instructions?: unknown;
  systemPrompt?: unknown;
  tools?: unknown;
}
/** MEMBER in the Brain's actions: an existing agent, a library slug, a starter or a new agent. */
interface MemberRef {
  agent?: string;
  agentId?: string;
  library?: string;
  starter?: string;
  new?: NewAgentRef;
}
/** One action the Brain asked for, as parsed from its answer (nothing is guaranteed). */
export interface BrainAction {
  do?: string;
  action?: string;
  name?: unknown;
  description?: unknown;
  members?: (MemberRef | string)[];
  agents?: (MemberRef | string)[];
  lead?: MemberRef | string | null;
  access?: { tools?: unknown; toolGroups?: unknown; mcpServers?: unknown };
  team?: string;
  content?: unknown;
  to?: string;
  id?: string;
  message?: unknown;
}

const SKIP = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.venv', '__pycache__', '.cache', '.claude']);
const TEXT = /\.(md|txt|json|ya?ml|toml|csv|js|ts|py|html|css)$/i;
const HISTORY_KEEP = 24;

const ago = (ts: number | null | undefined) => {
  if (!ts) return '';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};
const cut = (t: unknown, n: number) => {
  const s = String(t || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

// The project folder as an indented tree (2 levels, capped).
function tree(root: string, max = 220): string {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (out.length >= max) return;
    let list: fs.Dirent[] = [];
    try {
      list = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    list.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const e of list) {
      if (out.length >= max) return out.push(`${'  '.repeat(depth)}…`);
      if (SKIP.has(e.name) || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        let n = 0;
        try {
          n = fs.readdirSync(full).length;
        } catch {
          /* unreadable */
        }
        out.push(`${'  '.repeat(depth)}${e.name}/ (${n})`);
        if (depth < 1) walk(full, depth + 1);
      } else {
        let size = 0;
        let mtime = 0;
        try {
          const st = fs.statSync(full);
          size = st.size;
          mtime = st.mtimeMs;
        } catch {
          /* gone */
        }
        out.push(`${'  '.repeat(depth)}${e.name} (${size < 1024 ? `${size} B` : `${Math.round(size / 1024)} KB`}, changed ${ago(mtime)})`);
      }
    }
  };
  walk(root, 0);
  return out.join('\n');
}

// The key text files at the top of the folder (BRAIN.md, README, notes…), up to a budget.
function keyFiles(root: string, budget: number): string {
  const picked: string[] = [];
  let left = budget;
  const prefer = (n: string) => (/^project\.md$/i.test(n) ? 0 : /^brain\.md$/i.test(n) ? 1 : /^readme/i.test(n) ? 2 : /^claude\.md$/i.test(n) ? 3 : 4);
  let list: { name: string; isFile: () => boolean }[] = [];
  try {
    list = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isFile() && TEXT.test(e.name));
  } catch {
    return '';
  }
  const notesDir = path.join(root, 'notes');
  try {
    for (const n of fs.readdirSync(notesDir)) if (/\.md$/i.test(n)) list.push({ name: path.join('notes', n), isFile: () => true });
  } catch {
    /* no notes */
  }
  list.sort((a, b) => prefer(a.name) - prefer(b.name) || a.name.localeCompare(b.name));
  for (const e of list) {
    if (left < 400) break;
    let t = '';
    try {
      t = fs.readFileSync(path.join(root, e.name), 'utf8');
    } catch {
      continue;
    }
    const part = t.slice(0, Math.min(left, 6000));
    picked.push(`--- ${e.name}${t.length > part.length ? ' (start)' : ''} ---\n${part}`);
    left -= part.length;
  }
  return picked.join('\n\n');
}

const modelOf = (a: Agent) => a.model || defaultModel(a.engine) || a.lastModel || 'default';

// Everything the Brain knows right now, as text.
export async function snapshot({ fileBudget = 9000 }: { fileBudget?: number } = {}): Promise<string> {
  const p = activeProject();
  const root = ensureBrain(p);
  const info = await brainInfo(p).catch(() => null);
  let commits = '';
  if (info?.git) commits = (await run('git', ['-C', root, 'log', '-6', '--format=%h %s (%cr)'], { timeout: 10000 })).stdout.trim();

  const all = agents.list();
  const byId = new Map(all.map((a) => [a.id, a]));
  const live = liveActivity();
  const teams = listTeams();
  const teamOf = new Map<string, string[]>();
  for (const t of teams) for (const id of t.members) teamOf.set(id, [...(teamOf.get(id) || []), t.name]);

  const agentLines = all.map((a) => {
    const runs = live.filter((r) => r.agentId === a.id);
    const now = runs.length
      ? runs
          .map((r) => `WORKING ${r.seconds}s on "${cut(r.task, 140)}"${r.tool ? `, now using ${r.tool.name}${r.tool.status === 'running' ? ' (running)' : ''}` : ''}${r.saying ? `, last said: "${cut(r.saying, 120)}"` : ''}`)
          .join(' | ')
      : 'idle';
    return `- id=${a.id} | ${a.emoji || ''} ${a.name} | ${a.specialty || a.description || ''} | runs on ${a.engine} (${modelOf(a)}) | tools: ${(a.toolGroups || []).join(',') || 'none'} | autonomy: ${a.autonomy || 'ask'} | teams: ${(teamOf.get(a.id) || []).join(', ') || 'none (on the bench)'} | NOW: ${now}`;
  });

  const teamLines = teams.map((t) => {
    const st = teamState(t.id);
    const thread = getThread(t.id, 4).messages;
    const name = (id: string) => (id === 'user' ? 'You' : byId.get(id)?.name || id);
    const sched = t.schedule && t.schedule.type !== 'none' ? ` | routine: ${t.schedule.type} ${t.schedule.time || ''}${t.enabled === false ? ' (off)' : ''}` : '';
    return [
      `- id=${t.id} | ${t.name} | goal: ${t.description || '-'} | members: ${t.members.map((id) => `${name(id)}${t.lead === id ? ' (lead)' : ''}`).join(', ') || 'none'}${sched}`,
      `  NOW: ${st.working.length ? `working: ${st.working.map(name).join(', ')}` : 'quiet'}${st.queued.length ? ` | queued: ${st.queued.map(name).join(', ')}` : ''}`,
      ...thread.map((m) => `  [${ago(m.ts)}] ${name(m.from)}: ${cut(m.text, 160)}`),
    ].join('\n');
  });

  const approvals = listApprovals();
  const pendingPosts = outbox.list().filter((x) => x.status === 'pending');
  const recent = activity(25)
    .filter((e) => e.kind !== 'terminal')
    .map((e) => `- ${ago(e.ts)}: ${cut(e.text, 160)}`);

  return [
    `NOW: ${new Date().toLocaleString()}`,
    `PROJECT: ${p.name} (id ${p.id})`,
    p.description ? `What the user said the project is: ${p.description}` : 'The user has not described the project yet.',
    `Project folder (the Brain folder, every agent's default workspace): ${root}`,
    info ? `Size: ${info.files} files, ${info.sizeMB} MB` : '',
    info?.git ? `GitHub/Git: ${info.git.url || info.git.remote || 'local repo'} | branch ${info.git.branch} | ${info.git.changes} uncommitted changes\nRecent commits:\n${commits}` : 'Git: not a Git repo',
    `\nFOLDER TREE:\n${tree(root) || '(empty)'}`,
    fileBudget ? `\nKEY FILES:\n${keyFiles(root, fileBudget) || '(none)'}` : '',
    `\nAGENTS (${all.length}, ${live.length} running now):\n${agentLines.join('\n') || '(none)'}`,
    `\nTEAMS (${teams.length}; a team is a group chat of agents with a shared goal):\n${teamLines.join('\n') || '(none)'}`,
    `\nWAITING FOR THE USER: ${approvals.length} approval(s)${approvals.length ? `: ${approvals.map((x) => `${x.agentName || 'agent'} wants "${cut(x.title, 80)}"`).join('; ')}` : ''} | ${pendingPosts.length} post(s) in the Outbox${pendingPosts.length ? `: ${pendingPosts.map((x) => `${x.platform}: "${cut((x.parts || [x.text]).join(' '), 70)}"`).join('; ')}` : ''}`,
    `\nRECENT ACTIVITY:\n${recent.join('\n') || '(nothing yet)'}`,
  ]
    .filter(Boolean)
    .join('\n');
}

// ---------- conversation with the Brain ----------
// pid: the project whose chat it is (the active one by default)
const histFile = (pid = activeProject().id) => dataPath('projects', pid, 'brain-chat.json');
export function history(pid?: string): BrainChatMessage[] {
  return readJSON<{ messages: BrainChatMessage[] }>(histFile(pid), { messages: [] }).messages;
}
function remember(msgs: BrainChatMessage[], pid?: string) {
  writeJSON(histFile(pid), { messages: msgs.slice(-HISTORY_KEEP) });
  emit('brain-chat');
}
export function clearHistory() {
  remember([]);
}

const GROUP_IDS = TOOL_GROUPS.map((g) => g.id);
const PALETTE = ['#3d58c0', '#b0508a', '#c07a34', '#3a8a7a', '#7350c8', '#b8a03a', '#4f7fa8', '#5a9a3a', '#a84a5a', '#2f8fa0'];

// The library the Brain can hire from (compact: slug | name).
function catalog() {
  const lib = agencyAgents().map((a) => `${a.slug} | ${a.name}`);
  return `LIBRARY (The Agency, hire with {"library":"<slug>"}):\n${lib.join('\n') || '(not downloaded)'}\n\nSTARTERS (hire with {"starter":"<name>"}):\n${STARTERS.map((x) => `${x.name} | ${x.specialty}`).join('\n')}`;
}

const SYSTEM = (projectName: string, canRead: boolean) => `You are the Brain: the overseer of the user's project "${projectName}" in their personal AI agent dashboard (local, only for them).
You see everything in the SNAPSHOT: the project folder and its files, Git, every agent and team, what each is doing right now, and what waits for the user. You also run the roster: you build teams, hire agents from the library, and hand out work.

Kinds of request:
1. A question (about the project, its files, progress, who is doing what, what is stuck, what next): just answer it.${canRead ? ' You can open files in the project folder with Read, Glob and Grep (you work inside it) when the answer needs what is in a file. Never change files yourself (PROJECT.md goes through the write_project_md action).' : ''}
2. Change the roster: create a team, add or remove agents, change a team's goal, lead or access, hire an agent. Do it with actions.
3. Set up a project (the user just created it, or asks you to set it up): study the folder and its key files, then ask the user up to 5 short, numbered, specific questions you need answered (goals, audience, deliverables, style and voice, accounts and programs, deadlines). Ask, don't build, until you know enough. Once you do: write PROJECT.md with write_project_md and create the teams and agents the project needs, then tell the user what you set up and what each team will do. Keep PROJECT.md up to date whenever the user tells you something new about the project.
4. Work to be done (make, write, research, draft a post or DM, edit a video, generate images, fix code…): never do it yourself. Delegate it to the best existing team or agent. If nothing fits, build what's needed first (a team or an agent) and then delegate to it in the same answer.

A team is a group chat of 2-6 agents with a shared goal. A lead (planner type) coordinates when there are 3+ members; members hand work to each other by @mentioning. Prefer agents the user already has; otherwise hire from the LIBRARY (pick the slugs that match best); only invent a new agent when nothing in the library fits.

Answer format: a short reply in markdown (a few sentences or a tight list, names not ids, calm chief-of-staff tone). If you take actions, end with ONE fenced block:
\`\`\`actions
[ ...actions in order... ]
\`\`\`
Actions (JSON, ids exactly as in the snapshot or library):
{"do":"create_team","name":"…","description":"the shared goal, one sentence","members":[MEMBER,…],"lead":MEMBER-or-null,"access":{"tools":["tool group ids"],"mcpServers":["names"]}}
{"do":"add_members","team":"<team id or 'new'>","members":[MEMBER,…]}
{"do":"remove_members","team":"<team id>","agents":["<agent id>",…]}
{"do":"update_team","team":"<team id>","name":"…","description":"…","lead":"<agent id>","access":{"tools":[…],"mcpServers":[…]}}   (only the fields that change)
{"do":"hire","members":[MEMBER,…]}   (agents on the bench, no team)
{"do":"write_project_md","content":"the whole PROJECT.md in markdown"}   (the project brief every agent reads: what it is, goals, audience, deliverables, voice and style, accounts and programs, the teams and who does what, open questions)
{"do":"delegate","to":"team"|"agent","id":"<id, or 'new' for the team/agent created just before>","message":"a clear brief with the context from the snapshot they need"}
MEMBER is {"agent":"<existing agent id>"} or {"library":"<slug>"} or {"starter":"<name>"} or {"new":{"name":"…","emoji":"…","specialty":"one line","instructions":"5-10 sentences, second person","tools":["ids"]}}
Tool group ids: ${GROUP_IDS.join(', ')}
MCP servers: ${Object.keys(listServers()).join(', ') || '(none)'}

Rules: at most one delegate per answer. Never delete agents or teams (removing from a team is fine). Posts and DMs always wait for the user's approval in the Outbox. Say "nobody is working right now" when that's true. Never invent status, files or numbers.`;

export function parseActions(text: string): { answer: string; actions: BrainAction[] } {
  const m = /```actions\s*([\s\S]*?)```/i.exec(text);
  if (!m) return { answer: text.trim(), actions: [] };
  let actions: BrainAction[] = [];
  try {
    const j: unknown = JSON.parse(m[1].trim());
    actions = (Array.isArray(j) ? j : [j]) as BrainAction[];
  } catch {
    const arr = /\[[\s\S]*\]/.exec(m[1]);
    try {
      actions = arr ? (JSON.parse(arr[0]) as BrainAction[]) : [];
    } catch {
      actions = [];
    }
  }
  return { answer: (text.slice(0, m.index) + text.slice(m.index + m[0].length)).replace(/\n{3,}/g, '\n\n').trim(), actions };
}

const cleanTools = (t: unknown): string[] => (Array.isArray(t) ? (t as unknown[]) : []).filter((x): x is string => GROUP_IDS.includes(x as string));
const cleanMcp = (t: unknown): string[] => (Array.isArray(t) ? (t as unknown[]) : []).filter((x): x is string => (x as string) in listServers());

// Run the Brain's actions in project p. Returns what happened, plus a delegate for the chat to send.
export function applyActions(actions: BrainAction[], p: Project = activeProject()): { done: BrainDone[]; delegate: BrainDelegate | null } {
  const done: BrainDone[] = [];
  let delegate: BrainDelegate | null = null;
  let lastTeam: string | null = null;
  let lastAgent: string | null = null;
  const findTeam = (ref: string | null | undefined): Team | null => {
    if (!ref) return null;
    // normalized: an old step list gets its members from its agent steps
    if (ref === 'new') return lastTeam ? getTeam(lastTeam) : null;
    return getTeam(ref) || listTeams().find((w) => w.name.toLowerCase() === String(ref).toLowerCase()) || null;
  };
  // MEMBER -> agent id (reuses an agent already hired from the same library entry)
  const resolve = (m: MemberRef | string | null | undefined): string | null => {
    if (!m) return null;
    if (typeof m === 'string') m = agents.get(m) ? { agent: m } : { library: m };
    if (m.agent || m.agentId) {
      const a = agents.get(m.agent || m.agentId);
      return a ? a.id : null;
    }
    if (m.library) {
      const have = agents.list().find((a) => a.source?.type === 'agency' && a.source.slug === m.library);
      if (have) return have.id;
      if (!agencyAgents().some((x) => x.slug === m.library)) return null;
      const a = hireFromAgency(m.library);
      done.push({ kind: 'hired', text: `Hired ${a.emoji || ''} ${a.name} from the library`, agentId: a.id });
      return a.id;
    }
    if (m.starter) {
      const st = STARTERS.find((x) => x.name.toLowerCase() === String(m.starter).toLowerCase());
      if (!st) return null;
      const have = agents.list().find((a) => a.source?.type === 'starter' && a.name === st.name);
      if (have) return have.id;
      const a = createStarter(st.name);
      done.push({ kind: 'hired', text: `Added ${a.emoji || ''} ${a.name}`, agentId: a.id });
      return a.id;
    }
    if (m.new) {
      const n = m.new;
      const a = newAgent({
        name: String(n.name || 'New agent').slice(0, 40),
        emoji: String(n.emoji || '🤖').slice(0, 4),
        specialty: String(n.specialty || '').slice(0, 140),
        systemPrompt: String(n.instructions || n.systemPrompt || '').slice(0, 8000),
        toolGroups: cleanTools(n.tools).length ? cleanTools(n.tools) : undefined,
        engine: 'claude-code',
        source: { type: 'brain' },
      });
      done.push({ kind: 'hired', text: `Created a new agent: ${a.emoji || ''} ${a.name}`, agentId: a.id });
      return a.id;
    }
    return null;
  };
  const resolveAll = (list: unknown): string[] => [...new Set((Array.isArray(list) ? (list as (MemberRef | string)[]) : []).map((m) => {
    try {
      return resolve(m);
    } catch (e) {
      done.push({ kind: 'error', text: `Couldn't add an agent: ${(e as Error).message}` });
      return null;
    }
  }).filter((id): id is string => Boolean(id)))];
  // a step list keeps its other steps (tools, approvals, posts)
  const saveTeam = (wf: Partial<Team> & { members: string[] }): Team => workflows.save({ ...wf, steps: teamSteps({ steps: wf.steps || [], members: wf.members }) });

  for (const act of actions.slice(0, 12)) {
    try {
      const kind = act?.do || act?.action;
      if (kind === 'create_team') {
        const members = resolveAll(act.members);
        let lead = act.lead ? resolveAll([act.lead])[0] || null : null;
        if (lead && !members.includes(lead)) members.unshift(lead);
        if (!members.length) throw new Error('no agents to put on it');
        const wf = saveTeam({
          name: String(act.name || 'New team').slice(0, 50),
          description: String(act.description || '').slice(0, 300),
          members,
          lead: members.length > 1 ? lead : null,
          access: { toolGroups: cleanTools(act.access?.tools || act.access?.toolGroups), mcpServers: cleanMcp(act.access?.mcpServers) },
          color: PALETTE[Math.floor(Math.random() * PALETTE.length)],
          schedule: { type: 'none' },
          enabled: false,
          createdBy: 'brain',
        });
        lastTeam = wf.id;
        log('team', `The Brain built the team "${wf.name}" (${members.length} agents)`);
        done.push({ kind: 'team', text: `Built the team "${wf.name}" with ${members.map((id) => agents.get(id)?.name).join(', ')}${wf.lead ? ` (lead: ${agents.get(wf.lead)?.name})` : ''}`, teamId: wf.id });
      } else if (kind === 'add_members') {
        const wf = findTeam(act.team);
        if (!wf) throw new Error('team not found');
        const add = resolveAll(act.members).filter((id) => !(wf.members || []).includes(id));
        wf.members = [...(wf.members || []), ...add];
        saveTeam(wf);
        lastTeam = wf.id;
        if (add.length) log('team', `The Brain added ${add.map((id) => agents.get(id)?.name).join(', ')} to "${wf.name}"`);
        done.push({ kind: 'team', text: add.length ? `Added ${add.map((id) => agents.get(id)?.name).join(', ')} to "${wf.name}"` : `Everyone asked for is already on "${wf.name}"`, teamId: wf.id });
      } else if (kind === 'remove_members') {
        const wf = findTeam(act.team);
        if (!wf) throw new Error('team not found');
        const out = (act.agents || act.members || []).map((x) => (typeof x === 'string' ? x : x.agent || x.agentId)).filter((id): id is string => (wf.members || []).includes(id as string));
        wf.members = (wf.members || []).filter((id) => !out.includes(id));
        if (out.includes(wf.lead as string)) wf.lead = null;
        saveTeam(wf);
        if (out.length) log('team', `The Brain took ${out.map((id) => agents.get(id)?.name).join(', ')} off "${wf.name}"`);
        done.push({ kind: 'team', text: out.length ? `Took ${out.map((id) => agents.get(id)?.name).join(', ')} off "${wf.name}" (they stay on the bench)` : 'Nobody to remove', teamId: wf.id });
      } else if (kind === 'update_team') {
        const wf = findTeam(act.team);
        if (!wf) throw new Error('team not found');
        const changed: string[] = [];
        if (act.name) (wf.name = String(act.name).slice(0, 50)), changed.push('name');
        if (act.description) (wf.description = String(act.description).slice(0, 300)), changed.push('goal');
        if (act.lead !== undefined) {
          const lead = act.lead ? resolveAll([act.lead])[0] : null;
          if (lead && !(wf.members || []).includes(lead)) wf.members = [lead, ...(wf.members || [])];
          wf.lead = lead || null;
          changed.push('lead');
        }
        if (act.access) {
          // only what's given changes: tools alone keep the MCP servers, and the other way round
          const tools = act.access.tools ?? act.access.toolGroups;
          wf.access = {
            toolGroups: tools !== undefined ? cleanTools(tools) : wf.access?.toolGroups || [],
            mcpServers: act.access.mcpServers !== undefined ? cleanMcp(act.access.mcpServers) : wf.access?.mcpServers || [],
          };
          changed.push('access');
        }
        saveTeam(wf);
        lastTeam = wf.id;
        log('team', `The Brain updated "${wf.name}" (${changed.join(', ')})`);
        done.push({ kind: 'team', text: `Updated "${wf.name}": ${changed.join(', ') || 'nothing changed'}`, teamId: wf.id });
      } else if (kind === 'hire') {
        const ids = resolveAll(act.members);
        if (ids.length) lastAgent = ids[ids.length - 1];
        if (!done.some((d) => d.kind === 'hired')) done.push({ kind: 'note', text: `Already on your bench: ${ids.map((id) => agents.get(id)?.name).join(', ')}` });
      } else if (kind === 'write_project_md') {
        const content = String(act.content || '').trim();
        if (content.length < 20) throw new Error('nothing to write');
        const dir = ensureBrain(p);
        const file = path.join(dir, 'PROJECT.md');
        // keep the old version
        if (fs.existsSync(file)) {
          const hist = path.join(dir, '.brain-history');
          fs.mkdirSync(hist, { recursive: true });
          fs.copyFileSync(file, path.join(hist, `PROJECT-${new Date().toISOString().replace(/[:.]/g, '-')}.md`));
        }
        fs.writeFileSync(file, `${content.slice(0, 60000)}\n`);
        log('project', `The Brain wrote PROJECT.md for "${p.name}"`);
        done.push({ kind: 'file', text: 'Wrote PROJECT.md in the project folder', file });
      } else if (kind === 'delegate' && !delegate) {
        const to = act.to === 'agent' ? 'agent' : 'branch';
        let id: string | null | undefined = act.id;
        if (id === 'new') id = to === 'agent' ? lastAgent : lastTeam;
        if (to === 'branch') {
          const wf = findTeam(id);
          if (wf) delegate = { kind: 'branch', id: wf.id, name: wf.name, message: String(act.message || '').trim() };
        } else if (agents.get(id)) delegate = { kind: 'agent', id: id as string, name: agents.get(id)!.name, message: String(act.message || '').trim() };
        if (!delegate) done.push({ kind: 'error', text: `Couldn't hand it on: no ${to === 'agent' ? 'agent' : 'team'} "${act.id}"` });
      }
    } catch (e) {
      done.push({ kind: 'error', text: `${act?.do || 'action'}: ${(e as Error).message}` });
    }
  }
  return { done, delegate };
}

export async function ask(text: string): Promise<BrainAnswer> {
  const p = activeProject();
  const bm = brainModel();
  const canRead = bm.provider === 'claude' || bm.provider === 'codex';
  const snap = await snapshot({ fileBudget: canRead ? 6000 : 12000 });
  const past = history(p.id);
  const convo = past.length ? `\n\nEARLIER IN THIS CHAT:\n${past.slice(-12).map((m) => `${m.role === 'user' ? 'User' : 'Brain'}: ${cut(m.text, 600)}`).join('\n')}` : '';
  const out = await think(SYSTEM(p.name, canRead), `SNAPSHOT\n${snap}\n\n${catalog()}${convo}\n\nUSER:\n${text}`, {
    tools: bm.provider === 'claude' ? 'Read,Glob,Grep' : '',
    cwd: ensureBrain(p),
    timeout: 180000,
    maxTokens: 4000,
  });
  const parsed = parseActions(out);
  // you switched projects while it thought: its actions were meant for the other project, so skip them
  const skipped: BrainDone = { kind: 'error', text: `You switched projects while the Brain was thinking, so nothing was changed. Open "${p.name}" and ask again.` };
  const { done, delegate } = activeProject().id !== p.id ? { done: parsed.actions.length ? [skipped] : [], delegate: null } : applyActions(parsed.actions, p);
  const r = { answer: parsed.answer, done, delegate };
  const now = Date.now();
  remember([...past, { role: 'user', text, ts: now }, { role: 'brain', text: [r.answer, ...done.map((d) => `(${d.text})`), delegate ? `(handed to ${delegate.name}: ${delegate.message.slice(0, 200)})` : ''].filter(Boolean).join('\n'), ts: Date.now() }], p.id);
  return { ...r, model: bm, project: p.name };
}

// Small overview numbers for the UI.
export function pulse() {
  const live = liveActivity();
  const teams = listTeams();
  return {
    project: activeProject().name,
    agents: agents.list().length,
    working: [...new Set(live.map((r) => r.agentId))].length,
    teams: teams.length,
    teamsWorking: teams.filter((t) => teamState(t.id).working.length).length,
    approvals: listApprovals().length,
    outbox: outbox.list().filter((x) => x.status === 'pending').length,
    brain: getSettings().brain || null,
  };
}
