// The agents' runs going now (shared/api/runs.ts).
import { implement } from '@orpc/server';
import { runs as contract } from '../../shared/api/runs.ts';
import { activeRuns, stopRun } from '../engines/index.ts';

const os = implement(contract);

export const runsRouter = os.router({
  list: os.list.handler(() => activeRuns()),
  stop: os.stop.handler(({ input }) => ({ ok: stopRun(input.id) })),
});
