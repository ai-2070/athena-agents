import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { agents, chats, saveSettings, setSecret } from '../../server/store.ts';
import { newAgent } from '../../server/library.ts';
import { startRun, stopAllRuns } from '../../server/engines/index.ts';
import { eveRuntime } from '../../server/eve/runtime.ts';
import { eveCoordinator } from '../../server/eve/coordinator.ts';
import { readRun } from '../../server/eve/state.ts';
import { eveUsage } from '../../server/eve/usage.ts';
import { newBatch } from '../../server/uploads.ts';
import * as providers from '../../server/apiproviders.ts';
import type { ApiModelInfo } from '../../shared/types.ts';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=';
const usage = {
  prompt_tokens: 1000,
  completion_tokens: 100,
  total_tokens: 1100,
  prompt_tokens_details: { cached_tokens: 200 },
};
const text = { content: 'Venice answer' };
const tool = {
  tool_calls: [{ index: 0, id: 'task-call', type: 'function', function: { name: 'TaskList', arguments: '{}' } }],
};
const completion = (delta: unknown = text, cost: unknown = { usd: 0.002, diem: 0 }) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: delta === tool ? 'tool_calls' : 'stop' }], usage, cost })}\n\ndata: [DONE]\n\n`;
let server: http.Server;
let baseUrl = '';
let info: ApiModelInfo;
let replies: string[] = [];
let requested: { headers: http.IncomingHttpHeaders; body: Record<string, unknown> }[] = [];
const resolveProvider = providers.resolveApiProvider;

beforeAll(async () => {
  server = http.createServer(async (request, response) => {
    let raw = '';
    for await (const part of request) raw += String(part);
    requested.push({ headers: request.headers, body: JSON.parse(raw) as Record<string, unknown> });
    const reply = replies.shift();
    if (!reply) return response.writeHead(500).end('Unexpected model request.');
    response.writeHead(200, { 'content-type': 'text/event-stream' }).end(reply);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port.');
  baseUrl = `http://127.0.0.1:${address.port}/v1`;
  setSecret('veniceKey', 'venice-native-fixture');
  vi.spyOn(providers, 'resolveApiProvider').mockImplementation((id) => ({
    ...resolveProvider(id),
    ...(id === 'venice' ? { base: baseUrl } : {}),
  }));
  vi.spyOn(providers, 'apiModelInfo').mockImplementation(async () => info);
});

beforeEach(() => {
  info = {
    id: 'mock',
    name: 'Venice mock',
    context: 64000,
    tools: true,
    vision: true,
    multipleImages: false,
    reasoningEfforts: ['low', 'high'],
    price: { in: 1, out: 2, cached: 0.1 },
  };
  requested = [];
  replies = [completion()];
  saveSettings({
    contextWindowTokens: 64000,
    brainFollowsUp: false,
    brainApproves: false,
    maxToolSteps: 4,
    costLimitUsdPerRun: 0,
  });
});

afterAll(async () => {
  await stopAllRuns();
  await eveCoordinator.close();
  await eveRuntime.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.restoreAllMocks();
});

const go = (attachments: string[] = []) => {
  const agent = agents.save(
    newAgent({
      name: 'Native Venice',
      engine: 'eve',
      provider: 'venice',
      model: 'mock',
      effort: 'max',
      autonomy: 'full',
      toolGroups: [],
      mcpServers: [],
      richAnswers: false,
    }),
  );
  const chat = chats.create(agent.id);
  return { agent, chat, ...startRun(agent, chat, 'Answer using Venice.', { attachments }) };
};

describe('Venice through the native Eve runtime', () => {
  it('keeps provider controls, charges and tool results through a complete turn', async () => {
    replies = [completion(tool, { usd: 0.01 }), completion(text, { usd: 0.02 })];
    const run = go();
    expect(await run.promise).toBe('Venice answer');
    expect(requested).toHaveLength(2);
    expect(requested[0]!.headers.authorization).toBe('Bearer venice-native-fixture');
    expect(requested[0]!.headers['http-referer']).toBeUndefined();
    expect(requested[0]!.headers['x-title']).toBeUndefined();
    expect(requested[0]!.body).toMatchObject({
      model: 'mock',
      reasoning_effort: 'high',
      stream_options: { include_usage: true },
      venice_parameters: {
        include_venice_system_prompt: false,
        strip_thinking_response: true,
        enable_web_search: 'off',
        enable_web_scraping: false,
        enable_x_search: false,
      },
    });
    expect(requested[0]!.body).not.toHaveProperty('session_id');
    expect(requested[0]!.body).not.toHaveProperty('cache_control');
    expect(requested[1]!.body.messages).toContainEqual(
      expect.objectContaining({ role: 'tool', tool_call_id: 'task-call' }),
    );
    expect(eveUsage(run.runId)).toMatchObject({
      cost: 0.03,
      tokens: 2200,
      cached: 400,
      billing: { source: 'reported', chargedUsd: 0.03 },
    });
    expect(
      chats.get(run.agent.id, run.chat.id)!.items.filter((item) => item.type === 'meta' && item.billing),
    ).toHaveLength(1);
  });

  it('stops before another provider call when known spending reaches the limit', async () => {
    saveSettings({ costLimitUsdPerRun: 0.005 });
    replies = [completion(tool, { usd: 0.01 })];
    const run = go();
    expect(await run.promise).toBe('');
    expect(requested).toHaveLength(1);
    expect(readRun(run.runId)?.limitReason).toContain('$0.005');
    expect(eveUsage(run.runId).cost).toBe(0.01);
  });

  it('labels DIEM estimates and keeps unavailable costs separate from zero', async () => {
    replies = [completion(text, { usd: 0, diem: 0.05 })];
    const estimated = go();
    await estimated.promise;
    expect(eveUsage(estimated.runId)).toMatchObject({
      cost: 0.00102,
      billing: { source: 'estimated', chargedUsd: 0, chargedDiem: 0.05 },
    });
    expect(JSON.stringify(chats.get(estimated.agent.id, estimated.chat.id)!.items)).toContain('USD equivalent');
    info = { ...info, price: null };
    replies = [completion(text, { usd: 0, diem: 0.5 })];
    const unknown = go();
    await unknown.promise;
    expect(eveUsage(unknown.runId)).not.toHaveProperty('cost');
    expect(chats.get(unknown.agent.id, unknown.chat.id)!.items).toContainEqual(
      expect.objectContaining({
        type: 'meta',
        text: expect.stringContaining('Cost unavailable'),
        billing: { source: 'unavailable', chargedUsd: 0, chargedDiem: 0.5 },
      }),
    );
  });

  it('applies advertised tool, effort and image capabilities', async () => {
    const pictures = ['one.png', 'two.png'].map((name) => {
      const file = path.join(newBatch().dir, name);
      fs.writeFileSync(file, Buffer.from(PNG, 'base64'));
      return file;
    });
    info = { ...info, tools: false, vision: false, reasoningEfforts: [] };
    await go(pictures).promise;
    expect(requested[0]!.body).not.toHaveProperty('tools');
    expect(requested[0]!.body).not.toHaveProperty('reasoning_effort');
    expect(JSON.stringify(requested[0]!.body.messages)).toContain("can't see images");
    info = { ...info, vision: true };
    replies = [completion()];
    await go(pictures).promise;
    expect(JSON.stringify(requested[1]!.body.messages).match(/data:image\/png/g)).toHaveLength(1);
  });
});
