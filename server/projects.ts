// Projects: create, switch, and look inside a project's Brain folder (files, notes, GitHub).
import fs from 'node:fs';
import path from 'node:path';
import { HOME, ensureDir, exists, run, slugify, uid, which, dataPath } from './util.ts';
import { listProjects, saveProjects, activeProject, setActiveProject, log } from './store.ts';
import type { Project } from '../shared/types.ts';
import type { ProjectPeek } from './projectsync.ts';

const PROJECTS_ROOT = path.join(HOME, 'Documents', 'My Dashboard');
const SKIP = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.venv', '__pycache__', '.cache']);

export function projectsRoot(): string {
  return PROJECTS_ROOT;
}

function brainReadme(name: string, extra = ''): string {
  return `# ${name}

This folder is the project's Brain. Every agent in the project works here and reads it for context.

Put anything the agents should know in here: briefs, notes, brand and style guides, docs, assets.
Agents save what they make into this folder too.
${extra}
`;
}

export interface CreateProjectInput {
  name?: string;
  mode?: 'new' | 'existing' | 'github' | string;
  folder?: string;
  repo?: string;
  description?: string;
}

// mode: "new" (fresh folder), "existing" (a folder you already have), "github" (clone a repo into a folder)
export async function createProject({ name, mode = 'new', folder = '', repo = '', description = '' }: CreateProjectInput): Promise<Project> {
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
  const project: Project = { id, name, description: String(description || '').trim().slice(0, 6000), brainPath: path.resolve(brainPath), repo, createdAt: Date.now() };
  saveProjects([...list, project]);
  setActiveProject(id);
  log('project', `Created project "${name}" (${mode === 'github' ? `cloned ${repo}` : brainPath})`);
  return project;
}

export type ProjectPatch = Partial<Pick<Project, 'name' | 'description' | 'skills' | 'brainPath'>>;

export function updateProject(id: string, patch: ProjectPatch): Project {
  const list = listProjects();
  const p = list.find((x) => x.id === id);
  if (!p) throw new Error('No such project.');
  if (patch.name) p.name = String(patch.name).slice(0, 80);
  if (typeof patch.description === 'string') p.description = patch.description.trim().slice(0, 6000);
  // skills every agent in the project gets
  if (Array.isArray(patch.skills)) p.skills = [...new Set(patch.skills.map(String))].slice(0, 100);
  if (patch.brainPath) {
    if (!exists(patch.brainPath)) throw new Error(`${patch.brainPath} doesn't exist.`);
    p.brainPath = path.resolve(patch.brainPath);
  }
  saveProjects(list);
  return p;
}

// Removes the project from the dashboard. Its Brain folder and files on disk stay where they are.
export function removeProject(id: string): Project[] {
  const list = listProjects();
  if (list.length <= 1) throw new Error('Keep at least one project.');
  const rest = list.filter((x) => x.id !== id);
  saveProjects(rest);
  if (activeProject().id === id || !rest.some((x) => x.id === activeProject().id)) setActiveProject(rest[0].id);
  return rest;
}

export function ensureBrain(p: Project = activeProject()): string {
  if (!exists(p.brainPath)) {
    ensureDir(p.brainPath);
    fs.writeFileSync(path.join(p.brainPath, 'BRAIN.md'), brainReadme(p.name));
  }
  return p.brainPath;
}

export interface BrainEntry {
  name: string;
  dir: boolean;
  path: string;
}

export interface BrainGit {
  branch: string;
  remote: string;
  url: string;
  last: string;
  changes: number;
}

export interface BrainInfo {
  project: Project;
  entries: BrainEntry[];
  files: number;
  sizeMB: number;
  git: BrainGit | null;
}

