// Building in a project's world: runs build steps on an object or a prefab, moves, hides or deletes objects, and undoes.
// Every change keeps what it replaced (history/), so a builder can undo its own last change.
import fs from 'node:fs';
import { activeProject } from '../store.ts';
import { listFiles, readPlain, uid, writeJSON } from '../util.ts';
import { decodeChunk, countVoxels, volumeBounds } from '../../shared/voxel.ts';
import { BuildError, loadGrids, runBuild, saveGrids, VOXEL_SIZE_MAX, VOXEL_SIZE_MIN } from './ops.ts';
import type { BuildOutcome, Grid } from './ops.ts';
import { readObject, readPrefab, saveWorld, worldDir, writeObject, writePrefab, worldVoxels } from './store.ts';
import { worldForBuild } from './link.ts';
import type { PrefabInstance, Vec3, VoxelObjectData, VoxelObjectMeta, VoxelPrefabMeta, VoxelVolumeMeta, VoxelWorld, WorldAnchor, WorldBuilder } from '../../shared/types.ts';

export const WORLD_LIMITS = { voxels: 4_000_000, objects: 300, prefabs: 300, copies: 20_000, prefabSide: 128, prefabVoxels: 200_000, nesting: 4 };
const HISTORY_KEPT = 50;

const bad = (msg: string, status = 400) => Object.assign(new Error(msg), { status });

// ---------- finding things ----------
/** An object by id, or by name (any case). */
export function findObject(w: VoxelWorld, ref: unknown): VoxelObjectMeta | null {
  return byRef(w.objects, ref);
}
export function findPrefab(w: VoxelWorld, ref: unknown): VoxelPrefabMeta | null {
  return byRef(w.prefabs, ref);
}
function byRef<T extends { id: string; name: string }>(list: T[], ref: unknown): T | null {
  const r = String(ref ?? '').trim();
  if (!r) return null;
  return list.find((o) => o.id === r) || list.find((o) => o.name.toLowerCase() === r.toLowerCase()) || null;
}

/** Copies placed in the world's objects (a copy of a prefab with copies inside counts once). */
export const placedCopies = (w: VoxelWorld): number => w.objects.reduce((n, o) => n + (o.instances || 0), 0);

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
export interface HistoryEntry {
  id: string;
  at: number;
  by: WorldBuilder;
  what: string;
  /** an object (the default) or a prefab */
  kind?: 'object' | 'prefab';
  objectId: string;
  /** the object or prefab before (null: it was new) */
  metaBefore: VoxelObjectMeta | VoxelPrefabMeta | null;
  /** the voxels it replaced: every touched chunk (null: there was none) */
  chunks?: BuildOutcome['before'];
  /** the copies placed in it before, when the change placed or took some away */
  instancesBefore?: PrefabInstance[];
  /** the whole thing, when it was deleted */
  dataBefore?: VoxelObjectData | null;
}

const historyDir = (worldId: string) => worldDir(worldId, 'history');
function history(worldId: string): HistoryEntry[] {
  return listFiles(historyDir(worldId), (n) => n.endsWith('.json'))
    .map((n) => readPlain<HistoryEntry | null>(worldDir(worldId, 'history', n), null))
    .filter((h): h is HistoryEntry => !!h)
    .sort((a, b) => b.at - a.at);
}
export function remember(worldId: string, h: Omit<HistoryEntry, 'id' | 'at'>): void {
  // strictly after the last one, even in the same millisecond: undo goes by this order
  const e: HistoryEntry = { id: uid('h'), at: Math.max(Date.now(), (history(worldId)[0]?.at ?? 0) + 1), ...h };
  writeJSON(worldDir(worldId, 'history', `${e.id}.json`), e);
  for (const old of history(worldId).slice(HISTORY_KEPT)) fs.rmSync(worldDir(worldId, 'history', `${old.id}.json`), { force: true });
}

// ---------- building ----------
export interface BuildRequest {
  by: WorldBuilder;
  /** an object's id or name; a new one is made when there's none by that name */
  object?: string;
  /** build into a prefab (by id or name; new when there's none) instead of an object */
  prefab?: string;
  /** a new or changed prefab: what it is, and words to find it by */
  description?: unknown;
  tags?: unknown;
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
  /** the object, or the prefab, built in */
  object: VoxelObjectMeta | VoxelPrefabMeta;
  kind: 'object' | 'prefab';
  created: boolean;
  outcome: BuildOutcome;
  text: string;
}

export function volumesMeta(grids: Grid[]): VoxelVolumeMeta[] {
  return grids
    .map((g) => {
      const b = volumeBounds(g.vol);
      return { id: g.id, voxelSize: g.voxelSize, count: countVoxels(g.vol), min: b?.min || null, max: b?.max || null };
    })
    .filter((v) => v.count > 0);
}

