import { describe, expect, it, vi } from 'vitest';
import { activeProject, saveSettings } from '../../server/store.ts';
import { dataPath, readPlain, writeJSON } from '../../server/util.ts';
import { cancelForRun, decide, durableApproval, ensureDurableApproval, requestApproval } from '../../server/approvals.ts';
import type { DurableApprovalRecord } from '../../shared/types.ts';

describe('durable Eve approvals', () => {
  it('binds consent to exact project, agent, arguments and run, and saves decisions before returning', async () => {
    saveSettings({ brainApproves: false });
    const request = { title: 'Write the file', agentId: 'owner', data: { runId: 'approval-run', args: { path: 'one', text: 'contents' } } };
    const record = ensureDurableApproval('operation', request);
    expect(record.projectId).toBe(activeProject().id);
    const waiter = requestApproval({ ...request, operationId: 'operation' });
    expect(ensureDurableApproval('operation', { ...request, data: { args: { text: 'contents', path: 'one' }, runId: 'approval-run' } }).id).toBe(record.id);
    expect(() => ensureDurableApproval('operation', { ...request, agentId: 'other' })).toThrow('does not match');
    expect(() => ensureDurableApproval('operation', { ...request, data: { ...request.data, args: { path: 'two' } } })).toThrow('does not match');
    expect(decide(record.id, { approved: true, edited: { path: 'one', text: 'edited' }, always: true })).toBe(true);
    expect(durableApproval('operation')?.decision?.approved).toBe(true);
    expect(await waiter).toEqual(durableApproval('operation')?.decision);
    expect(await requestApproval({ ...request, operationId: 'operation' })).toEqual(durableApproval('operation')?.decision);
    expect(decide(record.id, { approved: false })).toBe(false);
  });

  it('rejects an expired answer even before its timer gets a chance to run', () => {
    const record = ensureDurableApproval('expired', { title: 'Too late', timeoutMs: -1 });
    expect(decide(record.id, { approved: true })).toBe(false);
    expect(durableApproval('expired')?.decision?.approved).toBe(false);
  });

  it('restores an interrupted Brain review as a user request, and restores Stop decisions', async () => {
    const source = ensureDurableApproval('restored', { title: 'Check this', agentId: 'owner', data: { runId: 'restore-run' } });
    // Model a dead process: its saved review has no live reviewer or waiter in the new module.
    const file = dataPath('runtime/eve/approvals', `${source.id}.json`);
    writeJSON(file, { ...source, reviewing: true });
    vi.resetModules();
    const restored = await import('../../server/approvals.ts');
    expect(restored.listApprovals().find((item) => item.id === source.id)?.brainNote).toContain('interrupted');
    restored.cancelForRun('restore-run');
    expect(readPlain<DurableApprovalRecord | null>(file, null)?.decision?.approved).toBe(false);
    expect(restored.decide(source.id, { approved: true })).toBe(false);
    cancelForRun('restore-run');
  });
});
