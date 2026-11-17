// A project's scene and its versions (docs/internal/plans/HTML_SCENE_PLAN.md §3). The scene is a folder in the
// project (.dashboard/scene/) that agents edit with their own file tools, so versions come from looking at the
// folder, not from a tool: whoever changed it, the change is kept. The versions live in the data folder, out of
// reach of agents' file tools, so a careless edit can't damage the history meant to undo it.
//
// A version is a list of files by content hash; each content is stored once (blobs/<sha256>). The Station shows a
// version (never the live folder) and reports whether it loads; a version that doesn't never replaces one that does.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { emit, listProjects, activeProject } from '../store.ts';
import { dataPath, ensureDir, isPlainDir, readJSON, uid, writeJSON } from '../util.ts';
import { SCENE_LIMITS, sceneType } from '../../shared/scene.ts';
import type { Project, SceneAuthor, SceneVersion, SceneVersions } from '../../shared/types.ts';

/** How many versions are kept, at least (plus pinned ones, and the newest one that loads of each recent day). */
const KEEP_LAST = 200;
const KEEP_DAYS = 30;
/** The history's size; over it, the oldest versions that aren't kept for another reason go first. */
const HISTORY_BYTES = 200 * 1024 * 1024;
/** How long the folder must stay the same before a change is kept (an agent writes several files in a row). */
export const SETTLE_MS = 1500;
const POLL_MS = 1000;
/** How long a project a tab showed the scene of is watched after the tab last asked. */
const WATCH_OPENED_MS = 10 * 60_000;

export const sceneDir = (p: Project): string => path.join(p.brainPath, '.dashboard', 'scene');
const historyDir = (p: Project): string => dataPath('projects', p.id, 'scene-history');
const blobFile = (p: Project, hash: string): string => path.join(historyDir(p), 'blobs', hash);
const versionsDir = (p: Project): string => path.join(historyDir(p), 'versions');

// ---------- reading the folder ----------
interface FolderFile {
  rel: string;
  abs: string;
  size: number;
  mtime: number;
}
interface Folder {
  /** the folder is there (a plain folder, not a link) */
  present: boolean;
  files: FolderFile[];
  /** why it can't be kept as a version, or null */
  problem: string | null;
  /** files left out: hidden, links, or of a type a scene can't hold */
  skipped: string[];
}

/** The scene folder's files (no reading of contents: sizes and times only), and what is wrong with it. */
export function scanScene(p: Project): Folder {
  const dash = path.join(p.brainPath, '.dashboard');
  const root = sceneDir(p);
  const out: Folder = { present: false, files: [], problem: null, skipped: [] };
  let st: fs.Stats;
  try {
    st = fs.lstatSync(root);
  } catch {
    return out;
  }
  // never through a link planted in the project folder: it could point at any folder on the PC
  if (!isPlainDir(dash) || !st.isDirectory()) {
    out.problem = 'The scene folder is a link or not a folder, so Athena does not read it.';
    return out;
  }
  out.present = true;
  let total = 0;
  const walk = (dir: string, rel: string, depth: number): void => {
    let names: string[];
    try {
      names = fs.readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of names) {
      const r = rel ? `${rel}/${name}` : name;
      if (name.startsWith('.')) continue;
      const abs = path.join(dir, name);
      let s: fs.Stats;
      try {
        s = fs.lstatSync(abs);
      } catch {
        continue;
      }
      if (s.isSymbolicLink()) {
        out.skipped.push(`${r} (a link)`);
        continue;
      }
      if (s.isDirectory()) {
        if (depth >= SCENE_LIMITS.depth) out.skipped.push(`${r}/ (too deep)`);
        else walk(abs, r, depth + 1);
        continue;
      }
      if (!s.isFile()) continue;
      if (!sceneType(r)) {
        out.skipped.push(`${r} (a scene can't use this type of file)`);
        continue;
      }
      if (s.size > SCENE_LIMITS.fileBytes && !out.problem)
        out.problem = `${r} is ${mb(s.size)}; a scene file can be ${mb(SCENE_LIMITS.fileBytes)} at most.`;
      total += s.size;
      out.files.push({ rel: r, abs, size: s.size, mtime: s.mtimeMs });
    }
  };
  walk(root, '', 0);
  if (out.problem) return out;
  if (out.files.length > SCENE_LIMITS.files)
    out.problem = `The scene has ${out.files.length} files; it can have ${SCENE_LIMITS.files} at most.`;
  else if (total > SCENE_LIMITS.totalBytes)
    out.problem = `The scene is ${mb(total)}; it can be ${mb(SCENE_LIMITS.totalBytes)} at most.`;
  else if (!out.files.some((f) => f.rel === 'index.html')) out.problem = 'The scene has no index.html.';
  else if (out.files.find((f) => f.rel === 'index.html')?.size === 0) out.problem = "The scene's index.html is empty.";
  return out;
}

