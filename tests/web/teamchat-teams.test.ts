// Other teams in a team chat: #Team Name is highlighted like @Name, and a quote names the team.
import { describe, expect, it } from 'vitest';
import { mentionPattern, senderName } from '../../web/teamchat.ts';
import type { TeamMessage } from '../../shared/types.ts';

const marked = (re: RegExp, text: string) => [...text.matchAll(re)].map((m) => m[0]);

describe('mentionPattern()', () => {
  it('marks @Names and #Teams, longest names first', () => {
    const re = mentionPattern(['Ana', 'everyone'], ['Design', 'Design Ops']);
    expect(marked(re, '@Ana ask #Design Ops, then #design')).toEqual(['@Ana', '#Design Ops', '#design']);
  });
  it('leaves links, longer words and headings alone', () => {
    const re = mentionPattern(['Ana'], ['Design']);
    expect(marked(re, 'see x.com/a#Design, a#Design, #Designers and # Design')).toEqual([]);
  });
  it('works with no other teams', () => {
    expect(marked(mentionPattern(['Ana'], []), '@Ana and #Design')).toEqual(['@Ana']);
  });
});

describe('senderName()', () => {
  const msg = (m: Partial<TeamMessage>): TeamMessage => ({ id: 'm', ts: 0, from: 'user', text: '', mentions: [], ...m });
  it('names another team, you, the Brain and agents', () => {
    expect(senderName(msg({ from: 'team:t1', relay: { teamId: 't1', teamName: 'Design', by: 'a1', byName: 'Ana' } }), () => 'x')).toBe('#Design');
    expect(senderName(msg({ from: 'user' }), () => 'x')).toBe('You');
    expect(senderName(msg({ from: 'brain' }), () => 'x')).toBe('Brain');
    expect(senderName(msg({ from: 'a1' }), (id) => (id === 'a1' ? 'Ana' : undefined))).toBe('Ana');
  });
});
