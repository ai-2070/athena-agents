import { describe, expect, it } from 'vitest';
import { estimateTokens, measuredBy, memoryTokens, seedPrompt } from '../../server/context.ts';
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
    expect(() => seedPrompt(items, 'Next', 100)).toThrow('No original messages were discarded');
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
