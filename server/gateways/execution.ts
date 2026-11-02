import { agents, chats } from '../store.ts';
import { startRun, hasBackgroundWork, isChatBusy, runInfo } from '../engines/index.ts';
import { listApprovals } from '../approvals.ts';
import { readExecution } from '../execution.ts';
import { ask, history } from '../overseer.ts';
import { getTeam, getThread, isTeamBusy, postUserMessage, teamState } from '../teams.ts';
import { pickMember } from '../brain.ts';
import { listBriefs } from '../briefs.ts';
import type { BrainBrief, GatewayDispatch, GatewayInboxEvent } from '../../shared/types.ts';
import { privateTeamRecord } from '../private-conversations.ts';
import { withGatewayRoute } from './instances.ts';

export type GatewaySubmitted = Pick<GatewayDispatch, 'runId' | 'messageId' | 'briefId' | 'briefRevision' | 'brain'>;
export type GatewayCompletion = { state: 'pending' } | { state: 'needs-review' } | { state: 'completed'; answer: string };
export interface GatewayExecutionServices {
  submit(event: GatewayInboxEvent, signal: AbortSignal, proceed: () => boolean): Promise<GatewaySubmitted>;
  poll(event: GatewayInboxEvent): GatewayCompletion;
  approvalPending?(event: GatewayInboxEvent): boolean;
}
const pending: GatewayCompletion = { state: 'pending' };
const review: GatewayCompletion = { state: 'needs-review' };
function briefFor(messageId: string, targetId: string, chatId?: string): BrainBrief | undefined {
  return listBriefs().findLast((brief) => brief.targetId === targetId && brief.messageId === messageId && (!chatId || brief.chatId === chatId));
}
function briefReference(brief?: BrainBrief): Pick<GatewayDispatch, 'briefId' | 'briefRevision'> {
  return brief ? { briefId: brief.id, briefRevision: brief.revision || 0 } : {};
}
function checkBrief(event: GatewayInboxEvent, brief: BrainBrief | undefined): GatewayCompletion | null {
  if (!brief) return event.dispatch?.briefId ? review : null;
  if (event.dispatch?.briefId && event.dispatch.briefId !== brief.id) return review;
  if ((event.dispatch?.briefRevision ?? 0) !== (brief.revision || 0)) return review;
  if (brief.status === 'open') return pending;
  if (brief.status !== 'done') return review;
  return { state: 'completed', answer: brief.summary || '' };
}
function agentCompletion(event: GatewayInboxEvent, agentId: string, chatId: string, runId: string): GatewayCompletion {
  const local = chats.get(agentId, chatId);
  if (!local || local.conversationId !== event.bindingId) return review;
  const all = readExecution().runs.filter((item) => item.projectId === event.route.projectId);
  const run = all.find((item) => item.id === runId && item.projectId === event.route.projectId && item.agentId === agentId && item.chatId === chatId);
  if (!run) return review;
  if (run.status === 'running' || isChatBusy(chatId) || hasBackgroundWork(chatId) || all.some((item) => item.ownerChatId === chatId && item.status === 'running')) return pending;
  if (run.status !== 'completed') return review;
  const brief = checkBrief(event, briefFor(runId, agentId, chatId));
  if (brief) return brief.state === 'completed' ? { state: 'completed', answer: brief.answer || run.answer || '' } : brief;
  // A parent saying it delegated work is not a finished outward answer.
  if (all.some((item) => item.id !== runId && item.ownerChatId === chatId && item.startedAt >= run.startedAt)) return review;
  return { state: 'completed', answer: run.answer || '' };
}
function teamCompletion(event: GatewayInboxEvent, teamId: string, messageId: string): GatewayCompletion {
  if (privateTeamRecord(teamId)?.conversationId !== event.bindingId) return review;
  const team = getTeam(teamId);
  if (!team) return review;
  const thread = getThread(teamId, 10000);
  const at = thread.messages.findIndex((message) => message.id === messageId);
  if (at < 0) return review;
  if (isTeamBusy(teamId)) return pending;
  if (teamState(teamId).resumable) return review;
  const brief = checkBrief(event, briefFor(messageId, teamId));
  if (brief?.state !== 'completed' && brief) return brief;
  const answer = brief?.state === 'completed' && brief.answer || thread.messages.slice(at + 1).findLast((message) => team.members.includes(message.from))?.text;
  return answer ? { state: 'completed', answer } : review;
}

