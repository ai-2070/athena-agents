// Changes that reach other builders' work ask first, like changing their object: a palette material they
// built with (the palette is the whole world's), a prefab they placed copies of, and a library entry they
// published. The builder's own work stays silent.
import { afterEach, describe, expect, it } from 'vitest';
import { callTool } from '../../server/tools.ts';
import { newAgent } from '../../server/library.ts';
import { decide, listApprovals, setReviewer } from '../../server/approvals.ts';
import { saveSettings } from '../../server/store.ts';
import { shownWorld } from '../../server/voxel/link.ts';
import { libraryList } from '../../server/voxel/prefabs.ts';
import { setSkin } from '../../server/voxel/characters.ts';
import { worldApprovalChecks } from '../../server/voxel/tools.ts';
import { redefinedInScript, redefinedInSteps } from '../../server/voxel/reach.ts';

const tick = () => new Promise((r) => setTimeout(r, 10));
afterEach(() => {
  for (const a of listApprovals()) decide(a.id, { approved: false });
});
saveSettings({ brainApproves: false });
setReviewer(null);

const ada = newAgent({ name: 'Ada', toolGroups: ['world'], autonomy: 'auto' });
const bo = newAgent({ name: 'Bo', toolGroups: ['world'], autonomy: 'auto' });
const jade = () => shownWorld().world!.palette.find((m) => m.name === 'jade');

