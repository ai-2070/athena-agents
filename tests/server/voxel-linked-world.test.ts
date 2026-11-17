// A world folder swapped for a link to a world-shaped folder outside: a build or a delete is refused before it writes
// or deletes anything there (BH-143).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { build, changeObject } from '../../server/voxel/build.ts';
import { shownWorld } from '../../server/voxel/link.ts';
import { writeWorldMd } from '../../server/voxel/worldmd.ts';
import { dataPath } from '../../server/util.ts';
import type { WorldBuilder } from '../../shared/types.ts';

const me: WorldBuilder = { kind: 'user', name: 'You' };
const files = (dir: string) =>
  fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => `${path.relative(dir, e.parentPath)}/${e.name}:${fs.statSync(path.join(e.parentPath, e.name)).size}`)
    .sort();

describe('a world folder that is a link', () => {
  it('builds, deletes and writes nothing through it', () => {
    build({ by: me, object: 'Kept', steps: [{ box: [2, 2, 2], use: 'stone' }] });
    const id = shownWorld().world!.id;
    const real = dataPath('worlds', id);
    const outside = path.join(os.homedir(), 'outside-world');
    fs.cpSync(real, outside, { recursive: true });
    fs.rmSync(real, { recursive: true, force: true });
    fs.symlinkSync(outside, real, process.platform === 'win32' ? 'junction' : 'dir');
    const before = files(outside);
    expect(() => build({ by: me, object: 'New', steps: [{ box: [1, 1, 1], use: 'stone' }] })).toThrow(/link/);
    expect(files(outside), 'after a build').toEqual(before);
    expect(() => changeObject({ by: me, object: 'Kept', delete: true })).toThrow(/link/);
    expect(files(outside), 'after a delete').toEqual(before);
    expect(() => writeWorldMd(id, '# Changed')).toThrow(/not writing through/);
    expect(files(outside), 'after WORLD.md').toEqual(before);
  });
});
