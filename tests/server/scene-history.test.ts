// The scene look's versions (server/scene/history.ts) and how scenes are served (server/scene/serve.ts):
// every change to a project's .dashboard/scene/ is kept, whoever made it, and a scene is only ever served
// sandboxed, from a kept version, under its project's token.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { createProject } from '../../server/projects.ts';
import {
  forgetScene,
  markLoaded,
  pinVersion,
  pollScenes,
  pruneVersions,
  restoreVersion,
  sceneDir,
  sceneOverview,
  sceneVersions,
  SETTLE_MS,
  settleScene,
  takeVersion,
  versionFile,
  watchScene,
} from '../../server/scene/history.ts';
import { sceneResponse, sceneToken } from '../../server/scene/serve.ts';
import { dataPath } from '../../server/util.ts';
import type { Project } from '../../shared/types.ts';

const folder = (name: string) => path.join(os.homedir(), 'projects', name);
const outside = { kind: 'outside' as const };
let n = 0;
async function project(): Promise<Project> {
  const p = await createProject({ name: `Scene ${++n}`, mode: 'new', folder: folder(`scene-${n}-${Date.now()}`) });
  forgetScene(p.id);
  return p;
}
function write(p: Project, rel: string, text: string | Buffer): void {
  const f = path.join(sceneDir(p), ...rel.split('/'));
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
}
const read = (p: Project, rel: string) => fs.readFileSync(path.join(sceneDir(p), ...rel.split('/')), 'utf8');
const HTML = '<!doctype html><title>t</title><script type="module" src="main.js"></script>';

