import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveSettings, setSecret } from '../../server/store.ts';
import { brainModel, think } from '../../server/brain.ts';
import { clearApiModelCache } from '../../server/apiproviders.ts';
import type { ThinkPart } from '../../server/brain.ts';

vi.mock('../../server/util.ts', async (original) => ({
  ...(await original<typeof import('../../server/util.ts')>()),
  which: () => null,
}));

let answer: () => Response;
let requested: { url: string; headers: Headers; body: Record<string, unknown> }[];
beforeEach(() => {
  clearApiModelCache();
  setSecret('veniceKey', 'venice-brain-test');
  setSecret('openrouterKey', null);
  saveSettings({ brain: { provider: 'venice', model: 'mock', effort: 'max' }, defaults: { veniceModel: '' } });
  requested = [];
  answer = () => Response.json({ choices: [{ message: { content: '{"ready":true}' }, finish_reason: 'stop' }] });
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    if (url.endsWith('/models?type=text'))
      return Response.json({
        data: [
          {
            id: 'mock',
            model_spec: { capabilities: { supportsReasoningEffort: true, reasoningEffortOptions: ['low', 'high'] } },
          },
        ],
      });
    requested.push({
      url,
      headers: new Headers(init.headers),
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
    });
    return answer();
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  clearApiModelCache();
  setSecret('veniceKey', null);
});

describe('Venice Brain', () => {
  it('answers with only a Venice key and keeps Athena system instructions', async () => {
    expect(brainModel()).toMatchObject({ provider: 'venice', model: 'mock', fallback: false });
    expect(await think('Athena rules', 'Plan a team')).toBe('{"ready":true}');
    expect(requested[0]).toMatchObject({
      url: 'https://api.venice.ai/api/v1/chat/completions',
      body: {
        model: 'mock',
        reasoning_effort: 'high',
        messages: [
          { role: 'system', content: 'Athena rules' },
          { role: 'user', content: 'Plan a team' },
        ],
        venice_parameters: { include_venice_system_prompt: false },
      },
    });
    expect(requested[0]?.headers.get('authorization')).toBe('Bearer venice-brain-test');
    expect(requested[0]?.body).not.toHaveProperty('session_id');
    expect(requested[0]?.body).not.toHaveProperty('stream');
  });

  it('streams answer text without reasoning and reads the last line without a newline', async () => {
    answer = () =>
      new Response(
        'data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}\n\ndata: {"choices":[{"delta":{"content":"Done"},"finish_reason":"stop"}]}',
        { headers: { 'content-type': 'text/event-stream' } },
      );
    const parts: ThinkPart[] = [];
    expect(await think('Rules', 'Go', { onPart: (p) => parts.push(p) })).toBe('Done');
    expect(parts).toEqual([{ kind: 'text', text: 'Done' }]);
    expect(requested[0]?.body).toMatchObject({ stream: true, stream_options: { include_usage: true } });
  });

  it('uses Venice last in setup fallback and requires its own model default', async () => {
    saveSettings({ brain: { provider: 'claude', model: 'haiku' } });
    expect(brainModel()).toMatchObject({ provider: 'venice', model: '', fallback: true });
    await expect(think('Rules', 'Go')).rejects.toThrow('Choose a Venice model');
    expect(requested).toHaveLength(0);
    saveSettings({ defaults: { veniceModel: 'mock' } });
    expect(await think('Rules', 'Go')).toBe('{"ready":true}');
    expect(requested[0]?.body.model).toBe('mock');
  });

  it.each([false, true])('rejects cut-off JSON (streamed: %s)', async (streamed) => {
    answer = () =>
      streamed
        ? new Response('data: {"choices":[{"delta":{"content":"{"},"finish_reason":"length"}]}\n\n')
        : Response.json({ choices: [{ message: { content: '{' }, finish_reason: 'length' }] });
    await expect(think('Rules', 'Go', streamed ? { onPart: () => {} } : {})).rejects.toThrow('cut off');
  });

  it('keeps Venice HTTP and stream errors without a provider fallback', async () => {
    answer = () => Response.json({ error: 'Insufficient balance' }, { status: 402 });
    await expect(think('Rules', 'Go')).rejects.toMatchObject({ message: 'Insufficient balance', status: 402 });
    answer = () => new Response('data: {"error":"Temporarily unavailable"}\n\n');
    await expect(think('Rules', 'Go', { onPart: () => {} })).rejects.toThrow('Temporarily unavailable');
    expect(requested.map((r) => r.url)).toEqual(Array(2).fill('https://api.venice.ai/api/v1/chat/completions'));
  });
});