describe('changes that reach other builders’ work', () => {
  it("the builder's own materials, prefabs and library entries change without asking", async () => {
    expect(
      (
        await callTool(bo, 'world_build', {
          object: 'Bo shed',
          steps: [
            { material: 'bo brick', color: '#aa3322' },
            { box: [3, 2, 3], use: 'bo brick' },
          ],
        })
      ).isError,
    ).toBe(false);
    expect(
      (await callTool(bo, 'world_build', { prefab: 'Bo lamp', steps: [{ box: [1, 3, 1], use: 'lantern' }] })).isError,
    ).toBe(false);
    expect(
      (await callTool(bo, 'world_build', { object: 'Bo shed', steps: [{ place: 'Bo lamp', at: [0, 2, 0] }] })).isError,
    ).toBe(false);
    // redefining a material only Bo used, rebuilding a prefab only Bo placed, publishing twice
    const recolour = await callTool(bo, 'world_build', {
      object: 'Bo shed',
      steps: [
        { material: 'bo brick', color: '#552211' },
        { box: [1, 1, 1], at: [5, 0, 0], use: 'bo brick' },
      ],
    });
    expect(recolour.isError, recolour.text).toBe(false);
    expect(
      (
        await callTool(bo, 'world_script', {
          object: 'Bo shed',
          code: 'material("bo brick", { color: "#663322" }); box([2, 0, 0], [0.25, 0.25, 0.25], { use: "bo brick" });',
        })
      ).isError,
    ).toBe(false);
    expect(
      (await callTool(bo, 'world_build', { prefab: 'Bo lamp', steps: [{ box: [1, 4, 1], use: 'lantern' }] })).isError,
    ).toBe(false);
    expect((await callTool(bo, 'world_prefab', { action: 'publish', prefab: 'Bo lamp' })).text).toMatch(
      /Published "Bo lamp"/,
    );
    expect((await callTool(bo, 'world_prefab', { action: 'publish', prefab: 'Bo lamp' })).text).toMatch(
      /Updated "Bo lamp"/,
    );
    expect(listApprovals()).toHaveLength(0);
  });

  it('using a material someone else defined, or stating it unchanged, needs no OK', async () => {
    expect(
      (
        await callTool(ada, 'world_build', {
          object: 'Tea house',
          steps: [
            { material: 'jade', color: '#2a9d8f' },
            { box: [4, 2, 4], use: 'jade' },
          ],
        })
      ).isError,
    ).toBe(false);
    expect(
      (
        await callTool(bo, 'world_build', {
          object: 'Bo shed',
          steps: [{ box: [1, 1, 1], at: [7, 0, 0], use: 'jade' }],
        })
      ).isError,
    ).toBe(false);
    expect(
      (
        await callTool(bo, 'world_build', {
          object: 'Bo shed',
          steps: [
            { material: 'jade', color: '#2a9d8f' },
            { box: [1, 1, 1], at: [8, 0, 0] },
          ],
        })
      ).isError,
    ).toBe(false);
    expect(
      (
        await callTool(bo, 'world_script', {
          object: 'Bo shed',
          code: 'material("jade"); box([0, 1, 0], [0.25, 0.25, 0.25]);',
        })
      ).isError,
    ).toBe(false);
    expect(listApprovals()).toHaveLength(0);
  });

  it('redefining a material other builders used asks first, and a no changes nothing', async () => {
    const pending = callTool(bo, 'world_build', {
      object: 'Bo shed',
      steps: [
        { material: 'jade', color: '#ff0000' },
        { box: [1, 1, 1], use: 'jade' },
      ],
    });
    await tick();
    const [a] = listApprovals();
    expect(a.title).toMatch(/Bo wants to use world_change_others/);
    expect(a.detail).toMatch(
      /Bo wants to change the material "jade", which other builders used too: "Tea house" \(Ada\)\. Everything made of it would change\./,
    );
    expect(a.detail).not.toMatch(/Bo shed/);
    decide(a.id, { approved: false });
    expect((await pending).text).toMatch(/The user said no/);
    expect(jade()?.color).toBe('#2a9d8f');
    // the same check is read before Eve's native wait
    const checks = worldApprovalChecks(
      'world_build',
      {
        object: 'Bo shed',
        steps: [{ scatter: { count: 2, area: [2, 2], step: { material: 'jade', color: '#ff0000' } } }],
      },
      { agent: bo },
    );
    expect(checks).toEqual([
      expect.objectContaining({
        name: 'world_change_others',
        risk: 'high',
        scope: expect.objectContaining({ kind: 'material', materials: ['jade'] }),
      }),
    ]);
    // a yes changes it (and can be undone like any change)
    const yes = callTool(bo, 'world_build', {
      object: 'Bo shed',
      steps: [
        { material: 'jade', color: '#ff0000' },
        { box: [1, 1, 1], at: [9, 0, 0], use: 'jade' },
      ],
    });
    await tick();
    decide(listApprovals()[0].id, { approved: true });
    expect((await yes).isError).toBe(false);
    expect(jade()?.color).toBe('#ff0000');
    expect((await callTool(bo, 'world_undo', {})).text).toMatch(/Undid/);
    expect(jade()?.color).toBe('#2a9d8f');
  });

  it("a script asks too, and one that hides the material's name is refused rather than asked", async () => {
    const pending = callTool(bo, 'world_script', {
      object: 'Bo shed',
      code: 'material("jade", { color: "#00ff00" }); box([0, 0, 0], [0.25, 0.25, 0.25], { use: "jade" });',
    });
    await tick();
    expect(listApprovals()[0].detail).toMatch(
      /change the material "jade", which other builders used too: "Tea house" \(Ada\)/,
    );
    decide(listApprovals()[0].id, { approved: false });
    expect((await pending).isError).toBe(true);
    const hidden = await callTool(bo, 'world_script', {
      object: 'Bo shed',
      code: 'const n = ["ja", "de"].join(""); material(n, { color: "#00ff00" }); box([0, 0, 0], [0.25, 0.25, 0.25], { use: n });',
    });
    expect(hidden.isError).toBe(true);
    expect(hidden.text).toMatch(
      /^Nothing was built\. It would change the material "jade", which other builders used too \("Tea house" \(Ada\)\)\. Write its name out in the code/,
    );
    expect(listApprovals()).toHaveLength(0);
    expect(jade()?.color).toBe('#2a9d8f');
  });

  it('rebuilding a prefab other builders placed copies of asks first', async () => {
    expect(
      (await callTool(ada, 'world_build', { object: 'Tea house', steps: [{ place: 'Bo lamp', at: [1, 2, 1] }] }))
        .isError,
    ).toBe(false);
    const pending = callTool(bo, 'world_build', { prefab: 'Bo lamp', steps: [{ box: [2, 2, 2], use: 'gold' }] });
    await tick();
    const [a] = listApprovals();
    expect(a.title).toMatch(/Bo wants to use world_change_others/);
    expect(a.detail).toBe(
      'Bo wants to change the prefab "Bo lamp", which other builders placed copies of: "Tea house" (Ada). Every copy would change.',
    );
    decide(a.id, { approved: false });
    expect((await pending).isError).toBe(true);
    const lamp = shownWorld().world!.prefabs.find((p) => p.name === 'Bo lamp')!;
    expect(lamp.volumes.reduce((n, v) => n + v.count, 0)).toBe(4);
    // Ada's change to Bo's prefab is asked about once, as a change to Bo's prefab
    const theirs = callTool(ada, 'world_build', { prefab: 'Bo lamp', steps: [{ box: [1, 1, 1], use: 'gold' }] });
    await tick();
    expect(listApprovals().map((x) => x.detail)).toEqual(['Ada wants to change the prefab "Bo lamp", which Bo built.']);
    decide(listApprovals()[0].id, { approved: false });
    await theirs;
  });

  it('a new pivot for a prefab others placed copies of asks first: it moves every copy (BH-138)', async () => {
    const pending = callTool(bo, 'world_prefab', { action: 'change', prefab: 'Bo lamp', pivot: 'top' });
    await tick();
    const [a] = listApprovals();
    expect(a?.detail).toMatch(/placed copies of: "Tea house" \(Ada\)/);
    decide(a.id, { approved: false });
    expect((await pending).isError).toBe(true);
    // a new name moves nothing: it doesn't ask
    expect(
      worldApprovalChecks('world_prefab', { action: 'change', prefab: 'Bo lamp', name: 'Bo light' }, { agent: bo }),
    ).toEqual([]);
  });

  it("rebuilding a prefab worn as another agent's look asks first (BH-139)", async () => {
    expect(
      (await callTool(bo, 'world_build', { prefab: 'Bo statue', steps: [{ box: [1, 2, 1], use: 'stone' }] })).isError,
    ).toBe(false);
    const statue = shownWorld().world!.prefabs.find((p) => p.name === 'Bo statue')!;
    setSkin({ by: { kind: 'user', name: 'You' }, to: 'agent', id: ada.id, fields: { character: statue.id } });
    const checks = worldApprovalChecks('world_build', { prefab: 'Bo statue', steps: [] }, { agent: bo });
    expect(checks).toEqual([
      expect.objectContaining({ name: 'world_change_others', detail: expect.stringContaining("Ada's look (Ada)") }),
    ]);
    // the Brain's look is the user's
    setSkin({ by: { kind: 'user', name: 'You' }, to: 'agent', id: ada.id, fields: { character: null } });
    setSkin({ by: { kind: 'user', name: 'You' }, to: 'brain', fields: { shell: statue.id } });
    expect(worldApprovalChecks('world_build', { prefab: 'Bo statue', steps: [] }, { agent: bo })[0]?.detail).toContain(
      "the Brain's look (You)",
    );
    setSkin({ by: { kind: 'user', name: 'You' }, to: 'brain', fields: { shell: null } });
    expect(worldApprovalChecks('world_build', { prefab: 'Bo statue', steps: [] }, { agent: bo })).toEqual([]);
  });

  it('publishing under a name someone else published asks first, and a no keeps their entry', async () => {
    expect(
      (await callTool(ada, 'world_build', { prefab: 'Lantern', steps: [{ box: [1, 2, 1], use: 'lantern' }] })).isError,
    ).toBe(false);
    expect((await callTool(ada, 'world_prefab', { action: 'publish', prefab: 'Lantern' })).text).toMatch(
      /Published "Lantern"/,
    );
    expect(
      (await callTool(ada, 'world_prefab', { action: 'change', prefab: 'Lantern', name: 'Ada lantern' })).isError,
    ).toBe(false);
    expect(
      (await callTool(bo, 'world_build', { prefab: 'Lantern', steps: [{ box: [2, 2, 2], use: 'gold' }] })).isError,
    ).toBe(false);
    expect(listApprovals()).toHaveLength(0);
    const pending = callTool(bo, 'world_prefab', { action: 'publish', prefab: 'Lantern' });
    await tick();
    const [a] = listApprovals();
    expect(a.title).toMatch(/Bo wants to use world_change_others/);
    expect(a.detail).toBe(
      'Bo wants to publish "Lantern" to the prefab library, which replaces the "Lantern" that Ada published there.',
    );
    expect(worldApprovalChecks('world_prefab', { action: 'publish', prefab: 'Lantern' }, { agent: bo })).toEqual([
      expect.objectContaining({ detail: a.detail, scope: expect.objectContaining({ kind: 'library' }) }),
    ]);
    decide(a.id, { approved: false });
    expect((await pending).isError).toBe(true);
    expect(libraryList('Lantern')).toMatch(/"Lantern" by Ada/);
    const yes = callTool(bo, 'world_prefab', { action: 'publish', prefab: 'Lantern' });
    await tick();
    decide(listApprovals()[0].id, { approved: true });
    expect((await yes).text).toMatch(/Updated "Lantern"/);
    expect(libraryList('Lantern')).toMatch(/"Lantern" by Bo/);
  });
});

