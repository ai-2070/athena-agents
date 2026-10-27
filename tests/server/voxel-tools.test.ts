// The agents' world tools: building is low risk, changing what someone else built asks first,
// and a whole WORLD.md rewrite needs a fresh read.
import { afterEach, describe, expect, it } from 'vitest';
import { callTool, toolDefs, allTools } from '../../server/tools.ts';
import { newAgent } from '../../server/library.ts';
import { decide, listApprovals, setReviewer } from '../../server/approvals.ts';
import { saveSettings } from '../../server/store.ts';
import { shownWorld } from '../../server/voxel/link.ts';
import { buildSystemPrompt } from '../../server/engines/index.ts';

const tick = () => new Promise((r) => setTimeout(r, 10));
afterEach(() => {
  for (const a of listApprovals()) decide(a.id, { approved: false });
});
saveSettings({ brainApproves: false });
setReviewer(null);

const mira = newAgent({ name: 'Mira', toolGroups: ['world'], autonomy: 'auto' });
const kenji = newAgent({ name: 'Kenji', toolGroups: ['world'], autonomy: 'auto' });

describe('world tools', () => {
  it('come with the "world" tool group, with honest risks', () => {
    const names = toolDefs(mira).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['world_info', 'world_build', 'world_object', 'world_undo', 'world_prefab', 'world_light', 'world_effect', 'world_environment', 'world_md_read', 'world_md_section', 'world_md_write']));
    expect(toolDefs(newAgent({ name: 'Plain', toolGroups: [] })).some((t) => t.name.startsWith('world_'))).toBe(false);
    const risk = Object.fromEntries(allTools().map((t) => [t.name, t.risk]));
    expect(risk).toMatchObject({ world_info: 'none', world_build: 'low', world_object: 'varies', world_prefab: 'varies', world_light: 'varies', world_effect: 'varies', world_environment: 'low', world_md_read: 'none' });
    // the step language, prefabs and placing are in the build tool's description; nothing ready-made
    const build = toolDefs(mira).find((t) => t.name === 'world_build')!;
    expect(build.description).toMatch(/"voxel_size": 0.1/);
    expect(build.description).toMatch(/\{"place": "Palm tree"/);
    expect(build.description).toMatch(/nothing comes ready-made/);
    expect(build.description).not.toMatch(/torii|generator/i);
  });

  it('an agent builds without asking, and the answer says what it made', async () => {
    const r = await callTool(mira, 'world_build', { object: 'Pond', steps: [{ box: [3, 1, 3], use: 'water' }] });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/Built "Pond".*9 voxels added/);
    expect(listApprovals()).toHaveLength(0);
    const bad = await callTool(mira, 'world_build', { object: 'Pond', steps: [{ box: 'big' }] });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/^Nothing was built\. Step 1 \(box\)/);
  });

  it("changing someone else's object asks first, and a no changes nothing", async () => {
    const pending = callTool(kenji, 'world_build', { object: 'Pond', steps: [{ box: [1, 1, 1], use: 'stone' }] });
    await tick();
    const [a] = listApprovals();
    expect(a.title).toMatch(/Kenji wants to use world_change_others/);
    expect(a.detail).toMatch(/Kenji wants to change "Pond", which Mira built/);
    decide(a.id, { approved: false });
    const r = await pending;
    expect(r.isError).toBe(true);
    expect(shownWorld().world!.objects.find((o) => o.name === 'Pond')!.volumes[0].count).toBe(9);
    // deleting is high risk for anyone (autonomy "auto" asks)
    const del = callTool(mira, 'world_object', { object: 'Pond', delete: true });
    await tick();
    expect(listApprovals()).toHaveLength(1);
    decide(listApprovals()[0].id, { approved: true });
    expect((await del).text).toMatch(/Deleted "Pond"/);
    expect((await callTool(mira, 'world_undo', {})).text).toMatch(/Undid: Mira deleted Pond/);
  });

  it('WORLD.md: a section edit any time, a whole rewrite only after a fresh read', async () => {
    expect((await callTool(mira, 'world_md_section', { section: 'Places › Pond', content: 'Still water by the Brain.' })).isError).toBe(false);
    const blind = await callTool(kenji, 'world_md_write', { content: '# New\n\nAll new.' });
    expect(blind).toMatchObject({ isError: true, text: expect.stringMatching(/Read WORLD.md with world_md_read first/) });
    const read = await callTool(kenji, 'world_md_read', {});
    expect(read.text).toContain('Still water by the Brain.');
    await callTool(mira, 'world_md_section', { section: 'Story so far', content: '- the pond', append: true });
    expect((await callTool(kenji, 'world_md_write', { content: '# New\n\nAll new.' })).text).toMatch(/changed since you read it/);
    await callTool(kenji, 'world_md_read', {});
    expect((await callTool(kenji, 'world_md_write', { content: '# New\n\nAll new.' })).text).toMatch(/Saved WORLD.md/);
  });

  it("builders get WORLD.md in their instructions; others don't", () => {
    expect(buildSystemPrompt(mira)).toMatch(/# The voxel world: .*\n[\s\S]*<world-md>\n# New/);
    expect(buildSystemPrompt(newAgent({ name: 'Plain', toolGroups: [] }))).not.toMatch(/voxel world/);
  });
});
