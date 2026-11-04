// The Agency comes with the dashboard (library/agency-agents in the repo): no download, no data folder needed.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as library from '../../server/library.ts';
import { agents } from '../../server/store.ts';
import { ROOT, parseFrontmatter } from '../../server/util.ts';
import { TOOL_GROUPS } from '../../server/tools.ts';
import { shippedSkillSlugs } from '../../server/skills.ts';
import type { EngineId } from '../../shared/types.ts';

// The bundled library test must not wait on an installed Hermes CLI.
vi.mock('../../server/engines/hermes.ts', async (orig) => ({
  ...(await orig<typeof import('../../server/engines/hermes.ts')>()),
  listProfiles: async () => [],
}));

const bundled = path.join(ROOT, 'library', 'agency-agents');

describe('the bundled Agency library', () => {
  it('lists every specialist straight from the repo, with an empty data folder', () => {
    const list = library.agencyAgents();
    expect(list.length).toBeGreaterThan(250);
    for (const a of list) {
      expect(a.name).toBeTruthy();
      expect(a.description).toBeTruthy();
      expect(fs.existsSync(a.file)).toBe(true);
      expect(a.file.startsWith(bundled)).toBe(true);
    }
  });

  it('has every division that divisions.json names, and no others', () => {
    const named = Object.keys(JSON.parse(fs.readFileSync(path.join(bundled, 'divisions.json'), 'utf8')).divisions as Record<string, unknown>).sort();
    const onDisk = fs
      .readdirSync(bundled, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    expect(onDisk).toEqual(named);
    const used = new Set(library.agencyAgents().map((a) => a.division));
    expect([...used].sort()).toEqual(named);
  });

  it("lists the security division's agents (their files are named security-*.md)", () => {
    const security = library.agencyAgents().filter((a) => a.division === 'security');
    expect(security.length).toBe(fs.readdirSync(path.join(bundled, 'security')).filter((f) => f.endsWith('.md')).length);
    expect(security.map((a) => a.slug)).toContain('security-appsec-engineer');
  });

  it('gives each specialist its own slug, since hiring looks one up by slug', () => {
    const slugs = library.agencyAgents().map((a) => a.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('shows up in the library index without file paths', async () => {
    const idx = await library.libraryIndex();
    expect(idx.agency.agents.length).toBe(library.agencyAgents().length);
    expect(idx.agency.agents[0]).not.toHaveProperty('file');
    expect(idx.agency).not.toHaveProperty('installed');
  });

  it('hires a specialist with its written instructions, and leaves the bundled file alone', () => {
    const pick = library.agencyAgents().find((a) => a.division === 'engineering')!;
    const before = fs.readFileSync(pick.file, 'utf8');
    const hired = library.hireFromAgency(pick.slug);
    expect(hired.name).toBe(pick.name);
    expect(hired.source).toEqual({ type: 'agency', slug: pick.slug, division: 'engineering' });
    expect(hired.systemPrompt).toBe(parseFrontmatter(before).body.trim());
    expect(agents.get(hired.id)?.name).toBe(pick.name);
    expect(fs.readFileSync(pick.file, 'utf8')).toBe(before);
  });

  it('refuses a specialist that is not in the library', () => {
    expect(() => library.hireFromAgency('no-such-specialist')).toThrow('not in the library');
  });
});

describe('Claude Code subagents', () => {
  it('exports a description with backslashes and quotes as frontmatter that reads back the same', () => {
    const description = 'Inspect C:\\src and say "done" \\';
    const a = library.newAgent({ name: 'Path checker', description, systemPrompt: 'Check paths.' });
    const text = fs.readFileSync(library.exportToClaude(a), 'utf8');
    expect(text).toContain('description: "Inspect C:\\\\src and say \\"done\\" \\\\"\n');
    expect(parseFrontmatter(text).meta).toMatchObject({ name: 'path-checker', description });
  });
});

// Athena's agents (library/athena-agents) replace The Agency. Its README.md has the standard each file follows; these
// checks catch what can be caught mechanically. Whether the writing is good is for review.
describe("Athena's agents", () => {
  const dir = path.join(ROOT, 'library', 'athena-agents');
  const groups = (JSON.parse(fs.readFileSync(path.join(dir, 'groups.json'), 'utf8')) as { groups: { id: string; label: string }[] }).groups;
  const KEYS = new Set(['name', 'description', 'emoji', 'color', 'specialty', 'group', 'tools', 'skills', 'engine', 'starter']);
  const ENGINE_IDS: EngineId[] = ['claude-code', 'eve', 'hermes', 'codex', 'pi', 'omp', 'openclaw'];
  const files = groups.flatMap((g) => (fs.existsSync(path.join(dir, g.id)) ? fs.readdirSync(path.join(dir, g.id)).map((f) => ({ group: g.id, f, file: path.join(dir, g.id, f) })) : []));

  it('has a folder only for the groups groups.json names, and only agent files in them', () => {
    const ids = groups.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const g of groups) expect(g.label).toBeTruthy();
    const folders = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    for (const f of folders) expect(ids).toContain(f);
    for (const { f } of files) expect(f).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/);
  });

  it('lists every file, in the order of groups.json, with unique slugs', () => {
    const list = library.libraryAgents();
    expect(list.map((a) => a.slug).sort()).toEqual(files.map(({ f }) => f.replace(/\.md$/, '')).sort());
    expect(new Set(list.map((a) => a.slug)).size).toBe(list.length);
    const order = list.map((a) => groups.findIndex((g) => g.id === a.group));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  // Both checks list every problem in every file, so one half-written file doesn't hide the others.
  it('gives every agent what the card, the hire and the Brain need', () => {
    const tools = new Set(TOOL_GROUPS.map((g) => g.id));
    const skills = new Set(shippedSkillSlugs());
    const problems: string[] = [];
    for (const { group, file } of files) {
      const { meta } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
      const at = path.relative(dir, file);
      const check = (ok: unknown, why: string) => void (ok || problems.push(`${at}: ${why}`));
      for (const k of Object.keys(meta)) check(KEYS.has(k), `unknown key "${k}"`);
      check(meta.name, 'no name');
      check(meta.description, 'no description');
      // the Brain reads every description when it picks teammates
      check((meta.description || '').split(/\s+/).length <= 35, 'description too long');
      check(!/[.!?;]\s+[A-Z]/.test(meta.description || ''), 'description is more than one sentence');
      check(meta.emoji, 'no emoji');
      check(/^#[0-9a-f]{6}$/i.test(meta.color || ''), 'colour is not a hex');
      // it finishes "You are <name>, <specialty>."
      check(/^[a-z][^\n]*[^.]$/.test(meta.specialty || ''), 'specialty is not a lower-case phrase without a full stop');
      check(meta.group === group, `group "${meta.group}" is not its folder`);
      const a = library.libraryAgents().find((x) => x.file === file);
      if (!a) {
        problems.push(`${at}: not listed`);
        continue;
      }
      // every agent can run a command and ask a teammate when its work needs one
      check(a.tools.includes('shell'), 'no shell');
      check(a.tools.includes('agents'), 'no agents');
      for (const t of a.tools) check(tools.has(t), `unknown tool group "${t}"`);
      for (const sk of a.skills) check(skills.has(sk), `unknown skill "${sk}"`);
      check(!a.engine || (ENGINE_IDS as readonly string[]).includes(a.engine), `unknown engine "${a.engine}"`);
      check(!meta.starter || meta.starter === 'true', 'starter is not "true"');
    }
    // each agent's emoji is its avatar on the cards
    const emoji = files.map(({ file }) => parseFrontmatter(fs.readFileSync(file, 'utf8')).meta.emoji);
    for (const e of new Set(emoji)) if (emoji.filter((x) => x === e).length > 1) problems.push(`emoji ${e} is used by more than one agent`);
    expect(problems).toEqual([]);
    // the Home page's starter team
    expect(library.libraryAgents().filter((a) => a.starter).map((a) => a.name).sort()).toEqual(['3D Artist', 'Coordinator', 'Image Maker', 'Mail Assistant', 'Researcher', 'Video Editor', 'World Builder', 'X Writer']);
  });

  it('is written to the standard, not the old Agency template', () => {
    // a role is a starting point, not a fence, and the model's limits come from its tools at run time
    const FENCE = /outside (?:of )?your (?:scope|role|remit)|\bnot your (?:job|role)\b|\byou (?:cannot|can't|are unable to|are not able to) (?:see|view|browse|run code|execute|access the internet|open files)\b/i;
    const problems: string[] = [];
    for (const { file } of files) {
      const text = fs.readFileSync(file, 'utf8');
      const { body } = parseFrontmatter(text);
      const at = path.relative(dir, file);
      const check = (ok: boolean, why: string) => void (ok || problems.push(`${at}: ${why}`));
      const lines = text.split(/\r?\n/).length;
      // no length limit; the upper bound only catches a runaway file
      check(lines >= 40 && lines <= 400, `${lines} lines`);
      // the dashboard already says "You are <name>, <specialty>."
      check(!/^(?:#.*\n+)?You are\b/.test(body.trimStart()), 'opens with "You are"');
      check(!/^#{1,6}\s.*\p{Extended_Pictographic}/mu.test(body), 'emoji in a heading');
      check(!/Identity & Memory|Success Metrics|\bYou remember\b/i.test(body), 'old Agency template wording');
      check(!FENCE.test(body), 'fences the role in');
      // wrapped at 120 characters, tables and code blocks aside
      let code = false;
      for (const [i, line] of body.split(/\r?\n/).entries()) {
        if (/^\s*```/.test(line)) code = !code;
        else if (!code && !line.startsWith('|')) check(line.length <= 120, `body line ${i + 1} is ${line.length} characters`);
      }
    }
    expect(problems).toEqual([]);
  });
});
