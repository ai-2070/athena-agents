// The page's security policy, and the dev page `bun run dev` serves: code from the Vite dev server only when `--vite`
// names one on this machine, and the policy otherwise exactly as it always was.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { devPage, pageCsp, viteFromArgs, viteOrigin } from '../../server/devpage.ts';

describe('viteOrigin', () => {
  it('takes a dev server on this machine', () => {
    expect(viteOrigin('http://127.0.0.1:5173')).toBe('http://127.0.0.1:5173');
    expect(viteOrigin('http://localhost:5174/')).toBe('http://localhost:5174');
  });

  it('ignores anything else', () => {
    for (const v of [
      undefined,
      '',
      'http://example.com:5173',
      'https://127.0.0.1:5173',
      'http://127.0.0.1',
      'http://127.0.0.1:0',
      'http://127.0.0.1:70000',
      'http://127.0.0.1:5173/x',
      'http://127.0.0.1.evil.com:5173',
      'javascript:alert(1)',
    ])
      expect(viteOrigin(v)).toBeNull();
  });
});

describe('viteFromArgs', () => {
  it("takes the dev server from the server's command line", () => {
    expect(viteFromArgs(['--no-open', '--vite', 'http://127.0.0.1:5173', '--port', '4900'], {})).toBe(
      'http://127.0.0.1:5173',
    );
    expect(viteFromArgs(['--vite', 'http://example.com:5173'], {})).toBeNull();
    expect(viteFromArgs(['--vite'], {})).toBeNull();
  });

  it('ignores the environment, so a leftover setting there changes nothing', () => {
    expect(viteFromArgs([], { DASH_VITE: 'http://127.0.0.1:5173' })).toBeNull();
  });

  it('is never used by the desktop app', () => {
    expect(viteFromArgs(['--vite', 'http://127.0.0.1:5173'], { DASH_DESKTOP: '1' })).toBeNull();
  });
});

describe('pageCsp', () => {
  it('is the same policy as always without a dev server', () => {
    expect(pageCsp(4800)).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; " +
        "img-src 'self' data: blob: https://pbs.twimg.com https://abs.twimg.com; " +
        "connect-src 'self' ws://localhost:4800 ws://127.0.0.1:4800; frame-ancestors 'none'",
    );
  });

  it('lets in only the dev server with one', () => {
    const csp = pageCsp(4800, 'http://127.0.0.1:5173');
    expect(csp).toContain("script-src 'self' http://127.0.0.1:5173;");
    expect(csp).toContain(
      "connect-src 'self' ws://localhost:4800 ws://127.0.0.1:4800 http://127.0.0.1:5173 ws://127.0.0.1:5173;",
    );
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).toContain("frame-ancestors 'none'");
  });
});

describe('devPage', () => {
  const html = fs.readFileSync(path.resolve(import.meta.dirname, '../../public/index.html'), 'utf8');

  it('loads the code from the dev server in place of the bundle', () => {
    const page = devPage(html, 'http://127.0.0.1:5173');
    expect(page).toContain('<script type="module" src="http://127.0.0.1:5173/@dash/dev"></script>');
    expect(page).not.toContain('/dist/app.js');
    // the stylesheet stays for the first paint
    expect(page).toContain('href="/dist/app.css"');
  });

  it('leaves a page without the bundle tag as it is', () => {
    expect(devPage('<p>hi</p>', 'http://127.0.0.1:5173')).toBe('<p>hi</p>');
  });
});
