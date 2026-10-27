// A torii gate: two pillars on black bases, a lower beam through them, a dark top beam with upturned
// ends over a red one, and a small plaque between the beams.
import type { GeneratorDef } from '../ops.ts';
import { num, str, matOr } from './params.ts';

export const torii: GeneratorDef = {
  help: 'torii: a shrine gate, the spot between its pillars. width (default 3.5), height (default 4), axis "x" or "z" (the way its beams run, default x), material (default red lacquer), top (the top beam, default dark wood), base (default iron)',
  draw(pen, p) {
    const W = pen.vox(num(p.width, 3.5, 1, 40));
    const H = pen.vox(num(p.height, 4, 1, 40));
    const alongZ = str(p.axis, 'x') === 'z';
    const red = matOr(pen, p.material, 'red lacquer');
    const dark = matOr(pen, p.top, 'dark wood');
    const black = matOr(pen, p.base, 'iron');
    // (u: along the beams, w: front to back)
    const box = (u0: number, y0: number, w0: number, u1: number, y1: number, w1: number, v: number) => (alongZ ? pen.box(w0, y0, u0, w1, y1, u1, v) : pen.box(u0, y0, w0, u1, y1, w1, v));
    const t = Math.max(1, Math.round(W / 9));
    const half = Math.max(t + 1, Math.round(W / 2) - t);
    const w0 = -Math.floor((t - 1) / 2);
    const w1 = w0 + t - 1;
    const baseH = Math.max(1, Math.round(H / 14));
    const nukiY = Math.round(H * 0.64);
    const beamH = Math.max(1, Math.round(H / 10));
    // the red beams are a voxel thinner than the dark top one
    const thin = Math.max(1, beamH - 1);
    const topY = H - 1;
    for (const side of [-1, 1]) {
      const u0 = side < 0 ? -half - t + 1 : half;
      const u1 = u0 + t - 1;
      box(u0 - 1, 0, w0 - 1, u1 + 1, baseH - 1, w1 + 1, black);
      box(u0, baseH, w0, u1, topY - thin - 1, w1, red);
    }
    // the lower beam (nuki), poking out past the pillars
    const over = Math.max(1, Math.round(W * 0.08));
    box(-half - t - over + 1, nukiY, w0, half + t + over - 1, nukiY + thin - 1, w1, red);
    // the plaque between the beams
    const plaqueTop = topY - thin - 1;
    if (plaqueTop - nukiY - thin >= 1) box(-Math.max(0, t - 1), nukiY + thin, w0, Math.max(0, t - 1), plaqueTop, w1, dark);
    // the red beam under the top, then the dark top beam, wider, with its ends turned up
    const span = half + t + Math.max(2, Math.round(W * 0.16));
    box(-span + 1, topY - thin, w0, span - 1, topY - 1, w1, red);
    box(-span, topY, w0 - 1, span, topY + beamH - 1, w1 + 1, dark);
    // the ends curve up a voxel
    const tip = Math.max(2, Math.round(W * 0.12));
    for (const side of [-1, 1]) {
      const a = side * span;
      const b = side * (span - tip + 1);
      box(Math.min(a, b), topY + beamH, w0 - 1, Math.max(a, b), topY + beamH, w1 + 1, dark);
    }
  },
};
