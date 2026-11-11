// Files and the smaller things around them (server/api/files.ts): what a chat's files are, showing and opening one,
// attached files, MEMORY.md, what agents made, the backups folder, the Station map's layout and terminals. The
// files themselves (GET /api/file, an upload's bytes, a backup to restore) are still sent by server/index.ts.
// files, uploads and memory are also answered under /api/p/<project> for a project that isn't open.
import { oc, type } from '@orpc/contract';
import { z } from 'zod';
import type { Artifact, BackupListing, FileInfo, MemoryInfo, StationLayout, Terminal } from '../types.ts';

const onePath = z.object({ path: z.string({ error: 'path must be a file.' }) });
const ok = type<{ ok: true }>();
const spot = z.number({ error: 'A place on the map is x and z.' });

export const files = {
  /** Whether each path a chat mentions is there and what it is (up to 50). */
  info: oc
    .route({ method: 'POST', path: '/files/info' })
    .input(z.object({ paths: z.array(z.string(), { error: 'paths must be a list.' }) }))
    .output(type<FileInfo[]>()),
  /** Shows it in Explorer or Finder; open: with its own program (the desktop app). */
  reveal: oc.route({ method: 'POST', path: '/files/reveal' }).input(onePath).output(ok),
  open: oc.route({ method: 'POST', path: '/files/open' }).input(onePath).output(ok),
};

export const uploads = {
  /** A folder for one drop of files; each is then sent to POST /api/uploads/<batch>?path=… (server/index.ts). */
  newBatch: oc.route({ method: 'POST', path: '/uploads' }).output(type<{ batch: string; dir: string }>()),
  /** Takes back an attached file (?path= as the upload gave it). ok: false when it wasn't there. */
  remove: oc
    .route({ method: 'DELETE', path: '/uploads', inputStructure: 'detailed' })
    .input(z.object({ query: z.object({ path: z.string({ error: 'Say which file.' }) }) }))
    .output(type<{ ok: boolean }>()),
};

export const memory = {
  /** An agent's MEMORY.md, or the Brain's (owner: brain). */
  get: oc
    .route({ method: 'GET', path: '/memory/{owner}' })
    .input(z.object({ owner: z.string() }))
    .output(type<MemoryInfo>()),
  save: oc
    .route({ method: 'PUT', path: '/memory/{owner}' })
    .input(z.object({ owner: z.string(), text: z.string({ error: 'Send the whole MEMORY.md as text.' }) }))
    .output(type<MemoryInfo>()),
};

export const artifacts = {
  /** What agents made, newest first. */
  list: oc.route({ method: 'GET', path: '/artifacts' }).output(type<Artifact[]>()),
  remove: oc
    .route({ method: 'DELETE', path: '/artifacts/{id}' })
    .input(z.object({ id: z.string() }))
    .output(ok),
};

export const backups = {
  /** The backups folder and the backups in it. */
  list: oc.route({ method: 'GET', path: '/backups' }).output(type<{ dir: string; backups: BackupListing[] }>()),
  /** Opens the backups folder in Explorer or Finder. */
  open: oc.route({ method: 'POST', path: '/backups/open' }).output(ok),
};

export const layout = {
  get: oc.route({ method: 'GET', path: '/layout' }).output(type<StationLayout>()),
  /** What it is given changes; the rest stays. */
  save: oc
    .route({ method: 'PUT', path: '/layout' })
    .input(
      z.object({
        bench: z.object({ x: spot, z: spot }, { error: 'A place on the map is x and z.' }).nullable().optional(),
      }),
    )
    .output(ok),
};

export const terminals = {
  list: oc.route({ method: 'GET', path: '/terminals' }).output(type<Terminal[]>()),
  /** A shell (in cwd), an agent's own CLI (agentId), or a command (with args). */
  create: oc
    .route({ method: 'POST', path: '/terminals' })
    .input(
      z.object({
        kind: z
          .enum(['shell', 'agent', 'command'], { error: 'A terminal is a shell, an agent or a command.' })
          .optional(),
        agentId: z.string().optional(),
        command: z.string({ error: 'The command must be text.' }).nullable().optional(),
        args: z.array(z.string(), { error: 'The arguments must be a list.' }).optional(),
        title: z.string().nullable().optional(),
        cwd: z.string({ error: 'cwd must be a folder.' }).nullable().optional(),
        cols: z.number().optional(),
        rows: z.number().optional(),
      }),
    )
    .output(type<{ id: string; title: string }>()),
  /** ok: false when it had closed already. */
  close: oc
    .route({ method: 'DELETE', path: '/terminals/{id}' })
    .input(z.object({ id: z.string() }))
    .output(type<{ ok: boolean }>()),
};
