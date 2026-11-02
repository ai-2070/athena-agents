import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from 'eve/client';
import { activeProject, agents, chats, saveSettings, setSecret, withProject } from '../../server/store.ts';
import { newAgent } from '../../server/library.ts';
import { createProject } from '../../server/projects.ts';
import { admitExecution, updateExecution } from '../../server/execution.ts';
import { newBatch } from '../../server/uploads.ts';
import { privateDataPath } from '../../server/private.ts';
import { writeJSON } from '../../server/util.ts';
import { admissionHistory, prepareAdmission, readAdmission, submitAdmission, validAdmission } from '../../server/eve/admission.ts';
import { readBinding, readRun, recordAdmissionReceipt, settleRun } from '../../server/eve/state.ts';
import { prepareEveRecovery, stopEveRun } from '../../server/eve/recovery.ts';
import { eveRuntime } from '../../server/eve/runtime.ts';
import { eveCoordinator } from '../../server/eve/coordinator.ts';
import { run as runEve } from '../../server/engines/eve.ts';
import { eveConfiguration } from '../../server/eve/bridge.ts';
import type { ChatItem, ExecutionRun } from '../../shared/types.ts';

afterEach(() => vi.restoreAllMocks());

function fixture(items: ChatItem[] = [], attachments: string[] = []) {
  saveSettings({ contextWindowTokens: 64000 });
  setSecret('openrouterKey', 'unit-admission-key');
  const project = activeProject();
  const agent = agents.save(newAgent({ engine: 'eve', name: 'Admission owner', toolGroups: [], mcpServers: [], richAnswers: false }));
  const chat = chats.create(agent.id, 'Admission');
  const run: ExecutionRun = { id: `admit-${chat.id}`, projectId: project.id, agentId: agent.id, chatId: chat.id, engine: agent.engine, depth: 0, parentRunId: null, ownerAgentId: agent.id, ownerChatId: chat.id, text: 'Current input', from: null, attachments, status: 'running', startedAt: Date.now() };
  admitExecution(run);
  chat.items = [...items, { type: 'user', text: run.text, runId: run.id }];
  chats.save(chat);
  return { project, agent, chat, run };
}

function transport(reply: (body: Record<string, unknown>) => Response | Promise<Response>) {
  const client = new Client({ baseUrl: 'http://127.0.0.1:4800' });
  const fetch = vi.spyOn(client, 'fetch').mockImplementation(async (_url, init) => reply(JSON.parse(String(init?.body)) as Record<string, unknown>));
  return { client, fetch };
}

