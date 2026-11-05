// The Vite dev server behind `bun run dev`: it hands the page its code module by module and swaps edited
// React components in place (hot reload). The dashboard's own server still serves the page, the API and
// public/dist; with DASH_VITE set it loads the code from here instead of the bundle (server/devpage.ts).
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
import { buildCss } from './build-css.ts';
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
    `import '${STYLES}';`,
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

// Tailwind writes only the classes the code uses, so any change in web/ can change the stylesheet
const touchesStyles = (file: string): boolean => {
  const rel = path.relative(WEB, file);
  return !rel.startsWith('..') && !path.isAbsolute(rel) && /\.(tsx?|css)$/.test(rel);
};

/** The dashboard's own pieces: the entry and the styles. */
export function dashPlugin(): Plugin {
  // the font rules don't change while it runs (the files are the last build's, in public/dist/fonts)
  let fonts: string | null = null;
  return {
    name: 'dash-dev',
    resolveId(id) {
      if (id === ENTRY || id === STYLES) return id;
    },
    async load(id) {
      if (id === ENTRY) return entryCode();
      if (id === STYLES) {
        fonts ??= buildFonts(null);
        return stylesCode(`${await buildCss({ minify: false })}\n${fonts}`);
      }
    },
    hotUpdate({ file, modules }) {
      if (this.environment.name !== 'client' || !touchesStyles(file)) return;
      const styles = this.environment.moduleGraph.getModuleById(STYLES);
      if (!styles) return;
      this.environment.moduleGraph.invalidateModule(styles);
      return [...modules.filter((m) => m !== styles), styles];
    },
  };
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
}

/** Starts the dev server on this machine only. */
export async function startVite({ port = 5173, logLevel = 'info', cacheDir = path.join(ROOT, 'node_modules', '.vite') }: DevServerOptions = {}): Promise<DevServer> {
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
    plugins: [react(), dashPlugin()],
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
