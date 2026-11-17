// The scene look (server/api/scene.ts, docs/internal/plans/HTML_SCENE_PLAN.md): the address a project's scene is
// served at, its versions, how a version loaded in the Station, going back to one, and keeping one.
import { oc, type } from '@orpc/contract';
import { z } from 'zod';
import type { SceneVersions } from '../types.ts';

const project = z.string({ error: 'Say which project.' }).min(1, { error: 'Say which project.' });
const version = z.string({ error: 'Say which version.' }).min(1, { error: 'Say which version.' });

export const scene = {
  /** Where the project's scene is served (/scene/<token>), and its versions. Watches its folder for changes. */
  open: oc
    .route({ method: 'POST', path: '/scene/open' })
    .input(z.object({ project }))
    .output(type<SceneVersions & { base: string }>()),
  versions: oc
    .route({ method: 'GET', path: '/scene/versions' })
    .input(z.object({ project }))
    .output(type<SceneVersions>()),
  /** How a version loaded in a tab: it sent `ready` with no error in its first seconds (ok), or not (broken). */
  loaded: oc
    .route({ method: 'POST', path: '/scene/loaded' })
    .input(
      z.object({
        project,
        version,
        loads: z.enum(['ok', 'broken'], { error: 'A version loads "ok" or is "broken".' }),
        error: z.string().max(4000).optional(),
      }),
    )
    .output(type<{ ok: boolean }>()),
  /** Writes a version (or one file of it) back into the scene folder; that is kept as a new version. */
  restore: oc
    .route({ method: 'POST', path: '/scene/restore' })
    .input(z.object({ project, version, path: z.string().optional() }))
    .output(type<SceneVersions>()),
  /** Keeps a version however old it gets (pinned), or lets it go again. */
  pin: oc
    .route({ method: 'POST', path: '/scene/pin' })
    .input(z.object({ project, version, pinned: z.boolean({ error: 'pinned is true or false.' }) }))
    .output(type<SceneVersions>()),
};
