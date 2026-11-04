// set_goal: the agent (or a team's lead) says the user's message is real work, and what done looks like.
// It shows as the chat's goal at once. A greeting or a simple question needs none: if nobody sets one,
// the Brain's check after the reply decides whether the message was work at all (irc.ts).
import { chats, getSettings, withProject } from './store.ts';
import { listBriefs, updateBrief } from './briefs.ts';
import type { ToolDef } from './tools.ts';

export function goalTool(): ToolDef {
  return {
    name: 'set_goal', group: 'core', risk: 'none',
    description: 'Call this once, at the start, when the user\'s message asks for real work (building, fixing, writing, research, a change: anything with a result to deliver). Say what done looks like in a sentence or two, with how it can be checked. The user sees it as the goal of this chat, and the Brain checks your work against it (and the user\'s own words) after each turn, following up until it is met. Don\'t call it for greetings, thanks or a question you answer right away. In a team chat, the lead sets the team\'s goal.',
    parameters: { type: 'object', properties: { goal: { type: 'string', description: 'What done looks like, e.g. "The /help command lists every command, and the tests pass."' } }, required: ['goal'] },
    run: async (args, ctx) => {
      const goal = String(args.goal ?? '').trim().slice(0, 2000);
      if (!goal) return { text: 'Say what done looks like.', isError: true };
      const { runInfo } = await import('./engines/index.ts');
      const run = ctx.runId ? runInfo(ctx.runId) : null;
      if (!run || run.agentId !== ctx.agent.id || run.signal.aborted) return { text: 'There is no chat with the user here to set a goal for.', isError: true };
      // (working for another agent: that agent's chat keeps the goal)
      if (run.depth > 0) return { text: 'You are helping another agent; its chat keeps the goal. Do the part you were asked for.' };
      const { getTeam } = await import('./teams.ts');
      return withProject(run.project, () => {
        const chat = chats.get(ctx.agent.id, run.chatId);
        const team = chat?.teamId ? getTeam(chat.teamId) : null;
        if (team?.lead && team.lead !== ctx.agent.id) return { text: 'The team\'s lead sets its goal. Carry on with your part.' };
        const brief = listBriefs().findLast((b) => b.status === 'open' && (team ? b.kind === 'team' && b.targetId === team.id : b.kind === 'agent' && b.targetId === ctx.agent.id && b.chatId === run.chatId));
        if (!brief) return { text: getSettings().brainFollowsUp === false ? 'Completion checks are off in Settings, so no goal is kept. Carry on.' : 'There is no open assignment here to set a goal for. Carry on.' };
        // the user's own /goal stands
        if (!brief.automatic) return { text: `The user already set the goal: ${brief.goal || brief.text}` };
        updateBrief(brief.id, { doneWhen: goal, recognized: true });
        return { text: `Goal set: ${goal}\nThe Brain checks the work against it after each turn.` };
      });
    },
  };
}
