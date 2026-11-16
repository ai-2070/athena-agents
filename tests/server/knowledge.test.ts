// An agent's knowledge: only plain text files in its folders, never a link to a file elsewhere.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addKnowledgeFile,
  clearKnowledgeCache,
  knowledgeCache,
  knowledgeContext,
  knowledgeFiles,
  knowledgeRoots,
  readKnowledge,
  removeKnowledgeFile,
  searchKnowledge,
} from '../../server/knowledge.ts';
import { projectData } from '../../server/store.ts';
import { toolsForAgent } from '../../server/tools.ts';

describe('knowledge files', () => {
  it('reads the plain text files in a linked folder', () => {
    const folder = fs.mkdtempSync(path.join(os.homedir(), 'kb-plain-'));
    fs.writeFileSync(path.join(folder, 'guide.md'), 'plain guide text');
    const agent = { id: 'kb-plain', knowledge: { folders: [folder] } };
    expect(knowledgeFiles(agent).map((f) => f.label)).toEqual([path.join(path.basename(folder), 'guide.md')]);
    expect(knowledgeContext(agent)).toContain('plain guide text');
  });

  it('leaves out a file link that points out of the folder', (ctx) => {
    const base = fs.mkdtempSync(path.join(os.homedir(), 'kb-link-'));
    const folder = path.join(base, 'kb');
    fs.mkdirSync(folder);
    const secret = path.join(base, 'secret.txt');
    fs.writeFileSync(secret, 'outside-sentinel-7171');
    try {
      fs.symlinkSync(secret, path.join(folder, 'reference.md'));
    } catch (e) {
      // file links need admin rights on Windows
      if ((e as NodeJS.ErrnoException).code === 'EPERM') return ctx.skip();
      throw e;
    }
    const agent = { id: 'kb-link', knowledge: { folders: [folder] } };
    expect(knowledgeFiles(agent)).toEqual([]);
    expect(knowledgeContext(agent)).not.toContain('outside-sentinel');
    expect(searchKnowledge(agent, 'outside-sentinel-7171')).toEqual([]);
    expect(() => readKnowledge(agent, 'reference.md')).toThrow(/No knowledge file/);
  });
});

