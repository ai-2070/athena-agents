// A team chat's "Show the work" leaves out the reply the thread already shows.
import { describe, expect, it } from 'vitest';
import type { ChatItem } from '../../shared/types.ts';
import { toUIMessages, withoutReply } from '../../web/chat/messages.ts';

const texts = (items: ChatItem[], reply: string) =>
  withoutReply(toUIMessages(items), reply).flatMap((m) =>
    m.parts.map((p) => (p.type === 'text' ? p.text : p.type === 'dynamic-tool' ? `tool:${p.toolName}` : p.type)),
  );

describe('a turn without its reply', () => {
  it('drops the closing text the reply already says, keeps the steps', () => {
    const items: ChatItem[] = [
      { type: 'assistant', text: 'Reading the brief.' },
      { type: 'tool', id: 't1', name: 'read_file', args: {}, result: 'the brief', status: 'done' },
      { type: 'assistant', text: 'Short answer: mostly no.\n\nWhy most are off-target' },
    ];
    expect(texts(items, '  Short answer: mostly no.\n\nWhy most are off-target\n')).toEqual([
      'Reading the brief.',
      'tool:read_file',
    ]);
  });

  it('keeps text the reply does not contain, and everything when the turn was stopped', () => {
    const items: ChatItem[] = [
      { type: 'tool', id: 't1', name: 'read_file', args: {}, result: 'x', status: 'done' },
      { type: 'assistant', text: 'Halfway there.' },
    ];
    expect(texts(items, 'Something else entirely')).toEqual(['tool:read_file', 'Halfway there.']);
    expect(texts(items, '(stopped)')).toEqual(['tool:read_file', 'Halfway there.']);
    expect(texts(items, '')).toEqual(['tool:read_file', 'Halfway there.']);
  });
});
