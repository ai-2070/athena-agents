// Skills: reusable know-how in Claude Code's format (a folder with SKILL.md: name, description, then
// the instructions; extra files next to it). The library lives in data/skills and is shared by every
// project. A skill can be given three ways: to one agent, to a team (every member, while working for
// that team) or to the whole project (every agent in it). Agents see the list in their instructions
// and open a skill with the read_skill tool when it fits the task, on any engine.
import fs from 'node:fs';
import path from 'node:path';
import { dataPath, ensureDir, exists, slugify, readJSON, writeJSON, HOME } from './util.ts';
import { activeProject, agents, workflows, listProjects, getSettings, saveSettings, log } from './store.ts';
import { updateProject } from './projects.ts';
import type { ClaudeSkill, Skill, SkillFile, SkillListing } from '../shared/types.ts';

/** A skill as getSkill returns it (dir is cleared so it never reaches the browser). */
export type SkillDetail = Skill & { dir?: undefined };
/** A skill as listSkills returns it: no body, a short preview instead. */
export type SkillSummary = SkillListing & { body?: undefined; dir?: undefined };
/** A skill an agent has, and how it got it. */
export type AgentSkill = SkillDetail & { via: 'agent' | 'team' | 'project' };

const LIB = () => ensureDir(dataPath('skills'));
const CLAUDE_DIR = path.join(HOME, '.claude', 'skills');
const SAFE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

