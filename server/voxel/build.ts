// Building in a project's world: runs build steps on an object, moves, hides or deletes objects, and undoes.
// Every change keeps what it replaced (history/), so a builder can undo its own last change.
import fs from 'node:fs';
import { activeProject } from '../store.ts';
import { listFiles, readPlain, uid, writeJSON } from '../util.ts';
import { decodeChunk, countVoxels, volumeBounds } from '../../shared/voxel.ts';
import { BuildError, loadGrids, runBuild, saveGrids, VOXEL_SIZE_MAX, VOXEL_SIZE_MIN } from './ops.ts';
import type { BuildOutcome, Grid } from './ops.ts';
import { readObject, saveWorld, worldDir, writeObject, worldVoxels } from './store.ts';
import { worldForBuild } from './link.ts';
import type { Vec3, VoxelObjectData, VoxelObjectMeta, VoxelWorld, WorldAnchor, WorldBuilder } from '../../shared/types.ts';

export const WORLD_LIMITS = { voxels: 4_000_000, objects: 300 };
const HISTORY_KEPT = 50;

const bad = (msg: string, status = 400) => Object.assign(new Error(msg), { status });

// ---------- finding things ----------
/** An object by id, or by name (any case). */
export function findObject(w: VoxelWorld, ref: unknown): VoxelObjectMeta | null {
  const r = String(ref ?? '').trim();
  if (!r) return null;
  return w.objects.find((o) => o.id === r) || w.objects.find((o) => o.name.toLowerCase() === r.toLowerCase()) || null;
}

export function cleanAnchor(a: unknown): WorldAnchor {
  if (a === undefined || a === null || a === 'world') return { to: 'world' };
  if (a === 'brain') return { to: 'brain' };
  const o = (typeof a === 'string' ? (([to, id]) => ({ to, id }))(a.split(':')) : a) as { to?: unknown; id?: unknown };
  const to = String(o.to || '');
  if (to === 'world' || to === 'brain') return { to };
  if ((to === 'team' || to === 'agent') && typeof o.id === 'string' && /^[\w.-]{1,80}$/.test(o.id)) return { to, id: o.id };
  throw bad('anchor is "world", "brain", "team:<team id>" or "agent:<agent id>"');
}

const vec3 = (v: unknown, what: string): Vec3 => {
  if (!Array.isArray(v) || v.length !== 3 || v.some((n) => !Number.isFinite(Number(n)))) throw bad(`${what} must be [x, y, z] in map units`);
  return v.map((n) => Math.max(-2000, Math.min(2000, Number(n)))) as Vec3;
};

/** Who a builder is, for the history and the page. */
export const builderKey = (b: WorldBuilder) => `${b.kind}:${b.id || ''}`;

// ---------- history (undo) ----------
interface HistoryEntry {
  id: string;
  at: number;
  by: WorldBuilder;
  what: string;
  objectId: string;
  /** the object before (null: it was new) */
  metaBefore: VoxelObjectMeta | null;
  /** the voxels it replaced: every touched chunk (null: there was none) */
  chunks?: BuildOutcome['before'];
  /** the whole object, when it was deleted */
  dataBefore?: VoxelObjectData | null;
}

const historyDir = (worldId: string) => worldDir(worldId, 'history');
function history(worldId: string): HistoryEntry[] {
  return listFiles(historyDir(worldId), (n) => n.endsWith('.json'))
    .map((n) => readPlain<HistoryEntry | null>(worldDir(worldId, 'history', n), null))
    .filter((h): h is HistoryEntry => !!h)
    .sort((a, b) => b.at - a.at);
}
function remember(worldId: string, h: Omit<HistoryEntry, 'id' | 'at'>): void {
  // strictly after the last one, even in the same millisecond: undo goes by this order
  const e: HistoryEntry = { id: uid('h'), at: Math.max(Date.now(), (history(worldId)[0]?.at ?? 0) + 1), ...h };
  writeJSON(worldDir(worldId, 'history', `${e.id}.json`), e);
  for (const old of history(worldId).slice(HISTORY_KEPT)) fs.rmSync(worldDir(worldId, 'history', `${old.id}.json`), { force: true });
}

// ---------- building ----------
export interface BuildRequest {
  by: WorldBuilder;
  /** an object's id or name; a new one is made when there's none by that name */
  object: string;
  anchor?: unknown;
  /** map units from the anchor (new objects only; move with changeObject) */
  position?: unknown;
  /** the voxel size the steps start with (default: the world's) */
  voxelSize?: unknown;
  steps: unknown;
  seed?: unknown;
  /** the project whose world it is (default: the active one) */
  project?: string;
}

