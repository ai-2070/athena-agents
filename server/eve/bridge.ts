import crypto from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import { z } from 'zod';
import { gatherTools } from '../apitools.ts';
import { providerOf } from '../providers.ts';
import { contextWindow } from '../compaction.ts';
import { getSettings, questions, withProject } from '../store.ts';
import { addQuestion, answerResult } from '../questions.ts';
import { callTool, gate, needsApproval, riskOf, toolApprovalName, toolApprovalRequest } from '../tools.ts';
import { durableApproval, ensureDurableApproval } from '../approvals.ts';
import * as mcp from '../mcp.ts';
import { activeEveRuns, attachSession, readRun, recordConfiguration, sessionContext, setRunStatus } from './state.ts';
import { executeOperation, operationId, prepareOperation, readOperation, saveOperation } from './operations.ts';
import { canonical } from '../../shared/canonical.ts';
import type { EveRuntimeConfiguration } from '../../shared/types.ts';

const schema = z.record(z.string(), z.json());

function invocationContext(bindingId: string, sessionId: string, runId?: string) {
  const context = sessionContext(bindingId);
  const run = activeEveRuns().find((item) => item.bindingId === bindingId && (item.status === 'running' || item.status === 'waiting'));
  if (!run) throw new Error('This Eve conversation has no active run.');
  if (runId && run.id !== runId) throw new Error('This Eve call does not belong to the active run.');
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
      runId: run.id,
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

export async function eveToolPolicy(bindingId: string, sessionId: string, runId: string, callId: string, name: string, args: Record<string, unknown>): Promise<{ status: 'approved' | 'user-approval' | 'denied'; reason?: string }> {
  const { project, agent, run } = invocationContext(bindingId, sessionId, runId);
  return withProject(project, async () => {
    const saved = readOperation(operationId(bindingId, sessionId, runId, callId));
    if (saved && (saved.name !== name || canonical(saved.args) !== canonical(args) || saved.runId !== run.id)) throw new Error('The tool call changed its saved operation.');
    if (saved?.status === 'completed') return { status: 'approved' };
    if (saved?.status === 'cancelled' || saved?.status === 'uncertain') return { status: 'denied', reason: 'This operation cannot be repeated. Check its outcome in Athena.' };
    const { route } = await gatherTools(agent, () => {});
    const target = route.get(name);
    if (!target) throw new Error('This tool is no longer available to the agent.');
    const fresh = invocationContext(bindingId, sessionId, runId);
    if (target.kind === 'mcp' && (!fresh.agent.mcpServers.includes(target.server) || !mcp.isEnabled(target.server))) throw new Error('This MCP account is no longer available to the agent.');
    const risk = target.kind === 'builtin' ? riskOf(target.name, args) : target.risk;
    const origin = target.kind === 'builtin' ? `builtin:${target.name}` : `mcp:${target.server}:${target.name}`;
    const operation = prepareOperation({ runId: run.id, bindingId, sessionId, callId, name, args, origin, risk });
    if (operation.status === 'running') return { status: 'approved' };
    if (target.kind === 'builtin' && target.name === 'ask_user') {
      const question = addQuestion({ question: String(args.question || ''), detail: typeof args.detail === 'string' ? args.detail : undefined, choices: args.choices, agentId: agent.id, chatId: fresh.binding.chatId, runId: run.id, operationId: operation.id });
      saveOperation({ ...operation, questionId: question.id, status: question.status === 'waiting' ? 'waiting' : 'prepared' });
      if (question.status === 'waiting') setRunStatus(run.id, 'waiting');
      return { status: question.status === 'waiting' ? 'user-approval' : 'approved' };
    }
    const approvalName = target.kind === 'builtin' ? toolApprovalName(target.name, args) : name;
    if (needsApproval(fresh.agent, risk, approvalName) || operation.approvalId) {
      const request = toolApprovalRequest(fresh.agent, approvalName, args, { runId: run.id, operationId: operation.id, ...(target.kind === 'mcp' ? { mcpServer: target.server } : {}) });
      const approval = ensureDurableApproval(operation.id, request);
      saveOperation({ ...operation, approvalId: approval.id, status: approval.decision ? approval.decision.approved ? 'prepared' : 'cancelled' : 'waiting' });
      if (!approval.decision) {
        setRunStatus(run.id, 'waiting');
        return { status: 'user-approval' };
      }
      return approval.decision.approved ? { status: 'approved' } : { status: 'denied', reason: approval.decision.message || 'The user denied this tool call.' };
    }
    return { status: 'approved' };
  });
}

export async function eveTool(bindingId: string, sessionId: string, runId: string, callId: string, name: string, args: Record<string, unknown>, signal?: AbortSignal) {
  const policy = await eveToolPolicy(bindingId, sessionId, runId, callId, name, args);
  if (policy.status !== 'approved') return { text: policy.reason || 'This tool is waiting for approval in Athena.', isError: true, denied: true };
  const { project, agent, run } = invocationContext(bindingId, sessionId, runId);
  const id = operationId(bindingId, sessionId, runId, callId);
  return withProject(project, async () => {
    const result = await executeOperation(id, async () => {
      const { route } = await gatherTools(agent, () => {});
      const target = route.get(name);
      if (!target) return { text: 'This tool is no longer available.', isError: true, denied: true };
      const fresh = invocationContext(bindingId, sessionId, runId);
      const operation = readOperation(id)!;
      if (operation.questionId) {
        const question = questions.get(operation.questionId);
        return question?.status === 'answered'
          ? { text: answerResult({ choice: question.choice || '', text: question.reply || '' }) }
          : { text: 'The question was closed without an answer. Ask what the user wants next.', isError: true, denied: true };
      }
      const edited = durableApproval(id)?.decision?.edited;
      const effective = edited !== null && typeof edited === 'object' && !Array.isArray(edited) ? edited as Record<string, unknown> : args;
      const context = { runId: run.id, depth: run.depth, signal, operationId: id, approvalArgs: args };
      if (target.kind === 'builtin') return callTool(fresh.agent, target.name, effective, context);
      if (!fresh.agent.mcpServers.includes(target.server) || !mcp.isEnabled(target.server)) return { text: 'This MCP account is no longer available.', isError: true, denied: true };
      const refused = await gate(fresh.agent, name, target.risk, effective, { ...context, mcpServer: target.server });
      if (signal?.aborted) return { text: 'Stopped.', isError: true, denied: true };
      return refused || mcp.callTool(target.server, target.name, effective, { signal });
    });
    const operation = readOperation(id);
    if (operation?.status === 'uncertain') {
      if (['running', 'waiting'].includes(readRun(run.id)?.status || '')) setRunStatus(run.id, 'interrupted');
      ensureDurableApproval(`reconcile:${id}`, { kind: 'workflow', title: `Check the outcome of ${name}`, detail: 'This tool may already have made changes. Check its outcome before starting more work. Allow to mark this check done; this run stays interrupted and the tool will not be repeated.', agentId: agent.id, agentName: agent.name, data: { tool: name, args, runId: run.id, outcomeCheck: true } });
    }
    return result;
  });
}

const requestSchema = z.object({ binding: z.string().min(1), input: z.object({ sessionId: z.string().min(1), runId: z.string().min(1).optional(), callId: z.string().optional(), name: z.string().optional(), args: z.record(z.string(), z.unknown()).optional() }) });

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
    if (request.method !== 'POST' || !['/configuration', '/policy', '/tool'].includes(request.url || '')) {
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
      if (request.url !== '/configuration' && !(body.input.callId && body.input.runId)) throw new Error('An Eve run and tool call ID are required.');
      const value = request.url === '/configuration' ? await eveConfiguration(body.binding, body.input.sessionId)
        : request.url === '/policy' ? await eveToolPolicy(body.binding, body.input.sessionId, body.input.runId!, body.input.callId!, body.input.name || '', body.input.args || {})
          : await eveTool(body.binding, body.input.sessionId, body.input.runId!, body.input.callId!, body.input.name || '', body.input.args || {}, controller.signal);
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
