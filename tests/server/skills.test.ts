import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as skills from '../../server/skills.ts';
import { dataPath } from '../../server/util.ts';
import { activeProject, saveProjects, listProjects } from '../../server/store.ts';

const make = (name: string, description = `Use for ${name}.`, body = `Steps for ${name}.`) =>
  skills.saveSkill({ name, description, body });

// Make every file and folder in a skill look a minute old: a skill changed in the last moments is
// always read again (file times can be coarse), so only an older one is kept.
const settle = (dir: string) => {
  const old = new Date(Date.now() - 60_000);
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      fs.utimesSync(path.join(d, e.name), old, old);
    }
  };
  walk(dir);
  fs.utimesSync(dir, old, old);
};
// How often each of a skill's files is read from disk while fn runs (files that aren't there don't count).
const reads = (dir: string, fn: () => void): Record<string, number> => {
  const real = fs.realpathSync(dir);
  const spy = vi.spyOn(fs, 'readFileSync');
  try {
    fn();
    const count: Record<string, number> = {};
    spy.mock.calls.forEach(([p], i) => {
      if (typeof p !== 'string' || spy.mock.results[i].type !== 'return') return;
      const rel = [path.relative(dir, p), path.relative(real, p)].find(
        (r) => r && !r.startsWith('..') && !path.isAbsolute(r),
      );
      if (rel) count[rel.split(path.sep).join('/')] = (count[rel.split(path.sep).join('/')] || 0) + 1;
    });
    return count;
  } finally {
    spy.mockRestore();
  }
};
afterEach(() => vi.restoreAllMocks());

describe('skills library', () => {
  it('needs a name and a "when to use it" line', () => {
    expect(() => skills.saveSkill({ name: '', description: 'x', body: '' })).toThrow(/name/);
    expect(() => skills.saveSkill({ name: 'X', description: '', body: '' })).toThrow(/when/i);
  });

  it('saves a SKILL.md in Claude Code format and lists it', () => {
    const s = make('Brand voice', 'Use when writing anything for the brand.', 'Be calm.');
    expect(s?.slug).toBe('brand-voice');
    const file = fs.readFileSync(dataPath('skills', 'brand-voice', 'SKILL.md'), 'utf8');
    expect(file).toMatch(/^---\nname: Brand voice\ndescription: Use when writing anything for the brand\.\n---/);
    expect(skills.listSkills().map((x) => x.slug)).toContain('brand-voice');
  });

  it('gives two skills with the same name different slugs', () => {
    const a = make('Same name');
    const b = make('Same name');
    expect(a?.slug).not.toBe(b?.slug);
  });

  it('reads multi-line descriptions (YAML >- blocks)', () => {
    const dir = dataPath('skills', 'folded');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'SKILL.md'),
      '---\nname: folded\ndescription: >-\n  first line\n  second line\n---\nbody',
    );
    expect(skills.getSkill('folded')?.description).toBe('first line second line');
  });

  it('reads back exactly the name and description it saved, however often it is saved', () => {
    const name = 'Say "Hello" #1: it\'s';
    const description = 'Use for C:\\src\\new and a trailing \\';
    let s = skills.saveSkill({ name, description, body: 'Hi.' })!;
    for (let i = 0; i < 3; i++) {
      expect(s).toMatchObject({ name, description });
      s = skills.saveSkill({ slug: s.slug, name: s.name, description: s.description, body: s.body })!;
    }
    for (const odd of ['>', '| pipe', '- dash', '[x]', '{x}', '@x', 'true\\'])
      expect(skills.saveSkill({ name: odd, description: 'Use it.', body: '' })?.name).toBe(odd);
  });

  it('decodes quoted names and descriptions written by hand or the old way', () => {
    const dir = dataPath('skills', 'quoted');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'SKILL.md'),
      '---\nname: "Say \\"Hi\\" \\x41\\u00e9"\ndescription: \'It\'\'s for C:\\src\'\n---\nbody',
    );
    expect(skills.getSkill('quoted')).toMatchObject({ name: 'Say "Hi" Aé', description: "It's for C:\\src" });
    // an escape YAML doesn't know is kept as it was, and a plain value keeps its quotes
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: "C:\\src\\q"\ndescription: Say "hi"\n---\nbody');
    expect(skills.getSkill('quoted')).toMatchObject({ name: 'C:\\src\\q', description: 'Say "hi"' });
  });

  it('finds a skill by its display name, with the full instructions', () => {
    make('Email to clients', 'Use for client emails.', 'Always sign with the team name.');
    const s = skills.findSkill('email to clients');
    expect(s?.body).toContain('Always sign');
  });

  it("won't read files outside a skill's folder", () => {
    const s = make('Has files');
    fs.writeFileSync(dataPath('skills', s!.slug, 'ref.md'), 'reference');
    expect(skills.readSkillFile(s!.slug, 'ref.md')).toBe('reference');
    expect(() => skills.readSkillFile(s!.slug, '../brand-voice/SKILL.md')).toThrow();
  });

  it('deletes a skill', () => {
    const s = make('Temporary');
    skills.deleteSkill(s!.slug);
    expect(skills.getSkill(s!.slug)).toBeNull();
  });
});

