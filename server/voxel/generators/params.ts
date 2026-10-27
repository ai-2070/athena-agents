// Reading a generator's parameters: odd values fall back to the default, but a material name the world
// doesn't know is an error the builder sees (a misspelling shouldn't quietly become another material).
import type { Pen } from '../ops.ts';

/** A number within [min, max], or def when it isn't one. */
export const num = (v: unknown, def: number, min: number, max: number): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : def;
};

export const str = (v: unknown, def: string): string => (typeof v === 'string' && v.trim() ? v.trim() : def);

/** The material named in a parameter, or the default when none is named. */
export const matOr = (pen: Pen, name: unknown, def: string): number => pen.mat(str(name, def));
