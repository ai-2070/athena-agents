import { afterEach, describe, expect, it } from 'vitest';
import { activeProject, agents, bus, chats, questions, withProject } from '../../server/store.ts';
import { newAgent } from '../../server/library.ts';
import { createProject } from '../../server/projects.ts';
import { addBrief, listBriefs } from '../../server/briefs.ts';
import { admitExecution, readExecution, saveHandoff, updateExecution } from '../../server/execution.ts';
import { activeRuns, finishNativeRun, isChatBusy, nativeRunPromise, onRunEnd, recoverExecution, runInfo, stopRun } from '../../server/engines/index.ts';
import { EveCoordinator } from '../../server/eve/coordinator.ts';
import { attachSession, beginRun, bindSession, readRun, setRunStatus } from '../../server/eve/state.ts';
import { observeEveEvent } from '../../server/eve/recovery.ts';
import { projectTranscript } from '../../server/eve/transcript.ts';
import { prepareOperation, saveOperation } from '../../server/eve/operations.ts';
import { addQuestion } from '../../server/questions.ts';
import { awaitHandoff } from '../../server/handoffs.ts';
import { dataPath, writeJSON } from '../../server/util.ts';
import type { ExecutionRun, ServerEvent } from '../../shared/types.ts';
import type { SessionStreamEvent } from 'eve/client';

const coordinators: EveCoordinator[] = [];
afterEach(async () => {
  onRunEnd(null);
  for (const coordinator of coordinators.splice(0)) await coordinator.close();
  for (const run of activeRuns()) { stopRun(run.id); finishNativeRun(run.id); }
});

function fixture() {
  const project = activeProject();
  const agent = agents.save(newAgent({ name: 'Recovered native owner', toolGroups: [] }));
  const chat = chats.create(agent.id);
  const binding = bindSession(agent, chat, project, 'proof');
  attachSession(binding.id, 'session');
  const id = `follow-${agent.id}`;
  beginRun(id, binding.id);
  setRunStatus(id, 'running', 'delivery');
  const receipt: ExecutionRun = { id, projectId: project.id, agentId: agent.id, chatId: chat.id, engine: agent.engine, parentRunId: null, ownerChatId: chat.id, ownerAgentId: agent.id, depth: 0, text: 'Original user request', from: null, attachments: [], startedAt: Date.now(), status: 'running' };
  admitExecution(receipt);
  const events: SessionStreamEvent[] = [];
  let wake = () => {};
  let connections = 0;
  let stops = 0;
  let broken = false;
  let breakNext = false;
  const add = (event: Omit<SessionStreamEvent, 'meta'>) => {
    events.push({ ...event, meta: { position: { line: events.length, index: 0 }, at: new Date().toISOString() } } as SessionStreamEvent);
    wake();
  };
  add({ type: 'delivery.admitted', data: { deliveryId: 'delivery' } });
  add({ type: 'delivery.consumed', data: { deliveryId: 'delivery', turnId: 'turn', parts: [] } });
  const coordinator = new EveCoordinator({
    ready: async () => ({ url: 'http://127.0.0.1:1', token: 'fixture', exited: new Promise<void>(() => {}), close: async () => {} }),
    connect: () => {
      connections++;
      return {
        snapshot: async () => ({ events: [...events], session: { sessionId: 'session', streamIndex: events.length } }),
        stream: async function* (startIndex, signal) {
          let next = startIndex;
          while (!signal.aborted) {
            for (const event of events.filter((e) => e.meta.position.line >= next)) {
              next = event.meta.position.line + 1;
              yield event;
            }
            if (breakNext && !broken) { broken = true; throw new Error('Transport dropped'); }
            await new Promise<void>((resolve) => {
              const done = () => { signal.removeEventListener('abort', done); resolve(); };
              wake = done;
              if (signal.aborted) done();
              else signal.addEventListener('abort', done, { once: true });
            });
          }
        },
        decisions: async () => {},
        stop: async () => { stops++; },
      };
    },
    retryMs: 1,
  });
  coordinators.push(coordinator);
  const finish = (text: string) => {
    add({ type: 'content.completed', data: { partId: 'reply', runId: 'model', kind: 'text', phase: 'reply', value: text } });
    add({ type: 'turn.settled', data: { turnId: 'turn', outcome: 'completed', reply: ['reply'] } });
  };
  return { project, agent, chat, binding, id, receipt, events, add, finish, coordinator, breakStream: () => { breakNext = true; wake(); }, connections: () => connections, stops: () => stops };
}

