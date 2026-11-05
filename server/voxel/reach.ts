// Whose work a change reaches besides the builder's own. The palette is the whole world's, and a prefab's
// copies stand in other builders' objects, so changing either can change what someone else built.
// tools.ts asks the user first, the same way it does for changing someone else's object.
import { fromBase64 } from '../../shared/voxel.ts';
import { cleanMaterial } from './ops.ts';
import { nesting, ownsObject } from './build.ts';
import { readObject, readPrefab } from './store.ts';
import type { VoxelMaterial, VoxelObjectData, VoxelWorld, WorldBuilder } from '../../shared/types.ts';

/** Someone else's object or prefab a change would reach. */
export interface OthersWork {
  by: WorldBuilder;
  /** `"Pond"` or `the prefab "Palm tree"` */
  where: string;
}

// (key order doesn't count: a material written back the same is no change)
const sameMaterial = (a: VoxelMaterial, b: VoxelMaterial) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

/** Existing palette materials these build steps would define differently (steps inside steps count too). */
export function redefinedInSteps(palette: VoxelMaterial[], steps: unknown): string[] {
  const out = new Set<string>();
  const walk = (v: unknown, depth: number) => {
    if (depth > 6 || !v || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    const step = v as Record<string, unknown>;
    if (typeof step.material === 'string') {
      const name = step.material.trim().toLowerCase();
      const was = palette.find((m) => m.name === name);
      if (was)
        try {
          if (!sameMaterial(cleanMaterial(step, was), was)) out.add(name);
        } catch {
          /* a bad material fails in the build */
        }
    }
    for (const x of Object.values(step)) walk(x, depth + 1);
  };
  walk(steps, 0);
  return [...out];
}

/** Existing palette materials a script names when it defines one: material("stone", …) or {material: "stone"}. */
export function redefinedInScript(palette: VoxelMaterial[], code: unknown): string[] {
  const text = String(code ?? '');
  const out = new Set<string>();
  // (material("stone") with nothing after the name changes nothing)
  for (const re of [/\bmaterial\s*\(\s*(['"`])((?:(?!\1)[^\\])*)\1\s*(\)?)/g, /['"]?\bmaterial['"]?\s*:\s*(['"`])((?:(?!\1)[^\\])*)\1()/g])
    for (const m of text.matchAll(re)) {
      if (m[3]) continue;
      const name = m[2].trim().toLowerCase();
      if (!name.includes('${') && palette.some((x) => x.name === name)) out.add(name);
    }
  return [...out];
}

// The materials (by name) of `byValue` this object's or prefab's voxels hold, or a copy in it swaps in.
function usedIn(data: VoxelObjectData | null, byValue: Map<number, string>): Set<string> {
  const hit = new Set<string>();
  if (!data) return hit;
  const names = new Set(byValue.values());
  for (const v of data.volumes || [])
    for (const text of Object.values(v.chunks || {})) {
      let bytes: Uint8Array;
      try {
        bytes = fromBase64(text);
      } catch {
        continue;
      }
      // (pairs of run length and value)
      for (let i = 1; i < bytes.length; i += 2) {
        const name = byValue.get(bytes[i]);
        if (name) hit.add(name);
      }
    }
  for (const i of data.instances || []) for (const to of Object.values(i.swap || {})) if (names.has(String(to))) hit.add(String(to));
  return hit;
}

/** Per material: the objects and prefabs other builders made that use it (its voxels, or a copy that swaps it in). */
export function materialUsers(w: VoxelWorld, by: WorldBuilder, materials: string[]): Map<string, OthersWork[]> {
  const out = new Map<string, OthersWork[]>();
  if (by.kind !== 'agent' || !materials.length) return out;
  // a voxel holds its material's place in the palette plus one
  const byValue = new Map<number, string>();
  for (const name of new Set(materials)) {
    const at = w.palette.findIndex((m) => m.name === name);
    if (at >= 0) byValue.set(at + 1, name);
  }
  if (!byValue.size) return out;
  const note = (hit: Set<string>, work: OthersWork) => {
    for (const name of hit) out.set(name, [...(out.get(name) || []), work]);
  };
  for (const o of w.objects) if (!ownsObject(by, o)) note(usedIn(readObject(w.id, o.id), byValue), { by: o.by, where: `"${o.name}"` });
  for (const p of w.prefabs) if (!ownsObject(by, p)) note(usedIn(readPrefab(w.id, p.id), byValue), { by: p.by, where: `the prefab "${p.name}"` });
  return out;
}

/** Other builders' objects and prefabs with copies of this prefab (or of a prefab that holds it). */
export function copiesByOthers(w: VoxelWorld, by: WorldBuilder, prefabId: string): OthersWork[] {
  if (by.kind !== 'agent') return [];
  const memo = new Map<string, { holds: boolean; depth: number }>();
  const holders = new Set([prefabId, ...w.prefabs.filter((p) => p.id !== prefabId && p.instances && nesting(w, p.id, prefabId, memo).holds).map((p) => p.id)]);
  const has = (data: VoxelObjectData | null) => (data?.instances || []).some((i) => holders.has(i.prefab));
  const out: OthersWork[] = [];
  for (const o of w.objects) if (o.instances && !ownsObject(by, o) && has(readObject(w.id, o.id))) out.push({ by: o.by, where: `"${o.name}"` });
  for (const p of w.prefabs) if (p.id !== prefabId && p.instances && !ownsObject(by, p) && has(readPrefab(w.id, p.id))) out.push({ by: p.by, where: `the prefab "${p.name}"` });
  return out;
}

/** `"Pond" (Mira), the prefab "Palm tree" (Kenji)`, at most a few. */
export function othersText(list: OthersWork[], most = 4): string {
  const shown = list.slice(0, most).map((x) => `${x.where} (${x.by.name})`);
  return `${shown.join(', ')}${list.length > most ? ` and ${list.length - most} more` : ''}`;
}
