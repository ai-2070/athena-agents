// The build language: a list of plain JSON steps run in order on one object (docs/internal/plans/VOXEL_WORLD_PLAN.md §4).
// Nothing is run as code. Positions are whole voxels of the current voxel size, from the cursor; generators
// (tree, island…) take their sizes in map units, so the same tree comes out finer at a smaller voxel size.
// A call either works as a whole or changes nothing: a step that fails puts back every voxel it changed.
import { CHUNK, CHUNK_CELLS, cellIndex, chunkKey, decodeChunk, encodeChunk, hash3, newVolume } from '../../shared/voxel.ts';
import { rng, valueNoise } from './noise.ts';
import type { Volume } from '../../shared/voxel.ts';
import { stockMaterial } from './materials.ts';
import { glyph, GLYPH_H, GLYPH_W } from './font.ts';
import { GENERATORS } from './generators/index.ts';
import type { VoxelMaterial, VoxelMaterialKind, VoxelObjectData } from '../../shared/types.ts';

export const LIMITS = {
  /** voxels one call may add, remove or repaint */
  changedPerCall: 250_000,
  /** voxels from the object's origin, each way */
  reach: 256,
  volumesPerObject: 16,
  palette: 255,
  /** single voxels in one "set" step */
  setPoints: 5000,
  steps: 400,
  scatter: 400,
};
export const VOXEL_SIZE_MIN = 0.05;
export const VOXEL_SIZE_MAX = 4;
const KINDS: VoxelMaterialKind[] = ['solid', 'glass', 'water', 'emissive', 'metal', 'leaf', 'snow'];

/** A step that can't be done, with the step's number and what to change. */
export class BuildError extends Error {}

/** One grid of an object, in memory. */
export interface Grid {
  id: string;
  voxelSize: number;
  vol: Volume;
}

export function loadGrids(data: VoxelObjectData | null | undefined): Grid[] {
  return (data?.volumes || []).map((v) => {
    const vol = newVolume(v.voxelSize);
    for (const [k, text] of Object.entries(v.chunks || {})) vol.chunks.set(k, decodeChunk(text));
    return { id: v.id, voxelSize: v.voxelSize, vol };
  });
}

/** Grids as stored: empty chunks and empty grids left out. */
export function saveGrids(grids: Grid[]): VoxelObjectData {
  const volumes: VoxelObjectData['volumes'] = [];
  for (const g of grids) {
    const chunks: Record<string, string> = {};
    for (const [k, c] of g.vol.chunks) if (c.some((x) => x)) chunks[k] = encodeChunk(c);
    if (Object.keys(chunks).length) volumes.push({ id: g.id, voxelSize: g.voxelSize, chunks });
  }
  return { volumes };
}

/** What a generator draws with: positions in voxels from the step's spot, sizes in map units through vox(). */
export interface Pen {
  /** the voxel size, in map units */
  readonly size: number;
  /** map units → whole voxels at this size (at least 1) */
  vox(mapUnits: number): number;
  /** a palette value by material name (a stock material is added on first use) */
  mat(name: string): number;
  /** the next repeatable random number in [0, 1) */
  rand(): number;
  put(x: number, y: number, z: number, value: number, opts?: { keep?: boolean }): void;
  get(x: number, y: number, z: number): number;
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, value: number, opts?: { keep?: boolean }): void;
  /** an ellipsoid; holes: the share of voxels left out (leafy crowns) */
  blob(cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, value: number, opts?: { keep?: boolean; holes?: number; rough?: number }): void;
  /** a line of spheres of radius r (0: one voxel thick) */
  line(a: [number, number, number], b: [number, number, number], value: number, r?: number, opts?: { keep?: boolean }): void;
}

export interface GeneratorDef {
  /** one line for the model: what it makes and its parameters (sizes in map units) */
  help: string;
  draw(pen: Pen, params: Record<string, unknown>): void;
}

/** What a call changed. before: every touched chunk as it was (null: there was none), for undo. */
export interface BuildOutcome {
  added: number;
  removed: number;
  painted: number;
  grids: Grid[];
  before: { gridId: string; voxelSize: number; chunks: Record<string, string | null> }[];
  /** materials added to the palette */
  newMaterials: string[];
  notes: string[];
}

type Step = Record<string, unknown>;
type V3 = [number, number, number];