describe('finding and searching a skill', () => {
  it('finds a skill by its id, its name or its name written as an id', () => {
    const s = make('Quarterly report', 'Use for the quarterly report.', 'Report steps.');
    // a skill whose name is another skill's id: the id wins
    const other = skills.saveSkill({ name: s!.slug, description: 'Named like an id.', body: 'Other steps.' })!;
    expect(other.slug).not.toBe(s!.slug);
    expect(skills.findSkill(s!.slug)?.body).toContain('Report steps.');
    expect(skills.findSkill('  QUARTERLY report ')?.slug).toBe(s!.slug);
    expect(skills.findSkill(other.slug)?.slug).toBe(other.slug);
    expect(skills.findSkill('Quarterly-Report!')?.slug).toBe(s!.slug);
    expect(skills.findSkill('no such skill')).toBeNull();
  });

  it('searches SKILL.md and its text files line by line, skipping files that are not text', () => {
    const s = make('Searchable', 'Use when searching.', 'Intro\nRun the TOOL first.\nThen stop.');
    const dir = dataPath('skills', s!.slug);
    fs.mkdirSync(path.join(dir, 'references'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'references', 'commands.md'), 'tool list\nnothing here\nanother tool');
    fs.writeFileSync(path.join(dir, 'data.bin'), 'tool\0binary');
    fs.writeFileSync(path.join(dir, '.hidden.md'), 'tool hidden');
    const out = skills.searchSkill(s!.slug, 'tool');
    expect(out.split('\n').sort()).toEqual(
      [
        'SKILL.md:7: Run the TOOL first.',
        'references/commands.md:1: tool list',
        'references/commands.md:3: another tool',
      ].sort(),
    );
    expect(skills.searchSkill(s!.slug, 'tool', 'references/commands.md')).toBe(
      'references/commands.md:1: tool list\nreferences/commands.md:3: another tool',
    );
    // one file asked for by name is searched even when it isn't text
    expect(skills.searchSkill(s!.slug, 'binary', 'data.bin')).toBe('data.bin:1: tool\0binary');
    // not a regular expression: searched for as plain words
    expect(skills.searchSkill(s!.slug, 'TOOL first.(')).toBe('No line in the skill\'s files matches "TOOL first.(".');
    expect(skills.searchSkill(s!.slug, 'the tool f')).toBe('SKILL.md:7: Run the TOOL first.');
    expect(() => skills.searchSkill(s!.slug, 'tool', '../brand-voice/SKILL.md')).toThrow(
      /not part of the skill|no file/,
    );
    expect(() => skills.searchSkill(s!.slug, 'tool', 'missing.md')).toThrow('The skill has no file "missing.md".');
    expect(() => skills.searchSkill('no-such-skill', 'tool')).toThrow('No skill "no-such-skill".');
  });

  it('shows the first 120 matching lines and says how many there were', () => {
    const s = make('Many lines', 'Use for many lines.', Array.from({ length: 150 }, (_, i) => `match ${i}`).join('\n'));
    const out = skills.searchSkill(s!.slug, 'match');
    const lines = out.split('\n');
    expect(lines[0]).toBe('SKILL.md:6: match 0');
    expect(lines[119]).toBe('SKILL.md:125: match 119');
    expect(lines.at(-1)).toBe('[First 120 of 150 matching lines: search for something narrower.]');
  });
});

