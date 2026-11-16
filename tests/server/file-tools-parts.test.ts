// The Files tools in parts: reading ranges and several files, exact edits, finding and searching files.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { callTool } from '../../server/tools.ts';
import { applyEdits, globRegExp } from '../../server/filetools.ts';
import type { ToolAgent } from '../../server/tools.ts';

const linksWork = process.platform !== 'win32'; // links need admin rights on Windows

function setup() {
  const base = fs.mkdtempSync(path.join(os.homedir(), 'parts-'));
  const workspace = path.join(base, 'workspace');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(path.join(workspace, 'notes', 'old'), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.md'), 'private-sentinel');
  fs.writeFileSync(path.join(workspace, 'a.md'), '# Alpha\nfind-me here\n');
  fs.writeFileSync(path.join(workspace, 'notes', 'b.txt'), 'nothing\nFIND-ME too\n');
  fs.writeFileSync(path.join(workspace, 'notes', 'old', 'c.md'), 'old note\n');
  const agent: ToolAgent = {
    id: 'parts-agent',
    name: 'Parts',
    toolGroups: ['files'],
    autonomy: 'full',
    workspace,
    knowledge: { folders: [] },
  };
  return { workspace, outside, agent };
}

describe('read_file', () => {
  it('returns a whole small file exactly as it is', async () => {
    const { agent } = setup();
    expect((await callTool(agent, 'read_file', { path: 'a.md' })).text).toBe('# Alpha\nfind-me here\n');
  });

  it('reads a long file in parts and says where to continue', async () => {
    const { workspace, agent } = setup();
    fs.writeFileSync(
      path.join(workspace, 'long.txt'),
      Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`).join('\n'),
    );
    const first = (await callTool(agent, 'read_file', { path: 'long.txt' })).text;
    expect(first).toMatch(/^line 1\n/);
    expect(first).toMatch(/\[Lines 1-2000 of 5000\. Continue with offset 2001\.\]$/);
    const part = (await callTool(agent, 'read_file', { path: 'long.txt', offset: 4999, limit: 10 })).text;
    expect(part).toBe('line 4999\nline 5000\n\n[Lines 4999-5000 of 5000.]');
  });

  it('reads several files in one call, each on its own', async () => {
    const { agent } = setup();
    const r = (await callTool(agent, 'read_file', { paths: ['a.md', 'notes/b.txt', 'missing.txt'] })).text;
    expect(r).toContain('===== a.md =====\n# Alpha');
    expect(r).toContain('===== notes/b.txt =====\nnothing');
    expect(r).toMatch(/===== missing\.txt =====\nError: /);
  });

  it("says when a file isn't text, and refuses files outside the allowed folders", async () => {
    const { workspace, outside, agent } = setup();
    fs.writeFileSync(path.join(workspace, 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1]));
    expect((await callTool(agent, 'read_file', { path: 'pic.png' })).text).toMatch(/not a text file/);
    const r = await callTool(agent, 'read_file', { paths: [path.join(outside, 'secret.md')] });
    expect(r.text).not.toContain('private-sentinel');
  });
});

describe('edit_file', () => {
  it('replaces exact text once, and changes nothing when an edit does not fit', async () => {
    const { workspace, agent } = setup();
    const file = path.join(workspace, 'a.md');
    expect(
      (await callTool(agent, 'edit_file', { path: 'a.md', edits: [{ old: 'find-me', new: 'found' }] })).text,
    ).toMatch(/1 replacement\./);
    expect(fs.readFileSync(file, 'utf8')).toBe('# Alpha\nfound here\n');
    const r = await callTool(agent, 'edit_file', {
      path: 'a.md',
      edits: [
        { old: 'Alpha', new: 'Beta' },
        { old: 'not there', new: 'x' },
      ],
    });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/edit 2/);
    expect(fs.readFileSync(file, 'utf8')).toBe('# Alpha\nfound here\n');
  });

  it('asks for more context when the text is there more than once, or replaces all', () => {
    expect(() => applyEdits('a b a', [{ old: 'a', new: 'c' }])).toThrow(/2 times/);
    expect(applyEdits('a b a', [{ old: 'a', new: 'c', all: true }])).toEqual({ text: 'c b c', replaced: 2 });
    // ($& in the new text is written as it is)
    expect(applyEdits('x', [{ old: 'x', new: '$&$&' }]).text).toBe('$&$&');
  });

  it('keeps Windows line ends', () => {
    expect(applyEdits('one\r\ntwo\r\n', [{ old: 'one\ntwo', new: 'uno\ndos' }]).text).toBe('uno\r\ndos\r\n');
  });

  it("can't reach outside the allowed folders, and asks first like write_file", async () => {
    const { outside, agent } = setup();
    const r = await callTool(agent, 'edit_file', {
      path: path.join(outside, 'secret.md'),
      edits: [{ old: 'private', new: 'public' }],
    });
    expect(r.isError).toBe(true);
    expect(fs.readFileSync(path.join(outside, 'secret.md'), 'utf8')).toBe('private-sentinel');
  });
});

describe('find_files and search_files', () => {
  it('finds files by name pattern', async () => {
    const { agent } = setup();
    const all = (await callTool(agent, 'find_files', { pattern: '*.md' })).text;
    expect(all).toContain('a.md');
    expect(all).toContain('notes/old/c.md');
    expect(all).not.toContain('b.txt');
    expect((await callTool(agent, 'find_files', { pattern: 'notes/*.{txt,md}' })).text.split('\n').slice(1)).toEqual([
      'notes/b.txt',
    ]);
    expect((await callTool(agent, 'find_files', { pattern: '*.pdf' })).text).toMatch(/No file/);
  });

  it('turns globs into patterns', () => {
    expect(globRegExp('**/*.ts').test('a/b/c.ts')).toBe(true);
    expect(globRegExp('**/*.ts').test('c.ts')).toBe(true);
    expect(globRegExp('src/*.ts').test('src/a/b.ts')).toBe(false);
    expect(globRegExp('report-?.md').test('report-1.md')).toBe(true);
  });

  it('searches lines in any case, with file and line number', async () => {
    const { agent } = setup();
    const r = (await callTool(agent, 'search_files', { query: 'find-me' })).text;
    expect(r).toContain('a.md:2: find-me here');
    expect(r).toContain('notes/b.txt:2: FIND-ME too');
    expect((await callTool(agent, 'search_files', { query: 'find-me', glob: '*.txt' })).text).not.toContain('a.md');
    expect((await callTool(agent, 'search_files', { query: '^#\\s+Al' })).text).toContain('a.md:1:');
    expect((await callTool(agent, 'search_files', { query: 'find', path: 'a.md' })).text).toContain('a.md:2:');
  });

  it('searches a pattern that could take forever as plain text', async () => {
    const { workspace, agent } = setup();
    fs.writeFileSync(path.join(workspace, 'aaa.txt'), `${'a'.repeat(40)}!\n(a+)+$ literally\n`);
    const r = (await callTool(agent, 'search_files', { query: '(a+)+$' })).text;
    expect(r).toContain('aaa.txt:2:');
    expect(r).not.toContain('aaa.txt:1:');
    // a repeated choice that overlaps, a repeated optional part and a back-reference too, and quickly
    fs.writeFileSync(path.join(workspace, 'long.txt'), `${'a'.repeat(5000)}!\n`);
    const started = Date.now();
    for (const query of ['(a|aa)+$', '(a?)+$', '(a)\\1+$'])
      expect((await callTool(agent, 'search_files', { query })).text, query).toMatch(/^No line/);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it.skipIf(!linksWork)("doesn't follow links out of the allowed folders", async () => {
    const { workspace, outside, agent } = setup();
    fs.symlinkSync(outside, path.join(workspace, 'escape'));
    fs.symlinkSync(path.join(outside, 'secret.md'), path.join(workspace, 'secret-link.md'));
    expect((await callTool(agent, 'search_files', { query: 'private-sentinel' })).text).toMatch(/No line/);
    expect((await callTool(agent, 'find_files', { pattern: 'secret*' })).text).toMatch(/No file/);
    expect((await callTool(agent, 'list_files', { depth: 3 })).text).toContain('[link] escape');
  });
});

describe('list_files', () => {
  it('lists sizes, folders inside with depth, and says when it was cut', async () => {
    const { workspace, agent } = setup();
    const one = (await callTool(agent, 'list_files', {})).text;
    expect(one).toContain('[dir] notes');
    expect(one).toMatch(/a\.md {2}\d+ B/);
    expect(one).not.toContain('notes/b.txt');
    expect((await callTool(agent, 'list_files', { depth: 3 })).text).toContain('notes/old/c.md');
    for (let i = 0; i < 505; i++) fs.writeFileSync(path.join(workspace, 'notes', `f${i}.txt`), '');
    expect((await callTool(agent, 'list_files', { path: 'notes' })).text).toMatch(/\[\d+ more not shown/);
  });
});
