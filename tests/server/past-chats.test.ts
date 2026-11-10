// The Brain's and the teams' earlier chats (server/pastchats.ts): New chat keeps the open conversation with the others,
// opening one swaps the two (a team's agents keep their sessions for it), deleting one, the routes, and backups.
import http from 'node:http';
import type net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newAgent } from '../../server/library.ts';
import { activeProject, bus, chats, workflows } from '../../server/store.ts';
import { dataPath, writeJSON } from '../../server/util.ts';
import { addBrainNote, brainThreads, history, newBrainThread, openBrainThread, removeBrainThread } from '../../server/overseer.ts';
import { getThread, newTeamThread, openTeamThread, removeTeamThread, teamThreads } from '../../server/teams.ts';
import { packPast, pastIds, threadTitle, unpackPast } from '../../server/pastchats.ts';
import { handleRpc } from '../../server/rpc.ts';
import type { BrainChatMessage, ServerEvent, Team, TeamMessage } from '../../shared/types.ts';

const pid = () => activeProject().id;
const brainSays = (messages: BrainChatMessage[]) => writeJSON(dataPath('projects', pid(), 'brain-chat.json'), { messages });
const said = (text: string, ts: number): BrainChatMessage[] => [
  { role: 'user', text, ts },
  { role: 'brain', text: `About “${text}”.`, ts: ts + 1 },
];
const events = (type: string) => {
  const seen: ServerEvent[] = [];
  const on = (e: ServerEvent) => void (e.type === type && seen.push(e));
  bus.on('event', on);
  return { seen, off: () => void bus.off('event', on) };
};

