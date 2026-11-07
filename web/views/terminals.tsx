// Live terminals: PowerShell, Claude Code, Hermes, Orca, or any Claude Code / Hermes agent.
// The page is React; each terminal is xterm, talking to the server over a WebSocket.
import { Button } from '../ui/button.tsx';
import { Dot } from '../ui/marks.tsx';
import { Plate } from '../ui/surface.tsx';
import { useEffect, useState } from 'react';
import { attempt, navigate } from '../core.ts';
import { rpc } from '../client/rpc.ts';
import { Icon, reactPage, useAppState } from '../ui/react.tsx';
import { SelectControl } from '../ui/select.tsx';
import { ProgramGlyph } from '../ui/programmark.tsx';
import { XTerm } from '../terminalview.tsx';
import type { Terminal as TerminalInfo } from '../../shared/types.ts';

export { terminalTheme } from '../terminalview.tsx';

/** What POST /api/terminals takes. */
interface OpenTerminal {
  kind: 'shell' | 'command' | 'agent';
  command?: string;
  args?: string[];
  title?: string;
  agentId?: string;
}

async function open(body: OpenTerminal): Promise<void> {
  const t = await attempt(() => rpc.terminals.create(body));
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
  useEffect(() => void rpc.terminals.list().then(setFirst).catch(() => setFirst([])), []);
  if (!first) return null;
  // the live list once the app state has it (terminals opening and closing elsewhere)
  const list = data?.terminals || first;
  // which one shows: by the live list once the app state has changed since the page opened (a
  // terminal closed here goes), by the first list until then
  const live = data !== opened && data?.terminals ? data.terminals : null;
  const current = pickTerminal(asked, live || (first.length ? first : list));
  const close = async (id: string) => {
    await attempt(() => rpc.terminals.close({ id }));
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
            <button type="button" className="text-faint cursor-pointer px-1 hover:text-red" title="Close" aria-label={`Close ${t.title}`} onClick={() => void close(t.id)}>
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
  const agents = (data?.agents || []).filter((a) => a.engine !== 'eve');
  const [agentId, setAgentId] = useState(agents[0]?.id || '');
  if (!data) return null;
  const e = data.engines;
  // mark: the program whose logo it shows (as in Settings › Programs); none is a plain shell
  const card = (title: string, about: string, body: OpenTerminal, mark?: string) => (
    <button key={title} type="button" className="glass-plate term-card flex w-full cursor-pointer items-start gap-4 rounded-box p-5 text-left [font:inherit] text-inherit transition-colors hover:bg-panel-2" onClick={() => void open(body)}>
      <span aria-hidden="true" className="grid size-10 flex-none place-items-center rounded-ctl border border-line bg-panel-2 text-ink">
        {mark ? <ProgramGlyph id={mark} size={20} /> : <Icon name="terminal" size={20} />}
      </span>
      <span className="flex min-w-0 flex-col gap-1.5">
        <span className="card-title">{title}</span>
        <span className="card-sub">{about}</span>
      </span>
    </button>
  );
  return (
    <div className={`${HOST} overflow-y-auto`}>
      <div className="px-4 py-6 max-w-190">
        <p className="lede">Open a real terminal right here. Everything keeps running when you switch pages; come back any time.</p>
        <div className="cards">
          {card('PowerShell', 'A normal shell in your user folder.', { kind: 'shell' })}
          {e['claude-code'].installed ? card('Claude Code', 'Plain interactive Claude Code session.', { kind: 'command', command: 'claude', title: 'Claude Code' }, 'claude-code') : null}
          {e.hermes.installed ? card('Hermes', 'Interactive Hermes (default profile).', { kind: 'command', command: 'hermes', title: 'Hermes' }, 'hermes') : null}
          {e.pi?.installed ? card('pi', 'Interactive pi coding agent.', { kind: 'command', command: 'pi', title: 'pi' }, 'pi') : null}
          {e.omp?.installed ? card('oh-my-pi', 'Interactive oh-my-pi (omp).', { kind: 'command', command: 'omp', title: 'oh-my-pi' }, 'omp') : null}
          {e.openclaw?.installed ? card('OpenClaw', "OpenClaw's chat screen (through its Gateway).", { kind: 'command', command: 'openclaw', args: ['tui'], title: 'OpenClaw' }, 'openclaw') : null}
          {card('Orca', 'Orca CLI: status, worktrees, agent sessions.', { kind: 'command', command: 'orca', args: ['status'], title: 'Orca' }, 'orca')}
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

export const flush = true;
export const title = () => 'Terminals';
export const { render, unmount } = reactPage((params) => <TerminalsPage asked={params[0]} />);
