// Sharing the webhooks port through a tunnel: the user's own cloudflared or tailscale, started by Athena when they pick
// it in Settings › Webhooks, always pointed at the webhooks port, and stopped when Athena stops.
// - Cloudflare: a quick tunnel (no account; its https://….trycloudflare.com address changes on every start).
// - Tailscale, public: Funnel. Tailscale, tailnet only: Serve. Both keep https://<computer>.<tailnet>.ts.net.
// Each runs in the foreground (never Tailscale's --bg, which would outlive Athena). Arguments are built here from
// fixed parts and the port, never from typed text, and run without a shell.
import type { ChildProcess } from 'node:child_process';
import path from 'node:path';
import { bus, emit, getSettings, log, saveSettings } from '../store.ts';
import { dataPath, exists, IS_WIN, killTree, PORT, readJSON, run, spawnCommand, which, writeJSON } from '../util.ts';
import type { RunResult } from '../util.ts';
import { checkNonce, listenerStatus, syncListener, webhookPort } from './listener.ts';
import type { WebhookShare, WebhookTunnel } from '../../shared/types.ts';

type Tool = 'cloudflared' | 'tailscale';

/** How Athena starts processes and reaches addresses; the tests put fakes here. */
export interface TunnelIo {
  spawn: (exe: string, args: string[]) => ChildProcess;
  run: (exe: string, args: string[]) => Promise<RunResult>;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** Milliseconds before each retry after the tool stopped by itself. */
  retries: number[];
  /** Milliseconds between the first checks (a new Cloudflare name takes a moment to resolve). */
  checks: number[];
}
const realIo: TunnelIo = {
  spawn: (exe, args) => spawnCommand(exe, args, { stdio: ['ignore', 'pipe', 'pipe'] }),
  run: (exe, args) => run(exe, args, { timeout: 15_000 }),
  fetch: (url, init) => fetch(url, init),
  retries: [5_000, 30_000, 120_000],
  checks: [0, 3_000, 6_000, 10_000, 15_000, 20_000],
};
let io: TunnelIo = realIo;
export const setTunnelIo = (next: Partial<TunnelIo> | null): void => {
  io = next ? { ...realIo, ...next } : realIo;
};

const TOOL_OF: Record<Exclude<WebhookShare, 'off'>, Tool> = {
  cloudflare: 'cloudflared',
  'tailscale-public': 'tailscale',
  'tailscale-tailnet': 'tailscale',
};

/** Where each tool is usually installed, when it isn't on PATH. */
const KNOWN: Record<Tool, string[]> = IS_WIN
  ? {
      cloudflared: [
        'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
        'C:\\Program Files\\cloudflared\\cloudflared.exe',
      ],
      tailscale: ['C:\\Program Files\\Tailscale\\tailscale.exe'],
    }
  : {
      cloudflared: ['/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared', '/usr/bin/cloudflared'],
      tailscale: [
        '/opt/homebrew/bin/tailscale',
        '/usr/local/bin/tailscale',
        '/usr/bin/tailscale',
        '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
      ],
    };

export const INSTALL: Record<Tool, { link: string; winget: string; brew: string }> = {
  cloudflared: {
    link: 'https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/',
    winget: 'winget install --id Cloudflare.cloudflared',
    brew: 'brew install cloudflared',
  },
  tailscale: {
    link: 'https://tailscale.com/download',
    winget: 'winget install --id Tailscale.Tailscale',
    brew: 'brew install --cask tailscale',
  },
};

/** The tool's program: the path set in Settings, else PATH, else where it is usually installed. */
export function findTool(tool: Tool): string | null {
  const set = getSettings().webhooks.toolPaths?.[tool];
  if (set) return exists(set) ? set : null;
  return which(tool) || KNOWN[tool].find((p) => exists(p)) || null;
}

const NAME: Record<Tool, string> = { cloudflared: 'cloudflared', tailscale: 'Tailscale' };

// ---------- state ----------
interface State {
  share: WebhookShare;
  state: WebhookTunnel['state'];
  address: string;
  reached: boolean | null;
  message: string | null;
  danger: boolean;
  link: string | null;
  linkLabel: string | null;
  output: string[];
}
const fresh = (share: WebhookShare = 'off'): State => ({
  share,
  state: 'off',
  address: '',
  reached: null,
  message: null,
  danger: false,
  link: null,
  linkLabel: null,
  output: [],
});
let st: State = fresh();
let child: ChildProcess | null = null;
/** Changes on every start and stop, so what an older process does afterwards is ignored. */
let generation = 0;
let retry = 0;
let timers: ReturnType<typeof setTimeout>[] = [];
const PID_FILE = () => dataPath('webhook-tunnel.json');

