import { describe, expect, it } from 'vitest';
import { estimateTokens, measuredBy, memoryTokens, newestThatFits, seedPrompt } from '../../server/context.ts';
import { memoryStart } from '../../shared/context.ts';
import { chats } from '../../server/store.ts';
import { newAgent } from '../../server/library.ts';
import type { ChatItem } from '../../shared/types.ts';

describe('engine-owned context', () => {
  it('reseeds a CLI from complete originals after the last reset', () => {
    const result = 'Original result '.repeat(4000);
    const items: ChatItem[] = [
      { type: 'user', text: 'Forgotten' },
      { type: 'meta', text: 'Clear', reset: true },
      { type: 'user', text: 'Kept' },
      { type: 'compaction', id: 'native', text: '', mode: 'engine', trigger: 'auto', upto: 2 },
      { type: 'tool', id: 'read', name: 'read_file', args: { path: 'report' }, result, status: 'done' },
      { type: 'assistant', text: 'Answer' },
      { type: 'user', text: 'Next' },
    ];
    const seed = seedPrompt(items, 'Next', 128000);
    expect(seed).not.toContain('Forgotten');
    expect(seed).toContain(result);
    expect(seed.match(/Next/g)).toHaveLength(1);
    expect(seed).toContain('Answer');
    expect(memoryStart(items)).toBe(2);
  });

  it("gives a fresh CLI session the newest part of a chat that doesn't fit, from a question on, and says where the rest is", () => {
    const items: ChatItem[] = [
      { type: 'user', text: `First question ${'x '.repeat(5000)}` },
      { type: 'assistant', text: 'First answer' },
      { type: 'user', text: 'Second question' },
      { type: 'tool', id: 't', name: 'read_file', args: { path: 'a' }, result: 'Second result', status: 'done' },
      { type: 'assistant', text: 'Second answer' },
      { type: 'user', text: 'Next' },
    ];
    const seed = seedPrompt(items, 'Next', 4000);
    expect(seed).not.toContain('First question');
    // (the cut moves to where a question starts: an answer isn't kept without it)
    expect(seed).not.toContain('First answer');
    expect(seed).toContain('The 2 oldest messages of this chat are left out');
    expect(seed).toContain('search_conversations');
    expect(seed.indexOf('Second question')).toBeLessThan(seed.indexOf('Second result'));
    expect(seed).toContain('Second answer');
    expect(seed.endsWith('Current request:\nNext')).toBe(true);
    // (one that fits is sent whole, as before)
    expect(seedPrompt(items, 'Next', 128000)).toContain('First question');
  });

  it('keeps the newest items that fit, from where a turn opens', () => {
    const size = (n: number) => n;
    const opens = (n: number) => n === 1;
    expect(newestThatFits([5, 1, 2, 1, 3], size, 100, opens)).toEqual({ kept: [5, 1, 2, 1, 3], left: 0 });
    expect(newestThatFits([5, 1, 2, 1, 3], size, 6, opens)).toEqual({ kept: [1, 3], left: 3 });
    // (no turn opens in what fits: what fits is kept)
    expect(newestThatFits([1, 2, 3], size, 3, opens)).toEqual({ kept: [3], left: 2 });
    expect(newestThatFits([1, 2], size, 0, opens)).toEqual({ kept: [], left: 2 });
  });

  it('uses a matching engine measurement and otherwise estimates retained originals', () => {
    const agent = newAgent({ name: 'Context meter', engine: 'eve', provider: 'custom', model: 'one' });
    const chat = chats.create(agent.id);
    chat.items = [{ type: 'user', text: 'Some words' }];
    chat.context = { tokens: 321, by: measuredBy(agent), items: 1, at: Date.now() };
    expect(memoryTokens(chat, agent)).toBe(321);
    expect(memoryTokens(chat, { ...agent, model: 'two' })).toBeGreaterThan(1000);
    expect(estimateTokens('漢字😀')).toBeGreaterThan(estimateTokens('test'));
  });
});

describe('whose measurement a chat has', () => {
  it('is the model really used, its default one too, at the address it is asked at', async () => {
    const { saveSettings } = await import('../../server/store.ts');
    const { defaultModelForEngine } = await import('../../shared/modeldefaults.ts');
    const blank = { engine: 'eve', provider: 'custom', model: '' } as const;
    saveSettings({ providers: { custom: { baseUrl: 'http://127.0.0.1:1111/v1' } } });
    const here = measuredBy(blank);
    // the same model name at another address is another measurement
    saveSettings({ providers: { custom: { baseUrl: 'http://127.0.0.1:2222/v1' } } });
    expect(measuredBy(blank)).not.toBe(here);
    // no model set: the default one it runs on, as the transcript records it
    const { getSettings } = await import('../../server/store.ts');
    const used = defaultModelForEngine('eve', getSettings().defaults, 'custom');
    expect(measuredBy(blank)).toBe(measuredBy({ ...blank, model: used }));
    saveSettings({ providers: { custom: { baseUrl: '' } } });
  });
});
