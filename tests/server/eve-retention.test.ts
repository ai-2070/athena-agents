import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { activeProject, agents, chats, saveSettings } from '../../server/store.ts';
import { newAgent } from '../../server/library.ts';
import { beginRun, bindSession, conversationBinding, markProjected, readBinding, readRun, recordEvents, setRunStatus, settleRun } from '../../server/eve/state.ts';
import { operationsForRun, prepareOperation, readOperation, saveOperation } from '../../server/eve/operations.ts';
import { decide, durableApproval, ensureDurableApproval } from '../../server/approvals.ts';
import { EVE_RECEIPT_DAYS, removeOldEveReceipts } from '../../server/eve/retention.ts';
import { EveRuntime } from '../../server/eve/runtime.ts';
import { privateDataPath } from '../../server/private.ts';
import { writeJSON } from '../../server/util.ts';
import type { EveToolOperation } from '../../shared/types.ts';

const DAY = 24 * 60 * 60 * 1000;
const file = (kind: string, id: string) => privateDataPath('runtime', 'eve', kind, `${id}.json`);
const approvalFile = (key: string) => file('approvals', durableApproval(key)!.id);

afterEach(() => vi.useRealTimers());

/** A run with one tool call and a saved input, ended (and dated) as asked. */
function run(id: string, { status = 'completed', operation = 'completed', daysAgo = EVE_RECEIPT_DAYS + 1 }: { status?: 'completed' | 'failed' | 'stopped' | 'interrupted' | 'running'; operation?: EveToolOperation['status']; daysAgo?: number } = {}) {
  saveSettings({ brainApproves: false });
  const agent = agents.save(newAgent({ engine: 'eve', name: id }));
  const chat = chats.create(agent.id, id);
  const binding = bindSession(agent, chat, activeProject(), 'retention');
  beginRun(id, binding.id);
  setRunStatus(id, 'running');
  const prepared = prepareOperation({ runId: id, bindingId: binding.id, sessionId: 'session', callId: 'call', name: 'send', args: { to: 'peer' }, origin: 'builtin:send', risk: 'high' });
  const approval = ensureDurableApproval(prepared.id, { title: `Send for ${id}`, agentId: agent.id, data: { runId: id } });
  decide(approval.id, { approved: true });
  saveOperation({ ...prepared, approvalId: approval.id, status: operation });
  writeJSON(file('admissions', id), { id });
  if (status !== 'running') settleRun(id, status, 'Done');
  writeJSON(file('runs', id), { ...readRun(id)!, ...(status === 'running' ? {} : { endedAt: Date.now() - daysAgo * DAY }), updatedAt: Date.now() - daysAgo * DAY });
  return { agent, chat, binding, operation: readOperation(prepared.id)! };
}

const kept = (id: string) => !!readRun(id) && fs.existsSync(file('admissions', id)) && operationsForRun(id).length === 1;

