// A gateway message through the real Brain, team and agent services (only the models are stand-ins): each chat gets
// its own private conversation, and the answer sent back is the finished one.
import { describe, expect, it, vi } from 'vitest';
import { activeProject, chats, workflows } from '../../server/store.ts';
import { newAgent } from '../../server/library.ts';
import { admitExecution, updateExecution } from '../../server/execution.ts';
import { history } from '../../server/overseer.ts';
import { getThread } from '../../server/teams.ts';
import { privateTeamId } from '../../server/private-conversations.ts';
import { runGatewayMessage } from '../../server/gateways/run.ts';
import type { Agent, Chat, Team } from '../../shared/types.ts';

const fake = vi.hoisted(() => ({
  runs: [] as { chat: Chat; text: string; from: string | null | undefined }[],
}));
vi.mock('../../server/brainrun.ts', async (orig) => ({
  ...(await orig<typeof import('../../server/brainrun.ts')>()),
  runBrain: (await import('./brain-fake.ts')).thinkingBrain,
}));
vi.mock('../../server/brain.ts', async (original) => ({
  ...(await original<typeof import('../../server/brain.ts')>()),
  brainModel: () => ({ provider: 'openrouter', model: 'mock', fallback: false }),
  think: async () => 'The Brain answers.',
}));
vi.mock('../../server/engines/index.ts', async (original) => {
  const real = await original<typeof import('../../server/engines/index.ts')>();
  const store = await import('../../server/store.ts');
  return {
    ...real,
    askAgent: async () => 'The member answers.',
    // an agent run that finishes a moment after it starts, with its answer in the journal
    startRun: (agent: Agent, chat: Chat, text: string, options: { from?: string | null } = {}) => {
      fake.runs.push({ chat, text, from: options.from });
      const id = `gw-run-${fake.runs.length}`;
      admitExecution({
        id,
        projectId: store.activeProject().id,
        agentId: agent.id,
        chatId: chat.id,
        engine: agent.engine,
        ownerChatId: chat.id,
        ownerAgentId: agent.id,
        parentRunId: null,
        depth: 0,
        text,
        from: options.from || null,
        attachments: [],
        startedAt: Date.now(),
        status: 'running',
      });
      setTimeout(() => updateExecution(id, { status: 'completed', answer: `Done: ${text}` }), 50);
      return { runId: id, promise: Promise.resolve(''), signal: new AbortController().signal };
    },
  };
});

const input = (target: Parameters<typeof runGatewayMessage>[0]['target'], conversationId: string) => ({
  projectId: activeProject().id,
  conversationId,
  target,
  text: 'Hello from the phone',
  attachments: [],
  from: 'Telegram: Ann (42)',
});

describe('running a gateway message', () => {
  it('gives an agent its own private chat per conversation and returns its finished answer', async () => {
    const agent = newAgent({ name: 'Helper', engine: 'eve', toolGroups: [] });
    const signal = new AbortController().signal;
    const answer = await runGatewayMessage(input({ kind: 'agent', id: agent.id }, 'gw-one'), signal);
    expect(answer).toBe('Done: Hello from the phone');
    await runGatewayMessage(input({ kind: 'agent', id: agent.id }, 'gw-two'), signal);
    const [one, two] = fake.runs;
    expect(one.chat.conversationId).toBe('gw-one');
    expect(two.chat.conversationId).toBe('gw-two');
    expect(one.chat.id).not.toBe(two.chat.id);
    expect(one.from).toBe('Telegram: Ann (42)');
    // (its ordinary chats don't hold it)
    expect(chats.list(agent.id).filter((c) => !c.conversationId)).toEqual([]);
  });

  it('asks the Brain in the conversation of that chat', async () => {
    const answer = await runGatewayMessage(input({ kind: 'brain' }, 'gw-brain'), new AbortController().signal);
    expect(answer).toBe('The Brain answers.');
    expect(history(activeProject().id, 'gw-brain').map((m) => m.role)).toEqual(['user', 'brain']);
    expect(history(activeProject().id).some((m) => 'text' in m && m.text === 'Hello from the phone')).toBe(false);
  });

  it('posts to a private copy of the team and waits for its answer', async () => {
    const agent = newAgent({ name: 'Member', engine: 'eve', toolGroups: [] });
    const team = workflows.save({
      name: 'Crew',
      members: [agent.id],
      lead: agent.id,
      steps: [],
      access: { toolGroups: [], mcpServers: [] },
      skills: [],
    } as Partial<Team>);
    const answer = await runGatewayMessage(
      input({ kind: 'team', id: team.id }, 'gw-team'),
      new AbortController().signal,
    );
    expect(answer).toBe('The member answers.');
    const thread = getThread(privateTeamId('gw-team', team.id));
    expect(thread.messages[0]).toMatchObject({ text: 'Hello from the phone', sender: 'Telegram: Ann (42)' });
    expect(getThread(team.id).messages).toEqual([]);
  });

  it('stops waiting when the gateway stops', async () => {
    const agent = newAgent({ name: 'Slow', engine: 'eve', toolGroups: [] });
    const stop = new AbortController();
    const running = runGatewayMessage(input({ kind: 'agent', id: agent.id }, 'gw-slow'), stop.signal);
    stop.abort();
    await expect(running).rejects.toThrow('stopped');
  });
});
