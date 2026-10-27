// Prefabs the builders make: save part of an object as one, rename or describe it, delete it, and share it
// through the prefab library (data/prefab-library/, every world and project) or take one from there.
// Building a prefab's voxels and placing copies are build steps (build.ts, ops.ts).
import fs from 'node:fs';
import { activeProject } from '../store.ts';
import { dataPath, listFiles, readPlain, uid, writeJSON } from '../util.ts';
import { CHUNK, chunkKey, cellIndex } from '../../shared/voxel.ts';
import { loadGrids, saveGrids, cleanMaterial } from './ops.ts';
import type { Grid } from './ops.ts';
import { stockMaterial } from './materials.ts';
import { newVolume } from '../../shared/voxel.ts';
import { readObject, readPrefab, saveWorld, writeObject, writePrefab, worldVoxels } from './store.ts';
import { worldForBuild } from './link.ts';
import { WORLD_LIMITS, findObject, findPrefab, objectBox, placedCopies, remember, volumesMeta } from './build.ts';
import type { PrefabInstance, Vec3, VoxelMaterial, VoxelObjectData, VoxelPrefabMeta, VoxelWorld, WorldBuilder } from '../../shared/types.ts';

const bad = (msg: string, status = 400) => Object.assign(new Error(msg), { status });
const fmt = (n: number) => n.toLocaleString('en-US');
const count = (p: { volumes: { count: number }[] }) => p.volumes.reduce((n, v) => n + v.count, 0);

function pivotOf(p: VoxelPrefabMeta): void {
  const b = objectBox(p);
  const r = (n: number) => Math.round(n * 1000) / 1000;
  p.pivot = b ? [r((b.min[0] + b.max[0]) / 2), r(b.min[1]), r((b.min[2] + b.max[2]) / 2)] : [0, 0, 0];
  p.size = b ? [r(b.max[0] - b.min[0]), r(b.max[1] - b.min[1]), r(b.max[2] - b.min[2])] : [0, 0, 0];
}

function uniqueName(w: VoxelWorld, want: string): string {
  let n = want.slice(0, 76);
  for (let i = 2; findPrefab(w, n); i++) n = `${want.slice(0, 72)} ${i}`;
  return n;
}

/** Where each prefab is used: objects and prefabs with copies of it. */
export function prefabUses(w: VoxelWorld): Map<string, { in: string[]; copies: number }> {
  const out = new Map<string, { in: string[]; copies: number }>();
  const note = (list: PrefabInstance[] | undefined, where: string) => {
    for (const i of list || []) {
      const u = out.get(i.prefab) || { in: [], copies: 0 };
      u.copies++;
      if (!u.in.includes(where)) u.in.push(where);
      out.set(i.prefab, u);
    }
  };
  for (const o of w.objects) if (o.instances) note(readObject(w.id, o.id)?.instances, `"${o.name}"`);
  for (const p of w.prefabs) if (p.instances) note(readPrefab(w.id, p.id)?.instances, `the prefab "${p.name}"`);
  return out;
}

export function prefabList(w: VoxelWorld): string {
  if (!w.prefabs.length) return 'No prefabs yet. Build one with world_build and "prefab": "<name>", or save part of an object with world_prefab (action "save").';
  const uses = prefabUses(w);
  return w.prefabs
    .map((p) => {
      const u = uses.get(p.id);
      return `- "${p.name}" (id ${p.id}) by ${p.by.name}: ${p.description || 'no description'}${p.tags.length ? ` [${p.tags.join(', ')}]` : ''} | ${p.size.join('×')} map units, ${fmt(count(p))} voxels at voxel size ${[...new Set(p.volumes.map((v) => v.voxelSize))].join(' and ') || '-'}${p.instances ? `, ${p.instances} copies of other prefabs inside` : ''} | ${u ? `${u.copies} copies in ${u.in.join(', ')}` : 'not placed yet'}`;
    })
    .join('\n');
}

// ---------- making one from an object ----------
export interface SaveFrom {
  by: WorldBuilder;
  name: string;
  /** the object to take it from */
  from: string;
  /** a box in map units from the object's origin ([min, max]); the whole object when left out */
  box?: unknown;
  description?: unknown;
  tags?: unknown;
  /** take that part out of the object and put a copy of the new prefab in its place */
  replace?: boolean;
  project?: string;
}

