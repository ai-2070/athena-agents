// Voxels → triangles. Faces between two solid voxels are skipped, each face corner is darkened by the
// solid voxels around it (ambient occlusion: the soft creases of the voxel look), and faces are split by
// how they are drawn: solid, glowing, or see-through (glass, water). Pure: no three.js, no DOM, so it
// can run in a worker and in tests.
import { CHUNK, cellIndex, chunkKey, materialShades, voxelShade } from '../../shared/voxel.ts';
import type { MaterialShades, Vec3i, Volume } from '../../shared/voxel.ts';
import type { VoxelMaterial } from '../../shared/types.ts';

export type RenderClass = 'opaque' | 'emissive' | 'transparent';

/** One render class of a meshed region. Positions are in voxels from the region's corner (0..size). */
export interface MeshPart {
  positions: Uint8Array;
  normals: Int8Array;
  /** rgb, 0..255, with the corner's ambient occlusion in it */
  colors: Uint8Array;
  indices: Uint32Array;
  faces: number;
}
export type MeshResult = Partial<Record<RenderClass, MeshPart>>;

/** The most voxels a region may be on a side: positions are bytes. */
export const MAX_REGION = 255;

/** How bright a face corner is with 0, 1, 2 or 3 solid voxels around it (3 = open). */
export const AO_LEVELS = [0.42, 0.62, 0.8, 1];

interface Corner {
  /** the corner, from the voxel's origin */
  at: Vec3i;
  /** the two side neighbours and the diagonal one that darken it (in front of the face) */
  s1: Vec3i;
  s2: Vec3i;
  c: Vec3i;
}
interface FaceDir {
  n: Vec3i;
  corners: Corner[];
}

const add = (a: Vec3i, b: Vec3i): Vec3i => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3i, k: number): Vec3i => [a[0] * k, a[1] * k, a[2] * k];

// The six faces, each with its corners counter-clockwise seen from outside.
const FACES: FaceDir[] = [0, 1, 2].flatMap((axis) =>
  [1, -1].map((sign) => {
    const n: Vec3i = [0, 0, 0];
    n[axis] = sign;
    const u: Vec3i = [0, 0, 0];
    const v: Vec3i = [0, 0, 0];
    u[(axis + 1) % 3] = 1;
    v[(axis + 2) % 3] = 1;
    const base: Vec3i = [0, 0, 0];
    base[axis] = sign > 0 ? 1 : 0;
    let order: [number, number][] = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ];
    // u × v points along +axis; facing the other way the corners go round the other way
    if (sign < 0) order = [order[0], order[3], order[2], order[1]];
    const corners = order.map(([cu, cv]) => {
      const du = scale(u, cu ? 1 : -1);
      const dv = scale(v, cv ? 1 : -1);
      return { at: add(add(base, scale(u, cu)), scale(v, cv)), s1: add(n, du), s2: add(n, dv), c: add(add(n, du), dv) };
    });
    return { n, corners };
  }),
);

interface Mat {
  cls: RenderClass;
  /** hides the faces of the voxels next to it, and darkens their corners */
  blocks: boolean;
  shades: MaterialShades;
}
const FALLBACK: VoxelMaterial = { name: 'unknown', color: '#8a8a8a', kind: 'solid' };
const classOf = (m: VoxelMaterial): RenderClass => (m.kind === 'emissive' ? 'emissive' : m.kind === 'glass' || m.kind === 'water' ? 'transparent' : 'opaque');

/**
 * Meshes the voxels of `vol` in the box from `min` with `size` voxels on each side.
 * palette[v - 1] is the material of value v. seed changes every voxel's shade.
 */