describe('reading skills once', () => {
  const handMade = (slug: string, body: string) => {
    const dir = dataPath('skills', slug);
    fs.mkdirSync(path.join(dir, 'references'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${slug}\ndescription: Use it.\n---\n${body}`);
    fs.writeFileSync(path.join(dir, 'references', 'a.md'), 'first reference');
    settle(dir);
    return dir;
  };

  it('keeps a skill it has read until something in its folder changes', () => {
    const dir = handMade('kept-skill', 'Old steps.');
    expect(reads(dir, () => skills.getSkill('kept-skill'))).toEqual({ 'SKILL.md': 1 });
    // read once more for the prompt, the list and read_skill: nothing comes from disk
    expect(
      reads(dir, () => {
        expect(skills.getSkill('kept-skill')?.body).toBe('Old steps.');
        expect(skills.listSkills().find((s) => s.slug === 'kept-skill')?.preview).toBe('Old steps.');
        expect(skills.findSkill('kept-skill')?.files.map((f) => f.path)).toEqual(['references/a.md']);
        expect(skills.skillsPrompt({ skills: ['kept-skill'] })).toContain(
          'kept-skill: Use it. [id: kept-skill; has 1 extra file]',
        );
      }),
    ).toEqual({});
    // edited by hand
    fs.writeFileSync(
      path.join(dir, 'SKILL.md'),
      '---\nname: kept-skill\ndescription: Use it.\n---\nNew steps, longer.',
    );
    expect(skills.getSkill('kept-skill')?.body).toBe('New steps, longer.');
    settle(dir);
    skills.getSkill('kept-skill');
    // a file added in a folder of the skill
    fs.writeFileSync(path.join(dir, 'references', 'b.md'), 'second');
    expect(
      skills
        .getSkill('kept-skill')
        ?.files.map((f) => f.path)
        .sort(),
    ).toEqual(['references/a.md', 'references/b.md']);
    settle(dir);
    skills.getSkill('kept-skill');
    // where it was installed from
    fs.writeFileSync(
      path.join(dir, '.source.json'),
      JSON.stringify({ url: 'https://github.com/o/r', repo: 'o/r', ref: 'main', path: '', installedAt: 1 }),
    );
    expect(skills.getSkill('kept-skill')?.origin?.repo).toBe('o/r');
    // gone
    fs.rmSync(dir, { recursive: true, force: true });
    expect(skills.getSkill('kept-skill')).toBeNull();
    expect(skills.findSkill('kept-skill')).toBeNull();
  });

  it('reads a skill changed in the last moments again', () => {
    const s = make('Fresh skill');
    const dir = dataPath('skills', s!.slug);
    expect(
      reads(dir, () => {
        skills.getSkill(s!.slug);
        skills.getSkill(s!.slug);
      }),
    ).toEqual({ 'SKILL.md': 2 });
  });

  it("sees the dashboard's own changes at once", () => {
    const s = make('Edited skill', 'Use for edits.', 'First text.');
    const dir = dataPath('skills', s!.slug);
    settle(dir);
    expect(skills.getSkill(s!.slug)?.body.trim()).toBe('First text.');
    skills.saveSkill({ slug: s!.slug, name: 'Edited skill', description: 'Use for edits.', body: 'Second text.' });
    expect(skills.getSkill(s!.slug)?.body.trim()).toBe('Second text.');
    expect(skills.skillsPrompt({ skills: [s!.slug] })).toContain('Edited skill: Use for edits.');
    settle(dir);
    skills.getSkill(s!.slug);
    skills.restoreSkill(
      { slug: s!.slug, name: 'Edited skill', description: 'Use for old edits.', body: 'First text.' },
      'none',
    );
    expect(skills.findSkill('edited skill')).toMatchObject({ description: 'Use for old edits.' });
    settle(dir);
    skills.getSkill(s!.slug);
    skills.deleteSkill(s!.slug);
    expect(skills.getSkill(s!.slug)).toBeNull();
    expect(skills.listSkills().some((x) => x.slug === s!.slug)).toBe(false);
  });

  it("gives each caller its own copy, so changing one doesn't change the kept skill", () => {
    handMade('copied-skill', 'Steps.');
    skills.getSkill('copied-skill');
    skills.getSkill('copied-skill')!.files.push({ path: 'made-up.md', size: 1 });
    expect(skills.getSkill('copied-skill')?.files.map((f) => f.path)).toEqual(['references/a.md']);
  });

  it('searches with one read of the skill and of each file', () => {
    const dir = handMade('searched-skill', 'Find the needle here.');
    skills.getSkill('searched-skill');
    let out = '';
    expect(reads(dir, () => (out = skills.searchSkill('searched-skill', 'needle|reference')))).toEqual({
      'SKILL.md': 1,
      'references/a.md': 1,
    });
    expect(out).toBe('SKILL.md:5: Find the needle here.\nreferences/a.md:1: first reference');
  });
});

describe('who gets which skill', () => {
  it('combines the agent, its team and the project, without duplicates', () => {
    const a = make('Agent skill');
    const t = make('Team skill');
    const p = make('Project skill');
    const projects = listProjects();
    projects[0].skills = [p!.slug, a!.slug];
    saveProjects(projects);
    expect(activeProject().skills).toContain(p!.slug);
    const list = skills.skillsFor({ skills: [a!.slug] } as never, [t!.slug]);
    expect(list.map((s) => [s.slug, s.via])).toEqual([
      [a!.slug, 'agent'],
      [t!.slug, 'team'],
      [p!.slug, 'project'],
    ]);
  });

  it('lists skills in the instructions only when there are some', () => {
    const projects = listProjects();
    projects[0].skills = [];
    saveProjects(projects);
    expect(skills.skillsPrompt({ skills: [] } as never)).toBe('');
    const s = make('Checklist', 'Use before finishing a task.');
    const prompt = skills.skillsPrompt({ skills: [s!.slug] } as never);
    expect(prompt).toContain('# Your skills');
    expect(prompt).toContain('- Checklist: Use before finishing a task.');
    expect(prompt).toContain('read_skill');
  });
});

describe('importing a Claude Code skill', () => {
  const claudeSkill = (name: string) => {
    const dir = path.join(os.homedir(), '.claude', 'skills', name);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };

  it('copies its files but leaves out a linked folder', () => {
    const src = claudeSkill('with-link');
    fs.writeFileSync(path.join(src, 'SKILL.md'), '---\nname: With link\ndescription: Use it.\n---\n\nSteps.');
    fs.writeFileSync(path.join(src, 'notes.md'), 'extra');
    const outside = fs.mkdtempSync(path.join(os.homedir(), 'outside-skill-'));
    fs.writeFileSync(path.join(outside, 'private.md'), 'outside-sentinel');
    // (junctions need no admin rights on Windows; elsewhere this makes a plain folder link)
    fs.symlinkSync(outside, path.join(src, 'linked'), 'junction');
    const s = skills.importClaudeSkill('with-link');
    expect(s?.body).toContain('Steps.');
    expect(s?.files.map((f) => f.path)).toEqual(['notes.md']);
    expect(fs.existsSync(path.join(dataPath('skills', s!.slug), 'linked'))).toBe(false);
  });

  it('refuses a SKILL.md that is a link', (ctx) => {
    const src = claudeSkill('linked-md');
    const outside = path.join(fs.mkdtempSync(path.join(os.homedir(), 'outside-md-')), 'secret.md');
    fs.writeFileSync(outside, '---\nname: Secret\ndescription: x\n---\n\noutside-sentinel');
    try {
      fs.symlinkSync(outside, path.join(src, 'SKILL.md'));
    } catch (e) {
      // file links need admin rights on Windows
      if ((e as NodeJS.ErrnoException).code === 'EPERM') return ctx.skip();
      throw e;
    }
    expect(() => skills.importClaudeSkill('linked-md')).toThrow(/link/);
    expect(skills.listSkills().some((x) => x.preview?.includes('outside-sentinel'))).toBe(false);
  });
});
