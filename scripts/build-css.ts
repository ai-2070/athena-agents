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

async function start() {
  const compiler = await compile(fs.readFileSync(CSS_ENTRY, 'utf8'), { base: path.dirname(CSS_ENTRY), onDependency: () => {} });
  const sources = compiler.sources.map((s) => ({ base: s.base, pattern: s.pattern, negated: s.negated }));
  const scanner = new Scanner({ sources });
  return { compiler, scanner, raw: compiler.build(scanner.scan()) };
}

function finish(css: string, minify: boolean): string {
  const optimized = optimize(css, { file: CSS_ENTRY, minify }).code;
  // light-dark(a, b) becomes var(--lightningcss-light, a) var(--lightningcss-dark, b), with the two set
  // wherever color-scheme is (base.css: on :root, by system and by data-theme). lightDark() in
  // web/theme.ts writes the same for colours set from code.
  return transform({ filename: CSS_ENTRY, code: Buffer.from(optimized), minify, targets: { safari: SAFARI_16_4, ios_saf: SAFARI_16_4 }, include: Features.LightDark }).code.toString();
}

export async function buildCss({ minify = true }: { minify?: boolean } = {}): Promise<string> {
  return finish((await start()).raw, minify);
}

/** The stylesheet kept up to date as files change (the dev server's: scripts/vite-dev.ts). */
export interface CssBuilder {
  /** The current stylesheet. */
  css(): Promise<string>;
  /** Takes in a changed file; true when the stylesheet changed. */
  update(file: string): Promise<boolean>;
}

/** A CssBuilder that does the full build once, then only reads the changed file for new class names: a change to
 *  code that adds none costs no Tailwind or lightningcss pass. A change to a stylesheet builds it all again. */
export function incrementalCss({ minify = false }: { minify?: boolean } = {}): CssBuilder {
  let state: Promise<Awaited<ReturnType<typeof start>> & { out: string }> | null = null;
  const full = () =>
    (state = start().then((s) => ({ ...s, out: finish(s.raw, minify) })).catch((e: unknown) => {
      state = null;
      throw e;
    }));
  return {
    css: async () => (await (state ?? full())).out,
    async update(file) {
      if (!state) return false; // not built yet: the first css() reads everything
      const before = await state.catch(() => null);
      if (!before || file.endsWith('.css')) {
        const after = await full();
        return after.out !== before?.out;
      }
      let content: string;
      try {
        content = fs.readFileSync(file, 'utf8');
      } catch {
        return false; // removed: its classes stay until the next full build (harmless extra rules)
      }
      // (its text, not its path: the scanner skips a path outside the folders it was given)
      const found = before.scanner.scanFiles([{ content, extension: path.extname(file).slice(1) }]);
      if (!found.length) return false;
      const raw = before.compiler.build(found);
      if (raw === before.raw) return false;
      const out = finish(raw, minify);
      state = Promise.resolve({ ...before, raw, out });
      return out !== before.out;
    },
  };
}