export function savePrefabFrom(req: SaveFrom): { prefab: VoxelPrefabMeta; text: string } {
  const w = worldForBuild(req.project || activeProject().id);
  const o = findObject(w, req.from);
  if (!o) throw bad(`There's no object "${req.from}". world_info lists them.`, 404);
  const name = String(req.name ?? '').trim().slice(0, 80);
  if (!name) throw bad('Name the new prefab.');
  if (findPrefab(w, name)) throw bad(`There's already a prefab called "${name}".`);
  if (w.prefabs.length >= WORLD_LIMITS.prefabs) throw bad(`This world has ${WORLD_LIMITS.prefabs} prefabs, the most it can hold.`);
  let lo: Vec3 = [-Infinity, -Infinity, -Infinity];
  let hi: Vec3 = [Infinity, Infinity, Infinity];
  if (req.box !== undefined) {
    const b = req.box as { min?: unknown; max?: unknown } | unknown[];
    const pair = Array.isArray(b) ? b : [b?.min, b?.max];
    const ok = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every((n) => Number.isFinite(Number(n)));
    if (!ok(pair[0]) || !ok(pair[1])) throw bad('box is {"min": [x, y, z], "max": [x, y, z]} in map units from the object\'s origin');
    lo = pair[0].map((n, i) => Math.min(Number(n), Number((pair[1] as Vec3)[i]))) as Vec3;
    hi = pair[0].map((n, i) => Math.max(Number(n), Number((pair[1] as Vec3)[i]))) as Vec3;
  }
  const data = readObject(w.id, o.id);
  const grids = loadGrids(data);
  const taken: Grid[] = [];
  // voxels whose middle is inside the box
  for (const g of grids) {
    const out: Grid = { id: g.id, voxelSize: g.voxelSize, vol: newVolume(g.voxelSize) };
    for (const [k, c] of g.vol.chunks) {
      const [cx, cy, cz] = k.split(',').map(Number);
      for (let i = 0; i < c.length; i++) {
        if (!c[i]) continue;
        const x = cx * CHUNK + (i % CHUNK);
        const y = cy * CHUNK + Math.floor(i / (CHUNK * CHUNK));
        const z = cz * CHUNK + (Math.floor(i / CHUNK) % CHUNK);
        const m = [(x + 0.5) * g.voxelSize, (y + 0.5) * g.voxelSize, (z + 0.5) * g.voxelSize];
        if (m.some((n, a) => n < lo[a] || n > hi[a])) continue;
        const key = chunkKey(cx, cy, cz);
        let oc = out.vol.chunks.get(key);
        if (!oc) out.vol.chunks.set(key, (oc = new Uint8Array(c.length)));
        oc[cellIndex(x - cx * CHUNK, y - cy * CHUNK, z - cz * CHUNK)] = c[i];
        if (req.replace) c[i] = 0;
      }
    }
    if (out.vol.chunks.size) taken.push(out);
  }
  const inBox = (i: PrefabInstance) => i.p.every((n, a) => n >= lo[a] && n <= hi[a]);
  const instances = (data?.instances || []).filter(inBox);
  const meta: VoxelPrefabMeta = { id: uid('p'), name, description: String(req.description ?? '').slice(0, 300), tags: Array.isArray(req.tags) ? req.tags.map((t) => String(t).toLowerCase()).slice(0, 12) : [], by: req.by, volumes: volumesMeta(taken), instances: instances.length || undefined, pivot: [0, 0, 0], size: [0, 0, 0], createdAt: Date.now(), updatedAt: Date.now(), voxelsAt: Date.now() };
  if (!count(meta) && !instances.length) throw bad('Nothing of that object is inside the box.');
  if (count(meta) > WORLD_LIMITS.prefabVoxels) throw bad(`a prefab can hold ${fmt(WORLD_LIMITS.prefabVoxels)} voxels; that part has ${fmt(count(meta))}.`);
  pivotOf(meta);
  writePrefab(w.id, meta.id, { ...saveGrids(taken), ...(instances.length ? { instances } : {}) });
  w.prefabs.push(meta);
  let note = '';
  if (req.replace) {
    // the part becomes a copy of the new prefab, standing where it stood
    const left = (data?.instances || []).filter((i) => !inBox(i));
    left.push({ prefab: meta.id, p: meta.pivot });
    const before = structuredClone(o);
    writeObject(w.id, o.id, { ...saveGrids(grids), instances: left });
    o.volumes = volumesMeta(grids);
    o.instances = left.length;
    o.updatedAt = o.voxelsAt = Date.now();
    o.lastBy = req.by;
    remember(w.id, { by: req.by, what: `turned part of ${o.name} into the prefab ${name}`, objectId: o.id, metaBefore: before, dataBefore: data });
    note = ` That part of "${o.name}" is now a copy of it.`;
  }
  remember(w.id, { by: req.by, kind: 'prefab', what: `made the prefab ${name}`, objectId: meta.id, metaBefore: null });
  saveWorld(w, { prefabs: [meta.id], objects: req.replace ? [o.id] : [], by: req.by.name });
  return { prefab: meta, text: `Made the prefab "${name}" from "${o.name}": ${fmt(count(meta))} voxels${instances.length ? ` and ${instances.length} copies of other prefabs` : ''}, ${meta.size.join('×')} map units.${note} Place copies with {"place": "${name}"}.` };
}

