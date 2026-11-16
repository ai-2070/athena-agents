// Projects: create, switch, and look inside a project's Brain folder (files, notes, GitHub).
import fs from 'node:fs';
import path from 'node:path';
import {
  HOME,
  ensureDir,
  exists,
  insideRoots,
  isPlainDir,
  realTarget,
  sameFolder,
  run,
  slugify,
  uid,
  which,
  dataPath,
} from './util.ts';
import { listProjects, saveProjects, activeProject, setActiveProject, log } from './store.ts';
import { toPercent } from '../shared/look.ts';
import type {
  Project,
  FolderEntry,
  FolderListing,
  FoundFolder,
  ProjectOverviewItem,
  ProjectPeek,
  ProjectsOverview,
  ProjectSummary,
  ProjectWithMedia,
  BrainEntry,
  BrainGit,
  BrainInfo,
} from '../shared/types.ts';

// (the shapes the page reads: shared/types.ts)
export type { FoundFolder, ProjectOverviewItem, ProjectsOverview, ProjectWithMedia };

const PROJECTS_ROOT = path.join(HOME, 'Documents', 'Athena Agents');
// Where projects went under the app's old names (Blacksite, My Dashboard). They stay there (each project
// knows its own folder); these are only searched for project folders the dashboard doesn't know yet.
const OLD_PROJECTS_ROOTS = [path.join(HOME, 'Documents', 'Blacksite'), path.join(HOME, 'Documents', 'My Dashboard')];
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
export async function createProject({
  name,
  mode = 'new',
  folder = '',
  repo = '',
  description = '',
}: CreateProjectInput): Promise<Project> {
  name = String(name || '').trim();
  if (!name) throw new Error('Give the project a name.');
  let brainPath = String(folder || '')
    .trim()
    .replace(/^"|"$/g, '');
  repo = String(repo || '').trim();
  // A folder is one project's: two would save over each other's copy in it (.dashboard)
  const owner = (dir: string) => listProjects().find((p) => sameFolder(p.brainPath, dir));
  const taken = brainPath ? owner(brainPath) : undefined;
  if (taken)
    throw new Error(
      mode === 'existing'
        ? `That folder is already the project "${taken.name}". Open it from your projects instead.`
        : `That folder belongs to the project "${taken.name}". Pick another folder.`,
    );
  if (mode === 'existing') {
    if (!brainPath || !exists(brainPath) || !fs.statSync(brainPath).isDirectory())
      throw new Error(`${brainPath || 'That folder'} doesn't exist.`);
  } else if (!brainPath) {
    // (a new folder named after the project, numbered when a project of that name already has it)
    const base = path.join(PROJECTS_ROOT, slugify(name));
    brainPath = base;
    for (let i = 2; owner(brainPath); i++) brainPath = `${base}-${i}`;
  }
  if (mode !== 'existing') {
    if (mode === 'github') {
      if (!repo) throw new Error('Which GitHub repo? Use owner/name or a URL.');
      if (exists(brainPath) && fs.readdirSync(brainPath).length)
        throw new Error(`${brainPath} already has files in it. Pick an empty or new folder.`);
      ensureDir(path.dirname(brainPath));
      const short = /^[\w.-]+\/[\w.-]+$/.test(repo);
      const r =
        which('gh') && short
          ? await run('gh', ['repo', 'clone', repo, brainPath], { timeout: 15 * 60_000 })
          : await run('git', ['clone', short ? `https://github.com/${repo}.git` : repo, brainPath], {
              timeout: 15 * 60_000,
            });
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
  const project: Project = {
    id,
    name,
    description: String(description || '')
      .trim()
      .slice(0, 6000),
    brainPath: path.resolve(brainPath),
    repo,
    createdAt: Date.now(),
  };
  saveProjects([...list, project]);
  setActiveProject(id);
  log('project', `Created project "${name}" (${mode === 'github' ? `cloned ${repo}` : brainPath})`);
  return project;
}

/** backgroundOpacity / mapDotsOpacity: 0-100, or null to go back to the default. */
export type ProjectPatch = Partial<Pick<Project, 'name' | 'description' | 'skills' | 'brainPath'>> & {
  backgroundOpacity?: unknown;
  mapDotsOpacity?: unknown;
  sidebar?: unknown;
};

export function updateProject(id: string, patch: ProjectPatch): Project {
  const list = listProjects();
  const p = list.find((x) => x.id === id);
  if (!p) throw new Error('No such project.');
  if (patch.name !== undefined) {
    const name = String(patch.name).trim().slice(0, 80);
    if (!name) throw new Error('Give the project a name.');
    if (name !== p.name) log('project', `Renamed the project "${p.name}" to "${name}"`);
    p.name = name;
  }
  if (typeof patch.description === 'string') p.description = patch.description.trim().slice(0, 6000);
  // skills every agent in the project gets
  if (Array.isArray(patch.skills)) p.skills = [...new Set(patch.skills.map(String))].slice(0, 100);
  if (patch.brainPath) {
    if (!exists(patch.brainPath)) throw new Error(`${patch.brainPath} doesn't exist.`);
    const taken = list.find((x) => x.id !== id && sameFolder(x.brainPath, String(patch.brainPath)));
    if (taken) throw new Error(`That folder belongs to the project "${taken.name}". Pick another folder.`);
    p.brainPath = path.resolve(patch.brainPath);
  }
  // how strong the Station's background picture and the map's dots are
  for (const key of ['backgroundOpacity', 'mapDotsOpacity'] as const) {
    const v = patch[key];
    if (v === undefined) continue;
    if (v === null) {
      delete p[key];
      continue;
    }
    const pct = toPercent(v);
    if (pct === null) throw new Error('An opacity is a percent from 0 to 100.');
    p[key] = pct;
  }
  // what the bottom of the sidebar last showed in this project (Status / Limits)
  if (patch.sidebar !== undefined) {
    if (patch.sidebar === null) delete p.sidebar;
    else if (patch.sidebar === 'status' || patch.sidebar === 'limits') p.sidebar = patch.sidebar;
    else throw new Error('The sidebar shows "status" or "limits".');
  }
  saveProjects(list);
  return p;
}

// Removes the project from the dashboard. Its Brain folder and files on disk stay where they are.
export function removeProject(id: string): Project[] {
  const list = listProjects();
  if (list.length <= 1) throw new Error('Keep at least one project.');
  const rest = list.filter((x) => x.id !== id);
  // (which one was open is read before the list changes: after it, the open one already reads as another)
  const open = activeProject().id;
  saveProjects(rest);
  if (open === id || !rest.some((x) => x.id === open)) setActiveProject(rest[0].id);
  return rest;
}

export function ensureBrain(p: Project = activeProject()): string {
  if (!exists(p.brainPath)) {
    ensureDir(p.brainPath);
    fs.writeFileSync(path.join(p.brainPath, 'BRAIN.md'), brainReadme(p.name));
  }
  return p.brainPath;
}

export type { BrainEntry, BrainGit, BrainInfo } from '../shared/types.ts';

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
    const g = (...args: string[]) =>
      run('git', ['-C', p.brainPath, ...args], { timeout: 15000 }).then((r) => r.stdout.trim());
    const [branch, remote, last, status] = await Promise.all([
      g('rev-parse', '--abbrev-ref', 'HEAD'),
      g('remote', 'get-url', 'origin'),
      g('log', '-1', '--format=%s · %cr'),
      g('status', '--porcelain'),
    ]);
    git = {
      branch,
      remote,
      url: remote.replace(/^git@github\.com:/, 'https://github.com/').replace(/\.git$/, ''),
      last,
      changes: status ? status.split('\n').length : 0,
    };
  }
  return {
    project: withLogo(p),
    entries: entries.slice(0, 60),
    files,
    sizeMB: +(bytes / 1e6).toFixed(1),
    git,
    summary: projectSummary(p),
  };
}

