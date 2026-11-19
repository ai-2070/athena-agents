// A gateway message goes to the Brain, a team or an agent like one typed in the dashboard, in a private conversation of
// its own per chat (private-conversations.ts), and the gateway waits for the finished answer: including work the Brain
// handed on, or helpers an agent started, so the person gets the result and not "I've asked the team".
import { activeProject, agents, bus, chats, withProject } from '../store.ts';
import { hasBackgroundWork, isChatBusy, startRun } from '../engines/index.ts';
import { readExecution } from '../execution.ts';
import { ask } from '../overseer.ts';
import { getTeam, getThread, isTeamBusy, postUserMessage } from '../teams.ts';
import { pickMember } from '../brain.ts';
import { listBriefs } from '../briefs.ts';
import { privateAgentChat, privateTeamId } from '../private-conversations.ts';
import type { GatewayTarget } from '../../shared/types.ts';

export interface GatewayRunInput {
  projectId: string;
  conversationId: string;
  target: GatewayTarget;
  text: string;
  attachments: string[];
  /** Who wrote it, as the agents see it ("Telegram: Ann (123)"). */
  from: string;
}

const stopped = () => new Error('The gateway stopped before the answer was ready.');

/** Checks every second, and when anything happens, until check gives a value. (In this project: an event from
 *  another one wakes it there.) */
function waitFor<T>(check: () => T | undefined, signal: AbortSignal): Promise<T> {
  const project = activeProject();
  return new Promise((resolve, reject) => {
    const done = () => {
      clearInterval(timer);
      bus.off('event', look);
      signal.removeEventListener('abort', abort);
    };
    const look = () => {
      try {
        const value = withProject(project, check);
        if (value === undefined) return;
        done();
        resolve(value);
      } catch (e) {
        done();
        reject(e);
      }
    };
    const abort = () => {
      done();
      reject(stopped());
    };
    const timer = setInterval(look, 1000);
    timer.unref?.();
    bus.on('event', look);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    else look();
  });
}

const briefSummary = (messageId: string, targetId: string): string | undefined => {
  const brief = listBriefs().findLast((b) => b.targetId === targetId && b.messageId === messageId);
  return brief?.status === 'done' && brief.summary?.trim() ? brief.summary : undefined;
};

/** An agent's answer once its chat is quiet: no run, no helpers, nothing it started in the background. */
function agentAnswer(projectId: string, agentId: string, chatId: string, runId: string, signal: AbortSignal) {
  return waitFor(() => {
    const runs = readExecution().runs.filter((r) => r.projectId === projectId);
    const run = runs.find((r) => r.id === runId);
    if (!run) throw new Error('The agent’s run is gone.');
    if (
      run.status === 'running' ||
      isChatBusy(chatId, projectId) ||
      hasBackgroundWork(chatId, projectId) ||
      runs.some((r) => r.ownerChatId === chatId && r.status === 'running')
    )
      return undefined;
    if (run.status !== 'completed') throw new Error(run.error || `The agent’s run ${run.status}.`);
    // (a later turn in the same chat, after its helpers reported back, has the final word)
    const last = runs.findLast((r) => r.chatId === chatId && r.startedAt >= run.startedAt && r.status === 'completed');
    return briefSummary(runId, agentId) || last?.answer || run.answer || '';
  }, signal);
}

/** A team's answer once it is quiet: its summary of the work, or the last thing a member said after the message. */
function teamAnswer(teamId: string, messageId: string, signal: AbortSignal) {
  return waitFor(() => {
    if (isTeamBusy(teamId)) return undefined;
    const team = getTeam(teamId);
    if (!team) throw new Error('The team is gone.');
    const messages = getThread(teamId, 10000).messages;
    const at = messages.findIndex((m) => m.id === messageId);
    const said = messages.slice(at + 1).findLast((m) => team.members.includes(m.from))?.text;
    return briefSummary(messageId, teamId) || said || '';
  }, signal);
}

/** Runs the message in its conversation and gives the answer to send back. Call it in the instance's project. */
export async function runGatewayMessage(input: GatewayRunInput, signal: AbortSignal): Promise<string> {
  const { projectId, conversationId, target, text, attachments, from } = input;
  if (target.kind === 'agent') {
    const agent = agents.get(target.id);
    if (!agent) throw new Error('The agent that answers is gone from the project.');
    const chat = privateAgentChat(conversationId, target.id);
    // (the last message's background work is still going: this one waits its turn)
    await waitFor(() => (isChatBusy(chat.id, projectId) ? undefined : true), signal);
    const run = startRun(agent, chats.get(target.id, chat.id) || chat, text, {
      attachments,
      from,
      userInitiated: true,
    });
    await run.promise.catch(() => {});
    return agentAnswer(projectId, target.id, chat.id, run.runId, signal);
  }
  if (target.kind === 'team') {
    const teamId = privateTeamId(conversationId, target.id);
    const message = await postUserMessage(teamId, text, { attachments, sender: from, route: pickMember, signal });
    return teamAnswer(teamId, message.id, signal);
  }
  const answer = await ask(text, { project: projectId, attachments, conversationId, from });
  const failed = answer.done.find((d) => d.kind === 'error');
  if (failed) throw new Error('The Brain couldn’t answer this.');
  const sent = answer.delegate?.sent;
  if (answer.delegate?.kind === 'agent' && sent?.chatId && sent.runId) {
    const handedOn = await agentAnswer(projectId, answer.delegate.id, sent.chatId, sent.runId, signal);
    return handedOn || answer.answer;
  }
  if (answer.delegate?.kind === 'branch' && sent?.messageId) {
    const handedOn = await teamAnswer(answer.delegate.id, sent.messageId, signal);
    return handedOn || answer.answer;
  }
  return answer.answer;
}
