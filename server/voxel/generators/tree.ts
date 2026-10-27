// Trees: a trunk that tapers and leans, branches, and crowns made of several rough, holey blobs.
import { hash3 } from '../../../shared/voxel.ts';
import type { GeneratorDef, Pen } from '../ops.ts';
import { num, str, matOr } from './params.ts';

type P3 = [number, number, number];
const KINDS = ['cherry', 'maple', 'oak', 'pine', 'bamboo', 'bonsai', 'dead'] as const;
type Kind = (typeof KINDS)[number];
const LEAVES: Record<Kind, string> = { cherry: 'blossom', maple: 'autumn leaves', oak: 'leaves', pine: 'pine needles', bamboo: 'leaves', bonsai: 'leaves', dead: 'leaves' };

/** A round slice of trunk at height y: radius r (0.5 is one voxel, 1.5 is three across). */
function disc(pen: Pen, x: number, y: number, z: number, r: number, v: number): void {
  const R = Math.ceil(r);
  for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) if (dx * dx + dz * dz <= r * r + 0.5) pen.put(Math.round(x) + dx, Math.round(y), Math.round(z) + dz, v);
}

/** A limb from a to b, its radius going from r0 to r1. */
function limb(pen: Pen, a: P3, b: P3, r0: number, r1: number, v: number): void {
  const n = Math.max(1, Math.ceil(Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]), Math.abs(b[2] - a[2]))));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const p: P3 = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    const r = r0 + (r1 - r0) * t;
    if (r < 0.75) pen.put(Math.round(p[0]), Math.round(p[1]), Math.round(p[2]), v);
    else disc(pen, p[0], p[1], p[2], r, v);
  }
}

/** A trunk that leans a little and bends: returns its top. */
function trunk(pen: Pen, height: number, r0: number, r1: number, lean: number, v: number): P3 {
  const ang = pen.rand() * Math.PI * 2;
  const bend = (pen.rand() - 0.5) * 2;
  let prev: P3 = [0, 0, 0];
  const segs = Math.max(2, Math.round(height / 4));
  for (let i = 1; i <= segs; i++) {
    const t = i / segs;
    // leans more towards the top, with an S-bend
    const off = lean * height * t * t;
    const wob = Math.sin(t * Math.PI) * bend * height * 0.06;
    const next: P3 = [Math.cos(ang) * off + Math.cos(ang + Math.PI / 2) * wob, height * t, Math.sin(ang) * off + Math.sin(ang + Math.PI / 2) * wob];
    limb(pen, prev, next, r0 + (r1 - r0) * ((i - 1) / segs), r0 + (r1 - r0) * t, v);
    prev = next;
  }
  // a flared foot
  if (r0 >= 1) disc(pen, 0, 0, 0, r0 + 0.8, v);
  return prev;
}

/** A crown of leaves: rough blobs with holes, kept off the wood. */
function crown(pen: Pen, c: P3, rx: number, ry: number, v: number, holes: number): void {
  pen.blob(c[0], c[1], c[2], rx, ry, rx * (0.85 + pen.rand() * 0.3), v, { keep: true, holes, rough: 0.35 });
}

/** Petals or leaves dropped on the ground nearby: only on top of what is there, where nothing stands. */
function fallen(pen: Pen, radius: number, count: number, v: number): void {
  for (let i = 0; i < count; i++) {
    const a = pen.rand() * Math.PI * 2;
    const d = Math.sqrt(pen.rand()) * radius;
    const x = Math.round(Math.cos(a) * d);
    const z = Math.round(Math.sin(a) * d);
    if (pen.get(x, -1, z) && !pen.get(x, 0, z)) pen.put(x, -1, z, v);
  }
}

