// Rocks: lumpy boulders, tall spires and flat slabs, speckled with darker stone and moss on top.
import { hash3 } from '../../../shared/voxel.ts';
import type { GeneratorDef } from '../ops.ts';
import { num, str, matOr } from './params.ts';

/** Cells first, then each gets its material: the top ones may be moss, some are darker. */
class Cells {
  readonly set = new Set<string>();
  add(x: number, y: number, z: number): void {
    this.set.add(`${Math.round(x)},${Math.round(y)},${Math.round(z)}`);
  }
  has(x: number, y: number, z: number): boolean {
    return this.set.has(`${x},${y},${z}`);
  }
  blob(cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, seed: number, rough = 0.3): void {
    for (let y = Math.floor(-ry); y <= Math.ceil(ry); y++)
      for (let z = Math.floor(-rz); z <= Math.ceil(rz); z++)
        for (let x = Math.floor(-rx); x <= Math.ceil(rx); x++) {
          const d = (x / rx) ** 2 + (y / ry) ** 2 + (z / rz) ** 2;
          const edge = 1 - rough * hash3(Math.round(cx + x), Math.round(cy + y), Math.round(cz + z), seed);
          if (d <= edge * edge) this.add(cx + x, cy + y, cz + z);
        }
  }
}

export const rock: GeneratorDef = {
  help: 'rock: kind boulder|spire|flat (default boulder), size (default 1.2), material (default stone, speckled with dark stone), moss (material on top, default moss; "none" for bare)',
  draw(pen, p) {
    const kind = ['boulder', 'spire', 'flat'].includes(str(p.kind, 'boulder')) ? str(p.kind, 'boulder') : 'boulder';
    const S = pen.vox(num(p.size, 1.2, 0.2, 30));
    const stone = matOr(pen, p.material, 'stone');
    const dark = pen.mat('dark stone');
    const mossName = str(p.moss, 'moss');
    const moss = mossName === 'none' ? 0 : matOr(pen, mossName, 'moss');
    const seed = Math.floor(pen.rand() * 1e9);
    const c = new Cells();
    const r = Math.max(1, S / 2);
    if (kind === 'spire') {
      // a tapering column of stacked lumps, leaning a little
      const h = Math.max(3, Math.round(S * 2.6));
      const lx = (pen.rand() - 0.5) * 0.25;
      const lz = (pen.rand() - 0.5) * 0.25;
      for (let y = 0; y < h; y += Math.max(1, Math.round(r * 0.5))) {
        const k = 1 - (y / h) * 0.75;
        c.blob(lx * y, y, lz * y, r * 0.75 * k + 0.3, Math.max(1, r * 0.6), r * 0.75 * k + 0.3, seed, 0.35);
      }
    } else if (kind === 'flat') {
      c.blob(0, 0, 0, r * 1.8, Math.max(1, r * 0.45), r * 1.5, seed, 0.25);
      c.blob(r * 0.6, Math.max(1, r * 0.3), r * 0.2, r, Math.max(1, r * 0.35), r * 0.8, seed + 1, 0.3);
    } else {
      // two or three lumps, the main one sunk a little into the ground
      c.blob(0, r * 0.35, 0, r, r * 0.8, r * 0.9, seed, 0.3);
      const n = 1 + Math.floor(pen.rand() * 2);
      for (let i = 0; i < n; i++) {
        const a = pen.rand() * Math.PI * 2;
        c.blob(Math.cos(a) * r * 0.8, r * 0.15, Math.sin(a) * r * 0.8, r * 0.6, r * 0.5, r * 0.6, seed + 2 + i, 0.35);
      }
    }
    for (const k of c.set) {
      const [x, y, z] = k.split(',').map(Number);
      // cut flat at the ground: the rock looks sunk into it, and nothing pokes below the floor
      if (y < 0) continue;
      const top = !c.has(x, y + 1, z);
      const h = hash3(x, y, z, seed + 9);
      const v = top && moss && h < 0.35 ? moss : h > 0.82 || (y <= 0 && h > 0.5) ? dark : stone;
      pen.put(x, y, z, v);
    }
  },
};
