import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunInfo } from '../../server/engines/index.ts';
import { activeProject, agents, chats, workflows } from '../../server/store.ts';
import { HOME } from '../../server/util.ts';
import { privateAgentChat, privateTeamId } from '../../server/private-conversations.ts';
import { selectGatewayDocuments, verifyGatewayDocument } from '../../server/gateways/outgoing.ts';
import { newAgent } from '../../server/library.ts';
import { ensureBrain } from '../../server/projects.ts';
import { admitExecution, updateExecution } from '../../server/execution.ts';
import { callTool, riskOf, toolApprovalPlan } from '../../server/tools.ts';
import { saveGatewayInstance } from '../../server/gateways/instances.ts';
import { GatewayInbox } from '../../server/gateways/inbox.ts';
import { GatewayStateAdapter } from '../../server/gateways/state.ts';
import { gatewayConversation } from '../../server/gateways/conversations.ts';
import {
  prepareGatewayFiles,
  registerGatewayDeliverables,
  sendGatewayFiles,
} from '../../server/gateways/deliverables.ts';
import { gatewayConfig, gatewayInput } from './gateway-fixtures.ts';

const live = vi.hoisted(() => new Map<string, RunInfo>());
vi.mock('../../server/engines/index.ts', async (original) => ({
  ...(await original<typeof import('../../server/engines/index.ts')>()),
  runInfo: (id: string) => live.get(id) ?? null,
}));
let account = 80000;
const closes: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
  live.clear();
});
async function fixture(options: { brain?: boolean; custom?: boolean } = {}) {
  const workspace = options.custom ? path.join(HOME, `delegate-workspace-${account}`) : '';
  if (workspace) fs.mkdirSync(workspace, { recursive: true });
  const agent = newAgent({ name: 'Gateway deliverable agent', autonomy: 'auto', workspace });
  const instance = saveGatewayInstance({
    ...gatewayConfig(String(account++)),
    target: options.brain ? { kind: 'brain' } : { kind: 'agent', id: agent.id },
  });
  const state = new GatewayStateAdapter(instance.id);
  await state.connect();
  closes.push(() => state.disconnect());
  const inbox = new GatewayInbox(state);
  inbox.accept({ ...gatewayInput(), accountId: instance.accountId });
  const claimed = inbox.claimNext()!;
  const abort = new AbortController();
  const event = inbox.beginDispatch(claimed.id, claimed.operationId!, await gatewayConversation(claimed, abort.signal));
  const local = event.dispatch!.conversation;
  const chatId = local.kind === 'agent' ? local.chatId : privateAgentChat(event.bindingId, agent.id).id;
  const id = options.brain ? `${event.operationId}-delegate` : event.operationId!;
  const run: RunInfo = {
    id,
    agentId: agent.id,
    projectId: event.route.projectId,
    chatId,
    conversationId: event.bindingId,
    depth: 0,
    signal: abort.signal,
    agent,
    project: activeProject(),
  };
  live.set(id, run);
  admitExecution({
    id,
    projectId: run.projectId,
    agentId: agent.id,
    chatId,
    engine: agent.engine,
    ownerChatId: chatId,
    ownerAgentId: agent.id,
    parentRunId: null,
    depth: 0,
    text: 'Make a report',
    from: null,
    attachments: [],
    startedAt: Date.now(),
    status: 'running',
  });
  const release = registerGatewayDeliverables(instance.id, inbox, abort.signal);
  closes.push(release);
  const target = path.join(workspace || ensureBrain(), `deliverable-${account}.txt`);
  fs.writeFileSync(target, 'finished report');
  return {
    agent,
    instance,
    inbox,
    state,
    event,
    run,
    abort,
    release,
    target,
    args: async () => ({
      files: (await prepareGatewayFiles(id, agent.id, { paths: [target] })).map(({ path, sha256 }) => ({
        path,
        sha256,
      })),
    }),
  };
}

