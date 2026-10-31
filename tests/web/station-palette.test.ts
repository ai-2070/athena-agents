// The Station's colours: worked out from the page's tokens for light or dark, and again when the page switches or the accent changes.
import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { INK, alpha, brandTone, mix, mutedTone, pal, refreshPalette, watchPalette } from '../../web/views/stationpalette.ts';

const root = document.documentElement;
const settle = () => new Promise((r) => setTimeout(r, 30));
// (the page's tokens come from the stylesheet, which a test page doesn't have: the dark ones are set here)
const dark = () => {
  root.dataset.theme = 'dark';
  for (const [name, value] of Object.entries({ ink: '#eceef1', floor: '#08090a', bg: '#0e0f11', accent: '#7f8cf3' })) root.style.setProperty(`--color-${name}`, value);
  refreshPalette();
};
beforeEach(() => {
  root.removeAttribute('style');
  delete root.dataset.theme;
  refreshPalette();
});
afterEach(() => {
  root.removeAttribute('style');
  delete root.dataset.theme;
});

describe('mixing colours', () => {
  it('mixes in sRGB, like color-mix() in the stylesheet', () => {
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(mix('#102030', '#102030', 0.7)).toBe('#102030');
    expect(mix('#ff0000', '#0000ff', 0)).toBe('#ff0000');
    expect(mix('#ff0000', '#0000ff', 1)).toBe('#0000ff');
  });

  it('writes an opacity as two more hex digits', () => {
    expect(alpha('#336699', 1)).toBe('#336699ff');
    expect(alpha('#336699', 0)).toBe('#33669900');
    expect(alpha('#336699', 0.5)).toBe('#33669980');
  });
});

describe('the map in light and dark', () => {
  it('lays glows on normally on white (added light would vanish) and adds them up at night', () => {
    expect(pal.dark).toBe(false);
    expect(pal.blend).toBe(THREE.NormalBlending);
    expect(pal.glowK).toBeLessThan(1);
    dark();
    expect(pal.dark).toBe(true);
    expect(pal.blend).toBe(THREE.AdditiveBlending);
  });

  it('is lit brighter on white than at night', () => {
    const light = pal.ambientK + pal.sunK;
    dark();
    expect(light).toBeGreaterThan(pal.ambientK + pal.sunK);
  });

  it('follows the page: its floor is the map\'s background and the accent is the working colour', () => {
    root.style.setProperty('--color-floor', '#f1f2f4');
    root.style.setProperty('--color-accent', '#c0502f');
    refreshPalette();
    expect(pal.clear).toBe(0xf1f2f4);
    expect(pal.accent).toBe('#c0502f');
    expect('#' + pal.working.getHexString()).toBe('#c0502f');
  });

  it('draws the monitors from the palette: light screens on white, dark ones at night', () => {
    const lum = (hex: string) => new THREE.Color(hex).getHSL({ h: 0, s: 0, l: 0 }).l;
    expect(lum(pal.screen.idleBg)).toBeGreaterThan(0.9);
    dark();
    expect(lum(pal.screen.idleBg)).toBeLessThan(0.2);
  });
});

describe('brand colours on the map', () => {
  it('turns a black-and-white brand into the page\'s text colour', () => {
    expect(brandTone(INK)).toBe(pal.ink);
    dark();
    expect(brandTone(INK)).toBe(pal.ink);
  });

  it('deepens a pale neon on white and leaves a mid colour as it is', () => {
    const lum = (hex: string) => new THREE.Color(hex).getHSL({ h: 0, s: 0, l: 0 }).l;
    expect(lum(brandTone('#f2ff59'))).toBeLessThan(lum('#f2ff59') - 0.15);
    expect(brandTone('#d97757')).toBe('#d97757');
    expect(brandTone(undefined)).toBe(pal.accent);
  });

  it('lifts a very dark brand at night, and mutes the wires nobody is looking at', () => {
    const lum = (hex: string) => new THREE.Color(hex).getHSL({ h: 0, s: 0, l: 0 }).l;
    dark();
    expect(lum(brandTone('#412991'))).toBeGreaterThan(lum('#412991'));
    expect(mutedTone('#ff4500')).not.toBe(brandTone('#ff4500'));
  });
});

describe('watching the palette', () => {
  it('says when the page switches between light and dark, once, and stops when asked', async () => {
    let n = 0;
    const stop = watchPalette(() => {
      n++;
      refreshPalette();
    });
    root.dataset.theme = 'dark';
    await settle();
    expect(n).toBe(1);
    stop();
    root.dataset.theme = 'light';
    await settle();
    expect(n).toBe(1);
  });

  it('says when the accent changes, but not for something else on <html style>', async () => {
    let n = 0;
    const stop = watchPalette(() => {
      n++;
      refreshPalette();
    });
    root.style.zoom = '1.2';
    await settle();
    expect(n).toBe(0);
    root.style.setProperty('--color-accent', '#7c4dcc');
    await settle();
    expect(n).toBe(1);
    stop();
  });
});
