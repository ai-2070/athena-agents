// Light or dark: Settings > Appearance > Colour scheme picks one, or "System" to follow the computer. The stylesheet
// swaps its own tokens from <html data-theme> (base.css); this is also for what CSS can't reach: the accent's two
// tones (look.ts), the Station's map and the terminal.
import type { ThemeChoice } from '../shared/types.ts';

const media = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;

// <html data-theme="dark"> or "light" (base.css) forces one whatever the system says.
const forced = (): string | undefined => document.documentElement.dataset.theme;

/** Light, dark, or the computer's own setting: writes it onto <html> so base.css and everything watching follow. */
export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  // "system" leaves the attribute off, the way the system's own setting works
  if (choice === 'light' || choice === 'dark') root.dataset.theme = choice;
  else root.removeAttribute('data-theme');
}

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
