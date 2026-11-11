// The voxel world (shared/api/world.ts). Changes are yours ({ kind: 'user' }); server/voxel/ checks their fields and
// refuses in plain words, which are 400s here.
import path from 'node:path';
import { implement } from '@orpc/server';
import { world as worldContract, worlds as worldsContract } from '../../shared/api/world.ts';
import { activeProject, listProjects, log } from '../store.ts';
import { ensureBrain } from '../projects.ts';
import { addArtifact } from '../artifacts.ts';
import { getVersion, listVersions, withActor } from '../versions.ts';
import * as worldLink from '../voxel/link.ts';
import * as worldBuild from '../voxel/build.ts';
import * as worldStore from '../voxel/store.ts';
import * as worldMd from '../voxel/worldmd.ts';
import * as worldScene from '../voxel/scene.ts';
import * as worldLook from '../voxel/look.ts';
import * as worldExchange from '../voxel/exchange.ts';
import * as worldPrefabs from '../voxel/prefabs.ts';
import * as worldCharacters from '../voxel/characters.ts';
import { refuse, refusing } from './refuse.ts';
import type { WorldBuilder } from '../../shared/types.ts';

const w = implement(worldContract);
const ws = implement(worldsContract);

const you: WorldBuilder = { kind: 'user', name: 'You' };
const projectName = (id?: string) => (id ? listProjects().find((p) => p.id === id)?.name : undefined);
const shown = () => worldLink.shownWorld().world || refuse('No world yet.', 404);
const mdVersion = (vid: string) =>
  getVersion<{ text: string }>(worldMd.worldMdVersionsDir(shown().id), vid) || refuse('No such version.', 404);
// files out of the world go to Artifacts and the project folder's exports/
const exportsDir = () => path.join(ensureBrain(), 'exports');