const changed = () => emit('webhook-status');
const later = (ms: number, fn: () => void) => {
  const t = setTimeout(fn, ms);
  t.unref?.();
  timers.push(t);
};
const clearTimers = () => {
  for (const t of timers) clearTimeout(t);
  timers = [];
};

export function tunnelStatus(): WebhookTunnel {
  const s = getSettings().webhooks;
  return {
    share: s.share,
    state: !s.on || s.share === 'off' ? 'off' : st.share === s.share ? st.state : 'starting',
    address: st.address,
    reached: st.reached,
    message: st.message,
    danger: st.danger,
    link: st.link,
    linkLabel: st.linkLabel,
    changed: !!s.tunnelChanged,
    tools: { cloudflared: !!findTool('cloudflared'), tailscale: !!findTool('tailscale') },
    output: st.output.slice(-50),
  };
}

/** The address webhooks are reached at: the tunnel's while one is shared, else the one typed in Settings. */
export function publicAddress(): string {
  const s = getSettings().webhooks;
  if (s.share !== 'off') return st.address || s.tunnelUrl || '';
  return s.publicUrl;
}

function note(line: string) {
  // (no colours or cursor codes in the details)
  const clean = line.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').trimEnd();
  if (!clean.trim()) return;
  st.output.push(clean.slice(0, 400));
  if (st.output.length > 50) st.output.splice(0, st.output.length - 50);
}

// ---------- Tailscale ----------
interface TailscaleStatus {
  BackendState?: string;
  Self?: { DNSName?: string };
}
interface ServeConfig {
  TCP?: Record<string, unknown>;
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
}

const parse = <T>(text: string): T | null => {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
};

/** Proxies in Tailscale's Serve/Funnel setup that lead to the dashboard. */
export function dashboardProxies(config: ServeConfig | null, dashboardPort = PORT): string[] {
  const out: string[] = [];
  for (const [host, web] of Object.entries(config?.Web || {}))
    for (const [mount, h] of Object.entries(web.Handlers || {}))
      if (h.Proxy && new RegExp(`(^|[/:])(localhost|127\\.0\\.0\\.1|\\[::1\\])?:?${dashboardPort}(/|$)`).test(h.Proxy))
        out.push(`${host}${mount} → ${h.Proxy}`);
  return out;
}

/** The first of 443, 8443 and 10000 (the ports Funnel can use) that Serve and Funnel don't use yet. */
export function freeHttpsPort(config: ServeConfig | null): number | null {
  const used = new Set(Object.keys(config?.TCP || {}));
  return [443, 8443, 10000].find((p) => !used.has(String(p))) ?? null;
}

