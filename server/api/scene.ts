// The scene look (shared/api/scene.ts): the address of a project's scene, its versions, load reports, going back.
import { implement } from '@orpc/server';
import { scene as sceneContract } from '../../shared/api/scene.ts';
import { listProjects, log } from '../store.ts';
import { markLoaded, pinVersion, restoreVersion, sceneOverview, sceneVersion } from '../scene/history.ts';
import { sceneToken } from '../scene/serve.ts';
import { addSceneLogs, deliverSceneLook } from '../scene/look.ts';
import { refuse, refusing } from './refuse.ts';
import type { Project } from '../../shared/types.ts';

const s = implement(sceneContract);

const projectOf = (id: string): Project => listProjects().find((p) => p.id === id) || refuse('No such project.', 404);

export const sceneRouter = s.router({
  open: s.open.handler(({ input }) => {
    const p = projectOf(input.project);
    return { ...sceneOverview(p), base: `/scene/${sceneToken(p.id)}` };
  }),
  versions: s.versions.handler(({ input }) => sceneOverview(projectOf(input.project))),
  loaded: s.loaded.handler(({ input }) => {
    const p = projectOf(input.project);
    return { ok: !!markLoaded(p, input.version, input.loads, input.error) };
  }),
  restore: s.restore.handler(({ input }) => {
    const p = projectOf(input.project);
    if (!sceneVersion(p, input.version)) refuse('There is no such version of the scene.', 404);
    refusing(() => restoreVersion(p, input.version, { kind: 'user', name: 'You' }, input.path));
    log('project', `Went back to an earlier version of the scene in "${p.name}"`);
    return sceneOverview(p);
  }),
  snapshot: s.snapshot.handler(({ input: { request, ...look } }) => ({ ok: deliverSceneLook(request, look) })),
  log: s.log.handler(({ input }) => {
    projectOf(input.project);
    addSceneLogs(input.project, input.lines);
    return { ok: true };
  }),
  pin: s.pin.handler(({ input }) => {
    const p = projectOf(input.project);
    if (!pinVersion(p, input.version, input.pinned)) refuse('There is no such version of the scene.', 404);
    return sceneOverview(p);
  }),
});
