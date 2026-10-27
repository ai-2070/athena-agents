// A stone lantern (tōrō): a wide foot, a post, a glowing light box under a stepped roof, a knob on top.
import type { GeneratorDef } from '../ops.ts';
import { num, matOr } from './params.ts';

export const lantern: GeneratorDef = {
  help: 'lantern: a stone lantern with a glowing light box. height (default 2), material (default dark stone), light (default lantern)',
  draw(pen, p) {
    const h = Math.max(5, pen.vox(num(p.height, 2, 0.5, 12)));
    const body = matOr(pen, p.material, 'dark stone');
    const light = matOr(pen, p.light, 'lantern');
    const w = Math.max(1, Math.round(h / 8));
    const foot = Math.max(1, Math.round(h * 0.08));
    const post = Math.round(h * 0.36);
    // tall enough, and the roof narrow enough, that the light shows from the Station's view (looking down)
    const boxH = Math.max(3, Math.round(h * 0.32));
    // foot, post, a shelf
    pen.box(-w - 1, 0, -w - 1, w + 1, foot - 1, w + 1, body);
    pen.box(-Math.max(0, w - 1), foot, -Math.max(0, w - 1), Math.max(0, w - 1), post, Math.max(0, w - 1), body);
    pen.box(-w, post + 1, -w, w, post + 1, w, body);
    // the light box, its corners stone so it reads as a frame
    const lb = post + 2;
    const lt = lb + boxH - 1;
    pen.box(-w, lb, -w, w, lt, w, light);
    for (const x of [-w, w]) for (const z of [-w, w]) if (w > 1) pen.box(x, lb, z, x, lt, z, body);
    // a stepped roof, wider than the box, and a knob
    let y = lt + 1;
    for (let r = w + 1; r >= 0 && y < h; r -= 1 + Math.floor(w / 2), y++) pen.box(-r, y, -r, r, y, r, body);
    pen.put(0, y, 0, body);
  },
};
