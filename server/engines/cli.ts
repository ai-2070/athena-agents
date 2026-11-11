// Small helpers shared by the engines that run another agent CLI (Claude Code, pi, oh-my-pi, OpenClaw, opencode):
// its version for Settings, reading what it prints line by line, and the messages sent into a turn
// while it works (for a CLI whose input stays open).
import { which, killTree, run as runCmd, PORT, DATA } from '../util.ts';
import { internalToken } from '../store.ts';
import type { ChildProcess } from 'node:child_process';
import type { RunEvent } from '../../shared/types.ts';
import type { TurnMessage, TurnSteering } from './index.ts';

/** Installed or not, where, and its version (fetched in the background, at most once a minute). */
export interface CliStatus {
  installed: boolean;
  path: string | null;
  version: string | null;
}

const versions = new Map<string, { at: number; version: string | null }>();
export function cliStatus(cmd: string, parse: (out: string) => string = (s) => s.trim().split('\n')[0] || ''): CliStatus {
  const exe = which(cmd);
  const hit = versions.get(cmd);
  if (exe && (!hit || Date.now() - hit.at > 60_000)) {
    versions.set(cmd, { at: Date.now(), version: hit?.version ?? null });
    runCmd(cmd, ['--version'], { timeout: 20000 }).then((r) => versions.set(cmd, { at: Date.now(), version: r.code === 0 ? parse(r.stdout) || null : null }));
  }
  return { installed: !!exe, path: exe, version: exe ? (versions.get(cmd)?.version ?? null) : null };
}

/** Is version a older than b? (Plain numbers: 0.99.0, 1.5.0; anything else isn't older.) */
export function olderThan(a: string | null, b: string): boolean {
  const nums = (v: string) => v.replace(/^v/, '').split(/[.-]/).slice(0, 3).map((n) => Number.parseInt(n, 10));
  const x = a ? nums(a) : [];
  if (x.length < 3 || x.some((n) => Number.isNaN(n))) return false;
  const y = nums(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! < y[i]!;
  return false;
}

/** What a finished child left behind. */
export interface ChildEnd {
  code: number | null;
  stderr: string;
}

/** Sends input on stdin, hands each line of stdout to onLine, and waits for the child to end.
 *  Stopping (signal) kills the child and its children. keepOpen: stdin stays open after the input (the
 *  caller writes more and ends it). */
export function pipeLines(child: ChildProcess, { input, signal, onLine, keepOpen = false }: { input?: string; signal: AbortSignal; onLine: (line: string) => void; keepOpen?: boolean }): Promise<ChildEnd> {
  const onAbort = () => killTree(child);
  signal.addEventListener('abort', onAbort);
  let buf = '';
  let stderr = '';
  const take = (line: string) => {
    const t = line.trim();
    if (!t) return;
    try {
      onLine(t);
    } catch {
      /* one bad line doesn't end the run */
    }
  };
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (d: string) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      take(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  });
  child.stderr?.on('data', (d: string) => {
    if (stderr.length < 200_000) stderr += d;
  });
  if (child.stdin) {
    child.stdin.on('error', () => {});
    if (keepOpen) child.stdin.write(input ?? '');
    else child.stdin.end(input ?? '');
  }
  return new Promise<ChildEnd>((resolve) => {
    child.on('close', (code) => {
      take(buf);
      signal.removeEventListener('abort', onAbort);
      resolve({ code, stderr });
    });
    child.on('error', (e) => {
      stderr += e.message;
      signal.removeEventListener('abort', onAbort);
      resolve({ code: -1, stderr });
    });
  });
}

/** Tells the dashboard bridge (in a CLI's MCP config) which agent and run is calling. */
export function bridgeEnv(agentId: string, runId = ''): Record<string, string> {
  // (the bridge reads the token from the data folder, so it never sits in their environment: made now if it isn't yet)
  internalToken();
  return { DASH_PORT: String(PORT), DASH_DATA: DATA, DASH_AGENT: agentId, ...(runId ? { DASH_RUN: runId } : {}) };
}

/** The end of what a CLI printed to stderr, for an error message. */
export const tail = (s: string, n = 1200): string => (s.trim() ? `\n${s.trim().slice(-n)}` : '');

/** The chat's engine session no longer exists (or never did). The engine has already cleared
 *  chat.sessionId and set chat.reseed, so the run can try again at once in a new session. */
export class SessionGone extends Error {}

/** The steer event that shows a message sent while it worked, where it was read. */
export function steerEvent(m: TurnMessage): RunEvent {
  return { kind: 'steer', id: m.id, text: m.text, ...(m.attachments?.length ? { attachments: m.attachments } : {}), ...(m.from ? { from: m.from } : {}), ...(m.teamMessageId ? { teamMessageId: m.teamMessageId } : {}) };
}

/** One run's open input: the messages sent into it that it hasn't read yet, and closing it. */
export interface OpenInput {
  /** by the key each went in with, in the order they went */
  unread: Map<string, TurnMessage>;
  isOpen(): boolean;
  /** done: its input closes (it exits) and it takes no more messages */
  close(): void;
  /** closes its input after ms, unless this is called again, or wait() or close() come first */
  closeIn(ms: number): void;
  wait(): void;
  /** it read this one: the chat shows it where it came in */
  read(key: string): void;
  /** it didn't take this one: it goes next, the ordinary way (it is still unread for the dashboard) */
  drop(key: string): void;
}

/** Steering for a CLI whose input stays open while it works: a message sent then is written into it, and the
 *  engine says when it read it. who: for the error when a run no longer reads ("Claude Code"). */
export function openInputs(who: string): { steer: TurnSteering; open(runId: string, io: { take: (m: TurnMessage) => string | false; end: () => void; onEvent: (ev: RunEvent) => void }): OpenInput } {
  // the runs whose CLI still reads its input
  const reading = new Map<string, (m: TurnMessage) => boolean>();
  const steer: TurnSteering = {
    can: (runId) => reading.has(runId),
    send: async (runId, m) => {
      if (!reading.get(runId)?.(m)) throw new Error(`${who} is no longer reading messages for this turn.`);
    },
    saysWhenRead: true,
  };
  /** take: writes a message in and says by which key it will know it (false: not this one). end: closes the input. */
  const open: ReturnType<typeof openInputs>['open'] = (runId, { take, end, onEvent }) => {
    const unread = new Map<string, TurnMessage>();
    let isOpen = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const close = () => {
      clearTimeout(timer);
      reading.delete(runId);
      if (!isOpen) return;
      isOpen = false;
      end();
    };
    reading.set(runId, (m) => {
      if (!isOpen) return false;
      const key = take(m);
      if (key === false) return false;
      unread.set(key, m);
      return true;
    });
    return {
      unread,
      isOpen: () => isOpen,
      close,
      closeIn: (ms) => {
        clearTimeout(timer);
        if (isOpen) timer = setTimeout(close, ms);
      },
      wait: () => clearTimeout(timer),
      read: (key) => {
        const m = unread.get(key);
        if (!m) return;
        unread.delete(key);
        onEvent(steerEvent(m));
      },
      drop: (key) => void unread.delete(key),
    };
  };
  return { steer, open };
}
