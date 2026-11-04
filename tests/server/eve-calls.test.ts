import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { activeProject, agents, chats, saveSettings, setSecret } from '../../server/store.ts';
import { newAgent } from '../../server/library.ts';
import { activeEveRuns, beginRun, bindSession, readRun, setRunStatus } from '../../server/eve/state.ts';
import { eveConfiguration } from '../../server/eve/bridge.ts';
import { operationId, operationsForRun, readOperation, saveOperation } from '../../server/eve/operations.ts';
import { privateDataPath } from '../../server/private.ts';
import { writeJSON } from '../../server/util.ts';

afterEach(() => vi.restoreAllMocks());

const runFile = (id: string) => privateDataPath('runtime', 'eve', 'runs', `${id}.json`);

function fixture(name: string, options: { toolGroups?: string[]; mcpServers?: string[] } = {}) {
  saveSettings({ providers: { custom: { baseUrl: 'http://127.0.0.1:9876/v1', label: 'Fixture' } }, contextWindowTokens: 64000 });
  setSecret('customKey', 'call-count-fixture-key');
  const agent = agents.save(newAgent({ engine: 'eve', name, provider: 'custom', model: 'proof', toolGroups: options.toolGroups || [], mcpServers: options.mcpServers || [], richAnswers: false }));
  const chat = chats.create(agent.id, name);
  const binding = bindSession(agent, chat, activeProject(), 'proof');
  const start = (runId: string) => {
    beginRun(runId, binding.id);
    setRunStatus(runId, 'running');
  };
  return { agent, chat, binding, start };
}

describe('cached Eve records', () => {
  it('sees run and operation files changed outside this module', async () => {
    const f = fixture('Edited elsewhere');
    f.start('edited-run');
    await eveConfiguration(f.binding.id, 'session');
    const id = operationId(f.binding.id, 'session', 'edited-run', 'call');
    saveOperation({ id, runId: 'edited-run', bindingId: f.binding.id, sessionId: 'session', callId: 'call', name: 'memory_read', args: {}, origin: 'builtin:memory_read', risk: 'none', fingerprint: '', status: 'prepared', createdAt: 1, updatedAt: 1 });
    writeJSON(privateDataPath('runtime', 'eve', 'operations', `${id}.json`), { ...readOperation(id)!, status: 'uncertain' });
    expect(readOperation(id)?.status).toBe('uncertain');
    expect(operationsForRun('edited-run').map((item) => item.status)).toEqual(['uncertain']);
    writeJSON(runFile('edited-run'), { ...readRun('edited-run')!, status: 'stopped' });
    expect(readRun('edited-run')?.status).toBe('stopped');
    expect(activeEveRuns().some((run) => run.id === 'edited-run')).toBe(false);
    await expect(eveConfiguration(f.binding.id, 'session')).rejects.toThrow('no active run');
  });

  it('finds operation files it did not write, and forgets deleted ones', () => {
    const f = fixture('Found elsewhere');
    f.start('found-run');
    const id = operationId(f.binding.id, 'session', 'found-run', 'outside');
    expect(operationsForRun('found-run')).toEqual([]);
    writeJSON(privateDataPath('runtime', 'eve', 'operations', `${id}.json`), { id, runId: 'found-run', bindingId: f.binding.id, sessionId: 'session', callId: 'outside', name: 'memory_read', args: {}, origin: 'builtin:memory_read', risk: 'none', fingerprint: '', status: 'completed', createdAt: 1, updatedAt: 1 });
    expect(operationsForRun('found-run').map((item) => item.id)).toEqual([id]);
    fs.rmSync(privateDataPath('runtime', 'eve', 'operations', `${id}.json`));
    expect(operationsForRun('found-run')).toEqual([]);
    expect(readOperation(id)).toBeNull();
  });

  it('hands out frozen records, so a caller cannot change what the next one reads', () => {
    const f = fixture('Frozen');
    f.start('frozen-run');
    const run = readRun('frozen-run')!;
    expect(Object.isFrozen(run) && Object.isFrozen(run.events)).toBe(true);
    expect(() => { (run as { status: string }).status = 'completed'; }).toThrow(TypeError);
    expect(readRun('frozen-run')?.status).toBe('running');
    const record = setRunStatus('frozen-run', 'waiting');
    record.status = 'completed';
    expect(readRun('frozen-run')?.status).toBe('waiting');
  });
});