export function addNote(name: unknown, content: unknown, p: Project = activeProject()): string {
  ensureBrain(p);
  const dir = ensureDir(path.join(p.brainPath, 'notes'));
  const safe =
    String(name || 'note')
      .replace(/[^\w.\- ]+/g, '_')
      .replace(/\.md$/i, '') + '.md';
  const file = path.join(dir, safe);
  // a notes/ folder or a note that links out of the Brain folder (planted in a project folder) would write over a file elsewhere
  const real = insideRoots(file, [p.brainPath]);
  if (!real) throw new Error('That note is a link out of the Brain folder; not writing through it.');
  fs.writeFileSync(real, String(content || ''));
  return file;
}

/** A folder inside the Brain to open in Finder / Explorer: the Brain itself when none is given. Only a real
 *  folder there (opening a file would run it, and a link may point out of the Brain). */
export function brainFolder(sub: unknown, p: Project = activeProject()): string {
  const root = ensureBrain(p);
  if (sub == null || sub === '') return root;
  const target = path.resolve(root, String(sub));
  const real = insideRoots(target, [root]);
  if (!real || !isPlainDir(real))
    throw Object.assign(new Error('That folder isn’t in the Brain folder.'), { status: 403 });
  return real;
}

/** One folder of a project (its folders first; build outputs, dependencies and .git left out). */
export function folderListing(sub: unknown, p: Project = activeProject(), max = 1000): FolderListing {
  // (real paths on both sides: the project folder itself can sit under a link, as /var does on a Mac)
  const dir = realTarget(brainFolder(sub, p)) || brainFolder(sub, p);
  const root = realTarget(ensureBrain(p)) || ensureBrain(p);
  const rel = path.relative(root, dir).split(path.sep).join('/');
  let list: fs.Dirent[] = [];
  try {
    list = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    /* unreadable: empty */
  }
  const entries: FolderEntry[] = [];
  for (const e of list) {
    if (SKIP.has(e.name) || e.isSymbolicLink()) continue;
    const full = path.join(dir, e.name);
    const dirEntry = e.isDirectory();
    let size: number | undefined;
    if (!dirEntry) {
      try {
        size = fs.statSync(full).size;
      } catch {
        continue;
      }
    }
    entries.push({
      name: e.name,
      dir: dirEntry,
      ...(size !== undefined ? { size } : {}),
      path: full,
      rel: rel ? `${rel}/${e.name}` : e.name,
    });
  }
  entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
  return { rel, entries: entries.slice(0, max), more: Math.max(0, entries.length - max) };
}

