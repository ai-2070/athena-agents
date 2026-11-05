import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import type { GatewayInboxEvent, GatewayUploadReservation } from '../../shared/types.ts';
import { activeProject, listProjects, withProject } from '../store.ts';
import { privateDataPath } from '../private.ts';
import { IS_WIN, readJSON, realTarget, writeJSON } from '../util.ts';
import { safeUploadsRoot } from '../uploads.ts';
import { GatewayInbox } from './inbox.ts';
import { gatewayRetirement } from './retirement.ts';

export const GATEWAY_MEDIA_RETENTION_MS = 24 * 60 * 60 * 1000;
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/);
const stamp = z.number().finite().nonnegative();
const leaf = z.string().min(1).max(240).refine((name) => name !== '.' && name !== '..' && !/[\\/\x00-\x1f\x7f]/.test(name));
const identity = z.strictObject({ name: leaf, dev: stamp, ino: stamp, birthtimeMs: stamp });
const schema: z.ZodType<GatewayUploadReservation> = z.strictObject({
  version: z.literal(1), instanceId: id, projectId: id, eventId: z.string().regex(/^[a-f0-9]{64}$/),
  batch: z.string().regex(/^[\w-]{1,64}$/), root: z.string().min(1), createdAt: stamp,
  target: identity, temporary: identity,
}).refine((record) => record.temporary.name.startsWith(`${record.target.name}.`)
  && /^[a-f0-9]{6}\.part$/.test(record.temporary.name.slice(record.target.name.length + 1)));
const pathKey = (file: string): string => IS_WIN ? path.resolve(file).toLowerCase() : path.resolve(file);
const samePath = (a: string, b: string): boolean => pathKey(a) === pathKey(b);
const directory = (instanceId: string): string => {
  if (!id.safeParse(instanceId).success) throw new Error('Invalid gateway instance ID.');
  return privateDataPath('gateways-runtime', instanceId, 'upload-reservations');
};

function fileIdentity(file: string): GatewayUploadReservation['target'] {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size !== 0) throw new Error('The temporary upload is not an empty reserved file.');
  return { name: path.basename(file), dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs };
}

/** Called with both empty files already claimed, before the source can produce bytes. */
export function recordGatewayUploadReservation(event: GatewayInboxEvent, target: string, temporary: string): () => void {
  const root = safeUploadsRoot(); const real = root && realTarget(root);
  if (!event.fileBatch || activeProject().id !== event.route.projectId || !root || !real
    || !fs.lstatSync(root).isDirectory() || !fs.lstatSync(path.join(root, event.fileBatch)).isDirectory()
    || !samePath(realTarget(path.dirname(target)) ?? '', path.join(real, event.fileBatch)) || !samePath(path.dirname(temporary), path.dirname(target))) throw new Error('The temporary upload left its original project batch.');
  const record = schema.parse({ version: 1, instanceId: event.route.instanceId, projectId: event.route.projectId, eventId: event.id,
    batch: event.fileBatch, root: real, createdAt: Date.now(), target: fileIdentity(target), temporary: fileIdentity(temporary) });
  const dir = directory(record.instanceId);
  if (fs.existsSync(dir) && !fs.lstatSync(dir).isDirectory()) throw new Error('Temporary upload ownership needs recovery.');
  if (fs.existsSync(dir) && fs.readdirSync(dir).length >= 10000) throw new Error('Temporary upload ownership needs cleanup before saving more files.');
  const file = privateDataPath('gateways-runtime', record.instanceId, 'upload-reservations', `${crypto.randomUUID()}.json`);
  writeJSON(file, record);
  return () => fs.unlinkSync(file);
}

/** The caller has drained the removed worker and holds account and state ownership. */
export function cleanRetiredGatewayMedia(instanceId: string, now = Date.now()): { removed: number } {
  const retired = gatewayRetirement(instanceId);
  if (!retired || retired.completedAt === undefined || now - retired.completedAt < GATEWAY_MEDIA_RETENTION_MS) return { removed: 0 };
  const dir = directory(instanceId);
  if (!fs.existsSync(dir)) return { removed: 0 };
  if (!fs.lstatSync(dir).isDirectory()) throw new Error('Temporary upload ownership needs recovery.');
  const names = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
  if (names.length > 10000) throw new Error('Temporary upload ownership needs recovery.');
  // Validate every proof before deleting anything; a broken inbox must never become an empty keep list.
  const records = names.map((name) => {
    if (!z.uuid().safeParse(name.slice(0, -5)).success) throw new Error('Temporary upload ownership needs recovery.');
    const file = privateDataPath('gateways-runtime', instanceId, 'upload-reservations', name);
    const parsed = schema.safeParse(fs.lstatSync(file).isFile() ? readJSON(file) : null);
    if (!parsed.success || parsed.data.instanceId !== instanceId) throw new Error('Temporary upload ownership needs recovery.');
    return { file, record: parsed.data };
  });
  if (!records.length) return { removed: 0 };
  const events = new GatewayInbox({ instanceId, inboxFile: () => privateDataPath('gateways-runtime', instanceId, 'inbox.json') }).list();
  const byId = new Map(events.map((event) => [event.id, event]));
  const projects = new Map(listProjects().map((project) => [project.id, project]));
  const retained = new Set(events.flatMap((event) => [...(event.files ?? []).flatMap((file) => file.file ? [file.file.path] : []), ...(event.outgoing ?? []).map((file) => file.path)])
    .map((file) => pathKey(realTarget(file) ?? file)));
  let removed = 0;
  for (const { file, record } of records) {
    if (record.createdAt > retired.completedAt || now - record.createdAt < GATEWAY_MEDIA_RETENTION_MS) continue;
    const event = byId.get(record.eventId);
    const project = projects.get(record.projectId);
    if (!event || event.route.projectId !== record.projectId || event.fileBatch !== record.batch || !project) continue;
    withProject(project, () => {
      const expectedRoot = path.join(project.brainPath, 'uploads');
      if (!fs.existsSync(expectedRoot) || !samePath(realTarget(expectedRoot) ?? '', record.root)) return;
      const root = safeUploadsRoot();
      if (!root || !samePath(realTarget(root) ?? '', record.root) || !fs.lstatSync(root).isDirectory()) return;
      const batch = path.join(root, record.batch);
      if (!fs.existsSync(batch) || !fs.lstatSync(batch).isDirectory() || !samePath(realTarget(batch) ?? '', path.join(record.root, record.batch))) return;
      let settled = true;
      for (const proof of [record.target, record.temporary]) {
        const location = path.join(batch, proof.name);
        if (retained.has(pathKey(realTarget(location) ?? location))) continue;
        let stat: fs.Stats;
        try { stat = fs.lstatSync(location); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
        if (stat.mtimeMs > retired.completedAt! + 1 || now - stat.mtimeMs < GATEWAY_MEDIA_RETENTION_MS) { settled = false; continue; }
        // Rename replaces the empty target with the owned temporary inode. Never follow links or replacements.
        const matches = [record.target, record.temporary].some((owned) => (owned === record.temporary || stat.size === 0) && owned.ino > 0 && owned.birthtimeMs > 0
          && stat.dev === owned.dev && stat.ino === owned.ino && stat.birthtimeMs === owned.birthtimeMs);
        if (!stat.isFile() || !matches) { settled = false; continue; }
        fs.unlinkSync(location); removed++;
      }
      if (settled) fs.unlinkSync(file);
    });
  }
  return { removed };
}