function broadleaf(pen: Pen, kind: Kind, H: number, spread: number, wood: number, leaves: number, drop: boolean): void {
  const thick = kind === 'oak' ? H / 9 : H / 12;
  const r0 = Math.max(0.5, thick);
  const r1 = Math.max(0.5, thick * 0.6);
  const trunkH = Math.round(H * (kind === 'oak' ? 0.45 : 0.5));
  const top = trunk(pen, trunkH, r0, r1, kind === 'cherry' ? 0.25 : 0.12, wood);
  const crownR = H * (kind === 'cherry' ? 0.3 : kind === 'oak' ? 0.32 : 0.27) * spread;
  const branches = kind === 'oak' ? 5 : 4;
  const tips: P3[] = [];
  const start = pen.rand() * Math.PI * 2;
  for (let i = 0; i < branches; i++) {
    const a = start + (i / branches) * Math.PI * 2 + (pen.rand() - 0.5) * 0.8;
    const len = crownR * (0.7 + pen.rand() * 0.5);
    const up = H * (kind === 'cherry' ? 0.2 : 0.28) * (0.6 + pen.rand() * 0.6);
    const from: P3 = [top[0], top[1] - pen.rand() * H * 0.12, top[2]];
    const mid: P3 = [from[0] + Math.cos(a) * len * 0.5, from[1] + up * 0.6, from[2] + Math.sin(a) * len * 0.5];
    const tip: P3 = [from[0] + Math.cos(a) * len, from[1] + up, from[2] + Math.sin(a) * len];
    limb(pen, from, mid, Math.max(0.5, r1 * 0.8), Math.max(0.5, r1 * 0.55), wood);
    limb(pen, mid, tip, Math.max(0.5, r1 * 0.55), 0.5, wood);
    tips.push(tip);
  }
  tips.push([top[0], top[1] + H * 0.25, top[2]]);
  const holes = kind === 'cherry' ? 0.16 : kind === 'maple' ? 0.12 : 0.1;
  const flat = kind === 'cherry' ? 0.62 : 0.78;
  for (const t of tips) {
    const r = crownR * (0.55 + pen.rand() * 0.3);
    crown(pen, t, r, r * flat, leaves, holes);
    // a smaller puff beside each one, so the outline isn't a ball
    const b = pen.rand() * Math.PI * 2;
    crown(pen, [t[0] + Math.cos(b) * r * 0.7, t[1] - r * 0.25, t[2] + Math.sin(b) * r * 0.7], r * 0.55, r * 0.45, leaves, holes);
  }
  if (kind === 'cherry') {
    // blossom hanging below the crowns
    for (const t of tips)
      for (let i = 0; i < 6; i++) {
        const x = Math.round(t[0] + (pen.rand() - 0.5) * crownR * 1.4);
        const z = Math.round(t[2] + (pen.rand() - 0.5) * crownR * 1.4);
        const y0 = Math.round(t[1] - crownR * 0.35);
        const len = 1 + Math.floor(pen.rand() * 3);
        for (let k = 0; k < len; k++) pen.put(x, y0 - k, z, leaves, { keep: true });
      }
  }
  if (drop) fallen(pen, crownR * 1.6, Math.round(H * 8 * spread), leaves);
}

function pine(pen: Pen, H: number, spread: number, wood: number, leaves: number): void {
  const r0 = Math.max(0.5, H / 16);
  trunk(pen, Math.round(H * 0.9), r0, 0.5, 0.03, wood);
  const baseR = Math.max(1.5, H * 0.26 * spread);
  const seed = Math.floor(pen.rand() * 1e9);
  // tiers from low on the trunk to the tip, each a cone with a ragged, drooping edge, overlapping the one below
  let y0 = Math.round(H * 0.18);
  for (let i = 0; y0 < H - 1 && i < 40; i++) {
    const t = (y0 - H * 0.18) / (H * 0.82);
    const r = Math.max(1, baseR * (1 - t * 0.85));
    const h = Math.max(2, Math.round(r * 0.95));
    for (let y = 0; y < h; y++) {
      const rr = r * (1 - y / h);
      const R = Math.ceil(rr) + 1;
      for (let z = -R; z <= R; z++)
        for (let x = -R; x <= R; x++) {
          const d = Math.hypot(x, z);
          if (d > rr + (hash3(x, y0 + y, z, seed) - 0.5) * 1.4) continue;
          // the outer ring droops a voxel
          const droop = y === 0 && d > rr - 1.2 && hash3(x, y0, z, seed + 1) < 0.5 ? -1 : 0;
          pen.put(x, y0 + y + droop, z, leaves, { keep: true });
        }
    }
    y0 += Math.max(2, Math.round(h * 0.6));
  }
  pen.box(0, y0, 0, 0, y0 + Math.max(1, Math.round(H / 12)), 0, leaves, { keep: true });
}

function bamboo(pen: Pen, H: number, spread: number, wood: number, leaves: number, node: number): void {
  const stalks = 5 + Math.floor(pen.rand() * 4);
  const R = Math.max(1, H * 0.12 * spread);
  const gap = Math.max(3, Math.round(H / 7));
  for (let i = 0; i < stalks; i++) {
    const a = pen.rand() * Math.PI * 2;
    const d = Math.sqrt(pen.rand()) * R;
    const x = Math.round(Math.cos(a) * d);
    const z = Math.round(Math.sin(a) * d);
    const h = Math.round(H * (0.65 + pen.rand() * 0.45));
    // a slight lean outwards
    const lx = Math.cos(a) * 0.06;
    const lz = Math.sin(a) * 0.06;
    const phase = Math.floor(pen.rand() * gap);
    for (let y = 0; y < h; y++) pen.put(x + Math.round(lx * y), y, z + Math.round(lz * y), (y + phase) % gap === 0 ? node : wood);
    // leaf sprays near the top, angled down and out
    for (let k = 0; k < 5; k++) {
      const y = h - 1 - Math.floor(pen.rand() * Math.max(1, h * 0.45));
      const b = pen.rand() * Math.PI * 2;
      const len = Math.max(2, Math.round(H * 0.16));
      const sx = x + Math.round(lx * y);
      const sz = z + Math.round(lz * y);
      // a thin twig, then a fan of leaves along it, drooping at the end
      for (let s = 1; s <= len; s++) {
        const px = sx + Math.round(Math.cos(b) * s);
        const pz = sz + Math.round(Math.sin(b) * s);
        const py = y - Math.floor((s * s) / (len * 2));
        pen.put(px, py, pz, leaves, { keep: true });
        if (s > 1) pen.put(px + Math.round(-Math.sin(b)), py, pz + Math.round(Math.cos(b)), leaves, { keep: true });
      }
    }
  }
}