describe('names', () => {
  it('names a chat by the start of the first thing you wrote', () => {
    expect(threadTitle('  Make me\n a  social media team ')).toBe('Make me a social media team');
    expect(threadTitle('')).toBe('New chat');
    const long = threadTitle('word '.repeat(40));
    expect(long.length).toBeLessThanOrEqual(60);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('the Brain chat', () => {
  it('keeps the open conversation when a new one starts, and swaps them back', () => {
    // (a chat saved before conversations had ids)
    brainSays(said('What is everyone working on?', 1000));
    const live = events('brain-chat');
    const fresh = newBrainThread();
    expect(history()).toEqual([]);
    const list = brainThreads();
    expect(list[0]).toMatchObject({ id: fresh.id, open: true, count: 0, title: 'New chat' });
    const old = list.find((t) => !t.open)!;
    expect(old).toMatchObject({ title: 'What is everyone working on?', count: 2, createdAt: 1000, updatedAt: 1001 });
    // (other tabs hear which conversation is open now)
    expect(live.seen.at(-1)).toMatchObject({ projectId: pid(), thread: fresh.id });

    // something said in the new one: it gets its own id, and opening the old one files it away
    addBrainNote(pid(), 'A note in the new chat.');
    expect(brainThreads()[0].id).toBe(fresh.id);
    openBrainThread(old.id);
    expect(history().map((m) => m.text)).toEqual(['What is everyone working on?', 'About “What is everyone working on?”.']);
    const now = brainThreads();
    expect(now[0]).toMatchObject({ id: old.id, open: true });
    expect(now.find((t) => t.id === fresh.id)).toMatchObject({ open: false, count: 1 });
    expect(pastIds({ kind: 'brain' })).not.toContain(old.id);
    expect(live.seen.at(-1)).toMatchObject({ thread: old.id });
    live.off();
  });

  it('does not keep an empty chat, nor start another when the open one is empty', () => {
    const a = newBrainThread();
    const before = pastIds({ kind: 'brain' }).length;
    expect(newBrainThread()).toEqual(a);
    const past = brainThreads().find((t) => !t.open)!;
    openBrainThread(past.id);
    // (the empty one was dropped, not filed away)
    expect(pastIds({ kind: 'brain' })).toHaveLength(before - 1);
    expect(brainThreads().some((t) => t.id === a.id)).toBe(false);
  });

  it('deletes an earlier chat, and empties the open one', () => {
    brainSays(said('Keep this', 5000));
    newBrainThread();
    brainSays(said('And this', 6000));
    const gone = brainThreads().find((t) => t.title === 'Keep this')!;
    removeBrainThread(gone.id);
    expect(brainThreads().some((t) => t.id === gone.id)).toBe(false);
    expect(() => removeBrainThread(gone.id)).toThrow('That chat is no longer there.');
    const open = brainThreads()[0];
    removeBrainThread(open.id);
    expect(history()).toEqual([]);
  });

  it('refuses a chat that is not there, and ids that would leave its folder', () => {
    expect(() => openBrainThread('t-nothing')).toThrow('That chat is no longer there.');
    expect(() => openBrainThread('../../settings')).toThrow('That chat is no longer there.');
    expect(() => removeBrainThread('..\\..\\settings')).toThrow('That chat is no longer there.');
  });
});

describe("a team's chat", () => {
  const setup = () => {
    const a = newAgent({ name: `Poet ${Math.random()}`, engine: 'eve', provider: 'custom', model: 'mock', toolGroups: [] });
    const team = workflows.save({ name: 'Writers', members: [a.id], lead: a.id, steps: [] } as Partial<Team>);
    const session = chats.create(a.id, 'Team: Writers', team.id);
    const messages: TeamMessage[] = [
      { id: 'm1', ts: 1000, from: 'user', text: 'Write a poem', mentions: [] },
      { id: 'm2', ts: 2000, from: a.id, text: 'Here it is.', mentions: [] },
    ];
    writeJSON(dataPath('projects', pid(), 'teamchats', `${team.id}.json`), { messages, sessions: { [a.id]: session.id }, seen: { [a.id]: 2 } });
    return { a, team, session };
  };

  it('keeps the thread, with the agents’ sessions for it, when a new chat starts; opening it brings both back', () => {
    const { a, team, session } = setup();
    const live = events('team');
    const fresh = newTeamThread(team.id);
    expect(getThread(team.id)).toMatchObject({ messages: [], sessions: {} });
    expect(live.seen.at(-1)).toMatchObject({ teamId: team.id, event: { kind: 'cleared' } });
    // (the agent still remembers the conversation that was filed away)
    expect(chats.get(a.id, session.id)).not.toBeNull();
    const list = teamThreads(team.id);
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ id: fresh.id, open: true, count: 0 });
    expect(list[1]).toMatchObject({ title: 'Write a poem', count: 2, open: false, updatedAt: 2000 });

    openTeamThread(team.id, list[1].id);
    expect(getThread(team.id)).toMatchObject({ messages: [{ id: 'm1' }, { id: 'm2' }], sessions: { [a.id]: session.id } });
    expect(live.seen.at(-1)).toMatchObject({ teamId: team.id, event: { kind: 'thread', id: list[1].id } });
    // (the empty new chat wasn't kept)
    expect(teamThreads(team.id)).toEqual([expect.objectContaining({ id: list[1].id, open: true })]);
    live.off();
  });

  it('deletes an earlier chat, and its agents forget it', () => {
    const { a, team, session } = setup();
    newTeamThread(team.id);
    const past = teamThreads(team.id).find((t) => !t.open)!;
    removeTeamThread(team.id, past.id);
    expect(teamThreads(team.id)).toHaveLength(1);
    expect(chats.get(a.id, session.id)).toBeNull();
    expect(() => removeTeamThread(team.id, past.id)).toThrow('That chat is no longer there.');
  });

  it('empties the open thread when it is the one deleted', () => {
    const { a, team, session } = setup();
    removeTeamThread(team.id, teamThreads(team.id)[0].id);
    expect(getThread(team.id).messages).toEqual([]);
    expect(chats.get(a.id, session.id)).toBeNull();
  });

  it('refuses a team that is not there', () => {
    expect(() => teamThreads('nobody')).toThrow('No such team.');
    expect(() => newTeamThread('../../x')).toThrow('No such team.');
  });
});

describe('backups', () => {
  it('carries the earlier chats, and puts back only names that are theirs', () => {
    brainSays(said('Back me up', 9000));
    newBrainThread();
    const packed = packPast(pid());
    expect(packed.some((p) => /^brain\/[\w-]+\.json$/.test(p.name) && JSON.stringify(p.data).includes('Back me up'))).toBe(true);
    const into = `restored-${Date.now()}`;
    unpackPast(into, [...packed, { name: '../../settings.json', data: { x: 1 } }, { name: 'brain/../../x.json', data: {} }]);
    expect(packPast(into).map((p) => p.name).sort()).toEqual(packed.map((p) => p.name).sort());
  });
});

describe('the routes', () => {
  let base = '';
  const server = http.createServer(async (req, res) => {
    if (!(await handleRpc(req, res, '/api'))) res.writeHead(404).end();
  });
  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const send = async (method: string, p: string) => {
    const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' } });
    return { status: r.status, json: (await r.json()) as unknown };
  };

  it('lists, starts, opens and deletes the Brain’s chats', async () => {
    brainSays(said('Over the wire', 20_000));
    const made = (await send('POST', '/api/brain/chats')).json as { id: string };
    const list = (await send('GET', '/api/brain/chats')).json as { id: string; open: boolean; title: string }[];
    expect(list[0]).toMatchObject({ id: made.id, open: true });
    const old = list.find((t) => t.title === 'Over the wire')!;
    expect(await send('POST', `/api/brain/chats/${old.id}/open`)).toEqual({ status: 200, json: { id: old.id } });
    expect(await send('POST', '/api/brain/chats/t-gone/open')).toEqual({ status: 404, json: { error: 'That chat is no longer there.' } });
    expect(await send('DELETE', `/api/brain/chats/${old.id}`)).toEqual({ status: 200, json: { ok: true } });
  });

  it('lists, starts, opens and deletes a team’s chats', async () => {
    const { team } = (() => {
      const a = newAgent({ name: `Wire ${Math.random()}`, engine: 'eve', provider: 'custom', model: 'mock', toolGroups: [] });
      const t = workflows.save({ name: 'Wire team', members: [a.id], lead: a.id, steps: [] } as Partial<Team>);
      writeJSON(dataPath('projects', pid(), 'teamchats', `${t.id}.json`), { messages: [{ id: 'm1', ts: 1, from: 'user', text: 'Hello team', mentions: [] }], sessions: {}, seen: {} });
      return { team: t };
    })();
    const made = (await send('POST', `/api/teams/${team.id}/chats`)).json as { id: string };
    const list = (await send('GET', `/api/teams/${team.id}/chats`)).json as { id: string; open: boolean; title: string }[];
    expect(list.map((t) => [t.title, t.open])).toEqual([['New chat', true], ['Hello team', false]]);
    expect(list[0].id).toBe(made.id);
    expect((await send('POST', `/api/teams/${team.id}/chats/${list[1].id}/open`)).json).toEqual({ id: list[1].id });
    expect(await send('DELETE', `/api/teams/${team.id}/chats/t-gone`)).toEqual({ status: 404, json: { error: 'That chat is no longer there.' } });
    expect((await send('GET', '/api/teams/nobody/chats')).status).toBe(404);
  });
});
