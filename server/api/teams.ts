// A team's chat (shared/api/teams.ts). The Brain picks which member a message goes to (brain.pickMember).
import { implement } from '@orpc/server';
import { teams as contract } from '../../shared/api/teams.ts';
import * as teams from '../teams.ts';
import * as commands from '../commands.ts';
import { pickMember } from '../brain.ts';
import { openGoal } from '../briefs.ts';
import { cleanAttachments } from '../uploads.ts';
import { refuse, refusing } from './refuse.ts';

const os = implement(contract);

const teamOf = (id: string): string => teams.getTeam(id)?.id || refuse('That team is unavailable.', 404);
// how a message of yours is posted: the one it answers, the member the Brain picks, the files attached
const posting = (input: { replyTo?: string | null; attachments?: string[] }) => ({
  replyTo: input.replyTo || null,
  route: pickMember,
  attachments: cleanAttachments(input.attachments),
});

export const teamsRouter = os.router({
  chat: os.chat.handler(({ input: { id } }) => {
    const team = teams.getTeam(id) || refuse('That team is unavailable.', 404);
    return { team, ...teams.getThread(id), goal: openGoal('team', id), others: teams.otherTeams(id) };
  }),
  send: os.send.handler(({ input }) => teams.postUserMessage(input.id, input.text, posting(input))),
  queue: os.queue.handler(({ input }) => teams.queueUserMessage(input.id, input.text, posting(input))),
  unqueue: os.unqueue.handler(({ input }) => ({ unqueued: teams.unqueueTeam(teamOf(input.id), input.queueId) })),
  editQueued: os.editQueued.handler(({ input }) => ({
    queued: teams.editQueuedTeam(teamOf(input.id), input.queueId, input.text),
  })),
  orderQueue: os.orderQueue.handler(({ input }) => ({ held: teams.orderQueuedTeam(teamOf(input.id), input.ids) })),
  steer: os.steer.handler(({ input }) => teams.steerTeam(input.id, input.text, posting(input))),
  resend: os.resend.handler(({ input }) => commands.resendInTeam(input.id)),
  resume: os.resume.handler(({ input }) => commands.resumeInTeam(input.id)),
  learn: os.learn.handler(({ input }) =>
    commands.learnInTeam(input.id, (input.text ?? '').trim().slice(0, 4000), cleanAttachments(input.attachments)),
  ),
  loop: os.loop.handler(({ input }) =>
    commands.loopInTeam(input.id, input.text ?? '', cleanAttachments(input.attachments)),
  ),
  stopLoop: os.stopLoop.handler(({ input }) => ({ ok: teams.stopTeamLoop(teamOf(input.id), 'Loop stopped.') })),
  goal: os.goal.handler(({ input }) => commands.goalInTeam(input.id, input.text.trim().slice(0, 4000))),
  clearGoal: os.clearGoal.handler(({ input }) => commands.goalInTeam(input.id, 'clear')),
  stop: os.stop.handler(({ input }) => {
    const teamId = teamOf(input.id);
    // the held /queue messages come back to you
    const unqueued = teams.unqueueTeam(teamId);
    return { ok: teams.stopTeam(teamId), unqueued };
  }),
  clear: os.clear.handler(({ input }) => {
    teams.clearThread(teamOf(input.id));
    return { ok: true as const };
  }),
  threads: os.threads.handler(({ input }) => teams.teamThreads(teamOf(input.id))),
  newThread: os.newThread.handler(({ input }) => teams.newTeamThread(teamOf(input.id))),
  openThread: os.openThread.handler(({ input }) =>
    refusing(() => teams.openTeamThread(teamOf(input.id), input.chatId), 404),
  ),
  removeThread: os.removeThread.handler(({ input }) => {
    refusing(() => teams.removeTeamThread(teamOf(input.id), input.chatId), 404);
    return { ok: true as const };
  }),
});
