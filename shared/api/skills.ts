// Skills (server/api/skills.ts): the library, writing and changing one, deleting it everywhere, and bringing one
// in from ~/.claude/skills or GitHub. Drafting one from plain words is /api/assist/skill, still in server/index.ts.
import { oc, type } from '@orpc/contract';
import { z } from 'zod';
import type { ClaudeSkill, Skill, SkillInstallResult, SkillListing } from '../types.ts';

const oneSkill = z.object({ slug: z.string() });
const skillFields = {
  name: z.string({ error: 'Give the skill a name.' }).optional(),
  description: z.string({ error: 'Say in one or two sentences when the skill should be used: agents decide from this.' }).optional(),
  body: z.string({ error: 'A skill is text.' }).optional(),
};

export const skills = {
  /** The library, and the skills in ~/.claude/skills not in it yet. */
  list: oc.route({ method: 'GET', path: '/skills' }).output(type<{ skills: SkillListing[]; claude: ClaudeSkill[] }>()),
  get: oc.route({ method: 'GET', path: '/skills/{slug}' }).input(oneSkill).output(type<Skill>()),
  /** A new skill (its name gives its slug), or a change to the one named by slug. */
  create: oc.route({ method: 'POST', path: '/skills' }).input(z.object({ ...skillFields, slug: z.string().optional() })).output(type<Skill | null>()),
  change: oc.route({ method: 'PUT', path: '/skills/{slug}' }).input(oneSkill.extend(skillFields)).output(type<Skill | null>()),
  /** Deletes it and takes it off every agent, team and project that had it, and the Brain. */
  remove: oc.route({ method: 'DELETE', path: '/skills/{slug}' }).input(oneSkill).output(type<{ ok: true }>()),
  /** Copies one from ~/.claude/skills (name: its folder) into the library. */
  import: oc.route({ method: 'POST', path: '/skills/import' })
    .input(z.object({ name: z.string({ error: 'Pick a skill from ~/.claude/skills.' }) }))
    .output(type<Skill | null>()),
  /** Installs (or updates) the skills at a GitHub link you typed. */
  install: oc.route({ method: 'POST', path: '/skills/install' })
    .input(z.object({ url: z.string({ error: 'Paste a GitHub link.' }) }))
    .output(type<SkillInstallResult>()),
};
