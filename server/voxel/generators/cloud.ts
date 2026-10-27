// A puffy cloud: a row of blobs on a flat-ish base, the middle ones tallest.
import type { GeneratorDef } from '../ops.ts';
import { num, matOr } from './params.ts';

export const cloud: GeneratorDef = {
  help: 'cloud: a puffy cloud, its flat base at the spot. width (default 6), height (default 2), material (default cloud)',
  draw(pen, p) {
    const W = pen.vox(num(p.width, 6, 0.5, 60));
    const H = pen.vox(num(p.height, 2, 0.25, 20));
    const v = matOr(pen, p.material, 'cloud');
    const puffs = Math.max(3, Math.min(9, Math.round(W / Math.max(2, H))));
    for (let i = 0; i < puffs; i++) {
      const t = puffs === 1 ? 0.5 : i / (puffs - 1);
      // taller in the middle, a little staggered front to back
      const peak = 1 - Math.abs(t - 0.5) * 1.2;
      const ry = Math.max(1, H * (0.45 + 0.55 * peak) * (0.85 + pen.rand() * 0.3));
      const rx = Math.max(1, (W / puffs) * (0.9 + pen.rand() * 0.5));
      const cx = (t - 0.5) * (W - rx * 1.5);
      const cz = (pen.rand() - 0.5) * H * 0.8;
      const rz = Math.max(1, ry * (0.9 + pen.rand() * 0.4));
      // centred low so the bottom is cut flat
      const cy = ry * 0.45;
      for (let y = 0; y <= Math.ceil(cy + ry); y++)
        for (let z = Math.floor(-rz); z <= Math.ceil(rz); z++)
          for (let x = Math.floor(-rx); x <= Math.ceil(rx); x++)
            if ((x / rx) ** 2 + ((y - cy) / ry) ** 2 + (z / rz) ** 2 <= 1) pen.put(Math.round(cx + x), y, Math.round(cz + z), v);
    }
  },
};