export async function gitPull(p: Project = activeProject()): Promise<string> {
  const r = await run('git', ['-C', p.brainPath, 'pull', '--ff-only'], { timeout: 5 * 60_000 });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().slice(-500));
  return r.stdout.trim() || 'Up to date.';
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
  for (const root of [PROJECTS_ROOT, ...OLD_PROJECTS_ROOTS]) {
    try {
      for (const e of fs.readdirSync(root, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        const dir = path.join(root, e.name);
        if (known.has(path.resolve(dir).toLowerCase())) continue;
        const saved = peek(dir);
        const hasBrief = ['PROJECT.md', 'BRAIN.md'].find((f) => exists(path.join(dir, f)));
        if (saved || hasBrief) found.push({ name: saved?.name || e.name, folder: dir, brief: hasBrief, saved });
      }
    } catch {
      /* no projects folder there */
    }
  }
  return {
    active: activeProject().id,
    root: PROJECTS_ROOT,
    projects: list
      .map((p) => ({
        ...withLogo(p),
        agents: count(p.id, 'agents'),
        teams: count(p.id, 'workflows'),
        hasProjectMd: exists(path.join(p.brainPath, 'PROJECT.md')),
        saved: peek(p.brainPath),
      }))
      .sort((a, b) => (b.openedAt || b.createdAt || 0) - (a.openedAt || a.createdAt || 0)),
    found,
  };
}

