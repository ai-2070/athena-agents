// How the dashboard looks: UI scale, accent colour, animations, chat font, Station quality. Saved in settings.look and
// remembered in this browser so the page opens at the right size straight away.
import type { LookSetting } from '../shared/types.ts';
import { chatFont } from '../shared/look.ts';
import { applyTheme, isDark, onThemeChange } from './theme.ts';
export { CHAT_FONTS, chatFont, STATION_QUALITY, stationLevel } from '../shared/look.ts';
export type { ChatFont } from '../shared/look.ts';

/** One tone of an accent: the colour, its hover, a quieter one for borders and small text, and the text on top of it. */
export interface AccentTone {
  c: string;
  hover: string;
  dim: string;
  on: string;
}
/** An accent has a tone for each scheme: dark text on a light colour on dark pages, white on a deeper one on white. */
export interface Accent {
  id: string;
  label: string;
  light: AccentTone;
  dark: AccentTone;
}
export const ACCENTS: Accent[] = [
  {
    id: 'aegean',
    label: 'Aegean',
    light: { c: '#18688e', hover: '#125574', dim: '#347a9a', on: '#ffffff' },
    dark: { c: '#7cbad5', hover: '#9dcfe3', dim: '#4289a9', on: '#061923' },
  },
  {
    id: 'olive',
    label: 'Olive',
    light: { c: '#5a7d2b', hover: '#496624', dim: '#86a45a', on: '#ffffff' },
    dark: { c: '#a3c45d', hover: '#b8d37b', dim: '#738f3f', on: '#10170a' },
  },
  {
    id: 'gold',
    label: 'Gold',
    light: { c: '#a87500', hover: '#956700', dim: '#cba041', on: '#1a1204' },
    dark: { c: '#e8b95f', hover: '#f0cb84', dim: '#a9833b', on: '#1a1204' },
  },
  {
    id: 'terracotta',
    label: 'Terracotta',
    light: { c: '#c0502f', hover: '#a7421f', dim: '#d98369', on: '#ffffff' },
    dark: { c: '#f19272', hover: '#f5ab8f', dim: '#b2674d', on: '#1c0b05' },
  },
  {
    id: 'amethyst',
    label: 'Amethyst',
    light: { c: '#7c4dcc', hover: '#6a3ab8', dim: '#a283dd', on: '#ffffff' },
    dark: { c: '#b69cff', hover: '#cbb8ff', dim: '#7f69c2', on: '#120c24' },
  },
  {
    id: 'slate',
    label: 'Slate',
    light: { c: '#33343c', hover: '#1f2026', dim: '#6e6f7a', on: '#ffffff' },
    dark: { c: '#d5d7de', hover: '#ffffff', dim: '#8a8c97', on: '#111216' },
  },
];
// Settings saved before the redesign named their accent after the old colours: they keep their closest hue
const OLD_ACCENTS: Record<string, string> = {
  lime: 'aegean',
  ice: 'aegean',
  amber: 'gold',
  rose: 'terracotta',
  violet: 'amethyst',
  mint: 'olive',
};
/** The accent for a saved id (an old id counts as its closest new one; anything else is the default). */
export const accentFor = (id: string | undefined): Accent =>
  ACCENTS.find((x) => x.id === (OLD_ACCENTS[id ?? ''] ?? id)) || ACCENTS[0];
/** The accent's tone for light or dark pages. */
export const accentTone = (a: Accent, dark = isDark()): AccentTone => (dark ? a.dark : a.light);
export const DEFAULT_LOOK: LookSetting = {
  theme: 'system',
  scale: 100,
  accent: 'aegean',
  motion: 'full',
  chatFont: 'sans',
  station: 'balanced',
  sidebar: 'status',
  stationLook: 'classic',
  worldQuality: 'medium',
};
let current: LookSetting = DEFAULT_LOOK;
/** The look in use now (the Station reads its quality from here every frame). */
export const currentLook = (): LookSetting => current;
const KEY = 'dash-look';

/** True in the desktop app on WebKit (macOS, Linux): the window applies the UI scale, the way the browser's own zoom
 *  does, because WebKit places popups wrongly under CSS zoom. The app says so before the page's scripts run. */
export const windowZooms = (): boolean => (window as { __athenaPageZoom?: unknown }).__athenaPageZoom === true;

// With a UI scale, mouse and box positions are in screen pixels but CSS pixels are scaled:
// divide by this when placing a popup at the mouse or next to a button.
export const uiZoom = (): number => parseFloat(document.documentElement.style.zoom) || 1;

// The four accent tokens for the scheme the page is in now (inline, so they beat the stylesheet's own).
function paintAccent(id: string | undefined): void {
  const t = accentTone(accentFor(id));
  const root = document.documentElement;
  root.style.setProperty('--color-accent', t.c);
  root.style.setProperty('--color-accent-hover', t.hover);
  root.style.setProperty('--color-accent-dim', t.dim);
  root.style.setProperty('--color-on-accent', t.on);
}
// the system switches between light and dark: the accent takes the other tone
onThemeChange(() => paintAccent(current.accent));

export function applyLook(look: Partial<LookSetting> = {}): LookSetting {
  const l: LookSetting = { ...DEFAULT_LOOK, ...look };
  current = l;
  applyTheme(l.theme);
  const root = document.documentElement;
  const scale = Math.max(70, Math.min(160, Number(l.scale) || 100));
  // the desktop app on macOS and Linux zooms the whole page itself (src-tauri/src/look.rs)
  root.style.zoom = scale === 100 || windowZooms() ? '' : String(scale / 100);
  // h-window and friends divide by it (--spacing-window in web/styles/app.css)
  if (root.style.zoom) root.style.setProperty('--ui-zoom', root.style.zoom);
  else root.style.removeProperty('--ui-zoom');
  paintAccent(l.accent);
  root.classList.toggle('reduce-motion', l.motion === 'reduced');
  const font = chatFont(l.chatFont);
  // the default is the stylesheet's own --font-chat
  if (font.id === DEFAULT_LOOK.chatFont) root.style.removeProperty('--font-chat');
  else root.style.setProperty('--font-chat', font.stack);
  try {
    localStorage.setItem(KEY, JSON.stringify(l));
  } catch {
    /* private window */
  }
  // the Station canvas sizes itself from the window
  window.dispatchEvent(new Event('resize'));
  return l;
}

// Before the first paint: what this browser used last time.
export function applySavedLook(): void {
  try {
    const l: Partial<LookSetting> | null = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (l) applyLook(l);
  } catch {
    /* nothing saved */
  }
}
