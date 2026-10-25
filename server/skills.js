// Skills: reusable know-how in Claude Code's format (a folder with SKILL.md: name, description, then
// the instructions; extra files next to it). The library lives in data/skills and is shared by every
// project. A skill can be given three ways: to one agent, to a team (every member, while working for
// that team) or to the whole project (every agent in it). Agents see the list in their instructions
// and open a skill with the read_skill tool when it fits the task, on any engine.
import fs from 'node:fs';
import path from 'node:path';
import { dataPath, ensureDir, exists, slugify, HOME } from './util.js';
import { activeProject, log } from './store.js';

const LIB = () => ensureDir(dataPath('skills'));
const CLAUDE_DIR = path.join(HOME, '.claude', 'skills');
const SAFE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

// "---\nname: x\ndescription: y\n---\nbody"
function parse(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let v = kv[2].trim();
    // multi-line values: "key: >-", "key: |" or an empty value followed by indented lines
    if (/^[>|][+-]?$/.test(v) || v === '') {
      const parts = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) parts.push(lines[++i].trim());
      v = v.startsWith('|') ? parts.join('\n') : parts.join(' ');
    }
    meta[kv[1]] = v.replace(/^["']|["']$/g, '').trim();
  }
  return { meta, body: m[2] };
}
const yamlLine = (s) => (/[:#"'\n]/.test(s) ? JSON.stringify(s) : s);
function compose({ name, description, body }) {
  return `---\nname: ${yamlLine(name)}\ndescription: ${yamlLine(description.replace(/\s+/g, ' '))}\n---\n\n${String(body || '').trim()}\n`;
}

function filesIn(dir) {
  const out = [];
  const walk = (d, rel) => {
    let list = [];
    try {
      list = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of list) {
      if (e.name.startsWith('.')) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else if (r !== 'SKILL.md') out.push({ path: r, size: fs.statSync(path.join(d, e.name)).size });
    }
  };
  walk(dir, '');
  return out.slice(0, 200);
}

function readDir(dir, source) {
  const file = path.join(dir, 'SKILL.md');
  if (!exists(file)) return null;
  const { meta, body } = parse(fs.readFileSync(file, 'utf8'));
  const slug = path.basename(dir);
  return { slug, name: meta.name || slug, description: meta.description || '', body, source, dir, files: filesIn(dir), updatedAt: fs.statSync(file).mtimeMs };
}

// Every skill in the library (with what it's used by is worked out on the page).
export function listSkills() {
  const out = [];
  for (const e of fs.readdirSync(LIB(), { withFileTypes: true })) {
    if (!e.isDirectory() || !SAFE.test(e.name)) continue;
    const s = readDir(path.join(LIB(), e.name), 'library');
    if (s) out.push({ ...s, body: undefined, dir: undefined, preview: s.body.slice(0, 280) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function getSkill(slug) {
  if (!SAFE.test(String(slug))) return null;
  const s = readDir(path.join(LIB(), slug), 'library');
  return s ? { ...s, dir: undefined } : null;
}

// Your Claude Code skills (~/.claude/skills) that aren't in the library yet.
export function claudeSkills() {
  if (!exists(CLAUDE_DIR)) return [];
  const have = new Set(listSkills().map((s) => s.slug));
  return fs
    .readdirSync(CLAUDE_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => readDir(path.join(CLAUDE_DIR, e.name), 'claude'))
    .filter(Boolean)
    .map(({ slug, name, description, files }) => ({ slug, name, description, files: files.length, inLibrary: have.has(slugify(slug)) }));
}

export function saveSkill({ slug, name, description, body }) {
  name = String(name || '').trim().slice(0, 80);
  description = String(description || '').trim().slice(0, 1000);
  if (!name) throw new Error('Give the skill a name.');
  if (!description) throw new Error('Say in one or two sentences when the skill should be used: agents decide from this.');
  const id = slug && SAFE.test(slug) && exists(path.join(LIB(), slug)) ? slug : uniqueSlug(name);
  const dir = ensureDir(path.join(LIB(), id));
  fs.writeFileSync(path.join(dir, 'SKILL.md'), compose({ name, description, body }));
  return getSkill(id);
}

function uniqueSlug(name) {
  const base = slugify(name).slice(0, 50) || 'skill';
  let s = base;
  for (let i = 2; exists(path.join(LIB(), s)); i++) s = `${base}-${i}`;
  return s;
}

export function deleteSkill(slug) {
  if (!SAFE.test(String(slug))) throw new Error('No such skill.');
  fs.rmSync(path.join(LIB(), slug), { recursive: true, force: true });
}

// Copy one of your Claude Code skills (folder and files) into the library.
export function importClaudeSkill(name) {
  const src = path.join(CLAUDE_DIR, path.basename(String(name)));
  if (!exists(path.join(src, 'SKILL.md'))) throw new Error('That skill was not found in ~/.claude/skills.');
  const id = uniqueSlug(path.basename(src));
  fs.cpSync(src, path.join(LIB(), id), { recursive: true });
  log('skill', `Imported the skill "${getSkill(id)?.name || id}" from Claude Code`);
  return getSkill(id);
}

// Read a file that belongs to a skill (for read_skill with a file).
export function readSkillFile(slug, rel) {
  const s = getSkill(slug);
  if (!s) throw new Error(`No skill "${slug}".`);
  const root = path.join(LIB(), slug);
  const abs = path.resolve(root, String(rel || ''));
  if (!abs.toLowerCase().startsWith(root.toLowerCase() + path.sep)) throw new Error('That file is not part of the skill.');
  if (!exists(abs)) throw new Error(`The skill has no file "${rel}".`);
  return fs.readFileSync(abs, 'utf8').slice(0, 60000);
}

// Find a skill by slug or name (agents may use either).
export function findSkill(key) {
  const k = String(key || '').trim().toLowerCase();
  return getSkill(k) || listSkills().find((s) => s.name.toLowerCase() === k || s.slug === slugify(k)) || null;
}

// The skills an agent has right now: its own, its team's (passed in), and the project's.
export function skillsFor(agent, extra = []) {
  const p = activeProject();
  const all = [...(agent.skills || []), ...(extra || []), ...(p.skills || [])];
  const seen = new Set();
  const out = [];
  for (const slug of all) {
    if (seen.has(slug)) continue;
    seen.add(slug);
    const s = getSkill(slug);
    if (s) out.push({ ...s, via: (agent.skills || []).includes(slug) ? 'agent' : (extra || []).includes(slug) ? 'team' : 'project' });
  }
  return out;
}

// The part of an agent's instructions that lists its skills.
export function skillsPrompt(agent) {
  const list = skillsFor(agent, agent._teamSkills || []);
  if (!list.length) return '';
  return `\n# Your skills
These are instructions written for specific kinds of work. When a task matches one, call read_skill with its name FIRST and follow it.
${list.map((s) => `- ${s.name}: ${s.description}${s.files.length ? ` (has ${s.files.length} extra file${s.files.length === 1 ? '' : 's'})` : ''}`).join('\n')}`;
}
