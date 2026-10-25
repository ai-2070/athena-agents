// Auto-save: every project keeps a copy of its agents, teams, layout, team chats, Brain chat and
// agent knowledge files inside its own folder (<project folder>/.dashboard). A few seconds after
// any change it is saved again. Opening that folder as a project (here or on another PC) restores it.
// Keys and tokens are never written there.
import fs from 'node:fs';
import path from 'node:path';
import { bus, listProjects, activeProject, log } from './store.ts';
import { dataPath, ensureDir, exists, readJSON, writeJSON } from './util.ts';
import type { Agent, Team } from '../shared/types.ts';

/** The last auto-save of a project (AppState.projectSaved). */
export interface SaveStatus {
  at: number;
  error?: string;
  agents?: number;
  teams?: number;
}

/** <project folder>/.dashboard/project.json */
export interface SavedProjectFile {
  format: number;
  app: string;
  savedAt: number;
  project: { name?: string; description?: string; repo?: string; skills?: string[] };
  agents: Agent[];
  teams: Team[];
  layout: unknown;
  brainChat: unknown;
}

/** What a folder holds, if the dashboard saved a project in it. */
export interface ProjectPeek {
  name: string;
  description: string;
  agents: number;
  teams: number;
  savedAt: number;
}

export interface RestoreResult {
  agents: number;
  teams: number;
  project: SavedProjectFile['project'];
}

const FORMAT = 1;
const DIR = '.dashboard';
const KNOWLEDGE_CAP = 50 * 1024 * 1024; // don't copy more than 50 MB of knowledge files
const saved = new Map<string, SaveStatus>(); // projectId -> { at, error }
const timers = new Map<string, ReturnType<typeof setTimeout>>();