const mb = (n: number): string => `${(n / 1048576).toFixed(n < 1048576 ? 2 : 1)} MB`;

/** A quick fingerprint of the folder (paths, sizes, times): it changes when a file does. */
const signature = (f: Folder): string =>
  f.present ? f.files.map((x) => `${x.rel}:${x.size}:${Math.round(x.mtime)}`).join('|') + `#${f.problem}` : 'none';

// ---------- versions ----------
const cache = new Map<string, SceneVersion[]>();
/** why the folder's latest state isn't a version, by project */
const problems = new Map<string, string | null>();

/** The project's versions, newest first. */
export function sceneVersions(p: Project): SceneVersion[] {
  const hit = cache.get(p.id);
  if (hit) return hit;
  const dir = versionsDir(p);
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    /* no history yet */
  }
  const list = names
    .map((n) => readJSON<SceneVersion>(path.join(dir, n)))
    .filter((v): v is SceneVersion => !!v && typeof v.id === 'string' && !!v.files && typeof v.at === 'number')
    .sort(newestFirst);
  cache.set(p.id, list);
  return list;
}
const newestFirst = (a: SceneVersion, b: SceneVersion): number => b.at - a.at || (a.id < b.id ? 1 : -1);

export const sceneVersion = (p: Project, id: string): SceneVersion | null =>
  sceneVersions(p).find((v) => v.id === id) || null;

/** What the Station needs to pick the version to show, and the versions list. */
export function sceneOverview(p: Project): SceneVersions {
  const versions = sceneVersions(p);
  const present = scanScene(p).present;
  return {
    versions,
    newest: versions[0]?.id ?? null,
    newestGood: versions.find((v) => v.loads === 'ok')?.id ?? null,
    present,
    problem: problems.get(p.id) ?? null,
  };
}

/** When the project's scene last changed (its newest version), or null when it has none. */
export function sceneAt(p: Project): number | null {
  const v = sceneVersions(p)[0];
  // (only whether the folder is there: this runs for every project in a list)
  return v && isPlainDir(path.join(p.brainPath, '.dashboard')) && isPlainDir(sceneDir(p)) ? v.at : null;
}

function saveVersion(p: Project, v: SceneVersion): void {
  writeJSON(path.join(versionsDir(p), `${v.id}.json`), v);
  const list = sceneVersions(p).filter((x) => x.id !== v.id);
  list.push(v);
  cache.set(p.id, list.sort(newestFirst));
}

const sameFiles = (a: SceneVersion['files'], b: SceneVersion['files']): boolean => {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => b[k]?.hash === a[k].hash);
};

/** Keeps the folder as it is now as a new version, unless it is the same as the newest one (or can't be kept:
 *  over the limits, no index.html). Returns the new version, or null. */
export function takeVersion(p: Project, by: SceneAuthor, note?: string): SceneVersion | null {
  const folder = scanScene(p);
  const was = problems.get(p.id) ?? null;
  problems.set(p.id, folder.problem);
  if (!folder.present || folder.problem) {
    if (folder.problem !== was) emit('scene', { project: p.id });
    return null;
  }
  const files: SceneVersion['files'] = {};
  const contents = new Map<string, Buffer>();
  for (const f of folder.files) {
    let buf: Buffer;
    try {
      buf = fs.readFileSync(f.abs);
    } catch {
      return null; // (removed while reading: the next look takes it)
    }
    const hash = crypto.createHash('sha256').update(buf).digest('hex');
    files[f.rel] = { hash, size: buf.length };
    contents.set(hash, buf);
  }
  const newest = sceneVersions(p)[0];
  if (newest && sameFiles(newest.files, files)) {
    if (was) emit('scene', { project: p.id });
    return null;
  }
  ensureDir(path.join(historyDir(p), 'blobs'));
  for (const [hash, buf] of contents) {
    const file = blobFile(p, hash);
    if (fs.existsSync(file)) continue;
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, file);
  }
  // (one millisecond apart at least, so versions keep their order)
  const at = Math.max(Date.now(), (newest?.at ?? 0) + 1);
  const v: SceneVersion = { id: uid('sv-'), at, by, ...(note ? { note } : {}), files };
  saveVersion(p, v);
  pruneVersions(p);
  emit('scene', { project: p.id, version: v.id });
  return v;
}