const num = (v: unknown, what: string, { min = -Infinity, max = Infinity, def }: { min?: number; max?: number; def?: number } = {}): number => {
  if (v === undefined || v === null) {
    if (def !== undefined) return def;
    throw new BuildError(`${what} is missing`);
  }
  const n = Number(v);
  if (!Number.isFinite(n)) throw new BuildError(`${what} must be a number`);
  return Math.max(min, Math.min(max, n));
};
const int = (v: unknown, what: string, o: { min?: number; max?: number; def?: number } = {}): number => Math.round(num(v, what, o));
const vec = (v: unknown, what: string, def?: V3): V3 => {
  if (v === undefined && def) return def;
  if (!Array.isArray(v) || v.length !== 3) throw new BuildError(`${what} must be [x, y, z]`);
  return [num(v[0], what), num(v[1], what), num(v[2], what)];
};
const ivec = (v: unknown, what: string, def?: V3): V3 => vec(v, what, def).map(Math.round) as V3;
const size3 = (v: unknown, what: string): V3 => {
  const s = typeof v === 'number' ? [v, v, v] : v;
  const out = ivec(s, what);
  if (out.some((n) => n < 1 || n > LIMITS.reach * 2)) throw new BuildError(`${what}: each side from 1 to ${LIMITS.reach * 2} voxels`);
  return out;
};

const SHAPE_VERBS = ['box', 'sphere', 'ellipsoid', 'cylinder', 'cone', 'pyramid', 'torus', 'line', 'stairs', 'arch', 'set', 'layers', 'text', 'heightmap', 'replace', 'clear', 'scatter'];
const STATE_VERBS = ['voxel_size', 'material', 'use', 'seed', 'at', 'move', 'mirror'];
export const VERBS = [...SHAPE_VERBS, ...Object.keys(GENERATORS), ...STATE_VERBS];

function verbOf(step: Step): string {
  for (const v of SHAPE_VERBS) if (v in step) return v;
  for (const v of Object.keys(GENERATORS)) if (v in step) return v;
  for (const v of STATE_VERBS) if (v in step) return v;
  throw new BuildError(`unknown step. Each step has one of: ${VERBS.join(', ')}`);
}

