import { afterEach, describe, expect, it, vi } from 'vitest';
import { workflows, activeProject } from '../../server/store.ts';
import { newAgent } from '../../server/library.ts';
import { admitExecution, updateExecution } from '../../server/execution.ts';
import { addBrief, updateBrief } from '../../server/briefs.ts';
import { isTeamBusy } from '../../server/teams.ts';
import { GatewayStateAdapter } from '../../server/gateways/state.ts';
import { GatewayInbox } from '../../server/gateways/inbox.ts';
import { saveGatewayInstance } from '../../server/gateways/instances.ts';
import { gatewayConversation } from '../../server/gateways/conversations.ts';
import { gatewayExecution } from '../../server/gateways/execution.ts';
import { GatewayDispatcher } from '../../server/gateways/dispatch.ts';
import { gatewayConfig, gatewayInput } from './gateway-fixtures.ts';
import type { Agent, Approval, Chat, GatewayTarget } from '../../shared/types.ts';
import { history } from '../../server/overseer.ts';
import { getThread } from '../../server/teams.ts';

const calls = vi.hoisted(() => ({
  runs: [] as {
    text: string;
    options: { reservedRunId?: string; from?: string | null; attachments?: string[]; userInitiated?: boolean };
  }[],
  answer: 'Brain answer.',
  approvals: [] as Approval[],
  scopes: new Map<string, { projectId: string; conversationId?: string }>(),
}));
vi.mock('../../server/brainrun.ts', async (orig) => ({
  ...(await orig<typeof import('../../server/brainrun.ts')>()),
  runBrain: (await import('./brain-fake.ts')).thinkingBrain,
}));
vi.mock('../../server/brain.ts', async (original) => ({
  ...(await original<typeof import('../../server/brain.ts')>()),
  brainModel: () => ({ provider: 'openrouter', model: 'mock' }),
  think: async () => calls.answer,
}));
vi.mock('../../server/approvals.ts', async (original) => ({
  ...(await original<typeof import('../../server/approvals.ts')>()),
  listApprovals: () => calls.approvals,
}));
vi.mock('../../server/engines/index.ts', async (original) => ({
  ...(await original<typeof import('../../server/engines/index.ts')>()),
  runInfo: (id: string) => calls.scopes.get(id) ?? null,
  askAgent: async () => 'Member final answer.',
  startRun: (
    agent: Agent,
    chat: Chat,
    text: string,
    options: { reservedRunId?: string; from?: string | null; attachments?: string[]; userInitiated?: boolean },
  ) => {
    calls.runs.push({ text, options });
    const id = options.reservedRunId!;
    admitExecution({
      id,
      projectId: activeProject().id,
      agentId: agent.id,
      chatId: chat.id,
      engine: agent.engine,
      ownerChatId: chat.id,
      ownerAgentId: agent.id,
      parentRunId: null,
      depth: 0,
      text,
      from: options.from || null,
      attachments: options.attachments || [],
      startedAt: Date.now(),
      status: 'running',
    });
    return { runId: id, promise: Promise.resolve('not a completion receipt'), signal: new AbortController().signal };
  },
}));
let account = 65000;
const opened: GatewayStateAdapter[] = [];
afterEach(async () => {
  for (const state of opened.splice(0)) await state.disconnect();
  calls.answer = 'Brain answer.';
  calls.approvals = [];
  calls.scopes.clear();
});
async function fixture(target: GatewayTarget) {
  const instance = saveGatewayInstance({ ...gatewayConfig(String(account++)), target });
  const state = new GatewayStateAdapter(instance.id);
  opened.push(state);
  await state.connect();
  const inbox = new GatewayInbox(state);
  inbox.accept({ ...gatewayInput(), accountId: instance.accountId });
  const claimed = inbox.claimNext()!;
  const event = inbox.beginDispatch(
    claimed.id,
    claimed.operationId!,
    await gatewayConversation(claimed, new AbortController().signal),
  );
  return {
    inbox,
    event,
    record: async () => {
      const result = await gatewayExecution.submit(event, new AbortController().signal, () => true);
      inbox.recordDispatch(event.id, event.operationId!, result);
      return inbox.list()[0];
    },
  };
}

