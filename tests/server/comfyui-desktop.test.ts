// Comfy Desktop (the multi-install app): finding its installs' workflow and output folders, the ports it moved a
// ComfyUI to, and what it does when it opens, so the start tool can say why no ComfyUI came up.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { comfyDesktopPorts, comfyOutputDirs, comfyWorkflowDirs } from '../../server/programs.ts';
import type { ComfyPlaces } from '../../server/programs.ts';
import { desktopStartup, startComfy } from '../../server/comfyui.ts';
import { saveSettings } from '../../server/store.ts';

const root = fs.mkdtempSync(path.join(os.homedir(), 'comfy-desktop-'));
const at: ComfyPlaces = {
  home: path.join(root, 'home'),
  local: path.join(root, 'local'),
  roaming: path.join(root, 'roaming'),
  platform: 'win32',
};
const mk = (...p: string[]) => fs.mkdirSync(path.join(...p), { recursive: true });
const json = (file: string, v: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(v));
};
const WF = ['user', 'default', 'workflows'];

// a new install in the default place, one on another drive with its own output folder, one carried over from the
// Legacy Desktop, Comfy Cloud, and an older install in the home folder that Desktop's list doesn't name
const desk = path.join(at.roaming, 'Comfy Desktop');
const first = path.join(at.local, 'Comfy-Desktop', 'ComfyUI-Installs', 'ComfyUI');
const big = path.join(root, 'D', 'Comfy-Desktop', 'ComfyUI-Installs', 'Big');
const adopted = path.join(root, 'Documents', 'ComfyUI');
const shared = path.join(at.local, 'Comfy-Desktop', 'ComfyUI-Shared', 'output');
const legacy = path.join(root, 'Legacy');
json(path.join(desk, 'installations.json'), [
  { id: 'inst-1', name: 'ComfyUI', installPath: first, sourceId: 'standalone', lastLaunchedAt: 100 },
  {
    id: 'inst-2',
    name: 'Big drive',
    installPath: big,
    sourceId: 'standalone',
    useSharedOutput: false,
    lastLaunchedAt: 200,
  },
  {
    id: 'inst-3',
    name: 'From Legacy Desktop',
    installPath: adopted,
    adopted: true,
    adoptedBaseDir: adopted,
    sourceId: 'standalone',
    useSharedOutput: false,
    outputDir: path.join(adopted, 'output'),
  },
  { id: 'cloud', name: 'Comfy Cloud', sourceId: 'cloud' },
]);
json(path.join(at.roaming, 'ComfyUI', 'config.json'), { basePath: legacy });
for (const d of [
  path.join(first, 'ComfyUI'),
  path.join(big, 'ComfyUI'),
  adopted,
  legacy,
  path.join(at.home, 'ComfyUI-Installs', 'ComfyUI', 'ComfyUI'),
])
  mk(d, ...WF);
for (const d of [
  shared,
  path.join(big, 'ComfyUI', 'output'),
  path.join(adopted, 'output'),
  path.join(legacy, 'output'),
])
  mk(d);
const settings = (v: Record<string, unknown>) => json(path.join(desk, 'settings.json'), { outputDir: shared, ...v });

describe("Comfy Desktop's folders", () => {
  it('finds the workflows of every install it lists, and of installs in its default places', () => {
    settings({ firstUseCompleted: true });
    expect(comfyWorkflowDirs(at)).toEqual([
      path.join(legacy, ...WF),
      path.join(first, 'ComfyUI', ...WF),
      path.join(big, 'ComfyUI', ...WF),
      path.join(adopted, ...WF),
      path.join(at.home, 'ComfyUI-Installs', 'ComfyUI', 'ComfyUI', ...WF),
    ]);
  });

  it('finds the shared output folder and the installs that keep their own', () => {
    settings({ firstUseCompleted: true });
    expect(comfyOutputDirs(at)).toEqual([
      path.join(legacy, 'output'),
      shared,
      path.join(big, 'ComfyUI', 'output'),
      path.join(adopted, 'output'),
    ]);
    // a setting that points at the whole home folder isn't a folder of results to show
    settings({ outputDir: at.home });
    expect(comfyOutputDirs(at)).not.toContain(at.home);
  });

  it("reads a Mac's Desktop from Application Support", () => {
    const mac: ComfyPlaces = { ...at, home: path.join(root, 'mac'), platform: 'darwin' };
    const inst = path.join(mac.home, 'ComfyUI-Installs', 'Mine');
    json(path.join(mac.home, 'Library', 'Application Support', 'Comfy Desktop', 'installations.json'), [
      { id: 'i', installPath: inst, sourceId: 'standalone' },
    ]);
    mk(inst, 'ComfyUI', ...WF);
    expect(comfyWorkflowDirs(mac)).toEqual([path.join(inst, 'ComfyUI', ...WF)]);
  });

  it('knows the ports it moved a ComfyUI to', () => {
    json(path.join(desk, 'port-locks', 'port-8189.json'), { pid: 1, installationName: 'ComfyUI', timestamp: 1 });
    expect(comfyDesktopPorts(at)).toEqual([8189]);
  });
});

describe('what Comfy Desktop does when it opens', () => {
  it('starts nothing unless "Auto-launch on startup" names a ComfyUI on this computer', () => {
    settings({});
    expect(desktopStartup(at)).toMatchObject({ startsServer: false, note: expect.stringMatching(/isn't set up yet/) });
    settings({ firstUseCompleted: true });
    expect(desktopStartup(at)).toMatchObject({
      startsServer: false,
      note: expect.stringMatching(/"Auto-launch on startup" setting names one, and that setting is off.*press Launch/),
    });
    settings({ firstUseCompleted: true, autoLaunchOnStartup: 'none' });
    expect(desktopStartup(at)?.startsServer).toBe(false);
    settings({ firstUseCompleted: true, autoLaunchOnStartup: 'inst-9' });
    expect(desktopStartup(at)).toMatchObject({ startsServer: false, note: expect.stringMatching(/no longer there/) });
    settings({ firstUseCompleted: true, autoLaunchOnStartup: 'cloud' });
    expect(desktopStartup(at)).toMatchObject({ startsServer: false, note: expect.stringMatching(/Comfy Cloud/) });
  });

  it('starts the last one used, or the one it names', () => {
    settings({ firstUseCompleted: true, autoLaunchOnStartup: 'last' });
    expect(desktopStartup(at)).toMatchObject({
      startsServer: true,
      note: expect.stringMatching(/set to start "Big drive".*only brings its window forward/),
    });
    settings({ firstUseCompleted: true, autoLaunchOnStartup: 'inst-1' });
    expect(desktopStartup(at)?.note).toMatch(/"ComfyUI"/);
  });

  it("is null where there's no Comfy Desktop", () => {
    expect(desktopStartup({ ...at, roaming: path.join(root, 'nothing') })).toBeNull();
  });

  it("doesn't start anything when ComfyUI already answers", async () => {
    // (what ComfyUI's /system_stats has)
    const server = http.createServer((_req, res) => res.end('{"system":{},"devices":[]}'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    saveSettings({ comfyui: { url } });
    try {
      expect(await startComfy({ waitSec: 120 })).toBe(`ComfyUI is already running at ${url}.`);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
