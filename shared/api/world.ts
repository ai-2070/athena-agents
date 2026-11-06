// The voxel world (server/api/world.ts, docs/internal/plans/VOXEL_WORLD_PLAN.md): the world the open project shows,
// its objects and prefabs, WORLD.md and its versions, the light, lights and effects, how the Brain, teams and
// agents look, exporting, the shared prefab library, and which world a project shows. A change's fields are checked
// by server/voxel/ (the same functions agents' world tools call), so here they are only named.
import { oc, type } from '@orpc/contract';
import { z } from 'zod';
import type { LibraryPrefabListing, ShownWorld, VoxelObjectData, VoxelObjectMeta, VoxelPrefabMeta, VoxelWorld, WorldEffect, WorldLight, WorldListing, WorldMdInfo, WorldMdVersion, WorldMdVersionEntry, WorldSkins } from '../types.ts';

const ok = type<{ ok: true }>();
/** a field server/voxel/ checks (and says what is wrong with) */
const maybe = z.unknown().optional();
/** the fields of a light, an effect, the light of the world or a look: each one is checked where it is used */
const fields = z.record(z.string(), z.unknown(), { error: 'Send the fields to change.' });

export const world = {
  /** The world the open project shows, and the project it came from (fromProjectName). */
  shown: oc.route({ method: 'GET', path: '/world' }).output(type<ShownWorld & { fromProjectName?: string }>()),
  /** An object's or a prefab's voxels. */
  object: oc.route({ method: 'GET', path: '/worlds/{wid}/objects/{oid}' }).input(z.object({ wid: z.string(), oid: z.string() })).output(type<VoxelObjectData>()),
  prefab: oc.route({ method: 'GET', path: '/worlds/{wid}/prefabs/{pid}' }).input(z.object({ wid: z.string(), pid: z.string() })).output(type<VoxelObjectData>()),
  /** Moves, turns, scales, renames, hides or anchors an object. */
  changeObject: oc.route({ method: 'PUT', path: '/world/objects/{oid}' })
    .input(z.object({ oid: z.string(), name: maybe, position: maybe, move: maybe, rotation: maybe, scale: maybe, anchor: maybe, hidden: maybe }))
    .output(type<VoxelObjectMeta | null>()),
  removeObject: oc.route({ method: 'DELETE', path: '/world/objects/{oid}' }).input(z.object({ oid: z.string() })).output(ok),
  /** Takes back the last change (anyone's, unless anyone: false). */
  undo: oc.route({ method: 'POST', path: '/world/undo' })
    .input(z.object({ anyone: z.boolean({ error: 'anyone must be true or false.' }).optional() }))
    .output(type<{ world: VoxelWorld; text: string }>()),
  /** What has changed lately, newest first. */
  changes: oc.route({ method: 'GET', path: '/world/changes' }).output(type<{ at: number; by: string; what: string }[]>()),
  md: {
    get: oc.route({ method: 'GET', path: '/world/md' }).output(type<WorldMdInfo>()),
    save: oc.route({ method: 'PUT', path: '/world/md' })
      .input(z.object({ text: z.string({ error: 'Send the whole WORLD.md as text.' }) }))
      .output(type<WorldMdInfo>()),
    versions: oc.route({ method: 'GET', path: '/world/md/versions' }).output(type<WorldMdVersionEntry[]>()),
    version: oc.route({ method: 'GET', path: '/world/md/versions/{vid}' }).input(z.object({ vid: z.string() })).output(type<WorldMdVersion>()),
    restore: oc.route({ method: 'POST', path: '/world/md/versions/{vid}/restore' }).input(z.object({ vid: z.string() })).output(type<WorldMdInfo>()),
  },
  /** The sky, sun and time of day. */
  environment: oc.route({ method: 'PUT', path: '/world/environment' }).input(fields).output(type<VoxelWorld>()),
  /** A light's or an effect's change: its fields are the body. */
  setLight: oc.route({ method: 'PUT', path: '/world/lights/{lid}' }).input(z.looseObject({ lid: z.string() })).output(type<WorldLight | null>()),
  removeLight: oc.route({ method: 'DELETE', path: '/world/lights/{lid}' }).input(z.object({ lid: z.string() })).output(ok),
  setEffect: oc.route({ method: 'PUT', path: '/world/effects/{eid}' }).input(z.looseObject({ eid: z.string() })).output(type<WorldEffect | null>()),
  removeEffect: oc.route({ method: 'DELETE', path: '/world/effects/{eid}' }).input(z.object({ eid: z.string() })).output(ok),
  /** How the Brain, a team or an agent looks (e.g. putting a hidden agent back on the map). */
  skins: oc.route({ method: 'PUT', path: '/world/skins' })
    .input(z.object({ to: z.enum(['agent', 'team', 'brain'], { error: 'to is agent, team or brain.' }), id: z.string().optional(), fields: fields.optional() }))
    .output(type<WorldSkins>()),
  /** A picture an open Station made for world_look (or why it couldn't). */
  snapshot: oc.route({ method: 'POST', path: '/world/snapshot/{request}' })
    .input(z.object({ request: z.string(), image: z.string().optional(), error: z.string().optional() }))
    .output(type<{ ok: boolean }>()),
  /** An object, a prefab or the whole world as files (glb, or vox), in Artifacts and the project's exports/ folder. */
  export: oc.route({ method: 'POST', path: '/world/export' })
    .input(z.object({ what: z.enum(['object', 'prefab', 'world'], { error: 'what is object, prefab or world.' }), id: z.string().optional(), format: z.enum(['glb', 'vox']).optional() }))
    .output(type<{ paths: string[]; artifacts: string[]; note?: string }>()),
  /** A picture of the world the page took (image: a data: URL), saved like an export. */
  picture: oc.route({ method: 'POST', path: '/world/picture' })
    .input(z.object({ image: z.string({ error: 'Send the picture.' }), name: z.string().optional() }))
    .output(type<{ path: string; artifact: string }>()),
  prefabs: {
    /** This world's prefabs, with where their copies are. */
    list: oc.route({ method: 'GET', path: '/world/prefabs' }).output(type<(VoxelPrefabMeta & { uses: { in: string[]; copies: number } | null })[]>()),
    change: oc.route({ method: 'PUT', path: '/world/prefabs/{pid}' })
      .input(z.object({ pid: z.string(), name: maybe, description: maybe, tags: maybe }))
      .output(type<VoxelPrefabMeta>()),
    remove: oc.route({ method: 'DELETE', path: '/world/prefabs/{pid}' }).input(z.object({ pid: z.string() })).output(type<{ text: string }>()),
    /** Puts it in the library every project shares; import: one from there into this world (as: its name here). */
    publish: oc.route({ method: 'POST', path: '/world/prefabs/{pid}/publish' }).input(z.object({ pid: z.string() })).output(type<{ text: string }>()),
    import: oc.route({ method: 'POST', path: '/world/prefabs/import' })
      .input(z.object({ name: z.string({ error: 'Pick a prefab from the library.' }), as: maybe }))
      .output(type<VoxelPrefabMeta>()),
    /** The shared library (q: search). */
    library: oc.route({ method: 'GET', path: '/prefab-library' }).input(z.object({ q: z.string().optional() })).output(type<LibraryPrefabListing[]>()),
  },
};

export const worlds = {
  list: oc.route({ method: 'GET', path: '/worlds' }).output(type<WorldListing[]>()),
  /** Which world the open project shows: one shared with another project, a copy of one, a new one, or the default. */
  choose: oc.route({ method: 'PUT', path: '/project-world' })
    .input(z.object({ mode: z.enum(['share', 'copy', 'new', 'auto'], { error: 'mode is share, copy, new or auto.' }), worldId: z.string().nullable().optional() }))
    .output(type<ShownWorld>()),
  /** The world a project without its own shows (none: an empty one). */
  setDefault: oc.route({ method: 'PUT', path: '/worlds/default' }).input(z.object({ worldId: z.string().nullable().optional() })).output(ok),
  rename: oc.route({ method: 'PUT', path: '/worlds/{wid}' }).input(z.object({ wid: z.string(), name: z.string({ error: 'Name the world.' }) })).output(type<VoxelWorld>()),
  /** Only a world no project shows. */
  remove: oc.route({ method: 'DELETE', path: '/worlds/{wid}' }).input(z.object({ wid: z.string() })).output(ok),
};