export interface BuildReport {
  world: VoxelWorld;
  object: VoxelObjectMeta;
  created: boolean;
  outcome: BuildOutcome;
  text: string;
}

function volumesMeta(grids: Grid[]): VoxelObjectMeta['volumes'] {
  return grids
    .map((g) => {
      const b = volumeBounds(g.vol);
      return { id: g.id, voxelSize: g.voxelSize, count: countVoxels(g.vol), min: b?.min || null, max: b?.max || null };
    })
    .filter((v) => v.count > 0);
}

/** An object's size in map units, for messages. */
export function objectBox(o: VoxelObjectMeta): { min: Vec3; max: Vec3 } | null {
  let min: Vec3 | null = null;
  let max: Vec3 | null = null;
  for (const v of o.volumes) {
    if (!v.min || !v.max) continue;
    const lo = v.min.map((n) => n * v.voxelSize) as Vec3;
    const hi = v.max.map((n) => (n + 1) * v.voxelSize) as Vec3;
    min = min ? (min.map((n, i) => Math.min(n, lo[i])) as Vec3) : lo;
    max = max ? (max.map((n, i) => Math.max(n, hi[i])) as Vec3) : hi;
  }
  return min && max ? { min, max } : null;
}
const r1 = (n: number) => Math.round(n * 10) / 10;
export const boxText = (o: VoxelObjectMeta): string => {
  const b = objectBox(o);
  if (!b) return 'empty';
  const s = b.max.map((n, i) => r1(n - b.min[i]));
  return `${s[0]}×${s[1]}×${s[2]} map units (x ${r1(b.min[0])}..${r1(b.max[0])}, y ${r1(b.min[1])}..${r1(b.max[1])}, z ${r1(b.min[2])}..${r1(b.max[2])} from its position)`;
};

export function build(req: BuildRequest): BuildReport {
  const pid = req.project || activeProject().id;
  const w = worldForBuild(pid);
  const name = String(req.object ?? '').trim().slice(0, 80);
  if (!name) throw bad('Name the object to build (a new name makes a new one).');
  let meta = findObject(w, name);
  const created = !meta;
  if (!meta) {
    if (w.objects.length >= WORLD_LIMITS.objects) throw bad(`This world has ${WORLD_LIMITS.objects} objects, the most it can hold. Add to an existing one, or delete one first.`);
    const now = Date.now();
    meta = { id: uid('o'), name, by: req.by, anchor: cleanAnchor(req.anchor), position: req.position === undefined ? [0, 0, 0] : vec3(req.position, 'position'), rotation: 0, scale: 1, volumes: [], createdAt: now, updatedAt: now };
  }
  const voxelSize = req.voxelSize === undefined ? w.voxelSize : Number(req.voxelSize);
  if (!Number.isFinite(voxelSize) || voxelSize < VOXEL_SIZE_MIN || voxelSize > VOXEL_SIZE_MAX) throw bad(`voxel_size is from ${VOXEL_SIZE_MIN} to ${VOXEL_SIZE_MAX} map units`);
  const grids = loadGrids(readObject(w.id, meta.id));
  const palette = [...w.palette];
  const outcome = runBuild({ grids, palette, voxelSize, steps: req.steps as unknown[], seed: req.seed === undefined ? undefined : Number(req.seed) || 1, newId: () => uid('v') });

  const volumes = volumesMeta(outcome.grids);
  const others = worldVoxels(w) - meta.volumes.reduce((n, v) => n + v.count, 0);
  const total = others + volumes.reduce((n, v) => n + v.count, 0);
  if (total > WORLD_LIMITS.voxels) throw new BuildError(`This would make the world ${total.toLocaleString('en-US')} voxels; it can hold ${WORLD_LIMITS.voxels.toLocaleString('en-US')}. Use a bigger voxel size, or remove something first.`);

  const metaBefore = created ? null : structuredClone(meta);
  writeObject(w.id, meta.id, saveGrids(outcome.grids));
  meta.volumes = volumes;
  meta.updatedAt = meta.voxelsAt = Date.now();
  meta.lastBy = req.by;
  if (created) w.objects.push(meta);
  w.palette = palette;
  w.built = true;
  remember(w.id, { by: req.by, what: `${created ? 'built' : 'changed'} ${meta.name}`, objectId: meta.id, metaBefore, chunks: outcome.before });
  saveWorld(w, { objects: [meta.id], by: req.by.name });

  const sizes = volumes.map((v) => `${v.voxelSize}: ${v.count.toLocaleString('en-US')}`).join(', ');
  const text = [
    `${created ? 'Built' : 'Changed'} "${meta.name}" in the world "${w.name}": ${outcome.added.toLocaleString('en-US')} voxels added, ${outcome.removed.toLocaleString('en-US')} removed, ${outcome.painted.toLocaleString('en-US')} repainted.`,
    `It now has ${volumes.reduce((n, v) => n + v.count, 0).toLocaleString('en-US')} voxels (by voxel size: ${sizes || 'none'}), ${boxText(meta)}, at ${meta.position.join(', ')} from ${anchorText(meta.anchor)}.`,
    outcome.newMaterials.length ? `Added to the palette: ${outcome.newMaterials.join(', ')}.` : '',
    ...outcome.notes,
    `The world has ${total.toLocaleString('en-US')} of ${WORLD_LIMITS.voxels.toLocaleString('en-US')} voxels.`,
  ]
    .filter(Boolean)
    .join('\n');
  return { world: w, object: meta, created, outcome, text };
}

