// Prompt caching: what OpenRouter requests add, and instructions that stay the same through the day.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { asksForCache, brainSession, cacheFields, systemMessage } from '../../server/promptcache.ts';
import { buildSystemPrompt, startRun } from '../../server/engines/index.ts';
import { think } from '../../server/brain.ts';
import { newAgent } from '../../server/library.ts';
import { chats, saveSettings, setSecret } from '../../server/store.ts';

describe('cacheFields', () => {
  it('Claude models on OpenRouter get a cache point and stay with one provider', () => {
    expect(cacheFields('openrouter', 'anthropic/claude-sonnet-5.5', 'c_1')).toEqual({
      session_id: 'c_1',
      cache_control: { type: 'ephemeral' },
    });
    expect(asksForCache('openrouter', '~anthropic/claude-haiku-latest')).toBe(true);
  });

  it('other OpenRouter models cache by themselves: only the session', () => {
    expect(cacheFields('openrouter', 'openai/gpt-5.5', 'c_1')).toEqual({ session_id: 'c_1' });
    expect(cacheFields('openrouter', 'deepseek/deepseek-v4', null)).toEqual({});
  });

  it('local and custom servers get nothing they might not understand', () => {
    for (const p of ['lmstudio', 'ollama', 'custom'])
      expect(cacheFields(p, 'anthropic/claude-sonnet-5.5', 'c_1')).toEqual({});
  });
});

describe('systemMessage (the Brain)', () => {
  it('marks the end of the instructions for a Claude model', () => {
    expect(systemMessage('anthropic/claude-haiku-5.5', 'rules')).toEqual({
      role: 'system',
      content: [{ type: 'text', text: 'rules', cache_control: { type: 'ephemeral' } }],
    });
  });

  it('leaves other models as plain text', () => {
    expect(systemMessage('google/gemini-3-flash', 'rules')).toEqual({ role: 'system', content: 'rules' });
  });
});

describe('the Brain keeps to one provider', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('one session per set of instructions, whatever the question', async () => {
    setSecret('openrouterKey', 'sk-or-test');
    saveSettings({ brain: { provider: 'openrouter', model: 'anthropic/claude-haiku-5.5' } });
    const sent: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }), {
        status: 200,
      });
    });
    await think('rules', 'first question');
    await think('rules', 'second question');
    await think('other rules', 'first question');
    expect(sent[0].session_id).toBe(brainSession('rules'));
    expect(sent[1].session_id).toBe(sent[0].session_id);
    expect(sent[2].session_id).not.toBe(sent[0].session_id);
    expect(String(sent[0].session_id).length).toBeLessThanOrEqual(256);
  });
});

describe('buildSystemPrompt', () => {
  afterEach(() => vi.useRealTimers());

  it('is the same all day, so the cache isn’t thrown away every minute', () => {
    const agent = { ...newAgent({ name: 'Cachey', engine: 'eve' }), id: 'a_cache' };
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 26, 9, 5));
    const morning = buildSystemPrompt(agent);
    vi.setSystemTime(new Date(2026, 9, 26, 17, 48));
    expect(buildSystemPrompt(agent)).toBe(morning);
    expect(morning).toContain('Monday, October 26, 2026');
    vi.setSystemTime(new Date(2026, 9, 27, 9, 5));
    expect(buildSystemPrompt(agent)).not.toBe(morning);
  });
});

describe('a run that read from the cache', () => {
  // a fake API model that says most of the request came from its cache
  let server: http.Server;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        if (req.url?.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'mock' }] }));
        const usage = {
          cost: 0.002,
          total_tokens: 5000,
          prompt_tokens: 4900,
          completion_tokens: 100,
          prompt_tokens_details: { cached_tokens: 4096 },
        };
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }], usage })}\n\ndata: [DONE]\n\n`,
        );
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    saveSettings({
      providers: {
        custom: { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, label: 'Fake model' },
      },
    });
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('says so next to the cost', async () => {
    const a = newAgent({ name: 'Cached run', engine: 'eve', provider: 'custom', model: 'mock', toolGroups: [] });
    const chat = chats.create(a.id);
    await startRun(a, chat, 'hello').promise;
    const meta = chats.get(a.id, chat.id)!.items.find((i) => i.type === 'meta');
    expect(meta).toMatchObject({ text: '$0.0020 · 5000 tokens · 4096 from cache' });
  });
});