/** An object's size in map units, for messages. */
export function objectBox(o: { volumes: VoxelVolumeMeta[] }): { min: Vec3; max: Vec3 } | null {
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
export const boxText = (o: { volumes: VoxelVolumeMeta[] }): string => {
  const b = objectBox(o);
  if (!b) return 'empty';
  const s = b.max.map((n, i) => r1(n - b.min[i]));
  return `${s[0]}×${s[1]}×${s[2]} map units (x ${r1(b.min[0])}..${r1(b.max[0])}, y ${r1(b.min[1])}..${r1(b.max[1])}, z ${r1(b.min[2])}..${r1(b.max[2])} from its position)`;
};

/** Does prefab `id` hold `target` (directly or deeper)? And how deep do copies nest inside `id`? */
function nesting(w: VoxelWorld, id: string, target: string | null, seen = new Set<string>()): { holds: boolean; depth: number } {
  if (seen.has(id)) return { holds: false, depth: 0 };
  seen.add(id);
  let holds = false;
  let depth = 0;
  for (const i of readPrefab(w.id, id)?.instances || []) {
    if (i.prefab === target) holds = true;
    const n = nesting(w, i.prefab, target, seen);
    holds ||= n.holds;
    depth = Math.max(depth, n.depth + 1);
  }
  return { holds, depth };
}

const count = (v: VoxelVolumeMeta[]) => v.reduce((n, x) => n + x.count, 0);
const fmt = (n: number) => n.toLocaleString('en-US');

/** A prefab's bottom centre and size (map units), from its voxels. */
function pivotOf(volumes: VoxelVolumeMeta[]): { pivot: Vec3; size: Vec3 } {
  const b = objectBox({ volumes });
  if (!b) return { pivot: [0, 0, 0], size: [0, 0, 0] };
  const r = (n: number) => Math.round(n * 1000) / 1000;
  return { pivot: [r((b.min[0] + b.max[0]) / 2), r(b.min[1]), r((b.min[2] + b.max[2]) / 2)], size: [r(b.max[0] - b.min[0]), r(b.max[1] - b.min[1]), r(b.max[2] - b.min[2])] };
}

export function build(req: BuildRequest): BuildReport {
  const pid = req.project || activeProject().id;
  const w = worldForBuild(pid);
  const kind = req.prefab !== undefined && req.prefab !== null && String(req.prefab).trim() ? 'prefab' : 'object';
  const name = String((kind === 'prefab' ? req.prefab : req.object) ?? '').trim().slice(0, 80);
  if (!name) throw bad('Name the object to build (a new name makes a new one), or a prefab with "prefab".');
  const now = Date.now();
  let target: VoxelObjectMeta | VoxelPrefabMeta | null = kind === 'prefab' ? findPrefab(w, name) : findObject(w, name);
  const created = !target;
  if (!target && kind === 'prefab') {
    if (w.prefabs.length >= WORLD_LIMITS.prefabs) throw bad(`This world has ${WORLD_LIMITS.prefabs} prefabs, the most it can hold.`);
    target = { id: uid('p'), name, description: '', tags: [], by: req.by, volumes: [], pivot: [0, 0, 0], size: [0, 0, 0], createdAt: now, updatedAt: now };
  } else if (!target) {
    if (w.objects.length >= WORLD_LIMITS.objects) throw bad(`This world has ${WORLD_LIMITS.objects} objects, the most it can hold. Add to an existing one, or delete one first.`);
    target = { id: uid('o'), name, by: req.by, anchor: cleanAnchor(req.anchor), position: req.position === undefined ? [0, 0, 0] : vec3(req.position, 'position'), rotation: 0, scale: 1, volumes: [], createdAt: now, updatedAt: now };
  }
  const t = target;
  const voxelSize = req.voxelSize === undefined ? w.voxelSize : Number(req.voxelSize);
  if (!Number.isFinite(voxelSize) || voxelSize < VOXEL_SIZE_MIN || voxelSize > VOXEL_SIZE_MAX) throw bad(`voxel_size is from ${VOXEL_SIZE_MIN} to ${VOXEL_SIZE_MAX} map units`);
  const data = kind === 'prefab' ? readPrefab(w.id, t.id) : readObject(w.id, t.id);
  const grids = loadGrids(data);
  const palette = [...w.palette];
  const outcome = runBuild({
    grids,
    palette,
    voxelSize,
    steps: req.steps as unknown[],
    seed: req.seed === undefined ? undefined : Number(req.seed) || 1,
    newId: () => uid('v'),
    instances: data?.instances || [],
    prefabs: w.prefabs.map((p) => ({ id: p.id, name: p.name, pivot: p.pivot })),
    loadPrefab: (id) => {
      const d = readPrefab(w.id, id);
      return d ? { grids: loadGrids(d), instances: d.instances || [] } : null;
    },
    cantPlace: (id) => {
      if (kind !== 'prefab') return null;
      const n = nesting(w, id, t.id);
      if (id === t.id || n.holds) return `a prefab can't be placed inside itself ("${t.name}")`;
      if (n.depth + 1 >= WORLD_LIMITS.nesting) return `prefabs nest at most ${WORLD_LIMITS.nesting} deep`;
      return null;
    },
  });

  const volumes = volumesMeta(outcome.grids);
  const total = worldVoxels(w) - count(t.volumes) + count(volumes);
  if (total > WORLD_LIMITS.voxels) throw new BuildError(`This would make the world ${fmt(total)} voxels; it can hold ${fmt(WORLD_LIMITS.voxels)}. Use a bigger voxel size, place copies of a prefab instead of building the same thing again, or remove something first.`);
  if (kind === 'prefab') {
    const box = objectBox({ volumes });
    if (count(volumes) > WORLD_LIMITS.prefabVoxels) throw new BuildError(`a prefab can hold ${fmt(WORLD_LIMITS.prefabVoxels)} voxels; this would be ${fmt(count(volumes))}. Make it smaller, or build it as an object.`);
    if (box && volumes.some((v) => v.min && v.max && v.max.some((n, a) => n - v.min![a] + 1 > WORLD_LIMITS.prefabSide))) throw new BuildError(`a prefab is at most ${WORLD_LIMITS.prefabSide} voxels on a side; build big things as objects`);
  } else {
    const copies = placedCopies(w) - ((t as VoxelObjectMeta).instances || 0) + outcome.instances.length;
    if (copies > WORLD_LIMITS.copies) throw new BuildError(`This would make ${fmt(copies)} placed copies in the world; it can hold ${fmt(WORLD_LIMITS.copies)}.`);
  }

  const metaBefore = created ? null : structuredClone(t);
  const instancesChanged = outcome.placed > 0 || outcome.unplaced > 0;
  const saved: VoxelObjectData = { ...saveGrids(outcome.grids), ...(outcome.instances.length ? { instances: outcome.instances } : {}) };
  if (kind === 'prefab') writePrefab(w.id, t.id, saved);
  else writeObject(w.id, t.id, saved);
  t.volumes = volumes;
  t.instances = outcome.instances.length || undefined;
  t.updatedAt = t.voxelsAt = Date.now();
  t.lastBy = req.by;
  if (kind === 'prefab') {
    const p = t as VoxelPrefabMeta;
    Object.assign(p, pivotOf(volumes));
    if (req.description !== undefined) p.description = String(req.description).slice(0, 300);
    if (Array.isArray(req.tags)) p.tags = [...new Set(req.tags.map((x) => String(x).trim().toLowerCase()).filter(Boolean))].slice(0, 12);
    if (created) w.prefabs.push(p);
  } else if (created) w.objects.push(t as VoxelObjectMeta);
  w.palette = palette;
  w.built = true;
  remember(w.id, { by: req.by, kind, what: `${created ? 'built' : 'changed'} ${kind === 'prefab' ? 'the prefab ' : ''}${t.name}`, objectId: t.id, metaBefore, chunks: outcome.before, ...(instancesChanged ? { instancesBefore: data?.instances || [] } : {}) });
  saveWorld(w, { [kind === 'prefab' ? 'prefabs' : 'objects']: [t.id], by: req.by.name });

  const sizes = volumes.map((v) => `${v.voxelSize}: ${fmt(v.count)}`).join(', ');
  const where = kind === 'prefab' ? `Its bottom centre stands where it is placed; it is ${(t as VoxelPrefabMeta).size.join('×')} map units. Place copies with {"place": "${t.name}"}, or bake it into an object with {"stamp": "${t.name}"}.` : `at ${(t as VoxelObjectMeta).position.join(', ')} from ${anchorText((t as VoxelObjectMeta).anchor)}`;
  const text = [
    `${created ? 'Built' : 'Changed'} ${kind === 'prefab' ? 'the prefab' : ''} "${t.name}" in the world "${w.name}": ${fmt(outcome.added)} voxels added, ${fmt(outcome.removed)} removed, ${fmt(outcome.painted)} repainted${instancesChanged ? `; ${fmt(outcome.placed)} copies placed, ${fmt(outcome.unplaced)} taken away` : ''}.`.replace('Built  "', 'Built "').replace('Changed  "', 'Changed "'),
    `It now has ${fmt(count(volumes))} voxels (by voxel size: ${sizes || 'none'})${outcome.instances.length ? ` and ${fmt(outcome.instances.length)} placed copies` : ''}, ${boxText({ volumes })}. ${where}`,
    outcome.newMaterials.length ? `Added to the palette: ${outcome.newMaterials.join(', ')}.` : '',
    ...outcome.notes,
    `The world has ${fmt(total)} of ${fmt(WORLD_LIMITS.voxels)} voxels${kind === 'object' ? ` and ${fmt(placedCopies(w))} of ${fmt(WORLD_LIMITS.copies)} placed copies` : ''}.`,
  ]
    .filter(Boolean)
    .join('\n');
  return { world: w, object: t, kind, created, outcome, text };
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
/** Undoes the last change `by` made (or anyone's, when `anyone`). Refuses when someone else changed that thing since. */
export function undo(by: WorldBuilder, { project, anyone = false }: { project?: string; anyone?: boolean } = {}): { world: VoxelWorld; text: string } {
  const w = worldForBuild(project || activeProject().id);
  const all = history(w.id);
  const mine = all.find((h) => anyone || builderKey(h.by) === builderKey(by));
  if (!mine) return { world: w, text: 'Nothing to undo.' };
  const later = all.filter((h) => h.at > mine.at && h.objectId === mine.objectId && builderKey(h.by) !== builderKey(mine.by));
  if (later.length) throw bad(`${later[0].by.name} changed that after you (${later[0].what}). Ask them, or change it again yourself.`, 409);
  const isPrefab = mine.kind === 'prefab';
  const list: { id: string }[] = isPrefab ? w.prefabs : w.objects;
  const read = (id: string) => (isPrefab ? readPrefab(w.id, id) : readObject(w.id, id));
  const write = (id: string, d: VoxelObjectData | null) => (isPrefab ? writePrefab(w.id, id, d) : writeObject(w.id, id, d));
  const idx = list.findIndex((o) => o.id === mine.objectId);
  const putBack = (m: VoxelObjectMeta | VoxelPrefabMeta) => {
    if (isPrefab) {
      const i = w.prefabs.findIndex((o) => o.id === m.id);
      if (i >= 0) w.prefabs[i] = m as VoxelPrefabMeta;
      else w.prefabs.push(m as VoxelPrefabMeta);
    } else {
      const i = w.objects.findIndex((o) => o.id === m.id);
      if (i >= 0) w.objects[i] = m as VoxelObjectMeta;
      else w.objects.push(m as VoxelObjectMeta);
    }
  };
  if (!mine.metaBefore) {
    // it was new: take it away
    if (idx >= 0) list.splice(idx, 1);
    write(mine.objectId, null);
  } else if (mine.dataBefore !== undefined) {
    // it was deleted: bring it back
    write(mine.objectId, mine.dataBefore);
    mine.metaBefore.voxelsAt = Date.now();
    putBack(mine.metaBefore);
  } else {
    if (mine.chunks?.length || mine.instancesBefore) {
      const data = read(mine.objectId);
      const grids = loadGrids(data);
      for (const b of mine.chunks || []) {
        const g = grids.find((x) => x.id === b.gridId);
        if (!g) continue;
        for (const [k, c] of Object.entries(b.chunks)) c ? g.vol.chunks.set(k, decodeChunk(c)) : g.vol.chunks.delete(k);
      }
      const instances = mine.instancesBefore ?? data?.instances ?? [];
      write(mine.objectId, { ...saveGrids(grids), ...(instances.length ? { instances } : {}) });
      mine.metaBefore.volumes = volumesMeta(grids);
      mine.metaBefore.instances = instances.length || undefined;
      mine.metaBefore.voxelsAt = Date.now();
    }
    putBack(mine.metaBefore);
  }
  fs.rmSync(worldDir(w.id, 'history', `${mine.id}.json`), { force: true });
  saveWorld(w, { [isPrefab ? 'prefabs' : 'objects']: [mine.objectId], undone: true, by: by.name });
  return { world: w, text: `Undid: ${mine.by.name} ${mine.what}.` };
}

/** Recent changes, newest first (for world_info and the page). */
export function recentChanges(worldId: string, n = 8): { at: number; by: string; what: string }[] {
  return history(worldId)
    .slice(0, n)
    .map((h) => ({ at: h.at, by: h.by.name, what: h.what }));
}

/** Who may change an object without asking: whoever built it, the Brain, and you. */
export function ownsObject(by: WorldBuilder, o: { by: WorldBuilder }): boolean {
  return by.kind !== 'agent' || (o.by.kind === 'agent' && o.by.id === by.id);
}

