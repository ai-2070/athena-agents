import { describe, expect, it } from 'vitest';
import { tarFile } from '../../scripts/node-runtime.ts';

function archive(name: string, value: string, type = '0', size = value.length) {
  const tar = Buffer.alloc(2048);
  tar.write(name, 0, 100);
  tar.write(size.toString(8).padStart(11, '0') + '\0', 124, 12);
  tar.write(type, 156, 1);
  tar.write(value, 512);
  return tar;
}

describe('packaging the Node runtime', () => {
  it('extracts only the requested regular file and rejects links or truncated data', () => {
    expect(tarFile(archive('node/bin/node', 'executable'), 'node/bin/node').toString()).toBe('executable');
    expect(() => tarFile(archive('other', 'unrelated'), 'node/bin/node')).toThrow('missing');
    expect(() => tarFile(archive('node/bin/node', 'target', '2'), 'node/bin/node')).toThrow('regular file');
    expect(() => tarFile(archive('node/bin/node', 'short', '0', 4096), 'node/bin/node')).toThrow('archive size');
  });
});