// ---------- changing one ----------
export function changePrefab(req: { by: WorldBuilder; prefab: string; name?: unknown; description?: unknown; tags?: unknown; project?: string }): { prefab: VoxelPrefabMeta; text: string } {
  const w = worldForBuild(req.project || activeProject().id);
  const p = findPrefab(w, req.prefab);
  if (!p) throw bad(`There's no prefab "${req.prefab}".`, 404);
  const before = structuredClone(p);
  const changed: string[] = [];
  if (req.name !== undefined) {
    const n = String(req.name).trim().slice(0, 80);
    if (!n) throw bad('name is empty');
    if (n.toLowerCase() !== p.name.toLowerCase() && findPrefab(w, n)) throw bad(`There's already a prefab called "${n}".`);
    p.name = n;
    changed.push('name');
  }
  if (req.description !== undefined) (p.description = String(req.description).slice(0, 300)), changed.push('description');
  if (Array.isArray(req.tags)) (p.tags = req.tags.map((t) => String(t).toLowerCase()).slice(0, 12)), changed.push('tags');
  if (!changed.length) return { prefab: p, text: 'Nothing to change: give name, description or tags.' };
  p.updatedAt = Date.now();
  p.lastBy = req.by;
  remember(w.id, { by: req.by, kind: 'prefab', what: `changed the prefab ${p.name} (${changed.join(', ')})`, objectId: p.id, metaBefore: before });
  saveWorld(w, { prefabs: [p.id], by: req.by.name });
  return { prefab: p, text: `Changed the prefab "${p.name}": ${changed.join(', ')}.` };
}

export function deletePrefab(req: { by: WorldBuilder; prefab: string; project?: string }): string {
  const w = worldForBuild(req.project || activeProject().id);
  const p = findPrefab(w, req.prefab);
  if (!p) throw bad(`There's no prefab "${req.prefab}".`, 404);
  const used = prefabUses(w).get(p.id);
  if (used) throw bad(`"${p.name}" is placed ${used.copies} times (in ${used.in.join(', ')}). Take those copies away first ({"unplace": "${p.name}"}), then delete it.`, 409);
  const data = readPrefab(w.id, p.id);
  w.prefabs = w.prefabs.filter((x) => x.id !== p.id);
  writePrefab(w.id, p.id, null);
  remember(w.id, { by: req.by, kind: 'prefab', what: `deleted the prefab ${p.name}`, objectId: p.id, metaBefore: p, dataBefore: data });
  saveWorld(w, { prefabs: [p.id], deleted: true, by: req.by.name });
  return `Deleted the prefab "${p.name}". It can be brought back with world_undo.`;
}

// ---------- the prefab library ----------
/** A prefab shared to every world: its voxels use its own small palette. */
interface LibraryPrefab {
  id: string;
  name: string;
  description: string;
  tags: string[];
  by: string;
  fromWorld: string;
  size: Vec3;
  voxels: number;
  palette: VoxelMaterial[];
  data: VoxelObjectData;
  createdAt: number;
}
const LIB_ID = /^[\w-]{1,64}$/;
const libDir = () => dataPath('prefab-library');
const libFile = (id: string) => dataPath('prefab-library', `${id}.json`);
function library(): LibraryPrefab[] {
  return listFiles(libDir(), (n) => n.endsWith('.json') && LIB_ID.test(n.slice(0, -5)))
    .map((n) => readPlain<LibraryPrefab | null>(dataPath('prefab-library', n), null))
    .filter((x): x is LibraryPrefab => !!x && typeof x.name === 'string' && !!x.data);
}

export function libraryList(query = ''): string {
  const q = query.trim().toLowerCase();
  const all = library().filter((p) => !q || `${p.name} ${p.description} ${p.tags.join(' ')}`.toLowerCase().includes(q));
  if (!all.length) return q ? `Nothing in the prefab library matches "${query}".` : 'The prefab library is empty. Publish a prefab you made (action "publish") to share it with every world.';
  return all.map((p) => `- "${p.name}" by ${p.by} (from "${p.fromWorld}"): ${p.description || 'no description'}${p.tags.length ? ` [${p.tags.join(', ')}]` : ''} | ${p.size.join('×')} map units, ${fmt(p.voxels)} voxels`).join('\n');
}