/** A file of a version, or null. */
export function versionFile(p: Project, v: SceneVersion, rel: string): Buffer | null {
  const f = v.files[rel];
  if (!f || !/^[0-9a-f]{64}$/.test(f.hash)) return null;
  try {
    return fs.readFileSync(blobFile(p, f.hash));
  } catch {
    return null;
  }
}

/** How a version loaded in a tab. The first answer counts; a version that loaded can still turn out to freeze
 *  the tab (broken), but a broken one never becomes good again (it is the same files). */
export function markLoaded(p: Project, id: string, loads: 'ok' | 'broken', error?: string): SceneVersion | null {
  const v = sceneVersion(p, id);
  if (!v || v.loads === loads || v.loads === 'broken') return v;
  const next: SceneVersion = { ...v, loads, ...(loads === 'broken' && error ? { error: error.slice(0, 2000) } : {}) };
  if (loads === 'ok') delete next.error;
  saveVersion(p, next);
  emit('scene', { project: p.id, version: id, loads });
  return next;
}

export function pinVersion(p: Project, id: string, pinned: boolean): SceneVersion | null {
  const v = sceneVersion(p, id);
  if (!v) return null;
  const next: SceneVersion = { ...v };
  if (pinned) next.pinned = true;
  else delete next.pinned;
  saveVersion(p, next);
  if (!pinned) pruneVersions(p);
  emit('scene', { project: p.id, version: id });
  return next;
}

