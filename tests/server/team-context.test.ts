// The fake model records every message it receives; assertions cover full text, not just previews.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newAgent } from '../../server/library.ts';
import { activeProject, chats, saveSettings, workflows } from '../../server/store.ts';
import { dataPath, readJSON, writeJSON } from '../../server/util.ts';
import { getThread, postUserMessage, teamMessages, teamState } from '../../server/teams.ts';
import type { Team, TeamMessage } from '../../shared/types.ts';

let server: http.Server;
let fail = false;
const calls: { name: string; args: Record<string, unknown> }[] = [];
const requests: { messages: { content: string }[] }[] = [];
beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    if (req.url?.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'mock', context_length: 128000 }] }));
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body) as { messages: { content: string }[] });
    if (fail) { res.writeHead(400); return res.end(JSON.stringify({ error: { message: 'Offline test model' } })); }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const call = calls.shift();
    const delta = call ? { tool_calls: [{ index: 0, id: `tool-${requests.length}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] } : { content: 'Done.' };
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: call ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  saveSettings({ providers: { custom: { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, label: 'Fake' } } });
});
beforeEach(() => { fail = false; requests.length = 0; calls.length = 0; saveSettings({ contextWindowTokens: 128000 }); });
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const message = (i: number, text = `Message ${i}: ${'x'.repeat(2600)} REQUIREMENT_AT_END_${i}`): TeamMessage => ({ id: `source-${i}`, ts: i + 1, from: i % 2 ? 'brain' : 'user', text, mentions: [] });
const setup = (messages: TeamMessage[]) => {
  const reader = newAgent({ name: 'Reader', engine: 'eve', provider: 'custom', model: 'mock', toolGroups: [] });
  const team = workflows.save({ name: 'Full context', members: [reader.id], lead: reader.id, steps: [] } as Partial<Team>);
  const file = dataPath('projects', activeProject().id, 'teamchats', `${team.id}.json`);
  writeJSON(file, { messages, sessions: {}, seen: {} });
  const turn = async (text = 'Please continue') => {
    await postUserMessage(team.id, text);
    await expect.poll(() => teamState(team.id).working.length).toBe(0);
    return chats.get(reader.id, getThread(team.id).sessions[reader.id])!;
  };
  return { team, reader, file, turn };
};

describe('full team context', () => {
  it('delivers every unread message in full, including instructions at their ends', async () => {
    const messages = Array.from({ length: 40 }, (_,i) => message(i));
    const { turn } = setup(messages);
    const chat = await turn();
    const input = requests[0].messages.map((m) => m.content).join('\n');
    for (const m of messages) {
      expect(input).toContain(m.text);
      expect(chat.items.some((i) => i.type === 'user' && i.teamMessageId === m.id && i.text.includes(m.text))).toBe(true);
    }
    expect(input).not.toContain('[message shortened]');
  });

  it('keeps a long addressed request intact too', async () => {
    const { turn } = setup([]);
    const text = `${'instruction '.repeat(2000)} CRITICAL_LAST_INSTRUCTION`;
    await turn(text);
    expect(requests[0].messages.at(-1)?.content).toContain(text);
  });

  it('restores the member\'s own earlier team replies when its private session is missing', async () => {
    const { reader, file, turn } = setup([]);
    const original = message(0, 'MY_PREVIOUS_TEAM_DECISION');
    original.from = reader.id;
    writeJSON(file, { messages: [original], sessions: {}, seen: { [reader.id]: 1 } });
    await turn('Continue from the shared record');
    expect(requests[0].messages.some((m) => m.content.includes('MY_PREVIOUS_TEAM_DECISION'))).toBe(true);
    expect(requests[0].messages.at(-1)?.content).toContain('How this chat works');
  });

  it('rebuilds a missing API memory from the saved full conversation', async () => {
    const { turn } = setup([message(0)]);
    const saved = await turn();
    saved.items.push({ type: 'meta', text: 'Memory cleared', reset: true });
    chats.save(saved);
    await turn('Continue after restoring the session');
    expect(requests[1].messages.some((m) => m.content.includes('REQUIREMENT_AT_END_0'))).toBe(true);
  });

  it('imports each source once and preserves history across turns', async () => {
    const { turn } = setup([message(0)]);
    await turn();
    const chat = await turn('Continue once more');
    expect(chat.items.filter((i) => i.type === 'user' && i.teamMessageId === 'source-0')).toHaveLength(1);
    expect(requests[1].messages.some((m) => m.content.includes('REQUIREMENT_AT_END_0'))).toBe(true);
  });

  it('keeps more than 500 messages and gives a member joining later the retained history', async () => {
    const { team, turn } = setup(Array.from({ length: 510 }, (_,i) => message(i, `Original ${i}`)));
    await turn();
    expect(teamMessages(team.id).length).toBeGreaterThan(510);
    const late = newAgent({ name: 'Late', engine: 'eve', provider: 'custom', model: 'mock', toolGroups: [] });
    workflows.save({ ...team, members: [...team.members, late.id] });
    await postUserMessage(team.id, '@Late take over');
    await expect.poll(() => teamState(team.id).working.length).toBe(0);
    const input = requests.at(-1)!.messages.map((m) => m.content).join('\n');
    expect(input).toContain('Original 0');
    expect(input).toContain('Original 509');
  });

  it('refuses oversized history and preserves all originals for retrieval', async () => {
    saveSettings({ contextWindowTokens: 32000 });
    const { turn } = setup(Array.from({ length: 100 }, (_,i) => message(i)));
    const chat = await turn();
    expect(requests).toHaveLength(0);
    expect(chat.items.filter((i) => i.type === 'user' && i.teamMessageId?.startsWith('source-'))).toHaveLength(100);
    expect(chat.items.some((i) => i.type === 'user' && i.text.includes('REQUIREMENT_AT_END_0'))).toBe(true);

  });

  it('lets the model search and read an original team message without Files tools', async () => {
    saveSettings({ contextWindowTokens: 128000 });
    const { turn, team } = setup(Array.from({ length: 100 }, (_,i) => message(i)));
    calls.push(
      { name: 'search_conversations', args: { query: 'REQUIREMENT_AT_END_0', scope: 'team', teamId: team.id } },
      { name: 'read_conversation', args: { source: 'team', conversationId: team.id, messageId: 'source-0', offset: 2500 } },
    );
    const chat = await turn();
    expect(requests).toHaveLength(3);
    expect(requests[1].messages.at(-1)?.content).toContain('source-0');
    expect(requests[2].messages.at(-1)?.content).toContain('REQUIREMENT_AT_END_0');
    expect(chat.items.findLast((item) => item.type === 'assistant')).toMatchObject({ type: 'assistant', text: 'Done.' });
  });

  it('does not advance the read mark on a failed model request, and can retry without losing context', async () => {
    const { turn, file } = setup([message(0)]);
    fail = true;
    await turn();
    expect(Object.values(readJSON<{ seen: Record<string, number> }>(file, { seen: {} }).seen)).toEqual([]);
    fail = false;
    const chat = await turn('Try again');
    expect(requests.at(-1)!.messages.some((m) => m.content.includes('REQUIREMENT_AT_END_0'))).toBe(true);
    expect(chat.items.filter((i) => i.type === 'user' && i.teamMessageId === 'source-0')).toHaveLength(1);
  });

  it('refuses an oversized addressed task explicitly rather than clipping it or marking it read', async () => {
    saveSettings({ contextWindowTokens: 8000 });
    const { turn, file, team } = setup([]);
    const text = 'Unabridged instruction. '.repeat(10000) + 'TAIL';
    const chat = await turn(text);
    expect(requests).toHaveLength(0);
    expect(getThread(team.id).messages.at(-1)?.text).toContain('does not fit this model');
    expect(Object.values(readJSON<{ seen: Record<string, number> }>(file, { seen: {} }).seen)).toEqual([]);
    expect(chat.items.some((i) => i.type === 'user' && i.teamMessageId && i.text.endsWith('TAIL'))).toBe(true);
  });
});