// ---------- starting and stopping ----------
export function argsFor(share: Exclude<WebhookShare, 'off'>, port: number, httpsPort = 443): string[] {
  if (share === 'cloudflare') return ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`];
  const verb = share === 'tailscale-public' ? 'funnel' : 'serve';
  return [verb, ...(httpsPort === 443 ? [] : [`--https=${httpsPort}`]), String(port)];
}

const stopped = (message: string, extra: Partial<State> = {}) => {
  Object.assign(st, { state: 'stopped', message, ...extra });
  changed();
};

/** A process left from a run that crashed (its id is in data/webhook-tunnel.json): ended if it is still that tool. */
async function endLeftover(): Promise<void> {
  const saved = readJSON<{ pid?: number; exe?: string } | null>(PID_FILE(), null);
  if (!saved?.pid || !saved.exe) return;
  writeJSON(PID_FILE(), {});
  const name = path.basename(saved.exe).toLowerCase();
  const r = IS_WIN
    ? await io.run('tasklist', ['/FI', `PID eq ${saved.pid}`, '/FO', 'CSV', '/NH'])
    : await io.run('ps', ['-p', String(saved.pid), '-o', 'comm=']);
  if (!r.stdout.toLowerCase().includes(name.replace(/\.exe$/, ''))) return;
  try {
    if (IS_WIN) await io.run('taskkill', ['/pid', String(saved.pid), '/t', '/f']);
    else process.kill(saved.pid);
    log('system', `Webhooks: stopped a ${name} left from before`);
  } catch {
    /* gone meanwhile */
  }
}

async function start(share: Exclude<WebhookShare, 'off'>): Promise<void> {
  const gen = ++generation;
  st = { ...fresh(share), state: 'starting' };
  changed();
  const tool = TOOL_OF[share];
  const exe = findTool(tool);
  startedFor = runKey(share);
  if (!exe)
    return stopped(`Install ${NAME[tool]} first, then pick it again.`, {
      link: INSTALL[tool].link,
      linkLabel: `Get ${NAME[tool]}`,
    });
  await syncListener();
  const listener = listenerStatus();
  if (!listener.listening) return stopped(listener.error || 'Webhooks are not being received. Turn them on first.');
  const port = listener.port;
  if (port === PORT)
    return stopped(`Port ${PORT} is the dashboard's. Pick another port for webhooks.`, { danger: true });
  await endLeftover();
  if (gen !== generation) return;

  let httpsPort = 443;
  if (tool === 'tailscale') {
    const status = parse<TailscaleStatus>((await io.run(exe, ['status', '--json'])).stdout);
    if (gen !== generation) return;
    if (status?.BackendState !== 'Running')
      return stopped(
        status?.BackendState === 'NeedsLogin' || status?.BackendState === 'NoState'
          ? 'Sign in to Tailscale first, then pick it again.'
          : 'Tailscale is not running. Start it and sign in, then pick it again.',
      );
    const dns = (status.Self?.DNSName || '').replace(/\.$/, '');
    const config = parse<ServeConfig>((await io.run(exe, ['serve', 'status', '--json'])).stdout);
    if (gen !== generation) return;
    const exposed = dashboardProxies(config);
    if (exposed.length)
      return stopped(
        `Tailscale already shares the dashboard (${exposed.join(', ')}). Anyone who reaches it can use the whole app. Turn it off with: tailscale serve reset`,
        { danger: true },
      );
    const free = freeHttpsPort(config);
    if (!free) return stopped('Tailscale already serves on ports 443, 8443 and 10000. Free one of them first.');
    httpsPort = free;
    if (dns) st.address = `https://${dns}${httpsPort === 443 ? '' : `:${httpsPort}`}`;
  }

  const args = argsFor(share, port, httpsPort);
  let proc: ChildProcess;
  try {
    proc = io.spawn(exe, args);
  } catch (e) {
    return stopped(`${NAME[tool]} could not start: ${e instanceof Error ? e.message : String(e)}`);
  }
  child = proc;
  if (proc.pid) writeJSON(PID_FILE(), { pid: proc.pid, exe });
  log('system', `Webhooks: started ${path.basename(exe)} ${args.join(' ')}`);
  let partial = '';
  const onData = (d: Buffer) => {
    if (gen !== generation) return;
    partial += d.toString('utf8');
    const lines = partial.split(/\r?\n/);
    partial = lines.pop() || '';
    for (const line of lines) read(share, line, gen);
  };
  proc.stdout?.on('data', onData);
  proc.stderr?.on('data', onData);
  proc.on('error', (e) => gen === generation && stopped(`${NAME[tool]} could not start: ${e.message}`));
  proc.on('exit', (code) => {
    if (gen !== generation) return;
    child = null;
    writeJSON(PID_FILE(), {});
    const last = st.output.at(-1) || `it ended (code ${code ?? 'none'})`;
    const wait = io.retries[retry];
    if (wait === undefined) {
      retry = 0;
      return stopped(`${NAME[tool]} stopped: ${last}. Pick it again to retry.`);
    }
    retry++;
    Object.assign(st, {
      state: 'starting',
      reached: null,
      message: `${NAME[tool]} stopped (${last}). Trying again in ${Math.round(wait / 1000)} seconds.`,
    });
    changed();
    later(wait, () => {
      if (gen === generation && getSettings().webhooks.share === share) void start(share);
    });
  });
  // Tailscale's address is known before it starts: it is on once the tool says so (see read)
}

/** One line of the tool's output: its address, a link to allow something, or that it's up. */
function read(share: Exclude<WebhookShare, 'off'>, line: string, gen: number) {
  note(line);
  if (share === 'cloudflare') {
    // (api.trycloudflare.com is in cloudflared's errors when it can't get a tunnel: never the address)
    const m = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/i.exec(line);
    if (m && st.state !== 'on') return up(share, m[0], gen);
  } else {
    const allow = /https:\/\/login\.tailscale\.com\/\S+/.exec(line);
    if (allow) {
      Object.assign(st, {
        link: allow[0],
        linkLabel: share === 'tailscale-public' ? 'Allow Funnel for your tailnet' : 'Allow Serve for your tailnet',
        message: 'Tailscale needs your OK first. Open the link, allow it, and it starts by itself.',
      });
      changed();
      return;
    }
    if (/available (on the internet|within your tailnet)/i.test(line) && st.state !== 'on') {
      const url = /https:\/\/\S+\.ts\.net\S*/.exec(line)?.[0].replace(/\/$/, '');
      return up(share, url || st.address, gen);
    }
    if (/logged out|needs ?login|not logged in/i.test(line)) {
      Object.assign(st, { message: 'Sign in to Tailscale first, then pick it again.' });
      changed();
    }
  }
}

