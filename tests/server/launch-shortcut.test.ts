// A program found only as a Start Menu shortcut can't be handed a file or options: that is refused, saying so,
// instead of opening it without them (BH-156).
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { dataPath, ensureDir } from '../../server/util.ts';

// (the Start Menu looked in is under the test's own folder, set before programs.ts reads it)
const roaming = ensureDir(dataPath('fake-roaming'));
process.env.APPDATA = roaming;
const { launchProgram, startMenuApps } = await import('../../server/programs.ts');

describe.runIf(process.platform === 'win32')('a program that is only a shortcut', () => {
  it('refuses a file or options rather than dropping them', async () => {
    const menu = ensureDir(path.join(roaming, 'Microsoft', 'Windows', 'Start Menu', 'Programs'));
    fs.writeFileSync(path.join(menu, 'Zebra Paint Studio.lnk'), '');
    expect(startMenuApps(true).some((a) => a.name === 'Zebra Paint Studio')).toBe(true);
    await expect(launchProgram('Zebra Paint Studio', { file: 'C:\\pictures\\cat.png' })).rejects.toThrow(
      /only a shortcut/,
    );
    await expect(launchProgram('Zebra Paint Studio', { args: ['--fullscreen'] })).rejects.toThrow(/only a shortcut/);
  });
});