export const worldRouter = w.router({
  shown: w.shown.handler(() => {
    const s = worldLink.shownWorld();
    return { ...s, fromProjectName: projectName(s.fromProject) };
  }),
  object: w.object.handler(
    ({ input }) => worldStore.readObject(input.wid, input.oid) || refuse('No such object.', 404),
  ),
  prefab: w.prefab.handler(
    ({ input }) => worldStore.readPrefab(input.wid, input.pid) || refuse('No such prefab.', 404),
  ),
  changeObject: w.changeObject.handler(({ input: { oid, ...change } }) =>
    refusing(
      () => worldBuild.changeObject({ ...change, delete: false, duplicate: false, object: oid, by: you }).object,
    ),
  ),
  removeObject: w.removeObject.handler(
    ({ input }) => (
      refusing(() => worldBuild.changeObject({ object: input.oid, delete: true, by: you })),
      { ok: true as const }
    ),
  ),
  undo: w.undo.handler(({ input }) => refusing(() => worldBuild.undo(you, { anyone: input.anyone !== false }))),
  changes: w.changes.handler(() => worldBuild.recentChanges(shown().id, 50)),
  md: {
    get: w.md.get.handler(() => worldMd.worldMdInfo(shown().id)),
    save: w.md.save.handler(({ input }) => {
      // (a carried-over world becomes this project's own first: you are changing it)
      const m = refusing(() => worldMd.writeWorldMd(worldLink.worldForBuild().id, input.text));
      log('world', 'You edited WORLD.md');
      return m;
    }),
    versions: w.md.versions.handler(() =>
      listVersions<{ text: string }>(worldMd.worldMdVersionsDir(shown().id)).map((v) => ({
        id: v.id,
        at: v.at,
        by: v.by,
        note: v.note,
        chars: v.item.text.length,
      })),
    ),
    version: w.md.version.handler(({ input }) => mdVersion(input.vid)),
    restore: w.md.restore.handler(({ input }) => {
      const v = mdVersion(input.vid);
      const m = withActor('you', () => worldMd.writeWorldMd(worldLink.worldForBuild().id, v.item.text), {
        note: `restored the version from ${new Date(v.at).toLocaleString()}`,
        force: true,
      });
      log('world', 'You restored an earlier WORLD.md');
      return m;
    }),
  },
  environment: w.environment.handler(({ input }) =>
    refusing(() => worldScene.setEnvironment({ by: you, fields: input }).world),
  ),
  setLight: w.setLight.handler(({ input: { lid, ...fields } }) =>
    refusing(() => worldScene.setLight({ by: you, action: 'change', light: lid, fields }).light),
  ),
  removeLight: w.removeLight.handler(
    ({ input }) => (
      refusing(() => worldScene.setLight({ by: you, action: 'remove', light: input.lid })),
      { ok: true as const }
    ),
  ),
  setEffect: w.setEffect.handler(({ input: { eid, ...fields } }) =>
    refusing(() => worldScene.setEffect({ by: you, action: 'change', effect: eid, fields }).effect),
  ),
  removeEffect: w.removeEffect.handler(
    ({ input }) => (
      refusing(() => worldScene.setEffect({ by: you, action: 'remove', effect: input.eid })),
      { ok: true as const }
    ),
  ),
  skins: w.skins.handler(({ input }) =>
    refusing(
      () => worldCharacters.setSkin({ by: you, to: input.to, id: input.id, fields: input.fields || {} }).world.skins,
    ),
  ),
  snapshot: w.snapshot.handler(({ input: { request, ...look } }) => ({ ok: worldLook.deliverLook(request, look) })),
  export: w.export.handler(({ input }) => {
    const out = refusing(() => worldExchange.exportFiles(shown(), input.what, input.id, input.format || 'glb'));
    const paths = worldExchange.writeFiles(exportsDir(), out.files);
    const made = paths.map((p) =>
      addArtifact({
        title: out.files.length > 1 ? `${out.title}: ${path.basename(p)}` : out.title,
        path: p,
        note: out.note || 'Made from the voxel world',
        by: 'You',
      }),
    );
    return { paths, artifacts: made.map((a) => a.id), note: out.note };
  }),
  picture: w.picture.handler(({ input }) => {
    const shownWorld = worldLink.shownWorld().world;
    const file = refusing(() =>
      worldExchange.writePicture(exportsDir(), input.name || shownWorld?.name || 'world', input.image),
    );
    const a = addArtifact({
      title: `${shownWorld?.name || 'The world'}: a picture`,
      path: file,
      note: 'A picture of the voxel world',
      by: 'You',
    });
    return { path: file, artifact: a.id };
  }),
  prefabs: {
    list: w.prefabs.list.handler(() => {
      const world = worldLink.shownWorld().world;
      if (!world) return [];
      const uses = worldPrefabs.prefabUses(world);
      return world.prefabs.map((p) => ({ ...p, uses: uses.get(p.id) || null }));
    }),
    change: w.prefabs.change.handler(({ input: { pid, ...change } }) =>
      refusing(() => worldPrefabs.changePrefab({ by: you, prefab: pid, ...change }).prefab),
    ),
    remove: w.prefabs.remove.handler(({ input }) => ({
      text: refusing(() => worldPrefabs.deletePrefab({ by: you, prefab: input.pid })),
    })),
    publish: w.prefabs.publish.handler(({ input }) => ({
      text: refusing(() => worldPrefabs.publishPrefab({ by: you, prefab: input.pid })),
    })),
    import: w.prefabs.import.handler(({ input }) =>
      refusing(() => worldPrefabs.importPrefab({ by: you, name: input.name, as: input.as }).prefab),
    ),
    library: w.prefabs.library.handler(({ input }) => worldPrefabs.libraryItems(input.q || '')),
  },
});

export const worldsRouter = ws.router({
  list: ws.list.handler(() => worldLink.listWorldsFor()),
  choose: ws.choose.handler(({ input }) =>
    refusing(() => worldLink.chooseWorld(activeProject().id, input.mode, input.worldId ?? null)),
  ),
  setDefault: ws.setDefault.handler(
    ({ input }) => (worldLink.setDefaultWorld(input.worldId || null), { ok: true as const }),
  ),
  rename: ws.rename.handler(({ input }) => refusing(() => worldLink.renameWorld(input.wid, input.name))),
  remove: ws.remove.handler(
    ({ input }) => (refusing(() => worldLink.deleteUnusedWorld(input.wid)), { ok: true as const }),
  ),
});
