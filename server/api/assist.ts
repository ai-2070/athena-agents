// The Brain helping you build (shared/api/assist.ts): drafts only, nothing saved here.
import { implement } from '@orpc/server';
import { assist as contract } from '../../shared/api/assist.ts';
import * as brain from '../brain.ts';
import * as skills from '../skills.ts';
import { cleanAttachments } from '../uploads.ts';
import { refuse } from './refuse.ts';

const os = implement(contract);

export const assistRouter = os.router({
  route: os.route.handler(({ input }) => brain.route(input.text || '')),
  model: os.model.handler(() => brain.brainModel()),
  agent: os.agent.handler(({ input }) =>
    brain.designAgent(input.text || '', { attachments: cleanAttachments(input.attachments) }),
  ),
  branch: os.branch.handler(({ input }) =>
    brain.designBranch(input.text || '', {
      allowNew: input.allowNew !== false,
      attachments: cleanAttachments(input.attachments),
    }),
  ),
  skill: os.skill.handler(({ input }) => {
    const text = (input.text || '').trim().slice(0, 8000);
    const attachments = cleanAttachments(input.attachments);
    if (!text && !attachments.length) return refuse('Say what the skill should do, or what to change.');
    const saved = input.slug ? skills.getSkill(input.slug) : null;
    // what the editor holds, else what is saved
    const field = (k: 'name' | 'description' | 'body', max: number) =>
      (input.current?.[k] ?? saved?.[k] ?? '').slice(0, max);
    const now = { name: field('name', 80), description: field('description', 1000), body: field('body', 60000) };
    // nothing written yet (a new skill's empty editor): a new skill, not an edit of an empty one
    const current = now.name.trim() || now.description.trim() || now.body.trim() ? now : null;
    return brain.draftSkill(text, {
      current,
      files: saved?.files.map((f) => f.path) || [],
      others: skills.listSkills().filter((s) => s.slug !== saved?.slug),
      attachments,
    });
  }),
});
