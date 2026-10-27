// A floating island: grass on top, a layer of soil, then a rough cone of rock hanging below with darker
// stone and a few drips at the bottom. Its top is at y = -1, so what stands on it starts at y = 0.
import { hash3 } from '../../../shared/voxel.ts';
import { valueNoise } from '../noise.ts';
import type { GeneratorDef } from '../ops.ts';
import { num, matOr } from './params.ts';

export const island: GeneratorDef = {
  help: 'island: a floating island, its top at the spot (things stand on it at y 0). radius (default 8), depth (of the rocky underside, default radius × 0.9), flat (default true; false adds gentle hills), rough (edge, 0-1, default 0.3), top, soil, rock, bottom (materials: grass, dirt, stone, dark stone), pond ({"x", "z", "radius"} from the centre: water two voxels deep with a sand rim)',
  draw(pen, p) {
    const R = pen.vox(num(p.radius, 8, 1, 64));
    const D = pen.vox(num(p.depth, (R * pen.size * 0.9), 0.5, 64));
    const rough = num(p.rough, 0.3, 0, 1);
    const flat = typeof p.flat === 'boolean' ? p.flat : true;
    const top = matOr(pen, p.top, 'grass');
    const soil = matOr(pen, p.soil, 'dirt');
    const rock = matOr(pen, p.rock, 'stone');
    const bottom = matOr(pen, p.bottom, 'dark stone');
    const seed = Math.floor(pen.rand() * 1e9);
    // a pond: water two voxels deep, sand around it
    const pond = p.pond && typeof p.pond === 'object' && !Array.isArray(p.pond) ? (p.pond as Record<string, unknown>) : null;
    const px = pond ? Math.round(num(pond.x, 0, -64, 64) / pen.size) : 0;
    const pz = pond ? Math.round(num(pond.z, 0, -64, 64) / pen.size) : 0;
    const pr = pond ? pen.vox(num(pond.radius, (R * pen.size) / 4, 0.25, 32)) : 0;
    const water = pond ? pen.mat('water') : 0;
    const sand = pond ? pen.mat('sand') : 0;
    const E = Math.ceil(R * (1 + rough * 0.4)) + 2;
    for (let z = -E; z <= E; z++)
      for (let x = -E; x <= E; x++) {
        const d = Math.hypot(x, z);
        // a wobbly rim: big lobes and small bites
        const edge = R * (1 - rough * 0.25 + rough * 0.45 * valueNoise(x, z, Math.max(3, R * 0.45), seed) + rough * 0.12 * valueNoise(x, z, 3, seed + 1));
        if (d > edge) continue;
        const t = d / edge;
        // the underside: deepest in the middle, lumpy, with the odd drip of rock
        let depth = 2 + D * Math.pow(1 - t, 0.85) * (0.65 + 0.7 * valueNoise(x, z, Math.max(3, R * 0.25), seed + 2));
        if (hash3(x, 0, z, seed + 3) < 0.04 * (1 - t)) depth += 2 + hash3(x, 1, z, seed + 3) * D * 0.25;
        const low = -1 - Math.round(depth);
        const hill = flat ? 0 : Math.round(valueNoise(x, z, Math.max(4, R * 0.5), seed + 4) * R * 0.12 * (1 - t));
        const pd = pond ? Math.hypot(x - px, z - pz) : Infinity;
        const inPond = pd < pr;
        const rim = !inPond && pd < pr + 1.5;
        const high = inPond ? -3 : -1 + hill;
        const soilDepth = 2 + Math.round(valueNoise(x, z, 5, seed + 5) * 2);
        for (let y = low; y <= high; y++) {
          const fromTop = high - y;
          let v: number;
          if (fromTop === 0) v = inPond || rim ? sand : top;
          else if (fromTop <= soilDepth) v = soil;
          else {
            // by depth (the underside's surface is every column's bottom): soil streaks high up, stone, then dark stone
            const deep = (-1 - y) / (D + 2) + (hash3(x, y, z, seed + 6) - 0.5) * 0.25;
            const h = hash3(x, y, z, seed + 7);
            v = deep > 0.62 ? (h < 0.2 ? rock : bottom) : deep > 0.3 ? (h < 0.15 ? bottom : rock) : h < 0.25 ? soil : rock;
          }
          pen.put(x, y, z, v);
        }
        if (inPond) pen.box(x, -2, z, x, -1, z, water);
        // grass creeping over the rim
        else if (!rim && t > 0.9 && hash3(x, 2, z, seed + 8) < 0.35) pen.put(x, high - 1, z, top);
      }
  },
};
