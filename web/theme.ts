// Light or dark: the page follows the system. The stylesheet does it by itself (base.css); this is for what CSS
// can't reach: the accent's two tones (look.ts), the Station's map and the terminal.
const media = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;

// <html data-theme="dark"> or "light" (base.css) forces one whatever the system says; nothing sets it but a person checking both.
const forced = (): string | undefined => document.documentElement.dataset.theme;

/** True while the page is dark: the system is set to dark. */
export const isDark = (): boolean => (forced() === 'dark' ? true : forced() === 'light' ? false : !!media?.matches);

/** Calls fn whenever the page switches between light and dark; returns how to stop. */
export function onThemeChange(fn: (dark: boolean) => void): () => void {
  const handler = (): void => fn(isDark());
  media?.addEventListener?.('change', handler);
  const watch = typeof MutationObserver === 'function' ? new MutationObserver(handler) : null;
  watch?.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => {
    media?.removeEventListener?.('change', handler);
    watch?.disconnect();
  };
}

/** One colour of the page's palette as the browser resolved it now (--color-ink, say), for canvases that can't use var(). */
export function themeColor(name: string, fallback = '#000000'): string {
  return getComputedStyle(document.documentElement).getPropertyValue(`--color-${name}`).trim() || fallback;
}
