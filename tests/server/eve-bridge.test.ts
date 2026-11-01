import { describe, expect, it } from 'vitest';
import { activeProject, agents, chats, saveSettings, setActiveProject, setSecret, withProject } from '../../server/store.ts';
import { createProject } from '../../server/projects.ts';
import { newAgent } from '../../server/library.ts';
import { beginRun, bindSession, readRun, setRunStatus } from '../../server/eve/state.ts';
import { eveConfiguration, eveTool, openEveBridge } from '../../server/eve/bridge.ts';

describe('the private Eve tool bridge', () => {
  it('resolves current project permissions and keeps credentials out of the persisted run', async () => {
    saveSettings({ providers: { custom: { baseUrl: 'http://127.0.0.1:9876/v1', label: 'Fixture' } }, compaction: { windowTokens: 64000 } });
    setSecret('customKey', 'private-eve-fixture-key');
    const project = activeProject();
    const agent = agents.save(newAgent({ name: 'Eve bridge owner', provider: 'custom', model: 'proof', toolGroups: ['files', 'agents'], richAnswers: false }));
    agents.save(newAgent({ name: 'Visible bridge peer' }));
    const chat = chats.create(agent.id, 'Bridge');
    const binding = bindSession(agent, chat, project, 'proof');
    beginRun('bridge-run', binding.id);
    setRunStatus('bridge-run', 'running');
    const config = await eveConfiguration(binding.id, 'session');
    expect(config.model).toBe('proof');
    expect(config.apiKey).toBe('private-eve-fixture-key');
    expect(config.contextWindow).toBe(64000);
    expect(JSON.stringify(readRun('bridge-run'))).not.toContain('private-eve-fixture-key');
    expect(readRun('bridge-run')?.configurationVersions).toHaveLength(1);
    const other = await createProject({ name: 'Different bridge project' });
    setActiveProject(other.id);
    agents.save(newAgent({ name: 'Other private owner' }));
    const result = await eveTool(binding.id, 'session', 'list_agents', {});
    expect(result.text).toContain('Visible bridge peer');
    expect(result.text).not.toContain('Other private owner');
    withProject(project, () => agents.save({ ...agent, toolGroups: [] }));
    await expect(eveTool(binding.id, 'session', 'read_file', {})).rejects.toThrow('no longer available');
    await expect(eveConfiguration(binding.id, 'foreign-session')).rejects.toThrow('does not own');
    setRunStatus('bridge-run', 'stopped');
    await expect(eveConfiguration(binding.id, 'session')).rejects.toThrow('no active run');
  });

  it('requires private credentials before parsing and returns no diagnostic secrets', async () => {
    const bridge = await openEveBridge();
    try {
      expect((await fetch(bridge.url + '/configuration', { method: 'POST', body: '{' })).status).toBe(401);
      const response = await fetch(bridge.url + '/configuration', { method: 'POST', headers: { authorization: `Bearer ${bridge.token}` }, body: JSON.stringify({ binding: '../secrets', input: { sessionId: 'foreign' } }) });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'The Eve bridge request could not be completed.' });
    } finally {
      await bridge.close();
    }
  });
});
