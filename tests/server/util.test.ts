import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  dataPath,
  DATA,
  parseFrontmatter,
  readJSON,
  renderTemplate,
  run,
  slugify,
  truncate,
  uid,
  writeJSON,
} from '../../server/util.ts';

describe('util', () => {
  it('uses the throwaway data folder from DASH_DATA', () => {
    expect(DATA).toBe(path.resolve(process.env.DASH_DATA!));
    expect(dataPath('a', 'b.json')).toBe(path.join(DATA, 'a', 'b.json'));
  });

  it('slugify makes safe ids', () => {
    expect(slugify('Hello World!')).toBe('hello-world');
    expect(slugify('  Ünïcode — Test  ')).toMatch(/^[a-z0-9-]+$/);
    // never an empty id
    expect(slugify('')).toBe('item');
  });

  it('uid is unique and keeps its prefix', () => {
    const a = uid('r');
    const b = uid('r');
    expect(a).not.toBe(b);
    expect(a.startsWith('r')).toBe(true);
  });

  it('writeJSON / readJSON round-trip, with a fallback for missing or broken files', () => {
    const file = dataPath('t', 'x.json');
    writeJSON(file, { n: 1, list: ['a'] });
    expect(readJSON<{ n: number; list: string[] }>(file, null)).toEqual({ n: 1, list: ['a'] });
    expect(readJSON(dataPath('t', 'missing.json'), { fallback: true })).toEqual({ fallback: true });
    fs.writeFileSync(dataPath('t', 'broken.json'), '{ not json');
    expect(readJSON(dataPath('t', 'broken.json'), null)).toBeNull();
  });

  it('renderTemplate fills {{placeholders}}', () => {
    expect(renderTemplate('Hi {{name}}, {{missing}}!', { name: 'Ada' })).toContain('Hi Ada');
  });

  it('truncate keeps short text and shortens long text', () => {
    expect(truncate('short', 100)).toBe('short');
    const long = truncate('x'.repeat(500), 100);
    expect(long.length).toBeLessThan(200);
  });

  it('parseFrontmatter splits meta and body', () => {
    const r = parseFrontmatter('---\nname: Writer\ndescription: writes\n---\nBody text');
    expect(r.meta.name).toBe('Writer');
    expect(r.meta.description).toBe('writes');
    expect(r.body.trim()).toBe('Body text');
    expect(parseFrontmatter('no frontmatter').body).toBe('no frontmatter');
  });
});

// Stop and the time limit end what a command started too, not only the shell (Windows: taskkill /t does).
describe.skipIf(process.platform === 'win32')('run() stopping a command', () => {
  const gone = (pid: number) => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  };

  it('ends what it started when the time is up, and does not wait on it', async () => {
    const started = Date.now();
    const r = await run('sh', ['-c', 'sleep 30 & echo $!; wait'], { timeout: 500 });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(r.stderr).toContain('timed out');
    const pid = Number(r.stdout.trim());
    expect(pid).toBeGreaterThan(0);
    for (const end = Date.now() + 5000; !gone(pid) && Date.now() < end;) await new Promise((r) => setTimeout(r, 50));
    expect(gone(pid)).toBe(true);
  });

  it('ends what it started when stopped', async () => {
    const stop = new AbortController();
    const pending = run('sh', ['-c', 'sleep 30 & echo $!; wait'], { timeout: 60_000, signal: stop.signal });
    await new Promise((r) => setTimeout(r, 300));
    stop.abort();
    const r = await pending;
    expect(r.stderr).toContain('[stopped]');
    const pid = Number(r.stdout.trim());
    for (const end = Date.now() + 5000; !gone(pid) && Date.now() < end;) await new Promise((r) => setTimeout(r, 50));
    expect(gone(pid)).toBe(true);
  });
});

describe('run() with a lot of output', () => {
  it('keeps the start and the real end, saying how much was left out', async () => {
    const r = await run(process.execPath, ['-e', "process.stdout.write('start' + 'x'.repeat(5000) + 'the real end')"], {
      maxBytes: 200,
    });
    expect(r.stdout.startsWith('start')).toBe(true);
    expect(r.stdout.endsWith('the real end')).toBe(true);
    expect(r.stdout).toMatch(/characters left out/);
    expect(r.stdout.length).toBeLessThan(300);
  });
});
