// The page's Content-Security-Policy, and what `bun run dev` changes in the page: its code then comes from the
// Vite dev server (hot reload) instead of public/dist. Only when the server's command line has `--vite <address>`
// naming a dev server on this machine; scripts/dev.ts passes it. A command line, unlike the environment, isn't handed
// down to what the server starts, so it can't leak into another server. The desktop app ignores it, and without it
// the policy is exactly as it was.

// a dev server here: plain http on the loopback address, nothing else
const LOOPBACK = /^http:\/\/(?:127\.0\.0\.1|localhost):(\d{1,5})$/;

/** A Vite dev server's address ('http://127.0.0.1:5173'), or null when it isn't a dev server on this machine. */
export function viteOrigin(value: string | undefined): string | null {
  const v = (value || '').trim().replace(/\/+$/, '');
  const m = LOOPBACK.exec(v);
  if (!m) return null;
  const port = Number(m[1]);
  return port > 0 && port < 65536 ? v : null;
}

/** The dev server the server's command line names (`--vite <address>`), or null. Never in the desktop app: it
 *  serves the page it ships with. */
export function viteFromArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.DASH_DESKTOP) return null;
  const at = argv.indexOf('--vite');
  return at < 0 ? null : viteOrigin(argv[at + 1]);
}

/** The policy the page is served with. vite: the dev server, whose code, styles and hot-reload socket the page
 *  then needs too. */
export function pageCsp(port: number, vite: string | null = null): string {
  const dev = vite ? ` ${vite}` : '';
  return [
    "default-src 'self'",
    `script-src 'self'${dev}`,
    "style-src 'self' 'unsafe-inline'",
    `font-src 'self'${dev}`,
    `img-src 'self' data: blob: https://pbs.twimg.com https://abs.twimg.com${dev}`,
    `connect-src 'self' ws://localhost:${port} ws://127.0.0.1:${port}${vite ? ` ${vite} ${vite.replace(/^http:/, 'ws:')}` : ''}`,
    "frame-ancestors 'none'",
  ].join('; ');
}

// the bundle's script tag in public/index.html
const BUNDLE = '<script type="module" src="/dist/app.js"></script>';

/** The page with its code loaded from the dev server (web/dev/entry.ts, through scripts/vite-dev.ts) instead of
 *  the bundle. The stylesheet link stays for the first paint; the dev styles take its place once they load. */
export function devPage(html: string, vite: string): string {
  if (!html.includes(BUNDLE)) return html;
  return html.replace(BUNDLE, `<script type="module" src="${vite}/@dash/dev"></script>`);
}