export const anchorText = (a: WorldAnchor): string => (a.to === 'world' ? 'the middle of the map' : a.to === 'brain' ? 'the Brain' : `${a.to} ${a.id}`);

// ---------- changing an object ----------
export interface ObjectChange {
  by: WorldBuilder;
  object: string;
  project?: string;
  name?: unknown;
  position?: unknown;
  /** add to the position (map units) */
  move?: unknown;
  rotation?: unknown;
  scale?: unknown;
  anchor?: unknown;
  hidden?: unknown;
  duplicate?: unknown;
  delete?: unknown;
}

export function changeObject(c: ObjectChange): { world: VoxelWorld; object: VoxelObjectMeta | null; text: string } {
  const w = worldForBuild(c.project || activeProject().id);
  const meta = findObject(w, c.object);
  if (!meta) throw bad(`There's no object "${c.object}" in this world. world_info lists them.`, 404);
  const before = structuredClone(meta);
  if (c.delete === true) {
    const data = readObject(w.id, meta.id);
    w.objects = w.objects.filter((o) => o.id !== meta.id);
    writeObject(w.id, meta.id, null);
    remember(w.id, { by: c.by, what: `deleted ${meta.name}`, objectId: meta.id, metaBefore: before, dataBefore: data });
    saveWorld(w, { objects: [meta.id], deleted: true, by: c.by.name });
    return { world: w, object: null, text: `Deleted "${meta.name}". It can be brought back with world_undo.` };
  }
  if (c.duplicate === true) {
    if (w.objects.length >= WORLD_LIMITS.objects) throw bad(`This world has ${WORLD_LIMITS.objects} objects, the most it can hold.`);
    const count = meta.volumes.reduce((n, v) => n + v.count, 0);
    if (worldVoxels(w) + count > WORLD_LIMITS.voxels) throw bad(`A copy would make the world bigger than ${WORLD_LIMITS.voxels.toLocaleString('en-US')} voxels.`);
    const now = Date.now();
    const copy: VoxelObjectMeta = { ...structuredClone(meta), id: uid('o'), name: uniqueName(w, String(c.name || `${meta.name} copy`)), by: c.by, lastBy: c.by, createdAt: now, updatedAt: now };
    if (c.position !== undefined) copy.position = vec3(c.position, 'position');
    if (c.move !== undefined) copy.position = copy.position.map((n, i) => n + vec3(c.move, 'move')[i]) as Vec3;
    if (c.anchor !== undefined) copy.anchor = cleanAnchor(c.anchor);
    writeObject(w.id, copy.id, readObject(w.id, meta.id));
    w.objects.push(copy);
    remember(w.id, { by: c.by, what: `copied ${meta.name}`, objectId: copy.id, metaBefore: null, chunks: [] });
    saveWorld(w, { objects: [copy.id], by: c.by.name });
    return { world: w, object: copy, text: `Copied "${meta.name}" as "${copy.name}" at ${copy.position.join(', ')} from ${anchorText(copy.anchor)}.` };
  }
  const changed: string[] = [];
  if (c.name !== undefined) {
    const n = String(c.name).trim().slice(0, 80);
    if (!n) throw bad('name is empty');
    if (n.toLowerCase() !== meta.name.toLowerCase() && findObject(w, n)) throw bad(`There's already an object called "${n}".`);
    meta.name = n;
    changed.push('name');
  }
  if (c.anchor !== undefined) (meta.anchor = cleanAnchor(c.anchor)), changed.push('anchor');
  if (c.position !== undefined) (meta.position = vec3(c.position, 'position')), changed.push('position');
  if (c.move !== undefined) (meta.position = meta.position.map((n, i) => n + vec3(c.move, 'move')[i]) as Vec3), changed.push('position');
  if (c.rotation !== undefined) {
    const r = Number(c.rotation);
    if (!Number.isFinite(r)) throw bad('rotation is in degrees');
    meta.rotation = ((r % 360) + 360) % 360;
    changed.push('rotation');
  }
  if (c.scale !== undefined) {
    const s = Number(c.scale);
    if (!Number.isFinite(s) || s < 0.1 || s > 10) throw bad('scale is from 0.1 to 10');
    meta.scale = s;
    changed.push('scale');
  }
  if (c.hidden !== undefined) (meta.hidden = c.hidden === true), changed.push(meta.hidden ? 'hidden' : 'shown');
  if (!changed.length) return { world: w, object: meta, text: 'Nothing to change: give name, position, move, rotation, scale, anchor, hidden, duplicate or delete.' };
  meta.updatedAt = Date.now();
  meta.lastBy = c.by;
  remember(w.id, { by: c.by, what: `changed ${meta.name} (${changed.join(', ')})`, objectId: meta.id, metaBefore: before });
  saveWorld(w, { objects: [meta.id], moved: true, by: c.by.name });
  return { world: w, object: meta, text: `Changed "${meta.name}": ${changed.join(', ')}. It is at ${meta.position.join(', ')} from ${anchorText(meta.anchor)}, turned ${meta.rotation}°, scale ${meta.scale}.` };
}