function bonsai(pen: Pen, H: number, spread: number, wood: number, leaves: number): void {
  // a short trunk that twists one way then the other, then flat pads of leaves
  const h = Math.max(3, Math.round(H * 0.55));
  const r0 = Math.max(0.5, H / 8);
  let prev: [number, number, number] = [0, 0, 0];
  const pads: [number, number, number][] = [];
  const dir = pen.rand() * Math.PI * 2;
  for (let i = 1; i <= 4; i++) {
    const t = i / 4;
    const swing = (i % 2 ? 1 : -1) * H * 0.18;
    const next: [number, number, number] = [Math.cos(dir) * swing, h * t, Math.sin(dir) * swing];
    limb(pen, prev, next, r0 * (1 - (i - 1) * 0.2), r0 * (1 - i * 0.2), wood);
    if (i >= 2) pads.push(next);
    prev = next;
  }
  for (const p of pads) {
    const r = Math.max(1.5, H * 0.3 * spread * (0.8 + pen.rand() * 0.4));
    const out: [number, number, number] = [p[0] * 1.5, p[1] + 1, p[2] * 1.5];
    limb(pen, p, out, 0.5, 0.5, wood);
    pen.blob(out[0], out[1], out[2], r, Math.max(1, r * 0.3), r, leaves, { keep: true, holes: 0.08, rough: 0.3 });
  }
}

function dead(pen: Pen, H: number, wood: number): void {
  const r0 = Math.max(0.5, H / 12);
  const top = trunk(pen, Math.round(H * 0.6), r0, Math.max(0.5, r0 * 0.5), 0.15, wood);
  // bare forks, two levels deep
  const grow = (from: [number, number, number], len: number, ang: number, depth: number) => {
    const up = len * (0.5 + pen.rand() * 0.4);
    const to: [number, number, number] = [from[0] + Math.cos(ang) * len, from[1] + up, from[2] + Math.sin(ang) * len];
    limb(pen, from, to, depth ? 0.5 : Math.max(0.5, r0 * 0.4), 0.5, wood);
    if (depth < 2) for (let k = 0; k < 2; k++) grow(to, len * 0.6, ang + (pen.rand() - 0.5) * 1.6, depth + 1);
  };
  const n = 3;
  for (let i = 0; i < n; i++) grow([top[0], top[1] - pen.rand() * H * 0.15, top[2]], H * 0.22, (i / n) * Math.PI * 2 + pen.rand(), 0);
}

export const tree: GeneratorDef = {
  help: 'tree: kind cherry|maple|oak|pine|bamboo|bonsai|dead (default cherry), height (default 5), spread (crown width ×, default 1), leaves, trunk (materials), fallen (petals or leaves on the ground around it, default true for cherry and maple)',
  draw(pen, p) {
    const kind: Kind = (KINDS as readonly string[]).includes(str(p.kind, 'cherry').toLowerCase()) ? (str(p.kind, 'cherry').toLowerCase() as Kind) : 'cherry';
    const H = pen.vox(num(p.height, kind === 'bonsai' ? 2.5 : kind === 'pine' ? 6 : 5, 0.5, 40));
    const spread = num(p.spread, 1, 0.4, 2.5);
    const wood = matOr(pen, p.trunk, kind === 'bamboo' ? 'bamboo' : kind === 'pine' || kind === 'dead' ? 'dark wood' : 'bark');
    const leaves = kind === 'dead' ? wood : matOr(pen, p.leaves, LEAVES[kind]);
    const drop = typeof p.fallen === 'boolean' ? p.fallen : kind === 'cherry' || kind === 'maple';
    if (kind === 'pine') pine(pen, H, spread, wood, leaves);
    else if (kind === 'bamboo') bamboo(pen, H, spread, wood, leaves, matOr(pen, p.node, 'moss'));
    else if (kind === 'bonsai') bonsai(pen, H, spread, wood, leaves);
    else if (kind === 'dead') dead(pen, H, wood);
    else broadleaf(pen, kind, H, spread, wood, leaves, drop);
  },
};
