// Skills that come with the dashboard: a copy nobody changed follows the dashboard's updates, and a skill of
// yours with the same id stays yours. (Its own file: the tests run in order on one fresh data folder.)
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as skills from '../../server/skills.ts';
import { dataPath } from '../../server/util.ts';
import { listVersions } from '../../server/versions.ts';
import type { SkillVersionItem } from '../../server/skills.ts';

const markerFile = () => dataPath('skills', '.builtin.json');
const readMarker = (): { added: string[]; copies: Record<string, string>; kept: string[] } => JSON.parse(fs.readFileSync(markerFile(), 'utf8'));
// as if an older dashboard had put what is in the folder now there (or something with this fingerprint)
function recordAsShipped(slug: string, sum = skills.copySum(skills.skillDir(slug))) {
  const m = readMarker();
  m.copies[slug] = sum;
  fs.writeFileSync(markerFile(), JSON.stringify(m));
}
const OLD = 'f'.repeat(40);

describe('skills that come with the dashboard', () => {
  it('leave a skill of yours with the same id alone, link and all, on every start', () => {
    // anatomy installed from GitHub before the dashboard came with it, and notes of your own called claude-motion
    const mine = dataPath('skills', 'anatomy');
    fs.mkdirSync(mine, { recursive: true });
    fs.writeFileSync(path.join(mine, 'SKILL.md'), '---\nname: My anatomy\ndescription: Mine.\n---\nmine');
    fs.writeFileSync(path.join(mine, '.source.json'), JSON.stringify({ url: 'https://github.com/wheresryan22/anatomy/tree/main', repo: 'wheresryan22/anatomy', ref: 'main', path: '', installedAt: 1 }));
    fs.mkdirSync(dataPath('skills', 'claude-motion'), { recursive: true });
    fs.writeFileSync(dataPath('skills', 'claude-motion', 'SKILL.md'), '---\nname: My motion notes\ndescription: Mine.\n---\nmine');

    skills.ensureBuiltinSkills();
    skills.ensureBuiltinSkills();
    expect(skills.getSkill('anatomy')?.name).toBe('My anatomy');
    // anatomy comes without a link, but this one is yours: its link stays
    expect(skills.getSkill('anatomy')?.origin?.repo).toBe('wheresryan22/anatomy');
    expect(skills.getSkill('claude-motion')?.name).toBe('My motion notes');
    expect(skills.keptSkillIds()).toEqual(expect.arrayContaining(['anatomy', 'claude-motion']));
    // the library says they're yours, so the page draws them as yours and not with the dashboard's marks
    const listed = Object.fromEntries(skills.listSkills().map((s) => [s.slug, s]));
    expect(listed.anatomy.mine).toBe(true);
    expect(listed['claude-motion'].mine).toBe(true);
    expect(listed['motion-design'].mine).toBeUndefined();
    const m = readMarker();
    expect(m.copies.anatomy).toBeUndefined();
    // the others came in, each with the fingerprint of what was put there
    expect(m.copies['motion-design']).toBe(skills.copySum(skills.skillDir('motion-design')));
    expect(m.copies['orca-agents']).toBe(skills.copySum(skills.skillDir('orca-agents')));
  });

  it('bring a copy nobody changed up to date, keeping the old one in its History', () => {
    const dir = skills.skillDir('web-sims');
    const md = path.join(dir, 'SKILL.md');
    const latest = fs.readFileSync(md, 'utf8');
    const origin = skills.getSkill('web-sims')?.origin;
    expect(origin).toBeTruthy();
    // as an older dashboard left it: other words, and a file the new version doesn't have
    fs.writeFileSync(md, `${latest}A line an older version had.\n`);
    fs.writeFileSync(path.join(dir, 'old-notes.md'), 'gone in the new version');
    recordAsShipped('web-sims');

    skills.ensureBuiltinSkills();
    expect(fs.readFileSync(md, 'utf8')).toBe(latest);
    expect(fs.existsSync(path.join(dir, 'old-notes.md'))).toBe(false);
    expect(skills.getSkill('web-sims')?.origin).toMatchObject({ repo: origin?.repo, path: origin?.path });
    const [v] = listVersions<SkillVersionItem>(skills.skillVersionsDir('web-sims'));
    expect(v.note).toBe('Before the dashboard updated it');
    expect(v.item.body).toContain('A line an older version had.');
    expect(v.item.files).toContain('old-notes.md');
    expect(readMarker().copies['web-sims']).toBe(skills.copySum(dir));
    // nothing half-done left behind
    expect(fs.readdirSync(dataPath('tmp')).filter((x) => x.startsWith('bundled-'))).toEqual([]);
  });

  it("update the skills the dashboard writes itself the same way", () => {
    const md = path.join(skills.skillDir('orca-agents'), 'SKILL.md');
    const latest = fs.readFileSync(md, 'utf8');
    fs.writeFileSync(md, '---\nname: Start agents in Orca\ndescription: Old.\n---\n\nOld steps.\n');
    recordAsShipped('orca-agents');
    skills.ensureBuiltinSkills();
    expect(fs.readFileSync(md, 'utf8')).toBe(latest);
  });

  it('leave a copy someone changed as it is', () => {
    const md = path.join(skills.skillDir('sound-design'), 'SKILL.md');
    fs.appendFileSync(md, '\nOur studio mixes to -16 LUFS.\n');
    // the dashboard last put an older version there
    recordAsShipped('sound-design', OLD);
    skills.ensureBuiltinSkills();
    expect(fs.readFileSync(md, 'utf8')).toContain('Our studio mixes');
    // a file added to it counts as a change too
    fs.writeFileSync(path.join(skills.skillDir('review-loop'), 'house-rules.md'), 'ours');
    recordAsShipped('review-loop', OLD);
    skills.ensureBuiltinSkills();
    expect(fs.readFileSync(path.join(skills.skillDir('review-loop'), 'house-rules.md'), 'utf8')).toBe('ours');
  });

  it('take on a copy from before fingerprints were kept only when it is just like the latest', () => {
    const m = readMarker();
    delete m.copies.composio;
    delete m.copies['sound-design'];
    fs.writeFileSync(markerFile(), JSON.stringify(m));
    skills.ensureBuiltinSkills();
    expect(readMarker().copies.composio).toBe(skills.copySum(skills.skillDir('composio')));
    // changed: can't tell whether by you or by an older dashboard, so it stays as it is
    expect(readMarker().copies['sound-design']).toBeUndefined();
    expect(fs.readFileSync(path.join(skills.skillDir('sound-design'), 'SKILL.md'), 'utf8')).toContain('Our studio mixes');
  });

  it('keep a deleted one deleted, even when a newer version comes', () => {
    skills.deleteSkillEverywhere('higgsfield-websites');
    recordAsShipped('higgsfield-websites', OLD);
    skills.ensureBuiltinSkills();
    expect(skills.getSkill('higgsfield-websites')).toBeNull();
  });

  it("don't count the hidden files a file browser leaves as a change", () => {
    const dir = skills.skillDir('oo');
    const before = skills.copySum(dir);
    fs.writeFileSync(path.join(dir, '.DS_Store'), 'x');
    fs.writeFileSync(path.join(dir, 'Thumbs.db'), 'x');
    expect(skills.copySum(dir)).toBe(before);
    fs.writeFileSync(path.join(dir, 'notes.md'), 'x');
    expect(skills.copySum(dir)).not.toBe(before);
  });
});
