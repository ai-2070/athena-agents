import { afterEach, describe, expect, it } from 'vitest';
import { activeProject, agents, chats, getSettings, saveSettings } from '../../server/store.ts';
import { newAgent } from '../../server/library.ts';
import { beginRun, bindSession, setRunStatus } from '../../server/eve/state.ts';
import { eveTool, eveToolPolicy } from '../../server/eve/bridge.ts';
import { operationId, readOperation } from '../../server/eve/operations.ts';
import { decide, listApprovals } from '../../server/approvals.ts';
import { callTool } from '../../server/tools.ts';
import { shownWorld } from '../../server/voxel/link.ts';

afterEach(() => {
  for (const request of listApprovals()) decide(request.id, { approved: false });
});

function fixture(autonomy: 'auto' | 'ask' | 'full' = 'auto') {
  saveSettings({ brainApproves: false });
  const agent = agents.save(newAgent({ engine: 'eve', name: 'Durable builder', toolGroups: ['world'], autonomy }));
  const chat = chats.create(agent.id);
  const binding = bindSession(agent, chat, activeProject(), 'proof');
  const runId = `consent-${agent.id}`;
  beginRun(runId, binding.id);
  setRunStatus(runId, 'running');
  return { agent, binding, runId, id: (callId: string) => operationId(binding.id, 'session', runId, callId) };
}

const createOtherObject = async (name: string) => {
  const owner = newAgent({ engine: 'eve', name: 'Original builder', toolGroups: ['world'], autonomy: 'full' });
  const built = await callTool(owner, 'world_build', { object: name, steps: [{ box: [2, 1, 2], use: 'stone' }] });
  expect(built.isError, built.text).toBe(false);
  return owner;
};

describe('Eve nested consent checkpoints', () => {
  it('parks tool access even at Full autonomy, then grants the saved request once', async () => {
    const { agent, binding, runId, id } = fixture('full');
    const args = { tools: 'shell', why: 'Run the requested build' };
    expect(await eveToolPolicy(binding.id, 'session', runId, 'grant', 'request_tool', args)).toEqual({
      status: 'user-approval',
    });
    expect(agents.get(agent.id)?.toolGroups).not.toContain('shell');
    const request = listApprovals().find((item) => item.data.runId === runId)!;
    expect(request.kind).toBe('tools');
    expect(readOperation(id('grant'))?.status).toBe('waiting');
    decide(request.id, { approved: true });
    const result = await eveTool(binding.id, 'session', runId, 'grant', 'request_tool', args);
    expect(result.text).toContain('Given:');
    expect(agents.get(agent.id)?.toolGroups.filter((group) => group === 'shell')).toHaveLength(1);
    expect(await eveTool(binding.id, 'session', runId, 'grant', 'request_tool', args)).toEqual(result);
    expect(listApprovals().filter((item) => item.data.runId === runId)).toEqual([]);
  });

  it('combines the ordinary gate and ownership gate before execution, with no broad Always allow grant', async () => {
    await createOtherObject('Shared bench');
    const { agent, binding, runId, id } = fixture('ask');
    const args = { object: 'Shared bench', steps: [{ box: [1, 1, 1], use: 'stone' }] };
    expect(await eveToolPolicy(binding.id, 'session', runId, 'build', 'world_build', args)).toEqual({
      status: 'user-approval',
    });
    const requests = listApprovals().filter((item) => item.data.runId === runId);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.detail).toContain('Original builder built');
    expect(readOperation(id('build'))?.approvalChecks).toHaveLength(2);
    decide(requests[0]!.id, { approved: true, always: true });
    expect((await eveTool(binding.id, 'session', runId, 'build', 'world_build', args)).isError).toBe(false);
    expect(agents.get(agent.id)?.alwaysAllow || []).not.toContain('world_change_others');
    expect(readOperation(id('build'))?.status).toBe('completed');
    expect(listApprovals().filter((item) => item.data.runId === runId)).toEqual([]);
  });

  it('does not reuse consent after an object with the same name was replaced', async () => {
    const owner = await createOtherObject('Replaceable desk');
    const { binding, runId, id } = fixture();
    const args = { object: 'Replaceable desk', steps: [{ box: [3, 1, 1] }] };
    await eveToolPolicy(binding.id, 'session', runId, 'change', 'world_build', args);
    decide(listApprovals().find((item) => item.data.runId === runId)!.id, { approved: true });
    expect((await callTool(owner, 'world_object', { object: args.object, delete: true })).isError).toBe(false);
    await createOtherObject(args.object);
    const before = JSON.stringify(shownWorld().world);
    expect(await eveTool(binding.id, 'session', runId, 'change', 'world_build', args)).toMatchObject({ denied: true });
    expect(JSON.stringify(shownWorld().world)).toBe(before);
    expect(readOperation(id('change'))?.status).toBe('cancelled');
  });

  it('rejects edited consent aimed at a different owner target', async () => {
    await createOtherObject('Approved target');
    await createOtherObject('Different target');
    const { binding, runId } = fixture();
    const args = { object: 'Approved target', steps: [{ box: [3, 1, 1] }] };
    await eveToolPolicy(binding.id, 'session', runId, 'edited', 'world_build', args);
    decide(listApprovals().find((item) => item.data.runId === runId)!.id, {
      approved: true,
      edited: { ...args, object: 'Different target' },
    });
    const before = JSON.stringify(shownWorld().world);
    expect(await eveTool(binding.id, 'session', runId, 'edited', 'world_build', args)).toMatchObject({ denied: true });
    expect(JSON.stringify(shownWorld().world)).toBe(before);
  });

  it('requires a saved setting decision even at Full autonomy and does not change the look while waiting', async () => {
    const { binding, runId, id } = fixture('full');
    await createOtherObject('Look subject');
    saveSettings({ look: { stationLook: 'classic' } });
    expect(await eveToolPolicy(binding.id, 'session', runId, 'look', 'world_look', {})).toEqual({
      status: 'user-approval',
    });
    expect(getSettings().look.stationLook).toBe('classic');
    const request = listApprovals().find((item) => item.data.runId === runId)!;
    expect(request.kind).toBe('setting');
    decide(request.id, { approved: false });
    expect(await eveTool(binding.id, 'session', runId, 'look', 'world_look', {})).toMatchObject({ denied: true });
    expect(getSettings().look.stationLook).toBe('classic');
    expect(readOperation(id('look'))?.status).toBe('cancelled');
  });
});
