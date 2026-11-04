// ComfyUI's workflow and output folders are found for the old ComfyUI desktop app (config.json's basePath)
// and for the newer Comfy Desktop (installations.json, its shared output folder, ComfyUI-Installs).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { comfyOutputDirs, comfyWorkflowDirs } from '../../server/programs.ts';

// everything under the throwaway home folder (tests/server/setup.ts)
const base = fs.mkdtempSync(path.join(os.homedir(), 'comfy-'));
const roaming = path.join(base, 'Roaming');
const local = path.join(base, 'Local');
const saved = { APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA };
const mk = (...p: string[]) => {
  const d = path.join(...p);
  fs.mkdirSync(d, { recursive: true });
  return d;
};
const write = (file: string, json: unknown) => {
  mk(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(json));
};
const real = (dirs: string[]) => dirs.map((d) => fs.realpathSync.native(d));

beforeAll(() => {
  process.env.APPDATA = roaming;
  process.env.LOCALAPPDATA = local;
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("ComfyUI's folders", () => {
  it('the old desktop app: basePath from config.json', () => {
    const old = path.join(base, 'OldComfy');
    const wf = mk(old, 'user', 'default', 'workflows');
    const out = mk(old, 'output');
    write(path.join(roaming, 'ComfyUI', 'config.json'), { basePath: old });
    expect(real(comfyWorkflowDirs())).toContain(fs.realpathSync.native(wf));
    expect(real(comfyOutputDirs())).toContain(fs.realpathSync.native(out));
  });

  it("Comfy Desktop: each install in installations.json, an adopted old install, and the shared and own output folders", () => {
    const install = path.join(local, 'Comfy-Desktop', 'ComfyUI-Installs', 'Main');
    const wf = mk(install, 'ComfyUI', 'user', 'default', 'workflows');
    const adopted = path.join(base, 'Adopted');
    const adoptedWf = mk(adopted, 'user', 'default', 'workflows');
    const own = mk(base, 'OwnOutput');
    const sharedSetting = mk(base, 'SharedOutput');
    const sharedDefault = mk(local, 'Comfy-Desktop', 'ComfyUI-Shared', 'output');
    write(path.join(roaming, 'Comfy Desktop', 'installations.json'), [
      { id: 'a', name: 'Main', installPath: install, sourceId: 'standalone' },
      { id: 'b', name: 'Old one', installPath: path.join(base, 'gone'), adoptedBaseDir: adopted, useSharedOutput: false, outputDir: own, sourceId: 'desktop' },
      'not a record',
    ]);
    write(path.join(roaming, 'Comfy Desktop', 'settings.json'), { outputDir: sharedSetting });
    const workflows = real(comfyWorkflowDirs());
    expect(workflows).toContain(fs.realpathSync.native(wf));
    expect(workflows).toContain(fs.realpathSync.native(adoptedWf));
    const outputs = real(comfyOutputDirs());
    for (const d of [own, sharedSetting, sharedDefault]) expect(outputs).toContain(fs.realpathSync.native(d));
  });

  it('an install under the home folder that no record lists (an older Comfy Desktop)', () => {
    const wf = mk(os.homedir(), 'ComfyUI-Installs', 'Other', 'ComfyUI', 'user', 'default', 'workflows');
    const shared = mk(os.homedir(), 'ComfyUI-Shared', 'output');
    expect(real(comfyWorkflowDirs())).toContain(fs.realpathSync.native(wf));
    expect(real(comfyOutputDirs())).toContain(fs.realpathSync.native(shared));
  });

  it('only folders that exist, each once', () => {
    const dirs = [...comfyWorkflowDirs(), ...comfyOutputDirs()];
    for (const d of dirs) expect(fs.existsSync(d)).toBe(true);
    expect(new Set(comfyWorkflowDirs()).size).toBe(comfyWorkflowDirs().length);
  });
});
