import { afterEach, describe, expect, it, vi } from 'vitest';
import { athenaModel, reachedCostLimit } from '../../runtime/eve/agent/lib/model.ts';
import { modelToolOutput } from '../../runtime/eve/agent/lib/tool-output.ts';
import { captureToolImages, fileTokens } from '../../server/eve/media.ts';
import { deflateSync } from 'node:zlib';
import { activeProject, agents, chats, saveSettings, setSecret } from '../../server/store.ts';
import { newAgent } from '../../server/library.ts';
import { selectEveModel } from '../../server/eve/model.ts';
import { attachSession, beginRun, bindSession, readRun, setRunStatus } from '../../server/eve/state.ts';
import { projectEvent } from '../../server/eve/projection.ts';
import { projectTranscript } from '../../server/eve/transcript.ts';
import { eveUsage } from '../../server/eve/usage.ts';
import type { EveRuntimeConfiguration } from '../../shared/types.ts';
import type { SessionStreamEvent } from 'eve/client';

afterEach(() => vi.restoreAllMocks());
const config: EveRuntimeConfiguration = { runId: 'model-proof', provider: 'openrouter', model: 'anthropic/claude-proof', baseUrl: 'https://provider.invalid/v1', apiKey: 'unit-fixture-key', headers: {}, instructions: '', contextWindow: 64000, tools: [], cacheKey: 'private-binding', effort: 'high', temperature: 0, maxModelSteps: 16, costLimitUsd: 2, costBaseline: 0 };
const prompt = () => [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'Hello' }] }];