describe('knowledge search', () => {
  // 100 lines: the phrase on line 5, one word three times on line 60
  const notes = (): string => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
    lines[4] = 'the alpha beta plan';
    lines[59] = 'alpha alpha alpha';
    return lines.join('\n');
  };
  const linked = (prefix: string, files: Record<string, string>): string => {
    const folder = fs.mkdtempSync(path.join(os.homedir(), prefix));
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(folder, name), text);
    return folder;
  };

  it('scores 40-line passages that overlap by half, best first, with a bonus for the whole phrase', () => {
    const folder = linked('kb-rank-', { 'notes.md': notes(), 'other.txt': 'beta only here' });
    const agent = { id: 'kb-rank', knowledge: { folders: [folder] } };
    const base = path.basename(folder);
    const hits = searchKnowledge(agent, 'Alpha beta');
    expect(hits.map((h) => [h.file, h.line])).toEqual([
      [path.join(base, 'notes.md'), 1],
      [path.join(base, 'notes.md'), 21],
      [path.join(base, 'notes.md'), 41],
      [path.join(base, 'other.txt'), 1],
    ]);
    // each word: 1 + ln(times it appears); the whole query once more: +3
    expect(hits[0].score).toBeCloseTo(2 + 3, 10);
    expect(hits[1].score).toBeCloseTo(1 + Math.log(3), 10);
    expect(hits[2].score).toBeCloseTo(1 + Math.log(3), 10);
    expect(hits[3].score).toBe(1);
    const lines = notes().split('\n');
    expect(hits[0].text).toBe(lines.slice(0, 40).join('\n'));
    expect(hits[1].text).toBe(lines.slice(20, 60).join('\n'));
    expect(hits[3].text).toBe('beta only here');
  });

  it('gives at most the limit, counts a word up to 20 times, and skips one-letter words', () => {
    const folder = linked('kb-limit-', {
      'many.md': Array.from({ length: 200 }, () => 'gamma').join('\n'),
      'dense.md': 'delta '.repeat(25),
    });
    const agent = { id: 'kb-limit', knowledge: { folders: [folder] } };
    expect(searchKnowledge(agent, 'gamma')).toHaveLength(6);
    expect(searchKnowledge(agent, 'gamma', 2)).toHaveLength(2);
    expect(searchKnowledge(agent, 'delta')[0].score).toBeCloseTo(1 + Math.log(20) + 3, 10);
    expect(searchKnowledge(agent, 'a')).toEqual([]);
    expect(searchKnowledge(agent, '')).toEqual([]);
  });

  it("keeps passages that score the same in file order: the agent's own files first", () => {
    const agent = { id: 'kb-ties', knowledge: { folders: [linked('kb-ties-', { 'theirs.md': 'epsilon here' })] } };
    addKnowledgeFile(agent.id, 'mine.md', 'epsilon here');
    expect(searchKnowledge(agent, 'epsilon').map((h) => h.file)).toEqual([
      'mine.md',
      path.join(path.basename(agent.knowledge.folders[0]), 'theirs.md'),
    ]);
  });

  it('cuts a passage to 1600 characters', () => {
    const agent = {
      id: 'kb-long',
      knowledge: { folders: [linked('kb-long-', { 'long.md': `zeta ${'x'.repeat(5000)}` })] },
    };
    const [hit] = searchKnowledge(agent, 'zeta');
    expect(hit.text).toHaveLength(1600);
  });

  it('lists big knowledge instead of putting it in the instructions', () => {
    const agent = { id: 'kb-big', knowledge: { folders: [linked('kb-big-', { 'big.md': 'eta '.repeat(8000) })] } };
    const ctx = knowledgeContext(agent);
    expect(ctx).toContain('You have 1 reference files (31 KB)');
    expect(ctx).toContain(`- ${path.join(path.basename(agent.knowledge.folders[0]), 'big.md')} (31 KB)`);
    expect(ctx).not.toContain('eta eta');
  });
});