// The start screen: shown once each time the dashboard starts, until you pick, make or restore a project.
let startScreen = true;
/** Whether the start screen is still to be shown. */
export const startScreenPending = (): boolean => startScreen;
/** A project was picked, made or restored, or the start screen closed. */
export function startScreenDone(): void {
  startScreen = false;
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

// ---------- the project's logo ----------
// Kept in the project folder (.dashboard/logo.<ext>), so it travels with the folder like the
// auto-saved agents and teams. PNG, JPG, WebP or GIF only: an SVG could carry scripts.
const LOGO_EXT = ['png', 'jpg', 'webp', 'gif'] as const;
const LOGO_MAX = 3 * 1024 * 1024;

// .dashboard/<name> only when it is a plain file in a plain .dashboard folder: a link planted in the
// project folder could point at any file on the PC, and these are served to the page.
function mediaFile(p: Project, name: string): string | null {
  const dir = path.join(p.brainPath, '.dashboard');
  if (!isPlainDir(dir)) return null;
  const f = path.join(dir, name);
  try {
    return fs.lstatSync(f).isFile() ? f : null;
  } catch {
    return null;
  }
}

export function logoFile(p: Project): string | null {
  for (const ext of LOGO_EXT) {
    const f = mediaFile(p, `logo.${ext}`);
    if (f) return f;
  }
  return null;
}

// When a file last changed, or null (just removed).
const changedAt = (f: string | null): number | null => {
  if (!f) return null;
  try {
    return Math.round(fs.statSync(f).mtimeMs);
  } catch {
    return null;
  }
};

/** A project as the page gets it: plus when its logo, 3D model and background last changed. */
/** The project plus when its logo, its 3D model and its background last changed (the page adds it to their URLs so a new one shows at once). */
export function withLogo(p: Project): ProjectWithMedia {
  const m = modelFile(p);
  const modelAt = changedAt(m);
  return {
    ...p,
    logoAt: changedAt(logoFile(p)),
    modelAt,
    modelExt: m && modelAt ? path.extname(m).slice(1) : null,
    backgroundAt: changedAt(backgroundFile(p)),
  };
}

// What the bytes really are (the data URL's type is only what the browser says).
export function sniffImage(buf: Buffer): (typeof LOGO_EXT)[number] | null {
  if (buf.length > 8 && buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') return 'png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 6 && buf.toString('ascii', 0, 3) === 'GIF') return 'gif';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP')
    return 'webp';
  return null;
}

function logoDir(p: Project): string {
  const dir = ensureDir(path.join(p.brainPath, '.dashboard'));
  // never write through a link someone planted in the project folder
  if (fs.lstatSync(dir).isSymbolicLink())
    throw new Error("The project's .dashboard folder is a link; not writing there.");
  return dir;
}

// Saves an image as .dashboard/<base>.<its real type>, in place of the old one (of any type).
function writeImage(p: Project, base: string, buf: Buffer, max: number): void {
  if (buf.length > max) throw new Error(`That image is too big (${max / 1048576} MB at most).`);
  const ext = sniffImage(buf);
  if (!ext) throw new Error('Pick a PNG, JPG, WebP or GIF image.');
  const dir = logoDir(p);
  for (const e of LOGO_EXT) {
    const old = path.join(dir, `${base}.${e}`);
    if (fs.existsSync(old) || isLink(old)) fs.rmSync(old, { force: true });
  }
  fs.writeFileSync(path.join(dir, `${base}.${ext}`), buf);
}

// The bytes of an image data URL (the page sends pictures this way).
function imageData(dataUrl: unknown): Buffer {
  const m = /^data:image\/[a-z+.-]+;base64,([A-Za-z0-9+/=\s]+)$/i.exec(String(dataUrl || ''));
  if (!m) throw new Error('Pick a PNG, JPG, WebP or GIF image.');
  return Buffer.from(m[1], 'base64');
}

const needProject = (id: string): Project => {
  const p = listProjects().find((x) => x.id === id);
  if (!p) throw new Error('No such project.');
  return p;
};

export function setLogo(id: string, dataUrl: unknown): ProjectWithMedia {
  const p = needProject(id);
  writeImage(p, 'logo', imageData(dataUrl), LOGO_MAX);
  log('project', `New logo for "${p.name}"`);
  return withLogo(p);
}

export function removeLogo(id: string): ProjectWithMedia {
  const p = needProject(id);
  const dir = path.join(p.brainPath, '.dashboard');
  // (not through a .dashboard that links elsewhere: that would delete files there)
  if (isPlainDir(dir)) for (const e of LOGO_EXT) fs.rmSync(path.join(dir, `logo.${e}`), { force: true });
  return withLogo(p);
}

// ---------- the project's background ----------
// A picture behind the Station's map, in the classic look and the voxel look (where it takes the sky's
// place). Kept next to the logo (.dashboard/background.<ext>), so it travels with the folder.
export const BACKGROUND_MAX = 12 * 1024 * 1024;

export function backgroundFile(p: Project): string | null {
  for (const ext of LOGO_EXT) {
    const f = mediaFile(p, `background.${ext}`);
    if (f) return f;
  }
  return null;
}

export function setBackground(id: string, dataUrl: unknown): ProjectWithMedia {
  const p = needProject(id);
  writeImage(p, 'background', imageData(dataUrl), BACKGROUND_MAX);
  log('project', `New background for "${p.name}"`);
  return withLogo(p);
}

/** A copy of an image file on this PC becomes the background. The caller checks the file may be read. */
export function setBackgroundFromFile(id: string, file: string): ProjectWithMedia {
  const p = needProject(id);
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    throw new Error(`There is no file at ${file}.`);
  }
  if (!st.isFile()) throw new Error(`${file} is not a file.`);
  // (before reading it: a huge file isn't read only to be refused)
  if (st.size > BACKGROUND_MAX) throw new Error(`That image is too big (${BACKGROUND_MAX / 1048576} MB at most).`);
  writeImage(p, 'background', fs.readFileSync(file), BACKGROUND_MAX);
  log('project', `New background for "${p.name}"`);
  return withLogo(p);
}

