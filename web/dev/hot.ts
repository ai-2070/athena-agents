// Hot reload's rules on the page's side (`bun run dev` only: the dev entry loads this, the bundle never does).
// A page in web/views/ exports its components next to what the router calls (render, unmount, title…), which
// React's hot swap would otherwise refuse: it only swaps files that export nothing but components.

/** What the router reads from a page module (View in web/app.ts). */
export const VIEW_EXPORTS = ['render', 'unmount', 'onEvent', 'title', 'flush', 'station'] as const;

/** The exports React's hot swap may leave out of its check for a file (the full path Vite gives it). A page's
 *  router hooks keep their first version until the next reload; its components are swapped in place. */
export function ignoredExports(id: string): string[] {
  return /\/web\/views\/[^/]+\.tsx$/.test(id.replace(/\\/g, '/').split('?')[0]) ? [...VIEW_EXPORTS] : [];
}

declare global {
  interface Window {
    // read by @vitejs/plugin-react's refresh runtime
    __getReactRefreshIgnoredExports?: (o: { id: string }) => string[];
  }
}

/** Sets the rules up (before the app's modules load). */
export function installHotRules(win: Window = window): void {
  win.__getReactRefreshIgnoredExports = ({ id }) => ignoredExports(id);
}