const when = (at: number): string =>
  new Date(at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** Writes a version (or one file of it) back into the scene folder, then keeps that as a new version: going back
 *  is itself a change, so it can be undone too. Later versions stay. */
export function restoreVersion(p: Project, id: string, by: SceneAuthor, onlyPath?: string): SceneVersion | null {
  const v = sceneVersion(p, id);
  if (!v) throw new Error('There is no such version of the scene.');
  if (onlyPath !== undefined && !v.files[onlyPath]) throw new Error(`That version has no file ${onlyPath}.`);
  const dash = path.join(p.brainPath, '.dashboard');
  const root = sceneDir(p);
  ensureDir(dash);
  if (!isPlainDir(dash)) throw new Error("The project's .dashboard folder is a link; not writing there.");
  ensureDir(root);
  if (!isPlainDir(root)) throw new Error('The scene folder is a link; not writing there.');
  const wanted = onlyPath !== undefined ? [onlyPath] : Object.keys(v.files);
  // first everything that will be written, so a missing blob changes nothing
  const bufs = new Map<string, Buffer>();
  for (const rel of wanted) {
    const buf = versionFile(p, v, rel);
    if (!buf) throw new Error(`The kept copy of ${rel} is missing, so this version can't be brought back.`);
    bufs.set(rel, buf);
  }
  if (onlyPath === undefined)
    // files that version didn't have go (only the kind a version would hold: other files are left alone)
    for (const f of scanScene(p).files) if (!v.files[f.rel]) fs.rmSync(f.abs, { force: true });
  for (const [rel, buf] of bufs) {
    const file = path.join(root, ...rel.split('/'));
    // (every folder on the way must be a plain one inside the scene folder)
    let dir = root;
    for (const part of rel.split('/').slice(0, -1)) {
      dir = path.join(dir, part);
      ensureDir(dir);
      if (!isPlainDir(dir)) throw new Error(`${path.relative(root, dir)} is a link; not writing there.`);
    }
    try {
      if (fs.lstatSync(file).isSymbolicLink()) fs.rmSync(file, { force: true });
    } catch {
      /* not there yet */
    }
    fs.writeFileSync(file, buf);
  }
  const note =
    onlyPath !== undefined
      ? `Brought back ${onlyPath} from the version of ${when(v.at)}`
      : `Went back to the version of ${when(v.at)}`;
  const made = takeVersion(p, by, note);
  // the folder already was that version: the Station shows it again all the same
  if (!made) emit('scene', { project: p.id });
  return made;
}

/** Keeps the last versions, pinned ones, the newest one that loads (and of each recent day), within the history's
 *  size; deletes the rest and the files no version uses any more. */
export function pruneVersions(p: Project): void {
  const list = sceneVersions(p);
  const keep = new Set<string>();
  list.slice(0, KEEP_LAST).forEach((v) => keep.add(v.id));
  const good = list.filter((v) => v.loads === 'ok');
  if (good[0]) keep.add(good[0].id);
  const since = Date.now() - KEEP_DAYS * 86_400_000;
  const days = new Set<string>();
  for (const v of good) {
    const day = new Date(v.at).toDateString();
    if (v.at >= since && !days.has(day)) {
      days.add(day);
      keep.add(v.id);
    }
  }
  for (const v of list) if (v.pinned) keep.add(v.id);
  let kept = list.filter((v) => keep.has(v.id));
  // over the size: the oldest go first, except the newest, the newest that loads and pinned ones
  const sizeOf = (vs: SceneVersion[]) => {
    const seen = new Map<string, number>();
    for (const v of vs) for (const f of Object.values(v.files)) seen.set(f.hash, f.size);
    let n = 0;
    for (const s of seen.values()) n += s;
    return n;
  };
  while (kept.length > 2 && sizeOf(kept) > HISTORY_BYTES) {
    const drop = [...kept].reverse().find((v) => !v.pinned && v.id !== kept[0].id && v.id !== good[0]?.id);
    if (!drop) break;
    kept = kept.filter((v) => v !== drop);
  }
  const gone = list.filter((v) => !kept.includes(v));
  if (!gone.length) return;
  for (const v of gone) fs.rmSync(path.join(versionsDir(p), `${v.id}.json`), { force: true });
  cache.set(p.id, kept);
  const used = new Set(kept.flatMap((v) => Object.values(v.files).map((f) => f.hash)));
  let blobs: string[] = [];
  try {
    blobs = fs.readdirSync(path.join(historyDir(p), 'blobs'));
  } catch {
    return;
  }
  for (const b of blobs) if (!used.has(b)) fs.rmSync(blobFile(p, b), { force: true });
}

// ---------- watching ----------
// The open project's scene folder (and the projects tabs showed a scene of lately) is looked at once a second:
// paths, sizes and times only. When it changed and then stayed the same for SETTLE_MS, it is kept as a version.
// (A look rather than fs.watch: it is the same on every system, sees the folder being made, and is cheap for a
// folder of a few hundred files at most.)
interface Watch {
  sig: string | null;
  changedAt: number;
  pending: boolean;
  openedAt: number;
}
const watched = new Map<string, Watch>();
/** Who changed the folder, when a change is seen (server/scene/tools.ts knows the runs going on). */
let authorOf: (p: Project) => SceneAuthor = () => ({ kind: 'outside' });
export function setSceneAuthor(fn: (p: Project) => SceneAuthor): void {
  authorOf = fn;
}

/** A tab shows this project's scene: watch its folder for a while. */
export function watchScene(projectId: string, now = Date.now()): void {
  const w = watched.get(projectId);
  if (w) w.openedAt = now;
  else watched.set(projectId, { sig: null, changedAt: now, pending: false, openedAt: now });
}

/** One look at the watched folders (the timer calls it each second; tests call it with their own clock). */
export function pollScenes(now = Date.now()): void {
  const projects = listProjects();
  const active = activeProject()?.id;
  // (the open project is always watched)
  if (active) watchScene(active, now);
  for (const [id, w] of watched) {
    const p = projects.find((x) => x.id === id);
    if (!p || (id !== active && now - w.openedAt > WATCH_OPENED_MS)) {
      watched.delete(id);
      continue;
    }
    const sig = signature(scanScene(p));
    if (w.sig === null) {
      // first look since the server started (or the project was opened): changed meanwhile?
      w.sig = sig;
      const first = !sceneVersions(p).length;
      takeVersion(
        p,
        { kind: 'outside' },
        first ? 'As found' : 'Changed while Athena was closed or showing another project',
      );
      continue;
    }
    if (sig !== w.sig) {
      w.sig = sig;
      w.changedAt = now;
      w.pending = true;
    } else if (w.pending && now - w.changedAt >= SETTLE_MS) {
      w.pending = false;
      takeVersion(p, authorOf(p));
    }
  }
}

/** Takes a version now if the folder changed since the newest (no waiting for the folder to settle). */
export function settleScene(p: Project): SceneVersion | null {
  const w = watched.get(p.id);
  if (w) {
    w.sig = signature(scanScene(p));
    w.pending = false;
  }
  return takeVersion(p, authorOf(p));
}

let timer: ReturnType<typeof setInterval> | null = null;
/** Starts looking at scene folders (server/index.ts). */
export function startSceneWatch(): void {
  if (timer) return;
  timer = setInterval(() => {
    try {
      pollScenes();
    } catch (e) {
      console.error('scene watch:', e);
    }
  }, POLL_MS);
  timer.unref?.();
}

/** Forgets what is cached (tests, and a restored backup). */
export function forgetScene(projectId?: string): void {
  if (projectId) {
    cache.delete(projectId);
    problems.delete(projectId);
    watched.delete(projectId);
  } else {
    cache.clear();
    problems.clear();
    watched.clear();
  }
}
