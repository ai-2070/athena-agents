import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeApiModels } from '../../server/apimodels.ts';
import { listModels } from '../../server/engines/openai.ts';
import { availableModels, checkModel, clearModelCache, findModels, providerProblem } from '../../server/models.ts';
import { setSecret } from '../../server/store.ts';
import { newAgent } from '../../server/library.ts';
import { contextWindow } from '../../server/compaction.ts';

const model = {
  id: 'venice-chat', type: 'text', model_spec: {
    name: 'Venice Chat', availableContextTokens: 131072, offline: false,
    capabilities: { supportsFunctionCalling: false, supportsVision: true, supportsMultipleImages: false, supportsReasoningEffort: true, reasoningEffortOptions: ['none', 'low', 'high', 'future-option'] },
    pricing: { input: { usd: 0.15 }, output: { usd: 0.6 }, cache_input: { usd: 0.03 } },
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
  clearModelCache();
  setSecret('veniceKey', null);
});

describe('Venice model discovery', () => {
  it('normalizes nested metadata without multiplying already-per-million prices', () => {
    expect(normalizeApiModels({ data: [model] }, 'venice')).toEqual([{
      id: 'venice-chat', name: 'Venice Chat', context: 131072, tools: false, vision: true, multipleImages: false,
      reasoningEfforts: ['low', 'high'], offline: false, price: { in: 0.15, out: 0.6, cached: 0.03 },
    }]);
  });

  it('keeps absent capabilities and prices unknown, preserves zero prices, and rejects malformed rows', () => {
    const rows = normalizeApiModels({ data: [null, { id: 1 }, {}, { id: 'image', type: 'image' }, { id: 'bare' }, {
      id: 'free', model_spec: { availableContextTokens: -1, capabilities: { supportsReasoningEffort: false }, pricing: { input: { usd: 0 }, output: { usd: '0' } } },
    }] }, 'venice');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: 'bare', context: null, price: null });
    expect(rows[0]?.tools).toBeUndefined();
    expect(rows[0]?.reasoningEfforts).toBeUndefined();
    expect(rows[1]).toMatchObject({ id: 'free', context: null, price: { in: 0, out: 0 }, reasoningEfforts: [] });
    expect(normalizeApiModels({ data: 'invalid' }, 'venice')).toEqual([]);
  });

  it('lists the public text catalog without a key while inference stays unconfigured', async () => {
    const fetcher = vi.fn(async () => Response.json({ data: [model] }));
    vi.stubGlobal('fetch', fetcher);
    expect((await listModels('venice'))[0]?.name).toBe('Venice Chat');
    expect(fetcher).toHaveBeenCalledWith('https://api.venice.ai/api/v1/models?type=text', { headers: {}, signal: expect.any(AbortSignal) });
    expect(providerProblem('venice')).toContain('no Venice key');
    const found = await findModels('venice', 'chat');
    expect(found).toContain('no tool use');
    expect(found).toContain('$0.15 in / $0.60 out');
    expect(found).toContain('131k context');
    expect(found).toContain('not usable right now');
    expect(await contextWindow(newAgent({ engine: 'openai', provider: 'venice', model: 'venice-chat' }))).toBe(131072);
  });

  it('reports offline models and rejects them for new selections', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ data: [{ ...model, model_spec: { ...model.model_spec, offline: true } }] }));
    expect((await availableModels('venice'))[0]?.note).toContain('temporarily unavailable');
    expect(await checkModel('venice', 'venice-chat')).toContain('temporarily unavailable');
  });

  it('does not accept a failed HTTP response as a catalog or change OpenRouter price units', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ data: [model] }, { status: 403 }));
    expect(await listModels('venice')).toEqual([]);
    expect(normalizeApiModels({ data: [{ id: 'a/b', supported_parameters: ['tools'], pricing: { prompt: '0.000001', completion: '0.000003' } }] }, 'openrouter')[0]).toMatchObject({ tools: true, price: { in: 1, out: 3 } });
    expect(normalizeApiModels({ data: [{ id: 'local' }] }, 'lmstudio')[0]).toMatchObject({ tools: true, price: null });
  });
});
