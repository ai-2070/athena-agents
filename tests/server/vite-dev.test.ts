// The Vite dev server behind `bun run dev`: it starts on this machine, hands the page its entry and styles, and
// hands out nothing but the page's own code (never the data folder, the server's code or the repo's files).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ENTRY, STYLES, dashPlugin, entryCode, startVite, stylesCode } from '../../scripts/vite-dev.ts';
import type { DevServer } from '../../scripts/vite-dev.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');

describe('the dev entry and styles', () => {
  it('sets up hot reload before the app loads', () => {
    const code = entryCode().split('\n');
    const at = (s: string) => code.findIndex((l) => l.includes(s));
    expect(at('/@vite/client')).toBe(0);
    expect(at('@vitejs/plugin-react/preamble')).toBeGreaterThan(at('/@vite/client'));
    expect(at("import('/app.ts')")).toBe(code.length - 1);
    // OpenUI's inspector is turned off before the app could load it
    expect(at('openui.devtools.autoMount')).toBeLessThan(at("import('/app.ts')"));
  });

  it('keeps one <style> up to date and takes over from the bundle stylesheet', () => {
    const code = stylesCode('a{color:red}</style><script>');
    expect(code).toContain('"a{color:red}</style><script>"');
    expect(code).toContain('import.meta.hot.accept()');
    expect(code).toContain('href="/dist/app.css"');
  });
});

describe('the styles follow code changes', () => {
  // the hook, with just what it reads of its context
  const run = (file: string, styles: object | undefined, modules: object[] = []) => {
    const invalidated: object[] = [];
    const ctx = { environment: { name: 'client', moduleGraph: { getModuleById: (id: string) => (id === STYLES ? styles : undefined), invalidateModule: (m: object) => invalidated.push(m) } } };
    const hook = dashPlugin().hotUpdate as unknown as (this: typeof ctx, o: { file: string; modules: object[] }) => object[] | undefined;
    return { result: hook.call(ctx, { file, modules }), invalidated };
  };

  it('a change to the page code also updates the styles (Tailwind writes only the classes used)', () => {
    const styles = { id: STYLES };
    const page = { id: '/views/home.tsx' };
    const { result, invalidated } = run(path.join(ROOT, 'web', 'views', 'home.tsx'), styles, [page]);
    expect(result).toEqual([page, styles]);
    expect(invalidated).toEqual([styles]);
    expect(run(path.join(ROOT, 'web', 'styles', 'base.css'), styles).result).toEqual([styles]);
  });

  it('leaves other changes alone', () => {
    expect(run(path.join(ROOT, 'server', 'index.ts'), { id: STYLES }).result).toBeUndefined();
    expect(run(path.join(ROOT, 'web', 'icon.png'), { id: STYLES }).result).toBeUndefined();
    // styles not loaded yet: nothing to update
    expect(run(path.join(ROOT, 'web', 'app.ts'), undefined).result).toBeUndefined();
  });
});

describe('the dev server', () => {
  let dev: DevServer;
  // its own cache: `bun run dev` may be running on the repo's (Vite may still be writing it as it closes, so it is
  // kept out of the test's data folder and removed with retries)
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-vite-'));
  beforeAll(async () => {
    dev = await startVite({ port: 0, logLevel: 'silent', cacheDir });
  }, 60_000);
  afterAll(async () => {
    await dev?.close();
    fs.rmSync(cacheDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  const get = (p: string) => fetch(`${dev.origin}${p}`);

  it('listens on this machine only', () => {
    expect(dev.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('serves the entry and the styles', async () => {
    const entry = await get(ENTRY);
    expect(entry.status).toBe(200);
    expect(await entry.text()).toContain("import('/app.ts')");
    const styles = await (await get(STYLES)).text();
    expect(styles).toContain('tailwindcss');
    expect(styles).toContain('/dist/fonts/');
  }, 60_000);

  it('serves the page code and shared/', async () => {
    expect((await get('/core.ts')).status).toBe(200);
    expect((await get(`/@fs${path.join(ROOT, 'shared', 'types.ts').replace(/\\/g, '/').replace(/^(?=[A-Za-z]:)/, '/')}`)).status).toBe(200);
  }, 60_000);

  it('refuses everything else in the repo', async () => {
    const fsUrl = (...p: string[]) => `/@fs${path.join(ROOT, ...p).replace(/\\/g, '/').replace(/^(?=[A-Za-z]:)/, '/')}`;
    for (const p of [fsUrl('package.json'), fsUrl('server', 'index.ts'), fsUrl('tests', 'server', 'setup.ts'), '/../package.json', '/%2e%2e/package.json']) {
      const res = await get(p);
      expect([403, 404], p).toContain(res.status);
    }
  }, 60_000);

  it('lets only pages on this machine read it', async () => {
    const res = await fetch(`${dev.origin}/core.ts`, { headers: { origin: 'https://example.com' } });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    const local = await fetch(`${dev.origin}/core.ts`, { headers: { origin: 'http://localhost:4800' } });
    expect(local.headers.get('access-control-allow-origin')).toBe('http://localhost:4800');
  }, 60_000);
});
