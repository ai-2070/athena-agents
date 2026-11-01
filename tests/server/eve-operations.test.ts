import { describe, expect, it, vi } from 'vitest';
import { activeProject, agents, chats } from '../../server/store.ts';
import { newAgent } from '../../server/library.ts';
import { beginRun, bindSession, setRunStatus } from '../../server/eve/state.ts';
import { executeOperation, prepareOperation, readOperation, reconcileOperations, saveOperation } from '../../server/eve/operations.ts';

function fixture(id: string) {
  const agent = agents.save(newAgent({ name: id }));
  const chat = chats.create(agent.id, id);
  const binding = bindSession(agent, chat, activeProject(), 'proof');
  beginRun(id, binding.id);
  setRunStatus(id, 'running');
  const input = { runId: id, bindingId: binding.id, sessionId: 'session', callId: 'call', name: 'send', args: { text: 'once', to: 'peer' }, origin: 'builtin:send', risk: 'high' } as const;
  return { input, operation: prepareOperation(input) };
}

describe('saved Eve tool outcomes', () => {
  it('joins duplicate deliveries and reuses the saved result without repeating an effect', async () => {
    const { operation, input } = fixture('outcome-once');
    let release = () => {};
    const execute = vi.fn(async () => { await new Promise<void>((resolve) => { release = resolve; }); return { text: 'sent', images: ['image'] }; });
    const first = executeOperation(operation.id, execute);
    const second = executeOperation(operation.id, execute);
    await Promise.resolve();
    expect(readOperation(operation.id)?.status).toBe('running');
    reconcileOperations(input.runId);
    expect(readOperation(operation.id)?.status).toBe('running');
    release();
    expect(await first).toEqual(await second);
    expect(await executeOperation(operation.id, execute)).toEqual({ text: 'sent', images: ['image'] });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(prepareOperation({ ...input, args: { to: 'peer', text: 'once' } }).id).toBe(operation.id);
    expect(() => prepareOperation({ ...input, args: { text: 'different', to: 'peer' } })).toThrow('changed');
  });

  it('requires review after a crash with saved execution intent, including low-risk writes', async () => {
    const { operation, input } = fixture('outcome-crash');
    saveOperation({ ...operation, status: 'running', risk: 'low' });
    reconcileOperations(input.runId);
    const execute = vi.fn(async () => ({ text: 'must not run' }));
    expect((await executeOperation(operation.id, execute)).isError).toBe(true);
    expect(readOperation(operation.id)?.status).toBe('uncertain');
    expect(() => prepareOperation({ ...input, callId: 'new-call' })).toThrow('checked');
    expect(execute).not.toHaveBeenCalled();
  });

  it('never blindly retries an effect whose executor lost its response', async () => {
    const { operation } = fixture('outcome-unknown');
    let effects = 0;
    const execute = vi.fn(async () => { effects++; throw new Error('connection lost after sending'); });
    await executeOperation(operation.id, execute);
    await executeOperation(operation.id, execute);
    expect(effects).toBe(1);
    expect(readOperation(operation.id)?.status).toBe('uncertain');
  });

  it('cancels prepared work on Stop and refuses late execution', async () => {
    const { operation, input } = fixture('outcome-stop');
    setRunStatus(input.runId, 'stopped');
    reconcileOperations(input.runId, true);
    const execute = vi.fn(async () => ({ text: 'must not run' }));
    expect((await executeOperation(operation.id, execute)).denied).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });
});