describe('scene versions', () => {
  let p: Project;
  beforeEach(async () => {
    p = await project();
  });

  it('keeps the folder as a version, outside the project folder, and not twice when nothing changed', () => {
    write(p, 'index.html', HTML);
    write(p, 'main.js', 'console.log(1)');
    const v = takeVersion(p, outside, 'As found');
    expect(v).not.toBeNull();
    expect(Object.keys(v!.files).sort()).toEqual(['index.html', 'main.js']);
    expect(takeVersion(p, outside)).toBeNull();
    // the history is in the data folder, where agents' file tools don't reach
    expect(fs.existsSync(dataPath('projects', p.id, 'scene-history', 'versions', `${v!.id}.json`))).toBe(true);
    expect(fs.existsSync(path.join(p.brainPath, '.dashboard', 'scene-history'))).toBe(false);
  });

  it('stores each content once, shared between versions', () => {
    write(p, 'index.html', HTML);
    write(p, 'main.js', 'a');
    const a = takeVersion(p, outside)!;
    write(p, 'main.js', 'b');
    const b = takeVersion(p, outside)!;
    expect(b.files['index.html'].hash).toBe(a.files['index.html'].hash);
    expect(fs.readdirSync(dataPath('projects', p.id, 'scene-history', 'blobs'))).toHaveLength(3);
    expect(versionFile(p, a, 'main.js')?.toString()).toBe('a');
    expect(versionFile(p, b, 'main.js')?.toString()).toBe('b');
  });

  it('keeps no version of a folder without index.html, over the limits, or with an empty index.html', () => {
    write(p, 'main.js', 'x');
    expect(takeVersion(p, outside)).toBeNull();
    expect(sceneOverview(p).problem).toMatch(/no index\.html/);
    write(p, 'index.html', '');
    expect(takeVersion(p, outside)).toBeNull();
    expect(sceneOverview(p).problem).toMatch(/empty/);
    write(p, 'index.html', HTML);
    write(p, 'big.bin', Buffer.alloc(9 * 1024 * 1024));
    expect(takeVersion(p, outside)).toBeNull();
    expect(sceneOverview(p).problem).toMatch(/big\.bin is .* at most/);
    fs.rmSync(path.join(sceneDir(p), 'big.bin'));
    expect(takeVersion(p, outside)).not.toBeNull();
    expect(sceneOverview(p).problem).toBeNull();
  });

  it('leaves out hidden files and types a scene can not hold', () => {
    write(p, 'index.html', HTML);
    write(p, '.notes', 'x');
    write(p, 'build.py', 'print(1)');
    write(p, 'img/fish.png', 'png');
    const v = takeVersion(p, outside)!;
    expect(Object.keys(v.files).sort()).toEqual(['img/fish.png', 'index.html']);
  });

  it('watches the folder: a quick run of edits becomes one version once it settles', () => {
    write(p, 'index.html', HTML);
    const t = Date.now() + 1_000_000;
    watchScene(p.id, t);
    pollScenes(t);
    expect(sceneVersions(p)).toHaveLength(1);
    expect(sceneVersions(p)[0].note).toBe('As found');
    // three edits in a row, each a second apart
    write(p, 'main.js', '1');
    pollScenes(t + 1000);
    write(p, 'main.js', '22');
    pollScenes(t + 2000);
    write(p, 'style.css', 'body{}');
    pollScenes(t + 3000);
    expect(sceneVersions(p)).toHaveLength(1);
    pollScenes(t + 3000 + SETTLE_MS);
    expect(sceneVersions(p)).toHaveLength(2);
    expect(Object.keys(sceneVersions(p)[0].files).sort()).toEqual(['index.html', 'main.js', 'style.css']);
    pollScenes(t + 10_000);
    expect(sceneVersions(p)).toHaveLength(2);
  });

  it('notices a change made while it was not watching', () => {
    write(p, 'index.html', HTML);
    takeVersion(p, outside);
    write(p, 'index.html', `${HTML}<!-- changed -->`);
    forgetScene(p.id);
    const t = Date.now() + 2_000_000;
    watchScene(p.id, t);
    pollScenes(t);
    expect(sceneVersions(p)).toHaveLength(2);
    expect(sceneVersions(p)[0].note).toMatch(/Changed while Athena was closed/);
  });

  it('settleScene keeps a change at once', () => {
    write(p, 'index.html', HTML);
    takeVersion(p, outside);
    write(p, 'main.js', 'now');
    expect(settleScene(p)).not.toBeNull();
    expect(settleScene(p)).toBeNull();
  });

  it('records how a version loaded: the first answer counts, and broken stays broken', () => {
    write(p, 'index.html', HTML);
    const v = takeVersion(p, outside)!;
    expect(markLoaded(p, v.id, 'ok')?.loads).toBe('ok');
    // (a version that loaded can turn out to freeze the tab)
    expect(markLoaded(p, v.id, 'broken', 'froze')?.loads).toBe('broken');
    expect(markLoaded(p, v.id, 'ok')?.loads).toBe('broken');
    expect(sceneOverview(p).newestGood).toBeNull();
    write(p, 'main.js', 'x');
    const w = takeVersion(p, outside)!;
    markLoaded(p, w.id, 'ok');
    expect(sceneOverview(p)).toMatchObject({ newest: w.id, newestGood: w.id, present: true });
  });

  it('goes back to a version as a new version, removing files that version did not have', () => {
    write(p, 'index.html', HTML);
    write(p, 'main.js', 'good');
    const good = takeVersion(p, outside)!;
    write(p, 'main.js', 'broken(');
    write(p, 'extra.js', 'x');
    write(p, 'build.py', 'left alone');
    takeVersion(p, outside);
    const back = restoreVersion(p, good.id, { kind: 'user', name: 'You' })!;
    expect(read(p, 'main.js')).toBe('good');
    expect(fs.existsSync(path.join(sceneDir(p), 'extra.js'))).toBe(false);
    expect(read(p, 'build.py')).toBe('left alone');
    expect(back.note).toMatch(/Went back to the version of/);
    expect(back.by).toEqual({ kind: 'user', name: 'You' });
    // three versions: the one going back can itself be undone
    expect(sceneVersions(p)).toHaveLength(3);
  });

  it('brings back one file of a version', () => {
    write(p, 'index.html', HTML);
    write(p, 'a.js', 'a1');
    write(p, 'b.js', 'b1');
    const first = takeVersion(p, outside)!;
    write(p, 'a.js', 'a2');
    write(p, 'b.js', 'b2');
    takeVersion(p, outside);
    restoreVersion(p, first.id, outside, 'a.js');
    expect(read(p, 'a.js')).toBe('a1');
    expect(read(p, 'b.js')).toBe('b2');
    expect(() => restoreVersion(p, first.id, outside, 'nope.js')).toThrow(/no file nope\.js/);
  });

  it('keeps the last versions, pinned ones and the newest that loads; deletes unused files', () => {
    write(p, 'index.html', HTML);
    write(p, 'n.js', 'first');
    const first = takeVersion(p, outside)!;
    pinVersion(p, first.id, true);
    write(p, 'n.js', 'second');
    const good = takeVersion(p, outside)!;
    markLoaded(p, good.id, 'ok');
    for (let i = 0; i < 205; i++) {
      write(p, 'n.js', `v${i}`);
      takeVersion(p, outside);
    }
    pruneVersions(p);
    const ids = sceneVersions(p).map((v) => v.id);
    expect(ids).toContain(first.id);
    expect(ids).toContain(good.id);
    expect(ids.length).toBe(202);
    const blobs = fs.readdirSync(dataPath('projects', p.id, 'scene-history', 'blobs'));
    // index.html, first, second and the 200 newest n.js
    expect(blobs.length).toBe(203);
  });

  it('does not read a scene folder that is a link', () => {
    const elsewhere = path.join(os.homedir(), `elsewhere-${Date.now()}`);
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.writeFileSync(path.join(elsewhere, 'index.html'), HTML);
    fs.mkdirSync(path.join(p.brainPath, '.dashboard'), { recursive: true });
    try {
      fs.symlinkSync(elsewhere, sceneDir(p), 'junction');
    } catch {
      return; // (no links on this system without rights)
    }
    expect(takeVersion(p, outside)).toBeNull();
    expect(sceneOverview(p).problem).toMatch(/link/);
  });
});

