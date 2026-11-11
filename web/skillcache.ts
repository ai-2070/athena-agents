// The skill library as the page last loaded it, shared by the skill pickers, menus and marks.
import { rpc } from './client/rpc.ts';
import type { SkillListing } from '../shared/types.ts';

let cache: SkillListing[] | null = null;
let loading: Promise<SkillListing[]> | null = null;
export async function loadSkills(force = false): Promise<SkillListing[]> {
  if (cache && !force) return cache;
  loading ||= rpc.skills
    .list()
    .then((r): SkillListing[] => (cache = r.skills))
    // not cached, so the next load tries again
    .catch((): SkillListing[] => [])
    .finally(() => (loading = null));
  return loading;
}
export const skillsCache = (): SkillListing[] => cache || [];
export const forgetSkills = (): null => (cache = null);
