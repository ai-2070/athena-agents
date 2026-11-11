// Routines (server/api/routines.ts): saved instructions you run by hand or on a schedule; the @mentioned agents and
// teams do them. server/routines.ts cleans what comes in (the name, the schedule) and works out the mentions.
import { oc, type } from '@orpc/contract';
import { z } from 'zod';
import { schedule } from './schedule.ts';
import type { Routine, RoutineListing, RoutineRun } from '../types.ts';

const oneRoutine = z.object({ id: z.string() });
const routineFields = {
  name: z.string({ error: 'Give the routine a name.' }).optional(),
  description: z.string({ error: 'description must be text.' }).optional(),
  text: z.string({ error: 'Write what the routine should do first.' }).optional(),
  schedule: schedule.optional(),
  enabled: z.boolean({ error: 'enabled must be true or false.' }).optional(),
};

export const routines = {
  /** Every routine, with its latest run. */
  list: oc.route({ method: 'GET', path: '/routines' }).output(type<RoutineListing[]>()),
  /** A new one: on, unscheduled unless it says, never without something to do. */
  create: oc.route({ method: 'POST', path: '/routines' }).input(z.object(routineFields)).output(type<Routine>()),
  get: oc.route({ method: 'GET', path: '/routines/{id}' }).input(oneRoutine).output(type<Routine>()),
  change: oc
    .route({ method: 'PUT', path: '/routines/{id}' })
    .input(oneRoutine.extend(routineFields))
    .output(type<Routine>()),
  remove: oc.route({ method: 'DELETE', path: '/routines/{id}' }).input(oneRoutine).output(type<{ ok: true }>()),
  /** Runs it now; input: words added for this run. */
  run: oc
    .route({ method: 'POST', path: '/routines/{id}/run' })
    .input(oneRoutine.extend({ input: z.string({ error: 'input must be text.' }).optional() }))
    .output(type<RoutineRun>()),
  runs: {
    /** The latest runs; routineId: only that routine's. */
    list: oc
      .route({ method: 'GET', path: '/routine-runs' })
      .input(z.object({ routineId: z.string().optional() }))
      .output(type<RoutineRun[]>()),
    stop: oc
      .route({ method: 'POST', path: '/routine-runs/{id}/stop' })
      .input(oneRoutine)
      .output(type<{ ok: boolean }>()),
  },
};
