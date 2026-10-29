// Settings > Look choices both sides use: the chat fonts (here so the build's font test can check they all ship)
// how hard the Station's map works, and how strong a project's background picture and map dots are.
import type { StationQuality } from './types.ts';

/** A font for chat messages; like: whose look it matches. They all come with the app (scripts/build-fonts.ts)
 *  or are on the computer already. */
export interface ChatFont {
  id: string;
  label: string;
  like: string;
  stack: string;
}
export const CHAT_FONTS: ChatFont[] = [
  { id: 'sans', label: 'Inter', like: 'The same font as the rest of the page (the default)', stack: "'Inter', 'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif" },
  { id: 'serif', label: 'Merriweather', like: 'A book-like serif', stack: "'Merriweather', Georgia, 'Times New Roman', serif" },
  { id: 'mono', label: 'JetBrains Mono', like: 'Like Claude Code in a terminal', stack: "'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace" },
  { id: 'system', label: 'System font', like: 'Like ChatGPT: your computer’s own font (Segoe UI on Windows, San Francisco on a Mac)', stack: "ui-sans-serif, -apple-system, system-ui, 'Segoe UI', Helvetica, Arial, sans-serif" },
  { id: 'google', label: 'Google Sans', like: 'Like Gemini and Google Search', stack: "'Google Sans', 'Segoe UI', system-ui, sans-serif" },
  { id: 'roboto', label: 'Roboto', like: 'Like Android', stack: "'Roboto', 'Segoe UI', system-ui, sans-serif" },
  // San Francisco can only be used on Apple devices; Inter is the closest free match
  { id: 'apple', label: 'San Francisco', like: 'Like iPhone and Mac (Inter, a close match, on Windows)', stack: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Inter', 'Segoe UI', sans-serif" },
];
export const chatFont = (id: string | undefined): ChatFont => CHAT_FONTS.find((f) => f.id === id) || CHAT_FONTS[0];

/** How the Station's map is drawn. fps: frames a second while you move around it (null: as fast as the
 *  screen shows), when nothing moves, and when the window isn't in front; pixelRatio: the most pixels drawn
 *  per screen pixel (sharpness on high-DPI screens); screenPx: how wide a desk's screen must look before its
 *  animation is drawn (every redraw sends a new picture to the graphics card). */
export interface StationLevel {
  id: StationQuality;
  label: string;
  hint: string;
  fps: { moving: number | null; still: number; away: number };
  pixelRatio: number;
  screenPx: number;
}
export const STATION_QUALITY: StationLevel[] = [
  { id: 'smooth', label: 'Smooth', hint: 'As many frames as your screen shows and full sharpness. Uses the most power.', fps: { moving: null, still: 60, away: 30 }, pixelRatio: 2, screenPx: 32 },
  { id: 'balanced', label: 'Balanced', hint: '60 frames a second while you move around, 30 when nothing moves, fewer when the window is in the back.', fps: { moving: 60, still: 30, away: 15 }, pixelRatio: 1.5, screenPx: 40 },
  { id: 'saver', label: 'Battery saver', hint: '30 frames a second at most and a little softer. For laptops on battery and older PCs, and many agents.', fps: { moving: 30, still: 20, away: 8 }, pixelRatio: 1, screenPx: 110 },
];
export const stationLevel = (id: string | undefined): StationLevel => STATION_QUALITY.find((q) => q.id === id) || STATION_QUALITY[1];

/** How strong the project's background picture is (percent) when it hasn't picked one: dimmed in the classic
 *  look so the map's lines and names stay easy to read, full in the voxel look where it takes the sky's place. */
export const BACKGROUND_OPACITY = { classic: 50, world: 100 } as const;
/** The classic map's floor dots, in percent, when the project hasn't picked how strong they are. */
export const MAP_DOTS_OPACITY = 100;

/** A percent from 0 to 100 (whole), or null for anything that isn't a number. */
export function toPercent(v: unknown): number | null {
  const n = typeof v === 'string' && v.trim() ? Number(v.trim().replace(/%$/, '')) : v;
  return typeof n === 'number' && Number.isFinite(n) ? Math.round(Math.min(100, Math.max(0, n))) : null;
}

type StationOpacity = { backgroundOpacity?: number | null; mapDotsOpacity?: number | null };
/** The project's picture opacity in this look (its own, or the look's default). */
export const backgroundOpacity = (p: StationOpacity | null | undefined, look: 'classic' | 'world'): number => toPercent(p?.backgroundOpacity) ?? BACKGROUND_OPACITY[look];
/** The project's map dots opacity (its own, or the default). */
export const mapDotsOpacity = (p: StationOpacity | null | undefined): number => toPercent(p?.mapDotsOpacity) ?? MAP_DOTS_OPACITY;

/** The Station opacities a saved project had (only valid ones), to put back with updateProject. */
export function savedOpacity(saved: { backgroundOpacity?: unknown; mapDotsOpacity?: unknown } | null | undefined): { backgroundOpacity?: number; mapDotsOpacity?: number } {
  const out: { backgroundOpacity?: number; mapDotsOpacity?: number } = {};
  for (const key of ['backgroundOpacity', 'mapDotsOpacity'] as const) {
    const pct = toPercent(saved?.[key]);
    if (pct !== null) out[key] = pct;
  }
  return out;
}
