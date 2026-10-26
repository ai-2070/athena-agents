// The desktop app's build helpers (scripts/desktop-target.ts) and what the server does differently
// when the desktop app starts it.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { desktopTarget, desktopTriples, hostTriple, shasumFor } from '../../scripts/desktop-target.ts';
import { BRIDGE_SCRIPT, ROOT } from '../../server/util.ts';

describe('desktop build targets', () => {
  it('knows Windows, macOS and Linux on x64 and arm64', () => {
    expect(desktopTriples()).toHaveLength(6);
    expect(desktopTarget('x86_64-pc-windows-msvc')).toMatchObject({ os: 'win32', cpu: 'x64', bunAsset: 'bun-windows-x64-baseline', exe: '.exe' });
    expect(desktopTarget('aarch64-pc-windows-msvc')).toMatchObject({ os: 'win32', cpu: 'arm64', bunAsset: 'bun-windows-aarch64', exe: '.exe' });
    expect(desktopTarget('aarch64-apple-darwin')).toMatchObject({ os: 'darwin', cpu: 'arm64', bunAsset: 'bun-darwin-aarch64', exe: '' });
    expect(desktopTarget('x86_64-apple-darwin')).toMatchObject({ os: 'darwin', cpu: 'x64', exe: '' });
    expect(desktopTarget('x86_64-unknown-linux-gnu')).toMatchObject({ os: 'linux', cpu: 'x64', bunAsset: 'bun-linux-x64-baseline' });
    expect(desktopTarget('aarch64-unknown-linux-gnu')).toMatchObject({ os: 'linux', cpu: 'arm64', bunAsset: 'bun-linux-aarch64' });
  });

  it('says what to do instead of a universal macOS build, and refuses unknown targets', () => {
    expect(() => desktopTarget('universal-apple-darwin')).toThrow(/separately/);
    expect(() => desktopTarget('wasm32-unknown-unknown')).toThrow(/can't be built/);
  });

  it('reads the host from rustc and checksums from Bun\'s list', () => {
    expect(hostTriple('rustc 1.96.1\nbinary: rustc\nhost: aarch64-apple-darwin\nrelease: 1.96.1\n')).toBe('aarch64-apple-darwin');
    expect(() => hostTriple('')).toThrow(/rustc/);
    const a = 'a'.repeat(64);
    const b = 'B'.repeat(64);
    const sums = `${a}  bun-linux-x64.zip\r\n${b}  bun-linux-x64-baseline.zip\n`;
    expect(shasumFor(sums, 'bun-linux-x64-baseline.zip')).toBe('b'.repeat(64));
    expect(shasumFor(sums, 'bun-linux-x64.zip')).toBe(a);
    expect(shasumFor(sums, 'bun-darwin-x64.zip')).toBeNull();
  });
});

describe('server started by the desktop app', () => {
  let tmp = '';
  afterAll(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('runs the MCP bridge from source in a checkout', () => {
    // (the desktop app ships server/mcp-bridge.js, bundled, and BRIDGE_SCRIPT picks that one)
    expect(fs.realpathSync(BRIDGE_SCRIPT)).toBe(fs.realpathSync(path.join(ROOT, 'server', 'mcp-bridge.ts')));
  });

  it('stops by itself when its stdin closes (the app quit or crashed)', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-desktop-'));
    const home = path.join(tmp, 'home');
    fs.mkdirSync(home);
    const port = await new Promise<number>((resolve, reject) => {
      const srv = net.createServer();
      srv.once('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        const p = (srv.address() as net.AddressInfo).port;
        srv.close(() => resolve(p));
      });
    });
    const child = spawn('bun', ['server/index.ts', '--port', String(port), '--no-open'], {
      cwd: path.resolve(import.meta.dirname, '..', '..'),
      env: { ...process.env, DASH_DATA: path.join(tmp, 'data'), DASH_DESKTOP: '1', HOME: home, USERPROFILE: home },
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
    try {
      let up = false;
      for (let i = 0; i < 200 && !up && child.exitCode === null; i++) {
        try {
          const r = await fetch(`http://127.0.0.1:${port}/api/state`);
          up = r.ok && String(((await r.json()) as { dataDir?: string }).dataDir || '').startsWith(tmp);
        } catch {
          /* not up yet */
        }
        if (!up) await new Promise((r) => setTimeout(r, 150));
      }
      expect(up).toBe(true);
      child.stdin?.end();
      const code = await Promise.race([exited, new Promise<'still running'>((r) => setTimeout(() => r('still running'), 10_000))]);
      expect(code).toBe(0);
    } finally {
      child.kill();
    }
  }, 60_000);
});
