// Session search (Settings › Session search): off by default; on, every agent, team member and the Brain can
// search and read every saved session in the project, except gateway conversations.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newAgent } from '../../server/library.ts';
import { activeProject, chats, saveSettings, getSettings, workflows } from '../../server/store.ts';
import { dataPath, writeJSON } from '../../server/util.ts';
import { filePast } from '../../server/pastchats.ts';
import type { ThreadMeta } from '../../server/pastchats.ts';
import { callTool, toolsForAgent } from '../../server/tools.ts';
import { brainSessionsInstructions, readSession, searchSessions } from '../../server/sessions.ts';
import { ask, clearHistory } from '../../server/overseer.ts';
import type { SessionReadResult, SessionSearchResult, Team } from '../../shared/types.ts';

const answers: string[] = [];
const asked: { system: string; user: string }[] = [];
vi.mock('../../server/brainrun.ts', async (orig) => ({
  ...(await orig<typeof import('../../server/brainrun.ts')>()),
  runBrain: (await import('./brain-fake.ts')).thinkingBrain,
}));
vi.mock('../../server/brain.ts', async (orig) => ({
  ...(await orig<typeof import('../../server/brain.ts')>()),
  brainModel: () => ({ provider: 'openrouter', model: 'mock', fallback: false }),
  think: async (system: string, user: string) => {
    asked.push({ system, user });
    return answers.shift() ?? 'NOTHING';
  },
}));

type Past = ThreadMeta & { messages: unknown[] };
const GATEWAY = 'telegram-123';
let n = 0;
/** Sessions everywhere in the project, each holding the marker word. */
function setup() {
  const word = `MARKER${++n}X`;
  const me = newAgent({ name: `Searcher ${n}`, toolGroups: [] });
  const other = newAgent({ name: `Other ${n}`, toolGroups: [] });
  const team = workflows.save({ name: `Team ${n}`, members: [other.id], lead: null, steps: [] } as Partial<Team>);
  const chat = chats.create(other.id, 'Other chat');
  chat.items.push({ type: 'user', text: `Plan: ${word} in the agent chat`, ts: 10 });
  chats.save(chat);
  const gateway = chats.create(other.id, 'Telegram');
  gateway.items.push({ type: 'user', text: `${word} GATEWAY_SECRET`, ts: 11 });
  gateway.conversationId = GATEWAY;
  chats.save(gateway);
  const pid = activeProject().id;
  writeJSON(dataPath('projects', pid, 'teamchats', `${team.id}.json`), {
    id: 't-open',
    messages: [{ id: 'm1', ts: 20, from: 'user', text: `${word} in the open team thread`, mentions: [] }],
    sessions: {},
    seen: {},
  });
  const pastTeam = filePast<Past>(
    { kind: 'team', id: team.id },
    { messages: [{ id: 'm0', ts: 5, from: other.id, text: `${word} in a past team thread`, mentions: [] }] },
  );
  writeJSON(dataPath('projects', pid, 'brain-chat.json'), {
    id: 't-brain',
    messages: [
      { role: 'user', text: `What about ${word}?`, ts: 30 },
      { role: 'brain', text: `${word} is in the Brain chat`, ts: 31 },
    ],
  });
  const pastBrain = filePast<Past>(
    { kind: 'brain' },
    { messages: [{ role: 'user', text: `Old ${word} question`, ts: 1 }] },
  );
  return { word, me, other, team, chat, gateway, pastTeam, pastBrain };
}

beforeEach(() => {
  answers.length = 0;
  asked.length = 0;
  clearHistory();
});
afterEach(() => saveSettings({ sessionSearch: false }));

