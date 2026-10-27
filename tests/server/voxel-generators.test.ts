import { describe, expect, it } from 'vitest';
import { LIMITS, runBuild } from '../../server/voxel/ops.ts';
import { GENERATORS } from '../../server/voxel/generators/index.ts';
import { encodeChunk } from '../../shared/voxel.ts';
import type { VoxelMaterial } from '../../shared/types.ts';

function build(steps: unknown[], seed = 1, voxelSize = 0.25) {
  const palette: VoxelMaterial[] = [];
  let n = 0;
  const out = runBuild({ grids: [], palette, voxelSize, steps, seed, newId: () => `g${n++}` });
  // what was built, as text (for comparing two builds)
  const shape = out.grids.map((g) => [...g.vol.chunks].map(([k, c]) => `${k}:${encodeChunk(c)}`).sort().join('|')).join('/');
  return { out, palette, shape };
}

const DEFAULTS: Record<string, unknown> = {
  tree: {},
  rock: {},
  island: {},
  cloud: {},
  bridge: {},
  torii: {},
  lantern: {},
};

describe('voxel generators', () => {
  it('every generator is registered with a one-line help', () => {
    expect(Object.keys(GENERATORS).sort()).toEqual(['bridge', 'cloud', 'island', 'lantern', 'rock', 'torii', 'tree']);
    for (const [name, g] of Object.entries(GENERATORS)) {
      expect(g.help.startsWith(`${name}:`)).toBe(true);
      expect(g.help).not.toContain('\n');
    }
  });

  for (const name of Object.keys(DEFAULTS)) {
    it(`${name}: builds at its defaults, under the cap, the same for the same seed`, () => {
      const a = build([{ [name]: DEFAULTS[name] }], 3);
      expect(a.out.added).toBeGreaterThan(20);
      expect(a.out.added).toBeLessThan(150_000);
      expect(a.out.added).toBeLessThan(LIMITS.changedPerCall);
      expect(build([{ [name]: DEFAULTS[name] }], 3).shape).toBe(a.shape);
    });

    it(`${name}: odd parameters fall back instead of failing`, () => {
      for (const p of [{ height: 'huge' }, { height: -5 }, { kind: 'nope' }, { width: null, radius: [1, 2], size: {} }, { leaves: 42 }]) {
        expect(() => build([{ [name]: p }])).not.toThrow();
      }
      // a step whose parameters aren't an object at all
      expect(() => build([{ [name]: 'big' }])).not.toThrow();
    });
  }

  it('a material name the world doesn\'t know is an error that says what to do', () => {
    for (const name of ['tree', 'rock', 'island', 'cloud', 'bridge', 'torii', 'lantern']) {
      const key = name === 'tree' ? 'leaves' : name === 'island' ? 'top' : 'material';
      expect(() => build([{ [name]: { [key]: 'no such material' } }])).toThrow(/no material "no such material". Define it first/);
    }
  });

  it('random ones differ with another seed', () => {
    for (const name of ['tree', 'rock', 'island', 'cloud']) expect(build([{ [name]: {} }], 1).shape).not.toBe(build([{ [name]: {} }], 2).shape);
  });

  it('every tree kind builds, in its own materials', () => {
    const want: Record<string, string> = { cherry: 'blossom', maple: 'autumn leaves', oak: 'leaves', pine: 'pine needles', bamboo: 'bamboo', bonsai: 'leaves', dead: 'dark wood' };
    for (const [kind, mat] of Object.entries(want)) {
      const { out, palette } = build([{ tree: { kind } }]);
      expect(out.added).toBeGreaterThan(10);
      expect(palette.map((m) => m.name)).toContain(mat);
    }
  });

  it('material overrides end up in the palette', () => {
    expect(build([{ tree: { leaves: 'snow', trunk: 'iron' } }]).palette.map((m) => m.name).sort()).toEqual(['iron', 'snow']);
    expect(build([{ torii: { material: 'gold', top: 'brick', base: 'stone' } }]).palette.map((m) => m.name).sort()).toEqual(['brick', 'gold', 'stone']);
    expect(build([{ island: { top: 'snow' } }]).palette.map((m) => m.name)).toContain('snow');
    expect(build([{ lantern: {} }]).palette.find((m) => m.name === 'lantern')?.kind).toBe('emissive');
  });

  it('a bigger size makes more voxels, a bigger voxel fewer', () => {
    expect(build([{ tree: { height: 8 } }]).out.added).toBeGreaterThan(build([{ tree: { height: 3 } }]).out.added);
    expect(build([{ island: {} }], 1, 0.5).out.added).toBeLessThan(build([{ island: {} }], 1, 0.25).out.added);
  });

  it('the island has a pond of water with sand around it, and its top at y = -1', () => {
    const { out, palette } = build([{ island: { radius: 4, pond: { x: 1, z: 0, radius: 1 } } }]);
    const names = palette.map((m) => m.name);
    expect(names).toEqual(expect.arrayContaining(['grass', 'dirt', 'stone', 'dark stone', 'water', 'sand']));
    // nothing above the top
    for (const g of out.grids) for (const k of g.vol.chunks.keys()) expect(Number(k.split(',')[1])).toBeLessThan(0);
  });

  it('fallen petals only land on ground that is there', () => {
    // on bare air: no petals below y = 0
    const bare = build([{ tree: { kind: 'cherry' } }]);
    for (const g of bare.out.grids) for (const k of g.vol.chunks.keys()) expect(Number(k.split(',')[1])).toBeGreaterThanOrEqual(0);
    // on an island: some grass under the crown turns to blossom
    const both = build([{ island: { radius: 5 } }, { tree: { kind: 'cherry' } }]);
    const noFall = build([{ island: { radius: 5 } }, { tree: { kind: 'cherry', fallen: false } }]);
    expect(both.out.painted).toBeGreaterThan(noFall.out.painted);
  });

  it('a garden in one call stays under the cap', () => {
    const { out } = build([
      { island: { radius: 10, pond: { x: 3, z: -3, radius: 2 } } },
      { tree: { kind: 'cherry', height: 6 }, at: [-20, 0, -12] },
      { tree: { kind: 'pine' }, at: [18, 0, 14] },
      { tree: { kind: 'bamboo' }, at: [-24, 0, 16] },
      { torii: {}, at: [0, 0, 28] },
      { bridge: { axis: 'z' }, at: [12, 0, -12] },
      { lantern: {}, at: [6, 0, 6] },
      { rock: { kind: 'spire' }, at: [-8, 0, 4] },
      { cloud: {}, at: [0, 40, 0] },
    ]);
    expect(out.added).toBeGreaterThan(50_000);
    expect(out.added + out.removed + out.painted).toBeLessThan(LIMITS.changedPerCall);
  });
});