// "---\nname: x\ndescription: y\n---\nbody"
function parse(text: string): { meta: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let v = kv[2].trim();
    // multi-line values: "key: >-", "key: |" or an empty value followed by indented lines
    if (/^[>|][+-]?$/.test(v) || v === '') {
      const parts: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) parts.push(lines[++i].trim());
      v = v.startsWith('|') ? parts.join('\n') : parts.join(' ');
    }
    meta[kv[1]] = v.replace(/^["']|["']$/g, '').trim();
  }
  return { meta, body: m[2] };
}
const yamlLine = (s: string) => (/[:#"'\n]/.test(s) ? JSON.stringify(s) : s);
function compose({ name, description, body }: { name: string; description: string; body?: unknown }): string {
  return `---\nname: ${yamlLine(name)}\ndescription: ${yamlLine(description.replace(/\s+/g, ' '))}\n---\n\n${String(body || '').trim()}\n`;
}

function filesIn(dir: string): SkillFile[] {
  const out: SkillFile[] = [];
  const walk = (d: string, rel: string) => {
    let list: fs.Dirent[] = [];
    try {
      list = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of list) {
      if (e.name.startsWith('.')) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else if (r !== 'SKILL.md') {
        try {
          out.push({ path: r, size: fs.statSync(path.join(d, e.name)).size });
        } catch {
          /* broken link: skip it */
        }
      }
    }
  };
  walk(dir, '');
  return out.slice(0, 200);
}

function readDir(dir: string, source: Skill['source']): (Skill & { dir: string }) | null {
  const file = path.join(dir, 'SKILL.md');
  if (!exists(file)) return null;
  const { meta, body } = parse(fs.readFileSync(file, 'utf8'));
  const slug = path.basename(dir);
  return { slug, name: meta.name || slug, description: meta.description || '', body, source, dir, files: filesIn(dir), updatedAt: fs.statSync(file).mtimeMs };
}

// Every skill in the library (with what it's used by is worked out on the page).
export function listSkills(): SkillSummary[] {
  const out: SkillSummary[] = [];
  for (const e of fs.readdirSync(LIB(), { withFileTypes: true })) {
    if (!e.isDirectory() || !SAFE.test(e.name)) continue;
    const s = readDir(path.join(LIB(), e.name), 'library');
    if (s) out.push({ ...s, body: undefined, dir: undefined, preview: s.body.slice(0, 280) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function getSkill(slug: string): SkillDetail | null {
  if (!SAFE.test(String(slug))) return null;
  const s = readDir(path.join(LIB(), slug), 'library');
  return s ? { ...s, dir: undefined } : null;
}

// Your Claude Code skills (~/.claude/skills) that aren't in the library yet.
export function claudeSkills(): ClaudeSkill[] {
  if (!exists(CLAUDE_DIR)) return [];
  const have = new Set(listSkills().map((s) => s.slug));
  return fs
    .readdirSync(CLAUDE_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => readDir(path.join(CLAUDE_DIR, e.name), 'claude'))
    .filter((s): s is Skill & { dir: string } => Boolean(s))
    .map(({ slug, name, description, files }) => ({ slug, name, description, files: files.length, inLibrary: have.has(slugify(slug)) }));
}

export const SKILL_BODY_MAX = 60000;

// keep: save the old SKILL.md in the skill's .history folder first (the Brain's edits can be undone by hand)
export function saveSkill({ slug, name, description, body }: { slug?: string; name?: string; description?: string; body?: string }, { keep = false }: { keep?: boolean } = {}): SkillDetail | null {
  name = String(name || '').trim().slice(0, 80);
  description = String(description || '').trim().slice(0, 1000);
  if (!name) throw new Error('Give the skill a name.');
  if (!description) throw new Error('Say in one or two sentences when the skill should be used: agents decide from this.');
  const id = slug && SAFE.test(slug) && exists(path.join(LIB(), slug)) ? slug : uniqueSlug(name);
  const dir = ensureDir(path.join(LIB(), id));
  const file = path.join(dir, 'SKILL.md');
  if (keep && exists(file)) keepVersion(dir);
  fs.writeFileSync(file, compose({ name, description, body: String(body || '').slice(0, SKILL_BODY_MAX) }));
  return getSkill(id);
}

// The last few versions of a skill, in <skill>/.history (hidden: not one of the skill's files).
const VERSIONS_KEPT = 20;
function keepVersion(dir: string) {
  const hist = ensureDir(path.join(dir, '.history'));
  fs.copyFileSync(path.join(dir, 'SKILL.md'), path.join(hist, `SKILL-${new Date().toISOString().replace(/[:.]/g, '-')}.md`));
  const old = fs.readdirSync(hist).filter((n) => /^SKILL-.*\.md$/.test(n)).sort();
  for (const n of old.slice(0, Math.max(0, old.length - VERSIONS_KEPT))) fs.rmSync(path.join(hist, n), { force: true });
}

function uniqueSlug(name: string): string {
  const base = slugify(name).slice(0, 50) || 'skill';
  let s = base;
  for (let i = 2; exists(path.join(LIB(), s)); i++) s = `${base}-${i}`;
  return s;
}

export function deleteSkill(slug: string) {
  if (!SAFE.test(String(slug))) throw new Error('No such skill.');
  fs.rmSync(path.join(LIB(), slug), { recursive: true, force: true });
}

// Delete a skill and take it off every agent and team (in the open project), every project, and the Brain.
export function deleteSkillEverywhere(slug: string) {
  deleteSkill(slug);
  for (const a of agents.list()) if ((a.skills || []).includes(slug)) agents.save({ ...a, skills: a.skills.filter((x) => x !== slug) });
  for (const w of workflows.list()) if ((w.skills || []).includes(slug)) workflows.save({ ...w, skills: w.skills!.filter((x) => x !== slug) });
  for (const p of listProjects()) if ((p.skills || []).includes(slug)) updateProject(p.id, { skills: p.skills!.filter((x) => x !== slug) });
  const brain = brainSkillSlugs();
  if (brain.includes(slug)) saveSettings({ brainSkills: brain.filter((x) => x !== slug) });
}

// ---------- the Brain's own skills ----------
// Skills given to the Brain are part of its instructions in every turn (Settings: brainSkills).
export const brainSkillSlugs = (): string[] => (Array.isArray(getSettings().brainSkills) ? getSettings().brainSkills : []);
export const brainSkills = (): SkillDetail[] => brainSkillSlugs().map(getSkill).filter((s): s is SkillDetail => s !== null);
export function setBrainSkills(slugs: unknown): string[] {
  const list = [...new Set((Array.isArray(slugs) ? slugs : []).map(String).filter((x) => SAFE.test(x)))].slice(0, 30);
  saveSettings({ brainSkills: list });
  return list;
}

// ---------- skills that come with the dashboard ----------
// Added to the library once. Deleting one keeps it deleted (data/skills/.builtin.json remembers).
export const SELF_IMPROVEMENT = 'self-improvement';
const BUILTIN: { slug: string; name: string; description: string; body: string }[] = [
  {
    slug: SELF_IMPROVEMENT,
    name: 'Self-improvement',
    description: 'Use after any substantial piece of work, and whenever the user explains how they want something done: record what worked as a skill, keep skills accurate, and spot work that should become a routine.',
    body: `# Self-improvement

You get better at this project over time by writing down what works. Skills are the project's memory of *how* things are done: step-by-step workflows, checklists, house rules and pitfalls. Agents read a skill before work that matches it, so a good skill makes the next run faster and better.

## When to record a workflow
Record one (create_skill) when:
- an agent or team finished a non-trivial task (several steps or tool calls) and the way it got there would help next time;
- someone found the fix for something that kept failing, or a trick that wasn't obvious;
- the user explained how they want a kind of work done, corrected the output, or said "always…" / "never…";
- the same kind of request has come up more than once.

Don't record one-off facts (they belong in PROJECT.md), secrets (keys, passwords, tokens, personal data), guesses, or work that failed without a lesson. When nothing is worth keeping, record nothing.

## Update before you create
Look at the SKILLS list first. If a skill already covers this kind of work, improve it instead of adding a near-copy:
- add a missing step, pitfall or example with "append";
- rewrite it with "body" only when you have seen its whole text (open it with read_skill first);
- sharpen a description that doesn't say clearly when to use it.
When two skills overlap, merge them into one and tell the user; delete the leftover only if they agree.

## How to write a skill
- name: short, the kind of work ("Weekly newsletter", "Product render in Blender").
- description: one or two sentences that say WHEN to use it. Agents decide from this line alone.
- body, in markdown:
  - ## When to use
  - ## Steps: numbered and concrete (which tool, folder, settings, accounts)
  - ## Pitfalls: what went wrong before and how it was fixed
  - ## Done when: what good output looks like
- General enough to reuse (no one-off dates or file names unless they are always the same), short enough to follow (about 60 lines at most).
- Give it to whoever does that work (give_skill): the agent, the team, or the whole project when everyone needs it.

## Routines
When work repeats on a rhythm (every morning, each Friday, after each release), suggest a routine that mentions the skill it uses. Create the routine once the user agrees.

## Tell the user
Say in one line what you recorded or changed and why, e.g. "Saved how Ana renders product shots as the skill Product render and gave it to the Design team."`,
  },
];

export function ensureBuiltinSkills() {
  const marker = path.join(LIB(), '.builtin.json');
  const added = readJSON<{ added: string[] }>(marker, { added: [] }).added;
  const now = [...added];
  for (const b of BUILTIN) {
    if (added.includes(b.slug)) continue;
    if (!exists(path.join(LIB(), b.slug))) {
      fs.mkdirSync(path.join(LIB(), b.slug), { recursive: true });
      fs.writeFileSync(path.join(LIB(), b.slug, 'SKILL.md'), compose(b));
    }
    now.push(b.slug);
  }
  if (now.length !== added.length) writeJSON(marker, { added: now });
}

// Copy one of your Claude Code skills (folder and files) into the library.
export function importClaudeSkill(name: string): SkillDetail | null {
  const src = path.join(CLAUDE_DIR, path.basename(String(name)));
  if (!exists(path.join(src, 'SKILL.md'))) throw new Error('That skill was not found in ~/.claude/skills.');
  const id = uniqueSlug(path.basename(src));
  fs.cpSync(src, path.join(LIB(), id), { recursive: true });
  log('skill', `Imported the skill "${getSkill(id)?.name || id}" from Claude Code`);
  return getSkill(id);
}

// Read a file that belongs to a skill (for read_skill with a file).
export function readSkillFile(slug: string, rel: unknown): string {
  const s = getSkill(slug);
  if (!s) throw new Error(`No skill "${slug}".`);
  // compare real paths, so a link inside the skill can't point outside it
  const root = fs.realpathSync(path.join(LIB(), slug));
  let abs: string;
  try {
    abs = fs.realpathSync(path.resolve(root, String(rel || '')));
  } catch {
    throw new Error(`The skill has no file "${rel}".`);
  }
  if (!abs.toLowerCase().startsWith(root.toLowerCase() + path.sep)) throw new Error('That file is not part of the skill.');
  return fs.readFileSync(abs, 'utf8').slice(0, 60000);
}

// Find a skill by slug or name (agents may use either).
export function findSkill(key: unknown): SkillDetail | null {
  const k = String(key || '').trim().toLowerCase();
  // by slug, or by its display name (then load the full skill, body included)
  const hit = listSkills().find((s) => s.name.toLowerCase() === k || s.slug === slugify(k));
  return getSkill(k) || (hit ? getSkill(hit.slug) : null);
}

// The skills an agent has right now: its own, its team's (passed in), and the project's.
export function skillsFor(agent: { skills?: string[] }, extra: string[] | null | undefined = []): AgentSkill[] {
  const p = activeProject();
  const all = [...(agent.skills || []), ...(extra || []), ...(p.skills || [])];
  const seen = new Set<string>();
  const out: AgentSkill[] = [];
  for (const slug of all) {
    if (seen.has(slug)) continue;
    seen.add(slug);
    const s = getSkill(slug);
    if (s) out.push({ ...s, via: (agent.skills || []).includes(slug) ? 'agent' : (extra || []).includes(slug) ? 'team' : 'project' });
  }
  return out;
}

// The part of an agent's instructions that lists its skills.
export function skillsPrompt(agent: { skills?: string[]; _teamSkills?: string[] }): string {
  const list = skillsFor(agent, agent._teamSkills || []);
  if (!list.length) return '';
  return `\n# Your skills
These are instructions written for specific kinds of work. When a task matches one, call read_skill with its id FIRST and follow it.
${list.map((s) => `- ${s.name}: ${s.description} [id: ${s.slug}${s.files.length ? `; has ${s.files.length} extra file${s.files.length === 1 ? '' : 's'}` : ''}]`).join('\n')}`;
}
