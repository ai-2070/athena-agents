// Sharing the webhooks port through Cloudflare or Tailscale, with fake tools that print what the real ones do.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getSettings, saveSettings } from '../../server/store.ts';
import { dataPath, PORT } from '../../server/util.ts';
import type { RunResult } from '../../server/util.ts';
import { checkNonce, stopListener } from '../../server/webhooks/listener.ts';
import {
  applyShare,
  argsFor,
  dashboardProxies,
  freeHttpsPort,
  publicAddress,
  setTunnelIo,
  stopTunnel,
  tunnelStatus,
} from '../../server/webhooks/tunnel.ts';
import type { WebhookShare } from '../../shared/types.ts';

/** What the fake tools print and answer. */
interface Fake {
  lines: string[];
  /** Ends right after printing. */
  exits?: boolean;
  status?: unknown;
  serve?: unknown;
  check?: () => Response;
}
let fake: Fake;
let started: { exe: string; args: string[]; pid: number | undefined }[];
const children: ReturnType<typeof spawn>[] = [];
const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: '' });
const waitFor = async (fn: () => boolean) => {
  for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 50));
  expect(fn()).toBe(true);
};
const alive = (pid: number | undefined) => {
  try {
    return !!pid && process.kill(pid, 0);
  } catch {
    return false;
  }
};

beforeAll(() => {
  const dir = dataPath('fake-tools');
  fs.mkdirSync(dir, { recursive: true });
  for (const t of ['cloudflared', 'tailscale']) fs.writeFileSync(path.join(dir, `${t}.exe`), '');
  saveSettings({
    webhooks: {
      toolPaths: { cloudflared: path.join(dir, 'cloudflared.exe'), tailscale: path.join(dir, 'tailscale.exe') },
    },
  });
});
beforeEach(() => {
  started = [];
  fake = { lines: [], status: { BackendState: 'Running', Self: { DNSName: 'pc.tail1.ts.net.' } }, serve: {} };
  setTunnelIo({
    spawn: (exe, args) => {
      const script = `${fake.lines.map((l) => `console.error(${JSON.stringify(l)});`).join('')}${fake.exits ? '' : 'setInterval(() => {}, 1000);'}`;
      const c = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
      children.push(c);
      started.push({ exe, args, pid: c.pid });
      return c;
    },
    run: async (_exe, args) => {
      if (args.join(' ') === 'status --json') return ok(JSON.stringify(fake.status));
      if (args.join(' ') === 'serve status --json') return ok(JSON.stringify(fake.serve));
      return ok('');
    },
    fetch: async () =>
      fake.check?.() ?? new Response(JSON.stringify({ athena: 'webhooks', nonce: checkNonce() }), { status: 200 }),
    retries: [20, 20],
    checks: [0],
  });
});
afterEach(async () => {
  stopTunnel();
  saveSettings({ webhooks: { share: 'off', on: false, tunnelUrl: '', tunnelChanged: false } });
  await stopListener();
});
afterAll(() => {
  setTunnelIo(null);
  for (const c of children) c.kill();
});

/** Picks a choice in the selector, as the page does. */
async function pick(share: WebhookShare) {
  saveSettings({ webhooks: { on: true, share, port: 0 } });
  await applyShare();
}

describe('the commands', () => {
  it('are fixed, point at the webhooks port, and never use --bg', () => {
    expect(argsFor('cloudflare', 4801)).toEqual(['tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:4801']);
    expect(argsFor('tailscale-public', 4801)).toEqual(['funnel', '4801']);
    expect(argsFor('tailscale-tailnet', 4801, 8443)).toEqual(['serve', '--https=8443', '4801']);
  });

  it("find the first free Funnel port, and any proxy that leads to the dashboard's", () => {
    expect(freeHttpsPort({})).toBe(443);
    expect(freeHttpsPort({ TCP: { 443: {}, 8443: {} } })).toBe(10000);
    expect(freeHttpsPort({ TCP: { 443: {}, 8443: {}, 10000: {} } })).toBeNull();
    const web = (proxy: string) => ({ Web: { 'pc.ts.net:443': { Handlers: { '/': { Proxy: proxy } } } } });
    expect(dashboardProxies(web(`http://127.0.0.1:${PORT}`))).toHaveLength(1);
    expect(dashboardProxies(web(`http://localhost:${PORT}/`))).toHaveLength(1);
    expect(dashboardProxies(web(`${PORT}`))).toHaveLength(1);
    expect(dashboardProxies(web('http://127.0.0.1:4801'))).toEqual([]);
    expect(dashboardProxies(web(`http://127.0.0.1:${PORT}1`))).toEqual([]);
  });
});

