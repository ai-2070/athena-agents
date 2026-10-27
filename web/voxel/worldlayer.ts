// The project's voxel world on the Station: loads the world it shows (GET /api/world), meshes each object
// in a worker, keeps every object on what it is pinned to (a team's platform moves when dragged), and
// reloads what changed when the server says the world changed.
// Prefab copies placed in an object are drawn as instances: each prefab variant (mirrored, materials
// swapped) is meshed once and repeated on the GPU, so a crowd of hundreds costs a few draw calls.
import * as THREE from 'three';
import { GET } from '../client/http.ts';
import { serverUrl } from '../client/connection.ts';
import { meshObject } from './mesher.ts';
import type { ObjectPart, RenderClass } from './mesher.ts';
import { partGeometry, partMatrix } from './view.ts';
import type { WorldView } from './view.ts';
import { expandInstances, mirrorData, reachablePrefabs, swapPalette } from './instances.ts';
import type { FlatCopy, Variant } from './instances.ts';
import { envPreset } from '../../shared/worldenv.ts';
import type { ShownWorld, VoxelMaterial, VoxelObjectData, VoxelObjectMeta, VoxelPrefabMeta, WorldAnchor } from '../../shared/types.ts';

/** Where an anchor is on the map now (null: not in this project, e.g. another project's team). */
export type AnchorAt = (a: WorldAnchor) => THREE.Vector3 | null;

export interface WorldLayer {
  /** what GET /api/world said last */
  readonly shown: ShownWorld | null;
  /** load again what changed (debounced) */
  refresh(): void;
  /** follow anchors (each frame) */
  update(): void;
  /** how far the world reaches from the middle (map units), for fitting the view */
  radius(): number;
  dispose(): void;
}

/** Answers from GET /api/world. */
type ShownWithName = ShownWorld & { fromProjectName?: string };

// One worker for the page; jobs answered in any order.
let worker: Worker | null = null;
let workerBroken = false;
let jobs = 0;
const waiting = new Map<number, { ok: (p: ObjectPart[]) => void; fail: (e: Error) => void }>();
function meshInWorker(data: VoxelObjectData, palette: VoxelMaterial[]): Promise<ObjectPart[]> {
  if (!worker && !workerBroken && typeof Worker === 'function') {
    try {
      worker = new Worker(serverUrl('/dist/voxel/mesh.worker.js'), { type: 'module' });
      worker.onmessage = (e: MessageEvent<{ job: number; parts?: ObjectPart[]; error?: string }>) => {
        const w = waiting.get(e.data.job);
        waiting.delete(e.data.job);
        if (e.data.error || !e.data.parts) w?.fail(new Error(e.data.error || 'meshing failed'));
        else w?.ok(e.data.parts);
      };
      worker.onerror = () => {
        // (no worker file, e.g. a dev build without it): mesh here instead from now on
        workerBroken = true;
        worker = null;
        for (const w of waiting.values()) w.fail(new Error('worker'));
        waiting.clear();
      };
    } catch {
      workerBroken = true;
    }
  }
  // (the worker only needs the voxels, not the copies placed in them)
  const voxelsOnly: VoxelObjectData = { volumes: data.volumes || [] };
  if (!worker) return Promise.resolve(meshObject(voxelsOnly, palette));
  const job = ++jobs;
  return new Promise<ObjectPart[]>((ok, fail) => {
    waiting.set(job, { ok, fail });
    worker!.postMessage({ job, data: voxelsOnly, palette, region: 32 });
  }).catch(() => meshObject(voxelsOnly, palette));
}

/** A prefab variant, meshed: its parts as shared geometry, and how many objects use it now. */
interface PrefabMesh {
  parts: { geo: THREE.BufferGeometry; cls: RenderClass; local: THREE.Matrix4 }[];
  users: number;
}

/** An object on the map. */
interface Placed {
  meta: VoxelObjectMeta;
  /** the palette its voxels were coloured with */
  palette: string;
  group: THREE.Group;
  data: VoxelObjectData;
  /** the prefabs (and their versions) its copies were drawn from */
  copiesKey: string;
  copies: THREE.InstancedMesh[];
  meshKeys: string[];
}

const stampOf = (p: VoxelPrefabMeta) => p.voxelsAt ?? p.updatedAt;

