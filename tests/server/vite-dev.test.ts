// The Vite dev server behind `bun run dev`: it starts on this machine, hands the page its entry and styles, and
// hands out nothing but the page's own code (never the data folder, the server's code or the repo's files).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ENTRY,
  STYLES,
  WEB,
  changeKind,
  dashPlugin,
  entryCode,
  isViewFile,
  serverBack,
  startVite,
  stylesCode,
  viewMark,
} from '../../scripts/vite-dev.ts';
import type { DashPluginOptions } from '../../scripts/vite-dev.ts';
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
  // the hook, with just what it reads of its context; the stylesheet changes when restyle says so
  const setup = ({
    restyle = true,
    serverBack,
  }: { restyle?: boolean; serverBack?: DashPluginOptions['serverBack'] } = {}) => {
    const invalidated: object[] = [];
    const sent: unknown[] = [];
    const updates: string[] = [];
    const css = { css: async () => '', update: async (file: string) => (updates.push(file), restyle) };
    const hook = dashPlugin({ css, serverBack }).hotUpdate as unknown as (
      this: object,
      o: { file: string; modules: object[] },
    ) => Promise<object[] | undefined>;
    const run = async (file: string, styles: object | undefined, modules: object[] = []) => {
      const ctx = {
        environment: {
          name: 'client',
          logger: { info: () => {}, error: () => {} },
          hot: { send: (m: unknown) => sent.push(m) },
          moduleGraph: {
            getModuleById: (id: string) => (id === STYLES ? styles : undefined),
            invalidateModule: (m: object) => invalidated.push(m),
          },
        },
      };
      return hook.call(ctx, { file, modules });
    };
    return { run, invalidated, sent, updates };
  };
  const styles = { id: STYLES, isSelfAccepting: true };
  const core = { id: '/core.ts', isSelfAccepting: false };
  const RELOAD = { type: 'full-reload', path: '*' };

  it('swaps React component files in place, with the styles (Tailwind writes only the classes used)', async () => {
    const page = { id: '/views/home.tsx', isSelfAccepting: true };
    const { run, invalidated, sent } = setup();
    expect(await run(path.join(WEB, 'views', 'home.tsx'), styles, [page])).toEqual([page, styles]);
    expect(invalidated).toEqual([styles]);
    expect(sent).toEqual([]);
    expect(await run(path.join(WEB, 'styles', 'base.css'), styles)).toEqual([styles]);
  });

  it('leaves the styles alone when a change adds no classes', async () => {
    const page = { id: '/views/home.tsx', isSelfAccepting: true };
    const { run, invalidated } = setup({ restyle: false });
    expect(await run(path.join(WEB, 'views', 'home.tsx'), styles, [page])).toBeUndefined();
    expect(invalidated).toEqual([]);
  });

  it('reloads the page for a plain module, rather than run it a second time next to its first copy', async () => {
    const { run, sent } = setup();
    expect(await run(path.join(WEB, 'core.ts'), styles, [core])).toEqual([]);
    expect(sent).toEqual([RELOAD]);
    // one plain module among swappable ones is enough
    await run(path.join(WEB, 'x.tsx'), styles, [{ id: '/x.tsx', isSelfAccepting: true }, core]);
    expect(sent).toHaveLength(2);
  });

  it('brings the styles up to date before a reload too (the reloaded page asks for them again)', async () => {
    const { run, invalidated, sent, updates } = setup();
    await run(path.join(WEB, 'app.ts'), styles, [core]);
    expect(updates).toEqual([path.join(WEB, 'app.ts')]);
    expect(invalidated).toEqual([styles]);
    expect(sent).toEqual([RELOAD]);
  });

  it('reloads for a change in shared/ only once the restarted server is back, once for many changes', async () => {
    let back = () => {};
    const serverBack = vi.fn(() => new Promise<void>((r) => (back = r)));
    const { run, sent } = setup({ serverBack });
    const shared = { id: path.join(ROOT, 'shared', 'types.ts'), isSelfAccepting: false };
    expect(await run(path.join(ROOT, 'shared', 'types.ts'), styles, [shared])).toEqual([]);
    await run(path.join(ROOT, 'shared', 'look.ts'), styles, [shared]);
    expect(sent).toEqual([]);
    back();
    await vi.waitFor(() => expect(sent).toEqual([RELOAD]));
    expect(serverBack).toHaveBeenCalledTimes(1);
    // a change in web/ doesn't wait
    await run(path.join(WEB, 'core.ts'), styles, [core]);
    expect(sent).toHaveLength(2);
  });

  it('leaves other changes alone', async () => {
    const { run, updates } = setup();
    expect(await run(path.join(ROOT, 'server', 'index.ts'), styles)).toBeUndefined();
    expect(await run(path.join(WEB, 'icon.png'), styles)).toBeUndefined();
    // styles not loaded yet: nothing to update
    expect(await run(path.join(WEB, 'app.ts'), undefined)).toBeUndefined();
    expect(updates).toEqual([]);
  });

  it('changeKind', () => {
    expect(changeKind([])).toBe('none');
    expect(changeKind([{ id: STYLES, isSelfAccepting: true }])).toBe('none');
    expect(changeKind([{ id: '/a.tsx', isSelfAccepting: true }])).toBe('hot');
    expect(changeKind([{ id: '/a.ts' }])).toBe('reload');
  });
});

