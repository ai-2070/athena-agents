// An Eve update must raise EVE_GENERATION: it retires the sessions an older Eve made, which a newer Eve may not take
// messages on (a team member then stayed "working" with nothing sent).
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EVE_GENERATION } from '../../server/eve/version.ts';

const eveVersion = (file: string): string => {
  const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '../..', file), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  return pkg.dependencies?.eve || '';
};

describe('the Eve generation', () => {
  it('names the Eve version the app and its runtime use', () => {
    expect(eveVersion('runtime/eve/package.json')).toBe(eveVersion('package.json'));
    expect(EVE_GENERATION).toMatch(
      new RegExp(`^eve-${eveVersion('package.json').replace(/[.^~]/g, '\\$&')}-athena-\\d+$`),
    );
  });
});