describe('explicit gateway deliverables', () => {
  it('rechecks current membership for files handed in from a private team session', async () => {
    const f = await fixture({ brain: true, custom: true });
    const team = workflows.save({ name: 'Delegate team', members: [f.agent.id], lead: f.agent.id, steps: [] });
    const teamId = privateTeamId(f.event.bindingId, team.id);
    const chat = chats.get(f.agent.id, f.run.chatId)!;
    chats.save({ ...chat, teamId });
    await sendGatewayFiles(f.run.id, f.agent.id, await f.args());
    const event = f.inbox.list()[0];
    const file = event.outgoing![0];
    expect((await verifyGatewayDocument(event, file, f.abort.signal)).toString()).toBe('finished report');
    workflows.save({ ...team, members: [], lead: '' });
    await expect(verifyGatewayDocument(event, file, f.abort.signal)).rejects.toThrow();
  });

  it('delivers a Brain delegate’s custom-workspace file after completion and restart using its native source receipt', async () => {
    const f = await fixture({ brain: true, custom: true });
    await expect(
      selectGatewayDocuments(f.inbox, f.event.id, { paths: [f.target] }, f.abort.signal),
    ).rejects.toMatchObject({ status: 400 });
    const args = await f.args();
    expect(args.files[0]).not.toHaveProperty('source');
    await sendGatewayFiles(f.run.id, f.agent.id, args);
    updateExecution(f.run.id, { status: 'completed', answer: 'Finished report' });
    f.inbox.finishDispatch(f.event.id, f.event.operationId!, 'Finished report');
    f.release();
    await f.state.disconnect();
    await f.state.connect();
    f.inbox.recover();
    const saved = f.inbox.list()[0];
    const file = saved.outgoing![0];
    expect(file.source).toMatchObject({ runId: f.run.id, agentId: f.agent.id, chatId: f.run.chatId });
    expect((await verifyGatewayDocument(saved, file, f.abort.signal)).toString()).toBe('finished report');
    agents.save({ ...f.agent, workspace: path.join(HOME, 'different-workspace') });
    await expect(verifyGatewayDocument(saved, file, f.abort.signal)).rejects.toThrow();
  });

  it('rejects source reuse across bindings and failed native execution evidence', async () => {
    const f = await fixture({ brain: true, custom: true });
    const args = await f.args();
    await expect(
      sendGatewayFiles(f.run.id, f.agent.id, { files: [{ ...args.files[0], source: { runId: 'forged' } }] }),
    ).rejects.toThrow();
    await sendGatewayFiles(f.run.id, f.agent.id, args);
    const file = f.inbox.list()[0].outgoing![0];
    await expect(
      verifyGatewayDocument(
        f.inbox.list()[0],
        { ...file, source: { ...file.source!, runId: 'missing-receipt' } },
        f.abort.signal,
      ),
    ).rejects.toThrow();
    f.inbox.accept({ ...gatewayInput('2', '456'), accountId: f.instance.accountId });
    const claimed = f.inbox.claimNext()!;
    const other = f.inbox.beginDispatch(
      claimed.id,
      claimed.operationId!,
      await gatewayConversation(claimed, f.abort.signal),
    );
    await expect(verifyGatewayDocument(other, file, f.abort.signal)).rejects.toThrow();
    updateExecution(f.run.id, { status: 'failed', error: 'Interrupted' });
    await expect(verifyGatewayDocument(f.inbox.list()[0], file, f.abort.signal)).rejects.toThrow();
  });

  it('inspects without selecting, then uses the normal high-risk approval gate and binds the original destination', async () => {
    const f = await fixture();
    const args = await f.args();
    expect(f.inbox.list()[0].outgoing).toBeUndefined();
    expect(riskOf('prepare_gateway_files')).toBe('none');
    expect(riskOf('send_gateway_files')).toBe('high');
    const plan = await toolApprovalPlan(f.agent, 'send_gateway_files', args, { runId: f.run.id });
    expect(plan.requests).toHaveLength(1);
    expect(plan.requests[0].data?.args).toEqual(args);
    const denied = await callTool(f.agent, 'send_gateway_files', args, {
      runId: f.run.id,
      approvalDecision: async () => ({ approved: false, message: 'No' }),
    });
    expect(denied.denied).toBe(true);
    expect(f.inbox.list()[0].outgoing).toBeUndefined();
    const allowed = await callTool(f.agent, 'send_gateway_files', args, {
      runId: f.run.id,
      approvalDecision: async () => ({ approved: true, message: '' }),
    });
    expect(allowed.isError).toBe(false);
    expect(allowed.text).toContain('Delivery waits');
    expect(f.inbox.list()[0].outgoing?.[0].sha256).toBe(args.files[0]!.sha256);
    await sendGatewayFiles(f.run.id, f.agent.id, args);
    expect(f.inbox.list()[0].outgoing).toHaveLength(1);
    await expect(sendGatewayFiles(f.run.id, f.agent.id, { ...args, recipient: 'someone else' })).rejects.toThrow();
  });

  it('refuses bytes changed while approval is pending', async () => {
    const f = await fixture();
    const args = await f.args();
    const result = await callTool(f.agent, 'send_gateway_files', args, {
      runId: f.run.id,
      approvalDecision: async () => {
        fs.writeFileSync(f.target, 'changed report');
        return { approved: true, message: '' };
      },
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('changed');
    expect(f.inbox.list()[0].outgoing).toBeUndefined();
  });

  it('refuses ordinary chats, other projects, impersonated agents and completed runs', async () => {
    const f = await fixture();
    const args = await f.args();
    await expect(sendGatewayFiles(f.run.id, 'another-agent', args)).rejects.toThrow();
    live.set(f.run.id, { ...f.run, conversationId: undefined });
    await expect(sendGatewayFiles(f.run.id, f.agent.id, args)).rejects.toThrow();
    live.set(f.run.id, { ...f.run, projectId: 'other-project' });
    await expect(sendGatewayFiles(f.run.id, f.agent.id, args)).rejects.toThrow();
    live.set(f.run.id, f.run);
    updateExecution(f.run.id, { status: 'completed', answer: 'done' });
    await expect(sendGatewayFiles(f.run.id, f.agent.id, args)).rejects.toThrow();
    expect(f.inbox.list()[0].outgoing).toBeUndefined();
  });

  it('revokes the destination on worker shutdown and rejects stale approval after a route change', async () => {
    const f = await fixture();
    const args = await f.args();
    f.release();
    await expect(sendGatewayFiles(f.run.id, f.agent.id, args)).rejects.toThrow();
    closes.push(registerGatewayDeliverables(f.instance.id, f.inbox, f.abort.signal));
    saveGatewayInstance({ ...gatewayConfig(f.instance.accountId), target: { kind: 'brain' } }, f.instance.id);
    await expect(sendGatewayFiles(f.run.id, f.agent.id, args)).rejects.toThrow();
    expect(f.inbox.list()[0].outgoing).toBeUndefined();
  });
});
