// Version history (shared/api/versions.ts), kept by server/history.ts.
import { implement } from '@orpc/server';
import { versions as contract } from '../../shared/api/versions.ts';
import * as history from '../history.ts';
import { refuse } from './refuse.ts';
import type { VersionKind } from '../../shared/types.ts';

const os = implement(contract);
const kept = (k: string): VersionKind =>
  history.isVersionKind(k) ? k : refuse('Versions are kept for skills, agents, teams and MEMORY.md files.', 404);

export const versionsRouter = os.router({
  deleted: os.deleted.handler(({ input }) => history.deletedItems(kept(input.kind))),
  undelete: os.undelete.handler(({ input }) => history.undelete(kept(input.kind), input.id)),
  history: os.history.handler(({ input }) => history.historyOf(kept(input.kind), input.id)),
  get: os.get.handler(({ input }) => history.versionOf(kept(input.kind), input.id, input.vid)),
  restore: os.restore.handler(({ input }) => history.restoreVersion(kept(input.kind), input.id, input.vid)),
});
