// The cost and token line after a run stays in the saved chat but is not shown.
import { describe, expect, it } from 'vitest';
import type { ChatItem } from '../../shared/types.ts';
import { isUsageLine, toUIMessages } from '../../web/chat/messages.ts';

describe('usage lines in the chat', () => {
  it('leaves out cost and token lines, keeps other notes', () => {
    const items: ChatItem[] = [
      { type: 'user', text: 'hi' },
      { type: 'assistant', text: 'hello' },
      { type: 'meta', text: '$0.0000 · 11392 from cache' },
      { type: 'meta', text: 'Estimated $0.0100 USD equivalent', billing: { source: 'estimated' } },
      { type: 'meta', text: 'Memory summary · Cost not reported · 20 tokens' },
      { type: 'meta', text: 'Memory cleared: the agent starts fresh from here.', reset: true },
      { type: 'meta', text: 'Goal reached.' },
    ];
    const shown = toUIMessages(items).flatMap((m) => m.parts).flatMap((p) => (p.type === 'data-meta' ? [(p.data as { text: string }).text] : []));
    expect(shown).toEqual(['Memory cleared: the agent starts fresh from here.', 'Goal reached.']);
    expect(isUsageLine({ type: 'meta', text: 'Cost unavailable' })).toBe(true);
  });
});
