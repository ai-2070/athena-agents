import { afterEach, describe, expect, it, vi } from 'vitest';
import { chats, getSettings, saveSettings, secretStatus, setSecret } from '../../server/store.ts';
import { newAgent } from '../../server/library.ts';
import { defaultModelFor, modelProvider, providerProblem, readyProviders } from '../../server/models.ts';
import { PROVIDERS, run, status } from '../../server/engines/openai.ts';
import { defaultModelForEngine } from '../../shared/modeldefaults.ts';

afterEach(() => {
  setSecret('veniceKey', null);
  saveSettings({ defaults: { veniceModel: '' } });
  vi.unstubAllGlobals();
});

describe('Venice setup and defaults', () => {
  it('has its own readiness and secret status', () => {
    expect(modelProvider('Venice')).toBe('venice');
    expect(providerProblem('venice')).toContain('Venice key');
    expect(status().venice).toBe(false);
    setSecret('veniceKey', 'venice-sentinel-4321');
    expect(status().venice).toBe(true);
    expect(readyProviders()).toContain('venice');
    expect(PROVIDERS.venice.base()).toBe('https://api.venice.ai/api/v1');
    expect(secretStatus().veniceKey).toEqual({ set: true, hint: '…4321' });
    expect(JSON.stringify(secretStatus())).not.toContain('venice-sentinel');
    setSecret('veniceKey', null);
    expect(secretStatus().veniceKey).toEqual({ set: false });
    expect(readyProviders()).not.toContain('venice');
  });

  it('keeps hosted model defaults separate, including old agents without a provider', () => {
    const defaults = getSettings().defaults;
    expect(defaultModelForEngine('openai', defaults)).toBe(defaults.openrouterModel);
    expect(defaultModelForEngine('openai', defaults, 'venice')).toBe('');
    expect(defaultModelFor('venice')).toBeNull();
    expect(newAgent({ engine: 'openai', provider: 'venice' }).model).toBe('');
    saveSettings({ defaults: { veniceModel: 'venice-model' } });
    expect(defaultModelFor('venice')).toBe('venice-model');
    expect(newAgent({ engine: 'openai', provider: 'venice' }).model).toBe('venice-model');
    expect(newAgent({ engine: 'openai' }).model).toBe(defaults.openrouterModel);
    expect(newAgent({ engine: 'openai', provider: 'venice', model: 'chosen' }).model).toBe('chosen');
    expect(defaultModelForEngine('openai', defaults, 'lmstudio')).toBe('');
  });

  it('asks for a Venice key or model before making any request', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const agent = newAgent({ engine: 'openai', provider: 'venice' });
    const args = { agent, chat: chats.create(agent.id, 'Setup'), text: 'Hello', signal: new AbortController().signal, onEvent: () => {}, depth: 0, runId: 'setup', systemPrompt: 'Be brief.', attachments: [] };
    await expect(run(args)).rejects.toThrow('Add your Venice key');
    setSecret('veniceKey', 'venice-test');
    await expect(run(args)).rejects.toThrow('Choose a Venice model');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
