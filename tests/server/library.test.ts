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

  it('gives every agent what the card, the hire and the Brain need', () => {
    const tools = new Set(TOOL_GROUPS.map((g) => g.id));
    const skills = new Set(shippedSkillSlugs());
    for (const { group, file } of files) {
      const { meta } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
      const at = path.relative(dir, file);
      for (const k of Object.keys(meta)) expect(KEYS.has(k), `${at}: unknown key "${k}"`).toBe(true);
      expect(meta.name, at).toBeTruthy();
      expect(meta.description, at).toBeTruthy();
      expect(meta.emoji, at).toBeTruthy();
      expect(meta.color, at).toMatch(/^#[0-9a-f]{6}$/i);
      // it finishes "You are <name>, <specialty>."
      expect(meta.specialty, at).toMatch(/^[a-z][^\n]*[^.]$/);
      expect(meta.group, at).toBe(group);
      const a = library.libraryAgents().find((x) => x.file === file)!;
      expect(a.tools.length, `${at}: no tools`).toBeGreaterThan(0);
      for (const t of a.tools) expect(tools.has(t), `${at}: unknown tool group "${t}"`).toBe(true);
      for (const s of a.skills) expect(skills.has(s), `${at}: unknown skill "${s}"`).toBe(true);
      if (a.engine) expect(ENGINE_IDS, at).toContain(a.engine);
      if (meta.starter) expect(meta.starter, at).toBe('true');
    }
    expect(library.libraryAgents().filter((a) => a.starter).length).toBeLessThanOrEqual(8);
  });

  it("is written to the standard, not the old Agency template", () => {
    for (const { file } of files) {
      const text = fs.readFileSync(file, 'utf8');
      const { body } = parseFrontmatter(text);
      const at = path.relative(dir, file);
      const lines = text.split(/\r?\n/).length;
      expect(lines, `${at}: ${lines} lines`).toBeGreaterThanOrEqual(40);
      expect(lines, `${at}: ${lines} lines`).toBeLessThanOrEqual(180);
      // the dashboard already says "You are <name>, <specialty>."
      expect(body.trimStart(), at).not.toMatch(/^(?:#.*\n+)?You are\b/);
      expect(body, `${at}: emoji in a heading`).not.toMatch(/^#{1,6}\s.*\p{Extended_Pictographic}/mu);
      expect(body, at).not.toMatch(/Identity & Memory|Success Metrics|\bYou remember\b/i);
      // a role is a starting point, not a fence, and the model's limits come from its tools at run time
      expect(body, `${at}: fences the role in`).not.toMatch(/outside (?:of )?your (?:scope|role|remit)|\bnot your (?:job|role)\b|\byou (?:cannot|can't|are unable to|are not able to) (?:see|view|browse|run code|execute|access the internet|open files)\b/i);
    }
  });
});
