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

// comments may talk about it: blank them out (keeping the lines, for the line numbers)
const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, (c) => c.replace(/[^\n]/g, ' '));

/** Where a file makes a React root, or takes react-dom/client's root makers in any form. */
function rootMakers(text: string): number[] {
  const src = code(text);
  const lines: number[] = [];
  const at = (i: number) => lines.push(src.slice(0, i).split('\n').length);
  // createRoot(…), ReactDOM.createRoot(…), hydrateRoot(…)
  for (const m of src.matchAll(/\b(?:createRoot|hydrateRoot)\s*\(/g)) at(m.index);
  // any import of react-dom/client but a type-only one (the braces may span lines), and import('react-dom/client')
  for (const m of src.matchAll(
    /\bimport\s+(?!type\b)[^;]*?\bfrom\s*['"]react-dom\/client['"]|\bimport\s*\(\s*['"]react-dom\/client['"]/g,
  ))
    at(m.index);
  return [...new Set(lines)].sort((a, b) => a - b);
}

describe('React roots in the page', () => {
  it('are all made by createAppRoot', () => {
    const found = sources(WEB).flatMap((file) =>
      rootMakers(fs.readFileSync(file, 'utf8')).map((line) => `${path.relative(WEB, file)}:${line}`),
    );
    expect(found).toEqual([]);
  });

  it('are found however a file makes one', () => {
    expect(rootMakers("import { createRoot } from 'react-dom/client';\ncreateRoot(el);")).toEqual([1, 2]);
    expect(rootMakers("import * as ReactDOM from 'react-dom/client';\nReactDOM.createRoot(el);")).toEqual([1, 2]);
    expect(rootMakers("import {\n  hydrateRoot,\n} from 'react-dom/client';")).toEqual([1]);
    expect(rootMakers("const m = await import('react-dom/client');")).toEqual([1]);
    expect(
      rootMakers(
        "import type { Root } from 'react-dom/client';\n// createRoot(el) is not used here\n/* nor\n hydrateRoot( */",
      ),
    ).toEqual([]);
    expect(rootMakers('const root = createAppRoot(el);')).toEqual([]);
  });
});
