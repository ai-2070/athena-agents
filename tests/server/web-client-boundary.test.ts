// Only web/client/ reaches the server: everywhere else asks it for addresses, requests and sockets, so
// reaching the server another way (a paired phone) stays a change in one place.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const WEB = path.resolve(import.meta.dirname, '../../web');
const CLIENT = path.join(WEB, 'client');

const sources = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return p === CLIENT ? [] : sources(p);
    return /\.tsx?$/.test(e.name) ? [p] : [];
  });

// what only the client may write
const DIRECT = [
  { what: "an '/api/' address", re: /['"`]\/api\// },
  { what: 'fetch(', re: /(?<![\w.])fetch\(/ },
  { what: 'new WebSocket(', re: /new WebSocket\(/ },
  { what: 'XMLHttpRequest', re: /XMLHttpRequest/ },
  { what: "the 'x-dash' header", re: /x-dash/ },
];

describe('the page reaches the server only through web/client/', () => {
  it('has no direct requests, sockets or API addresses anywhere else', () => {
    const found: string[] = [];
    for (const file of sources(WEB)) {
      fs.readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/^\s*(\/\/|\*)/.test(line)) return; // comments may talk about them
          for (const d of DIRECT)
            if (d.re.test(line)) found.push(`${path.relative(WEB, file)}:${i + 1} uses ${d.what}`);
        });
    }
    expect(found).toEqual([]);
  });
});

// The page's bundle gets shared/api/ as routes only (scripts/build-web.ts), so zod doesn't load with the page.
// A value imported from shared/api/ elsewhere would bring the schemas, and zod, back.
describe('the page takes only types from shared/api/', () => {
  it('imports values from it only in web/client/', () => {
    const found: string[] = [];
    for (const file of sources(WEB)) {
      fs.readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/from ['"][./]*shared\/api\//.test(line) && !/^\s*import type /.test(line))
            found.push(`${path.relative(WEB, file)}:${i + 1}`);
        });
    }
    expect(found).toEqual([]);
  });
});