function uniqueName(w: VoxelWorld, want: string): string {
  let n = want.slice(0, 76);
  for (let i = 2; findObject(w, n); i++) n = `${want.slice(0, 72)} ${i}`;
  return n;
}

// ---------- undo ----------
/** Undoes the last change `by` made (or anyone's, when `anyone`). Refuses when someone else changed that object since. */
export function undo(by: WorldBuilder, { project, anyone = false }: { project?: string; anyone?: boolean } = {}): { world: VoxelWorld; text: string } {
  const w = worldForBuild(project || activeProject().id);
  const all = history(w.id);
  const mine = all.find((h) => anyone || builderKey(h.by) === builderKey(by));
  if (!mine) return { world: w, text: 'Nothing to undo.' };
  const later = all.filter((h) => h.at > mine.at && h.objectId === mine.objectId && builderKey(h.by) !== builderKey(mine.by));
  if (later.length) throw bad(`${later[0].by.name} changed that object after you (${later[0].what}). Ask them, or change it again yourself.`, 409);
  const idx = w.objects.findIndex((o) => o.id === mine.objectId);
  if (!mine.metaBefore) {
    // it was new: take it away
    if (idx >= 0) w.objects.splice(idx, 1);
    writeObject(w.id, mine.objectId, null);
  } else if (mine.dataBefore !== undefined) {
    // it was deleted: bring it back
    writeObject(w.id, mine.objectId, mine.dataBefore);
    mine.metaBefore.voxelsAt = Date.now();
    if (idx >= 0) w.objects[idx] = mine.metaBefore;
    else w.objects.push(mine.metaBefore);
  } else {
    if (mine.chunks?.length) {
      const grids = loadGrids(readObject(w.id, mine.objectId));
      for (const b of mine.chunks) {
        const g = grids.find((x) => x.id === b.gridId);
        if (!g) continue;
        for (const [k, c] of Object.entries(b.chunks)) c ? g.vol.chunks.set(k, decodeChunk(c)) : g.vol.chunks.delete(k);
      }
      writeObject(w.id, mine.objectId, saveGrids(grids));
      mine.metaBefore.volumes = volumesMeta(grids);
      mine.metaBefore.voxelsAt = Date.now();
    }
    if (idx >= 0) w.objects[idx] = mine.metaBefore;
    else w.objects.push(mine.metaBefore);
  }
  fs.rmSync(worldDir(w.id, 'history', `${mine.id}.json`), { force: true });
  saveWorld(w, { objects: [mine.objectId], undone: true, by: by.name });
  return { world: w, text: `Undid: ${mine.by.name} ${mine.what}.` };
}

/** Recent changes, newest first (for world_info and the page). */
export function recentChanges(worldId: string, n = 8): { at: number; by: string; what: string }[] {
  return history(worldId)
    .slice(0, n)
    .map((h) => ({ at: h.at, by: h.by.name, what: h.what }));
}

/** Who may change an object without asking: whoever built it, the Brain, and you. */
export function ownsObject(by: WorldBuilder, o: VoxelObjectMeta): boolean {
  return by.kind !== 'agent' || (o.by.kind === 'agent' && o.by.id === by.id);
}

