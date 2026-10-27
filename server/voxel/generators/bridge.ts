// An arched footbridge: a plank deck on a curve, beams under its edges, posts and rails with gold caps.
import type { GeneratorDef } from '../ops.ts';
import { num, str, matOr } from './params.ts';

export const bridge: GeneratorDef = {
  help: 'bridge: an arched footbridge, the spot at its middle on the ground. length (default 6), width (default 1.6), rise (arch height, default 1.2), axis "x" or "z" (default x), material (posts and rails, default red lacquer), deck (default wood), railings (default true)',
  draw(pen, p) {
    const L = pen.vox(num(p.length, 6, 1, 64));
    const W = pen.vox(num(p.width, 1.6, 0.5, 16));
    const rise = pen.vox(num(p.rise, 1.2, 0, 16));
    const alongZ = str(p.axis, 'x') === 'z';
    const frame = matOr(pen, p.material, 'red lacquer');
    const deck = matOr(pen, p.deck, 'wood');
    const dark = pen.mat('dark wood');
    const cap = pen.mat('gold');
    const railings = typeof p.railings === 'boolean' ? p.railings : true;
    // (u: along the bridge, w: across it)
    const put = (u: number, y: number, w: number, v: number) => (alongZ ? pen.put(w, y, u, v) : pen.put(u, y, w, v));
    const half = Math.floor(L / 2);
    const hw = Math.floor(W / 2);
    const deckY = (u: number) => Math.round(rise * (1 - (u / Math.max(1, half)) ** 2));
    const postH = Math.max(2, pen.vox(0.9));
    const gap = Math.max(2, pen.vox(1.1));
    for (let u = -half; u <= half; u++) {
      const y = deckY(u);
      // planks across, every other one darker; a beam under each edge
      for (let w = -hw; w <= hw; w++) put(u, y, w, (u & 1) === 0 ? deck : dark);
      for (const w of [-hw, hw]) for (let k = 1; k <= Math.max(1, Math.round(rise * 0.25)); k++) if (y - k >= 0) put(u, y - k, w, frame);
      if (!railings) continue;
      for (const w of [-hw - 1, hw + 1]) {
        const end = Math.abs(u) >= half;
        if (end || (u + half) % gap === 0) {
          // a post from the deck (or the ground at the ends) up past the rail, with a cap
          for (let k = end ? 0 : y; k <= y + postH; k++) put(u, k, w, frame);
          if (end) put(u, y + postH + 1, w, cap);
        }
        put(u, y + postH, w, frame);
        if (postH >= 4) put(u, y + Math.round(postH / 2), w, frame);
      }
    }
    // piers at both ends, down to the ground
    for (const u of [-half, half]) for (let w = -hw; w <= hw; w++) for (let k = 0; k < deckY(u); k++) put(u, k, w, dark);
  },
};
