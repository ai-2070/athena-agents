// The page's fonts are served locally so the app looks the same offline.
// Copies the Fontsource files into <outdir>/fonts and returns their @font-face rules.
import fs from 'node:fs';
import path from 'node:path';

const PKGS = path.resolve(import.meta.dirname, '..', 'node_modules', '@fontsource-variable');

// Family names stay the plain ones web/styles/app.css and the terminal ask for.
export const FONTS = [
  { pkg: 'geist', family: 'Geist', sheets: ['wght.css', 'wght-italic.css'] },
  { pkg: 'archivo', family: 'Archivo', sheets: ['wght.css'] },
  { pkg: 'inter', family: 'Inter', sheets: ['wght.css', 'wght-italic.css'] },
  { pkg: 'jetbrains-mono', family: 'JetBrains Mono', sheets: ['wght.css'] },
  { pkg: 'merriweather', family: 'Merriweather', sheets: ['wght.css', 'wght-italic.css'] },
  // more chat fonts to pick in Settings > Look (web/look.ts CHAT_FONTS); a font's files download only when text uses it
  { pkg: 'google-sans', family: 'Google Sans', sheets: ['wght.css', 'wght-italic.css'] },
  { pkg: 'roboto', family: 'Roboto', sheets: ['wght.css', 'wght-italic.css'] },
  { pkg: 'dseg7-classic', family: 'DSEG7 Classic', sheets: ['400.css'] },
];

/** Copies the font files (and their licences) into outdir/fonts; returns the CSS, with urls relative to outdir. */
export function buildFonts(outdir: string): string {
  const fontsDir = path.join(outdir, 'fonts');
  fs.mkdirSync(fontsDir, { recursive: true });
  let css = '';
  for (const font of FONTS) {
    const dir = font.pkg === 'dseg7-classic'
      ? path.join(path.dirname(PKGS), '@fontsource', font.pkg)
      : path.join(PKGS, font.pkg);
    // the fonts' licence (SIL Open Font License) goes with them
    fs.copyFileSync(path.join(dir, 'LICENSE'), path.join(fontsDir, `${font.pkg}-LICENSE.txt`));
    for (const sheet of font.sheets) {
      css += fs
        .readFileSync(path.join(dir, sheet), 'utf8')
        .replace(/font-family:\s*'[^']+'/g, `font-family: '${font.family}'`)
        .replace(/url\(\.\/files\/([\w.-]+\.woff2?)\)/g, (_, file: string) => {
          fs.copyFileSync(path.join(dir, 'files', file), path.join(fontsDir, file));
          return `url(./fonts/${file})`;
        });
    }
  }
  return css;
}
