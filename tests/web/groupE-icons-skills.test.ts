import { afterEach, describe, expect, it, vi } from 'vitest';
import { brandColor, brandPath, icon, logo } from '../../web/icons.ts';
import { forgetSkills, loadSkills, skillsCache } from '../../web/skillcache.ts';

describe('icons', () => {
  it('finds brand logos by name', () => {
    expect(logo('Gmail')).not.toBeNull();
    expect(brandPath('gmail')?.d).toBeTruthy();
    expect(brandColor('gmail')).toMatch(/^#/);
  });

  it('ignores Object.prototype keys like "constructor"', () => {
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(logo(name)).toBeNull();
      expect(brandPath(name)).toBeNull();
      expect(brandColor(name)).toBeNull();
    }
  });

  it('draws a mark whose own colour would vanish on the page in the text colour', () => {
    const fill = (): string | null | undefined => logo('github')?.querySelector('path')?.getAttribute('fill');
    const html = document.documentElement;
    // GitHub is #181717, Anthropic #191919: on a near-black page both are invisible.
    html.dataset.theme = 'dark';
    expect(fill()).toBe('currentColor');
    expect(brandColor('github')).toBe('#e6e8e0');
    expect(brandColor('anthropic')).toBe('#e6e8e0');
    html.dataset.theme = 'light';
    expect(fill()).toBe('#181717');
    expect(brandColor('github')).toBe('#181717');
    delete html.dataset.theme;
    // A mark that reads on the page keeps its own colour, and a caller's colour still wins.
    expect(brandColor('gmail')).toBe('#EA4335');
    expect(logo('gmail', 16, '#123456')?.querySelector('path')?.getAttribute('fill')).toBe('#123456');
  });

  it('falls back to the box icon for unknown or inherited names', () => {
    const box = icon('box').innerHTML;
    expect(icon('constructor').innerHTML).toBe(box);
    expect(icon('no-such-icon').innerHTML).toBe(box);
  });
});

describe('loadSkills', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    forgetSkills();
  });

  it('does not cache a failed load, so the next one retries', async () => {
    const skills = [{ slug: 'writing', name: 'Writing' }];
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'down' }), { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ skills, claude: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);

    expect(await loadSkills()).toEqual([]);
    expect(skillsCache()).toEqual([]);
    expect(await loadSkills()).toEqual(skills);
    expect(fetch).toHaveBeenCalledTimes(2);
    // now cached
    expect(await loadSkills()).toEqual(skills);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