describe('gateway conversation execution services', () => {
  it.each(['brain', 'agent', 'team'] as const)(
    'passes combined album text and files to the %s entry point',
    async (kind) => {
      const agent = newAgent({ name: `Album ${kind} target` });
      const team = workflows.save({ name: `Album ${kind} team`, members: [agent.id], lead: agent.id, steps: [] });
      const f = await fixture(kind === 'brain' ? { kind } : { kind, id: kind === 'agent' ? agent.id : team.id });
      const event = { ...f.event, input: { ...f.event.input, mediaGroupId: 'album' } };
      await expect(gatewayExecution.submit(event, new AbortController().signal, () => true)).rejects.toThrow(
        'complete album',
      );
      const input = {
        text: 'Message 1\nFirst caption\n\nMessage 2\nSecond caption',
        attachments: ['/saved/first.txt', '/saved/second.txt'],
      };
      await gatewayExecution.submit(event, new AbortController().signal, () => true, input);
      const local = event.dispatch!.conversation;
      if (local.kind === 'agent')
        expect(calls.runs.at(-1)).toMatchObject({ text: input.text, options: { attachments: input.attachments } });
      else if (local.kind === 'team') {
        await expect.poll(() => isTeamBusy(local.teamId)).toBe(false);
        expect(getThread(local.teamId).messages.find((item) => item.id === event.operationId)).toMatchObject({
          text: input.text,
          attachments: input.attachments,
        });
      } else
        expect(history(event.route.projectId, event.bindingId).find((item) => item.role === 'user')).toMatchObject({
          text: input.text,
          attachments: input.attachments,
        });
    },
  );

  it('matches approvals to a live run in this binding and project without exposing their contents', async () => {
    const f = await fixture({ kind: 'brain' });
    const event = f.event;
    const approval: Approval = {
      id: 'approval-test',
      title: 'Private title',
      detail: 'Private detail',
      kind: 'tool',
      agentId: 'member',
      agentName: 'Member',
      data: { runId: 'delegate-run', args: { token: 'private-token' } },
      editable: null,
      createdAt: event.dispatch!.startedAt,
    };
    calls.approvals = [approval];
    expect(gatewayExecution.approvalPending!(event)).toBe(false);
    calls.scopes.set('delegate-run', { projectId: event.route.projectId, conversationId: 'other-binding' });
    expect(gatewayExecution.approvalPending!(event)).toBe(false);
    calls.scopes.set('delegate-run', { projectId: 'other-project', conversationId: event.bindingId });
    expect(gatewayExecution.approvalPending!(event)).toBe(false);
    calls.scopes.set('delegate-run', { projectId: event.route.projectId, conversationId: event.bindingId });
    expect(gatewayExecution.approvalPending!(event)).toBe(true);
    approval.createdAt--;
    expect(gatewayExecution.approvalPending!(event)).toBe(false);
    approval.createdAt++;
    approval.data = {};
    expect(gatewayExecution.approvalPending!(event)).toBe(false);
  });

  it('uses the real agent entry point with a reserved ID and sender, and waits for descendants and completion review', async () => {
    const agent = newAgent({ name: 'Execution target' });
    const f = await fixture({ kind: 'agent', id: agent.id });
    const event = await f.record();
    const local = event.dispatch!.conversation;
    if (local.kind !== 'agent') throw new Error('Wrong conversation');
    expect(calls.runs.at(-1)?.options).toMatchObject({
      reservedRunId: event.operationId,
      from: 'telegram: Alice (123)',
      userInitiated: true,
    });
    expect(gatewayExecution.poll(event)).toEqual({ state: 'pending' });
    updateExecution(event.operationId!, { status: 'completed', answer: 'Parent answer' });
    const parent = {
      id: event.operationId!,
      projectId: activeProject().id,
      agentId: agent.id,
      chatId: local.chatId,
      engine: agent.engine,
      ownerChatId: local.chatId,
      ownerAgentId: agent.id,
      parentRunId: null,
      depth: 0,
      text: '',
      from: null,
      attachments: [],
      startedAt: Date.now(),
      status: 'running' as const,
    };
    admitExecution({
      ...parent,
      id: `${event.operationId}-child`,
      chatId: 'child-chat',
      parentRunId: event.operationId!,
      depth: 1,
    });
    expect(gatewayExecution.poll(event).state).toBe('pending');
    updateExecution(`${event.operationId}-child`, { status: 'completed', answer: 'Child result' });
    expect(gatewayExecution.poll(event).state).toBe('needs-review');
    const brief = addBrief({
      kind: 'agent',
      targetId: agent.id,
      name: agent.name,
      chatId: local.chatId,
      messageId: event.operationId,
      text: 'Assignment',
      ts: Date.now(),
    });
    expect(gatewayExecution.poll(event).state).toBe('pending');
    updateBrief(brief.id, { status: 'done', summary: 'Chosen outward answer' });
    expect(gatewayExecution.poll(event)).toEqual({ state: 'completed', answer: 'Chosen outward answer' });
  });

  it('does not treat the first team reply as completion while the assignment review is still open', async () => {
    const agent = newAgent({ name: 'Team execution member' });
    const team = workflows.save({ name: 'Team execution target', members: [agent.id], lead: agent.id, steps: [] });
    const f = await fixture({ kind: 'team', id: team.id });
    const local = f.event.dispatch!.conversation;
    if (local.kind !== 'team') throw new Error('Wrong conversation');
    const brief = addBrief({
      kind: 'team',
      targetId: local.teamId,
      name: team.name,
      messageId: f.event.operationId,
      text: 'Assignment',
      ts: Date.now(),
    });
    const event = await f.record();
    await expect.poll(() => isTeamBusy(local.teamId)).toBe(false);
    expect(gatewayExecution.poll(event).state).toBe('pending');
    updateBrief(brief.id, { status: 'done', summary: 'Team chosen outward answer' });
    expect(gatewayExecution.poll(event)).toEqual({ state: 'completed', answer: 'Team chosen outward answer' });
    updateBrief(brief.id, { revision: 1 });
    expect(gatewayExecution.poll(event).state).toBe('needs-review');
  });

  it('requires a completion summary for the exact team message when reconciling held work', async () => {
    const agent = newAgent({ name: 'Reconciliation member' });
    const team = workflows.save({ name: 'Reconciliation team', members: [agent.id], lead: agent.id, steps: [] });
    const f = await fixture({ kind: 'team', id: team.id });
    const event = await f.record();
    const local = event.dispatch!.conversation;
    if (local.kind !== 'team') throw new Error('Wrong conversation');
    await expect.poll(() => isTeamBusy(local.teamId)).toBe(false);
    expect(gatewayExecution.reconcile!(event).state).toBe('needs-review');
    const brief = addBrief({
      kind: 'team',
      targetId: local.teamId,
      name: team.name,
      messageId: event.operationId,
      text: 'Original assignment',
      ts: Date.now(),
    });
    updateBrief(brief.id, { status: 'done', summary: '' });
    expect(gatewayExecution.reconcile!(event).state).toBe('needs-review');
    updateBrief(brief.id, { summary: 'Original verified team answer' });
    expect(gatewayExecution.reconcile!(event)).toEqual({ state: 'completed', answer: 'Original verified team answer' });
    updateBrief(brief.id, { revision: 1 });
    expect(gatewayExecution.reconcile!(event).state).toBe('needs-review');
  });

  it('recovers a Brain answer from its operation marker and refuses an unproven request instead of submitting again', async () => {
    const f = await fixture({ kind: 'brain' });
    const event = await f.record();
    expect(gatewayExecution.poll(event)).toEqual({ state: 'completed', answer: 'Brain answer.' });
    expect(
      gatewayExecution.poll({ ...event, dispatch: { ...event.dispatch!, state: 'starting', brain: undefined } }),
    ).toEqual({ state: 'completed', answer: 'Brain answer.' });
    expect(
      gatewayExecution.poll({
        ...event,
        operationId: 'unknown-operation',
        dispatch: { ...event.dispatch!, brain: undefined },
      }).state,
    ).toBe('needs-review');
    f.inbox.review(event.id);
    const dispatcher = new GatewayDispatcher(f.inbox, new AbortController().signal);
    expect(dispatcher.reconcile(event.id).state).toBe('completed');
    expect(f.inbox.list()[0].reply?.parts[0].text).toBe('Brain answer.');
    expect(() => dispatcher.reconcile(event.id)).toThrow('held operation');
  });
});
