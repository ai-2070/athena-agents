// Opening the Brain chat from the keyboard: Ctrl+K (⌘K on a Mac) anywhere, and Space on the Station
// (the main screen) when you are not typing or on a button.

/** A Mac (or iPad): shortcuts read ⌘ there. */
export function isMac(): boolean {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return /mac|iphone|ipad|ipod/i.test(nav.userAgentData?.platform || nav.platform || nav.userAgent || '');
}

/** What the "Ask the Brain" button shows: Space on the Station, else Ctrl K (⌘ K on a Mac). */
export const brainKeyLabel = (onStation: boolean, mac = isMac()): string => (onStation ? 'Space' : mac ? '⌘ K' : 'Ctrl K');

/** The button's tooltip: every way to open the Brain chat. */
export const brainKeyTitle = (mac = isMac()): string => `Ask the Brain (${mac ? '⌘K' : 'Ctrl+K'}, or Space on the Station)`;

// Where Space already means something: typing, or pressing a button, link or control.
const TAKES_SPACE = 'input, textarea, select, button, a[href], summary, [contenteditable]:not([contenteditable="false"]), [role="button"], [role="textbox"], [role="checkbox"], [role="switch"]';

/** What a key press does to the Brain chat: toggle it (Ctrl+K / ⌘K), open it (Space on the Station), or nothing. */
export function brainShortcut(e: KeyboardEvent, { open, onStation }: { open: boolean; onStation: boolean }): 'toggle' | 'open' | null {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') return 'toggle';
  if (e.key !== ' ' || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.repeat || e.isComposing || e.defaultPrevented) return null;
  if (open || !onStation) return null;
  if ((e.target as Element | null)?.closest?.(TAKES_SPACE)) return null;
  // a dialog or menu is open: Space belongs to it
  if (document.querySelector('.modal-back, .model-menu, .proj-menu')) return null;
  return 'open';
}

/** What Esc does once nothing else has taken it (see backdropEscape). */
export type BackdropEscape = 'phone-menu' | 'close-sidebar' | 'open-sidebar' | 'station' | null;

/**
 * What Esc does when nothing else wanted it — the Brain chat, a dialog, a menu and a Station panel all
 * take it first, and they say so. Closer things come first here too: the phone's menu drawer, the Station's
 * wide sidebar, then (on any other page) back to the Station. On the Station itself there is nowhere to go
 * back to, so Esc opens that wide sidebar. An open dialog, dropdown or drawer keeps its own Esc (null): it
 * has had no Esc of its own until now, and going somewhere behind it would be a surprise.
 */
export function backdropEscape(doc: Document): BackdropEscape {
  const body = doc.body.classList;
  if (body.contains('nav-open')) return 'phone-menu';
  if (body.contains('nav-wide')) return 'close-sidebar';
  if (doc.querySelector('.modal-back, .st-menu, #drawer:not(.hidden)')) return null;
  return body.contains('station-mode') ? 'open-sidebar' : 'station';
}

/** What a chat window key does (see chatWindowShortcut). */
export type ChatWindowAction = 'minimize' | 'restore' | 'left' | 'right' | 'separate' | 'combine';

// Ctrl+Alt (Ctrl+⌥ on a Mac) + an arrow arranges the windows, as Rectangle does on a Mac.
const ARRANGE: Record<string, ChatWindowAction> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'separate', ArrowDown: 'combine' };

/**
 * The chat windows from the keyboard. ⌘↓ minimizes the window on top, ⌘↑ brings back the one
 * minimized last (Ctrl instead of ⌘ on Windows and Linux). Ctrl+Alt (Ctrl+⌥) with ← / → snaps the
 * window on top to that half of the screen, ↑ gives every tab a window of its own side by side, and
 * ↓ puts all the windows back into one. Holding a key down doesn't repeat it.
 */
export function chatWindowShortcut(e: KeyboardEvent, mac = isMac()): ChatWindowAction | null {
  if (!ARRANGE[e.key] || e.shiftKey || e.repeat || e.isComposing) return null;
  if (e.ctrlKey && e.altKey) return e.metaKey ? null : ARRANGE[e.key];
  const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (!mod || e.altKey) return null;
  return e.key === 'ArrowDown' ? 'minimize' : e.key === 'ArrowUp' ? 'restore' : null;
}

/** The chat window keys as the tooltips and the Layout menu show them. */
export function chatWindowKeys(mac = isMac()): Record<ChatWindowAction, string> {
  const arrange = mac ? '⌃⌥' : 'Ctrl+Alt+';
  return {
    minimize: mac ? '⌘↓' : 'Ctrl+↓',
    restore: mac ? '⌘↑' : 'Ctrl+↑',
    left: `${arrange}←`,
    right: `${arrange}→`,
    separate: `${arrange}↑`,
    combine: `${arrange}↓`,
  };
}