describe('reading which materials a change redefines', () => {
  const palette = [{ name: 'stone', color: '#7d7a74', kind: 'solid' as const }];
  it('build steps: a different definition, anywhere in the steps; the same one is no change', () => {
    expect(redefinedInSteps(palette, [{ material: 'stone', color: '#000000' }])).toEqual(['stone']);
    expect(
      redefinedInSteps(palette, [{ scatter: { count: 3, area: [2, 2], step: { material: 'Stone', kind: 'glass' } } }]),
    ).toEqual(['stone']);
    expect(
      redefinedInSteps(palette, [
        { material: 'stone' },
        { material: 'stone', color: '#7d7a74' },
        { material: 'new one', color: '#000000' },
        { box: [1, 1, 1], use: 'stone' },
      ]),
    ).toEqual([]);
  });
  it('scripts: material("name", …) and {material: "name"} with something to change', () => {
    expect(redefinedInScript(palette, 'material("stone", { color: "#000000" })')).toEqual(['stone']);
    expect(redefinedInScript(palette, "step({ material: 'stone', color: '#000000' })")).toEqual(['stone']);
    expect(
      redefinedInScript(palette, 'material("stone"); use("stone"); materialAt(0, 0, 0); material("other", {})'),
    ).toEqual([]);
  });
});
