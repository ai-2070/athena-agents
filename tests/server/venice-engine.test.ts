import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearApiModelCache, resolveApiProvider, apiRequestOptions } from '../../server/apiproviders.ts';
import { run } from '../../server/engines/openai.ts';
import { startRun } from '../../server/engines/index.ts';
import { chats, saveSettings, setSecret } from '../../server/store.ts';
import { newAgent } from '../../server/library.ts';
import { completionBilling } from '../../server/apibilling.ts';
import { newBatch } from '../../server/uploads.ts';
import { effortFor, effortLevels } from '../../shared/effort.ts';
import type { Agent, RunEvent } from '../../shared/types.ts';

const caps = { supportsFunctionCalling: true, supportsVision: true, supportsMultipleImages: false, supportsReasoningEffort: true, reasoningEffortOptions: ['low', 'high'] };
let capabilities: Record<string, unknown>;
let price: Record<string, unknown>;
let replies: (() => Response)[];
let requested: { url: string; headers: Headers; body: Record<string, unknown> }[];
const usage = { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100, prompt_tokens_details: { cached_tokens: 200 } };
const delta = (d: Record<string, unknown>, finish = 'stop') => ({ choices: [{ delta: d, finish_reason: finish }] });
const sse = (...chunks: unknown[]) => {
  const bytes = new TextEncoder().encode(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\r\n\r\n`).join('') + 'data: [DONE]');
  return new Response(new ReadableStream<Uint8Array>({ start(controller) {
    for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
    controller.close();
  } }), { headers: { 'content-type': 'text/event-stream' } });
};
const call = () => delta({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'TaskList', arguments: '{}' } }] }, 'tool_calls');

beforeEach(() => {
  clearApiModelCache();
  setSecret('veniceKey', 'venice-inference-test');
  saveSettings({ brainApproves: false, compaction: { auto: false, windowTokens: 128000 }, costLimitUsdPerRun: 0, maxToolSteps: 4 });
  capabilities = { ...caps };
  price = { input: { usd: 1 }, output: { usd: 2 }, cache_input: { usd: 0.1 } };
  replies = [() => sse(delta({ content: 'Hello 👋' }), { usage, cost: { usd: 0.002, diem: 0 } })];
  requested = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    if (url.endsWith('/models?type=text')) return Response.json({ data: [{ id: 'mock', type: 'text', model_spec: { capabilities, pricing: price } }] });
    requested.push({ url, headers: new Headers(init.headers), body: JSON.parse(String(init.body)) as Record<string, unknown> });
    return (replies.shift() || (() => { throw new Error('Unexpected completion request'); }))();
  });
});
afterEach(() => {
  setSecret('veniceKey', null);
  clearApiModelCache();
  vi.unstubAllGlobals();
});

const go = async (fields: Partial<Agent> = {}, attachments: string[] = []) => {
  const agent = newAgent({ engine: 'openai', provider: 'venice', model: 'mock', effort: 'max', toolGroups: [], mcpServers: [], autonomy: 'full', ...fields });
  const chat = chats.create(agent.id);
  const events: RunEvent[] = [];
  const args = { agent, chat, text: 'Hello', signal: new AbortController().signal, onEvent: (event: RunEvent) => { events.push(event); }, depth: 0, runId: 'venice', systemPrompt: 'Athena instructions', attachments };
  return { agent, chat, events, args, result: await run(args) };
};

describe('Venice API execution', () => {
  it('streams fragmented UTF-8 text with provider-specific options and charges counted once', async () => {
    replies = [() => sse(delta({ reasoning_content: 'private reasoning' }, ''), { usage, cost: { usd: 0.002 } }, delta({ content: 'Hello 👋' }), { usage, cost: { usd: 0.002, diem: 0 } })];
    const { result, events } = await go();
    expect(result).toMatchObject({ text: 'Hello 👋', cost: 0.002, tokens: 1100, cached: 200, billing: { source: 'reported', chargedUsd: 0.002, chargedDiem: 0 } });
    expect(events.filter((event) => event.kind === 'text')).toEqual([{ kind: 'text', text: 'Hello 👋' }]);
    expect(requested[0]?.url).toBe('https://api.venice.ai/api/v1/chat/completions');
    expect(requested[0]?.headers.get('authorization')).toBe('Bearer venice-inference-test');
    expect(requested[0]?.headers.has('HTTP-Referer')).toBe(false);
    expect(requested[0]?.headers.has('X-Title')).toBe(false);
    expect(requested[0]?.body).toMatchObject({ model: 'mock', stream: true, stream_options: { include_usage: true }, reasoning_effort: 'high', venice_parameters: { include_venice_system_prompt: false, enable_web_search: 'off' } });
    expect(requested[0]?.body).not.toHaveProperty('session_id');
    expect(requested[0]?.body).not.toHaveProperty('cache_control');
    expect(requested[0]?.body).not.toHaveProperty('reasoning');
  });

  it('runs a complete tool round trip and stops before another model step past the budget', async () => {
    replies = [() => sse(call(), { usage, cost: { usd: 0.01 } }), () => sse(delta({ content: 'Done' }), { usage, cost: { usd: 0.02 } })];
    expect((await go()).result).toMatchObject({ text: 'Done', cost: 0.03, tokens: 2200 });
    expect(requested[1]?.body.messages).toContainEqual(expect.objectContaining({ role: 'tool', tool_call_id: 'c1' }));
    saveSettings({ costLimitUsdPerRun: 0.005 });
    requested = [];
    replies = [() => sse(call(), { usage, cost: { usd: 0.01 } })];
    const stopped = await go();
    expect(requested).toHaveLength(1);
    expect(stopped.events).toContainEqual({ kind: 'text', text: expect.stringContaining('passed the $0.005 limit') });
  });

  it('uses catalog estimates for DIEM and preserves both charged currencies', async () => {
    replies = [() => sse(delta({ content: 'Done' }), { usage, cost: { usd: 0, diem: 0.05 } })];
    const { result } = await go();
    expect(result.cost).toBeCloseTo(0.00102);
    expect(result.billing).toEqual({ source: 'estimated', chargedUsd: 0, chargedDiem: 0.05 });
  });

  it('reports missing cost as unavailable and persists billing with saved chat usage', async () => {
    price = {};
    replies = [() => sse(delta({ content: 'Done' }), { usage })];
    const { result, events } = await go();
    expect(result).not.toHaveProperty('cost');
    expect(result.billing?.source).toBe('unavailable');
    expect(events).toContainEqual({ kind: 'status', text: expect.stringContaining('monetary limit cannot be measured') });
    replies = [() => sse(delta({ content: 'Done' }), { usage, cost: { usd: 0, diem: 0.5 } })];
    const agent = newAgent({ engine: 'openai', provider: 'venice', model: 'mock', toolGroups: [] });
    const chat = chats.create(agent.id);
    await startRun(agent, chat, 'Hello').promise;
    expect(chats.get(agent.id, chat.id)?.items).toContainEqual(expect.objectContaining({ type: 'meta', text: expect.stringContaining('Cost unavailable'), billing: { source: 'unavailable', chargedUsd: 0, chargedDiem: 0.5 } }));
  });

  it('omits unsupported tools and effort and handles text-only and single-image models', async () => {
    capabilities = { supportsFunctionCalling: false, supportsReasoningEffort: false, supportsVision: false };
    const { dir } = newBatch();
    const pictures = ['one.png', 'two.png'].map((name) => {
      const file = path.join(dir, name);
      fs.writeFileSync(file, Buffer.from('iVBORw0KGgo=', 'base64'));
      return file;
    });
    await go({}, pictures);
    expect(requested[0]?.body).not.toHaveProperty('tools');
    expect(requested[0]?.body).not.toHaveProperty('reasoning_effort');
    expect(JSON.stringify(requested[0]?.body.messages)).toContain("can't see images");
    clearApiModelCache();
    capabilities = { ...caps };
    replies = [() => sse(delta({ content: 'Done' }), { usage })];
    await go({}, pictures);
    expect(JSON.stringify(requested[1]?.body.messages).match(/data:image\/png/g)).toHaveLength(1);
  });

  it.each([401, 402, 403, 429])('keeps HTTP %s errors without retrying or changing providers', async (status) => {
    replies = [() => Response.json({ error: 'Venice refused the request' }, { status })];
    await expect(go()).rejects.toMatchObject({ status, message: `${status}: Venice refused the request` });
    expect(requested).toHaveLength(1);
  });

  it.each([delta({ content: 'Partial' }, ''), delta({ tool_calls: [{ index: 0, function: { name: 'Task', arguments: '{' } }] }, '')])('never retries an error after text or tool fragments', async (fragment) => {
    replies = [() => sse(fragment, { error: 'tool reasoning image context too long', code: 400 })];
    await expect(go()).rejects.toMatchObject({ status: 400, midStream: true });
    expect(requested).toHaveLength(1);
  });

  it('keeps OpenRouter headers and cache options scoped to OpenRouter', () => {
    setSecret('openrouterKey', 'or-test');
    expect(resolveApiProvider('openrouter').headers).toMatchObject({ authorization: 'Bearer or-test', 'X-Title': 'Athena Agents' });
    expect(apiRequestOptions('openrouter', 'anthropic/claude', 'high', 'chat')).toMatchObject({ usage: { include: true }, reasoning: { effort: 'high' }, session_id: 'chat', cache_control: { type: 'ephemeral' } });
    expect(() => resolveApiProvider('constructor')).toThrow('Unknown provider');
  });
});

describe('Venice effort and accounting boundaries', () => {
  it('selects the nearest advertised level and omits unknown capabilities', () => {
    expect(effortLevels('openai', 'venice', ['high', 'low'])).toEqual(['low', 'high']);
    expect(effortFor('openai', 'medium', 'venice', ['low', 'high'])).toBe('low');
    expect(effortFor('openai', 'max', 'venice', ['low', 'high'])).toBe('high');
    expect(effortFor('openai', 'high', 'venice')).toBe('');
    expect(effortLevels('openai', 'venice', [])).toEqual([]);
  });

  it('handles cost without usage, zero-cost reports and incomplete estimates', () => {
    expect(completionBilling(null, { usd: 0.2 }, null)).toMatchObject({ cost: 0.2, billing: { source: 'reported' } });
    expect(completionBilling(null, { usd: 0, diem: 0 }, null).cost).toBe(0);
    expect(completionBilling({ total_tokens: 2 }, null, { in: 1, out: 2 }).billing.source).toBe('unavailable');
    expect(completionBilling(usage, null, { in: 0, out: 0 }).cost).toBe(0);
  });
});
