// The Vite dev server behind `bun run dev`: it starts on this machine, hands the page its entry and styles, and
// hands out nothing but the page's own code (never the data folder, the server's code or the repo's files).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ENTRY, STYLES, VIEW_MARK, WEB, changeKind, dashPlugin, entryCode, isViewFile, startVite, stylesCode } from '../../scripts/vite-dev.ts';
import type { DevServer } from '../../scripts/vite-dev.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');

describe('the dev entry and styles', () => {
  it('sets up hot reload before the app loads', () => {
    const code = entryCode().split('\n');
    const at = (s: string) => code.findIndex((l) => l.includes(s));
    expect(at('/@vite/client')).toBe(0);
    expect(at('@vitejs/plugin-react/preamble')).toBeGreaterThan(at('/@vite/client'));
    // the page's hot-reload rules are in place before the app loads
    expect(at('installHotRules()')).toBeGreaterThan(at('@vitejs/plugin-react/preamble'));
    expect(at('installHotRules()')).toBeLessThan(at("import('/app.ts')"));
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

describe('what a change does', () => {
  // the hook, with just what it reads of its context
  const run = (file: string, styles: object | undefined, modules: object[] = []) => {
    const invalidated: object[] = [];
    const sent: unknown[] = [];
    const ctx = {
      environment: {
        name: 'client',
        logger: { info: () => {} },
        hot: { send: (m: unknown) => sent.push(m) },
        moduleGraph: { getModuleById: (id: string) => (id === STYLES ? styles : undefined), invalidateModule: (m: object) => invalidated.push(m) },
      },
    };
    const hook = dashPlugin().hotUpdate as unknown as (this: typeof ctx, o: { file: string; modules: object[] }) => object[] | undefined;
    return { result: hook.call(ctx, { file, modules }), invalidated, sent };
  };
  const styles = { id: STYLES, isSelfAccepting: true };

  it('swaps React component files in place, with the styles (Tailwind writes only the classes used)', () => {
    const page = { id: '/views/home.tsx', isSelfAccepting: true };
    const { result, invalidated, sent } = run(path.join(WEB, 'views', 'home.tsx'), styles, [page]);
    expect(result).toEqual([page, styles]);
    expect(invalidated).toEqual([styles]);
    expect(sent).toEqual([]);
    expect(run(path.join(WEB, 'styles', 'base.css'), styles).result).toEqual([styles]);
  });

  it('reloads the page for a plain module, rather than run it a second time next to its first copy', () => {
    const core = { id: '/core.ts', isSelfAccepting: false };
    const { result, sent } = run(path.join(WEB, 'core.ts'), styles, [core]);
    expect(result).toEqual([]);
    expect(sent).toEqual([{ type: 'full-reload', path: '*' }]);
    // one plain module among swappable ones is enough
    expect(run(path.join(WEB, 'x.tsx'), styles, [{ id: '/x.tsx', isSelfAccepting: true }, core]).sent).toHaveLength(1);
  });

  it('leaves other changes alone', () => {
    expect(run(path.join(ROOT, 'server', 'index.ts'), styles).result).toBeUndefined();
    expect(run(path.join(WEB, 'icon.png'), styles).result).toBeUndefined();
    // styles not loaded yet: nothing to update
    expect(run(path.join(WEB, 'app.ts'), undefined).result).toBeUndefined();
  });

  it('changeKind', () => {
    expect(changeKind([])).toBe('none');
    expect(changeKind([{ id: STYLES, isSelfAccepting: true }])).toBe('none');
    expect(changeKind([{ id: '/a.tsx', isSelfAccepting: true }])).toBe('hot');
    expect(changeKind([{ id: '/a.ts' }])).toBe('reload');
  });
});

describe('pages in web/views/', () => {
  it('are told apart from other files', () => {
    expect(isViewFile(path.join(WEB, 'views', 'home.tsx'))).toBe(true);
    expect(isViewFile('C:\\athena\\web\\views\\tasks.tsx?t=1')).toBe(true);
    for (const f of [path.join(WEB, 'views', 'station.ts'), path.join(WEB, 'app.ts'), path.join(WEB, 'ui', 'button.tsx')]) expect(isViewFile(f), f).toBe(false);
  });

  it('get one component export in development, and nothing else changes', () => {
    const transform = dashPlugin().transform as unknown as { handler: (this: object, code: string, id: string) => { code: string } | undefined };
    const ctx = { environment: { name: 'client' } };
    const out = transform.handler.call(ctx, 'export const title = () => "Home";', path.join(WEB, 'views', 'home.tsx'));
    expect(out?.code).toBe(`export const title = () => "Home";${VIEW_MARK}`);
    expect(VIEW_MARK).toMatch(/export function [A-Z]\w*\(\) \{ return null; \}/);
    expect(transform.handler.call(ctx, 'x', path.join(WEB, 'core.ts'))).toBeUndefined();
  });

  it("leave out exactly the router's hooks (View in web/app.ts)", () => {
    // web/dev/hot.ts runs in the page; read both as text
    const app = fs.readFileSync(path.join(WEB, 'app.ts'), 'utf8');
    const view = /export interface View \{([\s\S]*?)\n\}/.exec(app)?.[1] || '';
    const keys = [...view.matchAll(/^\s+(\w+)\??[(:]/gm)].map((m) => m[1]).sort();
    const hot = fs.readFileSync(path.join(WEB, 'dev', 'hot.ts'), 'utf8');
    const listed = [...(/VIEW_EXPORTS = \[([^\]]*)\]/.exec(hot)?.[1] || '').matchAll(/'(\w+)'/g)].map((m) => m[1]).sort();
    expect(keys.length).toBeGreaterThan(2);
    expect(listed).toEqual(keys);
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

  it('serves a page ready to swap in place', async () => {
    const code = await (await get('/views/home.tsx')).text();
    expect(code).toContain('DashHotView');
    expect(code).toContain('validateRefreshBoundaryAndEnqueueUpdate');
    const mod = await dev.vite.environments.client.moduleGraph.getModuleByUrl('/views/home.tsx');
    expect(mod?.isSelfAccepting).toBe(true);
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
