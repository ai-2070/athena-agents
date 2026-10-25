// Projects: create, switch, and look inside a project's Brain folder (files, notes, GitHub).
import fs from 'node:fs';
import path from 'node:path';
import { HOME, ensureDir, exists, run, slugify, uid, which } from './util.js';
import { listProjects, saveProjects, activeProject, setActiveProject, log } from './store.js';

const PROJECTS_ROOT = path.join(HOME, 'Documents', 'My Dashboard');
const SKIP = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.venv', '__pycache__', '.cache']);

export function projectsRoot() {
  return PROJECTS_ROOT;
}

function brainReadme(name, extra = '') {
  return `# ${name}

This folder is the project's Brain. Every agent in the project works here and reads it for context.

Put anything the agents should know in here: briefs, notes, brand and style guides, docs, assets.
Agents save what they make into this folder too.
${extra}
`;
}

// mode: "new" (fresh folder), "existing" (a folder you already have), "github" (clone a repo into a folder)
export async function createProject({ name, mode = 'new', folder = '', repo = '' }) {
  name = String(name || '').trim();
  if (!name) throw new Error('Give the project a name.');
  let brainPath = String(folder || '').trim().replace(/^"|"$/g, '');
  repo = String(repo || '').trim();
  if (mode === 'existing') {
    if (!brainPath || !exists(brainPath) || !fs.statSync(brainPath).isDirectory()) throw new Error(`${brainPath || 'That folder'} doesn't exist.`);
  } else {
    brainPath ||= path.join(PROJECTS_ROOT, slugify(name));
    if (mode === 'github') {
      if (!repo) throw new Error('Which GitHub repo? Use owner/name or a URL.');
      if (exists(brainPath) && fs.readdirSync(brainPath).length) throw new Error(`${brainPath} already has files in it. Pick an empty or new folder.`);
      ensureDir(path.dirname(brainPath));
      const short = /^[\w.-]+\/[\w.-]+$/.test(repo);
      const r = which('gh') && short ? await run('gh', ['repo', 'clone', repo, brainPath], { timeout: 15 * 60_000 }) : await run('git', ['clone', short ? `https://github.com/${repo}.git` : repo, brainPath], { timeout: 15 * 60_000 });
      if (r.code !== 0) throw new Error(`Couldn't clone ${repo}: ${(r.stderr || r.stdout).trim().slice(-500)}`);
    } else {
      ensureDir(brainPath);
      const readme = path.join(brainPath, 'BRAIN.md');
      if (!exists(readme)) fs.writeFileSync(readme, brainReadme(name));
      ensureDir(path.join(brainPath, 'notes'));
    }
  }
  const list = listProjects();
  const id = `${slugify(name)}-${uid().slice(-4)}`;
  const project = { id, name, brainPath: path.resolve(brainPath), repo, createdAt: Date.now() };
  saveProjects([...list, project]);
  setActiveProject(id);
  log('project', `Created project "${name}" (${mode === 'github' ? `cloned ${repo}` : brainPath})`);
  return project;
}

export function updateProject(id, patch) {
  const list = listProjects();
  const p = list.find((x) => x.id === id);
  if (!p) throw new Error('No such project.');
  if (patch.name) p.name = String(patch.name).slice(0, 80);
  if (patch.brainPath) {
    if (!exists(patch.brainPath)) throw new Error(`${patch.brainPath} doesn't exist.`);
    p.brainPath = path.resolve(patch.brainPath);
  }
  saveProjects(list);
  return p;
}

// Removes the project from the dashboard. Its Brain folder and files on disk stay where they are.
export function removeProject(id) {
  const list = listProjects();
  if (list.length <= 1) throw new Error('Keep at least one project.');
  const rest = list.filter((x) => x.id !== id);
  saveProjects(rest);
  if (activeProject().id === id || !rest.some((x) => x.id === activeProject().id)) setActiveProject(rest[0].id);
  return rest;
}

export function ensureBrain(p = activeProject()) {
  if (!exists(p.brainPath)) {
    ensureDir(p.brainPath);
    fs.writeFileSync(path.join(p.brainPath, 'BRAIN.md'), brainReadme(p.name));
  }
  return p.brainPath;
}

// A look inside the Brain: top files and folders, size, and Git status.
export async function brainInfo(p = activeProject()) {
  ensureBrain(p);
  const entries = [];
  let files = 0;
  let bytes = 0;
  const walk = (dir, depth) => {
    let list = [];
    try {
      list = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of list) {
      if (SKIP.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth === 0) entries.push({ name: e.name, dir: true, path: full });
        if (files < 5000) walk(full, depth + 1);
      } else {
        files++;
        try {
          bytes += fs.statSync(full).size;
        } catch {
          /* gone */
        }
        if (depth === 0) entries.push({ name: e.name, dir: false, path: full });
      }
    }
  };
  walk(p.brainPath, 0);
  entries.sort((a, b) => b.dir - a.dir || a.name.localeCompare(b.name));
  let git = null;
  if (exists(path.join(p.brainPath, '.git'))) {
    const g = (...args) => run('git', ['-C', p.brainPath, ...args], { timeout: 15000 }).then((r) => r.stdout.trim());
    const [branch, remote, last, status] = await Promise.all([g('rev-parse', '--abbrev-ref', 'HEAD'), g('remote', 'get-url', 'origin'), g('log', '-1', '--format=%s · %cr'), g('status', '--porcelain')]);
    git = { branch, remote, url: remote.replace(/^git@github\.com:/, 'https://github.com/').replace(/\.git$/, ''), last, changes: status ? status.split('\n').length : 0 };
  }
  return { project: p, entries: entries.slice(0, 60), files, sizeMB: +(bytes / 1e6).toFixed(1), git };
}

export function addNote(name, content, p = activeProject()) {
  ensureBrain(p);
  const dir = ensureDir(path.join(p.brainPath, 'notes'));
  const safe = String(name || 'note').replace(/[^\w.\- ]+/g, '_').replace(/\.md$/i, '') + '.md';
  const file = path.join(dir, safe);
  fs.writeFileSync(file, String(content || ''));
  return file;
}

export async function gitPull(p = activeProject()) {
  const r = await run('git', ['-C', p.brainPath, 'pull', '--ff-only'], { timeout: 5 * 60_000 });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().slice(-500));
  return r.stdout.trim() || 'Up to date.';
}