/** A material from a step, checked. Unknown fields are ignored. */
export function cleanMaterial(step: Step, base?: VoxelMaterial): VoxelMaterial {
  const name = String(step.material ?? base?.name ?? '').trim().toLowerCase().slice(0, 40);
  if (!name) throw new BuildError('a material needs a name');
  const hex = (v: unknown, what: string) => {
    const s = String(v).trim();
    if (!/^#[0-9a-f]{6}$/i.test(s)) throw new BuildError(`${what} must be a color like #a0522d`);
    return s.toLowerCase();
  };
  const kind = step.kind === undefined ? base?.kind || 'solid' : String(step.kind);
  if (!KINDS.includes(kind as VoxelMaterialKind)) throw new BuildError(`kind is one of ${KINDS.join(', ')}`);
  const m: VoxelMaterial = { name, color: step.color !== undefined ? hex(step.color, 'color') : base?.color || '#8a8a8a', kind: kind as VoxelMaterialKind };
  const ramp = step.ramp !== undefined ? step.ramp : base?.ramp;
  if (ramp !== undefined) {
    if (!Array.isArray(ramp)) throw new BuildError('ramp must be a list of colors');
    m.ramp = ramp.slice(0, 6).map((c, i) => hex(c, `ramp[${i}]`));
  }
  const jitter = step.jitter ?? base?.jitter;
  if (jitter !== undefined) m.jitter = num(jitter, 'jitter', { min: 0, max: 0.3 });
  const emissive = step.emissive ?? base?.emissive;
  if (emissive !== undefined) m.emissive = num(emissive, 'emissive', { min: 0, max: 8 });
  const opacity = step.opacity ?? base?.opacity;
  if (opacity !== undefined) m.opacity = num(opacity, 'opacity', { min: 0.05, max: 1 });
  const roughness = step.roughness ?? base?.roughness;
  if (roughness !== undefined) m.roughness = num(roughness, 'roughness', { min: 0, max: 1 });
  return m;
}

export interface BuildInput {
  grids: Grid[];
  /** changed in place on success (materials added or changed) */
  palette: VoxelMaterial[];
  /** the voxel size the build starts with */
  voxelSize: number;
  steps: unknown[];
  seed?: number;
  newId: () => string;
}

export function runBuild(input: BuildInput): BuildOutcome {
  if (!Array.isArray(input.steps) || !input.steps.length) throw new BuildError('steps must be a list of build steps');
  if (input.steps.length > LIMITS.steps) throw new BuildError(`at most ${LIMITS.steps} steps in one call: split the build`);
  const grids = input.grids;
  const palette = input.palette.map((m) => ({ ...m }));
  const newMaterials: string[] = [];
  const notes: string[] = [];
  const before = new Map<Grid, Map<string, Uint8Array | null>>();
  let added = 0;
  let removed = 0;
  let painted = 0;

  // ---------- state ----------
  let grid: Grid;
  let use = 0;
  let seed = input.seed ?? 1;
  let random = rng(seed);
  /** the cursor, in map units */
  let cursor: V3 = [0, 0, 0];
  let mirror: ('x' | 'y' | 'z')[] = [];

  const gridFor = (size: number): Grid => {
    const s = num(size, 'voxel_size', { min: VOXEL_SIZE_MIN, max: VOXEL_SIZE_MAX });
    const found = grids.find((g) => Math.abs(g.voxelSize - s) < 1e-6);
    if (found) return found;
    if (grids.length >= LIMITS.volumesPerObject) throw new BuildError(`an object can mix at most ${LIMITS.volumesPerObject} voxel sizes`);
    const g: Grid = { id: input.newId(), voxelSize: s, vol: newVolume(s) };
    grids.push(g);
    return g;
  };
  grid = gridFor(input.voxelSize);

  const matIndex = (name: unknown): number => {
    const n = String(name ?? '').trim().toLowerCase();
    if (!n) throw new BuildError('no material named');
    const i = palette.findIndex((m) => m.name === n);
    if (i >= 0) return i + 1;
    const stock = stockMaterial(n);
    if (!stock) throw new BuildError(`no material "${n}". Define it first: {"material": "${n}", "color": "#rrggbb"}, or use a stock one (grass, stone, wood, water, lantern…)`);
    if (palette.length >= LIMITS.palette) throw new BuildError(`the palette is full (${LIMITS.palette} materials)`);
    palette.push({ ...stock });
    newMaterials.push(stock.name);
    return palette.length;
  };

  // ---------- writing voxels ----------
  const base = (): V3 => cursor.map((c) => Math.round(c / grid.voxelSize)) as V3;
  const setAbs = (x: number, y: number, z: number, value: number, keep = false) => {
    const R = LIMITS.reach;
    if (x < -R || x >= R || y < -R || y >= R || z < -R || z >= R) throw new BuildError(`it reaches past ${R} voxels from the object's origin. Use a bigger voxel size, or build that part as another object`);
    const cx = Math.floor(x / CHUNK);
    const cy = Math.floor(y / CHUNK);
    const cz = Math.floor(z / CHUNK);
    const k = chunkKey(cx, cy, cz);
    let c = grid.vol.chunks.get(k);
    const i = cellIndex(x - cx * CHUNK, y - cy * CHUNK, z - cz * CHUNK);
    const was = c ? c[i] : 0;
    if (was === value || (keep && was)) return;
    let seen = before.get(grid);
    if (!seen) before.set(grid, (seen = new Map()));
    if (!seen.has(k)) seen.set(k, c ? c.slice() : null);
    if (!c) grid.vol.chunks.set(k, (c = new Uint8Array(CHUNK_CELLS)));
    c[i] = value;
    if (!was) added++;
    else if (!value) removed++;
    else painted++;
    if (added + removed + painted > LIMITS.changedPerCall) throw new BuildError(`one call may change at most ${LIMITS.changedPerCall.toLocaleString('en-US')} voxels: split the build, or use a bigger voxel size`);
  };
  const getAbs = (x: number, y: number, z: number): number => {
    const cx = Math.floor(x / CHUNK);
    const cy = Math.floor(y / CHUNK);
    const cz = Math.floor(z / CHUNK);
    const c = grid.vol.chunks.get(chunkKey(cx, cy, cz));
    return c ? c[cellIndex(x - cx * CHUNK, y - cy * CHUNK, z - cz * CHUNK)] : 0;
  };
  /** puts a voxel at a spot from `o` (voxels), mirrored across the cursor when mirroring is on */
  const putFrom = (o: V3) => (x: number, y: number, z: number, value: number, keep = false) => {
    const p: V3 = [o[0] + x, o[1] + y, o[2] + z];
    const b = base();
    const spots: V3[] = [p];
    for (const ax of mirror) {
      const a = ax === 'x' ? 0 : ax === 'y' ? 1 : 2;
      for (const s of [...spots]) {
        const m: V3 = [...s];
        m[a] = 2 * b[a] - 1 - s[a];
        spots.push(m);
      }
    }
    for (const s of spots) setAbs(s[0], s[1], s[2], value, keep);
  };

  const makePen = (o: V3): Pen => {
    const put = putFrom(o);
    const pen: Pen = {
      size: grid.voxelSize,
      vox: (m) => Math.max(1, Math.round(num(m, 'size') / grid.voxelSize)),
      mat: (name) => matIndex(name),
      rand: () => random(),
      put: (x, y, z, v, opts) => put(Math.round(x), Math.round(y), Math.round(z), v, opts?.keep),
      get: (x, y, z) => getAbs(o[0] + Math.round(x), o[1] + Math.round(y), o[2] + Math.round(z)),
      box(x0, y0, z0, x1, y1, z1, v, opts) {
        for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z++) for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) put(x, y, z, v, opts?.keep);
      },
      blob(cx, cy, cz, rx, ry, rz, v, opts) {
        const [ax, ay, az] = [Math.max(0.5, rx), Math.max(0.5, ry), Math.max(0.5, rz)];
        const rough = opts?.rough ?? 0;
        for (let y = Math.floor(-ay); y <= Math.ceil(ay); y++)
          for (let z = Math.floor(-az); z <= Math.ceil(az); z++)
            for (let x = Math.floor(-ax); x <= Math.ceil(ax); x++) {
              const d = (x / ax) ** 2 + (y / ay) ** 2 + (z / az) ** 2;
              const edge = 1 - rough * hash3(cx + x, cy + y, cz + z, seed + 3);
              if (d > edge * edge) continue;
              if (opts?.holes && hash3(cx + x, cy + y, cz + z, seed + 5) < opts.holes) continue;
              put(Math.round(cx + x), Math.round(cy + y), Math.round(cz + z), v, opts?.keep);
            }
      },
      line(a, b, v, r = 0, opts) {
        const n = Math.max(1, Math.ceil(Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]), Math.abs(b[2] - a[2]))));
        for (let i = 0; i <= n; i++) {
          const t = i / n;
          const p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t].map(Math.round) as V3;
          if (r < 0.5) put(p[0], p[1], p[2], v, opts?.keep);
          else pen.blob(p[0], p[1], p[2], r, r, r, v, opts);
        }
      },
    };
    return pen;
  };

  /** fills the voxels of a box (from `o`, size `s`) that `inside` says, solid or as a one-voxel shell */
  const fillShape = (put: ReturnType<typeof putFrom>, s: V3, inside: (x: number, y: number, z: number) => boolean, value: number, hollow: boolean, keep: boolean) => {
    for (let y = 0; y < s[1]; y++)
      for (let z = 0; z < s[2]; z++)
        for (let x = 0; x < s[0]; x++) {
          if (!inside(x, y, z)) continue;
          if (hollow && inside(x + 1, y, z) && inside(x - 1, y, z) && inside(x, y + 1, z) && inside(x, y - 1, z) && inside(x, y, z + 1) && inside(x, y, z - 1)) continue;
          put(x, y, z, value, keep);
        }
  };

  // ---------- the steps ----------
  const run = (step: Step, depth: number) => {
    const verb = verbOf(step);
    // state
    if (!SHAPE_VERBS.includes(verb) && !(verb in GENERATORS)) {
      if (verb === 'voxel_size') {
        grid = gridFor(num(step.voxel_size, 'voxel_size'));
      } else if (verb === 'material') {
        const name = String(step.material).trim().toLowerCase();
        const i = palette.findIndex((m) => m.name === name);
        const m = cleanMaterial(step, i >= 0 ? palette[i] : stockMaterial(name));
        if (i >= 0) palette[i] = m;
        else {
          if (palette.length >= LIMITS.palette) throw new BuildError(`the palette is full (${LIMITS.palette} materials)`);
          palette.push(m);
          newMaterials.push(m.name);
        }
        use = i >= 0 ? i + 1 : palette.length;
      } else if (verb === 'use') {
        use = matIndex(step.use);
      } else if (verb === 'seed') {
        seed = int(step.seed, 'seed');
        random = rng(seed);
      } else if (verb === 'at') {
        const p = vec(step.at, 'at');
        cursor = step.units === 'map' ? p : (p.map((n) => Math.round(n) * grid.voxelSize) as V3);
      } else if (verb === 'move') {
        const p = vec(step.move, 'move');
        cursor = cursor.map((c, i) => c + (step.units === 'map' ? p[i] : Math.round(p[i]) * grid.voxelSize)) as V3;
      } else if (verb === 'mirror') {
        const m = step.mirror;
        const list = m === false || m === 'none' || m === null ? [] : Array.isArray(m) ? m : [m];
        if (list.some((a) => !['x', 'y', 'z'].includes(String(a)))) throw new BuildError('mirror is "x", "y", "z", a list of them, or "none"');
        mirror = [...new Set(list.map(String))] as ('x' | 'y' | 'z')[];
      }
      return;
    }

    // a shape or a generator: where, with what
    const off: V3 = step.at === undefined ? [0, 0, 0] : step.units === 'map' ? (vec(step.at, 'at').map((n) => Math.round(n / grid.voxelSize)) as V3) : ivec(step.at, 'at');
    const b = base();
    const o: V3 = [b[0] + off[0], b[1] + off[1], b[2] + off[2]];
    const erase = step.erase === true;
    const keep = step.keep === true;
    const hollow = step.hollow === true;
    const value = () => {
      if (erase) return 0;
      if (step.use !== undefined) return matIndex(step.use);
      if (!use) throw new BuildError('pick a material first: {"use": "stone"} (or "use" in this step)');
      return use;
    };
    const put = putFrom(o);

    if (verb in GENERATORS) {
      const params = step[verb] && typeof step[verb] === 'object' && !Array.isArray(step[verb]) ? (step[verb] as Record<string, unknown>) : {};
      GENERATORS[verb].draw(makePen(o), params);
      return;
    }
    switch (verb) {
      case 'box': {
        const s = size3(step.box, 'box');
        const v = value();
        if (step.frame === true) {
          const edge = (x: number, y: number, z: number) => [x === 0 || x === s[0] - 1, y === 0 || y === s[1] - 1, z === 0 || z === s[2] - 1].filter(Boolean).length >= 2;
          fillShape(put, s, edge, v, false, keep);
        } else fillShape(put, s, (x, y, z) => x >= 0 && y >= 0 && z >= 0 && x < s[0] && y < s[1] && z < s[2], v, hollow, keep);
        break;
      }
      case 'sphere':
      case 'ellipsoid': {
        const r: V3 = verb === 'sphere' ? (([n]) => [n, n, n] as V3)([num(step.sphere, 'sphere', { min: 0.5, max: LIMITS.reach })]) : (vec(step.ellipsoid, 'ellipsoid').map((n) => Math.max(0.5, Math.min(LIMITS.reach, n))) as V3);
        const v = value();
        const lo = r.map((n) => -Math.ceil(n)) as V3;
        const s = r.map((n) => Math.ceil(n) * 2 + 1) as V3;
        const inside = (x: number, y: number, z: number) => ((x + lo[0]) / r[0]) ** 2 + ((y + lo[1]) / r[1]) ** 2 + ((z + lo[2]) / r[2]) ** 2 <= 1;
        fillShape(putFrom([o[0] + lo[0], o[1] + lo[1], o[2] + lo[2]]), s, inside, v, hollow, keep);
        break;
      }
      case 'cylinder':
      case 'cone': {
        const r = num(step[verb], verb, { min: 0.5, max: LIMITS.reach });
        const h = int(step.height, 'height', { min: 1, max: LIMITS.reach * 2 });
        const axis = String(step.axis || 'y');
        if (!['x', 'y', 'z'].includes(axis)) throw new BuildError('axis is x, y or z');
        const down = step.down === true;
        const v = value();
        const R = Math.ceil(r);
        const radiusAt = (t: number) => (verb === 'cone' ? r * (1 - (down ? h - 1 - t : t) / h) : r);
        // (t: along the axis, a and c: across it)
        const inside = (t: number, a: number, c: number) => t >= 0 && t < h && (a - R) ** 2 + (c - R) ** 2 <= radiusAt(t) ** 2 + 0.25;
        const map = (t: number, a: number, c: number): V3 => (axis === 'y' ? [a - R, t, c - R] : axis === 'x' ? [t, a - R, c - R] : [a - R, c - R, t]);
        for (let t = 0; t < h; t++)
          for (let a = 0; a <= 2 * R; a++)
            for (let c = 0; c <= 2 * R; c++) {
              if (!inside(t, a, c)) continue;
              if (hollow && inside(t, a + 1, c) && inside(t, a - 1, c) && inside(t, a, c + 1) && inside(t, a, c - 1) && (verb === 'cylinder' ? true : inside(t + 1, a, c) && inside(t - 1, a, c))) continue;
              const [x, y, z] = map(t, a, c);
              put(x, y, z, v, keep);
            }
        break;
      }
      case 'pyramid': {
        const [w, d] = Array.isArray(step.pyramid) ? [int(step.pyramid[0], 'pyramid', { min: 1, max: 512 }), int(step.pyramid[1], 'pyramid', { min: 1, max: 512 })] : [int(step.pyramid, 'pyramid', { min: 1, max: 512 }), int(step.pyramid, 'pyramid', { min: 1, max: 512 })];
        const h = int(step.height, 'height', { min: 1, max: 512, def: Math.ceil(Math.min(w, d) / 2) });
        const v = value();
        for (let y = 0; y < h; y++) {
          const k = 1 - y / h;
          const hw = Math.max(0, Math.round((w * k) / 2));
          const hd = Math.max(0, Math.round((d * k) / 2));
          if (!hw || !hd) break;
          for (let z = -hd; z < hd; z++) for (let x = -hw; x < hw; x++) if (!hollow || y === 0 || x === -hw || x === hw - 1 || z === -hd || z === hd - 1) put(x, y, z, v, keep);
        }
        break;
      }
      case 'torus': {
        const R = num(step.torus, 'torus', { min: 1, max: LIMITS.reach });
        const t = num(step.tube, 'tube', { min: 0.5, max: R, def: Math.max(1, R / 4) });
        const v = value();
        const E = Math.ceil(R + t);
        const T = Math.ceil(t);
        for (let y = -T; y <= T; y++) for (let z = -E; z <= E; z++) for (let x = -E; x <= E; x++) if ((Math.hypot(x, z) - R) ** 2 + y * y <= t * t) put(x, y, z, v, keep);
        break;
      }
      case 'line': {
        const to = ivec(step.line, 'line');
        const thick = num(step.thickness, 'thickness', { min: 1, max: 32, def: 1 });
        makePen(o).line([0, 0, 0], to, value(), (thick - 1) / 2, { keep });
        break;
      }
      case 'stairs': {
        const s = (step.stairs && typeof step.stairs === 'object' ? step.stairs : {}) as Record<string, unknown>;
        const steps = int(s.steps, 'stairs.steps', { min: 1, max: 256 });
        const width = int(s.width, 'stairs.width', { min: 1, max: 256, def: 3 });
        const rise = int(s.rise, 'stairs.rise', { min: 1, max: 8, def: 1 });
        const runLen = int(s.run, 'stairs.run', { min: 1, max: 8, def: 1 });
        const dir = String(s.dir || '+x');
        if (!['+x', '-x', '+z', '-z'].includes(dir)) throw new BuildError('stairs.dir is +x, -x, +z or -z');
        const v = value();
        const solid = s.solid !== false;
        for (let i = 0; i < steps; i++)
          for (let r = 0; r < runLen; r++)
            for (let wv = 0; wv < width; wv++)
              for (let y = solid ? 0 : i * rise; y < (i + 1) * rise; y++) {
                const along = i * runLen + r;
                const [x, z] = dir === '+x' ? [along, wv] : dir === '-x' ? [-along, wv] : dir === '+z' ? [wv, along] : [wv, -along];
                put(x, y, z, v, keep);
              }
        break;
      }
      case 'arch': {
        const s = (step.arch && typeof step.arch === 'object' ? step.arch : {}) as Record<string, unknown>;
        const width = int(s.width, 'arch.width', { min: 3, max: 256 });
        const height = int(s.height, 'arch.height', { min: 2, max: 256 });
        const thick = int(s.thickness, 'arch.thickness', { min: 1, max: 64, def: 1 });
        const depth = int(s.depth, 'arch.depth', { min: 1, max: 64, def: 1 });
        const axis = String(s.axis || 'x');
        const v = value();
        // a wall `width` wide and `height` high with a round-topped opening; centred on the spot, along `axis`
        const hw = width / 2;
        const inner = hw - thick;
        const spring = Math.max(0, height - thick - inner);
        for (let y = 0; y < height; y++)
          for (let a = 0; a < width; a++) {
            const ax = a - hw + 0.5;
            const inOpening = inner > 0 && (y < spring ? Math.abs(ax) < inner : (ax / inner) ** 2 + ((y - spring) / Math.max(1, inner)) ** 2 < 1);
            if (inOpening) continue;
            for (let dd = 0; dd < depth; dd++) put(axis === 'x' ? a - Math.floor(hw) : dd, y, axis === 'x' ? dd : a - Math.floor(hw), v, keep);
          }
        break;
      }
      case 'set': {
        if (!Array.isArray(step.set)) throw new BuildError('set is a list of [x, y, z]');
        if (step.set.length > LIMITS.setPoints) throw new BuildError(`at most ${LIMITS.setPoints} voxels in one set: use shapes or layers for more`);
        const v = value();
        for (const p of step.set) {
          const [x, y, z] = ivec(p, 'each point of set');
          put(x, y, z, v, keep);
        }
        break;
      }
      case 'layers': {
        if (!Array.isArray(step.layers)) throw new BuildError('layers is a list of layers (bottom first), each a list of rows');
        const key = (step.key && typeof step.key === 'object' ? step.key : {}) as Record<string, unknown>;
        const values = new Map<string, number>();
        for (const [ch, name] of Object.entries(key)) {
          if ([...ch].length !== 1) throw new BuildError(`key: "${ch}" must be one character`);
          values.set(ch, name === null || name === '' ? 0 : matIndex(name));
        }
        if (step.layers.length > LIMITS.reach * 2) throw new BuildError('too many layers');
        step.layers.forEach((layer, y) => {
          if (!Array.isArray(layer)) throw new BuildError(`layer ${y} must be a list of rows`);
          layer.forEach((row, z) => {
            if (typeof row !== 'string') throw new BuildError(`layer ${y}, row ${z} must be a string`);
            [...row].forEach((ch, x) => {
              if (ch === '.' || ch === ' ') return;
              const v = values.get(ch);
              if (v === undefined) throw new BuildError(`layer ${y}, row ${z}: "${ch}" isn't in key (use "." for empty)`);
              put(x, y, z, v, keep);
            });
          });
        });
        break;
      }
      case 'text': {
        const text = String(step.text ?? '').slice(0, 80);
        const scale = int(step.scale, 'scale', { min: 1, max: 8, def: 1 });
        const depth = int(step.depth, 'depth', { min: 1, max: 8, def: 1 });
        const facing = String(step.facing || '+z');
        if (!['+z', '-z', '+x', '-x'].includes(facing)) throw new BuildError('facing is +z, -z, +x or -x');
        const v = value();
        let col = 0;
        for (const ch of text) {
          const g = glyph(ch);
          if (g)
            for (let r = 0; r < GLYPH_H; r++)
              for (let c = 0; c < GLYPH_W; c++) {
                if (!g[r][c]) continue;
                for (let sy = 0; sy < scale; sy++)
                  for (let sx = 0; sx < scale; sx++)
                    for (let d = 0; d < depth; d++) {
                      const u = (col + c) * scale + sx;
                      const y = (GLYPH_H - 1 - r) * scale + sy;
                      // reads left to right for someone facing the sign
                      const [x, z] = facing === '+z' ? [u, d] : facing === '-z' ? [-u, -d] : facing === '+x' ? [d, -u] : [-d, u];
                      put(x, y, z, v, keep);
                    }
              }
          col += GLYPH_W + 1;
        }
        break;
      }
      case 'heightmap': {
        const h = (step.heightmap && typeof step.heightmap === 'object' ? step.heightmap : {}) as Record<string, unknown>;
        const fill = value();
        const top = step.top !== undefined ? matIndex(step.top) : fill;
        const heights: number[][] = [];
        if (Array.isArray(h.rows)) {
          // digits and letters: 0-9 then a-z (10-35)
          for (const row of h.rows) heights.push([...String(row)].map((ch) => (ch === '.' ? -1 : parseInt(ch, 36) * num(h.scale, 'heightmap.scale', { min: 0.1, max: 16, def: 1 }))));
        } else {
          const [w, d] = Array.isArray(h.size) ? [int(h.size[0], 'heightmap.size', { min: 1, max: 512 }), int(h.size[1], 'heightmap.size', { min: 1, max: 512 })] : [16, 16];
          const max = num(h.height, 'heightmap.height', { min: 0, max: 256, def: 6 });
          const cell = num(h.cell, 'heightmap.cell', { min: 2, max: 256, def: 12 });
          for (let z = 0; z < d; z++) {
            const row: number[] = [];
            for (let x = 0; x < w; x++) row.push(1 + valueNoise(x, z, cell, seed) * max);
            heights.push(row);
          }
        }
        heights.forEach((row, z) =>
          row.forEach((hgt, x) => {
            const n = Math.round(hgt);
            for (let y = 0; y < n; y++) put(x, y, z, y === n - 1 ? top : fill, keep);
          }),
        );
        break;
      }
      case 'replace': {
        const r = (step.replace && typeof step.replace === 'object' ? step.replace : {}) as Record<string, unknown>;
        const from = matIndex(r.from);
        const to = r.to === null || r.to === '' ? 0 : matIndex(r.to);
        const chance = num(r.chance, 'replace.chance', { min: 0, max: 1, def: 1 });
        // inside a box from the spot ("in": [w, h, d]), or the whole of this voxel size's grid
        const box = step.in !== undefined ? size3(step.in, 'in') : null;
        const visit = (x: number, y: number, z: number) => {
          if (getAbs(x, y, z) !== from) return;
          if (chance < 1 && hash3(x, y, z, seed + 11) >= chance) return;
          setAbs(x, y, z, to);
        };
        if (box) for (let y = 0; y < box[1]; y++) for (let z = 0; z < box[2]; z++) for (let x = 0; x < box[0]; x++) visit(o[0] + x, o[1] + y, o[2] + z);
        else
          for (const [k, c] of [...grid.vol.chunks]) {
            const [cx, cy, cz] = k.split(',').map(Number);
            for (let i = 0; i < c.length; i++) if (c[i] === from) visit(cx * CHUNK + (i % CHUNK), cy * CHUNK + Math.floor(i / (CHUNK * CHUNK)), cz * CHUNK + (Math.floor(i / CHUNK) % CHUNK));
          }
        break;
      }
      case 'clear': {
        // everything at this voxel size in this object
        for (const [k, c] of [...grid.vol.chunks]) {
          const [cx, cy, cz] = k.split(',').map(Number);
          for (let i = 0; i < c.length; i++) if (c[i]) setAbs(cx * CHUNK + (i % CHUNK), cy * CHUNK + Math.floor(i / (CHUNK * CHUNK)), cz * CHUNK + (Math.floor(i / CHUNK) % CHUNK), 0);
        }
        break;
      }
      case 'scatter': {
        if (depth > 0) throw new BuildError("a scatter can't hold another scatter");
        const s = (step.scatter && typeof step.scatter === 'object' ? step.scatter : {}) as Record<string, unknown>;
        const count = int(s.count, 'scatter.count', { min: 1, max: LIMITS.scatter });
        const [w, d] = Array.isArray(s.area) ? [int(s.area[0], 'scatter.area', { min: 1, max: 512 }), int(s.area[1], 'scatter.area', { min: 1, max: 512 })] : [16, 16];
        const what = s.step;
        if (!what || typeof what !== 'object' || Array.isArray(what)) throw new BuildError('scatter.step is the step to repeat, e.g. {"tree": {"kind": "pine"}}');
        // each copy stands on the highest voxel of its column (or at the area's floor)
        const saved = cursor;
        for (let i = 0; i < count; i++) {
          const x = o[0] + Math.floor(random() * w);
          const z = o[2] + Math.floor(random() * d);
          let y = o[1];
          for (let yy = o[1] + 64; yy >= o[1] - 64; yy--)
            if (getAbs(x, yy, z)) {
              y = yy + 1;
              break;
            }
          cursor = [x * grid.voxelSize, y * grid.voxelSize, z * grid.voxelSize];
          const { at: _at, ...rest } = what as Step;
          run(rest, depth + 1);
        }
        cursor = saved;
        break;
      }
    }
  };

  try {
    input.steps.forEach((s, i) => {
      if (!s || typeof s !== 'object' || Array.isArray(s)) throw new BuildError(`step ${i + 1} must be an object like {"box": [4, 2, 4]}`);
      try {
        run(s as Step, 0);
      } catch (e) {
        if (e instanceof BuildError && !e.message.startsWith('Step ')) throw new BuildError(`Step ${i + 1} (${Object.keys(s as Step)[0]}): ${e.message}`);
        throw e;
      }
    });
  } catch (e) {
    // put every changed chunk back as it was
    for (const [g, chunks] of before) for (const [k, c] of chunks) c ? g.vol.chunks.set(k, c) : g.vol.chunks.delete(k);
    if (e instanceof BuildError) throw e;
    throw new BuildError(e instanceof Error ? e.message : String(e));
  }

  input.palette.splice(0, input.palette.length, ...palette);
  if (!added && !removed && !painted) notes.push('Nothing changed: every voxel was already like that.');
  return {
    added,
    removed,
    painted,
    grids,
    before: [...before].map(([g, chunks]) => ({ gridId: g.id, voxelSize: g.voxelSize, chunks: Object.fromEntries([...chunks].map(([k, c]) => [k, c ? encodeChunk(c) : null])) })),
    newMaterials,
    notes,
  };
}