describe('serving scenes', () => {
  const host = '127.0.0.1:4800';
  it('serves a kept version sandboxed, under the project token only', async () => {
    const p = await project();
    write(p, 'index.html', HTML);
    write(p, 'main.js', 'console.log("v1")');
    const v = takeVersion(p, outside)!;
    const token = sceneToken(p.id);
    expect(token).not.toContain(p.id);
    const r = sceneResponse(`/scene/${token}/v/${v.id}/index.html`, host)!;
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/html/);
    const csp = r.headers['content-security-policy'];
    expect(csp).toMatch(/^sandbox allow-scripts;/);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain(`connect-src http://${host}/scene/${token}/ http://${host}/scene-lib/ data: blob:`);
    expect(csp).not.toMatch(/allow-same-origin/);
    expect(r.headers['access-control-allow-origin']).toBe('*');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    // the version, not the live folder
    write(p, 'main.js', 'console.log("v2")');
    expect(String(sceneResponse(`/scene/${token}/v/${v.id}/main.js`, host)!.body)).toBe('console.log("v1")');
  });

  it('answers 404 for unknown tokens, versions and paths', async () => {
    const p = await project();
    write(p, 'index.html', HTML);
    const v = takeVersion(p, outside)!;
    const token = sceneToken(p.id);
    expect(sceneResponse(`/scene/nottoken/v/${v.id}/index.html`, host)!.status).toBe(404);
    expect(sceneResponse(`/scene/${p.id}/v/${v.id}/index.html`, host)!.status).toBe(404);
    expect(sceneResponse(`/scene/${token}/v/sv-nope/index.html`, host)!.status).toBe(404);
    expect(sceneResponse(`/scene/${token}/v/${v.id}/other.js`, host)!.status).toBe(404);
    expect(sceneResponse(`/scene/${token}/v/${v.id}/../../../data/settings.json`, host)!.status).toBe(404);
    expect(sceneResponse(`/scene/${token}/starter/../../server/index.ts`, host)!.status).toBe(404);
    expect(sceneResponse('/scene-lib/../package.json', host)!.status).toBe(404);
    expect(sceneResponse('/scene-lib/three/three.cjs', host)!.status).toBe(404);
    expect(sceneResponse('/somewhere/else', host)).toBeNull();
  });

  it('serves the starter, the helper and three.js', async () => {
    const p = await project();
    const token = sceneToken(p.id);
    const starter = sceneResponse(`/scene/${token}/starter/index.html`, host)!;
    expect(starter.status).toBe(200);
    expect(starter.headers['content-security-policy']).toMatch(/^sandbox allow-scripts;/);
    expect(sceneResponse(`/scene/${token}/starter/starter.js`, host)!.status).toBe(200);
    const helper = sceneResponse('/scene-lib/athena-scene.js', host)!;
    expect(helper.status).toBe(200);
    expect(helper.headers['access-control-allow-origin']).toBe('*');
    expect(String(helper.body)).toContain('export const Athena');
    expect(sceneResponse('/scene-lib/three/three.module.js', host)!.status).toBe(200);
    expect(sceneResponse('/scene-lib/three/addons/controls/OrbitControls.js', host)!.status).toBe(200);
  });
});