// A look inside the Brain: top files and folders, size, and Git status.
export async function brainInfo(p: Project = activeProject()): Promise<BrainInfo> {
  ensureBrain(p);
  const entries: BrainEntry[] = [];
  let files = 0;
  let bytes = 0;
  const walk = (dir: string, depth: number) => {
    let list: fs.Dirent[] = [];
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
  entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
  let git: BrainGit | null = null;
  if (exists(path.join(p.brainPath, '.git'))) {
    const g = (...args: string[]) => run('git', ['-C', p.brainPath, ...args], { timeout: 15000 }).then((r) => r.stdout.trim());
    const [branch, remote, last, status] = await Promise.all([g('rev-parse', '--abbrev-ref', 'HEAD'), g('remote', 'get-url', 'origin'), g('log', '-1', '--format=%s · %cr'), g('status', '--porcelain')]);
    git = { branch, remote, url: remote.replace(/^git@github\.com:/, 'https://github.com/').replace(/\.git$/, ''), last, changes: status ? status.split('\n').length : 0 };
  }
  return { project: p, entries: entries.slice(0, 60), files, sizeMB: +(bytes / 1e6).toFixed(1), git };
}

export function addNote(name: unknown, content: unknown, p: Project = activeProject()): string {
  ensureBrain(p);
  const dir = ensureDir(path.join(p.brainPath, 'notes'));
  const safe = String(name || 'note').replace(/[^\w.\- ]+/g, '_').replace(/\.md$/i, '') + '.md';
  const file = path.join(dir, safe);
  fs.writeFileSync(file, String(content || ''));
  return file;
}

export async function gitPull(p: Project = activeProject()): Promise<string> {
  const r = await run('git', ['-C', p.brainPath, 'pull', '--ff-only'], { timeout: 5 * 60_000 });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().slice(-500));
  return r.stdout.trim() || 'Up to date.';
}

/** A project on the start screen. */
export type ProjectOverviewItem = Project & { agents: number; teams: number; hasProjectMd: boolean; saved: ProjectPeek | null };

/** A folder in the projects folder that isn't a project yet. */
export interface FoundFolder {
  name: string;
  folder: string;
  /** PROJECT.md or BRAIN.md, when it has one */
  brief: string | undefined;
  saved: ProjectPeek | null;
}

export interface ProjectsOverview {
  active: string;
  root: string;
  projects: ProjectOverviewItem[];
  found: FoundFolder[];
}

// For the start screen: every project with how many agents and teams it has, plus project
// folders on this PC (in the projects folder) that aren't on the list yet.
export function overview(peek: (folder: string) => ProjectPeek | null = () => null): ProjectsOverview {
  const list = listProjects();
  const count = (id: string, what: string) => {
    try {
      return fs.readdirSync(dataPath('projects', id, what)).filter((n) => n.endsWith('.json')).length;
    } catch {
      return 0;
    }
  };
  const known = new Set(list.map((p) => path.resolve(p.brainPath).toLowerCase()));
  const found: FoundFolder[] = [];
  try {
    for (const e of fs.readdirSync(PROJECTS_ROOT, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const dir = path.join(PROJECTS_ROOT, e.name);
      if (known.has(path.resolve(dir).toLowerCase())) continue;
      const saved = peek(dir);
      const hasBrief = ['PROJECT.md', 'BRAIN.md'].find((f) => exists(path.join(dir, f)));
      if (saved || hasBrief) found.push({ name: saved?.name || e.name, folder: dir, brief: hasBrief, saved });
    }
  } catch {
    /* no projects folder yet */
  }
  return {
    active: activeProject().id,
    root: PROJECTS_ROOT,
    projects: list
      .map((p) => ({ ...p, agents: count(p.id, 'agents'), teams: count(p.id, 'workflows'), hasProjectMd: exists(path.join(p.brainPath, 'PROJECT.md')), saved: peek(p.brainPath) }))
      .sort((a, b) => (b.openedAt || b.createdAt || 0) - (a.openedAt || a.createdAt || 0)),
    found,
  };
}

// Remember when a project was last opened (for the start screen order).
export function touch(id: string) {
  const list = listProjects();
  const p = list.find((x) => x.id === id);
  if (p) {
    p.openedAt = Date.now();
    saveProjects(list);
  }
}
