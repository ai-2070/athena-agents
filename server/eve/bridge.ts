import crypto from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import { z } from 'zod';
import { gatherTools } from '../apitools.ts';
import { providerOf } from '../providers.ts';
import { contextWindow } from '../compaction.ts';
import { getSettings, withProject } from '../store.ts';
import { callTool, gate } from '../tools.ts';
import * as mcp from '../mcp.ts';
import { activeEveRuns, attachSession, recordConfiguration, sessionContext } from './state.ts';
import type { EveRuntimeConfiguration } from '../../shared/types.ts';

const schema = z.record(z.string(), z.json());

function invocationContext(bindingId: string, sessionId: string) {
  const context = sessionContext(bindingId);
  const run = activeEveRuns().find((item) => item.bindingId === bindingId && (item.status === 'running' || item.status === 'waiting'));
  if (!run) throw new Error('This Eve conversation has no active run.');
  if (!context.binding.sessionId) attachSession(bindingId, sessionId);
  else if (context.binding.sessionId !== sessionId) throw new Error('The Eve session does not own this binding.');
  return { ...context, run };
}

export async function eveConfiguration(bindingId: string, sessionId: string): Promise<EveRuntimeConfiguration> {
  const { project, agent, chat, run } = invocationContext(bindingId, sessionId);
  return withProject(project, async () => {
    const [{ buildSystemPrompt }, { richSection }] = await Promise.all([import('../engines/index.ts'), import('../richanswers.ts')]);
    const provider = providerOf(agent);
    const { defs } = await gatherTools(agent, () => {});
    const headers = { ...provider.headers };
    delete headers.authorization;
    delete headers['content-type'];
    const configuration: EveRuntimeConfiguration = {
      model: agent.model || getSettings().defaults.openrouterModel,
      baseUrl: provider.base,
      apiKey: provider.headers.authorization?.replace(/^Bearer /, '') || '', headers,
      instructions: buildSystemPrompt(agent) + await richSection(agent, chat, run.depth),
      contextWindow: await contextWindow(agent, chat),
      tools: defs.map((tool) => ({ name: tool.function.name, description: tool.function.description || '', inputSchema: schema.parse(tool.function.parameters) })),
    };
    const { apiKey: _key, headers: _headers, ...definition } = configuration;
    recordConfiguration(run.id, definition);
    return configuration;
  });
}

export async function eveTool(bindingId: string, sessionId: string, name: string, args: Record<string, unknown>, signal?: AbortSignal) {
  const { project, agent, run } = invocationContext(bindingId, sessionId);
  return withProject(project, async () => {
    const { route } = await gatherTools(agent, () => {});
    const target = route.get(name);
    if (!target) throw new Error('This tool is no longer available to the agent.');
    const fresh = invocationContext(bindingId, sessionId);
    const context = { runId: run.id, depth: run.depth, signal };
    if (target.kind === 'builtin') return callTool(fresh.agent, target.name, args, context);
    if (!fresh.agent.mcpServers.includes(target.server) || !mcp.isEnabled(target.server)) throw new Error('This MCP account is no longer available to the agent.');
    const refused = await gate(fresh.agent, name, target.risk, args, { ...context, mcpServer: target.server });
    return refused || mcp.callTool(target.server, target.name, args, { signal });
  });
}

const requestSchema = z.object({ binding: z.string().min(1), input: z.object({ sessionId: z.string().min(1), callId: z.string().optional(), name: z.string().optional(), args: z.record(z.string(), z.unknown()).optional() }) });

/** A separate authenticated listener; dashboard request guards are never bypassed. */
export async function openEveBridge() {
  const token = crypto.randomBytes(32).toString('hex');
  const server = http.createServer(async (request, response) => {
    const supplied = request.headers.authorization;
    const expected = Buffer.from(`Bearer ${token}`);
    const actual = Buffer.from(supplied || '');
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
      response.writeHead(401).end();
      return;
    }
    const controller = new AbortController();
    response.on('close', () => { if (!response.writableEnded) controller.abort(); });
    if (request.method !== 'POST' || !['/configuration', '/tool'].includes(request.url || '')) {
      response.writeHead(404).end();
      return;
    }
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > 1024 * 1024) throw new Error('The Eve bridge request is too large.');
        chunks.push(bytes);
      }
      const body = requestSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      const value = request.url === '/configuration' ? await eveConfiguration(body.binding, body.input.sessionId)
        : await eveTool(body.binding, body.input.sessionId, body.input.name || '', body.input.args || {}, controller.signal);
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value));
    } catch {
      // A provider failure may contain credentials; only a fixed message leaves the bridge.
      response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'The Eve bridge request could not be completed.' }));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not start the private Eve tool bridge.');
  return { url: `http://127.0.0.1:${address.port}`, token, close: async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } };
}
