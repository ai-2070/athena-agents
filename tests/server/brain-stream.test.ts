// The Brain's model, streamed: think() hands its text over as it is written (OpenRouter's SSE here),
// and run() reads a program's output line by line as it comes.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { saveSettings, setSecret } from '../../server/store.ts';
import { think } from '../../server/brain.ts';
import type { ThinkPart } from '../../server/brain.ts';
import { run } from '../../server/util.ts';

afterEach(() => vi.unstubAllGlobals());

describe('think() with onPart', () => {
  it('OpenRouter: asks for a stream and hands each piece over as it comes', async () => {
    setSecret('openrouterKey', 'sk-or-test');
    saveSettings({ brain: { provider: 'openrouter', model: 'mock' } });
    let asked: Record<string, unknown> = {};
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      asked = JSON.parse(String(init.body));
      const enc = new TextEncoder();
      const lines = ['Plan', ' ready.'].map((d) => `data: ${JSON.stringify({ choices: [{ delta: { content: d } }] })}\n\n`).join('') + 'data: [DONE]\n\n';
      return new Response(new ReadableStream({ start: (c) => (c.enqueue(enc.encode(lines)), c.close()) }), { status: 200 });
    });
    const parts: ThinkPart[] = [];
    const text = await think('system', 'user', { onPart: (p) => parts.push(p) });
    expect(asked.stream).toBe(true);
    expect(text).toBe('Plan ready.');
    expect(parts).toEqual([
      { kind: 'text', text: 'Plan' },
      { kind: 'text', text: ' ready.' },
    ]);
  });

  it('without onPart nothing changes: one answer, not a stream', async () => {
    setSecret('openrouterKey', 'sk-or-test');
    saveSettings({ brain: { provider: 'openrouter', model: 'mock' } });
    let asked: Record<string, unknown> = {};
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      asked = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: 'Whole answer.' } }] }), { status: 200 });
    });
    expect(await think('system', 'user')).toBe('Whole answer.');
    expect(asked.stream).toBeUndefined();
  });
});

describe('run() with onLine', () => {
  it("gets each line of a program's output as it comes, the last one too", async () => {
    const lines: string[] = [];
    const r = await run(process.execPath, ['-e', "process.stdout.write('one\\ntwo\\nthree')"], { onLine: (l) => lines.push(l) });
    expect(r.code).toBe(0);
    expect(lines).toEqual(['one', 'two', 'three']);
  });
});
