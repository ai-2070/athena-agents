// Agent library: Athena's agents (library/athena-agents, one Markdown file each), your Hermes profiles and your
// Claude Code subagents. Plus creating, hiring and exporting agents.
import fs from 'node:fs';
import path from 'node:path';
import { HOME, ROOT, ensureDir, listFiles, parseFrontmatter, readJSON, slugify, uid } from './util.ts';
import { agents, getSettings, log } from './store.ts';
import { listProfiles } from './engines/hermes.ts';
import { getSkill } from './skills.ts';
import { isEffort } from '../shared/effort.ts';
import { defaultModelForEngine } from '../shared/modeldefaults.ts';
import type { Agent, EngineId, LibraryAgentListing } from '../shared/types.ts';

/** One of Athena's agents, not hired yet: the listing and where its file is. */
export interface LibraryAgent extends LibraryAgentListing {
  file: string;
}

/** A Claude Code subagent (~/.claude/agents/<slug>.md). */
export interface ClaudeSubagent {
  slug: string;
  name: string;
  description: string;
  model: string;
  file: string;
}

// Athena's agents (the folder's README.md has the standard each file follows). Only the folders groups.json names
// are read, in its order.
const LIBRARY_DIR = path.join(ROOT, 'library', 'athena-agents');
const commaList = (v: string | undefined): string[] => (v || '').split(',').map((x) => x.trim()).filter(Boolean);

let libraryCache: LibraryAgent[] | null = null;
export function libraryAgents(): LibraryAgent[] {
  if (libraryCache) return libraryCache;
  const groups = readJSON<{ groups?: { id?: string; label?: string }[] }>(path.join(LIBRARY_DIR, 'groups.json'), {}).groups || [];
  const out: LibraryAgent[] = [];
  for (const g of groups) {
    if (!g.id) continue;
    const dir = path.join(LIBRARY_DIR, g.id);
    const here: LibraryAgent[] = [];
    for (const f of listFiles(dir, (n) => n.endsWith('.md'))) {
      const file = path.join(dir, f);
      let text = '';
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const { meta } = parseFrontmatter(text);
      if (!meta.name) continue;
      here.push({
        slug: f.replace(/\.md$/, ''),
        name: meta.name,
        description: meta.description || '',
        emoji: meta.emoji || '🤖',
        color: meta.color || '',
        specialty: meta.specialty || '',
        group: meta.group || g.id,
        groupLabel: g.label || g.id,
        tools: commaList(meta.tools),
        skills: commaList(meta.skills),
        engine: meta.engine || '',
        starter: meta.starter === 'true',
        file,
      });
    }
    out.push(...here.sort((a, b) => a.name.localeCompare(b.name)));
  }
  libraryCache = out;
  return libraryCache;
}

export function claudeSubagents(): ClaudeSubagent[] {
  const dir = path.join(HOME, '.claude', 'agents');
  return listFiles(dir, (n) => n.endsWith('.md')).map((f) => {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    const { meta } = parseFrontmatter(text);
    return { slug: f.replace(/\.md$/, ''), name: meta.name || f.replace(/\.md$/, ''), description: meta.description || '', model: meta.model || '', file: path.join(dir, f) };
  });
}

export async function libraryIndex() {
  return {
    agents: libraryAgents().map(({ file, ...a }): LibraryAgentListing => a),
    hermes: await listProfiles().catch(() => []),
    claude: claudeSubagents().map(({ file, ...a }) => a),
  };
}

// ---------- agents ----------
// mid-tone, so a new agent's colour shows on white pages and on near-black ones
const COLORS = ['#6b7bff', '#2fa57a', '#d6803b', '#c4568f', '#3d8fd1', '#8a63d2', '#c99a1a', '#2aa5a0', '#d9534f'];