describe('knowledge kept between calls', () => {
  const real = { ...knowledgeCache };
  afterEach(() => {
    Object.assign(knowledgeCache, real);
    clearKnowledgeCache();
    vi.restoreAllMocks();
  });
  const folderWith = (prefix: string, files: Record<string, string>): string => {
    const folder = fs.mkdtempSync(path.join(os.homedir(), prefix));
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(folder, name), text);
    return folder;
  };
  // Make the files look a minute old: a file changed in the last moments is always read again.
  const settle = (...files: string[]) => {
    const old = new Date(Date.now() - 60_000);
    for (const f of files) fs.utimesSync(f, old, old);
  };
  // Which files are read from disk while fn runs (opened: only their start is read, never the whole file).
  const reads = (fn: () => void): string[] => {
    const spy = vi.spyOn(fs, 'openSync');
    try {
      fn();
      return spy.mock.calls
        .map(([p]) => (typeof p === 'string' ? path.basename(p) : ''))
        .filter((n) => n.endsWith('.md'))
        .sort();
    } finally {
      spy.mockRestore();
    }
  };
  const labels = (agent: Parameters<typeof knowledgeFiles>[0]) =>
    knowledgeFiles(agent)
      .map((f) => f.label)
      .sort();

  it("lists files added or removed through the dashboard at once, and a linked folder's other changes after a few seconds", () => {
    let now = 1_000_000;
    knowledgeCache.now = () => now;
    const folder = folderWith('kb-window-', { 'first.md': 'first' });
    const agent = { id: 'kb-window', knowledge: { folders: [folder] } };
    const base = path.basename(folder);
    expect(labels(agent)).toEqual([path.join(base, 'first.md')]);
    addKnowledgeFile(agent.id, 'mine.md', 'my note');
    expect(labels(agent)).toEqual(['mine.md', path.join(base, 'first.md')].sort());
    removeKnowledgeFile(agent.id, 'mine.md');
    expect(labels(agent)).toEqual([path.join(base, 'first.md')]);
    // another folder linked: a new list at once
    const other = folderWith('kb-window-other-', { 'other.md': 'other' });
    expect(labels({ ...agent, knowledge: { folders: [folder, other] } })).toEqual(
      [path.join(base, 'first.md'), path.join(path.basename(other), 'other.md')].sort(),
    );
    // changed outside the dashboard: shown once the list's time is up
    fs.writeFileSync(path.join(folder, 'second.md'), 'second');
    expect(labels(agent)).toEqual([path.join(base, 'first.md')]);
    now += knowledgeCache.listMs - 1;
    expect(labels(agent)).toEqual([path.join(base, 'first.md')]);
    now += 1;
    expect(labels(agent)).toEqual([path.join(base, 'first.md'), path.join(base, 'second.md')].sort());
  });

  it("doesn't make a knowledge folder just by looking", () => {
    const agent = { id: 'kb-nobody' };
    const dir = projectData('knowledge', agent.id);
    expect(knowledgeFiles(agent)).toEqual([]);
    expect(knowledgeContext(agent)).toBe('');
    expect(searchKnowledge(agent, 'anything')).toEqual([]);
    expect(() => readKnowledge(agent, 'x.md')).toThrow(/No knowledge file/);
    expect(knowledgeRoots(agent)).toEqual([]);
    expect(toolsForAgent({ id: agent.id, name: 'Nobody', toolGroups: [] }).map((t) => t.name)).not.toContain(
      'knowledge_search',
    );
    expect(fs.existsSync(dir)).toBe(false);
    // the folder is made when a file is added, and then it is one the agent may read
    addKnowledgeFile(agent.id, 'note.md', 'hello');
    expect(knowledgeRoots(agent)).toEqual([dir]);
    expect(toolsForAgent({ id: agent.id, name: 'Nobody', toolGroups: [] }).map((t) => t.name)).toContain(
      'knowledge_search',
    );
  });

  it('searches again reading only the files that changed, with the same results', () => {
    const folder = folderWith('kb-reread-', { 'one.md': 'omega in one\nmore', 'two.md': 'omega omega in two' });
    const agent = { id: 'kb-reread', knowledge: { folders: [folder] } };
    settle(path.join(folder, 'one.md'), path.join(folder, 'two.md'));
    let first: ReturnType<typeof searchKnowledge> = [];
    expect(reads(() => (first = searchKnowledge(agent, 'omega')))).toEqual(['one.md', 'two.md']);
    let again: ReturnType<typeof searchKnowledge> = [];
    expect(reads(() => (again = searchKnowledge(agent, 'omega')))).toEqual([]);
    expect(again).toEqual(first);
    expect(reads(() => knowledgeContext(agent))).toEqual([]);
    // edited outside the dashboard: read again at once, even while the list is kept
    fs.writeFileSync(path.join(folder, 'one.md'), 'omega omega omega in one, longer');
    expect(reads(() => (again = searchKnowledge(agent, 'omega')))).toEqual(['one.md']);
    expect(again[0]).toMatchObject({
      file: path.join(path.basename(folder), 'one.md'),
      text: 'omega omega omega in one, longer',
    });
    expect(knowledgeContext(agent)).toContain('omega omega omega in one, longer');
  });

  it('keeps no more text than its limit, dropping the least recently used', () => {
    const folder = folderWith('kb-limit-', { 'a.md': `theta ${'a'.repeat(94)}`, 'b.md': `theta ${'b'.repeat(94)}` });
    const agent = { id: 'kb-cap', knowledge: { folders: [folder] } };
    settle(path.join(folder, 'a.md'), path.join(folder, 'b.md'));
    const first = searchKnowledge(agent, 'theta');
    expect(reads(() => expect(searchKnowledge(agent, 'theta')).toEqual(first))).toEqual([]);
    // room for one of the two (200 bytes each): every search reads both again, with the same answer
    clearKnowledgeCache();
    knowledgeCache.maxBytes = 300;
    expect(reads(() => expect(searchKnowledge(agent, 'theta')).toEqual(first))).toEqual(['a.md', 'b.md']);
    expect(reads(() => expect(searchKnowledge(agent, 'theta')).toEqual(first))).toEqual(['a.md', 'b.md']);
    // a file bigger than the limit is never kept
    knowledgeCache.maxBytes = 100;
    clearKnowledgeCache();
    searchKnowledge(agent, 'theta');
    expect(reads(() => searchKnowledge(agent, 'theta'))).toEqual(['a.md', 'b.md']);
  });

  it('never reads a listed file that became a link while the list was kept', (ctx) => {
    const base = fs.mkdtempSync(path.join(os.homedir(), 'kb-swap-'));
    const folder = path.join(base, 'kb');
    fs.mkdirSync(folder);
    const secret = path.join(base, 'secret.txt');
    fs.writeFileSync(secret, 'swap-sentinel-4242');
    fs.writeFileSync(path.join(folder, 'reference.md'), 'harmless');
    const agent = { id: 'kb-swap', knowledge: { folders: [folder] } };
    expect(knowledgeFiles(agent)).toHaveLength(1);
    fs.rmSync(path.join(folder, 'reference.md'));
    try {
      fs.symlinkSync(secret, path.join(folder, 'reference.md'));
    } catch (e) {
      // file links need admin rights on Windows
      if ((e as NodeJS.ErrnoException).code === 'EPERM') return ctx.skip();
      throw e;
    }
    expect(knowledgeFiles(agent)).toHaveLength(1);
    expect(knowledgeContext(agent)).not.toContain('swap-sentinel');
    expect(searchKnowledge(agent, 'swap-sentinel-4242')).toEqual([]);
    expect(readKnowledge(agent, 'reference.md').text).not.toContain('swap-sentinel');
  });
});

