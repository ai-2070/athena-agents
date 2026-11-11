// What you send an agent or the Brain (shared/api/agents.ts, brain.ts): words, and files you attached (uploads of
// the project). Both are optional here; server/api/said.ts refuses a message with neither.
import { z } from 'zod';

export const message = {
  text: z.string({ error: 'Type a message first.' }).optional(),
  attachments: z
    .array(z.string({ error: 'Each attachment is a file of the project.' }), { error: 'attachments must be a list.' })
    .optional(),
};
