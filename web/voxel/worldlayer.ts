// The project's voxel world on the Station: loads the world it shows (GET /api/world), meshes each object
// in a worker, keeps every object on what it is pinned to (a team's platform moves when dragged), and
// reloads what changed when the server says the world changed.
import * as THREE from 'three';
import { GET } from '../client/http.ts';
import { serverUrl } from '../client/connection.ts';
import { meshObject } from './mesher.ts';
import type { ObjectPart } from './mesher.ts';
import type { WorldView } from './view.ts';
import { envPreset } from '../../shared/worldenv.ts';
import type { ShownWorld, VoxelMaterial, VoxelObjectData, VoxelObjectMeta, WorldAnchor } from '../../shared/types.ts';

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
  if (!worker) return Promise.resolve(meshObject(data, palette));
  const job = ++jobs;
  return new Promise<ObjectPart[]>((ok, fail) => {
    waiting.set(job, { ok, fail });
    worker!.postMessage({ job, data, palette, region: 32 });
  }).catch(() => meshObject(data, palette));
}

export function createWorldLayer(view: WorldView, anchorAt: AnchorAt, onShown?: (s: ShownWithName) => void): WorldLayer {
  let shown: ShownWithName | null = null;
  let alive = true;
  /** objects on the map: its meta, and the palette its voxels were coloured with */
  const placed = new Map<string, { meta: VoxelObjectMeta; palette: string; group: THREE.Group }>();
  let envKey = '';
  let timer: ReturnType<typeof setTimeout> | null = null;
  let loading: Promise<void> | null = null;
  let again = false;
  let worldId = '';
  const groupId = (m: VoxelObjectMeta) => `world:${worldId}:${m.id}`;
  const dropAll = () => {
    for (const p of placed.values()) view.removeVolume(groupId(p.meta));
    placed.clear();
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
    const want = new Map(w.objects.filter((o) => !o.hidden).map((o) => [o.id, o]));
    for (const [id, p] of placed) if (!want.has(id)) (view.removeVolume(groupId(p.meta)), placed.delete(id));
    const palette = JSON.stringify(w.palette);
    for (const o of want.values()) {
      const p = placed.get(o.id);
      // moved, turned, renamed, or nothing: the voxels and their colours are as meshed
      if (p && p.palette === palette && p.meta.voxelsAt === o.voxelsAt && JSON.stringify(p.meta.volumes) === JSON.stringify(o.volumes)) {
        p.meta = o;
        continue;
      }
      const data = await GET<VoxelObjectData>(`/worlds/${w.id}/objects/${o.id}`).catch(() => null);
      if (!alive || worldId !== w.id) return;
      if (!data) continue;
      const parts = await meshInWorker(data, w.palette);
      if (!alive || worldId !== w.id) return;
      placed.set(o.id, { meta: o, palette, group: view.addParts(groupId(o), parts) });
    }
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
        const base = anchorAt(m.anchor) || (m.lastWorldPos ? new THREE.Vector3(...m.lastWorldPos).sub(new THREE.Vector3(...m.position)) : new THREE.Vector3());
        p.group.position.set(base.x + m.position[0], base.y + m.position[1], base.z + m.position[2]);
        p.group.rotation.y = (m.rotation * Math.PI) / 180;
        p.group.scale.setScalar(m.scale || 1);
      }
    },
    radius() {
      let r = 0;
      for (const p of placed.values()) {
        const box = new THREE.Box3().setFromObject(p.group);
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