describe('Eve model controls', () => {
  it.each(['lmstudio', 'custom'] as const)('uses the selected %s connection without remote-provider fields', async (provider) => {
    let sent: Record<string, unknown> = {};
    let target = '';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      target = String(url);
      sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer unit-fixture-key');
      return Response.json({ id: 'completion', created: 1, model: 'local-model', choices: [{ index: 0, message: { role: 'assistant', content: 'Ready' }, finish_reason: 'stop' }] });
    });
    await athenaModel({ ...config, provider, baseUrl: 'http://127.0.0.1:9876/v1', model: 'local-model' }).doGenerate({ prompt: prompt() });
    expect(target).toBe('http://127.0.0.1:9876/v1/chat/completions');
    expect(sent).toMatchObject({ model: 'local-model', reasoning_effort: 'high', temperature: 0 });
    expect(sent).not.toHaveProperty('cache_control');
    expect(sent).not.toHaveProperty('session_id');
  });
  it('counts PDF pages even when a small compressed file expands to many pages', () => {
    const compressed = deflateSync(Buffer.from('/Type /Page '.repeat(12)));
    const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n/Type /ObjStm\nstream\n'), compressed, Buffer.from('\nendstream')]);
    expect(fileTokens('application/pdf', pdf.toString('base64'))).toBe(36000);
    expect(fileTokens('application/pdf', Buffer.from('%PDF-1.4 /Count 40').toString('base64'))).toBe(120000);
  });
  it('sends saved tool images as vision input after all matching tool results', async () => {
    const result = await captureToolImages({ text: 'Screenshot', images: ['data:image/png;base64,YQ=='] });
    expect(modelToolOutput(result)).toMatchObject({ type: 'content', value: [{ type: 'text', text: 'Screenshot' }, { type: 'file', data: { type: 'data', data: 'YQ==' } }] });
    let body: Record<string, unknown> = {};
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ id: 'vision', created: 1, model: config.model, choices: [{ index: 0, message: { role: 'assistant', content: 'Seen' }, finish_reason: 'stop' }] });
    });
    const model = athenaModel(config);
    await model.doGenerate({ prompt: [{ role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'one', toolName: 'screenshot', input: {} }, { type: 'tool-call', toolCallId: 'two', toolName: 'read', input: {} }] }, { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'one', toolName: 'screenshot', output: { type: 'content', value: [{ type: 'text', text: 'Screenshot' }, { type: 'file', data: { type: 'data', data: 'YQ==' }, mediaType: 'image/png' }] } }] }, { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'two', toolName: 'read', output: { type: 'text', value: 'Other result' } }] }] });
    const messages = body.messages as { role: string; content: unknown; tool_call_id?: string }[];
    expect(messages.map((message) => message.role)).toEqual(['assistant', 'tool', 'tool', 'user']);
    expect(messages[1]).toMatchObject({ tool_call_id: 'one', content: 'Screenshot' });
    expect(JSON.stringify(messages.at(-1))).toContain('data:image/png;base64,YQ==');
    const unavailable = await captureToolImages({ text: 'Result', images: ['https://untrusted.invalid/image.png'] });
    expect(unavailable.text).toBe('Result\n\n1 image was left out of what you see: 1 that could not be read as a PNG, JPEG, WebP or GIF of at most 5 MB. Ask for fewer or smaller images if you need them.');
    expect(unavailable.modelImages).toEqual([]);
  });
  it('does not grant another model call because subtracting decimal costs rounds down', () => {
    expect(reachedCostLimit(0.03, 0.02, 0.01)).toBe(true);
    expect(reachedCostLimit(0.03, 0.02, 0.011)).toBe(false);
    expect(reachedCostLimit(0.03, 0.03, 0.01)).toBe(false);
    expect(reachedCostLimit(1, 0, 0)).toBe(false);
  });
  it('sends requested OpenRouter controls, cache identity and the reported cost through the SDK', async () => {
    let sent: Record<string, unknown> = {};
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ id: 'completion', created: 1, model: config.model, choices: [{ index: 0, message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10, cost: '0.0125', prompt_tokens_details: { cached_tokens: 40 } } });
    });
    const result = await athenaModel(config).doGenerate({ prompt: prompt() });
    expect(sent).toMatchObject({ model: config.model, temperature: 0, reasoning: { effort: 'high' }, session_id: 'private-binding', cache_control: { type: 'ephemeral' } });
    expect(sent).not.toHaveProperty('reasoning_effort');
    expect(result.providerMetadata?.gateway).toEqual({ cost: 0.0125 });
    expect(result.usage.inputTokens.cacheRead).toBe(40);
  });

  it('keeps compatible-server controls separate and leaves absent cost unknown in streams', async () => {
    const sent: Record<string, unknown>[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const usage = { prompt_tokens: 20, completion_tokens: 5, ...(sent.length === 2 ? { cost: 0 } : {}) };
      return new Response(`data: ${JSON.stringify({ id: 'response', choices: [{ index: 0, delta: { content: 'Hi' }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    });
    const model = athenaModel({ ...config, provider: 'ollama', effort: 'low', temperature: undefined });
    const costs: unknown[] = [];
    for (let i = 0; i < 2; i++) {
      const result = await model.doStream({ prompt: prompt() });
      for await (const part of result.stream) if (part.type === 'finish') costs.push(part.providerMetadata?.gateway?.cost);
    }
    expect(sent[0]).toMatchObject({ reasoning_effort: 'low', stream_options: { include_usage: true } });
    expect(sent[0]).not.toHaveProperty('reasoning');
    expect(sent[0]).not.toHaveProperty('cache_control');
    expect(sent[0]).not.toHaveProperty('session_id');
    expect(sent[0]).not.toHaveProperty('temperature');
    expect(costs).toEqual([undefined, 0]);
  });

  it('validates temperature and selects supported effort before any dispatch', async () => {
    saveSettings({ contextWindowTokens: 64000, providers: { custom: { baseUrl: 'http://127.0.0.1:9000/v1', label: 'Unit model' } } });
    setSecret('customKey', 'fixture-key');
    const agent = agents.save(newAgent({ engine: 'eve', name: 'Options', provider: 'custom', model: 'selected-model', effort: 'max', temperature: 0.5 }));
    const chat = chats.create(agent.id);
    expect(await selectEveModel(agent, chat)).toMatchObject({ provider: 'custom', model: 'selected-model', effort: 'high', temperature: 0.5, contextWindow: 64000 });
    await expect(selectEveModel({ ...agent, temperature: NaN }, chat)).rejects.toThrow('Temperature');
    await expect(selectEveModel({ ...agent, temperature: 3 }, chat)).rejects.toThrow('Temperature');
  });
});

describe('native Eve usage', () => {
  it('deduplicates all committed usage, including summaries, and preserves unknown cost', () => {
    const agent = agents.save(newAgent({ engine: 'eve', name: 'Meter owner' }));
    const chat = chats.create(agent.id);
    const binding = bindSession(agent, chat, activeProject(), 'meter');
    attachSession(binding.id, 'meter-session');
    beginRun('meter-run', binding.id);
    setRunStatus('meter-run', 'running', 'delivery');
    const event = (line: number, costUsd?: number, summary = false): SessionStreamEvent => ({ type: 'usage.recorded', data: { kind: 'model', owner: summary ? { changeId: 'summary' } : { runId: 'model' }, usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 40, cacheWriteTokens: 5, ...(costUsd === undefined ? {} : { costUsd }) } }, meta: { position: { line, index: 0 }, at: new Date().toISOString() } });
    projectEvent('meter-run', event(1, 0.1));
    projectEvent('meter-run', event(1, 0.1));
    projectEvent('meter-run', event(2, 0.05, true));
    expect(eveUsage('meter-run')).toEqual({ tokens: 220, cached: 80, context: 110, cost: 0.15000000000000002 });
    projectEvent('meter-run', event(3));
    expect(eveUsage('meter-run')).toEqual({ tokens: 330, cached: 120, context: 110 });
    projectTranscript('meter-run');
    projectTranscript('meter-run');
    const saved = chats.get(agent.id, chat.id)!;
    expect(saved.items.filter((item) => item.type === 'meta')).toHaveLength(3);
    expect(JSON.stringify(saved.items)).toContain('Cost not reported');
    expect(JSON.stringify(saved.items)).toContain('Memory summary');
    expect(readRun('meter-run')?.projected).toBe(3);
    expect(saved.context?.tokens).toBe(110);
  });
});
