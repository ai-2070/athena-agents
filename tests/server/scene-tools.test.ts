// The scene tools (server/scene/tools.ts): agents write the scene with their own file tools, without asking, and
// the scene tools tell them whether a change loads, show it, list versions and go back. Also what the engines are
// given (the folder and its rules), the Brain's scene actions, and backups carrying the scene and its versions.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { callTool, riskOf, toolsForAgent } from '../../server/tools.ts';
import type { ToolAgent } from '../../server/tools.ts';
import { activeProject, getSettings, saveSettings } from '../../server/store.ts';
import { ensureBrain } from '../../server/projects.ts';
import {
  forgetScene,
  markLoaded,
  sceneDir,
  sceneVersions,
  readThumb,
  saveThumb,
  settleScene,
  startFromTemplate,
  takeVersion,
} from '../../server/scene/history.ts';
import { forgetSceneLook, setScenePages, addSceneLogs } from '../../server/scene/look.ts';
import { forgetSceneWriters, noteSceneWrite, sceneAuthor, scenePrompt, shownNote } from '../../server/scene/tools.ts';
import { claudeArgs, claudePathRule } from '../../server/engines/claude.ts';
import { codexArgs } from '../../server/engines/codex.ts';
import { applyActions } from '../../server/overseer.ts';
import { newAgent } from '../../server/library.ts';
import * as backup from '../../server/backup.ts';
import type { ActiveRun } from '../../shared/types.ts';

const HTML = '<!doctype html><script type="module" src="main.js"></script>';
const builder: ToolAgent = { id: 'scene-agent', name: 'Coral', toolGroups: ['scene', 'files'], autonomy: 'ask' };

function clean(): string {
  const p = activeProject();
  ensureBrain(p);
  fs.rmSync(sceneDir(p), { recursive: true, force: true });
  fs.rmSync(path.join(process.env.DASH_DATA!, 'projects', p.id, 'scene-history'), { recursive: true, force: true });
  forgetScene(p.id);
  forgetSceneLook();
  forgetSceneWriters();
  return sceneDir(p);
}
const write = (rel: string, text: string) => {
  const f = path.join(sceneDir(activeProject()), ...rel.split('/'));
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};

describe('writing the scene', () => {
  let dir: string;
  beforeEach(() => {
    dir = clean();
  });

  it('never asks inside the scene folder, and asks elsewhere as before', () => {
    expect(riskOf('write_file', { path: path.join(dir, 'index.html') })).toBe('none');
    expect(riskOf('edit_file', { path: path.join(dir, 'js', 'main.js') })).toBe('none');
    expect(riskOf('write_file', { path: path.join(path.dirname(dir), 'project.json') })).toBe('low');
    // (a relative path can't be told apart without the workspace: asked about like any write)
    expect(riskOf('write_file', { path: 'index.html' })).toBe('low');
  });

  it('a builder writes the folder with the file tools, even on "Ask first", and the version is its own', async () => {
    const w = await callTool(builder, 'write_file', { path: path.join(dir, 'index.html'), content: HTML });
    expect(w.isError).toBeFalsy();
    await callTool(builder, 'write_file', { path: path.join(dir, 'main.js'), content: 'Athena.ready()' });
    const v = settleScene(activeProject());
    expect(v?.by).toMatchObject({ kind: 'agent', id: 'scene-agent', name: 'Coral' });
    expect(Object.keys(v!.files).sort()).toEqual(['index.html', 'main.js']);
  });

  it("a write is the agent's when the scene folder is reached through a link", () => {
    // (the file tools hand over the real path: /private/var on macOS, a long name on Windows)
    const target = path.join(process.env.DASH_DATA!, 'scene-elsewhere');
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(target, { recursive: true });
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    fs.symlinkSync(target, dir, 'junction');
    try {
      noteSceneWrite(path.join(fs.realpathSync(target), 'index.html'), builder, 'r1');
      expect(sceneAuthor(activeProject(), [])).toMatchObject({ kind: 'agent', id: 'scene-agent', runId: 'r1' });
    } finally {
      fs.rmSync(dir, { force: true });
    }
  });

  it('only agents with the scene tools get them and the folder', () => {
    const names = toolsForAgent(builder).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['scene_check', 'scene_look', 'scene_logs', 'scene_restore']));
    const plain: ToolAgent = { id: 'plain', name: 'Plain', toolGroups: ['files'] };
    expect(toolsForAgent(plain).some((t) => t.name.startsWith('scene_'))).toBe(false);
    expect(scenePrompt(names)).toContain(dir);
    expect(scenePrompt(['read_file'])).toBe('');
  });

  it('a change seen in the folder is put on the one run going on in the project', () => {
    const p = activeProject();
    const run = { id: 'r1', agentId: 'a1', agentName: 'Kenji', projectId: p.id } as ActiveRun;
    expect(sceneAuthor(p, [run])).toMatchObject({ kind: 'agent', name: 'Kenji', runId: 'r1' });
    expect(sceneAuthor(p, [run, { ...run, id: 'r2' }])).toEqual({ kind: 'outside' });
  });
});

