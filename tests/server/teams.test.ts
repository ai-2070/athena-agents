// Teams as group chats, end to end with a fake model: you → lead → @teammate → back to the lead.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newAgent } from '../../server/library.ts';
import { bus, chats, saveSettings, workflows } from '../../server/store.ts';
import { MAX_CHATTER, TURN_ASK, briefing, editQueuedTeam, getThread, orderQueuedTeam, parseMentions, postUserMessage, queueUserMessage, steerTeam, stopTeam, teamState } from '../../server/teams.ts';
import type { ServerEvent, Team } from '../../shared/types.ts';

// a fake OpenAI-compatible model: the Lead hands off to the Maker, the Maker reports back, the Lead wraps up
let server: http.Server;
// the last message each agent was sent, by name
const lastAsk: Record<string, string> = {};
const asks: Record<string, string[]> = {};
const contexts: Record<string, string[]> = {};
const heldReplies = new Set<() => void>();
beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    if (req.url?.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'mock' }] }));
    let body = '';
    for await (const c of req) body += c;
    const j = JSON.parse(body) as { messages: { content: string }[] };
    const system = j.messages[0].content;
    const last = j.messages.at(-1)!.content;
    const who = /You are (\w+)/.exec(system)?.[1];
    if (who) {
      lastAsk[who] = last;
      (asks[who] ||= []).push(last);
      (contexts[who] ||= []).push(j.messages.slice(1).map((m) => m.content).join('\n\n'));
    }
    if (who?.startsWith('Hold')) {
      let release!: () => void;
      await new Promise<void>((r) => {
        release = r;
        heldReplies.add(r);
        res.once('close', r);
      });
      heldReplies.delete(release);
    }
    let reply = 'Okay.';
    if (who === 'Dispatcher') reply = '@HoldOne and @HoldTwo, do your parts.';
    // Slow works on and on (until it is stopped), except on a change of plan
    if (system.includes('You are Slow') && !/Change of plan/.test(last)) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Working on the long one' } }] })}

