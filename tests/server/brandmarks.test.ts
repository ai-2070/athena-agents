// The bundled engine marks the page shows: a mark with a separate dark copy must not also follow the computer's
// own setting, or it would turn white on a white page when the app is set to Light.
import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';

const read = (name: string) => fs.readFileSync(path.join(__dirname, '../../public/brand/engines', name), 'utf8');

it('serves a black pi mark and a white one, neither following the computer', () => {
  for (const file of ['pi.svg', 'pi-dark.svg']) expect(read(file)).not.toContain('prefers-color-scheme');
  expect(read('pi.svg')).toContain('#111111');
  expect(read('pi.svg')).not.toContain('#f6f6f6');
  expect(read('pi-dark.svg')).toContain('#f6f6f6');
  expect(read('pi-dark.svg')).not.toContain('#111111');
});

it('serves a deep blue Venice mark and an off-white one, neither following the computer', () => {
  for (const file of ['venice.svg', 'venice-dark.svg']) expect(read(file)).not.toContain('prefers-color-scheme');
  expect(read('venice.svg')).toContain('#0E2942');
  expect(read('venice-dark.svg')).toContain('#F7F5ED');
  expect(read('venice-dark.svg')).not.toContain('#0E2942');
});
