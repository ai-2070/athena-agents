import { DATA, dataPath, isInside, realTarget } from './util.ts';

/** Private metadata follows the data root, never a link out of it. */
export function privateDataPath(...parts: string[]): string {
  const file = dataPath(...parts);
  const root = realTarget(DATA);
  const target = realTarget(file);
  if (!root || !target || !isInside(root, target)) throw new Error('Private metadata must stay under the data folder.');
  return file;
}
