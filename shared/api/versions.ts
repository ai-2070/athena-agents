// Version history (server/api/versions.ts) of skills, agents, teams and MEMORY.md files: the versions kept of one,
// one version, bringing one back, and what was deleted. A MEMORY.md's history and versions are also answered under
// /api/p/<project> for a project that isn't open.
import { oc, type } from '@orpc/contract';
import { z } from 'zod';
import type { DeletedItem, VersionDetail, VersionHistory } from '../types.ts';

// (a kind without versions is a 404, checked by the handler: there is nothing at that address)
const kind = z.string();
const oneItem = z.object({ kind, id: z.string() });
const oneVersion = oneItem.extend({ vid: z.string() });

export const versions = {
  /** What was deleted, newest first, to bring back. */
  deleted: oc
    .route({ method: 'GET', path: '/versions/{kind}' })
    .input(z.object({ kind }))
    .output(type<DeletedItem[]>()),
  undelete: oc
    .route({ method: 'POST', path: '/versions/{kind}/{id}/undelete' })
    .input(oneItem)
    .output(type<{ name: string }>()),
  history: oc.route({ method: 'GET', path: '/versions/{kind}/{id}' }).input(oneItem).output(type<VersionHistory>()),
  get: oc.route({ method: 'GET', path: '/versions/{kind}/{id}/{vid}' }).input(oneVersion).output(type<VersionDetail>()),
  /** Brings it back as that version was (what it is now is kept as a version first). */
  restore: oc
    .route({ method: 'POST', path: '/versions/{kind}/{id}/{vid}/restore' })
    .input(oneVersion)
    .output(type<{ name: string }>()),
};
