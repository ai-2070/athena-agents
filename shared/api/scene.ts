// The scene look (server/api/scene.ts, docs/internal/plans/HTML_SCENE_PLAN.md): the address a project's scene is
// served at, its versions, how a version loaded in the Station, going back to one, and keeping one.
import { oc, type } from '@orpc/contract';
import { z } from 'zod';
import type { SceneVersions } from '../types.ts';
import { SCENE_TEMPLATES } from '../scene.ts';

const SCENE_TEMPLATE_IDS = SCENE_TEMPLATES.map((t) => t.id) as [string, ...string[]];

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
  /** A picture an open Station made for scene_look (or why it couldn't). note: "version:<id>" says which it drew. */
  snapshot: oc
    .route({ method: 'POST', path: '/scene/snapshot/{request}' })
    .input(
      z.object({
        request: z.string(),
        image: z
          .string()
          .max(6 * 1024 * 1024)
          .optional(),
        error: z.string().max(2000).optional(),
        note: z.string().max(2000).optional(),
      }),
    )
    .output(type<{ ok: boolean }>()),
  /** What the shown scene logged lately (sent every few seconds while a tab shows it), for scene_logs. */
  log: oc
    .route({ method: 'POST', path: '/scene/log' })
    .input(
      z.object({
        project,
        lines: z
          .array(
            z.object({
              at: z.number(),
              version: z.string().max(100),
              level: z.enum(['error', 'warn', 'info']),
              text: z.string().max(4000),
            }),
          )
          .max(100, { error: 'At most 100 lines at a time.' }),
      }),
    )
    .output(type<{ ok: boolean }>()),
  /** Replaces the scene with a template (the starter, or a sample); the scene before is kept as a version. */
  start: oc
    .route({ method: 'POST', path: '/scene/start' })
    .input(z.object({ project, template: z.enum(SCENE_TEMPLATE_IDS, { error: 'Pick one of the templates.' }) }))
    .output(type<SceneVersions>()),
  /** A small picture of a version that loads (a JPEG data: URL), made by the first tab it loaded in. */
  saveThumb: oc
    .route({ method: 'POST', path: '/scene/thumb' })
    .input(z.object({ project, version, image: z.string().max(300 * 1024) }))
    .output(type<{ ok: boolean }>()),
  thumb: oc
    .route({ method: 'GET', path: '/scene/thumb' })
    .input(z.object({ project, version }))
    .output(type<{ image: string | null }>()),
  /** Keeps a version however old it gets (pinned), or lets it go again. */
  pin: oc
    .route({ method: 'POST', path: '/scene/pin' })
    .input(z.object({ project, version, pinned: z.boolean({ error: 'pinned is true or false.' }) }))
    .output(type<SceneVersions>()),
};
