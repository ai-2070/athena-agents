import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { activeProject, agents, chats, setActiveProject, withProject } from '../../server/store.ts';
import { createProject } from '../../server/projects.ts';
import { newAgent } from '../../server/library.ts';
import { activeEveRuns, attachSession, beginRun, bindSession, readBinding, readRun, recordEvents, retireSession, sessionContext, setRunStatus } from '../../server/eve/state.ts';
import { projectEvent } from '../../server/eve/projection.ts';
import { dataPath } from '../../server/util.ts';

function fixture() {
  const project = activeProject();
  const agent = agents.save(newAgent({ name: 'Bound agent', toolGroups: [] }));
  const chat = chats.create(agent.id, 'Bound chat');
  return { project, agent, chat, binding: bindSession(agent, chat, project, 'proof') };
}

describe('Eve session ownership', () => {
  it('pins a saved binding across project switches and refuses reused or retired sessions', async () => {
    const own = fixture();
    attachSession(own.binding.id, 'eve-session');
    const other = await createProject({ name: 'Other project' });
    setActiveProject(other.id);
    expect(sessionContext(own.binding.id).project.id).toBe(own.project.id);
    expect(sessionContext(own.binding.id).agent.id).toBe(own.agent.id);
    expect(readBinding(own.binding.id)?.sessionId).toBe('eve-session');
    expect(() => attachSession(own.binding.id, 'another-session')).toThrow('another Eve session');
    expect(readBinding('../secrets')).toBeNull();
    retireSession(own.binding.id);
    expect(() => sessionContext(own.binding.id)).toThrow('not active');
  });

  it('refuses a deleted owner even if the agent and chat IDs exist in another project', () => {
    const own = fixture();
    withProject(own.project, () => agents.remove(own.agent.id));
    expect(() => sessionContext(own.binding.id)).toThrow('no longer exists');
  });
});

describe('Eve run ledger', () => {
  it('persists ownership, rejects overlapping claims and never resumes a stopped run', () => {
    const own = fixture();
    beginRun('proof-run', own.binding.id);
    expect(() => beginRun('overlap-run', own.binding.id)).toThrow('work in progress');
    expect(beginRun('proof-run', own.binding.id).status).toBe('queued');
    const another = fixture();
    expect(() => beginRun('proof-run', another.binding.id)).toThrow('ownership');
    setRunStatus('proof-run', 'running', 'delivery');
    expect(() => setRunStatus('proof-run', 'running', 'different')).toThrow('delivery');
    expect(activeEveRuns().some((run) => run.id === 'proof-run')).toBe(true);
    setRunStatus('proof-run', 'stopped');
    expect(() => setRunStatus('proof-run', 'running')).toThrow('finished');
    expect(activeEveRuns().some((run) => run.id === 'proof-run')).toBe(false);
    expect(() => recordEvents('proof-run', { line: 0, index: 0 }, [])).toThrow('finished');
    expect(fs.existsSync(dataPath('runtime/eve/runs/proof-run.json'))).toBe(true);
  });

  it('saves committed original text once, including several facts in a source line', () => {
    const own = fixture();
    beginRun('projection-run', own.binding.id);
    const source = { type: 'content.completed', data: { partId: 'part', runId: 'model', kind: 'text', value: 'Complete original', phase: 'reply' }, meta: { position: { line: 3, index: 0 }, at: new Date().toISOString() } } as const;
    expect(projectEvent('projection-run', source).map((item) => item.event)).toEqual([{ kind: 'text', text: 'Complete original' }]);
    expect(projectEvent('projection-run', source)).toEqual([]);
    projectEvent('projection-run', { ...source, data: { ...source.data, partId: 'second', value: 'Second original' }, meta: { ...source.meta, position: { line: 3, index: 1 } } });
    projectEvent('projection-run', { type: 'content.delta', data: { partId: 'third', delta: 'preview' }, meta: { ...source.meta, position: { line: 4, index: 0 } } });
    expect(readRun('projection-run')?.events).toHaveLength(2);
    expect(readRun('projection-run')?.cursor).toEqual({ line: 3, index: 1 });
    expect(() => recordEvents('projection-run', { line: -1, index: 0 }, [])).toThrow('position');
  });

  it('projects the original tool outcome and a read-only native compaction mark', () => {
    const own = fixture();
    beginRun('tool-projection', own.binding.id);
    const meta = { position: { line: 1, index: 0 }, at: new Date().toISOString() };
    projectEvent('tool-projection', { type: 'call.requested', data: { callId: 'tool', owner: { runId: 'model' }, capability: { kind: 'tool', name: 'read_file' }, input: { path: 'report' } }, meta });
    const result = projectEvent('tool-projection', { type: 'call.settled', data: { callId: 'tool', outcome: 'completed', output: { text: 'original result', isError: true } }, meta: { ...meta, position: { line: 1, index: 1 } } });
    expect(result[0]?.event).toEqual({ kind: 'tool_result', id: 'tool', text: 'original result', isError: true });
    const mark = projectEvent('tool-projection', { type: 'context.settled', data: { changeId: 'compact', kind: 'compaction', outcome: 'completed' }, meta: { ...meta, position: { line: 2, index: 0 } } });
    expect(mark[0]?.event).toEqual({ kind: 'compacted' });
  });
});
