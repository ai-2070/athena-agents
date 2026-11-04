// An agent's knowledge: only plain text files in its folders, never a link to a file elsewhere.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { addKnowledgeFile, knowledgeContext, knowledgeFiles, readKnowledge, searchKnowledge } from '../../server/knowledge.ts';

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
    const folder = linked('kb-limit-', { 'many.md': Array.from({ length: 200 }, () => 'gamma').join('\n'), 'dense.md': 'delta '.repeat(25) });
    const agent = { id: 'kb-limit', knowledge: { folders: [folder] } };
    expect(searchKnowledge(agent, 'gamma')).toHaveLength(6);
    expect(searchKnowledge(agent, 'gamma', 2)).toHaveLength(2);
    expect(searchKnowledge(agent, 'delta')[0].score).toBeCloseTo(1 + Math.log(20) + 3, 10);
    expect(searchKnowledge(agent, 'a')).toEqual([]);
    expect(searchKnowledge(agent, '')).toEqual([]);
  });

  it('keeps passages that score the same in file order: the agent\'s own files first', () => {
    const agent = { id: 'kb-ties', knowledge: { folders: [linked('kb-ties-', { 'theirs.md': 'epsilon here' })] } };
    addKnowledgeFile(agent.id, 'mine.md', 'epsilon here');
    expect(searchKnowledge(agent, 'epsilon').map((h) => h.file)).toEqual(['mine.md', path.join(path.basename(agent.knowledge.folders[0]), 'theirs.md')]);
  });

  it('cuts a passage to 1600 characters', () => {
    const agent = { id: 'kb-long', knowledge: { folders: [linked('kb-long-', { 'long.md': `zeta ${'x'.repeat(5000)}` })] } };
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