export function meshRegion(vol: Volume, min: Vec3i, size: Vec3i, palette: VoxelMaterial[], seed = 0): MeshResult {
  const [sx, sy, sz] = size;
  if (sx > MAX_REGION || sy > MAX_REGION || sz > MAX_REGION) throw new Error(`A region can be at most ${MAX_REGION} voxels on a side`);
  // the region with a one-voxel border from its neighbours, so faces and corners at the edge are right
  const px = sx + 2;
  const py = sy + 2;
  const pz = sz + 2;
  const grid = new Uint8Array(px * py * pz);
  const at = (x: number, y: number, z: number) => x + 1 + px * (z + 1 + pz * (y + 1));
  // copied chunk by chunk (one map lookup per chunk, not per voxel)
  const lo: Vec3i = [min[0] - 1, min[1] - 1, min[2] - 1];
  const hi: Vec3i = [min[0] + sx, min[1] + sy, min[2] + sz];
  const c0 = lo.map((n) => Math.floor(n / CHUNK));
  const c1 = hi.map((n) => Math.floor(n / CHUNK));
  for (let cy = c0[1]; cy <= c1[1]; cy++)
    for (let cz = c0[2]; cz <= c1[2]; cz++)
      for (let cx = c0[0]; cx <= c1[0]; cx++) {
        const chunk = vol.chunks.get(chunkKey(cx, cy, cz));
        if (!chunk) continue;
        const ox = cx * CHUNK;
        const oy = cy * CHUNK;
        const oz = cz * CHUNK;
        for (let y = Math.max(lo[1], oy); y <= Math.min(hi[1], oy + CHUNK - 1); y++)
          for (let z = Math.max(lo[2], oz); z <= Math.min(hi[2], oz + CHUNK - 1); z++) {
            let i = cellIndex(Math.max(lo[0], ox) - ox, y - oy, z - oz);
            let g = at(Math.max(lo[0], ox) - min[0], y - min[1], z - min[2]);
            for (let x = Math.max(lo[0], ox); x <= Math.min(hi[0], ox + CHUNK - 1); x++) grid[g++] = chunk[i++];
          }
      }

  const mats: (Mat | null)[] = [null];
  for (let v = 1; v < 256; v++) {
    const m = palette[v - 1] || FALLBACK;
    mats.push({ cls: classOf(m), blocks: classOf(m) !== 'transparent', shades: materialShades(m) });
  }
  const blocks = (x: number, y: number, z: number) => {
    const v = grid[at(x, y, z)];
    return v ? mats[v]!.blocks : false;
  };
  // a face shows unless the voxel in front hides it: a solid one, or more of the same glass or water
  const shows = (v: number, x: number, y: number, z: number) => {
    const w = grid[at(x, y, z)];
    if (!w) return true;
    if (mats[w]!.blocks) return false;
    return mats[v]!.blocks || w !== v;
  };

  // count first, so each class gets arrays of the right size
  const count: Record<RenderClass, number> = { opaque: 0, emissive: 0, transparent: 0 };
  for (let y = 0; y < sy; y++)
    for (let z = 0; z < sz; z++)
      for (let x = 0; x < sx; x++) {
        const v = grid[at(x, y, z)];
        if (!v) continue;
        for (const f of FACES) if (shows(v, x + f.n[0], y + f.n[1], z + f.n[2])) count[mats[v]!.cls]++;
      }

  const out: MeshResult = {};
  const fill: Partial<Record<RenderClass, { p: MeshPart; f: number }>> = {};
  for (const cls of ['opaque', 'emissive', 'transparent'] as RenderClass[]) {
    const n = count[cls];
    if (!n) continue;
    const p: MeshPart = { positions: new Uint8Array(n * 12), normals: new Int8Array(n * 12), colors: new Uint8Array(n * 12), indices: new Uint32Array(n * 6), faces: n };
    out[cls] = p;
    fill[cls] = { p, f: 0 };
  }

  const ao = [0, 0, 0, 0];
  for (let y = 0; y < sy; y++)
    for (let z = 0; z < sz; z++)
      for (let x = 0; x < sx; x++) {
        const v = grid[at(x, y, z)];
        if (!v) continue;
        const m = mats[v]!;
        let rgb: Vec3i | null = null;
        for (const f of FACES) {
          if (!shows(v, x + f.n[0], y + f.n[1], z + f.n[2])) continue;
          rgb ??= voxelShade(m.shades, min[0] + x, min[1] + y, min[2] + z, seed);
          const slot = fill[m.cls]!;
          const { p } = slot;
          const vi = slot.f * 4;
          for (let k = 0; k < 4; k++) {
            const c = f.corners[k];
            const s1 = blocks(x + c.s1[0], y + c.s1[1], z + c.s1[2]) ? 1 : 0;
            const s2 = blocks(x + c.s2[0], y + c.s2[1], z + c.s2[2]) ? 1 : 0;
            const cc = blocks(x + c.c[0], y + c.c[1], z + c.c[2]) ? 1 : 0;
            // glowing voxels aren't shadowed: they light their own creases
            ao[k] = m.cls === 'emissive' ? 3 : s1 && s2 ? 0 : 3 - (s1 + s2 + cc);
            const o = (vi + k) * 3;
            p.positions[o] = x + c.at[0];
            p.positions[o + 1] = y + c.at[1];
            p.positions[o + 2] = z + c.at[2];
            p.normals[o] = f.n[0] * 127;
            p.normals[o + 1] = f.n[1] * 127;
            p.normals[o + 2] = f.n[2] * 127;
            const light = AO_LEVELS[ao[k]];
            p.colors[o] = Math.round(rgb[0] * light);
            p.colors[o + 1] = Math.round(rgb[1] * light);
            p.colors[o + 2] = Math.round(rgb[2] * light);
          }
          // split the quad along the diagonal that keeps the shading smooth
          const ii = slot.f * 6;
          if (ao[0] + ao[2] < ao[1] + ao[3]) p.indices.set([vi + 1, vi + 2, vi + 3, vi + 1, vi + 3, vi], ii);
          else p.indices.set([vi, vi + 1, vi + 2, vi, vi + 2, vi + 3], ii);
          slot.f++;
        }
      }
  return out;
}
