// Inspect the prompt a real team turn sends to a fake model, including both context limits.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newAgent } from '../../server/library.ts';
import { activeProject, saveSettings, workflows } from '../../server/store.ts';
import { dataPath, writeJSON } from '../../server/util.ts';
import { getThread, postUserMessage, teamState } from '../../server/teams.ts';
import { teamDigest } from '../../server/teamdigest.ts';
import type { Team, TeamMessage } from '../../shared/types.ts';

let server: http.Server;
let prompt = '';
beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    if (req.url?.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'mock' }] }));
    let body = '';
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body) as { messages: { content: string }[] };
    prompt = request.messages.at(-1)!.content;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Done.' } }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  saveSettings({ providers: { custom: { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, label: 'Fake' } } });
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const message = (text: string, from = 'user'): TeamMessage => ({ id: `m-${Math.random()}`, ts: 1, from, text, mentions: [] });
const inspect = async (messages: TeamMessage[], latest = 'Please continue') => {
  const reader = newAgent({ name: 'Reader', engine: 'openai', provider: 'custom', model: 'mock', toolGroups: [] });
  const team = workflows.save({ name: 'Digest', members: [reader.id], lead: reader.id, steps: [] } as Partial<Team>);
  writeJSON(dataPath('projects', activeProject().id, 'teamchats', `${team.id}.json`), { messages, sessions: {}, seen: {} });
  prompt = '';
  await postUserMessage(team.id, latest);
  await expect.poll(() => teamState(team.id).working.length).toBe(0);
  expect(getThread(team.id).messages.at(-1)?.text).toBe('Done.');
  const context = prompt.split('New in the team chat since you last spoke:\n\n')[1].split('\n\n---\n')[0];
  const parts = context.split('\n\nRecent in this chat:\n');
  const earlier = parts.length === 2 ? parts[0] : '';
  const recent = parts.at(-1)!;
  expect(recent.length).toBeLessThanOrEqual(9000);
  expect(earlier.length).toBeLessThanOrEqual(2000);
  return { prompt, earlier, recent };
};
const sources = (n: number) => Array.from({ length: n }, (_,i) => {
  const author = newAgent({ name: `Source${i}` });
  return message(`message ${i} ${'x'.repeat(2500)}`, author.id);
});

describe('team digest', () => {
  it('keeps short messages intact and in order without a fold block', async () => {
    const { prompt, recent, earlier } = await inspect([message('First'), message('Second', 'brain')]);
    expect(recent).toBe('You (the user): First\n\nThe Brain (overseer): Second\n\nYou (the user): Please continue');
    expect(earlier).toBe('');
    expect(prompt).not.toContain('[message shortened]');
  });

  it('previews all older messages when their previews fit', async () => {
    const { earlier, recent } = await inspect(sources(5));
    expect(earlier).toContain('Earlier in this chat (shortened):');
    expect(earlier).toContain('@Source0: message 0');
    expect(earlier).toContain('@Source1: message 1');
    expect(earlier).toContain('2 earlier messages: 2 previews; 0 not shown.');
    expect(recent).toContain('@Source4: message 4');
    expect(recent.endsWith('You (the user): Please continue')).toBe(true);
  });

  it('reserves the oldest preview and counts omissions when the fold overflows', async () => {
    const { earlier, recent } = await inspect(sources(40));
    expect(earlier).toContain('@Source0: message 0');
    expect(earlier).not.toContain('@Source1:');
    expect(earlier).toContain('@Source36: message 36');
    const count = /37 earlier messages: (\d+) previews; (\d+) not shown\./.exec(earlier)!;
    expect(count).not.toBeNull();
    const previews = earlier.match(/@Source\d+:/g) || [];
    expect(Number(count[1])).toBe(previews.length);
    expect(Number(count[1]) + Number(count[2])).toBe(37);
    expect(Number(count[2])).toBeGreaterThan(0);
    expect(recent).toContain('@Source39: message 39');
  });

  it('marks per-message clipping even without aggregate overflow, including addressed text', async () => {
    const { prompt, recent, earlier } = await inspect([], `${'z'.repeat(10000)}UNIQUE_TAIL`);
    expect(earlier).toBe('');
    expect(recent).toContain(`${'z'.repeat(2500)} [message shortened]`);
    expect(prompt.split('Addressed to you:\n')[1]).toContain('[message shortened]');
    expect(prompt).not.toContain('UNIQUE_TAIL');
  });

  it('bounds huge relay labels and attachment labels instead of losing the newest context', async () => {
    const long = message('Important work', 'team:other');
    long.relay = { teamId: 'other', teamName: 'Relay'.repeat(2500), by: 'user', byName: 'Someone' };
    long.attachments = Array.from({ length: 200 }, (_,i) => `missing-${i}-${'a'.repeat(50)}.txt`);
    const { recent, earlier } = await inspect([long]);
    expect(recent + earlier).toContain('[message shortened]');
    expect(recent).toContain('Please continue');
    // A too-large older line may be folded; both paths must retain a marked preview.
    expect(recent + earlier).toContain('#Relay');
  });

  it('counts separators in the recent budget and keeps longer user and Brain previews', async () => {
    const old = [message('USER_INTENT '.repeat(100)), message('BRAIN_INTENT '.repeat(100), 'brain')];
    const { earlier } = await inspect([...old, ...sources(4)]);
    expect(earlier).toContain('USER_INTENT '.repeat(30));
    expect(earlier).toContain('BRAIN_INTENT '.repeat(30));
  });

  it('counts separators at the exact recent-block boundary', async () => {
    const text = 'x'.repeat(2250 - 'You (the user): '.length);
    const { earlier, recent } = await inspect([message(text), message(text), message(text)], text);
    expect(earlier).toContain('1 earlier message: 1 preview; 0 not shown.');
    expect(recent.length).toBe(6754);
  });

  it('delivers a marked preview when the newest rendered line alone exceeds the cap', () => {
    const long = message('Important');
    long.attachments = Array.from({ length: 200 }, (_,i) => `missing-${i}-${'a'.repeat(50)}.txt`);
    const digest = teamDigest([long], () => 'Name'.repeat(3000));
    expect(digest.length).toBe(9000);
    expect(digest.endsWith('[message shortened]')).toBe(true);
    expect(digest).toContain('Important');
    expect(digest).not.toContain('Earlier in this chat');
  });
});
