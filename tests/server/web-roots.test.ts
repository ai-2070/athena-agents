// Every React root in the page comes from createAppRoot (web/ui/root.tsx), so each one has a crash guard: a piece
// that throws while drawing shows a message instead of going blank, and hot reload can draw it again.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const WEB = path.resolve(import.meta.dirname, '../../web');
const ROOT = path.join(WEB, 'ui', 'root.tsx');

const sources = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return /\.tsx?$/.test(e.name) && p !== ROOT ? [p] : [];
  });

describe('React roots in the page', () => {
  it('are all made by createAppRoot', () => {
    const found: string[] = [];
    for (const file of sources(WEB)) {
      fs.readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/^\s*(\/\/|\*)/.test(line)) return; // comments may talk about it
          if (/(?<![\w.])(createRoot|hydrateRoot)\(/.test(line) || /\{[^}]*\b(createRoot|hydrateRoot)\b[^}]*\}\s*from\s*'react-dom\/client'/.test(line))
            found.push(`${path.relative(WEB, file)}:${i + 1}`);
        });
    }
    expect(found).toEqual([]);
  });
});