function up(share: Exclude<WebhookShare, 'off'>, address: string, gen: number) {
  retry = 0;
  const saved = getSettings().webhooks;
  const moved = share === 'cloudflare' && !!saved.tunnelUrl && saved.tunnelUrl !== address;
  Object.assign(st, { state: 'on', address, message: null, link: null, linkLabel: null });
  // (the senders need the new address: the page says so until you say they have it)
  if (moved) saveSettings({ webhooks: { tunnelUrl: address, tunnelChanged: true } });
  else if (saved.tunnelUrl !== address) saveSettings({ webhooks: { tunnelUrl: address } });
  log('system', `Webhooks: shared at ${new URL(address).host}`);
  changed();
  // (a new Cloudflare name takes a moment to resolve: try a few times before saying it doesn't reach)
  let n = 0;
  const next = () => {
    if (gen !== generation) return;
    void checkTunnel().then((ok) => {
      if (!ok && gen === generation && st.state === 'on' && ++n < io.checks.length) later(io.checks[n], next);
    });
  };
  later(io.checks[0] ?? 0, next);
}

export function stopTunnel(): void {
  generation++;
  clearTimers();
  retry = 0;
  startedFor = '';
  const p = child;
  child = null;
  if (p) killTree(p);
  writeJSON(PID_FILE(), {});
  if (st.state !== 'off') {
    st = fresh();
    changed();
  }
}

/** What a running tunnel was started with: the choice, the webhooks port asked for and the program. Any change to
 *  them starts it again, so it never keeps forwarding to a port the listener left. */
let startedFor = '';
const runKey = (share: Exclude<WebhookShare, 'off'>) =>
  JSON.stringify([share, webhookPort(), findTool(TOOL_OF[share])]);

/** Starts, switches or stops the tunnel to match Settings › Webhooks. */
let applying: Promise<void> = Promise.resolve();
export function applyShare(): Promise<void> {
  applying = applying.then(async () => {
    const s = getSettings().webhooks;
    const want: WebhookShare = s.on ? s.share : 'off';
    if (want === 'off') return stopTunnel();
    // already going (or waiting to try again) for this choice, port and program
    if (st.share === want && st.state !== 'off' && (child || st.state === 'starting') && startedFor === runKey(want))
      return;
    stopTunnel();
    await start(want);
  });
  return applying;
}

// ---------- check ----------
/** Asks the public address for /h/_check: true when this listener answers. A 421 "Wrong host" means the address leads
 *  to the dashboard: the tunnel Athena runs is stopped at once. */
export async function checkAddress(address: string): Promise<{ ok: boolean; message: string; danger?: boolean }> {
  if (!address) return { ok: false, message: 'There is no public address yet.' };
  let r: Response;
  try {
    r = await io.fetch(`${address.replace(/\/+$/, '')}/h/_check`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(8_000),
    });
  } catch (e) {
    return {
      ok: false,
      message: `Webhooks don't reach this computer yet (${e instanceof Error ? e.message : 'no answer'}).`,
    };
  }
  if (r.status === 421)
    return {
      ok: false,
      danger: true,
      message:
        'This address leads to the dashboard, not the webhooks port. Anyone who reaches it can use the whole app. Point it at the webhooks port instead, now.',
    };
  const body = (await r.json().catch(() => null)) as { athena?: unknown; nonce?: unknown } | null;
  if (r.ok && body?.athena === 'webhooks' && body.nonce === checkNonce())
    return { ok: true, message: 'Webhooks reach this computer.' };
  return { ok: false, message: `Webhooks don't reach this computer yet (the address answered ${r.status}).` };
}

/** Checks the shared address (or the one typed in Settings), and keeps the answer in the status. */
export async function checkTunnel(): Promise<boolean> {
  const s = getSettings().webhooks;
  const address = publicAddress();
  const gen = generation;
  const r = await checkAddress(address);
  if (gen !== generation) return r.ok;
  if (r.danger && s.share !== 'off') {
    stopTunnel();
    st = { ...fresh(s.share), state: 'stopped' };
  }
  Object.assign(st, { reached: r.ok, message: r.ok ? null : r.message, danger: !!r.danger });
  changed();
  return r.ok;
}

/** Keeps the tunnel in step with Settings › Webhooks, and checks it every 10 minutes while it's on. */
export function watchTunnel(): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let last = JSON.stringify(shareKey());
  bus.on('event', (e) => {
    if (e.type !== 'settings') return;
    const now = JSON.stringify(shareKey());
    if (now === last) return;
    last = now;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void applyShare(), 200);
    timer.unref?.();
  });
  setInterval(() => st.state === 'on' && void checkTunnel(), 10 * 60_000).unref();
  void applyShare();
}

/** What starting or stopping the tunnel depends on. */
const shareKey = () => {
  const s = getSettings().webhooks;
  return [s.on, s.share, s.port, s.toolPaths];
};
