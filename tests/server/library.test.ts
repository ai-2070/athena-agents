// The Agent library comes with the dashboard (library/athena-agents in the repo): no download, no data folder needed.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as library from '../../server/library.ts';
import { agents, saveSettings } from '../../server/store.ts';
import { ROOT, parseFrontmatter } from '../../server/util.ts';
import { TOOL_GROUPS } from '../../server/tools.ts';
import { saveSkill, shippedSkillSlugs } from '../../server/skills.ts';
import { LIBRARY_ROLE_LINE, buildSystemPrompt } from '../../server/engines/index.ts';
import type { EngineId } from '../../shared/types.ts';

// The bundled library test must not wait on an installed Hermes CLI.
vi.mock('../../server/engines/hermes.ts', async (orig) => ({
  ...(await orig<typeof import('../../server/engines/hermes.ts')>()),
  listProfiles: async () => [],
}));

describe('hiring from the Agent library', () => {
  it('lists the agents in the library index without file paths, and nothing else', async () => {
    const idx = await library.libraryIndex();
    expect(Object.keys(idx).sort()).toEqual(['agents', 'claude', 'hermes']);
    expect(idx.agents.map((a) => a.slug)).toEqual(library.libraryAgents().map((a) => a.slug));
    for (const a of idx.agents) expect(a).not.toHaveProperty('file');
  });

  it("copies the file's text, tools, skills you have and source into a new agent, and leaves the file alone", () => {
    // one with two or more skills, so one is in your skill library and the others aren't
    const pick = library.libraryAgents().find((a) => a.skills.length > 1)!;
    const before = fs.readFileSync(pick.file, 'utf8');
    const have = saveSkill({ name: pick.skills[0], description: 'Use it for the test.', body: 'Steps.' })!;
    expect(have.slug).toBe(pick.skills[0]);
    const hired = library.hireFromLibrary(pick.slug);
    expect(hired).toMatchObject({
      name: pick.name,
      emoji: pick.emoji,
      color: pick.color,
      specialty: pick.specialty,
      description: pick.description,
    });
    expect(hired.systemPrompt).toBe(parseFrontmatter(before).body.trim());
    expect(hired.toolGroups).toEqual(pick.tools);
    expect(hired.skills).toEqual([pick.skills[0]]);
    expect(hired.source).toEqual({ type: 'library', slug: pick.slug, division: pick.group });
    expect(agents.get(hired.id)?.name).toBe(pick.name);
    expect(fs.readFileSync(pick.file, 'utf8')).toBe(before);
  });

  it("runs on the agent's own engine when its file names one, else on your default; what you pick wins", () => {
    const own = library.libraryAgents().find((a) => a.engine)!;
    const plain = library.libraryAgents().find((a) => !a.engine)!;
    saveSettings({ defaults: { engine: 'codex' } });
    try {
      expect(library.hireFromLibrary(own.slug).engine).toBe(own.engine);
      expect(library.hireFromLibrary(plain.slug).engine).toBe('codex');
      expect(library.hireFromLibrary(own.slug, { engine: 'eve', model: 'some/model' })).toMatchObject({
        engine: 'eve',
        model: 'some/model',
      });
    } finally {
      saveSettings({ defaults: { engine: 'claude-code' } });
    }
  });

  it('refuses an agent that is not in the library', () => {
    expect(() => library.hireFromLibrary('no-such-specialist')).toThrow('not in the library');
  });

  it('tells a library hire, and no other agent, that its role is a starting point', () => {
    const hired = library.hireFromLibrary(library.libraryAgents()[0].slug);
    const prompt = buildSystemPrompt(hired);
    expect(prompt).toContain(LIBRARY_ROLE_LINE);
    // right after its own instructions
    expect(prompt.indexOf(LIBRARY_ROLE_LINE)).toBe(prompt.indexOf(hired.systemPrompt) + hired.systemPrompt.length + 1);
    expect(buildSystemPrompt(library.newAgent({ name: 'Mine', systemPrompt: 'Do my thing.' }))).not.toContain(
      LIBRARY_ROLE_LINE,
    );
    expect(buildSystemPrompt(library.newAgent({ name: 'Made by the Brain', source: { type: 'brain' } }))).not.toContain(
      LIBRARY_ROLE_LINE,
    );
    expect(
      buildSystemPrompt(
        library.newAgent({
          name: 'Old hire',
          source: { type: 'agency', slug: 'engineering-code-reviewer', division: 'engineering' },
        }),
      ),
    ).not.toContain(LIBRARY_ROLE_LINE);
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

// Athena's agents (library/athena-agents). Its README.md has the standard each file follows; these checks catch
// what can be caught mechanically. Whether the writing is good is for review.
describe("Athena's agents", () => {
  const dir = path.join(ROOT, 'library', 'athena-agents');
  const groups = (
    JSON.parse(fs.readFileSync(path.join(dir, 'groups.json'), 'utf8')) as { groups: { id: string; label: string }[] }
  ).groups;
  const KEYS = new Set([
    'name',
    'description',
    'emoji',
    'color',
    'specialty',
    'group',
    'tools',
    'skills',
    'engine',
    'starter',
  ]);
  const ENGINE_IDS: EngineId[] = ['claude-code', 'eve', 'hermes', 'codex', 'pi', 'omp', 'openclaw', 'opencode'];
  const files = groups.flatMap((g) =>
    fs.existsSync(path.join(dir, g.id))
      ? fs.readdirSync(path.join(dir, g.id)).map((f) => ({ group: g.id, f, file: path.join(dir, g.id, f) }))
      : [],
  );

  it('has a folder only for the groups groups.json names, and only agent files in them', () => {
    const ids = groups.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const g of groups) expect(g.label).toBeTruthy();
    const folders = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
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
      // one short sentence for the card
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
    for (const e of new Set(emoji))
      if (emoji.filter((x) => x === e).length > 1) problems.push(`emoji ${e} is used by more than one agent`);
    expect(problems).toEqual([]);
    // the Home page's starter team
    expect(
      library
        .libraryAgents()
        .filter((a) => a.starter)
        .map((a) => a.name)
        .sort(),
    ).toEqual([
      '3D Artist',
      'Coordinator',
      'Image Maker',
      'Mail Assistant',
      'Researcher',
      'Video Editor',
      'World Builder',
      'X Writer',
    ]);
  });

  it('is written to the standard, not the old Agency template', () => {
    // a role is a starting point, not a fence, and the model's limits come from its tools at run time
    const FENCE =
      /outside (?:of )?your (?:scope|role|remit)|\bnot your (?:job|role)\b|\byou (?:cannot|can't|are unable to|are not able to) (?:see images|see the screen|view images|browse the web|run code|execute code|access the internet|open files)\b/i;
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
        else if (!code && !line.startsWith('|'))
          check(line.length <= 120, `body line ${i + 1} is ${line.length} characters`);
      }
    }
    expect(problems).toEqual([]);
  });
});