export function removeBackground(id: string): ProjectWithMedia {
  const p = needProject(id);
  const dir = path.join(p.brainPath, '.dashboard');
  if (isPlainDir(dir)) for (const e of LOGO_EXT) fs.rmSync(path.join(dir, `background.${e}`), { force: true });
  return withLogo(p);
}

// ---------- the project's 3D model ----------
// Replaces the logo inside the Brain's globe. Kept next to the logo (.dashboard/brain-model.<ext>). Only the formats the page can
// draw, and each file must really be one (its first bytes are checked).
export const MODEL_EXT = ['glb', 'gltf', 'obj', 'stl', 'ply', 'fbx'] as const;
export const MODEL_MAX = 15 * 1024 * 1024;

export function modelFile(p: Project): string | null {
  for (const ext of MODEL_EXT) {
    const f = mediaFile(p, `brain-model.${ext}`);
    if (f) return f;
  }
  return null;
}

/** Is this buffer really a model of the type its name says? */
export function looksLikeModel(ext: string, buf: Buffer): boolean {
  const head = buf.toString('latin1', 0, 4096);
  switch (ext) {
    case 'glb':
      return buf.length > 12 && buf.toString('ascii', 0, 4) === 'glTF';
    case 'gltf':
      try {
        return typeof (JSON.parse(buf.toString('utf8')) as { asset?: unknown }).asset === 'object';
      } catch {
        return false;
      }
    case 'ply':
      return head.startsWith('ply');
    case 'fbx':
      return head.startsWith('Kaydara FBX Binary') || head.startsWith('; FBX');
    case 'stl':
      // ASCII starts with "solid"; binary is an 80-byte header, a triangle count and 50 bytes per triangle
      return head.trimStart().startsWith('solid') || (buf.length > 84 && buf.length === 84 + 50 * buf.readUInt32LE(80));
    case 'obj':
      return /^\s*(#|mtllib|o |g |v |vn |vt |f )/m.test(head) && /^\s*v\s/m.test(head);
    default:
      return false;
  }
}

export function setModel(id: string, name: unknown, dataUrl: unknown): ProjectWithMedia {
  const p = needProject(id);
  const ext = path
    .extname(String(name || ''))
    .slice(1)
    .toLowerCase();
  if (!(MODEL_EXT as readonly string[]).includes(ext))
    throw new Error(`Pick a 3D model file: ${MODEL_EXT.map((e) => `.${e}`).join(', ')}.`);
  const m = /^data:[^,]*;base64,([A-Za-z0-9+/=\s]+)$/i.exec(String(dataUrl || ''));
  if (!m) throw new Error("Couldn't read that file.");
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length > MODEL_MAX) throw new Error(`That model is too big (${MODEL_MAX / 1048576} MB at most).`);
  if (!looksLikeModel(ext, buf)) throw new Error(`That file isn't a real .${ext} model.`);
  const dir = logoDir(p);
  for (const e of MODEL_EXT) {
    const old = path.join(dir, `brain-model.${e}`);
    if (fs.existsSync(old) || isLink(old)) fs.rmSync(old, { force: true });
  }
  fs.writeFileSync(path.join(dir, `brain-model.${ext}`), buf);
  log('project', `New 3D model for "${p.name}"`);
  return withLogo(p);
}

export function removeModel(id: string): ProjectWithMedia {
  const p = needProject(id);
  const dir = path.join(p.brainPath, '.dashboard');
  if (isPlainDir(dir)) for (const e of MODEL_EXT) fs.rmSync(path.join(dir, `brain-model.${e}`), { force: true });
  return withLogo(p);
}

const isLink = (f: string): boolean => {
  try {
    return fs.lstatSync(f).isSymbolicLink();
  } catch {
    return false;
  }
};

// ---------- a short description for the Brain panel ----------
// What the user said the project is, or else the first real paragraph of PROJECT.md / README.
export function projectSummary(p: Project = activeProject()): ProjectSummary {
  if (p.description?.trim()) return { text: p.description.trim(), from: 'description' };
  for (const name of ['PROJECT.md', 'README.md'] as const) {
    let text = '';
    try {
      text = fs.readFileSync(path.join(p.brainPath, name), 'utf8');
    } catch {
      continue;
    }
    const para = text
      .split(/\r?\n\s*\r?\n/)
      .map((b) => b.trim())
      .find(
        (b) =>
          b &&
          !b.startsWith('#') &&
          !b.startsWith('<') &&
          !b.startsWith('![') &&
          !b.startsWith('|') &&
          !b.startsWith('```'),
      );
    if (para) return { text: para.replace(/\s+/g, ' ').slice(0, 500), from: name };
  }
  return { text: '', from: null };
}
