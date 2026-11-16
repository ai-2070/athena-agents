// A service the Programs page shows (ComfyUI): found by the regular check once it answers, even when the last scan
// didn't find it (BH-160), and a move to another address is news for the page (BH-161).
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import { discoverPrograms, knownPrograms, refreshRunning } from '../../server/programs.ts';
import { bus, saveSettings } from '../../server/store.ts';
import type { ServerEvent } from '../../shared/types.ts';

const comfy = async () => {
  const server = http.createServer((_req, res) => res.end('{"system":{},"devices":[]}'));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
};
const open: http.Server[] = [];
afterAll(async () => {
  saveSettings({ comfyui: { url: '', workflowDirs: [] } });
  await Promise.all(open.map((s) => new Promise<void>((r) => s.close(() => r()))));
});

describe('a service that starts after the scan', () => {
  it('shows up running, and its new address is told to the page', async () => {
    // nothing answers where it is set when the scan runs
    saveSettings({ comfyui: { url: 'http://127.0.0.1:9', workflowDirs: [] } });
    await discoverPrograms(true);
    const first = await comfy();
    open.push(first.server);
    saveSettings({ comfyui: { url: first.url, workflowDirs: [] } });
    await refreshRunning();
    expect(knownPrograms().find((p) => p.id === 'comfyui')).toMatchObject({ installed: true, running: true });
    const told: ServerEvent[] = [];
    const listen = (ev: ServerEvent) => ev.type === 'programs' && told.push(ev);
    bus.on('event', listen);
    try {
      // it moves to another port, with no moment between where it was stopped
      const second = await comfy();
      open.push(second.server);
      saveSettings({ comfyui: { url: second.url, workflowDirs: [] } });
      await refreshRunning();
      expect(told.length).toBeGreaterThan(0);
      expect(knownPrograms().find((p) => p.id === 'comfyui')?.serviceUrl).toBe(second.url);
    } finally {
      bus.off('event', listen);
    }
  }, 60_000);
});
