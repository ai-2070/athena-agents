// The Vite dev server behind `bun run dev`: it hands the page its code module by module and swaps edited
// React components in place (hot reload). The dashboard's own server still serves the page, the API and
// public/dist; started with `--vite <address>` it loads the code from here instead of the bundle (server/devpage.ts).
// Production builds don't use this: scripts/build-web.ts bundles the page with Bun.
//
// What it may hand out is kept to the page's own code: web/, shared/ and node_modules. The data folder,
// secrets and the rest of the repo stay out of reach of anything else on this machine that asks it.
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import react from '@vitejs/plugin-react';
import { createServer } from 'vite';
import type { Plugin, ViteDevServer } from 'vite';
import { incrementalCss } from './build-css.ts';
import type { CssBuilder } from './build-css.ts';
import { buildFonts } from './build-fonts.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
export const WEB = path.join(ROOT, 'web');
const SHARED = path.join(ROOT, 'shared');

/** The page's first module (server/devpage.ts points the page at it). */
export const ENTRY = '/@dash/dev';
/** The page's styles, as a module that puts them in a <style> and swaps them on a change. */
export const STYLES = '/@dash/styles';

/** The entry: Vite's hot-reload client and React's refresh hooks first, then the app. */
export function entryCode(): string {
  return [
    `import '/@vite/client';`,
    `import '@vitejs/plugin-react/preamble';`,
    `import { installHotRules } from '/dev/hot.ts';`,
    `import '${STYLES}';`,
    `installHotRules();`,
    // OpenUI shows its own inspector in development; not in the dashboard. Set before the app loads it.
    `globalThis[Symbol.for('openui.devtools.autoMount')] = true;`,
    `import('/app.ts');`,
  ].join('\n');
}

/** The styles module for a stylesheet: one <style> it keeps up to date, in place of the bundle's link. */
export function stylesCode(css: string): string {
  return [
    `const css = ${JSON.stringify(css)};`,
    `let el = document.getElementById('dash-dev-styles');`,
    `if (!el) { el = document.createElement('style'); el.id = 'dash-dev-styles'; document.head.append(el); }`,
    `el.textContent = css;`,
    // (the bundle's stylesheet drew the first paint; from here on these styles are the current ones)
    `document.querySelector('link[rel="stylesheet"][href="/dist/app.css"]')?.remove();`,
    `if (import.meta.hot) import.meta.hot.accept();`,
  ].join('\n');
}

const inWeb = (file: string): boolean => {
  const rel = path.relative(WEB, file);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
};

// Tailwind writes only the classes the code uses, so any change in web/ can change the stylesheet
const touchesStyles = (file: string): boolean => inWeb(file) && /\.(tsx?|css)$/.test(file);

/** A page in web/views/: a .tsx file there that exports the router's render() (other files in the folder are
 *  pieces the pages use). It exports the router's hooks next to its components: web/dev/hot.ts. */
export function isViewFile(id: string, code: string): boolean {
  if (!/\/web\/views\/[^/]+\.tsx$/.test(id.replace(/\\/g, '/').split('?')[0])) return false;
  return /^export\s+(?:(?:async\s+)?function\s+render\b|(?:const|let)\s+(?:render\b|\{[^}]*\brender\b))|^export\s*\{[^}]*\brender\b/m.test(code);
}

/** What a page gets in development: it tells the page's hot-reload rules it is a page (so React's check leaves out
 *  its router hooks: web/dev/hot.ts), and gets one component export, since React's hot swap gives up on a file with
 *  none left (a page's own components aren't exported). id: the file, as React's refresh code names it. */
export function viewMark(id: string): string {
  return [
    '',
    '// (bun run dev: lets hot reload swap this page in place, scripts/vite-dev.ts)',
    `window.__dashHotView?.(${JSON.stringify(id.split('?')[0])});`,
    'export function DashHotView() { return null; }',
    '',
  ].join('\n');
}

/** What to do with a change to these modules: swap them in place ('hot': each one swaps itself, React components)
 *  or reload the page. A plain module (state, sockets, listeners, three.js) run a second time next to its first
 *  copy would leave the page half old, half new, so it reloads, even when only hot-swappable files import it. */
export function changeKind(modules: readonly { id: string | null; isSelfAccepting?: boolean }[]): 'hot' | 'reload' | 'none' {
  const code = modules.filter((m) => m.id !== STYLES);
  if (!code.length) return 'none';
  return code.every((m) => m.isSelfAccepting) ? 'hot' : 'reload';
}

export interface DashPluginOptions {
  /** The stylesheet (the full build once, then only what a change adds). */
  css?: CssBuilder;
  /** Resolves once the dashboard's server answers again. A change outside web/ (shared/) restarts the server too
   *  (`bun --watch`): the page reloads after that, not while the server is down. */
  serverBack?: () => Promise<void>;
}

