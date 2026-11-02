import http from 'node:http';
import { once } from 'node:events';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { agents, chats, saveSettings } from '../../server/store.ts';
import { newAgent } from '../../server/library.ts';
import { startRun, stopAllRuns } from '../../server/engines/index.ts';
import { eveCoordinator } from '../../server/eve/coordinator.ts';
import { eveRuntime } from '../../server/eve/runtime.ts';
import { readRun } from '../../server/eve/state.ts';
import { readConversation, searchConversations } from '../../server/conversations.ts';
import * as mcp from '../../server/mcp.ts';
import { openuiPrompt } from '../../server/richanswers.ts';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=';
const answer = 'root = Card([t])\nt = TextContent("Native rich answer")';
let server: http.Server | undefined;
afterAll(async () => {
  await stopAllRuns();
  await eveCoordinator.close();
  await eveRuntime.close();
  server?.closeAllConnections();
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  vi.restoreAllMocks();
});

describe('native Eve context and media', () => {
  it('carries tool vision and rich answers, then compacts while preserving searchable originals', async () => {
    let summaries = 0;
    let vision = 0;
    let rich = 0;
    const failures: string[] = [];
    server = http.createServer(async (request, response) => {
      if (request.url?.endsWith('/models')) return response.end(JSON.stringify({ data: [{ id: 'native-context', context_length: 64000 }] }));
      let raw = '';
      for await (const part of request) raw += String(part);
      const body = JSON.parse(raw) as { stream?: boolean; messages: { role: string; content: unknown }[] };
      const serialized = JSON.stringify(body.messages);
      if (serialized.includes('characters from the middle of this message were cut')) failures.push('Current request was shortened');
      if (serialized.includes('How to write your answers (Rich answers)')) rich++;
      if (serialized.includes('CONTEXT CHECKPOINT COMPACTION')) {
        summaries++;
        const summary = 'The first vision check is complete. Continue with the full current request.';
        if (body.stream) response.writeHead(200, { 'content-type': 'text/event-stream' }).end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: summary }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20 } })}\n\ndata: [DONE]\n\n`);
        else response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'summary', model: 'native-context', created: 1, choices: [{ index: 0, message: { role: 'assistant', content: summary }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20 } }));
        return;
      }
      const next = serialized.includes('FORCE_NEXT_CONTEXT');
      const toolResult = body.messages.some((message) => message.role === 'tool');
      if (toolResult && !next) {
        if (!serialized.includes(`data:image/png;base64,${PNG}`)) failures.push('Tool image was not supplied as vision');
        else vision++;
      }
      const delta = next || toolResult ? { content: answer } : { tool_calls: [{ index: 0, id: 'vision-call', type: 'function', function: { name: 'vision__screenshot', arguments: '{}' } }] };
      response.writeHead(200, { 'content-type': 'text/event-stream' }).end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: next || toolResult ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: toolResult && !next ? 60000 : 100, completion_tokens: 30 } })}\n\ndata: [DONE]\n\n`);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port.');
    saveSettings({ providers: { custom: { baseUrl: `http://127.0.0.1:${address.port}/v1`, label: 'Native proof' } }, contextWindowTokens: 64000, brainFollowsUp: false });
    mcp.saveServer('vision', { type: 'http', url: 'http://127.0.0.1:1/mcp', enabled: true });
    vi.spyOn(mcp, 'listTools').mockResolvedValue([{ name: 'screenshot', description: 'Read a fixture screenshot', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true, destructiveHint: false } }]);
    const tool = vi.spyOn(mcp, 'callTool').mockResolvedValue({ text: 'Original screenshot result', images: [`data:image/png;base64,${PNG}`] });
    const agent = agents.save(newAgent({ engine: 'eve', name: 'Native context', provider: 'custom', model: 'native-context', richAnswers: true, toolGroups: [], mcpServers: ['vision'], autonomy: 'full' }));
    expect(await openuiPrompt()).toBeTruthy();
    const chat = chats.create(agent.id);
    const original = `ORIGINAL_ONLY_NEEDLE ${'retained original words '.repeat(3000)}`;
    chat.items.push({ type: 'user', text: original }, { type: 'assistant', text: 'Ready for the vision check.' });
    chats.save(chat);
    expect(await startRun(agent, chat, 'Read the screenshot using the vision tool.').promise).toBe(answer);
    expect(vision).toBe(1);
    expect(tool).toHaveBeenCalledTimes(1);
    const next = startRun(agent, chats.get(agent.id, chat.id)!, 'FORCE_NEXT_CONTEXT: retain this complete new request.');
    const nextAnswer = await next.promise;
    expect(readRun(next.runId)?.error).toBeUndefined();
    expect(nextAnswer).toBe(answer);
    expect(summaries).toBeGreaterThan(0);
    expect(rich).toBeGreaterThan(0);
    expect(failures).toEqual([]);
    const saved = chats.get(agent.id, chat.id)!;
    expect(saved.items.some((item) => item.type === 'compaction')).toBe(true);
    expect(saved.items.find((item) => item.type === 'tool')).toMatchObject({ result: 'Original screenshot result', images: [expect.stringContaining('/api/file?path=')] });
    expect(saved.rich).toBe(true);
    const hit = searchConversations(agent.id, { query: 'ORIGINAL_ONLY_NEEDLE', scope: 'own' }).hits[0];
    expect(hit).toBeTruthy();
    let text = '';
    let offset: number | null = 0;
    while (offset !== null) {
      const page = readConversation(agent.id, { source: 'own', conversationId: hit.conversationId, messageId: hit.messageId, offset });
      text += page.text;
      offset = page.nextOffset;
    }
    expect(text).toBe(original);
  }, 45000);
});