describe('Cloudflare', () => {
  it('starts on pick, reads its address, checks it and becomes the public address', async () => {
    fake.lines = ['INF Requesting new quick Tunnel', 'INF |  https://red-fox-12.trycloudflare.com  |'];
    await pick('cloudflare');
    await waitFor(() => tunnelStatus().state === 'on' && tunnelStatus().reached === true);
    const s = tunnelStatus();
    expect(s.address).toBe('https://red-fox-12.trycloudflare.com');
    expect(started[0].args.slice(0, 3)).toEqual(['tunnel', '--no-autoupdate', '--url']);
    expect(started[0].args[3]).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(started[0].args[3]).not.toBe(`http://127.0.0.1:${PORT}`);
    expect(publicAddress()).toBe('https://red-fox-12.trycloudflare.com');
    expect(s.output.join('\n')).toContain('Requesting new quick Tunnel');
  });

  it('says when its address changed since last time', async () => {
    saveSettings({ webhooks: { tunnelUrl: 'https://old-name.trycloudflare.com' } });
    fake.lines = ['INF |  https://new-name.trycloudflare.com  |'];
    await pick('cloudflare');
    await waitFor(() => tunnelStatus().state === 'on');
    expect(tunnelStatus().changed).toBe(true);
    expect(getSettings().webhooks.tunnelUrl).toBe('https://new-name.trycloudflare.com');
  });

  it('stops at once when the address leads to the dashboard', async () => {
    fake.lines = ['INF |  https://oops.trycloudflare.com  |'];
    fake.check = () => new Response('Wrong host', { status: 421 });
    await pick('cloudflare');
    await waitFor(() => tunnelStatus().danger);
    expect(tunnelStatus()).toMatchObject({ state: 'stopped', reached: false });
    expect(tunnelStatus().message).toMatch(/leads to the dashboard/);
    await waitFor(() => !alive(started[0].pid));
  });

  it('starts again after it stops by itself, then gives up', async () => {
    fake.lines = ['ERR failed to connect'];
    fake.exits = true;
    await pick('cloudflare');
    await waitFor(() => started.length === 3 && tunnelStatus().state === 'stopped');
    expect(tunnelStatus().message).toMatch(/cloudflared stopped: ERR failed to connect/);
  });

  it('says to install it when it is missing', async () => {
    const saved = getSettings().webhooks.toolPaths;
    saveSettings({ webhooks: { toolPaths: { ...saved, cloudflared: dataPath('nowhere', 'cloudflared.exe') } } });
    try {
      await pick('cloudflare');
      expect(tunnelStatus()).toMatchObject({ state: 'stopped', link: expect.stringContaining('cloudflare.com') });
      expect(tunnelStatus().tools.cloudflared).toBe(false);
      expect(started).toHaveLength(0);
    } finally {
      saveSettings({ webhooks: { toolPaths: saved } });
    }
  });
});

describe('Tailscale', () => {
  it("public: Funnel on the first free port, with the computer's ts.net name", async () => {
    fake.serve = { TCP: { 443: { HTTPS: true } } };
    fake.lines = ['Available on the internet:', '', 'https://pc.tail1.ts.net:8443/', '|-- proxy http://127.0.0.1:4801'];
    await pick('tailscale-public');
    await waitFor(() => tunnelStatus().state === 'on');
    expect(started[0].args).toEqual(['funnel', '--https=8443', expect.stringMatching(/^\d+$/)]);
    expect(tunnelStatus().address).toBe('https://pc.tail1.ts.net:8443');
  });

  it('tailnet only: Serve', async () => {
    fake.lines = ['Available within your tailnet:', 'https://pc.tail1.ts.net/'];
    await pick('tailscale-tailnet');
    await waitFor(() => tunnelStatus().state === 'on');
    expect(started[0].args[0]).toBe('serve');
    expect(tunnelStatus().address).toBe('https://pc.tail1.ts.net');
  });

  it('shows the link to allow Funnel, and waits', async () => {
    fake.lines = [
      'Funnel is not enabled on your tailnet.',
      'To enable, visit:',
      '',
      '  https://login.tailscale.com/f/funnel?node=abc',
    ];
    await pick('tailscale-public');
    await waitFor(() => !!tunnelStatus().link);
    expect(tunnelStatus()).toMatchObject({
      state: 'starting',
      link: 'https://login.tailscale.com/f/funnel?node=abc',
      linkLabel: 'Allow Funnel for your tailnet',
    });
  });

  it('asks to sign in first, and starts nothing', async () => {
    fake.status = { BackendState: 'NeedsLogin' };
    await pick('tailscale-public');
    expect(tunnelStatus()).toMatchObject({ state: 'stopped', message: expect.stringMatching(/Sign in to Tailscale/) });
    expect(started).toHaveLength(0);
  });

  it('refuses while Tailscale already shares the dashboard', async () => {
    fake.serve = { Web: { 'pc.tail1.ts.net:443': { Handlers: { '/': { Proxy: `http://127.0.0.1:${PORT}` } } } } };
    await pick('tailscale-public');
    expect(tunnelStatus()).toMatchObject({ state: 'stopped', danger: true });
    expect(tunnelStatus().message).toMatch(/tailscale serve reset/);
    expect(started).toHaveLength(0);
  });
});

describe('the selector', () => {
  it('stops the old tunnel before another starts, and Off stops it', async () => {
    fake.lines = ['INF |  https://one.trycloudflare.com  |'];
    await pick('cloudflare');
    await waitFor(() => tunnelStatus().state === 'on');
    fake.lines = ['Available within your tailnet:'];
    await pick('tailscale-tailnet');
    await waitFor(() => tunnelStatus().state === 'on');
    await waitFor(() => !alive(started[0].pid));
    expect(alive(started[1].pid)).toBe(true);
    await pick('off');
    expect(tunnelStatus().state).toBe('off');
    await waitFor(() => !alive(started[1].pid));
  });

  it('keeps the choice for the next start, and turning webhooks off stops it', async () => {
    fake.lines = ['INF |  https://kept.trycloudflare.com  |'];
    await pick('cloudflare');
    await waitFor(() => tunnelStatus().state === 'on');
    expect(getSettings().webhooks.share).toBe('cloudflare');
    saveSettings({ webhooks: { on: false } });
    await applyShare();
    expect(tunnelStatus().state).toBe('off');
    expect(getSettings().webhooks.share).toBe('cloudflare');
  });
});
