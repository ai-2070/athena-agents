import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  activeProject,
  agents,
  chats,
  saveSettings,
  setActiveProject,
  setSecret,
  withProject,
} from '../../server/store.ts';
import { createProject } from '../../server/projects.ts';
import { newAgent } from '../../server/library.ts';
import { beginRun, bindSession, readRun, setRunStatus } from '../../server/eve/state.ts';
import { eveConfiguration, eveTool, eveToolPolicy, modelSchema, openEveBridge } from '../../server/eve/bridge.ts';
import { decide, listApprovals } from '../../server/approvals.ts';
import { dataPath, ensureDir } from '../../server/util.ts';
import { stopEveRun } from '../../server/eve/recovery.ts';
import { writeMemory } from '../../server/memory.ts';

describe('the private Eve tool bridge', () => {
  it('sends no tool schema that Claude models refuse (oneOf, anyOf or allOf at the top level)', async () => {
    const project = activeProject();
    const agent = agents.save(
      newAgent({
        engine: 'eve',
        name: 'Eve schema owner',
        provider: 'openrouter',
        model: 'anthropic/claude-haiku-5.5',
        toolGroups: ['agents', 'files', 'browser'],
        richAnswers: false,
      }),
    );
    setSecret('openrouterKey', 'private-schema-fixture-key');
    const chat = chats.create(agent.id, 'Schemas');
    const binding = bindSession(agent, chat, project, 'schemas');
    beginRun('schema-run', binding.id);
    setRunStatus('schema-run', 'running');
    const { tools } = await eveConfiguration(binding.id, 'session');
    // (the task tools take one task or a batch: that used to be a top-level oneOf)
    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['TaskCreate', 'TaskUpdate']));
    for (const tool of tools)
      expect(
        Object.keys(tool.inputSchema).filter((key) => ['oneOf', 'anyOf', 'allOf'].includes(key)),
        tool.name,
      ).toEqual([]);
    // an MCP server's tool can still have one: it is left out, the rest kept
    expect(
      modelSchema({
        type: 'object',
        properties: { a: { type: 'string' } },
        anyOf: [{ required: ['a'] }],
        oneOf: [],
        allOf: [],
      }),
    ).toEqual({ type: 'object', properties: { a: { type: 'string' } } });
    setRunStatus('schema-run', 'stopped');
  });

  it('resolves current project permissions and keeps credentials out of the persisted run', async () => {
    saveSettings({
      providers: { custom: { baseUrl: 'http://127.0.0.1:9876/v1', label: 'Fixture' } },
      contextWindowTokens: 64000,
    });
    setSecret('customKey', 'private-eve-fixture-key');
    const project = activeProject();
    const agent = agents.save(
      newAgent({
        engine: 'eve',
        name: 'Eve bridge owner',
        provider: 'custom',
        model: 'proof',
        toolGroups: ['files', 'agents'],
        richAnswers: false,
      }),
    );
    agents.save(newAgent({ engine: 'eve', name: 'Visible bridge peer' }));
    const chat = chats.create(agent.id, 'Bridge');
    const binding = bindSession(agent, chat, project, 'proof');
    beginRun('bridge-run', binding.id);
    setRunStatus('bridge-run', 'running');
    const config = await eveConfiguration(binding.id, 'session');
    expect(config.model).toBe('proof');
    expect(config.apiKey).toBe('private-eve-fixture-key');
    expect(config.contextWindow).toBe(64000);
    expect(config.costBaseline).toBe(0);
    expect((await eveConfiguration(binding.id, 'session', 10)).costBaseline).toBe(0);
    expect(JSON.stringify(readRun('bridge-run'))).not.toContain('private-eve-fixture-key');
    expect(readRun('bridge-run')?.configurationVersions).toHaveLength(1);
    const other = await createProject({ name: 'Different bridge project' });
    setActiveProject(other.id);
    agents.save(newAgent({ engine: 'eve', name: 'Other private owner' }));
    const result = await eveTool(binding.id, 'session', 'bridge-run', 'list-call', 'list_agents', {});
    expect(result.text).toContain('Visible bridge peer');
    expect(result.text).not.toContain('Other private owner');
    withProject(project, () => agents.save({ ...agent, toolGroups: [] }));
    await expect(eveTool(binding.id, 'session', 'bridge-run', 'read-call', 'read_file', {})).rejects.toThrow(
      'no longer available',
    );
    await expect(eveConfiguration(binding.id, 'foreign-session')).rejects.toThrow('does not own');
    setRunStatus('bridge-run', 'stopped');
    await expect(eveConfiguration(binding.id, 'session')).rejects.toThrow('no active run');
  });

  it('requires private credentials before parsing and returns no diagnostic secrets', async () => {
    const bridge = await openEveBridge();
    try {
      expect((await fetch(bridge.url + '/configuration', { method: 'POST', body: '{' })).status).toBe(401);
      const response = await fetch(bridge.url + '/configuration', {
        method: 'POST',
        headers: { authorization: `Bearer ${bridge.token}` },
        body: JSON.stringify({ binding: '../secrets', input: { sessionId: 'foreign' } }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'The Eve bridge request could not be completed.' });
    } finally {
      await bridge.close();
    }
  });

  it('keeps edited consent attached to the original arguments and rejects calls from an older run', async () => {
    saveSettings({ brainApproves: false });
    const workspace = ensureDir(dataPath('edited-eve-proof'));
    const agent = agents.save(
      newAgent({ engine: 'eve', name: 'Edited consent', toolGroups: ['files'], autonomy: 'ask', workspace }),
    );
    const chat = chats.create(agent.id, 'Edits');
    const binding = bindSession(agent, chat, activeProject(), 'proof');
    beginRun('edited-run', binding.id);
    setRunStatus('edited-run', 'running');
    const args = { path: 'report.txt', content: 'draft' };
    expect(await eveToolPolicy(binding.id, 'session', 'edited-run', 'write-call', 'write_file', args)).toEqual({
      status: 'user-approval',
    });
    const request = listApprovals().find((item) => item.data.runId === 'edited-run');
    expect(request).toBeTruthy();
    decide(request!.id, { approved: true, edited: { ...args, content: 'checked' }, always: true });
    expect((await eveTool(binding.id, 'session', 'edited-run', 'write-call', 'write_file', args)).isError).toBe(false);
    expect(fs.readFileSync(dataPath('edited-eve-proof/report.txt'), 'utf8')).toBe('checked');
    expect(agents.get(agent.id)?.alwaysAllow).toContain('write_file');
    await expect(
      eveTool(binding.id, 'session', 'edited-run', 'write-call', 'write_file', { ...args, content: 'changed call' }),
    ).rejects.toThrow('changed');
    setRunStatus('edited-run', 'completed');
    beginRun('next-run', binding.id);
    setRunStatus('next-run', 'running');
    await expect(eveTool(binding.id, 'session', 'edited-run', 'late-call', 'write_file', args)).rejects.toThrow(
      'active run',
    );
    await stopEveRun('next-run');
  });

  it('hands the model a long result shortened, and keeps that same text in the receipt', async () => {
    const agent = agents.save(newAgent({ engine: 'eve', name: 'Long memory', toolGroups: [], autonomy: 'full' }));
    writeMemory(agent.id, `FIRST ${'note '.repeat(9_000)} LAST`);
    const chat = chats.create(agent.id, 'Long');
    const binding = bindSession(agent, chat, activeProject(), 'proof');
    beginRun('long-run', binding.id);
    setRunStatus('long-run', 'running');
    const result = await eveTool(binding.id, 'session', 'long-run', 'memory-call', 'memory_read', {});
    expect(result.text.length).toBeLessThan(25_000);
    expect(result.text).toMatch(/^FIRST/);
    expect(result.text).toMatch(/LAST$/);
    expect(result.text).toMatch(/whole result is saved in/);
    // a redelivered call gets the same shortened text
    expect((await eveTool(binding.id, 'session', 'long-run', 'memory-call', 'memory_read', {})).text).toBe(result.text);
    await stopEveRun('long-run');
  });
});
