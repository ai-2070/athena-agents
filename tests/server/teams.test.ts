// Teams as group chats, end to end with a fake model: you → lead → @teammate → back to the lead.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newAgent } from '../../server/library.ts';
import { saveSettings, workflows } from '../../server/store.ts';
import { getThread, parseMentions, postUserMessage } from '../../server/teams.ts';
import type { Team } from '../../shared/types.ts';

// a fake OpenAI-compatible model: the Lead hands off to the Maker, the Maker reports back, the Lead wraps up
let server: http.Server;
beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    if (req.url?.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'mock' }] }));
    let body = '';
    for await (const c of req) body += c;
    const j = JSON.parse(body) as { messages: { content: string }[] };
    const system = j.messages[0].content;
    const last = j.messages.at(-1)!.content;
    let reply = 'Okay.';
    if (system.includes('You are Lead')) reply = /@Maker: Done/.test(last) ? 'All done, the thumbnail is ready.' : 'Plan: @Maker please make the thumbnail.';
    else if (system.includes('You are Maker')) reply = 'Done, saved as thumb.png.';
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
  });
});