describe('serverBack', () => {
  // a clock the sleeps move on
  const clock = () => {
    let t = 0;
    return { now: () => t, sleep: async (ms: number) => void (t += ms) };
  };

  it('waits for the restart to begin, then until the server answers', async () => {
    const c = clock();
    let tries = 0;
    const get = vi.fn(async () => {
      if (++tries < 3) throw new Error('refused');
      return new Response('ok');
    });
    await serverBack('http://127.0.0.1:4800/', { ...c, get, settle: 1000, every: 250 });
    expect(get).toHaveBeenCalledTimes(3);
    expect(c.now()).toBe(1500);
  });

  it('gives up after its time is up', async () => {
    const c = clock();
    const get = vi.fn(async (): Promise<Response> => {
      throw new Error('refused');
    });
    await serverBack('http://127.0.0.1:4800/', { ...c, get, settle: 0, every: 1000, timeout: 5000 });
    expect(get).toHaveBeenCalledTimes(5);
  });
});

describe('pages in web/views/', () => {
  const PAGE = "export const { render, unmount } = reactPage(() => <Home />);\nexport const title = () => 'Home';";

  it('are the files there that export render()', () => {
    expect(isViewFile(path.join(WEB, 'views', 'home.tsx'), PAGE)).toBe(true);
    expect(isViewFile('C:\\athena\\web\\views\\tasks.tsx?t=1', 'export function render(el) {}')).toBe(true);
    expect(isViewFile(path.join(WEB, 'views', 'x.tsx'), 'export const render = () => {};')).toBe(true);
    expect(isViewFile(path.join(WEB, 'views', 'x.tsx'), 'export { render, title };')).toBe(true);
    // pieces the pages use, and files elsewhere
    expect(
      isViewFile(
        path.join(WEB, 'views', 'stationpanel.tsx'),
        'export function mountStationPanel() {}\nexport const title = 1;',
      ),
    ).toBe(false);
    for (const f of [
      path.join(WEB, 'views', 'station.ts'),
      path.join(WEB, 'app.ts'),
      path.join(WEB, 'ui', 'button.tsx'),
    ])
      expect(isViewFile(f, PAGE), f).toBe(false);
  });

  it('agree with the files in web/views/ (each .tsx there that the router opens is a page)', () => {
    const app = fs.readFileSync(path.join(WEB, 'app.ts'), 'utf8');
    for (const [, name] of app.matchAll(/from '\.\/views\/([\w-]+\.tsx)'/g)) {
      const file = path.join(WEB, 'views', name);
      expect(isViewFile(file, fs.readFileSync(file, 'utf8')), name).toBe(true);
    }
    for (const name of ['stationpanel.tsx', 'stationmenu.tsx', 'worldpanel.tsx']) {
      const file = path.join(WEB, 'views', name);
      expect(isViewFile(file, fs.readFileSync(file, 'utf8')), name).toBe(false);
    }
  });

  it('say so to the page and get one component export in development, and nothing else changes', () => {
    const transform = dashPlugin().transform as unknown as {
      handler: (this: object, code: string, id: string) => { code: string } | undefined;
    };
    const ctx = { environment: { name: 'client' } };
    const id = path.join(WEB, 'views', 'home.tsx');
    const out = transform.handler.call(ctx, PAGE, id);
    expect(out?.code).toBe(PAGE + viewMark(id));
    expect(viewMark(id)).toContain(`window.__dashHotView?.(${JSON.stringify(id)});`);
    expect(viewMark(`${id}?t=1`)).toBe(viewMark(id));
    expect(viewMark(id)).toMatch(/export function [A-Z]\w*\(\) \{ return null; \}/);
    expect(transform.handler.call(ctx, 'x', path.join(WEB, 'core.ts'))).toBeUndefined();
    expect(
      transform.handler.call(
        ctx,
        'export function mountStationPanel() {}',
        path.join(WEB, 'views', 'stationpanel.tsx'),
      ),
    ).toBeUndefined();
  });

  it("leave out exactly the router's hooks (View in web/app.ts)", () => {
    // web/dev/hot.ts runs in the page; read both as text
    const app = fs.readFileSync(path.join(WEB, 'app.ts'), 'utf8');
    const view = /export interface View \{([\s\S]*?)\n\}/.exec(app)?.[1] || '';
    const keys = [...view.matchAll(/^\s+(\w+)\??[(:]/gm)].map((m) => m[1]).sort();
    const hot = fs.readFileSync(path.join(WEB, 'dev', 'hot.ts'), 'utf8');
    const listed = [...(/VIEW_EXPORTS = \[([^\]]*)\]/.exec(hot)?.[1] || '').matchAll(/'(\w+)'/g)]
      .map((m) => m[1])
      .sort();
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
    expect(code).toContain('__dashHotView');
    expect(code).toContain('validateRefreshBoundaryAndEnqueueUpdate');
    const mod = await dev.vite.environments.client.moduleGraph.getModuleByUrl('/views/home.tsx');
    expect(mod?.isSelfAccepting).toBe(true);
  }, 60_000);

  it('serves the page code and shared/', async () => {
    expect((await get('/core.ts')).status).toBe(200);
    expect(
      (
        await get(
          `/@fs${path
            .join(ROOT, 'shared', 'types.ts')
            .replace(/\\/g, '/')
            .replace(/^(?=[A-Za-z]:)/, '/')}`,
        )
      ).status,
    ).toBe(200);
  }, 60_000);

  it('refuses everything else in the repo', async () => {
    const fsUrl = (...p: string[]) =>
      `/@fs${path
        .join(ROOT, ...p)
        .replace(/\\/g, '/')
        .replace(/^(?=[A-Za-z]:)/, '/')}`;
    for (const p of [
      fsUrl('package.json'),
      fsUrl('server', 'index.ts'),
      fsUrl('tests', 'server', 'setup.ts'),
      '/../package.json',
      '/%2e%2e/package.json',
    ]) {
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
