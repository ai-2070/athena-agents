// The scene look (shared/api/scene.ts): the address of a project's scene, its versions, load reports, going back.
import { implement } from '@orpc/server';
import { scene as sceneContract } from '../../shared/api/scene.ts';
import { log, projectById } from '../store.ts';
import {
  markLoaded,
  pinVersion,
  readThumb,
  restoreVersion,
  saveThumb,
  sceneOverview,
  sceneVersion,
  startFromTemplate,
} from '../scene/history.ts';
import { isSceneTemplate } from '../../shared/scene.ts';
import { sceneToken } from '../scene/serve.ts';
import { addSceneLogs, deliverSceneLook } from '../scene/look.ts';
import { refuse, refusing } from './refuse.ts';

const s = implement(sceneContract);

export const sceneRouter = s.router({
  open: s.open.handler(({ input }) => {
    const p = projectById(input.project);
    return { ...sceneOverview(p), base: `/scene/${sceneToken(p.id)}` };
  }),
  versions: s.versions.handler(({ input }) => sceneOverview(projectById(input.project))),
  loaded: s.loaded.handler(({ input }) => {
    const p = projectById(input.project);
    return { ok: !!markLoaded(p, input.version, input.loads, input.error) };
  }),
  restore: s.restore.handler(({ input }) => {
    const p = projectById(input.project);
    if (!sceneVersion(p, input.version)) refuse('There is no such version of the scene.', 404);
    refusing(() => restoreVersion(p, input.version, { kind: 'user', name: 'You' }, input.path));
    log('project', `Went back to an earlier version of the scene in "${p.name}"`);
    return sceneOverview(p);
  }),
  snapshot: s.snapshot.handler(({ input: { request, ...look } }) => ({ ok: deliverSceneLook(request, look) })),
  log: s.log.handler(({ input }) => {
    projectById(input.project);
    addSceneLogs(input.project, input.lines);
    return { ok: true };
  }),
  start: s.start.handler(({ input }) => {
    const p = projectById(input.project);
    if (!isSceneTemplate(input.template)) refuse('Pick one of the templates.');
    refusing(() =>
      startFromTemplate(p, input.template as Parameters<typeof startFromTemplate>[1], { kind: 'user', name: 'You' }),
    );
    log('project', `Started the scene from a template in "${p.name}"`);
    return sceneOverview(p);
  }),
  saveThumb: s.saveThumb.handler(({ input }) => ({
    ok: saveThumb(projectById(input.project), input.version, input.image),
  })),
  thumb: s.thumb.handler(({ input }) => ({ image: readThumb(projectById(input.project), input.version) })),
  pin: s.pin.handler(({ input }) => {
    const p = projectById(input.project);
    if (!pinVersion(p, input.version, input.pinned)) refuse('There is no such version of the scene.', 404);
    return sceneOverview(p);
  }),
});