describe('native run lifecycle', () => {
  it('restores busy ownership, reconnects without another input, and settles the saved answer and handoff once', async () => {
    const f = fixture();
    const ends: string[] = [];
    onRunEnd((event) => ends.push(event.answer));
    saveHandoff({ id: 'recovered-handle', projectId: f.project.id, from: 'asker', to: f.agent.id, toName: f.agent.name, chatId: f.chat.id, runId: f.id, task: f.receipt.text, startedAt: Date.now() });
    f.coordinator.restore();
    recoverExecution();
    expect(isChatBusy(f.chat.id)).toBe(true);
    const done = nativeRunPromise(f.id)!;
    const signal = runInfo(f.id)!.signal;
    f.coordinator.start();
    await expect.poll(f.connections).toBe(1);
    f.breakStream();
    await expect.poll(f.connections).toBe(2);
    expect(isChatBusy(f.chat.id)).toBe(true);
    expect(signal.aborted).toBe(false);
    f.finish('Recovered answer');
    expect(await done).toBe('Recovered answer');
    expect(ends).toEqual(['Recovered answer']);
    expect(readRun(f.id)).toMatchObject({ status: 'completed', answer: 'Recovered answer' });
    expect(readExecution().runs.find((run) => run.id === f.id)).toMatchObject({ status: 'completed', settled: true });
    expect(isChatBusy(f.chat.id)).toBe(false);
    expect(await awaitHandoff('recovered-handle', 'asker')).toEqual({ text: `${f.agent.name} says:\nRecovered answer` });
    f.coordinator.restore();
    expect(ends).toHaveLength(1);
    expect(chats.get(f.agent.id, f.chat.id)!.items.filter((item) => item.type === 'user')).toHaveLength(1);
  });

  it('saves Stop, aborts the restored signal and ignores late native output', async () => {
    const f = fixture();
    f.coordinator.restore();
    f.coordinator.start();
    const signal = runInfo(f.id)!.signal;
    const done = expect(nativeRunPromise(f.id)!).rejects.toThrow('Stopped');
    await expect.poll(f.connections).toBe(1);
    expect(stopRun(f.id)).toBe(true);
    expect(readRun(f.id)?.status).toBe('stopped');
    expect(signal.aborted).toBe(true);
    await done;
    f.finish('Late answer must not land');
    await expect.poll(f.stops).toBeGreaterThan(0);
    expect(chats.get(f.agent.id, f.chat.id)!.items.some((item) => item.type === 'assistant')).toBe(false);
    expect(readRun(f.id)?.status).toBe('stopped');
  });

  it('finishes a native result saved before the application callback, without opening a new transport', async () => {
    const f = fixture();
    f.finish('Already finished');
    for (const event of f.events) observeEveEvent(f.id, event);
    f.coordinator.restore();
    const done = nativeRunPromise(f.id)!;
    recoverExecution();
    const ends: string[] = [];
    onRunEnd((event) => ends.push(event.answer));
    f.coordinator.start();
    await done;
    expect(f.connections()).toBe(0);
    expect(ends).toEqual(['Already finished']);
    expect(chats.get(f.agent.id, f.chat.id)!.items.filter((item) => item.type === 'error')).toEqual([]);
  });

  it('pauses an already claimed completion callback instead of repeating uncertain follow-up effects', () => {
    const f = fixture();
    const brief = addBrief({ kind: 'agent', targetId: f.agent.id, chatId: f.chat.id, name: f.agent.name, text: f.receipt.text, ts: Date.now() });
    f.finish('Saved result');
    for (const event of f.events) observeEveEvent(f.id, event);
    updateExecution(f.id, { status: 'completed', answer: 'Saved result', completionClaimed: true });
    let ended = false;
    onRunEnd(() => { ended = true; });
    f.coordinator.restore();
    recoverExecution();
    expect(ended).toBe(false);
    expect(isChatBusy(f.chat.id)).toBe(false);
    expect(listBriefs().find((item) => item.id === brief.id)?.status).toBe('stopped');
    expect(chats.get(f.agent.id, f.chat.id)!.items.some((item) => item.type === 'error' && item.text.includes('paused'))).toBe(true);
  });

  it('pauses an unreadable native reply without publishing an empty successful answer', async () => {
    const f = fixture();
    f.add({ type: 'turn.settled', data: { turnId: 'turn', outcome: 'completed', reply: ['unresolved-part'] } });
    f.coordinator.restore();
    const done = expect(nativeRunPromise(f.id)!).rejects.toThrow('paused');
    f.coordinator.start();
    await done;
    expect(readRun(f.id)?.status).toBe('interrupted');
    expect(chats.get(f.agent.id, f.chat.id)!.items.some((item) => item.type === 'assistant')).toBe(false);
    expect(readExecution().runs.find((run) => run.id === f.id)?.status).toBe('interrupted');
  });

  it('interrupts a deleted owner instead of reconnecting forever or writing its saved chat', async () => {
    const f = fixture();
    const operation = prepareOperation({ runId: f.id, bindingId: f.binding.id, sessionId: 'session', callId: 'question', name: 'ask_user', args: { question: 'Choose' }, origin: 'builtin:ask_user', risk: 'none' });
    const question = addQuestion({ question: 'Choose', agentId: f.agent.id, chatId: f.chat.id, runId: f.id, operationId: operation.id });
    saveOperation({ ...operation, questionId: question.id, status: 'waiting' });
    f.coordinator.restore();
    const before = chats.get(f.agent.id, f.chat.id)!.items;
    const done = expect(nativeRunPromise(f.id)!).rejects.toThrow('no longer available');
    agents.remove(f.agent.id);
    f.coordinator.start();
    await done;
    expect(isChatBusy(f.chat.id)).toBe(false);
    expect(readRun(f.id)?.status).toBe('interrupted');
    expect(chats.get(f.agent.id, f.chat.id)!.items).toEqual(before);
    expect(questions.get(question.id)?.status).toBe('closed');
  });
});

