// Skills (shared/api/skills.ts). server/skills.ts refuses a skill without a name or a description in plain words.
import { implement } from '@orpc/server';
import { skills as contract } from '../../shared/api/skills.ts';
import { log } from '../store.ts';
import * as skills from '../skills.ts';
import { installFromGitHub } from '../skillinstall.ts';
import { refuse, refusing } from './refuse.ts';

const os = implement(contract);

export const skillsRouter = os.router({
  list: os.list.handler(() => ({ skills: skills.listSkills(), claude: skills.claudeSkills() })),
  get: os.get.handler(({ input }) => skills.getSkill(input.slug) || refuse('That skill is unavailable.', 404)),
  create: os.create.handler(({ input }) => {
    const s = refusing(() => skills.saveSkill(input));
    if (s) log('skill', `Saved the skill "${s.name}"`);
    return s;
  }),
  change: os.change.handler(({ input }) => refusing(() => skills.saveSkill(input))),
  remove: os.remove.handler(({ input }) => (skills.deleteSkillEverywhere(input.slug), { ok: true as const })),
  import: os.import.handler(({ input }) => refusing(() => skills.importClaudeSkill(input.name))),
  install: os.install.handler(({ input }) => refusing(() => installFromGitHub(input.url))),
});