describe('removing old Eve receipts', () => {
  it('removes the run, its operations, its input and its decided consent after 30 days', () => {
    const old = run('old-done');
    const consent = approvalFile(old.operation.id);
    const recent = run('recent-done', { daysAgo: EVE_RECEIPT_DAYS - 1 });
    expect(removeOldEveReceipts()).toEqual(['old-done']);
    expect(readRun('old-done')).toBeNull();
    expect(readOperation(old.operation.id)).toBeNull();
    expect(fs.existsSync(file('operations', old.operation.id))).toBe(false);
    expect(fs.existsSync(file('admissions', 'old-done'))).toBe(false);
    expect(fs.existsSync(consent)).toBe(false);
    expect(kept('recent-done')).toBe(true);
    expect(durableApproval(recent.operation.id)?.decision?.approved).toBe(true);
    // The age is a setting of the sweep.
    expect(removeOldEveReceipts({ keepMs: 0 })).toEqual(['recent-done']);
  });

  it('keeps runs that are not finished or whose results are not all in the chat', () => {
    run('still-working', { status: 'running' });
    run('not-projected');
    writeJSON(file('runs', 'not-projected'), { ...readRun('not-projected')!, events: [{ id: '1:0:0', event: { kind: 'text', text: 'Unsaved reply' } }], projected: 0 });
    expect(removeOldEveReceipts()).toEqual([]);
    expect(kept('still-working') && kept('not-projected')).toBe(true);
    markProjected('not-projected', 1);
    expect(removeOldEveReceipts()).toEqual(['not-projected']);
  });

  it.each(['waiting', 'running', 'prepared', 'uncertain'] as const)('keeps a run with a %s operation', (status) => {
    run(`open-${status}`, { status: 'interrupted', operation: status });
    expect(removeOldEveReceipts()).toEqual([]);
    expect(kept(`open-${status}`)).toBe(true);
  });

  it('keeps a run while a consent or an outcome check is undecided', () => {
    const asked = run('asked', { operation: 'cancelled' });
    writeJSON(approvalFile(asked.operation.id), { ...durableApproval(asked.operation.id)!, decision: undefined });
    const checked = run('checked', { status: 'interrupted', operation: 'cancelled' });
    const check = ensureDurableApproval(`reconcile:${checked.operation.id}`, { kind: 'workflow', title: 'Check the outcome', agentId: checked.agent.id, data: { runId: 'checked', outcomeCheck: true } });
    expect(removeOldEveReceipts()).toEqual([]);
    expect(kept('asked') && kept('checked')).toBe(true);
    decide(check.id, { approved: true });
    expect(removeOldEveReceipts()).toEqual(['checked']);
    expect(fs.existsSync(file('approvals', check.id))).toBe(false);
  });

  it('retires the binding of an interrupted run before removing it, so it is never used again', () => {
    const lost = run('lost', { status: 'interrupted' });
    const finished = run('finished');
    expect(conversationBinding(activeProject().id, lost.agent.id, lost.chat.id, 'retention')).toBeNull();
    expect(removeOldEveReceipts().sort()).toEqual(['finished', 'lost']);
    expect(readBinding(lost.binding.id)?.retired).toBe(true);
    expect(conversationBinding(activeProject().id, lost.agent.id, lost.chat.id, 'retention')).toBeNull();
    // A finished conversation keeps its native session for the next turn.
    expect(readBinding(finished.binding.id)?.retired).toBe(false);
    expect(conversationBinding(activeProject().id, finished.agent.id, finished.chat.id, 'retention')?.id).toBe(finished.binding.id);
  });

  it('dates runs stopped before this change by their last save, and stopping now saves when it ended', () => {
    const at = Date.now();
    const stopped = run('stopped-now', { status: 'running' });
    setRunStatus('stopped-now', 'stopped');
    expect(readRun('stopped-now')?.endedAt).toBeGreaterThanOrEqual(at);
    expect(removeOldEveReceipts()).toEqual([]);
    writeJSON(file('runs', 'stopped-now'), { ...readRun('stopped-now')!, endedAt: undefined, updatedAt: at - (EVE_RECEIPT_DAYS + 1) * DAY });
    expect(removeOldEveReceipts()).toEqual(['stopped-now']);
    expect(readBinding(stopped.binding.id)?.retired).toBe(true);
  });
});

describe('when Eve removes old receipts', () => {
  it('sweeps once when the runtime first starts, then daily while it owns the data folder', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const tidy = vi.fn();
    let exit = () => {};
    const runtime = new EveRuntime({
      claim: async () => async () => {},
      bridge: async () => ({ url: 'http://127.0.0.1:1', token: 'fixture', close: async () => {} }),
      host: async () => {
        let resolve = () => {};
        const exited = new Promise<void>((done) => { resolve = done; });
        exit = resolve;
        return { url: 'http://127.0.0.1:2', token: 'fixture', exited, close: async () => resolve() };
      },
      prepare: () => {},
      recover: async () => {},
      hasWork: () => false,
      tidy,
    });
    await runtime.ready();
    expect(tidy).toHaveBeenCalledTimes(1);
    exit();
    await vi.waitFor(() => runtime.ready());
    expect(tidy).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(DAY);
    expect(tidy).toHaveBeenCalledTimes(2);
    await runtime.close();
    vi.advanceTimersByTime(DAY);
    expect(tidy).toHaveBeenCalledTimes(2);
  });
});
