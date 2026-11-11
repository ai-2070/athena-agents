// The Brain helping you build (server/api/assist.ts): who a message should go to, which model it thinks with, and
// drafts of a new agent, a team or a skill from plain words. Nothing is saved until you save the draft.
import { oc, type } from '@orpc/contract';
import { z } from 'zod';
import type { AgentDraft, BrainModel, BrainRoute, BranchDesign, SkillDraft } from '../types.ts';

const request = {
  text: z.string({ error: 'Say what you need.' }).optional(),
  attachments: z.array(z.string(), { error: 'attachments must be a list.' }).optional(),
};

export const assist = {
  /** The agent or team best placed for a message (kind none: neither). */
  route: oc
    .route({ method: 'POST', path: '/assist/route' })
    .input(z.object({ text: request.text }))
    .output(type<BrainRoute>()),
  /** The model the Brain thinks with now (fallback: its own one isn't available). */
  model: oc.route({ method: 'GET', path: '/assist/model' }).output(type<BrainModel>()),
  agent: oc.route({ method: 'POST', path: '/assist/agent' }).input(z.object(request)).output(type<AgentDraft>()),
  /** allowNew: false: only agents you have. */
  branch: oc
    .route({ method: 'POST', path: '/assist/branch' })
    .input(z.object({ ...request, allowNew: z.boolean({ error: 'allowNew must be true or false.' }).optional() }))
    .output(type<BranchDesign>()),
  /** A skill written or changed: slug, the one being edited (for its files); current, what the editor holds now
   *  (unsaved changes too). */
  skill: oc
    .route({ method: 'POST', path: '/assist/skill' })
    .input(
      z.object({
        ...request,
        slug: z.string().optional(),
        current: z
          .object({ name: z.string().optional(), description: z.string().optional(), body: z.string().optional() })
          .nullable()
          .optional(),
      }),
    )
    .output(type<SkillDraft>()),
};
