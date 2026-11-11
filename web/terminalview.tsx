// A live terminal drawn with xterm, talking to the server over a WebSocket (/ws/term): the Terminals page and the
// Overview's panes show the same thing.
import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import type { ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { openSocket } from './client/connection.ts';
import { isDark, onThemeChange, themeColor } from './theme.ts';

// xterm paints on a canvas and can't use var(): the page's colors come from theme.ts, the 16 ANSI colors are
// picked here for each side (every one reads on its background: 4:1 or better, most 5:1)
const ANSI_LIGHT = {
  black: '#3b3b46',
  red: '#c4283a',
  green: '#16794a',
  yellow: '#8f5e00',
  blue: '#2a55c9',
  magenta: '#9235ad',
  cyan: '#0c748a',
  white: '#6b6b78',
  brightBlack: '#5b5b66',
  brightRed: '#d3303f',
  brightGreen: '#17804b',
  brightYellow: '#a3680a',
  brightBlue: '#3f6ae0',
  brightMagenta: '#a84dc4',
  brightCyan: '#0f7f98',
  brightWhite: '#74747f',
};
const ANSI_DARK = {
  black: '#636573',
  red: '#ff7b7b',
  green: '#4cc38a',
  yellow: '#f0b04a',
  blue: '#7da2ff',
  magenta: '#d29bf0',
  cyan: '#7cc4e8',
  white: '#c9cbd3',
  brightBlack: '#8b8d99',
  brightRed: '#ff9a9a',
  brightGreen: '#74dba5',
  brightYellow: '#f7c873',
  brightBlue: '#9db9ff',
  brightMagenta: '#e0b4f6',
  brightCyan: '#a3d8f1',
  brightWhite: '#eceef1',
};

/** #rrggbb as #rrggbbaa (a hex colour that isn't six digits is kept as it is). */
const withAlpha = (hex: string, alpha: number): string =>
  /^#[0-9a-f]{6}$/i.test(hex)
    ? `${hex}${Math.round(alpha * 255)
        .toString(16)
        .padStart(2, '0')}`
    : hex;

/** The terminal's colors for the page as it is now: the page's own background and ink, the picked accent for
 *  the cursor and the selection. */
export function terminalTheme(dark: boolean = isDark()): ITheme {
  const accent = themeColor('accent', dark ? '#7cbad5' : '#18688e');
  const background = themeColor('bg', dark ? '#0e0f11' : '#ffffff');
  return {
    ...(dark ? ANSI_DARK : ANSI_LIGHT),
    background,
    foreground: themeColor('ink', dark ? '#eceef1' : '#1a1a1f'),
    cursor: accent,
    cursorAccent: background,
    selectionBackground: withAlpha(accent, dark ? 0.35 : 0.22),
  };
}

/** One live terminal: xterm in the page, its keystrokes to the server and its output back. */
export function XTerm({ id, className = 'flex-1 min-h-0 px-4 py-3 bg-bg' }: { id: string; className?: string }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = host.current!;
    const term = new Terminal({
      fontFamily: "'JetBrains Mono', Consolas, monospace",
      fontSize: 13,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 10000,
      theme: terminalTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    const ws = openSocket('/ws/term', { id });
    const sendSize = () => {
      try {
        fit.fit();
      } catch {
        return;
      }
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    };
    ws.onopen = () => {
      sendSize();
      term.focus();
    };
    ws.onmessage = (m: MessageEvent<string | ArrayBuffer>) =>
      term.write(typeof m.data === 'string' ? m.data : new Uint8Array(m.data));
    ws.onclose = (e) => {
      if (e.code === 4004) term.write('\r\n\x1b[90m[this terminal is gone]\x1b[0m\r\n');
    };
    const input = term.onData((d) => ws.readyState === 1 && ws.send(JSON.stringify({ type: 'input', data: d })));
    const ro = new ResizeObserver(() => sendSize());
    ro.observe(el);
    // the page went light or dark: the terminal follows, text already on screen included
    // (again a frame later: the accent's own two tones may switch after this does)
    let again = 0;
    const offTheme = onThemeChange((dark) => {
      term.options.theme = terminalTheme(dark);
      cancelAnimationFrame(again);
      again = requestAnimationFrame(() => void (term.options.theme = terminalTheme()));
    });
    return () => {
      offTheme();
      cancelAnimationFrame(again);
      ro.disconnect();
      input.dispose();
      ws.close();
      term.dispose();
    };
  }, [id]);
  return <div className={`${className} [&_.xterm]:h-full`} ref={host} />;
}