describe('adding a knowledge file', () => {
  it("refuses one that isn't text, instead of saving its bytes as Markdown", () => {
    expect(() => addKnowledgeFile('kb-binary', 'contract.pdf', '%PDF-1.4 garbled')).toThrow(/isn't a text file/);
    expect(() => addKnowledgeFile('kb-binary', 'notes', 'a\u0000b')).toThrow(/isn't a text file/);
    expect(fs.readFileSync(addKnowledgeFile('kb-binary', 'notes', 'plain words'), 'utf8')).toBe('plain words');
  });
});

describe('knowledge that is long or has two files of one name', () => {
  const folderOf = (prefix: string, files: Record<string, string>): string => {
    const folder = fs.mkdtempSync(path.join(os.homedir(), prefix));
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(folder, name), text);
    return folder;
  };

  it('numbers a second file of the same name, so a search hit opens the file it came from', () => {
    const a = folderOf('kb-same-', {});
    fs.mkdirSync(path.join(a, 'docs'));
    fs.writeFileSync(path.join(a, 'docs', 'README.md'), 'alpha only');
    const other = folderOf('kb-same-other-', {});
    fs.rmSync(other, { recursive: true });
    fs.mkdirSync(path.join(other, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(other, 'docs', 'README.md'), 'beta only');
    // two linked folders named docs: their READMEs have the same label
    const agent = { id: 'kb-same', knowledge: { folders: [path.join(a, 'docs'), path.join(other, 'docs')] } };
    const hit = searchKnowledge(agent, 'beta')[0]!;
    expect(hit.file).toBe(path.join('docs', 'README.md (2)'));
    expect(readKnowledge(agent, hit.file).text).toBe('beta only');
  });

  it('shows a long passage around what matched', () => {
    const lines = Array.from({ length: 40 }, (_, i) => (i === 35 ? 'the needle is here' : 'x'.repeat(60)));
    const agent = {
      id: 'kb-snippet',
      knowledge: { folders: [folderOf('kb-snippet-', { 'long.md': lines.join('\n') })] },
    };
    expect(searchKnowledge(agent, 'needle')[0]!.text).toContain('the needle is here');
  });

  it('puts files in the instructions only when what they hold now is small enough', () => {
    const folder = folderOf('kb-grown-', { 'small.md': 'tiny' });
    const agent = { id: 'kb-grown', knowledge: { folders: [folder] } };
    expect(knowledgeContext(agent)).toContain('tiny');
    // it grows a lot before the kept list is looked at again
    fs.writeFileSync(path.join(folder, 'small.md'), 'y'.repeat(100_000));
    expect(knowledgeContext(agent)).toContain('Search them with knowledge_search');
  });
});
