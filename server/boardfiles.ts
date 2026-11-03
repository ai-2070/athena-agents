// Files on Tasks board tasks and comments. Each is a copy in the task's own project's uploads folder, saved with its
// path relative to that folder (so a copied or restored project points at its own copy). Files you attach come
// from the open project's uploads; files a worker hands in come from its own workspace and pass the same checks a
// gateway uses before a file leaves the dashboard (gateways/outgoing.ts).
import fs from 'node:fs';
import { constants } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { activeProject, listProjects, withProject } from './store.ts';
import { DATA, insideRoots } from './util.ts';
import { cleanAttachments, MAX_FILE_BYTES, newBatch, receiveSource, safeUploadsRoot } from './uploads.ts';
import type { RunInfo } from './engines/index.ts';
import type { Project, TaskFile } from '../shared/types.ts';

/** At most this many files on one task, and on one comment. */
export const TASK_FILES_MAX = 20;
const fail = (message: string, status = 400): never => { throw Object.assign(new Error(message), { status }); };
const unavailable = () => fail('This file cannot be attached. Check that it is a finished file in your workspace or the project uploads, not a link, and at most 500 MB.');

// Credentials, runtime stores and account material never become task files, even inside a broad workspace.
// (the same names gateways/outgoing.ts refuses)
const forbidden = (value: string) =>
  value.split(/[\\/]/).some((part) => /^(?:\.git|\.dashboard|\.ssh|\.aws|\.azure|\.kube|\.docker|\.gnupg|\.config|\.codex|\.claude|\.npmrc|\.netrc|\.pypirc|\.env(?:\..*)?|auth\.json|secrets?(?:\..*)?|credentials?(?:\..*)?|id_rsa|id_ed25519)$/i.test(part))
  || /\.(?:pem|key|p12|pfx|dashbackup)$/i.test(value);

const relative = (root: string, file: string) => path.relative(root, file).split(path.sep).join('/');

/** A task file's place on disk, in its project's uploads folder, while it is still a plain file there. */
export function taskFilePath(p: Project, rel: string): string | null {
  return withProject(p, () => {
    const root = safeUploadsRoot();
    if (!root || !rel || path.isAbsolute(rel) || rel.split(/[\\/]/).some((x) => !x || x === '.' || x === '..')) return null;
    const file = path.join(root, ...rel.split('/'));
    const real = insideRoots(file, [root]);
    if (!real) return null;
    try { return fs.lstatSync(file).isFile() ? file : null; } catch { return null; }
  });
}

/** Copies a file into a new batch of a project's uploads, hashing it as it goes. */
async function copyInto(p: Project, from: string, by: string): Promise<TaskFile> {
  const handle = await fs.promises.open(from, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_FILE_BYTES) return unavailable();
    const hash = crypto.createHash('sha256');
    const stream = handle.createReadStream({ autoClose: false });
    async function* hashed(): AsyncIterable<Uint8Array> {
      for await (const chunk of stream) { hash.update(chunk as Buffer); yield chunk as Buffer; }
    }
    return await withProject(p, async () => {
      const root = safeUploadsRoot() || fail("The task's project has no usable uploads folder.");
      const { batch } = newBatch();
      const saved = await receiveSource(hashed(), batch, path.basename(from), { declaredBytes: stat.size });
      return { path: relative(root, saved.path), name: saved.name, size: saved.size, sha256: hash.digest('hex'), by, at: Date.now() };
    });
  } finally { await handle.close(); }
}

/**
 * The files a request names for a task: paths already on it (relative) stay; new ones are uploads of the open
 * project (absolute), copied into the task's project when that is another one.
 */
export async function filesFromRequest(p: Project, list: unknown, current: TaskFile[] = [], by = 'you'): Promise<TaskFile[]> {
  if (list === undefined) return current;
  if (!Array.isArray(list)) return fail('files must be a list.');
  const kept = current.filter((f) => list.includes(f.path));
  const fresh = cleanAttachments(list.filter((x) => typeof x === 'string' && path.isAbsolute(x))).filter((x) => !x.endsWith(path.sep));
  if (kept.length + fresh.length > TASK_FILES_MAX) return fail(`A task or comment can have ${TASK_FILES_MAX} files.`);
  const open = activeProject();
  const added: TaskFile[] = [];
  for (const file of fresh) {
    if (open.id === p.id) {
      const root = safeUploadsRoot()!;
      const stat = fs.statSync(file);
      added.push({ path: relative(root, file), name: path.basename(file), size: stat.size, by, at: Date.now() });
    } else added.push(await copyInto(p, file, by));
  }
  return [...kept, ...added];
}

/**
 * Files a worker hands in with its comment: absolute paths in its own workspace or the project's uploads, regular
 * files only (no links, no hard links), not credentials, not data folders and not another project's. Each is copied
 * into the task's project.
 */
export async function workerFiles(run: RunInfo, raw: unknown, by: string): Promise<TaskFile[]> {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > TASK_FILES_MAX || raw.some((x) => typeof x !== 'string' || !x || x.length > 16384)) return fail(`files must be a list of at most ${TASK_FILES_MAX} full paths.`);
  const out: TaskFile[] = [];
  for (const file of raw as string[]) {
    if (!path.isAbsolute(file)) return unavailable();
    const real = withProject(run.project, () => {
      const brain = run.project.brainPath;
      const uploads = safeUploadsRoot();
      const workspace = run.agent.workspace && path.isAbsolute(run.agent.workspace) ? run.agent.workspace : brain;
      const found = insideRoots(file, [workspace, ...(uploads ? [uploads] : [])]);
      const unrelated = found && !insideRoots(found, [brain]) && listProjects().some((x) => x.id !== run.projectId && insideRoots(found, [x.brainPath]));
      return !found || insideRoots(found, [DATA]) || unrelated || forbidden(file) || forbidden(found) ? null : found;
    });
    // (the path itself must be the file, not a link to one)
    if (!real || fs.lstatSync(file).isSymbolicLink()) return unavailable();
    out.push(await copyInto(run.project, real, by));
  }
  return out;
}