describe('session search', () => {
  it('is off by default: agents and the Brain get nothing, and calls are refused', async () => {
    const { me, word } = setup();
    expect(getSettings().sessionSearch).toBe(false);
    const names = toolsForAgent(me).map((t) => t.name);
    expect(names).not.toContain('search_sessions');
    expect(names).not.toContain('read_session');
    expect(names).toContain('search_conversations');
    expect(brainSessionsInstructions()).toBe('');
    const r = await callTool(me, 'search_sessions', { query: word });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('Session search is off');
    expect(() => searchSessions({ query: word })).toThrow(/off/);
  });

  it('on, finds every agent chat, team thread and Brain conversation, but no gateway chat', async () => {
    const { me, other, team, chat, pastTeam, pastBrain, word } = setup();
    saveSettings({ sessionSearch: true });
    expect(toolsForAgent(me).find((t) => t.name === 'search_sessions')).toMatchObject({ group: 'core', risk: 'none' });
    expect(toolsForAgent(me).map((t) => t.name)).toContain('read_session');
    const r = await callTool(me, 'search_sessions', { query: `${word.toLowerCase()}` });
    expect(r.isError).toBe(false);
    const data = JSON.parse(r.text) as SessionSearchResult;
    expect(r.text).not.toContain('GATEWAY_SECRET');
    expect(data.total).toBe(6);
    const found = data.hits.map((h) => `${h.source}/${h.owner}/${h.sessionId}/${h.messageId}`).sort();
    expect(found).toEqual(
      [
        `agent/${other.id}/${chat.id}/0`,
        `brain/brain/${pastBrain}/0`,
        'brain/brain/t-brain/0',
        'brain/brain/t-brain/1',
        `team/${team.id}/${pastTeam}/m0`,
        `team/${team.id}/t-open/m1`,
      ].sort(),
    );
    // newest first
    expect(data.hits[0]).toMatchObject({ source: 'brain', messageId: '1', ownerName: 'The Brain' });
    // narrowed to one kind and one owner
    const teamOnly = searchSessions({ query: word, source: 'team' });
    expect(teamOnly.hits.every((h) => h.source === 'team')).toBe(true);
    expect(teamOnly.total).toBe(2);
    expect(searchSessions({ query: word, owner: other.id }).total).toBe(1);
    // every hit reads back
    for (const hit of data.hits) {
      const read = await callTool(me, 'read_session', { ...hit });
      expect(read.isError).toBe(false);
      expect((JSON.parse(read.text) as SessionReadResult).text).toContain(word);
    }
  });

  it('refuses gateway chats and conversations, unknown sessions, stand-ins and borrowed runs', async () => {
    const { me, other, gateway, word } = setup();
    saveSettings({ sessionSearch: true });
    expect(() => readSession({ source: 'agent', owner: other.id, sessionId: gateway.id, messageId: '0' })).toThrow(
      /not found/,
    );
    // a run in a gateway conversation gets no session search at all
    expect(toolsForAgent(me, { conversationId: GATEWAY }).map((t) => t.name)).not.toContain('search_sessions');
    expect(() => searchSessions({ query: word }, GATEWAY)).toThrow(/not available/);
    expect(brainSessionsInstructions(GATEWAY)).toBe('');
    // (a Tasks board conversation keeps it)
    expect(toolsForAgent(me, { conversationId: 'board-7' }).map((t) => t.name)).toContain('search_sessions');
    for (const bad of [
      { source: 'agent', owner: other.id, sessionId: '../secrets', messageId: '0' },
      { source: 'team', owner: 'nope', sessionId: 't-open', messageId: 'm1' },
      { source: 'brain', owner: 'brain', sessionId: '../../x', messageId: '0' },
      { source: 'other', owner: 'brain', sessionId: 't-brain', messageId: '0' },
    ])
      expect((await callTool(me, 'read_session', bad)).isError).toBe(true);
    expect((await callTool({ id: '_external', name: 'Outside' }, 'search_sessions', { query: word })).isError).toBe(
      true,
    );
    expect((await callTool(me, 'search_sessions', { query: word }, { runId: 'not-a-run' })).isError).toBe(true);
  });

  it('pages long originals to their end and skips its own earlier results', () => {
    const { me, chat, other, word } = setup();
    saveSettings({ sessionSearch: true });
    const original = `${word} start. ${'long words '.repeat(5000)}THE_TAIL`;
    chat.items.push({ type: 'assistant', text: original, ts: 40 });
    chat.items.push({
      type: 'tool',
      id: 'ss',
      name: 'search_sessions',
      args: { query: word },
      result: `${word} earlier result`,
      status: 'done',
      ts: 41,
    });
    chats.save(chat);
    expect(me.id).toBeTruthy();
    const hit = searchSessions({ query: 'THE_TAIL' }).hits[0];
    expect(hit).toMatchObject({ source: 'agent', owner: other.id, messageId: '1' });
    expect(searchSessions({ query: `${word} earlier result` }).total).toBe(0);
    let text = '';
    let offset: number | null = 0;
    while (offset !== null) {
      const page = readSession({ ...hit, offset });
      text += page.text;
      offset = page.nextOffset;
    }
    expect(text).toBe(original);
  });
});

describe("the Brain's session search", () => {
  it('is offered only when on, and answers within the project', async () => {
    const { word } = setup();
    answers.push('Nothing to look up.');
    await ask('hello');
    expect(asked[0].system).not.toContain('Session search is on');

    saveSettings({ sessionSearch: true });
    answers.push(
      `Let me look.\n\`\`\`actions\n${JSON.stringify([{ do: 'search_sessions', query: word, source: 'team' }])}\n\`\`\``,
      'Found it in the team thread.',
    );
    const r = await ask(`what did the team say about ${word}?`);
    expect(asked[1].system).toContain('Session search is on');
    expect(asked[2].user).toContain('--- search_sessions');
    expect(asked[2].user).toContain('in the open team thread');
    expect(r.answer).toBe('Found it in the team thread.');
    expect(r.done).toEqual([]);
  });

  it("a session it can't read comes back as a failed tool call", async () => {
    setup();
    saveSettings({ sessionSearch: true });
    answers.push(
      `\`\`\`actions\n${JSON.stringify([{ do: 'read_session', source: 'brain', owner: 'brain', sessionId: 'x', messageId: '9' }])}\n\`\`\``,
      'Nothing there.',
    );
    const before = asked.length;
    await ask('read that');
    expect(asked[before + 1].user).toContain('--- read_session');
    expect(asked[before + 1].user).toContain('(failed)');
  });
});
