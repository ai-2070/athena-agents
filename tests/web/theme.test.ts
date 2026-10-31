// Light or dark: the page follows the system, and the accent takes the tone that suits the page.
import { afterEach, describe, expect, it } from 'vitest';
import { ACCENTS, accentFor, accentTone, applyLook } from '../../web/look.ts';
import { isDark, onThemeChange } from '../../web/theme.ts';

const root = document.documentElement;
afterEach(() => {
  delete root.dataset.theme;
  root.removeAttribute('style');
});

describe('isDark()', () => {
  it('is light unless the system or <html data-theme> says dark', () => {
    expect(isDark()).toBe(false);
    root.dataset.theme = 'dark';
    expect(isDark()).toBe(true);
    root.dataset.theme = 'light';
    expect(isDark()).toBe(false);
  });

  it('tells listeners when the page switches, until they stop', async () => {
    const seen: boolean[] = [];
    const stop = onThemeChange((dark) => seen.push(dark));
    root.dataset.theme = 'dark';
    await new Promise((r) => setTimeout(r, 0));
    stop();
    root.dataset.theme = 'light';
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual([true]);
  });
});

describe('the accent', () => {
  it('defaults to Aegean blue and keeps it readable when the theme switches', async () => {
    expect(applyLook().accent).toBe('aegean');
    expect(root.style.getPropertyValue('--color-accent')).toBe('#18688e');
    expect(root.style.getPropertyValue('--color-on-accent')).toBe('#ffffff');
    root.dataset.theme = 'dark';
    await new Promise((r) => setTimeout(r, 0));
    expect(root.style.getPropertyValue('--color-accent')).toBe('#7cbad5');
    expect(root.style.getPropertyValue('--color-on-accent')).toBe('#061923');
  });

  it('has a light and a dark tone, and dark text on the dark one', () => {
    for (const a of ACCENTS) {
      expect(a.light.c).toMatch(/^#[0-9a-f]{6}$/);
      expect(a.dark.c).toMatch(/^#[0-9a-f]{6}$/);
      expect(a.dark.c).not.toBe(a.light.c);
    }
    const aegean = ACCENTS[0]!;
    expect(accentTone(aegean, false)).toBe(aegean.light);
    expect(accentTone(aegean, true)).toBe(aegean.dark);
  });

  it('a setting saved with an old colour moves to the closest new one; anything unknown is the default', () => {
    expect(accentFor('lime').id).toBe('aegean');
    expect(accentFor('rose').id).toBe('terracotta');
    expect(accentFor('violet').id).toBe('amethyst');
    expect(accentFor('mint').id).toBe('olive');
    expect(accentFor('amber').id).toBe('gold');
    expect(accentFor('nonsense').id).toBe('aegean');
    expect(accentFor(undefined).id).toBe('aegean');
  });

  it('is painted in the page\'s tone, and repainted when the page switches', async () => {
    const gold = ACCENTS.find((a) => a.id === 'gold')!;
    applyLook({ accent: 'gold' });
    expect(root.style.getPropertyValue('--color-accent')).toBe(gold.light.c);
    expect(root.style.getPropertyValue('--color-on-accent')).toBe(gold.light.on);
    root.dataset.theme = 'dark';
    await new Promise((r) => setTimeout(r, 0));
    expect(root.style.getPropertyValue('--color-accent')).toBe(gold.dark.c);
    expect(root.style.getPropertyValue('--color-on-accent')).toBe(gold.dark.on);
  });
});
