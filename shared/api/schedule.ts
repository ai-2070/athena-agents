// When a routine or a team runs on its own (Schedule in shared/types.ts), as both routes take it.
import { z } from 'zod';
import type { Schedule } from '../types.ts';

// (one field per field of Schedule: a field added there and not here fails to compile, instead of being
// dropped quietly on save)
const fields = {
  type: z.string(),
  times: z.array(z.string()).optional(),
  minutes: z.number().optional(),
  days: z.array(z.number()).optional(),
  input: z.string().optional(),
} satisfies Record<keyof Schedule, z.ZodType>;

export const schedule = z.object(fields, { error: 'schedule must say when it runs.' });