export function newAgent(fields: Partial<Agent> = {}): Agent {
  const d = getSettings().defaults;
  const engine = fields.engine || d.engine;
  const a: Agent = {
    id: fields.id || `${slugify(fields.name || 'agent')}-${uid().slice(-4)}`,
    name: fields.name || 'New agent',
    emoji: fields.emoji || '🤖',
    color: fields.color || COLORS[Math.floor(Math.random() * COLORS.length)],
    specialty: fields.specialty || '',
    description: fields.description || '',
    systemPrompt: fields.systemPrompt || '',
    engine,
    model: fields.model ?? defaultModelForEngine(engine, d, fields.provider),
    provider: fields.provider || 'openrouter',
    claudeAuth: fields.claudeAuth || 'login',
    hermesProfile: fields.hermesProfile ?? d.hermesProfile ?? '',
    ...(fields.openclawAgent ? { openclawAgent: fields.openclawAgent } : {}),
    autonomy: fields.autonomy || d.autonomy || 'auto',
    toolGroups: fields.toolGroups || ['programs', 'browser', 'agents', 'files'],
    mcpServers: fields.mcpServers || [],
    knowledge: { folders: fields.knowledge?.folders || [] },
    workspace: fields.workspace || '',
    temperature: fields.temperature ?? '',
    effort: isEffort(fields.effort) ? fields.effort : '',
    richAnswers: !!fields.richAnswers,
    alwaysAllow: [], // grants stay with the agent they were given to, never copies
    skills: Array.isArray(fields.skills) ? fields.skills : [],
    source: fields.source || { type: 'custom' },
    pinned: false,
  };
  return agents.save(a);
}

// (a Record, so a new engine can't be left out)
const ENGINE_IDS: Record<EngineId, true> = { 'claude-code': true, eve: true, hermes: true, codex: true, pi: true, omp: true, openclaw: true };
const isEngineId = (e: string): e is EngineId => Object.hasOwn(ENGINE_IDS, e);

// The agent gets a copy of the file's text, its tools and engine, and the skills it names that are in your skill
// library. The file itself is never changed.
export function hireFromLibrary(slug: string, overrides: Partial<Agent> = {}): Agent {
  const a = libraryAgents().find((x) => x.slug === slug);
  if (!a) throw new Error('That agent is not in the library.');
  const { body } = parseFrontmatter(fs.readFileSync(a.file, 'utf8'));
  const agent = newAgent({
    name: a.name,
    emoji: a.emoji,
    color: a.color,
    specialty: a.specialty,
    description: a.description,
    systemPrompt: body.trim(),
    toolGroups: [...a.tools],
    skills: a.skills.filter((sk) => getSkill(sk)),
    ...(isEngineId(a.engine) ? { engine: a.engine } : {}),
    source: { type: 'library', slug, division: a.group },
    ...overrides,
  });
  log('library', `Hired ${agent.name} from the Agent library`, { agentId: agent.id });
  return agent;
}

export function hireHermesProfile(profile: string, overrides: Partial<Agent> = {}): Agent {
  const agent = newAgent({
    name: profile === 'default' ? 'Hermes' : profile.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
    emoji: '☤',
    specialty: `Hermes profile "${profile}"`,
    engine: 'hermes',
    hermesProfile: profile,
    model: '',
    toolGroups: ['agents'],
    source: { type: 'hermes', profile },
    ...overrides,
  });
  log('library', `Added Hermes profile ${profile} as an agent`, { agentId: agent.id });
  return agent;
}

export function importClaudeSubagent(slug: string): Agent {
  const s = claudeSubagents().find((x) => x.slug === slug);
  if (!s) throw new Error('No such Claude Code subagent.');
  const { body } = parseFrontmatter(fs.readFileSync(s.file, 'utf8'));
  return newAgent({ name: s.name, emoji: '✳️', specialty: s.description.slice(0, 140), description: s.description, systemPrompt: body.trim(), engine: 'claude-code', source: { type: 'claude', slug } });
}

// Write an agent as a Claude Code subagent (~/.claude/agents/<slug>.md) so you can use it in any Claude session.
export function exportToClaude(agent: Agent): string {
  const dir = ensureDir(path.join(HOME, '.claude', 'agents'));
  const slug = slugify(agent.name);
  const file = path.join(dir, `${slug}.md`);
  // a real YAML string: a backslash (a Windows path) or a quote must not break the frontmatter
  const desc = JSON.stringify((agent.description || agent.specialty || agent.name).replace(/\s+/g, ' ').trim());
  fs.writeFileSync(file, `---\nname: ${slug}\ndescription: ${desc}\n---\n\n${agent.systemPrompt || `You are ${agent.name}.`}\n`);
  log('library', `Installed ${agent.name} into Claude Code as subagent "${slug}"`, { agentId: agent.id });
  return file;
}
