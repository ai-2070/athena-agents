import { afterEach, describe, expect, it, vi } from 'vitest';
import { completionBilling } from '../../server/apibilling.ts';
import { effortFor, effortLevels } from '../../shared/effort.ts';
import { apiRequestOptions, resolveApiProvider } from '../../server/apiproviders.ts';
import { setSecret } from '../../server/store.ts';
import { athenaModel } from '../../runtime/eve/agent/lib/model.ts';
import type { EveRuntimeConfiguration } from '../../shared/types.ts';
const usage = {
  prompt_tokens: 1000,
  completion_tokens: 100,
  total_tokens: 1100,
  prompt_tokens_details: { cached_tokens: 200 },
};
const config: EveRuntimeConfiguration = {
  runId: 'venice',
  provider: 'venice',
  model: 'mock',
  baseUrl: 'https://api.venice.ai/api/v1',
  apiKey: 'venice-fixture',
  headers: {},
  instructions: 'Athena rules',
  contextWindow: 64000,
  effort: 'high',
  cacheKey: 'private',
  costBaseline: 0,
  costLimitUsd: 2,
  maxModelSteps: 4,
  tools: [],
  price: { in: 1, out: 2, cached: 0.1 },
};
const prompt = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'Hello' }] }];
afterEach(() => vi.unstubAllGlobals());

describe('Venice model adapter', () => {
  it('reads fragmented UTF-8 and records repeated cumulative charges only once', async () => {
    const chunks = [
      { choices: [{ index: 0, delta: { reasoning_content: 'private reasoning' }, finish_reason: null }] },
      { usage, cost: { usd: 0.002 } },
      { choices: [{ index: 0, delta: { content: 'Hello 👋' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage, cost: { usd: 0.002, diem: 0 } },
    ];
    const bytes = new TextEncoder().encode(
      chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\r\n\r\n`).join('') + 'data: [DONE]',
    );
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
              controller.close();
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    );
    const report = vi.fn(async () => {});
    const result = await athenaModel(config, undefined, report).doStream({ prompt });
    let text = '';
    for await (const part of result.stream) if (part.type === 'text-delta') text += part.delta;
    expect(text).toBe('Hello 👋');
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith({
      id: expect.any(String),
      cost: 0.002,
      billing: { source: 'reported', chargedUsd: 0.002, chargedDiem: 0 },
    });
  });

  it.each([401, 402, 403, 429])(
    'keeps HTTP %s errors without switching provider or retrying in the adapter',
    async (status) => {
      const fetcher = vi.fn(async (_url: unknown) =>
        Response.json({ error: { message: 'Venice refused the request' } }, { status }),
      );
      vi.stubGlobal('fetch', fetcher);
      await expect(athenaModel(config).doStream({ prompt })).rejects.toMatchObject({ statusCode: status });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(String(fetcher.mock.calls[0]?.[0])).toContain('https://api.venice.ai/api/v1/chat/completions');
    },
  );

  it('keeps OpenRouter headers and cache options scoped to OpenRouter', () => {
    setSecret('openrouterKey', 'or-fixture');
    expect(resolveApiProvider('openrouter').headers).toMatchObject({
      authorization: 'Bearer or-fixture',
      'X-Title': 'Athena Agents',
    });
    expect(apiRequestOptions('openrouter', 'anthropic/claude', 'high', 'chat')).toMatchObject({
      usage: { include: true },
      reasoning: { effort: 'high' },
      session_id: 'chat',
      cache_control: { type: 'ephemeral' },
    });
    expect(() => resolveApiProvider('constructor')).toThrow('Unknown provider');
  });
});

describe('Venice effort and accounting boundaries', () => {
  it('selects the nearest advertised level and omits unknown capabilities', () => {
    expect(effortLevels('eve', 'venice', ['high', 'low'])).toEqual(['low', 'high']);
    expect(effortFor('eve', 'medium', 'venice', ['low', 'high'])).toBe('low');
    expect(effortFor('eve', 'max', 'venice', ['low', 'high'])).toBe('high');
    expect(effortFor('eve', 'high', 'venice')).toBe('');
    expect(effortLevels('eve', 'venice', [])).toEqual([]);
  });

  it('handles cost without usage, zero-cost reports and incomplete estimates', () => {
    expect(completionBilling(null, { usd: 0.2 }, null)).toMatchObject({ cost: 0.2, billing: { source: 'reported' } });
    expect(completionBilling(null, { usd: 0, diem: 0 }, null).cost).toBe(0);
    expect(completionBilling({ total_tokens: 2 }, null, { in: 1, out: 2 }).billing.source).toBe('unavailable');
    expect(completionBilling(usage, null, { in: 0, out: 0 }).cost).toBe(0);
  });
});
