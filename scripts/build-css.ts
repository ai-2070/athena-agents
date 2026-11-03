// The page's stylesheet: Tailwind reads web/styles/app.css, finds the class names used in web/ and
// public/index.html, and writes only what they need. Used by build-web.ts (and its test); plain Node.
import fs from 'node:fs';
import path from 'node:path';
import { compile, optimize } from '@tailwindcss/node';
import { Scanner } from '@tailwindcss/oxide';
import { Features, transform } from 'lightningcss';

export const CSS_ENTRY = path.resolve(import.meta.dirname, '..', 'web', 'styles', 'app.css');

// The oldest engine the page must look right in: the desktop app on macOS 13 uses the system's
// WebKit, which can be Safari 16.4. Tailwind targets it too, but leaves light-dark() as it is (Safari 17.5+).
const SAFARI_16_4 = (16 << 16) | (4 << 8);

export async function buildCss({ minify = true }: { minify?: boolean } = {}): Promise<string> {
  const compiler = await compile(fs.readFileSync(CSS_ENTRY, 'utf8'), { base: path.dirname(CSS_ENTRY), onDependency: () => {} });
  const sources = compiler.sources.map((s) => ({ base: s.base, pattern: s.pattern, negated: s.negated }));
  const css = compiler.build(new Scanner({ sources }).scan());
  const optimized = optimize(css, { file: CSS_ENTRY, minify }).code;
  // light-dark(a, b) becomes var(--lightningcss-light, a) var(--lightningcss-dark, b), with the two set
  // wherever color-scheme is (base.css: on :root, by system and by data-theme). lightDark() in
  // web/theme.ts writes the same for colours set from code.
  return transform({ filename: CSS_ENTRY, code: Buffer.from(optimized), minify, targets: { safari: SAFARI_16_4, ios_saf: SAFARI_16_4 }, include: Features.LightDark }).code.toString();
}