export const gatewayExecution: GatewayExecutionServices = {
  approvalPending(event) {
    return withGatewayRoute(event.route, () => listApprovals().some((approval) => {
      if (!event.dispatch || approval.createdAt < event.dispatch.startedAt || typeof approval.data.runId !== 'string') return false;
      const run = runInfo(approval.data.runId);
      return run?.projectId === event.route.projectId && run.conversationId === event.bindingId;
    }));
  },
  async submit(event, signal, proceed) {
    signal.throwIfAborted();
    if (!proceed() || !event.dispatch || !event.operationId) throw new Error('This gateway operation is no longer authorized.');
    return withGatewayRoute(event.route, async () => {
      const local = event.dispatch!.conversation;
      const attachments = (event.files ?? []).map((file) => file.file!.path);
      if (local.kind === 'agent') {
        const agent = agents.get(local.agentId); const chat = chats.get(local.agentId, local.chatId);
        if (!agent || !chat || chat.conversationId !== event.bindingId) throw new Error('The gateway conversation is unavailable.');
        const run = startRun(agent, chat, event.input.text, { attachments, from: local.sender, reservedRunId: event.operationId, userInitiated: true });
        void run.promise.catch(() => {});
        return { runId: run.runId, ...briefReference(briefFor(run.runId, local.agentId, local.chatId)) };
      }
      if (local.kind === 'team') {
        const message = await postUserMessage(local.teamId, event.input.text, { attachments, sender: local.sender, messageId: event.operationId, route: pickMember, signal });
        return { messageId: message.id, ...briefReference(briefFor(message.id, local.teamId)) };
      }
      const answer = await ask(event.input.text, { project: event.route.projectId, attachments, conversationId: event.bindingId, from: local.sender, operationId: event.operationId, proceed });
      if (answer.done.some((item) => item.kind === 'error')) throw new Error('The Brain operation needs review.');
      const delegate = answer.delegate;
      const brief = delegate?.sent?.runId && delegate.sent.chatId ? briefFor(delegate.sent.runId, delegate.id, delegate.sent.chatId)
        : delegate?.sent?.messageId ? briefFor(delegate.sent.messageId, delegate.id) : undefined;
      return { brain: { answer: answer.answer, delegate: delegate ? { kind: delegate.kind, id: delegate.id, name: delegate.name, message: delegate.message, sent: delegate.sent } : null }, ...briefReference(brief) };
    });
  },
  poll(event) {
    return withGatewayRoute(event.route, () => {
      const dispatch = event.dispatch;
      if (!dispatch) return review;
      const local = dispatch.conversation;
      if (local.kind === 'agent') return agentCompletion(event, local.agentId, local.chatId, dispatch.runId!);
      if (local.kind === 'team') return teamCompletion(event, local.teamId, dispatch.messageId!);
      const saved = dispatch.brain ?? history(event.route.projectId, event.bindingId).findLast((message) => message.role === 'brain' && message.operationId === event.operationId);
      if (!saved || ('done' in saved && saved.done?.some((item) => item.kind === 'error'))) return review;
      const delegate = saved.delegate;
      if (!delegate) return { state: 'completed', answer: 'answer' in saved ? saved.answer : saved.text };
      if (delegate.kind === 'agent' && delegate.sent?.chatId && delegate.sent.runId) return agentCompletion(event, delegate.id, delegate.sent.chatId, delegate.sent.runId);
      if (delegate.kind === 'branch' && delegate.sent?.messageId) return teamCompletion(event, delegate.id, delegate.sent.messageId);
      return review;
    });
  },
};
