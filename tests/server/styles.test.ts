// The page's Tailwind stylesheet builds, and class names in web/ are written so Tailwind can see them.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCss, CSS_ENTRY } from '../../scripts/build-css.ts';

const WEB = path.resolve(import.meta.dirname, '../../web');
const sources = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return /\.tsx?$/.test(e.name) ? [p] : [];
  });

describe('the stylesheet', () => {
  it('builds with the theme, the shared pieces and the utilities the page uses', async () => {
    const css = await buildCss({ minify: false });
    // tokens look.ts swaps at runtime
    expect(css).toContain('--color-accent:');
    expect(css).toContain('--color-on-accent:');
    // a shared piece, Markdown defaults, a utility found in web/
    expect(css).toMatch(/\.btn\s*\{/);
    expect(css).toContain(':where(.md)');
    expect(css).toMatch(/\.text-dim\s*\{/);
    // the hidden class beats display utilities
    expect(css).toMatch(/\.hidden\s*\{[^}]*display:\s*none\s*!important/);
  }, 60_000);

  it('has no class names built from pieces (Tailwind reads the source text)', () => {
    // e.g. `bg-${color}`: the finished name never appears in the source, so no CSS is made for it
    const piece = /['"`\s](bg|text|border|ring|fill|stroke|shadow|from|to|via|w|h|min-w|max-w|min-h|max-h|p[xytrbl]|m[xytrbl]|gap|grid-cols|col-span|row-span|rounded|opacity|z|top|left|right|bottom|inset|translate-[xy]|font|leading|tracking)-\$\{/;
    const found: string[] = [];
    for (const file of sources(WEB)) {
      fs.readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/^\s*(\/\/|\*)/.test(line)) return;
          if (piece.test(line)) found.push(`${path.relative(WEB, file)}:${i + 1}`);
        });
    }
    expect(found).toEqual([]);
  });

  it('has no utilities glued to a following ${…} (Tailwind would skip them)', async () => {
    // `flex${on ? ' x' : ''}` reads as one word with the expression, so "flex" gets no CSS: put a space before ${
    const { __unstable__loadDesignSystem } = await import('@tailwindcss/node');
    const theme = fs.readFileSync(CSS_ENTRY, 'utf8').replace(/@import '\.\/(base|components)[^;]*;/g, '');
    const ds = await __unstable__loadDesignSystem(theme, { base: path.dirname(CSS_ENTRY) });
    const found: string[] = [];
    for (const file of sources(WEB)) {
      const src = fs.readFileSync(file, 'utf8');
      for (const m of src.matchAll(/([^\s`'"{}]+)\$\{/g)) {
        if (ds.candidatesToCss([m[1]])[0]) found.push(`${path.relative(WEB, file)}:${src.slice(0, m.index).split('\n').length} ${m[1]}`);
      }
    }
    expect(found).toEqual([]);
  }, 60_000);
});
