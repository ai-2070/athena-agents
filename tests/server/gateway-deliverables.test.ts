import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunInfo } from '../../server/engines/index.ts';
import { activeProject } from '../../server/store.ts';
import { newAgent } from '../../server/library.ts';
import { ensureBrain } from '../../server/projects.ts';
import { admitExecution, updateExecution } from '../../server/execution.ts';
import { callTool, riskOf, toolApprovalPlan } from '../../server/tools.ts';
import { saveGatewayInstance } from '../../server/gateways/instances.ts';
import { GatewayInbox } from '../../server/gateways/inbox.ts';
import { GatewayStateAdapter } from '../../server/gateways/state.ts';
import { gatewayConversation } from '../../server/gateways/conversations.ts';
import { prepareGatewayFiles, registerGatewayDeliverables, sendGatewayFiles } from '../../server/gateways/deliverables.ts';
import { gatewayConfig, gatewayInput } from './gateway-fixtures.ts';

const live = vi.hoisted(() => new Map<string, RunInfo>());
vi.mock('../../server/engines/index.ts', async (original) => ({ ...await original<typeof import('../../server/engines/index.ts')>(), runInfo: (id: string) => live.get(id) ?? null }));
let account = 80000;
const closes: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); live.clear(); });
async function fixture() {
  const agent = newAgent({ name: 'Gateway deliverable agent', autonomy: 'auto' });
  const instance = saveGatewayInstance({ ...gatewayConfig(String(account++)), target: { kind: 'agent', id: agent.id } });
  const state = new GatewayStateAdapter(instance.id); await state.connect(); closes.push(() => state.disconnect());
  const inbox = new GatewayInbox(state); inbox.accept({ ...gatewayInput(), accountId: instance.accountId });
  const claimed = inbox.claimNext()!; const abort = new AbortController();
  const event = inbox.beginDispatch(claimed.id, claimed.operationId!, await gatewayConversation(claimed, abort.signal));
  if (event.dispatch!.conversation.kind !== 'agent') throw new Error('Wrong conversation');
  const chatId = event.dispatch!.conversation.chatId; const id = event.operationId!;
  const run: RunInfo = { id, agentId: agent.id, projectId: event.route.projectId, chatId, conversationId: event.bindingId, depth: 0, signal: abort.signal, agent, project: activeProject() };
  live.set(id, run);
  admitExecution({ id, projectId: run.projectId, agentId: agent.id, chatId, engine: agent.engine, ownerChatId: chatId, ownerAgentId: agent.id, parentRunId: null, depth: 0, text: 'Make a report', from: null, attachments: [], startedAt: Date.now(), status: 'running' });
  const release = registerGatewayDeliverables(instance.id, inbox, abort.signal); closes.push(release);
  const target = path.join(ensureBrain(), `deliverable-${account}.txt`); fs.writeFileSync(target, 'finished report');
  return { agent, instance, inbox, state, event, run, abort, release, target, args: async () => ({ files: (await prepareGatewayFiles(id, agent.id, { paths: [target] })).map(({ path, sha256 }) => ({ path, sha256 })) }) };
}

describe('explicit gateway deliverables', () => {
  it('inspects without selecting, then uses the normal high-risk approval gate and binds the original destination', async () => {
    const f = await fixture(); const args = await f.args();
    expect(f.inbox.list()[0].outgoing).toBeUndefined();
    expect(riskOf('prepare_gateway_files')).toBe('none'); expect(riskOf('send_gateway_files')).toBe('high');
    const plan = await toolApprovalPlan(f.agent, 'send_gateway_files', args, { runId: f.run.id });
    expect(plan.requests).toHaveLength(1); expect(plan.requests[0].data?.args).toEqual(args);
    const denied = await callTool(f.agent, 'send_gateway_files', args, { runId: f.run.id, approvalDecision: async () => ({ approved: false, message: 'No' }) });
    expect(denied.denied).toBe(true); expect(f.inbox.list()[0].outgoing).toBeUndefined();
    const allowed = await callTool(f.agent, 'send_gateway_files', args, { runId: f.run.id, approvalDecision: async () => ({ approved: true, message: '' }) });
    expect(allowed.isError).toBe(false); expect(allowed.text).toContain('Delivery waits');
    expect(f.inbox.list()[0].outgoing?.[0].sha256).toBe(args.files[0]!.sha256);
    await sendGatewayFiles(f.run.id, f.agent.id, args); expect(f.inbox.list()[0].outgoing).toHaveLength(1);
    await expect(sendGatewayFiles(f.run.id, f.agent.id, { ...args, recipient: 'someone else' })).rejects.toThrow();
  });

  it('refuses bytes changed while approval is pending', async () => {
    const f = await fixture(); const args = await f.args();
    const result = await callTool(f.agent, 'send_gateway_files', args, { runId: f.run.id, approvalDecision: async () => { fs.writeFileSync(f.target, 'changed report'); return { approved: true, message: '' }; } });
    expect(result.isError).toBe(true); expect(result.text).toContain('changed'); expect(f.inbox.list()[0].outgoing).toBeUndefined();
  });

  it('refuses ordinary chats, other projects, impersonated agents and completed runs', async () => {
    const f = await fixture(); const args = await f.args();
    await expect(sendGatewayFiles(f.run.id, 'another-agent', args)).rejects.toThrow();
    live.set(f.run.id, { ...f.run, conversationId: undefined });
    await expect(sendGatewayFiles(f.run.id, f.agent.id, args)).rejects.toThrow();
    live.set(f.run.id, { ...f.run, projectId: 'other-project' });
    await expect(sendGatewayFiles(f.run.id, f.agent.id, args)).rejects.toThrow();
    live.set(f.run.id, f.run); updateExecution(f.run.id, { status: 'completed', answer: 'done' });
    await expect(sendGatewayFiles(f.run.id, f.agent.id, args)).rejects.toThrow();
    expect(f.inbox.list()[0].outgoing).toBeUndefined();
  });

  it('revokes the destination on worker shutdown and rejects stale approval after a route change', async () => {
    const f = await fixture(); const args = await f.args(); f.release();
    await expect(sendGatewayFiles(f.run.id, f.agent.id, args)).rejects.toThrow();
    closes.push(registerGatewayDeliverables(f.instance.id, f.inbox, f.abort.signal));
    saveGatewayInstance({ ...gatewayConfig(f.instance.accountId), target: { kind: 'brain' } }, f.instance.id);
    await expect(sendGatewayFiles(f.run.id, f.agent.id, args)).rejects.toThrow();
    expect(f.inbox.list()[0].outgoing).toBeUndefined();
  });
});
