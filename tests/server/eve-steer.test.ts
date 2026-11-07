// Steering an Eve turn: a message whose attached files take a while to read is saved on the run only if its turn
// is still going once they are read; otherwise it goes the ordinary way (sendSteer throws).
import { describe, expect, it, vi } from 'vitest';
import { activeProject, agents, chats } from '../../server/store.ts';
import { newAgent } from '../../server/library.ts';
import { attachSession, beginRun, bindSession, readRun, setRunStatus, settleRun, stageTerminal } from '../../server/eve/state.ts';
import { sendSteer } from '../../server/eve/steer.ts';

// reading the message's files: the turn ends meanwhile when the test says so
const during = vi.hoisted(() => ({ read: () => {} }));
vi.mock('../../server/eve/admission.ts', async (original) => ({
  ...(await original<typeof import('../../server/eve/admission.ts')>()),
  eveMessage: async () => {
    during.read();
    return [{ type: 'text', text: 'and a summary' }];
  },
}));

function steerableRun(runId: string) {
  const agent = agents.save(newAgent({ engine: 'eve', name: 'Steered agent', toolGroups: [] }));
  const chat = chats.create(agent.id, 'Steered chat');
  const binding = bindSession(agent, chat, activeProject(), 'proof');
  attachSession(binding.id, `${runId}-session`);
  beginRun(runId, binding.id);
  setRunStatus(runId, 'running', `${runId}-delivery`);
  return binding;
}

describe('a steer message read while its turn ends', () => {
  it("isn't saved on a turn that is ending, so it can go the ordinary way", async () => {
    steerableRun('steer-race');
    // the turn's end has arrived, and is being written down
    during.read = () => stageTerminal('steer-race', { line: 3, status: 'completed', parts: ['done'] });
    await expect(sendSteer('steer-race', { id: 'late', text: 'and a summary', attachments: [], from: null })).rejects.toThrow('can no longer take a message');
    expect(readRun('steer-race')?.steers ?? []).toEqual([]);
  });

  it("isn't saved on a turn that ended", async () => {
    steerableRun('steer-ended');
    during.read = () => settleRun('steer-ended', 'completed', 'done');
    await expect(sendSteer('steer-ended', { id: 'late', text: 'and a summary', attachments: [], from: null })).rejects.toThrow('can no longer take a message');
    expect(readRun('steer-ended')?.steers ?? []).toEqual([]);
  });
});
