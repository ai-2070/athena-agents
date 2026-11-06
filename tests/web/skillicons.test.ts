import { afterEach, describe, expect, it, vi } from 'vitest';
import { logo } from '../../web/icons.ts';
import { PHOSPHOR } from '../../web/phosphor.ts';
import { forgetSkills, loadSkills } from '../../web/skillcache.ts';
import { ownColours, skillIcon, skillMark } from '../../web/skillicons.ts';
import { SKILL_MARKS } from '../../shared/skillmarks.ts';

describe('skill marks', () => {
  it('names only logos and icons the app has', () => {
    for (const [slug, m] of Object.entries(SKILL_MARKS)) {
      if ('logo' in m) expect(logo(m.logo), slug).not.toBeNull();
      if ('icon' in m) expect(Object.hasOwn(PHOSPHOR, m.icon), slug).toBe(true);
    }
  });

  it('draws a skill with its app icon, its logo or its line icon', () => {
    expect(skillIcon('orca-cli', 14).getAttribute('src')).toBe('/app-icons/orca.png');
    expect(skillIcon('photocraft', 14).getAttribute('src')).toBe('/craft-icons/photocraft.png');
    expect(skillIcon('github', 14).getAttribute('aria-label')).toBe('GitHub');
    const word = skillIcon('docx', 14) as SVGSVGElement;
    expect(word.classList.contains('ico-svg')).toBe(true);
    expect(word.style.color).toBeTruthy();
  });

  it('keeps the puzzle piece for a skill of your own, and for inherited names', () => {
    for (const slug of ['my-brand-voice', 'constructor', '', null]) expect(skillMark(slug)).toEqual({ icon: 'puzzle' });
    expect(ownColours(skillMark('my-brand-voice'))).toBe(false);
    expect(ownColours(skillMark('github'))).toBe(true);
    expect(ownColours(skillMark('docx'))).toBe(true);
    expect(ownColours(skillMark('spike'))).toBe(false);
  });

  describe('with the library loaded', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
      forgetSkills();
    });

    it("keeps the puzzle piece for a skill of yours that only shares its id with one that comes with the dashboard", async () => {
      const skills = [
        { slug: 'review-loop', name: 'Our code review', mine: true },
        { slug: 'vectorcraft', name: 'My vector notes', mine: true },
        { slug: 'motion-design', name: 'motion-design' },
      ];
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ skills, claude: [] }), { status: 200 })));
      expect(skillMark('review-loop')).toEqual(SKILL_MARKS['review-loop']);
      await loadSkills();
      expect(skillMark('review-loop')).toEqual({ icon: 'puzzle' });
      // a Craft app's id too
      expect(skillMark('vectorcraft')).toEqual({ icon: 'puzzle' });
      // the dashboard's own copy keeps its mark
      expect(skillMark('motion-design')).toEqual(SKILL_MARKS['motion-design']);
      forgetSkills();
      expect(skillMark('review-loop')).toEqual(SKILL_MARKS['review-loop']);
    });
  });
});