describe('native transcript replay', () => {
  it('keeps complete originals and images once across the chat-save/cursor gap and project switches', async () => {
    const f = fixture();
    const full = 'original result '.repeat(4000);
    f.add({ type: 'call.requested', data: { callId: 'tool', owner: { runId: 'model' }, capability: { kind: 'tool', name: 'read_file' }, input: {} } });
    f.add({ type: 'call.settled', data: { callId: 'tool', outcome: 'completed', output: { text: full, images: ['data:image/png;base64,aW1hZ2U='] } } });
    f.finish('Full reply');
    for (const event of f.events) observeEveEvent(f.id, event);
    const published: ServerEvent[] = [];
    const hear = (event: ServerEvent) => { if (event.type === 'run' && event.runId === f.id) published.push(event); };
    bus.on('event', hear);
    try {
      projectTranscript(f.id);
      const first = chats.get(f.agent.id, f.chat.id)!;
      const tool = first.items.find((item) => item.type === 'tool');
      expect(tool?.type === 'tool' && tool.result).toBe(full);
      expect(tool?.type === 'tool' && tool.images?.[0]).toContain('/api/file?path=');
      // Simulate a crash after chat save but before the private projection receipt.
      writeJSON(dataPath('runtime', 'eve', 'runs', `${f.id}.json`), { ...readRun(f.id), projected: 0 });
      const other = await createProject({ name: 'Different active screen' });
      await withProject(other, async () => {
        projectTranscript(f.id);
        expect(chats.get(f.agent.id, f.chat.id)).toBeNull();
      });
      expect(withProject(f.project, () => chats.get(f.agent.id, f.chat.id)!.items)).toEqual(first.items);
      expect(published).toHaveLength(3);
    } finally { bus.off('event', hear); }
  });
});