/** Values in a prefab's voxels, through a map (palette value → palette value). */
function remap(data: VoxelObjectData, map: Map<number, number>): VoxelObjectData {
  const grids = loadGrids(data);
  for (const g of grids) for (const c of g.vol.chunks.values()) for (let i = 0; i < c.length; i++) if (c[i]) c[i] = map.get(c[i]) ?? c[i];
  return saveGrids(grids);
}

export function publishPrefab(req: { by: WorldBuilder; prefab: string; project?: string }): string {
  const w = worldForBuild(req.project || activeProject().id);
  const p = findPrefab(w, req.prefab);
  if (!p) throw bad(`There's no prefab "${req.prefab}".`, 404);
  const data = readPrefab(w.id, p.id);
  if (!data) throw bad(`"${p.name}" has no voxels yet.`);
  if (data.instances?.length) throw bad(`"${p.name}" holds copies of other prefabs. Publish those first, or stamp them into it ({"stamp": …}) so it stands alone.`);
  // its own palette: only the materials it uses, in a new order
  const used = new Set<number>();
  for (const g of loadGrids(data)) for (const c of g.vol.chunks.values()) for (const v of c) if (v) used.add(v);
  const order = [...used].sort((a, b) => a - b);
  const palette = order.map((v) => w.palette[v - 1] || { name: `material ${v}`, color: '#8a8a8a', kind: 'solid' as const });
  const map = new Map(order.map((v, i) => [v, i + 1]));
  // the same name again replaces that entry
  const existing = library().find((x) => x.name.toLowerCase() === p.name.toLowerCase());
  const entry: LibraryPrefab = { id: existing?.id || uid('lp'), name: p.name, description: p.description, tags: p.tags, by: req.by.name, fromWorld: w.name, size: p.size, voxels: count(p), palette, data: remap(data, map), createdAt: Date.now() };
  writeJSON(libFile(entry.id), entry);
  return `${existing ? 'Updated' : 'Published'} "${p.name}" in the prefab library: every world can take it now (world_prefab action "import").`;
}

export function importPrefab(req: { by: WorldBuilder; name: string; as?: unknown; project?: string }): { prefab: VoxelPrefabMeta; text: string } {
  const w = worldForBuild(req.project || activeProject().id);
  const lib = library().find((x) => x.name.toLowerCase() === String(req.name ?? '').trim().toLowerCase() || x.id === req.name);
  if (!lib) throw bad(`There's no "${req.name}" in the prefab library. Action "library" lists what is there.`, 404);
  if (w.prefabs.length >= WORLD_LIMITS.prefabs) throw bad(`This world has ${WORLD_LIMITS.prefabs} prefabs, the most it can hold.`);
  if (worldVoxels(w) + lib.voxels > WORLD_LIMITS.voxels) throw bad(`This world has no room for ${fmt(lib.voxels)} more voxels.`);
  // its materials by name: the world's own when it has one by that name (so it fits the world's look), else added
  const map = new Map<number, number>();
  const added: string[] = [];
  lib.palette.forEach((m, i) => {
    const name = String(m.name).toLowerCase();
    let at = w.palette.findIndex((x) => x.name === name);
    if (at < 0) {
      if (w.palette.length >= 255) throw bad("This world's palette is full.");
      w.palette.push(cleanMaterial({ ...m, material: name }, stockMaterial(name)));
      added.push(name);
      at = w.palette.length - 1;
    }
    map.set(i + 1, at + 1);
  });
  const data = remap(lib.data, map);
  const name = uniqueName(w, String(req.as ?? '').trim() || lib.name);
  const meta: VoxelPrefabMeta = { id: uid('p'), name, description: lib.description, tags: lib.tags, by: req.by, volumes: volumesMeta(loadGrids(data)), pivot: [0, 0, 0], size: [0, 0, 0], createdAt: Date.now(), updatedAt: Date.now(), voxelsAt: Date.now() };
  pivotOf(meta);
  writePrefab(w.id, meta.id, data);
  w.prefabs.push(meta);
  w.built = true;
  remember(w.id, { by: req.by, kind: 'prefab', what: `took the prefab ${name} from the library`, objectId: meta.id, metaBefore: null });
  saveWorld(w, { prefabs: [meta.id], by: req.by.name });
  return { prefab: meta, text: `Took "${lib.name}" from the prefab library as "${name}"${added.length ? `; added to the palette: ${added.join(', ')}` : ''}. Place copies with {"place": "${name}"}.` };
}

export function removeFromLibrary(name: string): string {
  const lib = library().find((x) => x.name.toLowerCase() === name.trim().toLowerCase() || x.id === name);
  if (!lib) throw bad(`There's no "${name}" in the prefab library.`, 404);
  fs.rmSync(libFile(lib.id), { force: true });
  return `Took "${lib.name}" out of the prefab library (worlds that took it keep their copy).`;
}

export { placedCopies };
