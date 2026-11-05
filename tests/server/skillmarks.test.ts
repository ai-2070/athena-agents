import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { shippedSkillSlugs } from '../../server/skills.ts';
import { ROOT } from '../../server/util.ts';
import { SKILL_MARKS } from '../../shared/skillmarks.ts';

// The Craft apps' skills are drawn with the app's own icon (web/crafticons.ts), the rest with SKILL_MARKS.
const craftIcon = (slug: string): boolean => fs.existsSync(path.join(ROOT, 'public', 'craft-icons', `${slug}.png`));

describe('skill marks', () => {
  it('gives every skill that comes with the dashboard a mark of its own', () => {
    const missing = shippedSkillSlugs().filter((slug) => !Object.hasOwn(SKILL_MARKS, slug) && !craftIcon(slug));
    expect(missing).toEqual([]);
  });

  it('lists only skills the dashboard comes with', () => {
    const shipped = new Set(shippedSkillSlugs());
    expect(Object.keys(SKILL_MARKS).filter((slug) => !shipped.has(slug))).toEqual([]);
  });

  it('points at pictures that are in public/', () => {
    for (const m of Object.values(SKILL_MARKS)) {
      if ('img' in m) expect(fs.existsSync(path.join(ROOT, 'public', m.img)), m.img).toBe(true);
    }
  });
});