describe('saved Eve input admission', () => {
  it('pins a turn model and its options while resolving current permissions', async () => {
    const own = fixture();
    agents.save({ ...own.agent, model: 'original-model', temperature: 0.2, effort: 'high' });
    const input = await prepareAdmission(own.run.id, own.project);
    agents.save({ ...own.agent, model: 'changed-model', temperature: 0.8, effort: 'low', toolGroups: [] });
    const selected = await eveConfiguration(input.bindingId, 'selected-session');
    expect(selected).toMatchObject({ model: 'original-model', temperature: 0.2, effort: 'high', cacheKey: input.bindingId });
    expect(JSON.stringify(readAdmission(input.id))).not.toContain('unit-admission-key');
  });

  it('refuses to reroute an admitted turn when its provider address changes', async () => {
    const own = fixture();
    agents.save({ ...own.agent, provider: 'custom' });
    saveSettings({ providers: { custom: { baseUrl: 'http://127.0.0.1:9001/v1', label: 'Original' } } });
    const input = await prepareAdmission(own.run.id, own.project);
    saveSettings({ providers: { custom: { baseUrl: 'http://127.0.0.1:9002/v1', label: 'Changed' } } });
    await expect(eveConfiguration(input.bindingId, 'pinned-endpoint')).rejects.toThrow('address changed');
    expect(readAdmission(input.id)?.selection.baseUrl).toBe('http://127.0.0.1:9001/v1');
  });

  it('starts a fresh native session after changing models or clearing memory', async () => {
    const own = fixture([{ type: 'user', text: 'Retained history' }]);
    const first = await prepareAdmission(own.run.id, own.project);
    recordAdmissionReceipt(first.id, 'old-model-session', 'old-delivery', []);
    settleRun(first.id, 'completed', 'Old answer');
    updateExecution(first.id, { status: 'completed', settled: true });
    agents.save({ ...own.agent, model: 'another-model' });
    const next = { ...own.run, id: `${own.run.id}-model` };
    admitExecution(next);
    const changed = await prepareAdmission(next.id, own.project);
    expect(changed.mode).toBe('create');
    expect(changed.bindingId).not.toBe(first.bindingId);
    expect(changed.history.some((m) => m.text === 'Retained history')).toBe(true);
    recordAdmissionReceipt(changed.id, 'changed-model-session', 'changed-delivery', []);
    settleRun(changed.id, 'completed', 'Changed answer');
    updateExecution(changed.id, { status: 'completed', settled: true });
    own.chat.items.push({ type: 'meta', text: 'Memory cleared', reset: true });
    chats.save(own.chat);
    const cleared = { ...own.run, id: `${own.run.id}-clear` };
    admitExecution(cleared);
    const fresh = await prepareAdmission(cleared.id, own.project);
    expect(fresh.mode).toBe('create');
    expect(fresh.bindingId).not.toBe(changed.bindingId);
    expect(fresh.history).toEqual([]);
  });

  it('runs the adapter through a lost receipt and follows the native result', async () => {
    const own = fixture();
    const ready = vi.spyOn(eveRuntime, 'ready').mockResolvedValue({ url: 'http://127.0.0.1:4800', token: 'fixture', exited: new Promise<void>(() => {}), close: async () => {} });
    const requests: string[] = [];
    vi.spyOn(Client.prototype, 'fetch').mockImplementation(async (_route, init) => {
      requests.push(String(init?.body));
      if (requests.length === 1) throw new Error('Receipt lost');
      return Response.json({ sessionId: 'adapter-session', deliveryId: 'adapter-delivery' });
    });
    vi.spyOn(eveCoordinator, 'follow').mockImplementation(async (id) => { settleRun(id, 'completed', 'Native answer'); });
    expect(await runEve({ agent: own.agent, chat: own.chat, runId: own.run.id, text: own.run.text, systemPrompt: '', attachments: [], signal: new AbortController().signal, depth: 0, onEvent: () => {} })).toEqual({ text: 'Native answer', window: 64000 });
    expect(requests).toHaveLength(2);
    expect(requests[0]).toBe(requests[1]);
    expect(ready).toHaveBeenCalledTimes(2);
    expect(readAdmission(own.run.id)?.status).toBe('accepted');
  });

  it('keeps a Stop final when the adapter receives its creation receipt afterward', async () => {
    const own = fixture();
    const controller = new AbortController();
    vi.spyOn(eveRuntime, 'ready').mockResolvedValue({ url: 'http://127.0.0.1:4800', token: 'fixture', exited: new Promise<void>(() => {}), close: async () => {} });
    const fetch = vi.spyOn(Client.prototype, 'fetch').mockImplementation(async (route) => {
      if (route.endsWith('/end')) return Response.json({});
      controller.abort();
      return Response.json({ sessionId: 'late-session', deliveryId: 'late-delivery' });
    });
    vi.spyOn(eveCoordinator, 'follow').mockResolvedValue();
    await expect(runEve({ agent: own.agent, chat: own.chat, runId: own.run.id, text: own.run.text, systemPrompt: '', attachments: [], signal: controller.signal, depth: 0, onEvent: () => {} })).rejects.toThrow('could not finish');
    expect(readRun(own.run.id)).toMatchObject({ status: 'stopped', deliveryId: 'late-delivery' });
    expect(readBinding(readRun(own.run.id)!.bindingId)).toMatchObject({ retired: true, runtimeEnded: true });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('imports original roles and tool results after the last memory reset', async () => {
    const original = 'Original result '.repeat(4000);
    const own = fixture([
      { type: 'user', text: 'Forgotten' }, { type: 'meta', text: 'Reset', reset: true },
      { type: 'user', text: 'First question', from: 'You' }, { type: 'assistant', text: 'First answer' },
      { type: 'tool', id: 'tool', name: 'read_file', args: { path: 'notes' }, result: original, status: 'done' },
    ]);
    const input = await prepareAdmission(own.run.id, own.project);
    expect(input.mode).toBe('create');
    expect(input.history.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant']);
    expect(input.history[0]?.text).toBe('You:\nFirst question');
    expect(input.history[2]?.text).toContain(original);
    expect(JSON.stringify(input)).not.toContain('Forgotten');
    expect(admissionHistory(input.bindingId, input.id, input.messageHash)).toEqual(input.history);
    expect(() => admissionHistory(input.bindingId, input.id, '0'.repeat(64))).toThrow('does not match');
    prepareEveRecovery();
    expect(readRun(input.id)?.status).toBe('running');
  });

  it('retries a lost create receipt with the same operation key and saved file bytes', async () => {
    const dir = newBatch().dir;
    const file = path.join(dir, 'proof.png');
    fs.writeFileSync(file, Buffer.from([0, 1, 2, 3]));
    const own = fixture([], [file]);
    const input = await prepareAdmission(own.run.id, own.project);
    fs.unlinkSync(file);
    expect(await prepareAdmission(own.run.id, own.project)).toEqual(input);
    const seen: Record<string, unknown>[] = [];
    const { client } = transport((body) => {
      seen.push(body);
      if (seen.length === 1) throw new Error('The worker accepted this but its response was lost.');
      return Response.json({ sessionId: 'original-session', deliveryId: 'original-delivery' });
    });
    await expect(submitAdmission(input, client)).rejects.toThrow('response was lost');
    expect(readAdmission(input.id)?.status).toBe('prepared');
    await submitAdmission(readAdmission(input.id)!, client);
    expect(seen[0]).toEqual(seen[1]);
    expect(seen[1]?.operationId).toBe(`athena:${input.bindingId}`);
    expect(seen[1]?.message).toContainEqual({ type: 'file', filename: 'proof.png', mediaType: 'image/png', data: 'data:image/png;base64,AAECAw==' });
    expect(readRun(input.id)?.deliveryId).toBe('original-delivery');
    await submitAdmission(input, client);
    expect(seen).toHaveLength(2);
  });

  it('pins follow-up messages to their session and imports each team source once', async () => {
    const own = fixture([{ type: 'user', text: 'Team source', teamMessageId: 'source-1' }]);
    const first = await prepareAdmission(own.run.id, own.project);
    recordAdmissionReceipt(first.id, 'pinned-session', 'first-delivery', first.historyKeys);
    settleRun(first.id, 'completed', 'First answer');
    updateExecution(first.id, { status: 'completed', answer: 'First answer', settled: true });
    const next = { ...own.run, id: `${own.run.id}-next`, context: [{ id: 'source-1', text: 'Already imported', from: 'peer', ts: 1 }, { id: 'source-2', text: 'New source', from: 'peer', ts: 2 }] };
    admitExecution(next);
    const input = await prepareAdmission(next.id, own.project);
    expect(input).toMatchObject({ mode: 'send', sessionId: 'pinned-session', bindingId: first.bindingId, history: [{ id: 'team:source-2', role: 'user', text: 'New source' }] });
    const { client, fetch } = transport(() => Response.json({ sessionId: 'pinned-session', deliveryId: 'next-delivery' }));
    await submitAdmission(input, client);
    expect(fetch.mock.calls[0]?.[1]?.body).toContain(`"idempotencyKey":"athena:${next.id}"`);
    expect(readBinding(input.bindingId)?.imported).toEqual(['team:source-1', 'team:source-2']);
  });

  it('records an in-flight receipt after Stop without reviving the input', async () => {
    const own = fixture();
    const input = await prepareAdmission(own.run.id, own.project);
    const { client } = transport(async () => {
      await stopEveRun(input.id);
      return Response.json({ sessionId: 'stopped-session', deliveryId: 'stopped-delivery' });
    });
    await submitAdmission(input, client);
    expect(readRun(input.id)).toMatchObject({ status: 'stopped', deliveryId: 'stopped-delivery' });
    expect(readBinding(input.bindingId)).toMatchObject({ sessionId: 'stopped-session', retired: true });
    expect(validAdmission(input.id)).toBe(false);
    prepareEveRecovery();
    expect(readRun(input.id)?.status).toBe('stopped');
  });

  it('rejects retired and deleted owners before any network call', async () => {
    const own = fixture();
    const input = await prepareAdmission(own.run.id, own.project);
    agents.remove(own.agent.id);
    expect(validAdmission(input.id)).toBe(false);
    const { client, fetch } = transport(() => Response.json({}));
    await expect(submitAdmission(input, client)).rejects.toThrow('cannot be dispatched');
    expect(fetch).not.toHaveBeenCalled();
    prepareEveRecovery();
    expect(readRun(input.id)?.status).toBe('interrupted');
  });

  it('does not dispatch a finished native run or a saved Stop', async () => {
    const own = fixture();
    await prepareAdmission(own.run.id, own.project);
    updateExecution(own.run.id, { stopRequested: true });
    expect(validAdmission(own.run.id)).toBe(false);
    const other = fixture();
    await prepareAdmission(other.run.id, other.project);
    settleRun(other.run.id, 'failed', '', 'Original failure');
    expect(validAdmission(other.run.id)).toBe(false);
  });

  it('refuses an altered payload and a receipt for another session', async () => {
    const own = fixture();
    const input = await prepareAdmission(own.run.id, own.project);
    writeJSON(privateDataPath('runtime', 'eve', 'admissions', `${input.id}.json`), { ...input, historyKeys: ['different-source'] });
    expect(() => readAdmission(input.id)).toThrow('changed');
    writeJSON(privateDataPath('runtime', 'eve', 'admissions', `${input.id}.json`), input);
    recordAdmissionReceipt(input.id, 'original-session', 'original-delivery', []);
    const { client } = transport(() => Response.json({ sessionId: 'wrong-session', deliveryId: 'wrong-delivery' }));
    await expect(submitAdmission(input, client)).rejects.toThrow('changed its binding');
    expect(readRun(input.id)?.deliveryId).toBe('original-delivery');
  });

  it('makes a permanent rejection terminal rather than retrying forever', async () => {
    const own = fixture();
    const input = await prepareAdmission(own.run.id, own.project);
    const { client } = transport(() => new Response('', { status: 400 }));
    await expect(submitAdmission(input, client)).rejects.toThrow('acknowledge');
    expect(readAdmission(input.id)?.status).toBe('cancelled');
    expect(readRun(input.id)?.status).toBe('failed');
  });

  it('starts a fresh binding after a failed turn instead of reusing an ended session', async () => {
    const own = fixture([{ type: 'assistant', text: 'Retained original' }]);
    const first = await prepareAdmission(own.run.id, own.project);
    recordAdmissionReceipt(first.id, 'failed-session', 'failed-delivery', []);
    settleRun(first.id, 'failed', '', 'The model failed.');
    updateExecution(first.id, { status: 'failed', settled: true });
    const next = { ...own.run, id: `${own.run.id}-fresh` };
    admitExecution(next);
    const input = await prepareAdmission(next.id, own.project);
    expect(input.mode).toBe('create');
    expect(input.bindingId).not.toBe(first.bindingId);
    expect(input.history.some((m) => m.text === 'Retained original')).toBe(true);
  });

  it('uses fresh bindings in a project copy and refuses the wrong pinned project', async () => {
    const own = fixture([{ type: 'user', text: 'Portable original' }]);
    const input = await prepareAdmission(own.run.id, own.project);
    const copy = await createProject({ name: 'Copy' });
    await expect(prepareAdmission(own.run.id, copy)).rejects.toThrow('project');
    await withProject(copy, async () => {
      agents.save(own.agent);
      chats.save(own.chat);
      const next = { ...own.run, id: `${own.run.id}-copy`, projectId: copy.id };
      admitExecution(next);
      const copied = await prepareAdmission(next.id, copy);
      expect(copied.bindingId).not.toBe(input.bindingId);
      expect(copied.mode).toBe('create');
      expect(copied.history[0]?.text).toBe('Portable original');
    });
  });

  it('fails oversized history and files without clipping or dropping them', async () => {
    const own = fixture([{ type: 'user', text: 'Original '.repeat(30000) }]);
    saveSettings({ contextWindowTokens: 1000 });
    await expect(prepareAdmission(own.run.id, own.project)).rejects.toThrow('No original messages were discarded');
    expect(readAdmission(own.run.id)).toBeNull();
    expect(chats.get(own.agent.id, own.chat.id)?.items[0]).toEqual(own.chat.items[0]);
    const file = path.join(newBatch().dir, 'too-big.pdf');
    fs.writeFileSync(file, Buffer.alloc(16 * 1024 * 1024 + 1));
    const big = fixture([], [file]);
    await expect(prepareAdmission(big.run.id, big.project)).rejects.toThrow('16 MB');
    expect(readAdmission(big.run.id)).toBeNull();
    fs.unlinkSync(file);
    await expect(prepareAdmission(big.run.id, big.project)).rejects.toThrow('missing');
  });
});
