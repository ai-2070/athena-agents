// request_tool: an agent asks for a set of tools; the Brain (or you) decides, and the agent keeps what it is given.
import { describe, it, expect, afterEach } from 'vitest';
import { setReviewer, listApprovals, decide } from '../../server/approvals.ts';
import { agents, saveSettings } from '../../server/store.ts';
import { newAgent } from '../../server/library.ts';
import { callTool, toolsForAgent } from '../../server/tools.ts';
import type { Approval } from '../../shared/types.ts';

const tick = () => new Promise((r) => setTimeout(r, 0));
// (an API model: the coding engines have their own file tools and are told to use those)
const coder = () => agents.save({ ...newAgent({ name: 'Coder', toolGroups: [] }), engine: 'eve' });

afterEach(() => {
  setReviewer(null);
  saveSettings({ brainApproves: true });
  for (const a of listApprovals()) decide(a.id, { approved: false });
});

describe('request_tool', () => {
  it('every agent has it', () => {
    expect(toolsForAgent(newAgent({ name: 'Plain', toolGroups: [] })).map((t) => t.name)).toContain('request_tool');
  });

  it('goes to the Brain; once given, the agent keeps the tools and can use them in the same run', async () => {
    let seen: Approval | null = null;
    setReviewer(async (item) => ((seen = item), { approve: true, reason: 'needs files' }));
    const agent = coder();
    const r = await callTool(agent, 'request_tool', { tools: 'files', why: 'to read the notes' });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/you now have the Files tools \(.*read_file/);
    expect(seen!.kind).toBe('tools');
    expect(seen!.data.group).toBe('files');
    expect(agents.get(agent.id)!.toolGroups).toContain('files');
    // the same agent object (the run's) can use them at once
    expect(toolsForAgent(agent).map((t) => t.name)).toContain('read_file');
  });

  it('passed on to you and denied: nothing changes, and the agent is told not to ask again', async () => {
    setReviewer(async () => ({ approve: false, reason: 'not sure' }));
    const agent = coder();
    const p = callTool(agent, 'request_tool', { tools: 'social', why: 'to post the launch' });
    await tick();
    await tick();
    const [a] = listApprovals();
    expect(a.title).toBe('Coder asks for the Social tools');
    expect(a.brainNote).toBe('not sure');
    decide(a.id, { approved: false, message: 'no posting yet' });
    const r = await p;
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Not given: no posting yet\. Don't ask for it again/);
    expect(agents.get(agent.id)!.toolGroups).not.toContain('social');
  });

  it('refuses an unknown set, a missing reason, a set it has, and stand-ins that are not saved agents', async () => {
    setReviewer(async () => ({ approve: true, reason: '' }));
    const agent = coder();
    expect((await callTool(agent, 'request_tool', { tools: 'rockets', why: 'x' })).text).toMatch(/no "rockets" set/);
    expect((await callTool(agent, 'request_tool', { tools: 'files', why: ' ' })).text).toMatch(/Say what you need/);
    const has = agents.save({ ...newAgent({ name: 'Filer', toolGroups: ['files'] }), engine: 'eve' });
    expect((await callTool(has, 'request_tool', { tools: 'files', why: 'x' })).text).toMatch(/already have/);
    expect((await callTool({ id: '_external', name: 'Outside' }, 'request_tool', { tools: 'files', why: 'x' })).text).toMatch(/Only the dashboard's agents/);
    expect(listApprovals()).toHaveLength(0);
  });

  it('tells an agent on a coding engine to use its own file and command tools', async () => {
    setReviewer(async () => ({ approve: true, reason: '' }));
    const agent = agents.save({ ...newAgent({ name: 'Native', toolGroups: [] }), engine: 'claude-code' });
    for (const tools of ['files', 'shell']) expect((await callTool(agent, 'request_tool', { tools, why: 'to read the notes' })).text).toMatch(/own tools for files and commands/);
    expect(listApprovals()).toHaveLength(0);
    expect(agents.get(agent.id)!.toolGroups).toEqual([]);
  });

  it('lists every set briefly', () => {
    const tool = toolsForAgent(newAgent({ name: 'Plain', toolGroups: [] })).find((t) => t.name === 'request_tool')!;
    expect(tool.description).toMatch(/The sets: programs, browser, .*world \(Voxel world\), shell\.$/);
    expect(tool.description.length).toBeLessThan(900);
  });
});
