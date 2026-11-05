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
  interface ImportMeta {
    // Vite's, in `bun run dev` only (written out as import.meta.hot: Vite looks for those words)
    readonly hot?: HotEvents;
  }
}

/** The part of Vite's import.meta.hot used here. */
export interface HotEvents {
  on(event: string, cb: (payload: unknown) => void): void;
}

/** How soon after an update an uncaught error counts as the update's doing. */
export const BROKE_WITHIN_MS = 3000;

/** Reloads the page when it breaks right after a hot update: an uncaught error or a rejected promise nobody handled
 *  (a swapped module half run, an effect throwing outside any crash guard). A fresh load starts clean. A crash a
 *  crash guard caught (web/ui/root.tsx) isn't uncaught: it stays on screen, and fixing the code draws it again. Only
 *  armed by an update, so a page that breaks while loading isn't reloaded over and over. */
export function watchUpdates(hot: HotEvents, { win = window, reload = () => win.location.reload(), within = BROKE_WITHIN_MS, now = () => Date.now() }: { win?: Window; reload?: () => void; within?: number; now?: () => number } = {}): () => void {
  let updated = -Infinity;
  let reloading = false;
  hot.on('vite:afterUpdate', () => void (updated = now()));
  const broke = (what: unknown) => {
    if (reloading || now() - updated > within) return;
    reloading = true;
    console.warn('[hot reload] the page broke right after an update; reloading it.', what);
    reload();
  };
  const onError = (e: ErrorEvent) => broke(e.error ?? e.message);
  const onRejection = (e: PromiseRejectionEvent) => broke(e.reason);
  win.addEventListener('error', onError);
  win.addEventListener('unhandledrejection', onRejection);
  return () => {
    win.removeEventListener('error', onError);
    win.removeEventListener('unhandledrejection', onRejection);
  };
}

/** Sets the rules up (before the app's modules load). */
export function installHotRules(win: Window = window, hot: HotEvents | undefined = import.meta.hot): void {
  win.__getReactRefreshIgnoredExports = ({ id }) => ignoredExports(id);
  if (hot) watchUpdates(hot, { win });
}
