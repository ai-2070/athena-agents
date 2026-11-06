// The agents' runs going now (server/api/runs.ts), and stopping one.
import { oc, type } from '@orpc/contract';
import { z } from 'zod';
import type { ActiveRun } from '../types.ts';

export const runs = {
  list: oc.route({ method: 'GET', path: '/runs' }).output(type<ActiveRun[]>()),
  /** ok: false when it had already ended. */
  stop: oc.route({ method: 'POST', path: '/runs/{id}/stop' }).input(z.object({ id: z.string() })).output(type<{ ok: boolean }>()),
};
