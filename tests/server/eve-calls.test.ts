import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { activeProject, agents, chats, saveSettings, setSecret } from '../../server/store.ts';
import { newAgent } from '../../server/library.ts';
import * as mcp from '../../server/mcp.ts';
import { activeEveRuns, beginRun, bindSession, readRun, setRunStatus, settleRun } from '../../server/eve/state.ts';
import { eveConfiguration, eveTool, eveToolPolicy, openEveBridge } from '../../server/eve/bridge.ts';
import { operationId, operationsForRun, readOperation, saveOperation } from '../../server/eve/operations.ts';
import { eveCounts, resetEveCounts } from '../../server/eve/counts.ts';
import { keptSnapshots } from '../../server/eve/snapshot.ts';
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

/** What Eve asks for around one model call: model, instructions and tools, then the cost check. */
async function modelStep(bindingId: string) {
  const configs = await Promise.all([eveConfiguration(bindingId, 'session'), eveConfiguration(bindingId, 'session'), eveConfiguration(bindingId, 'session')]);
  return [...configs, await eveConfiguration(bindingId, 'session')];
}

/** Earlier work on another binding, saved by this process and then changed on disk behind its back. */
function history(count: number) {
  const other = fixture(`Earlier ${count}`);
  for (let i = 0; i < count; i++) {
    const id = `history-${count}-${i}`;
    other.start(id);
    saveOperation({ id: operationId(other.binding.id, 'session', id, 'call'), runId: id, bindingId: other.binding.id, sessionId: 'session', callId: 'call', name: 'memory_read', args: {}, origin: 'builtin:memory_read', risk: 'none', fingerprint: '', status: 'completed', result: { text: 'old' }, createdAt: 1, updatedAt: 1 });
    settleRun(id, 'completed', 'Old answer');
    writeJSON(runFile(id), { ...readRun(id)!, answer: 'Edited elsewhere' });
  }
}

describe('Eve call counts', () => {
  it('builds the instructions once per run and reads no other run files during a step with one tool call', async () => {
    history(20);
    mcp.saveServer('count-fixture', { type: 'http', url: 'http://127.0.0.1:1/mcp', enabled: true });
    const lists = vi.spyOn(mcp, 'listTools').mockResolvedValue([{ name: 'lookup', description: 'Look something up', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } }]);
    const f = fixture('Counted', { mcpServers: ['count-fixture'] });
    f.start('counted-run');
    const stats = vi.spyOn(fs, 'lstatSync');
    const runStats = () => stats.mock.calls.filter(([file]) => String(file).includes(`${path.sep}runs${path.sep}`)).length;
    resetEveCounts();

    const configs = await modelStep(f.binding.id);
    expect(new Set(configs.map((config) => config.instructions)).size).toBe(1);
    expect(configs[0]!.tools.map((tool) => tool.name)).toContain('count-fixture__lookup');
    expect(await eveToolPolicy(f.binding.id, 'session', 'counted-run', 'call-1', 'memory_add', { note: 'Prefers tea' })).toEqual({ status: 'approved' });
    expect((await eveTool(f.binding.id, 'session', 'counted-run', 'call-1', 'memory_add', { note: 'Prefers tea' })).isError).toBeFalsy();

    // Before: 4 prompt builds, 7 tool lists (7 MCP list requests), 10 call checks that each read all 21 run files.
    expect(eveCounts).toMatchObject({ promptBuilds: 1, toolLists: 6, contexts: 9, runReads: 0, operationReads: 0 });
    expect(lists).toHaveBeenCalledTimes(6);
    // Each check looks at this run's own file; none lists the 20 earlier runs.
    expect(runStats()).toBeLessThan(40);

    resetEveCounts();
    stats.mockClear();
    await modelStep(f.binding.id);
    await eveTool(f.binding.id, 'session', 'counted-run', 'call-2', 'memory_read', {});
    expect(eveCounts).toMatchObject({ promptBuilds: 0, runReads: 0, operationReads: 0 });
    expect(runStats()).toBeLessThan(40);
  });

  it('answers /limit without building a configuration', async () => {
    const f = fixture('Limited');
    f.start('limited-run');
    await eveConfiguration(f.binding.id, 'session');
    resetEveCounts();
    const bridge = await openEveBridge();
    try {
      const response = await fetch(`${bridge.url}/limit`, { method: 'POST', headers: { authorization: `Bearer ${bridge.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ binding: f.binding.id, input: { sessionId: 'session', runId: 'limited-run', limit: 'steps' } }) });
      expect(await response.json()).toEqual({ reason: 'Stopped after 16 model steps. Raise Max tool steps in Settings to continue.' });
    } finally { await bridge.close(); }
    expect(eveCounts).toMatchObject({ promptBuilds: 0, toolLists: 0 });
    expect(readRun('limited-run')?.limitReason).toContain('16 model steps');
  });
});

describe('one set of instructions per run', () => {
  it('keeps MEMORY.md as the run started, and the next run sees the new note', async () => {
    const f = fixture('Remembers');
    f.start('memory-run');
    const [first] = await modelStep(f.binding.id);
    expect(first!.instructions).not.toContain('Takes notes in green');
    expect((await eveTool(f.binding.id, 'session', 'memory-run', 'note', 'memory_add', { note: 'Takes notes in green' })).text).toContain('Remembered');
    const later = await modelStep(f.binding.id);
    expect(later.every((config) => config.instructions === first!.instructions)).toBe(true);
    expect(keptSnapshots()).toBeGreaterThan(0);
    const kept = keptSnapshots();
    settleRun('memory-run', 'completed', 'Done');
    expect(keptSnapshots()).toBe(kept - 1);
    f.start('memory-next');
    expect((await eveConfiguration(f.binding.id, 'session')).instructions).toContain('Takes notes in green');
  });

  it('shows a tool group given during the run at the next call and records only real changes', async () => {
    const f = fixture('Given tools');
    f.start('tools-run');
    const before = await eveConfiguration(f.binding.id, 'session');
    expect(before.tools.map((tool) => tool.name)).not.toContain('read_file');
    const saved = fs.statSync(runFile('tools-run'));
    const step = await modelStep(f.binding.id);
    expect(step.every((config) => JSON.stringify(config.tools) === JSON.stringify(before.tools))).toBe(true);
    // Unchanged: the run file is not read, hashed or written again.
    expect(fs.statSync(runFile('tools-run')).ino).toBe(saved.ino);
    expect(readRun('tools-run')?.configurationVersions).toHaveLength(1);
    agents.save({ ...agents.get(f.agent.id)!, toolGroups: ['files'] });
    const after = await eveConfiguration(f.binding.id, 'session');
    const names = after.tools.map((tool) => tool.name);
    expect(names).toContain('read_file');
    // The tools it had keep their order.
    expect(names.filter((name) => before.tools.some((tool) => tool.name === name))).toEqual(before.tools.map((tool) => tool.name));
    expect(after.instructions).toBe(before.instructions);
    expect(readRun('tools-run')?.configurationVersions).toHaveLength(2);
  });
});

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
