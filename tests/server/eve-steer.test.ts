// Steering an Eve turn: a message whose attached files take a while to read is saved on the run only if its turn
// is still going once they are read; otherwise it goes the ordinary way (sendSteer throws).
import { describe, expect, it, vi } from 'vitest';
import { activeProject, agents, chats } from '../../server/store.ts';
import { newAgent } from '../../server/library.ts';
import {
  attachSession,
  beginRun,
  bindSession,
  readBinding,
  readRun,
  setRunStatus,
  settleRun,
  stageTerminal,
} from '../../server/eve/state.ts';
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

// the private Eve worker: ready at once; ending retired sessions is counted
const worker = vi.hoisted(() => ({ retired: 0 }));
vi.mock('../../server/eve/runtime.ts', async (original) => {
  const real = await original<typeof import('../../server/eve/runtime.ts')>();
  return {
    ...real,
    eveRuntime: {
      ready: async () => ({ url: 'http://127.0.0.1:1', token: 'fixture' }),
      retireBindings: async () => void worker.retired++,
      close: async () => {},
    },
  };
});

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
    await expect(
      sendSteer('steer-race', { id: 'late', text: 'and a summary', attachments: [], from: null }),
    ).rejects.toThrow('can no longer take a message');
    expect(readRun('steer-race')?.steers ?? []).toEqual([]);
  });

  it("isn't saved on a turn that ended", async () => {
    steerableRun('steer-ended');
    during.read = () => settleRun('steer-ended', 'completed', 'done');
    await expect(
      sendSteer('steer-ended', { id: 'late', text: 'and a summary', attachments: [], from: null }),
    ).rejects.toThrow('can no longer take a message');
    expect(readRun('steer-ended')?.steers ?? []).toEqual([]);
  });
});

describe('a steer message whose answer is lost', () => {
  it('ends the session, so a turn Eve may have started with it never runs beside the one sent again', async () => {
    const binding = steerableRun('steer-lost');
    during.read = () => {};
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('socket hang up'));
    try {
      await expect(
        sendSteer('steer-lost', { id: 'lost', text: 'and a summary', attachments: [], from: null }),
      ).rejects.toThrow();
    } finally {
      fetch.mockRestore();
    }
    expect(readRun('steer-lost')?.steers?.[0]).toMatchObject({ id: 'lost', dropped: true });
    expect(readBinding(binding.id)?.retired).toBe(true);
    expect(worker.retired).toBeGreaterThan(0);
  });

  it('keeps the session when Eve said no', async () => {
    const binding = steerableRun('steer-refused');
    during.read = () => {};
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ error: 'busy' }, { status: 409 }));
    try {
      await expect(
        sendSteer('steer-refused', { id: 'no', text: 'and a summary', attachments: [], from: null }),
      ).rejects.toThrow('did not take');
    } finally {
      fetch.mockRestore();
    }
    expect(readBinding(binding.id)?.retired).toBeFalsy();
  });
});
