// Live terminals: PowerShell, Claude Code, Hermes, Orca, or any Claude Code / Hermes agent.
// The page is React; each terminal is xterm, talking to the server over a WebSocket.
import { Button } from '../ui/button.tsx';
import { Dot } from '../ui/marks.tsx';
import { Plate } from '../ui/surface.tsx';
import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import type { ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { GET, POST, DEL, attempt, navigate } from '../core.ts';
import { openSocket } from '../client/connection.ts';
import { reactPage, useAppState } from '../ui/react.tsx';
import { SelectControl } from '../ui/select.tsx';
import { isDark, onThemeChange, themeColor } from '../theme.ts';
import type { Terminal as TerminalInfo } from '../../shared/types.ts';

/** What POST /api/terminals takes. */
interface OpenTerminal {
  kind: 'shell' | 'command' | 'agent';
  command?: string;
  args?: string[];
  title?: string;
  agentId?: string;
}

// xterm paints on a canvas and can't use var(): the page's colors come from theme.ts, the 16 ANSI colors are
// picked here for each side (every one reads on its background: 4:1 or better, most 5:1)
const ANSI_LIGHT = {
  black: '#3b3b46', red: '#c4283a', green: '#16794a', yellow: '#8f5e00', blue: '#2a55c9', magenta: '#9235ad', cyan: '#0c748a', white: '#6b6b78',
  brightBlack: '#5b5b66', brightRed: '#d3303f', brightGreen: '#17804b', brightYellow: '#a3680a', brightBlue: '#3f6ae0', brightMagenta: '#a84dc4', brightCyan: '#0f7f98', brightWhite: '#74747f',
};
const ANSI_DARK = {
  black: '#636573', red: '#ff7b7b', green: '#4cc38a', yellow: '#f0b04a', blue: '#7da2ff', magenta: '#d29bf0', cyan: '#7cc4e8', white: '#c9cbd3',
  brightBlack: '#8b8d99', brightRed: '#ff9a9a', brightGreen: '#74dba5', brightYellow: '#f7c873', brightBlue: '#9db9ff', brightMagenta: '#e0b4f6', brightCyan: '#a3d8f1', brightWhite: '#eceef1',
};

/** #rrggbb as #rrggbbaa (a hex colour that isn't six digits is kept as it is). */
const withAlpha = (hex: string, alpha: number): string => (/^#[0-9a-f]{6}$/i.test(hex) ? `${hex}${Math.round(alpha * 255).toString(16).padStart(2, '0')}` : hex);

/** The terminal's colors for the page as it is now: the page's own background and ink, the picked accent for
 *  the cursor and the selection. */
export function terminalTheme(dark: boolean = isDark()): ITheme {
  const accent = themeColor('accent', dark ? '#7cbad5' : '#18688e');
  const background = themeColor('bg', dark ? '#0e0f11' : '#ffffff');
  return { ...(dark ? ANSI_DARK : ANSI_LIGHT), background, foreground: themeColor('ink', dark ? '#eceef1' : '#1a1a1f'), cursor: accent, cursorAccent: background, selectionBackground: withAlpha(accent, dark ? 0.35 : 0.22) };
}

async function open(body: OpenTerminal): Promise<void> {
  const t = await attempt(() => POST<TerminalInfo>('/terminals', body));
  if (t) navigate(`#/terminals/${t.id}`);
}

/** Which terminal to show: the one asked for if it exists, the launcher for "new", else the first one. */
export function pickTerminal(asked: string | undefined, list: readonly Pick<TerminalInfo, 'id'>[]): string | null {
  if (asked === 'new') return null;
  if (asked && list.some((t) => t.id === asked)) return asked;
  return list[0]?.id || null;
}

// a tab; the open one has a line in the accent under it
const TAB = 'flex items-center gap-2.5 px-4 py-3 border-b-2 border-transparent cursor-pointer text-[13px] leading-[normal] font-medium whitespace-nowrap text-dim hover:bg-ink/5 hover:text-ink';
const TAB_ON = 'flex items-center gap-2.5 px-4 py-3 border-b-2 border-accent cursor-pointer text-[13px] leading-[normal] font-medium whitespace-nowrap text-ink';
/** Where a terminal (or the launcher) sits, under the tabs: the page's own background, which the terminal paints in too. */
const HOST = 'flex-1 min-h-0 px-4 py-3 bg-bg';

function TerminalsPage({ asked }: { asked?: string }) {
  const data = useAppState();
  // the app state as it was when the page opened: it may not have a terminal just opened yet
  const [opened] = useState(() => data);
  const [first, setFirst] = useState<TerminalInfo[] | null>(null);
  useEffect(() => void GET<TerminalInfo[]>('/terminals').then(setFirst).catch(() => setFirst([])), []);
  if (!first) return null;
  // the live list once the app state has it (terminals opening and closing elsewhere)
  const list = data?.terminals || first;
  // which one shows: by the live list once the app state has changed since the page opened (a
  // terminal closed here goes), by the first list until then
  const live = data !== opened && data?.terminals ? data.terminals : null;
  const current = pickTerminal(asked, live || (first.length ? first : list));
  const close = async (id: string) => {
    await attempt(() => DEL(`/terminals/${id}`));
    if (current === id) navigate('#/terminals');
  };
  return (
    <div className="flex flex-col h-[calc(100vh-56px)]">
      <nav className="flex gap-1 border-b border-line bg-panel px-3 overflow-x-auto flex-none" aria-label="Terminals">
        {list.map((t) => (
          <div key={t.id} className={t.id === current ? TAB_ON : TAB}>
            <a className="flex items-center gap-2 text-inherit" href={`#/terminals/${t.id}`} aria-current={t.id === current ? 'page' : undefined}>
              <Dot tone={t.exited ? 'off' : 'on'} />
              {t.title}
            </a>
            <button className="text-faint cursor-pointer px-1 hover:text-red" title="Close" aria-label={`Close ${t.title}`} onClick={() => void close(t.id)}>
              ✕
            </button>
          </div>
        ))}
        <div className={!current ? TAB_ON : TAB}>
          <a className="flex items-center gap-2 text-inherit" href="#/terminals/new" aria-current={!current ? 'page' : undefined}>+ New</a>
        </div>
      </nav>
      {current ? <XTerm key={current} id={current} /> : <Launcher />}
    </div>
  );
}

function Launcher() {
  const data = useAppState();
  const agents = (data?.agents || []).filter((a) => a.engine !== 'openai');
  const [agentId, setAgentId] = useState(agents[0]?.id || '');
  if (!data) return null;
  const e = data.engines;
  const card = (title: string, about: string, body: OpenTerminal) => (
    <button key={title} type="button" className="glass-plate term-card flex w-full cursor-pointer flex-col gap-2.5 rounded-box p-5 text-left [font:inherit] text-inherit transition-colors hover:bg-panel-2" onClick={() => void open(body)}>
      <div className="card-title">{title}</div>
      <div className="card-sub">{about}</div>
    </button>
  );
  return (
    <div className={`${HOST} overflow-y-auto`}>
      <div className="px-4 py-6 max-w-190">
        <p className="lede">Open a real terminal right here. Everything keeps running when you switch pages; come back any time.</p>
        <div className="cards">
          {card('PowerShell', 'A normal shell in your user folder.', { kind: 'shell' })}
          {e['claude-code'].installed ? card('Claude Code', 'Plain interactive Claude Code session.', { kind: 'command', command: 'claude', title: 'Claude Code' }) : null}
          {e.hermes.installed ? card('Hermes', 'Interactive Hermes (default profile).', { kind: 'command', command: 'hermes', title: 'Hermes' }) : null}
          {e.pi?.installed ? card('pi', 'Interactive pi coding agent.', { kind: 'command', command: 'pi', title: 'pi' }) : null}
          {e.omp?.installed ? card('oh-my-pi', 'Interactive oh-my-pi (omp).', { kind: 'command', command: 'omp', title: 'oh-my-pi' }) : null}
          {e.openclaw?.installed ? card('OpenClaw', "OpenClaw's chat screen (through its Gateway).", { kind: 'command', command: 'openclaw', args: ['tui'], title: 'OpenClaw' }) : null}
          {card('Orca', 'Orca CLI: status, worktrees, agent sessions.', { kind: 'command', command: 'orca', args: ['status'], title: 'Orca' })}
        </div>
        {agents.length ? (
          <Plate className="mt-8 rounded-box p-6">
            <div className="panel-head">
              <h2>Open an agent in a terminal</h2>
            </div>
            <p className="hint">Runs the agent interactively with its instructions, model, tools and MCP servers. Great for long hands-on sessions.</p>
            <div className="flex flex-wrap items-center gap-3 mt-4">
              <div className="w-75">
                <SelectControl aria-label="Agent" value={agentId} onChange={setAgentId} options={agents.map((a) => ({ value: a.id, label: `${a.emoji || ''} ${a.name}` }))} />
              </div>
              <Button onClick={() => void open({ kind: 'agent', agentId })}>Open</Button>
            </div>
          </Plate>
        ) : null}
      </div>
    </div>
  );
}

/** One live terminal: xterm in the page, its keystrokes to the server and its output back. */
function XTerm({ id }: { id: string }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = host.current!;
    const term = new Terminal({ fontFamily: "'JetBrains Mono', Consolas, monospace", fontSize: 13, cursorBlink: true, allowProposedApi: true, scrollback: 10000, theme: terminalTheme() });
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
    ws.onmessage = (m: MessageEvent<string | ArrayBuffer>) => term.write(typeof m.data === 'string' ? m.data : new Uint8Array(m.data));
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
  return <div className={`${HOST} [&_.xterm]:h-full`} ref={host} />;
}

export const flush = true;
export const title = () => 'Terminals';
export const { render, unmount } = reactPage((params) => <TerminalsPage asked={params[0]} />);