const projectDir = (id: string, ...p: string[]) => dataPath('projects', id, ...p);
const jsonFiles = (dir: string): string[] => {
  try {
    return fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
};
const readAll = <T>(dir: string): T[] => jsonFiles(dir).map((n) => readJSON<T>(path.join(dir, n))).filter((x): x is T => Boolean(x));

function copyTree(from: string, to: string, budget: number): number {
  let used = 0;
  const walk = (src: string, dst: string) => {
    let list: fs.Dirent[] = [];
    try {
      list = fs.readdirSync(src, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of list) {
      const a = path.join(src, e.name);
      const b = path.join(dst, e.name);
      if (e.isDirectory()) walk(a, b);
      else if (e.isFile()) {
        const st = fs.statSync(a);
        if (used + st.size > budget) continue;
        used += st.size;
        // skip files that haven't changed
        try {
          const old = fs.statSync(b);
          if (old.size === st.size && old.mtimeMs >= st.mtimeMs) continue;
        } catch {
          /* new file */
        }
        ensureDir(path.dirname(b));
        fs.copyFileSync(a, b);
      }
    }
  };
  walk(from, to);
  return used;
}

// Write the project's copy into its folder now.
export function saveProject(id: string): SaveStatus | null {
  const p = listProjects().find((x) => x.id === id);
  if (!p || !exists(p.brainPath)) return null;
  try {
    const out = ensureDir(path.join(p.brainPath, DIR));
    const agents = readAll<Agent>(projectDir(id, 'agents'));
    const teams = readAll<Team>(projectDir(id, 'workflows'));
    const file = path.join(out, 'project.json');
    // Fewer agents or teams than last time: keep the old copy as a backup first (last 10 kept).
    const prev = readJSON<Partial<SavedProjectFile>>(file, null);
    if (prev && ((prev.agents || []).length > agents.length || (prev.teams || []).length > teams.length)) {
      const bdir = ensureDir(path.join(out, 'backups'));
      fs.copyFileSync(file, path.join(bdir, `project-${new Date(prev.savedAt || Date.now()).toISOString().replace(/[:.]/g, '-')}.json`));
      const old = fs.readdirSync(bdir).filter((n) => n.endsWith('.json')).sort();
      for (const n of old.slice(0, Math.max(0, old.length - 10))) fs.rmSync(path.join(bdir, n), { force: true });
    }
    writeJSON<SavedProjectFile>(file, {
      format: FORMAT,
      app: 'my-dashboard',
      savedAt: Date.now(),
      project: { name: p.name, description: p.description || '', repo: p.repo || '', skills: p.skills || [] },
      agents,
      teams,
      layout: readJSON<unknown>(projectDir(id, 'layout.json'), {}),
      brainChat: readJSON<unknown>(projectDir(id, 'brain-chat.json'), { messages: [] }),
    });
    // team chat threads
    const tc = projectDir(id, 'teamchats');
    for (const n of jsonFiles(tc)) {
      const dst = path.join(out, 'teamchats', n);
      const src = path.join(tc, n);
      const st = fs.statSync(src);
      if (exists(dst) && fs.statSync(dst).mtimeMs >= st.mtimeMs) continue;
      ensureDir(path.dirname(dst));
      fs.copyFileSync(src, dst);
    }
    // files you gave agents as knowledge
    copyTree(projectDir(id, 'knowledge'), path.join(out, 'knowledge'), KNOWLEDGE_CAP);
    fs.writeFileSync(
      path.join(out, 'README.txt'),
      'My Dashboard keeps this project\'s agents, teams, chats and knowledge here (auto-saved).\nOpen this folder as a project in the dashboard ("Open a folder…") to load them again.\nNo keys or passwords are stored here.\n',
    );
    saved.set(id, { at: Date.now(), agents: agents.length, teams: teams.length });
    return saved.get(id) ?? null;
  } catch (e) {
    saved.set(id, { at: Date.now(), error: (e as Error).message });
    return saved.get(id) ?? null;
  }
}

const firstAsk = new Map<string, number>();
export function saveSoon(id: string = activeProject().id, ms = 2500) {
  // keep pushing the save back while things change, but never more than 15 s
  if (!firstAsk.has(id)) firstAsk.set(id, Date.now());
  const wait = Math.max(0, Math.min(ms, firstAsk.get(id)! + 15_000 - Date.now()));
  clearTimeout(timers.get(id));
  timers.set(
    id,
    setTimeout(() => {
      timers.delete(id);
      firstAsk.delete(id);
      saveProject(id);
    }, wait),
  );
}

export function saveStatus(id: string = activeProject().id): SaveStatus | null {
  return saved.get(id) || null;
}

// What a folder holds, if it was saved by the dashboard.
export function peek(folder: string): ProjectPeek | null {
  const f = path.join(folder, DIR, 'project.json');
  if (!exists(f)) return null;
  const j = readJSON<Partial<SavedProjectFile>>(f, null);
  if (!j || j.app !== 'my-dashboard') return null;
  return { name: j.project?.name || '', description: j.project?.description || '', agents: (j.agents || []).length, teams: (j.teams || []).length, savedAt: j.savedAt || 0 };
}

// Load a saved copy into a project that has no agents yet (a folder you just opened).
export function restoreInto(id: string, folder: string): RestoreResult | null {
  const f = path.join(folder, DIR, 'project.json');
  const j = exists(f) ? readJSON<Partial<SavedProjectFile>>(f, null) : null;
  if (!j || j.app !== 'my-dashboard') return null;
  if (jsonFiles(projectDir(id, 'agents')).length) return null; // never overwrite a project that has agents
  const safe = (x: { id?: unknown } | null | undefined) => typeof x?.id === 'string' && /^[\w.-]+$/.test(x.id);
  for (const a of (j.agents || []).filter(safe)) writeJSON(projectDir(id, 'agents', `${a.id}.json`), a);
  for (const t of (j.teams || []).filter(safe)) writeJSON(projectDir(id, 'workflows', `${t.id}.json`), t);
  if (j.layout) writeJSON(projectDir(id, 'layout.json'), j.layout);
  if (j.brainChat) writeJSON(projectDir(id, 'brain-chat.json'), j.brainChat);
  const tc = path.join(folder, DIR, 'teamchats');
  for (const n of jsonFiles(tc)) {
    ensureDir(projectDir(id, 'teamchats'));
    fs.copyFileSync(path.join(tc, n), projectDir(id, 'teamchats', n));
  }
  copyTree(path.join(folder, DIR, 'knowledge'), projectDir(id, 'knowledge'), KNOWLEDGE_CAP * 4);
  log('project', `Loaded ${(j.agents || []).length} agents and ${(j.teams || []).length} teams from ${folder}`);
  return { agents: (j.agents || []).length, teams: (j.teams || []).length, project: j.project || {} };
}

// Save after anything in the project changes.
const WATCH = new Set(['agents', 'workflows', 'layout', 'team', 'knowledge', 'brain-chat']);
export function startAutoSave() {
  bus.on('event', (ev) => {
    if (WATCH.has(ev.type)) saveSoon(activeProject().id);
    else if (ev.type === 'project') saveSoon(activeProject().id, 500);
  });
  // and every 5 minutes, for anything that changed without an event (e.g. knowledge files)
  setInterval(() => saveProject(activeProject().id), 5 * 60_000).unref?.();
  // first save for every project, so each folder has its copy
  setTimeout(() => {
    for (const p of listProjects()) saveProject(p.id);
  }, 4000);
}