describe('the scene tools', () => {
  const look = getSettings().look.stationLook;
  beforeEach(() => {
    clean();
    setScenePages(() => 1);
  });
  afterEach(() => saveSettings({ look: { stationLook: look } }));

  it('scene_check: no folder yet, then a change that loads', async () => {
    saveSettings({ look: { stationLook: 'scene' } });
    expect((await callTool(builder, 'scene_check', {})).text).toMatch(/no scene folder yet.*starter/s);
    write('index.html', HTML);
    // an open Station loads it while scene_check waits
    setTimeout(() => {
      const v = sceneVersions(activeProject())[0];
      if (v) markLoaded(activeProject(), v.id, 'ok');
    }, 100);
    const r = await callTool(builder, 'scene_check', {});
    expect(r.text).toMatch(/It loads/);
    expect(r.isError).toBeFalsy();
  });

  it('scene_check: a change that does not load, with what it logged and what the Station shows instead', async () => {
    saveSettings({ look: { stationLook: 'scene' } });
    const p = activeProject();
    write('index.html', HTML);
    const good = takeVersion(p, { kind: 'outside' })!;
    markLoaded(p, good.id, 'ok');
    write('main.js', 'nonsense(');
    const bad = settleScene(p)!;
    markLoaded(p, bad.id, 'broken', 'SyntaxError: Unexpected end of input (main.js:1)');
    addSceneLogs(p.id, [{ at: Date.now(), version: bad.id, level: 'error', text: 'SyntaxError: Unexpected end' }]);
    const r = await callTool(builder, 'scene_check', {});
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/doesn't load: SyntaxError/);
    expect(r.text).toContain(good.id);
    expect(r.text).toMatch(/- error: SyntaxError/);
  });

  it('scene_check and scene_look say when the Station is not in the scene look', async () => {
    saveSettings({ look: { stationLook: 'classic' } });
    write('index.html', HTML);
    expect((await callTool(builder, 'scene_check', {})).text).toMatch(/isn't in the scene look/);
    const l = await callTool(builder, 'scene_look', {});
    expect(l.isError).toBe(true);
    expect(l.text).toMatch(/isn't in the scene look/);
  });

  it('scene_restore: the starter, then back to an earlier version; scene_versions lists and reads them', async () => {
    const p = activeProject();
    const s = await callTool(builder, 'scene_restore', { version: 'starter' });
    expect(s.text).toMatch(/Copied the starter scene in/);
    expect(fs.existsSync(path.join(sceneDir(p), 'starter.js'))).toBe(true);
    const first = sceneVersions(p)[0];
    expect(first.by).toMatchObject({ kind: 'agent', name: 'Coral' });
    write('index.html', '<!doctype html><p>changed</p>');
    settleScene(p);
    const back = await callTool(builder, 'scene_restore', { version: first.id });
    expect(back.text).toMatch(/Went back to the version of/);
    expect(fs.readFileSync(path.join(sceneDir(p), 'index.html'), 'utf8')).toContain('importmap');
    const list = (await callTool(builder, 'scene_versions', {})).text;
    expect(list.split('\n')).toHaveLength(3);
    expect(list).toMatch(/changed index\.html/);
    const old = await callTool(builder, 'scene_versions', { version: first.id, path: 'index.html' });
    expect(old.text).toContain('importmap');
    expect((await callTool(builder, 'scene_restore', { version: 'nope' })).isError).toBe(true);
  });

  it('scene_use turns the scene look on and off', async () => {
    // (on "Ask first" it would wait for the user's OK: an agent on "Auto" doesn't)
    const auto: ToolAgent = { ...builder, autonomy: 'auto' };
    await callTool(auto, 'scene_use', { look: 'scene' });
    expect(getSettings().look.stationLook).toBe('scene');
    await callTool(auto, 'scene_use', { look: 'classic' });
    expect(getSettings().look.stationLook).toBe('classic');
  });

  it('scene_use asks on "Ask first" (a setting for every project); going back to a version does not', () => {
    expect(riskOf('scene_use', { look: 'scene' })).toBe('low');
    expect(riskOf('scene_restore', { version: 'starter' })).toBe('none');
  });

  it('scene_look says the newest version is still loading, not that it does not load', () => {
    const v = (loads?: 'ok' | 'broken') => ({
      id: 'sv-new',
      at: 1,
      by: { kind: 'outside' as const },
      files: {},
      loads,
    });
    expect(shownNote('sv-new', v())).toBe(' (the newest)');
    expect(shownNote('sv-old', v())).toMatch(/hasn't loaded yet/);
    expect(shownNote('sv-old', v('broken'))).toMatch(/doesn't load/);
    expect(shownNote('sv-old', v('ok'))).toBe(' (not the newest, sv-new)');
  });
});

describe('what the engines are given', () => {
  const files = { promptFile: 'prompt.md', mcpFile: 'mcp.json' };
  it('Claude Code: allow rules for the scene folder, for scene builders only', () => {
    const a = newAgent({ name: 'Scener', engine: 'claude-code', autonomy: 'ask', toolGroups: ['scene'] });
    const args = claudeArgs(a, files);
    const rule = claudePathRule(sceneDir(activeProject()));
    expect(args).toContain(`Edit(${rule})`);
    expect(args).toContain(`Write(${rule})`);
    const plain = claudeArgs(newAgent({ name: 'Plain', engine: 'claude-code', autonomy: 'ask' }), files);
    expect(plain.some((x) => x.startsWith('Edit('))).toBe(false);
  });

  it('Claude Code rules: absolute paths with //, Windows paths in POSIX form', () => {
    expect(claudePathRule('C:\\Users\\x\\proj\\.dashboard\\scene')).toBe('//c/Users/x/proj/.dashboard/scene/**');
    expect(claudePathRule('/home/x/proj/.dashboard/scene/')).toBe('//home/x/proj/.dashboard/scene/**');
  });

  it('Codex on auto: the scene folder is added to the writable roots, not put in place of the config ones', () => {
    const a = newAgent({ name: 'Scener', engine: 'codex', autonomy: 'auto', toolGroups: ['scene'] });
    const args = codexArgs(a);
    expect(args[args.indexOf('--add-dir') + 1]).toBe(sceneDir(activeProject()));
    // (-c sandbox_workspace_write.writable_roots=[…] would replace what the user set in ~/.codex/config.toml)
    expect(args.some((x) => x.startsWith('sandbox_workspace_write.writable_roots='))).toBe(false);
    const plain = codexArgs(newAgent({ name: 'Plain', engine: 'codex', autonomy: 'auto' }));
    expect(plain).not.toContain('--add-dir');
  });
});

describe('the Brain and the scene', () => {
  const look = getSettings().look.stationLook;
  afterEach(() => saveSettings({ look: { stationLook: look } }));

  it('turns the scene look on, and goes back to a version or the starter when asked', () => {
    clean();
    expect(applyActions([{ do: 'station_look', look: 'scene' }]).done[0]).toMatchObject({
      text: expect.stringMatching(/scene look/),
    });
    expect(getSettings().look.stationLook).toBe('scene');
    const started = applyActions([{ do: 'scene_restore', version: 'starter' }]).done[0];
    expect(started).toMatchObject({ text: 'Started from the starter scene' });
    const p = activeProject();
    const first = sceneVersions(p)[0];
    expect(first.by).toMatchObject({ kind: 'brain' });
    write('index.html', '<p>x</p>');
    settleScene(p);
    expect(applyActions([{ do: 'scene_restore', version: first.id }]).done[0]).toMatchObject({
      text: expect.stringMatching(/Went back/),
    });
    // never from a review on its own
    expect(applyActions([{ do: 'scene_restore', version: first.id }], undefined, { auto: true }).done[0]).toMatchObject(
      { kind: 'error' },
    );
  });
});

describe('backups', () => {
  it('carry the scene and its versions into the restored project', async () => {
    clean();
    const p = activeProject();
    write('index.html', HTML);
    write('main.js', 'v1');
    const v1 = takeVersion(p, { kind: 'outside' })!;
    markLoaded(p, v1.id, 'ok');
    write('main.js', 'v2');
    takeVersion(p, { kind: 'outside' });
    const r = backup.createBackup(p.id);
    const data = backup.decodeBackup(fs.readFileSync(r.file));
    expect(data.scene?.files.map((f) => f.path).sort()).toEqual(['index.html', 'main.js']);
    const { project, restored } = await backup.restoreBackup(fs.readFileSync(r.file), { name: 'Scene copy' });
    expect(restored.scene).toBe(true);
    expect(fs.readFileSync(path.join(sceneDir(project), 'main.js'), 'utf8')).toBe('v2');
    const versions = sceneVersions(project);
    expect(versions.map((v) => v.id)).toContain(v1.id);
    expect(versions.find((v) => v.id === v1.id)?.loads).toBe('ok');
  });
});

describe('templates and small pictures', () => {
  it('a template replaces the scene; what was there stays in the versions', async () => {
    clean();
    const p = activeProject();
    write('index.html', HTML);
    write('mine.js', 'mine');
    const before = takeVersion(p, { kind: 'outside' })!;
    const r = await callTool(builder, 'scene_restore', { version: 'garden' });
    expect(r.text).toMatch(/Copied the garden scene in/);
    expect(fs.existsSync(path.join(sceneDir(p), 'garden.js'))).toBe(true);
    expect(fs.existsSync(path.join(sceneDir(p), 'mine.js'))).toBe(false);
    expect(sceneVersions(p)[0].note).toBe('Started from the underwater garden scene');
    expect(sceneVersions(p).map((v) => v.id)).toContain(before.id);
    startFromTemplate(p, 'solar', { kind: 'user', name: 'You' });
    expect(fs.existsSync(path.join(sceneDir(p), 'solar.js'))).toBe(true);
    expect(fs.existsSync(path.join(sceneDir(p), 'garden.js'))).toBe(false);
  });

  it('keeps one small JPEG per version, and nothing that is not one', () => {
    clean();
    const p = activeProject();
    write('index.html', HTML);
    const v = takeVersion(p, { kind: 'outside' })!;
    const jpeg = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString('base64')}`;
    expect(saveThumb(p, v.id, 'data:image/png;base64,iVBORw0KGgo=')).toBe(false);
    expect(saveThumb(p, v.id, `data:image/jpeg;base64,${Buffer.from('not a jpeg').toString('base64')}`)).toBe(false);
    expect(saveThumb(p, v.id, jpeg)).toBe(true);
    expect(sceneVersions(p)[0].thumb).toBe(true);
    expect(readThumb(p, v.id)).toBe(jpeg);
    // the first one counts
    expect(saveThumb(p, v.id, jpeg)).toBe(false);
    expect(readThumb(p, '../../secrets')).toBeNull();
  });
});
