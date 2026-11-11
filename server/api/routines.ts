// Routines (shared/api/routines.ts). server/routines.ts cleans what comes in and refuses with a status.
import { implement } from '@orpc/server';
import { routines as contract } from '../../shared/api/routines.ts';
import { routines as routineStore } from '../store.ts';
import * as routines from '../routines.ts';
import { refuse } from './refuse.ts';

const os = implement(contract);
const saved = (id: string): string => routineStore.get(id)?.id || refuse('That routine is unavailable.', 404);

export const routinesRouter = os.router({
  list: os.list.handler(() => routines.listRoutines()),
  create: os.create.handler(({ input }) => routines.saveRoutine(input)),
  get: os.get.handler(({ input }) => routines.getRoutine(input.id) || refuse('That routine is unavailable.', 404)),
  change: os.change.handler(({ input: { id, ...patch } }) => routines.saveRoutine(patch, saved(id))),
  remove: os.remove.handler(({ input }) => (routines.deleteRoutine(input.id), { ok: true as const })),
  run: os.run.handler(({ input }) =>
    routines.startRoutine(saved(input.id), { input: (input.input || '').slice(0, 20000) }),
  ),
  runs: {
    list: os.runs.list.handler(({ input }) => routines.listRuns(input.routineId || undefined)),
    stop: os.runs.stop.handler(({ input }) => ({ ok: routines.stopRoutineRun(input.id) })),
  },
});