/** The dashboard's own pieces: the entry, the styles, and when a change reloads the page. */
export function dashPlugin({ css = incrementalCss({ minify: false }), serverBack }: DashPluginOptions = {}): Plugin {
  // the font rules don't change while it runs (the files are the last build's, in public/dist/fonts)
  let fonts: string | null = null;
  // a reload waiting for the server: one is enough for any number of changes meanwhile
  let waiting: Promise<void> | null = null;
  return {
    name: 'dash-dev',
    resolveId(id) {
      if (id === ENTRY || id === STYLES) return id;
    },
    async load(id) {
      if (id === ENTRY) return entryCode();
      if (id === STYLES) {
        fonts ??= buildFonts(null);
        return stylesCode(`${await css.css()}\n${fonts}`);
      }
    },
    configureServer(server) {
      // React's hot swap gave up on a file ("Could not Fast Refresh": it exports more than components): reload
      // rather than let the change spread to the files that import it
      server.environments.client.hot.on('vite:invalidate', (data: unknown) => {
        const path = data && typeof data === 'object' && 'path' in data ? String(data.path) : '';
        server.config.logger.info(`page reload ${path} (not only React components)`, { timestamp: true });
        server.environments.client.hot.send({ type: 'full-reload', path: '*' });
      });
    },
    transform: {
      order: 'pre',
      handler(code, id) {
        if (this.environment.name === 'client' && isViewFile(id, code)) return { code: code + viewMark(id), map: null };
      },
    },
    async hotUpdate({ file, modules }) {
      const env = this.environment;
      if (env.name !== 'client') return;
      // The styles first, for a reload as much as for a swap: the reloaded page asks for them again
      const styles = env.moduleGraph.getModuleById(STYLES);
      const restyled = !!styles && touchesStyles(file) && (await css.update(file).catch((e: unknown) => (env.logger.error(`styles: ${e instanceof Error ? e.message : String(e)}`), false)));
      if (styles && restyled) env.moduleGraph.invalidateModule(styles);
      if (changeKind(modules) === 'reload') {
        const reload = () => env.hot.send({ type: 'full-reload', path: '*' });
        if (serverBack && !inWeb(file)) {
          env.logger.info(`page reload ${path.relative(path.dirname(WEB), file)} once the server is back (it restarts too)`, { timestamp: true });
          waiting ??= serverBack().finally(() => {
            waiting = null;
            reload();
          });
        } else {
          env.logger.info(`page reload ${path.relative(WEB, file)} (not a React component file)`, { timestamp: true });
          reload();
        }
        return [];
      }
      if (!styles || !restyled) return;
      return [...modules.filter((m) => m !== styles), styles];
    },
  };
}

/** Waits for the dashboard's server to answer at url after a change that restarts it: a moment for the restart to
 *  begin (`bun --watch` stops it at once), then until it answers, or gives up after timeout. */
export async function serverBack(
  url: string,
  { settle = 1000, every = 250, timeout = 30_000, get = (u: string) => fetch(u, { signal: AbortSignal.timeout(2000) }), sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)), now = () => Date.now() }: { settle?: number; every?: number; timeout?: number; get?: (url: string) => Promise<Response>; sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<void> {
  await sleep(settle);
  const end = now() + timeout;
  while (now() < end) {
    try {
      const res = await get(url);
      await res.body?.cancel();
      return;
    } catch {
      await sleep(every);
    }
  }
}

export interface DevServer {
  /** Its address, like 'http://127.0.0.1:5173'. */
  origin: string;
  vite: ViteDevServer;
  close: () => Promise<void>;
}

export interface DevServerOptions {
  /** 0: any free port. */
  port?: number;
  logLevel?: 'info' | 'warn' | 'error' | 'silent';
  /** Where Vite keeps its prepared dependencies. Two dev servers must not share one (a test's would empty
   *  the folder `bun run dev` is using). */
  cacheDir?: string;
  /** The dashboard's address, like 'http://127.0.0.1:4800': a change in shared/ reloads the page once it is back. */
  dashboard?: string;
}

/** Starts the dev server on this machine only. */
export async function startVite({ port = 5173, logLevel = 'info', cacheDir = path.join(ROOT, 'node_modules', '.vite'), dashboard }: DevServerOptions = {}): Promise<DevServer> {
  fs.mkdirSync(cacheDir, { recursive: true });
  const vite = await createServer({
    configFile: false,
    root: WEB,
    base: '/',
    mode: 'development',
    appType: 'custom',
    publicDir: false,
    cacheDir,
    clearScreen: false,
    logLevel,
    plugins: [react(), dashPlugin({ serverBack: dashboard ? () => serverBack(dashboard) : undefined })],
    optimizeDeps: { entries: ['app.ts'] },
    server: {
      host: '127.0.0.1',
      port,
      strictPort: false,
      fs: { strict: true, allow: [WEB, SHARED, path.join(ROOT, 'node_modules')] },
    },
  });
  await vite.listen();
  const address = vite.httpServer?.address() as AddressInfo | null;
  if (!address || typeof address !== 'object') throw new Error('The dev server did not start.');
  return { origin: `http://127.0.0.1:${address.port}`, vite, close: () => vite.close() };
}
