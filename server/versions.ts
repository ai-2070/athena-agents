// Versions: before a skill, agent or team changes (or is deleted), the version it had is kept, with who
// changed it. One JSON file per version in <versions folder>/<id>/. Kept apart from the item itself, so
// a deleted item's versions stay and it can be brought back.
// (Low level, no store imports: store.ts uses it for agents and teams, skills.ts for skills.)
import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ensureDir, listFiles, readJSON, uid, writeJSON } from './util.ts';

/** Who made a change: you (the page, the API) or the Brain. */
export type Actor = 'you' | 'brain';

export interface Version<T = unknown> {
  id: string;
  /** when it was replaced (or deleted) */
  at: number;
  /** who replaced it */
  by: Actor;
  /** this is the last version of an item that was deleted */
  deleted?: boolean;
  /** what was done to it, when that isn't an ordinary edit (e.g. "restored the version from …") */
  note?: string;
  item: T;
}

// Keep this many versions per item.
export const VERSIONS_KEPT = 50;
// Edits by the same one this close together are one change: the version from before the first is kept.
export const COALESCE_MS = 3 * 60_000;

// ---------- who is changing things ----------
const actor = new AsyncLocalStorage<{ by: Actor; note?: string; force?: boolean }>();
/** Run fn as a change by `by` (e.g. the Brain's actions). force: always keep a version (a restore). */
export function withActor<T>(by: Actor, fn: () => T, { note, force = false }: { note?: string; force?: boolean } = {}): T {
  return actor.run({ by, note, force }, fn);
}
export const currentActor = (): Actor => actor.getStore()?.by || 'you';

// ---------- comparing ----------
// The same JSON whatever the key order, without the fields that don't count as a change.
export function canonical(value: unknown, ignore: readonly string[] = []): string {
  const walk = (v: unknown, top: boolean): unknown => {
    if (Array.isArray(v)) return v.map((x) => walk(x, false));
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        if (top && ignore.includes(k)) continue;
        const x = (v as Record<string, unknown>)[k];
        if (x !== undefined) out[k] = walk(x, false);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(walk(value, true));
}

/** The top-level fields that differ between a and b. */
export function changedFields(a: unknown, b: unknown, ignore: readonly string[] = []): string[] {
  const ra = (a && typeof a === 'object' ? a : {}) as Record<string, unknown>;
  const rb = (b && typeof b === 'object' ? b : {}) as Record<string, unknown>;
  return [...new Set([...Object.keys(ra), ...Object.keys(rb)])].filter((k) => !ignore.includes(k) && canonical(ra[k]) !== canonical(rb[k])).sort();
}

// ---------- reading and writing ----------
/** Every version in dir, newest first. */
export function listVersions<T>(dir: string): Version<T>[] {
  return listFiles(dir, (n) => n.endsWith('.json'))
    .map((n) => readJSON<Version<T>>(path.join(dir, n)))
    .filter((v): v is Version<T> => Boolean(v && v.id && v.item))
    .sort((a, b) => b.at - a.at || b.id.localeCompare(a.id));
}

export function getVersion<T>(dir: string, id: string): Version<T> | null {
  if (!/^[\w-]+$/.test(String(id))) return null;
  return readJSON<Version<T>>(path.join(dir, `${id}.json`));
}

/** Keep `before` (what an item was until now) in dir, unless it's the same as `after` or part of the
 *  same run of edits as the last version. Returns the version kept, or null. */
export function keepVersion<T>(dir: string, before: T, after: T | null, { ignore = [], deleted = false }: { ignore?: readonly string[]; deleted?: boolean } = {}): Version<T> | null {
  if (!before) return null;
  if (!deleted && after && canonical(before, ignore) === canonical(after, ignore)) return null;
  const ctx = actor.getStore();
  const by = ctx?.by || 'you';
  const last = listVersions<T>(dir)[0];
  if (!deleted && !ctx?.force && last && !last.deleted && last.by === by && Date.now() - last.at < COALESCE_MS) return null;
  const v: Version<T> = { id: uid('v'), at: Date.now(), by, ...(deleted ? { deleted: true } : {}), ...(ctx?.note ? { note: ctx.note } : {}), item: before };
  writeJSON(path.join(ensureDir(dir), `${v.id}.json`), v);
  const all = listVersions<T>(dir);
  for (const old of all.slice(VERSIONS_KEPT)) fs.rmSync(path.join(dir, `${old.id}.json`), { force: true });
  return v;
}

/** Items with versions whose newest version says they were deleted (and that aren't back): newest first. */
export function deletedIn<T>(root: string, stillThere: (id: string) => boolean): { id: string; version: Version<T> }[] {
  let ids: string[] = [];
  try {
    ids = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  return ids
    .filter((id) => !stillThere(id))
    .map((id) => ({ id, version: listVersions<T>(path.join(root, id))[0] }))
    .filter((x): x is { id: string; version: Version<T> } => Boolean(x.version?.deleted))
    .sort((a, b) => b.version.at - a.version.at);
}