`);
      return;
    }
    if (system.includes('You are Slow')) reply = 'Switched to the short one.';
    if (system.includes('You are Lead')) reply = /@Maker: Done/.test(last) ? 'All done, the thumbnail is ready.' : 'Plan: @Maker please make the thumbnail.';
    else if (system.includes('You are Maker')) reply = 'Done, saved as thumb.png.';
    else if (system.includes('You are Ping')) reply = 'Your turn @Pong.';
    else if (system.includes('You are Pong')) reply = 'Back to you @Ping.';
    // long replies: a draft each turn is work, even without tools
    else if (system.includes('You are Writer')) reply = `Next draft:\n${'A line of the story. '.repeat(40)}\n@Editor your turn.`;
    else if (system.includes('You are Editor')) reply = `Notes:\n${'A note on the draft. '.repeat(40)}\n@Writer your turn.`;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: reply } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  saveSettings({ providers: { custom: { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, label: 'Fake model' } } });
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const agent = (name: string) => newAgent({ name, engine: 'openai', provider: 'custom', model: 'mock', toolGroups: [] });

describe('parseMentions()', () => {
  it('finds @Names (longest first) and @everyone', () => {
    const a = newAgent({ name: 'Trend Scout' });
    const b = newAgent({ name: 'Trend' });
    const team = { id: 't', name: 'T', members: [a.id, b.id], lead: null, steps: [], description: '' } as Team;
    expect(parseMentions(team, 'hey @Trend Scout, look')).toEqual([a.id]);
    expect(parseMentions(team, '@Trend go')).toEqual([b.id]);
    expect(parseMentions(team, '@everyone stand up').sort()).toEqual([a.id, b.id].sort());
    expect(parseMentions(team, 'no mentions here')).toEqual([]);
  });
});

describe('a team chat', () => {
  it('goes from you to the lead, to a teammate and back to the lead', async () => {
    const lead = agent('Lead');
    const maker = agent('Maker');
    const team = workflows.save({ name: 'Thumbs', description: 'Make thumbnails', members: [lead.id, maker.id], lead: lead.id, steps: [] } as Partial<Team>);
    await postUserMessage(team.id, 'Make a thumbnail for my launch video');
    let thread = getThread(team.id);
    for (let i = 0; i < 60 && thread.messages.length < 4; i++) {
      await new Promise((r) => setTimeout(r, 100));
      thread = getThread(team.id);
    }
    const who = (id: string) => (id === lead.id ? 'Lead' : id === maker.id ? 'Maker' : id);
    expect(thread.messages.map((m) => `${who(m.from)}: ${m.text.trim()}`)).toEqual([
      'user: Make a thumbnail for my launch video',
      'Lead: Plan: @Maker please make the thumbnail.',
      'Maker: Done, saved as thumb.png.',
      'Lead: All done, the thumbnail is ready.',
    ]);
    expect(thread.messages[1].mentions).toEqual([maker.id]);
    // every turn ends by telling the agent to finish its part, not only the first one (which has the briefing)
    expect(lastAsk.Maker).toContain('How this chat works');
    expect(lastAsk.Maker.endsWith(TURN_ASK)).toBe(true);
    expect(lastAsk.Lead).not.toContain('How this chat works');
    expect(lastAsk.Lead.endsWith(TURN_ASK)).toBe(true);
  });

  it('briefs members to finish their part: no declining, no waiting on teammates, install or ask for what they need', () => {
    const one = agent('Solo');
    const team = workflows.save({ name: 'Solo team', members: [one.id], lead: one.id, steps: [] } as Partial<Team>);
    const text = briefing(team, one);
    expect(text).toMatch(/Work you're given is yours to finish\. Don't decline it/);
    expect(text).toMatch(/Don't wait for a teammate to finish theirs first/);
    expect(text).toMatch(/install it and keep going/);
    expect(text).toMatch(/ask for them with request_tool/);
    expect(text).toMatch(/For access, a login or a key, ask the user with ask_user/);
    expect(TURN_ASK).toMatch(/finish it/);
    expect(TURN_ASK).toMatch(/request_tool/);
  });
});

describe('how long a team keeps going', () => {
  const rally = async (a: string, b: string) => {
    const one = agent(a);
    const two = agent(b);
    const team = workflows.save({ name: `${a} and ${b}`, description: 'Keep going', members: [one.id, two.id], lead: one.id, steps: [] } as Partial<Team>);
    await postUserMessage(team.id, 'Start');
    const replies = () => getThread(team.id).messages.filter((m) => m.from === one.id || m.from === two.id).length;
    const paused = () => getThread(team.id).messages.some((m) => m.from === 'system' && m.text.startsWith('Paused'));
    return { team, replies, paused };
  };
  const until = async (done: () => boolean) => {
    for (let i = 0; i < 400 && !done(); i++) await new Promise((r) => setTimeout(r, 25));
  };

  it('keeps going past any turn count while the agents do work', async () => {
    const { team, replies, paused } = await rally('Writer', 'Editor');
    await until(() => replies() >= 40 || paused());
    expect(paused()).toBe(false);
    expect(replies()).toBeGreaterThanOrEqual(40);
    stopTeam(team.id);
  }, 30000);

  it('pauses agents that only hand it back and forth', async () => {
    const { team, replies, paused } = await rally('Ping', 'Pong');
    await until(paused);
    expect(paused()).toBe(true);
    expect(replies()).toBe(MAX_CHATTER);
    stopTeam(team.id);
  }, 30000);
});

describe("a reply's work", () => {
  it('each reply says where its turn is in the agent’s session, and the session is named when it starts', async () => {
    const lead = agent('Lead');
    const maker = agent('Maker');
    const team = workflows.save({ name: 'Work', description: 'Show the work', members: [lead.id, maker.id], lead: lead.id, steps: [] } as Partial<Team>);
    const starts: { agentId: string; chatId?: string }[] = [];
    const listen = (ev: ServerEvent) => {
      const e = ev.event as { kind?: string; state?: string; agentId: string; chatId?: string };
      if (ev.type === 'team' && ev.teamId === team.id && e.kind === 'turn' && e.state === 'start') starts.push(e);
    };
    bus.on('event', listen);
    try {
      await postUserMessage(team.id, 'Make a thumbnail');
      let thread = getThread(team.id);
      for (let i = 0; i < 60 && thread.messages.length < 4; i++) {
        await new Promise((r) => setTimeout(r, 100));
        thread = getThread(team.id);
      }
      // you → Lead → Maker → Lead: every reply came, and each of the three turns said it started
      expect(thread.messages).toHaveLength(4);
      expect(starts.map((s) => s.agentId)).toEqual([lead.id, maker.id, lead.id]);
      // the thread names each agent's own session for this team
      expect(thread.sessions[lead.id]).toEqual(expect.any(String));
      expect(thread.sessions[maker.id]).toEqual(expect.any(String));
      // and each turn's start says which one it streams in
      expect(starts.map((s) => s.chatId)).toEqual(starts.map((s) => thread.sessions[s.agentId]));
      const replies = thread.messages.filter((x) => x.from !== 'user');
      expect(replies).toHaveLength(3);
      for (const m of replies) {
        expect(m.turn).toMatchObject({ chatId: thread.sessions[m.from] });
        const items = chats.get(m.from, m.turn!.chatId)!.items.slice(m.turn!.from, m.turn!.to);
        // the turn: the message to the agent, then its answer (the reply in the thread)
        expect(items[0]).toMatchObject({ type: 'user' });
        expect(items.find((i) => i.type === 'assistant')).toMatchObject({ text: m.text });
      }
    } finally {
      bus.off('event', listen);
    }
  });
});

describe('steering: a message while the team works', () => {
  const until = async (done: () => boolean) => {
    for (let i = 0; i < 200 && !done(); i++) await new Promise((r) => setTimeout(r, 25));
  };

  it('stops the turn going now, gives the message to whoever was working, and queued messages still wait', async () => {
    const slow = agent('Slow');
    const other = agent('Lead');
    const team = workflows.save({ name: 'Steer', description: 'Change course', members: [other.id, slow.id], lead: other.id, steps: [] } as Partial<Team>);
    await postUserMessage(team.id, '@Slow do the long job');
    await until(() => teamState(team.id).working.includes(slow.id));
    expect(teamState(team.id).working).toEqual([slow.id]);
    const held = await queueUserMessage(team.id, 'then tidy up');
    expect(held).toHaveProperty('queued');
    const msg = await steerTeam(team.id, 'Change of plan: do the short one');
    const who = (id: string) => (id === slow.id ? 'Slow' : id === other.id ? 'Lead' : id);
    const said = () => getThread(team.id).messages.map((m) => `${who(m.from)}: ${m.text.trim()}`);
    await until(() => said().length >= 6);
    // in order: the stopped turn, your message (to Slow, not the lead), its answer, then the queued one
    expect(said().slice(0, 5)).toEqual([
      'user: @Slow do the long job',
      'Slow: (stopped to take your new message)',
      'user: Change of plan: do the short one',
      'Slow: Switched to the short one.',
      'user: then tidy up',
    ]);
    // (the queued one is an ordinary message: the lead takes it)
    expect(getThread(team.id).messages[5].from).toBe(other.id);
    expect(msg.text).toBe('Change of plan: do the short one');
    expect(teamState(team.id).held).toEqual([]);
  }, 15000);

  it('two messages sent quickly while it works are posted in the order sent', async () => {
    const slow = agent('Slow');
    const other = agent('Lead');
    const team = workflows.save({ name: 'Twice', description: 'x', members: [other.id, slow.id], lead: other.id, steps: [] } as Partial<Team>);
    await postUserMessage(team.id, '@Slow do the long job');
    await until(() => teamState(team.id).working.includes(slow.id));
    const [a, b] = await Promise.all([steerTeam(team.id, 'Change of plan: the short one'), steerTeam(team.id, 'and make it blue')]);
    const yours = getThread(team.id).messages.filter((m) => m.from === 'user');
    expect(yours.map((m) => m.text)).toEqual(['@Slow do the long job', 'Change of plan: the short one', 'and make it blue']);
    expect(a.ts).toBeLessThanOrEqual(b.ts);
    // the stopped turn says why
    expect(getThread(team.id).messages.some((m) => m.from === slow.id && m.text === '(stopped to take your new message)')).toBe(true);
    stopTeam(team.id);
  }, 15000);

  it('with nobody working, a steer is an ordinary message', async () => {
    const lead = agent('Lead');
    const maker = agent('Maker');
    const team = workflows.save({ name: 'Quiet', description: 'Idle', members: [lead.id, maker.id], lead: lead.id, steps: [] } as Partial<Team>);
    await steerTeam(team.id, 'Make a thumbnail');
    await until(() => getThread(team.id).messages.length >= 4);
    expect(getThread(team.id).messages.map((m) => m.text.trim())).toEqual(['Make a thumbnail', 'Plan: @Maker please make the thumbnail.', 'Done, saved as thumb.png.', 'All done, the thumbnail is ready.']);
  });

  it('an empty steer stops nothing', async () => {
    const slow = agent('Slow');
    const team = workflows.save({ name: 'Empty', description: 'x', members: [slow.id], lead: slow.id, steps: [] } as Partial<Team>);
    await postUserMessage(team.id, 'the long job');
    await until(() => teamState(team.id).working.includes(slow.id));
    await expect(steerTeam(team.id, '   ')).rejects.toThrow();
    expect(teamState(team.id).working).toEqual([slow.id]);
    stopTeam(team.id);
  });
});

describe('queued messages: changed and put in order', () => {
  it('changes the text of one, and the order they go in', async () => {
    const slow = agent('Slow');
    const team = workflows.save({ name: 'Held', description: 'x', members: [slow.id], lead: slow.id, steps: [] } as Partial<Team>);
    await postUserMessage(team.id, 'the long job');
    for (let i = 0; i < 200 && !teamState(team.id).working.length; i++) await new Promise((r) => setTimeout(r, 25));
    const ids: string[] = [];
    for (const t of ['one', 'two', 'three']) {
      const r = await queueUserMessage(team.id, t);
      if ('queued' in r) ids.push(r.queued.id);
    }
    expect(editQueuedTeam(team.id, ids[1], '  two, changed ')).toMatchObject({ id: ids[1], text: 'two, changed' });
    expect(() => editQueuedTeam(team.id, ids[1], '  ')).toThrow();
    // (already posted: nothing to change, and not an error)
    expect(editQueuedTeam(team.id, 'nope', 'x')).toBeNull();
    // the ones it names go first, in that order; the rest keep theirs after them
    expect(orderQueuedTeam(team.id, [ids[2], 'nope', ids[0]]).map((q) => q.text)).toEqual(['three', 'one', 'two, changed']);
    expect(teamState(team.id).held?.map((q) => q.id)).toEqual([ids[2], ids[0], ids[1]]);
    stopTeam(team.id);
  });
});

describe('fallback routing and concurrent assignments', () => {
  const until = async (done: () => boolean) => {
    await expect.poll(done).toBe(true);
  };
  const setup = (dispatcher = false) => {
    asks.HoldOne = [];
    asks.HoldTwo = [];
    contexts.HoldOne = [];
    contexts.HoldTwo = [];
    const one = agent('HoldOne');
    const two = agent('HoldTwo');
    const lead = dispatcher ? agent('Dispatcher') : null;
    const team = workflows.save({ name: 'Assignments', members: [one.id, two.id, ...(lead ? [lead.id] : [])], lead: lead?.id || null, steps: [] } as Partial<Team>);
    return { one, two, team };
  };
  const cleanup = async (team: Team) => {
    stopTeam(team.id);
    for (const release of heldReplies) release();
    await until(() => teamState(team.id).working.length === 0);
  };
  const notes = (team: Team) => getThread(team.id).messages.filter((m) => m.from === 'system');
  const assignment = (prompt: string) => prompt.split('Other members assigned this message: ')[1]?.split('\n')[0];

  it.each(['missing', 'null', 'error', 'invalid'])('discloses a %s routing fallback before the turn starts', async (mode) => {
    const { one, team } = setup();
    try {
      const route = mode === 'missing' ? undefined : async () => {
        if (mode === 'error') throw new Error('Router unavailable');
        return mode === 'invalid' ? 'non-member' : null;
      };
      await postUserMessage(team.id, 'Please help', { route });
      await until(() => asks.HoldOne.length === 1);
      expect(teamState(team.id).working).toEqual([one.id]);
      expect(notes(team).map((m) => m.text)).toEqual(['No routing match: asked @HoldOne, the first member free.']);
      expect(contexts.HoldOne[0]).toContain('System: No routing match: asked @HoldOne');
    } finally { await cleanup(team); }
  });

  it('skips a busy member on fallback and describes queued work when everyone is busy', async () => {
    const { one, two, team } = setup();
    try {
      await postUserMessage(team.id, '@HoldOne take the first request');
      await until(() => asks.HoldOne.length === 1);
      await postUserMessage(team.id, 'Take another request', { route: async () => null });
      await until(() => asks.HoldTwo.length === 1);
      expect(notes(team)[0].text).toBe('No routing match: asked @HoldTwo, the first member free.');
      expect(assignment(asks.HoldTwo[0])).toBeUndefined();
      await postUserMessage(team.id, 'And another', { route: async () => null });
      expect(teamState(team.id).working).toEqual([one.id, two.id]);
      expect(teamState(team.id).queued).toEqual([one.id]);
      expect(notes(team)[1].text).toBe('No routing match: queued this for @HoldOne; everyone is busy.');
    } finally { await cleanup(team); }
  });

  it('keeps valid picks, mentions and reply-to routing even when that member is busy', async () => {
    const { one, team } = setup();
    try {
      const first = await postUserMessage(team.id, '@HoldOne first');
      await until(() => asks.HoldOne.length === 1);
      await postUserMessage(team.id, 'Best fit', { route: async () => one.id });
      // A reply to a user message has no agent author, so the valid router still applies.
      await postUserMessage(team.id, 'Reply', { replyTo: first.id, route: async () => one.id });
      await postUserMessage(team.id, '@HoldOne another');
      expect(notes(team)).toEqual([]);
      expect(teamState(team.id).queued).toEqual([one.id]);
    } finally { await cleanup(team); }
  });

  it('rechecks the roster after the router waits instead of losing work for a removed member', async () => {
    const { one, two, team } = setup();
    try {
      await postUserMessage(team.id, 'Pick someone', { route: async () => {
        workflows.save({ ...team, members: [two.id] });
        return one.id;
      } });
      await until(() => asks.HoldTwo.length === 1);
      expect(notes(team)[0].text).toBe('No routing match: asked @HoldTwo, the first member free.');
    } finally { await cleanup(team); }
  });

  it('routes a reply to its agent author without a fallback note', async () => {
    const { one, team } = setup();
    try {
      await postUserMessage(team.id, '@HoldOne first');
      await until(() => asks.HoldOne.length === 1);
      for (const release of heldReplies) release();
      await until(() => !teamState(team.id).working.length);
      const answer = getThread(team.id).messages.find((m) => m.from === one.id)!;
      await postUserMessage(team.id, 'Please expand', { replyTo: answer.id, route: async () => { throw new Error('Must not route'); } });
      await until(() => asks.HoldOne.length === 2);
      expect(notes(team)).toEqual([]);
    } finally { await cleanup(team); }
  });

  it.each([false, true])('discloses every peer in initial prompts (agent handoff: %s)', async (handoff) => {
    const { one, two, team } = setup(handoff);
    try {
      const starts: string[] = [];
      const listen = (ev: ServerEvent) => {
        const e = ev.event as { kind?: string; state?: string; agentId?: string };
        if (ev.type === 'team' && ev.teamId === team.id && e.kind === 'turn' && e.state === 'start' && e.agentId) starts.push(e.agentId);
      };
      bus.on('event', listen);
      try {
        await postUserMessage(team.id, handoff ? 'Split the work' : '@HoldOne and @HoldTwo, do your parts');
        await until(() => asks.HoldOne.length === 1 && asks.HoldTwo.length === 1);
      } finally { bus.off('event', listen); }
      expect(starts.slice(handoff ? 1 : 0)).toEqual([one.id, two.id]);
      expect(assignment(asks.HoldOne[0])).toBe('@HoldTwo. Do your own part; avoid duplicating theirs.');
      expect(assignment(asks.HoldTwo[0])).toBe('@HoldOne. Do your own part; avoid duplicating theirs.');
      expect(teamState(team.id).working).toEqual([one.id, two.id]);
      expect(asks.HoldOne[0].endsWith(TURN_ASK)).toBe(true);
    } finally { await cleanup(team); }
  });

  it('does not claim another agent is assigned to a solo or unrelated turn', async () => {
    const { team } = setup();
    try {
      await postUserMessage(team.id, '@HoldOne first job');
      await until(() => asks.HoldOne.length === 1);
      await postUserMessage(team.id, '@HoldTwo different job');
      await until(() => asks.HoldTwo.length === 1);
      expect(assignment(asks.HoldOne[0])).toBeUndefined();
      expect(assignment(asks.HoldTwo[0])).toBeUndefined();
    } finally { await cleanup(team); }
  });
});