export function createWorldLayer(view: WorldView, anchorAt: AnchorAt, onShown?: (s: ShownWithName) => void): WorldLayer {
  let shown: ShownWithName | null = null;
  let alive = true;
  const placed = new Map<string, Placed>();
  /** prefab voxels, by id, with the version they are */
  const prefabData = new Map<string, { stamp: number; data: VoxelObjectData }>();
  /** meshed prefab variants, by prefab id, version, variant and palette */
  const prefabMeshes = new Map<string, PrefabMesh>();
  let envKey = '';
  let timer: ReturnType<typeof setTimeout> | null = null;
  let loading: Promise<void> | null = null;
  let again = false;
  let worldId = '';
  const groupId = (m: VoxelObjectMeta) => `world:${worldId}:${m.id}`;

  const freeUnused = () => {
    for (const [k, pm] of prefabMeshes) {
      if (pm.users > 0) continue;
      for (const part of pm.parts) part.geo.dispose();
      prefabMeshes.delete(k);
    }
  };
  /** Takes an object's copies off the map (their geometry stays while other objects use it). */
  const dropCopies = (p: Placed) => {
    for (const m of p.copies) {
      p.group.remove(m);
      m.dispose();
    }
    for (const k of p.meshKeys) {
      const pm = prefabMeshes.get(k);
      if (pm) pm.users--;
    }
    p.copies = [];
    p.meshKeys = [];
    p.copiesKey = '';
  };
  const dropObject = (p: Placed) => {
    // (copies first: removeVolume disposes the geometry of what is left in the group)
    dropCopies(p);
    view.removeVolume(groupId(p.meta));
  };
  const dropAll = () => {
    for (const p of placed.values()) dropObject(p);
    placed.clear();
    freeUnused();
    prefabData.clear();
  };

  async function load(): Promise<void> {
    const s = await GET<ShownWithName>('/world').catch(() => null);
    if (!alive || !s) return;
    shown = s;
    onShown?.(s);
    const w = s.world;
    // another world (or none): start over
    if (!w || w.id !== worldId) {
      dropAll();
      worldId = w?.id || '';
    }
    const env = w?.environment || envPreset('station');
    const ek = JSON.stringify(env);
    if (ek !== envKey) {
      envKey = ek;
      view.setEnvironment(env);
    }
    if (!w) return;
    const wid = w.id;
    const prefabs = new Map((w.prefabs || []).map((p) => [p.id, p]));
    const want = new Map(w.objects.filter((o) => !o.hidden).map((o) => [o.id, o]));
    for (const [id, p] of placed) if (!want.has(id)) (dropObject(p), placed.delete(id));
    // prefabs that were deleted or changed: their voxels are loaded again when needed
    for (const [id, d] of prefabData) {
      const pm = prefabs.get(id);
      if (!pm || stampOf(pm) !== d.stamp) prefabData.delete(id);
    }
    const palette = JSON.stringify(w.palette);
    const paletteKey = hashText(palette);
    const stale = () => !alive || worldId !== wid;

    // the voxels of every prefab these copies reach (nested ones too), each loaded once
    const loadPrefabs = async (data: VoxelObjectData): Promise<void> => {
      for (let round = 0; round < 5; round++) {
        const missing = [...reachablePrefabs(data.instances, (id) => prefabData.get(id)?.data)].filter((id) => prefabs.has(id) && !prefabData.has(id));
        if (!missing.length) return;
        await Promise.all(
          missing.map(async (id) => {
            const d = await GET<VoxelObjectData>(`/worlds/${wid}/prefabs/${id}`).catch(() => null);
            const pm = prefabs.get(id);
            if (d && pm && !stale()) prefabData.set(id, { stamp: stampOf(pm), data: d });
          }),
        );
        if (stale()) return;
      }
    };
    // which prefabs (and versions) an object's copies come from: when this changes, they are drawn again
    const copiesKeyOf = (data: VoxelObjectData) =>
      `${[...reachablePrefabs(data.instances, (id) => prefabData.get(id)?.data)]
        .sort()
        .map((id) => `${id}@${prefabs.has(id) ? stampOf(prefabs.get(id)!) : 'gone'}`)
        .join(',')}#${data.instances?.length || 0}`;

    // a prefab variant, meshed (once for every object that uses it)
    const variantMesh = async (id: string, v: Variant, key: string): Promise<PrefabMesh | null> => {
      const hit = prefabMeshes.get(key);
      if (hit) return hit;
      const d = prefabData.get(id)?.data;
      if (!d) return null;
      const parts = await meshInWorker(v.mirror ? mirrorData(d) : d, swapPalette(w.palette, v.swap));
      if (stale()) return null;
      // (another object meshed the same variant meanwhile)
      const raced = prefabMeshes.get(key);
      if (raced) return raced;
      const pm: PrefabMesh = { parts: parts.map((p) => ({ geo: partGeometry(p), cls: p.cls, local: partMatrix(p) })), users: 0 };
      prefabMeshes.set(key, pm);
      return pm;
    };

    const drawCopies = async (p: Placed): Promise<void> => {
      dropCopies(p);
      await loadPrefabs(p.data);
      if (stale()) return;
      const flat = expandInstances(p.data.instances, (id) => {
        const meta = prefabs.get(id);
        const d = prefabData.get(id);
        return meta && d ? { data: d.data, pivot: meta.pivot } : null;
      });
      // the copies of each prefab variant together: one instanced mesh per part
      const byVariant = new Map<string, FlatCopy[]>();
      for (const c of flat) {
        const k = `${c.prefab}@${stampOf(prefabs.get(c.prefab)!)}|${c.key}|${paletteKey}`;
        const list = byVariant.get(k);
        if (list) list.push(c);
        else byVariant.set(k, [c]);
      }
      const m = new THREE.Matrix4();
      for (const [k, copies] of byVariant) {
        const pm = await variantMesh(copies[0].prefab, copies[0].variant, k);
        if (stale()) return;
        if (!pm) continue;
        pm.users++;
        p.meshKeys.push(k);
        for (const part of pm.parts) {
          const mesh = new THREE.InstancedMesh(part.geo, view.material(part.cls), copies.length);
          copies.forEach((c, i) => mesh.setMatrixAt(i, m.multiplyMatrices(c.matrix, part.local)));
          mesh.instanceMatrix.needsUpdate = true;
          mesh.computeBoundingSphere();
          mesh.castShadow = part.cls !== 'transparent';
          mesh.receiveShadow = part.cls !== 'emissive';
          p.group.add(mesh);
          p.copies.push(mesh);
        }
      }
      p.copiesKey = copiesKeyOf(p.data);
    };

    for (const o of want.values()) {
      const p = placed.get(o.id);
      // its voxels and their colours are as meshed: at most its copies' prefabs changed
      if (p && p.palette === palette && p.meta.voxelsAt === o.voxelsAt && (p.meta.instances || 0) === (o.instances || 0) && JSON.stringify(p.meta.volumes) === JSON.stringify(o.volumes)) {
        p.meta = o;
        await loadPrefabs(p.data);
        if (stale()) return;
        if (copiesKeyOf(p.data) !== p.copiesKey) await drawCopies(p);
        if (stale()) return;
        continue;
      }
      const data = await GET<VoxelObjectData>(`/worlds/${wid}/objects/${o.id}`).catch(() => null);
      if (stale()) return;
      if (!data) continue;
      const parts = await meshInWorker(data, w.palette);
      if (stale()) return;
      // (its old copies come off before addParts replaces the group and disposes what's in it)
      if (p) dropCopies(p);
      const np: Placed = { meta: o, palette, group: view.addParts(groupId(o), parts), data, copiesKey: '', copies: [], meshKeys: [] };
      placed.set(o.id, np);
      if (data.instances?.length) await drawCopies(np);
      if (stale()) return;
    }
    freeUnused();
  }

  const run = () => {
    if (loading) {
      again = true;
      return;
    }
    loading = load()
      .catch(() => {})
      .finally(() => {
        loading = null;
        if (again && alive) {
          again = false;
          run();
        }
      });
  };
  run();

  // (reused every frame)
  const fallback = new THREE.Vector3();
  const box = new THREE.Box3();
  return {
    get shown() {
      return shown;
    },
    refresh() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(run, 120);
    },
    update() {
      for (const p of placed.values()) {
        const m = p.meta;
        // pinned to something this project doesn't have: where it last stood, or from the middle
        const base = anchorAt(m.anchor) || (m.lastWorldPos ? fallback.set(m.lastWorldPos[0] - m.position[0], m.lastWorldPos[1] - m.position[1], m.lastWorldPos[2] - m.position[2]) : fallback.set(0, 0, 0));
        p.group.position.set(base.x + m.position[0], base.y + m.position[1], base.z + m.position[2]);
        p.group.rotation.y = (m.rotation * Math.PI) / 180;
        p.group.scale.setScalar(m.scale || 1);
      }
    },
    radius() {
      let r = 0;
      for (const p of placed.values()) {
        box.setFromObject(p.group);
        if (!box.isEmpty()) r = Math.max(r, Math.hypot(box.min.x, box.min.z), Math.hypot(box.max.x, box.max.z));
      }
      return r;
    },
    dispose() {
      alive = false;
      if (timer) clearTimeout(timer);
      dropAll();
    },
  };
}

/** A short fingerprint of a text (the palette), for cache keys. */
function hashText(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return `${s.length}:${(h >>> 0).toString(36)}`;
}
