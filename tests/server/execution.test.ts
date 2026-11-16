import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawnSync } from 'node:child_process';
import { beforeEach, describe, expect, it } from 'vitest';
import { activeProject, chats, saveSettings, withProject } from '../../server/store.ts';
import { newAgent } from '../../server/library.ts';
import { createProject } from '../../server/projects.ts';
import {
  admitExecution,
  interruptExecutions,
  readExecution,
  saveExecutionQueue,
  saveHandoff,
  updateExecution,
} from '../../server/execution.ts';
import { activeRuns, queuedMessages, recoverExecution, startRun, stopChat } from '../../server/engines/index.ts';
import { awaitHandoff, listHandoffs } from '../../server/handoffs.ts';
import { RESUME_TEXT, resumeInChat, stopBrain } from '../../server/commands.ts';
import { privateDataPath } from '../../server/private.ts';
import { dataPath } from '../../server/util.ts';
import type { ExecutionQueue, ExecutionRun } from '../../shared/types.ts';

beforeEach(() => {
  fs.rmSync(privateDataPath('runtime', 'execution.json'), { force: true });
  recoverExecution();
});

function fixture() {
  const project = activeProject();
  const agent = newAgent({ name: 'Saved work', engine: 'eve', toolGroups: [] });
  const chat = chats.create(agent.id);
  const run: ExecutionRun = {
    id: `run-${agent.id}`,
    projectId: project.id,
    agentId: agent.id,
    chatId: chat.id,
    engine: agent.engine,
    parentRunId: null,
    ownerChatId: chat.id,
    ownerAgentId: agent.id,
    depth: 0,
    text: 'Do the first job',
    from: null,
    attachments: [],
    startedAt: Date.now(),
    status: 'running',
  };
  const queue: ExecutionQueue = {
    projectId: project.id,
    agentId: agent.id,
    chatId: chat.id,
    items: [{ id: 'next', text: 'Do the next job', from: 'The Brain', attachments: ['notes.txt'], ts: Date.now() }],
    priority: [],
    paused: false,
  };
  return { project, agent, chat, run, queue };
}

describe('saved input admission', () => {
  it('claims a queued input and its run in one write; repeated admission cannot submit it again', () => {
    const { run, queue } = fixture();
    saveExecutionQueue(queue);
    const input = queue.items[0]!;
    const claimed = { ...run, text: input.text, from: input.from!, attachments: input.attachments! };
    admitExecution(claimed, input.id);
    expect(readExecution().queues).toEqual([]);
    expect(readExecution().runs).toEqual([claimed]);
    expect(() => admitExecution({ ...claimed, id: 'duplicate' }, input.id)).toThrow('saved work');
    expect(() => admitExecution(claimed, input.id)).toThrow('already has a run');
    expect(readExecution().runs).toHaveLength(1);
  });

  it('refuses an edited or cancelled input without consuming it or starting a run', () => {
    const { run, queue } = fixture();
    saveExecutionQueue(queue);
    expect(() => admitExecution(run, 'next')).toThrow('changed');
    expect(readExecution().queues[0]?.items).toEqual(queue.items);
    expect(readExecution().runs).toEqual([]);
    saveExecutionQueue({ ...queue, items: [] });
    expect(() => admitExecution(run, 'next')).toThrow('no longer next');
  });

  it('restores a claimed input that crashed before chat save, once, with its full team context', () => {
    const { project, agent, chat, run, queue } = fixture();
    saveExecutionQueue(queue);
    admitExecution({
      ...run,
      context: [{ id: 'original-message', text: 'Original context', from: 'Teammate', ts: 123 }],
    });
    recoverExecution();
    recoverExecution();
    const items = chats.get(agent.id, chat.id)!.items;
    expect(items.filter((item) => item.type === 'user').map((item) => item.text)).toEqual([
      'Original context',
      run.text,
    ]);
    expect(items.filter((item) => item.type === 'error')).toHaveLength(1);
    expect(readExecution().runs[0]).toMatchObject({ status: 'interrupted', settled: true });
    expect(queuedMessages(chat.id, project.id)).toEqual(queue.items);
    expect(readExecution().queues[0]?.paused).toBe(true);
    stopChat(chat.id, project.id);
    expect(readExecution().queues).toEqual([]);
    recoverExecution();
    expect(queuedMessages(chat.id, project.id)).toEqual([]);
  });

  it('saves live queues and steering before a process ends, then restores their order without executing them', () => {
    // The child has its own engine maps and exits without callbacks, as at a crash boundary.
    const script = `
      import { newAgent } from './server/library.ts';
      import { chats, activeProject } from './server/store.ts';
      import { startRun, queueMessage, editQueued, steerChat, queuedMessages } from './server/engines/index.ts';
      const agent = newAgent({name:'Crash boundary',engine:'eve',provider:'custom',model:'mock',toolGroups:[]});
      const chat = chats.create(agent.id);
      startRun(agent, chat, 'first job');
      const next = queueMessage(agent, chat, 'second job');
      if ('queued' in next) editQueued(chat.id, next.queued.id, 'edited second job');
      queueMessage(agent, chat, 'third job', ['notes.txt'], {from:'The Brain'});
      void steerChat(agent, chat, 'new direction', {waitMs:10000});
      await Promise.resolve();
      console.log(JSON.stringify({projectId:activeProject().id,agentId:agent.id,chatId:chat.id,queue:queuedMessages(chat.id)}));
      process.exit(0);
    `;
    const child = spawnSync('bun', ['--eval', script], { encoding: 'utf8', env: process.env, timeout: 15000 });
    expect(child.status, child.stderr).toBe(0);
    const saved = JSON.parse(child.stdout.trim()) as {
      projectId: string;
      agentId: string;
      chatId: string;
      queue: ExecutionQueue['items'];
    };
    expect(saved.queue.map((q) => q.text)).toEqual(['new direction', 'edited second job', 'third job']);
    recoverExecution();
    expect(queuedMessages(saved.chatId, saved.projectId)).toEqual(saved.queue);
    expect(readExecution().runs[0]).toMatchObject({ status: 'interrupted', steered: true, stopRequested: true });
    expect(chats.get(saved.agentId, saved.chatId)!.items.filter((item) => item.type === 'user')).toHaveLength(1);
    expect(readExecution().queues[0]?.paused).toBe(true);
  });

  it('a message a run had been sent but not read before a restart is an ordinary queued message after it', () => {
    const { project, chat, queue } = fixture();
    const sent = { id: 's-sent', text: 'and a summary', ts: Date.now(), reading: 'run-gone' };
    saveExecutionQueue({ ...queue, items: [sent, ...queue.items], priority: [sent.id] });
    recoverExecution();
    const [first, ...rest] = queuedMessages(chat.id, project.id);
    expect(first).toEqual({ id: 's-sent', text: 'and a summary', ts: sent.ts });
    expect(rest).toEqual(queue.items);
  });

  it('keeps a saved Stop final even if the process ends before it removes queued work', () => {
    const { run, queue } = fixture();
    saveExecutionQueue(queue);
    admitExecution(run);
    updateExecution(run.id, { stopRequested: true });
    recoverExecution();
    expect(readExecution().runs[0]?.status).toBe('stopped');
    expect(queuedMessages(run.chatId)).toEqual([]);
  });

  it('reserves native work for the Eve coordinator and does not admit another run in that chat', () => {
    const { run, queue } = fixture();
    saveExecutionQueue(queue);
    admitExecution(run);
    expect(interruptExecutions(new Set([run.id]))).toEqual([]);
    expect(readExecution().runs[0]?.status).toBe('running');
    expect(readExecution().queues[0]?.paused).toBe(false);
    expect(() => admitExecution({ ...run, id: 'overlap' })).toThrow('saved work');
  });

  it.each(['message', 'resume'])(
    'keeps the old input paused and sends saved inputs once after continuing (%s)',
    async (mode) => {
      const { agent, chat, run, queue } = fixture();
      const asked: string[] = [];
      const model = http.createServer(async (req, res) => {
        if (req.url?.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'mock' }] }));
        let body = '';
        for await (const chunk of req) body += chunk;
        const input = JSON.parse(body) as { messages: { content: string }[] };
        asked.push(input.messages.at(-1)!.content);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Done' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
        );
      });
      await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve));
      try {
        saveSettings({
          providers: {
            custom: { baseUrl: `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`, label: 'Fake model' },
          },
        });
        agent.provider = 'custom';
        agent.model = 'mock';
        // Queued work re-reads the saved agent.
        const { agents } = await import('../../server/store.ts');
        agents.save(agent);
        saveExecutionQueue({ ...queue, items: [{ ...queue.items[0]!, attachments: [] }] });
        admitExecution(run);
        recoverExecution();
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(asked).toEqual([]);
        const next = mode === 'resume' ? RESUME_TEXT : 'Continue after checking';
        if (mode === 'resume') resumeInChat(agent.id, chat.id);
        else await startRun(agent, chats.get(agent.id, chat.id)!, next).promise;
        for (const until = Date.now() + 5000; Date.now() < until && activeRuns().length;)
          await new Promise((resolve) => setTimeout(resolve, 10));
        expect(activeRuns()).toEqual([]);
        expect(asked).toHaveLength(2);
        expect(asked[0]).toContain(next);
        expect(asked[1]).toContain('Do the next job');
        expect(
          chats
            .get(agent.id, chat.id)!
            .items.filter((item) => item.type === 'user')
            .map((item) => item.text),
        ).toEqual([run.text, next, 'Do the next job']);
        expect(queuedMessages(chat.id)).toEqual([]);
      } finally {
        stopChat(chat.id);
        await new Promise<void>((resolve) => model.close(() => resolve()));
      }
    },
  );
});

describe('saved Stop commands', () => {
  it('takes back a paused agent queue from the Brain Stop command', () => {
    const { agent, chat, run, queue } = fixture();
    saveExecutionQueue(queue);
    admitExecution(run);
    recoverExecution();
    expect(stopBrain({ chats: [{ agentId: agent.id, chatId: chat.id }] }).stopped).toContain(agent.name);
    expect(queuedMessages(chat.id)).toEqual([]);
  });
});

describe('Clear memory pressed while a turn worked, then a restart', () => {
  it('still clears the memory, so what came after it stays out of the next session', async () => {
    const { memoryStart } = await import('../../shared/context.ts');
    const { run, chat } = fixture();
    admitExecution(run);
    updateExecution(run.id, { clearMemoryOnEnd: true });
    chat.items.push({ type: 'assistant', text: 'written after the reset' });
    chat.sessionId = 'cli-session';
    chats.save(chat);
    recoverExecution();
    const saved = chats.get(chat.agentId, chat.id)!;
    expect(saved.items.some((i) => i.type === 'meta' && i.sourceId === `reset:${run.id}`)).toBe(true);
    expect(memoryStart(saved.items)).toBe(saved.items.length);
    expect(saved.sessionId).toBeNull();
  });
});

describe('a message read just before a restart', () => {
  it('is sent again only if the chat does not show it as read', () => {
    const { project, chat, agent, queue } = fixture();
    // the chat saved the message as read in the turn; the server ended before it left the queue
    chat.items.push({ type: 'steer', steerId: 'read-one', text: 'Also do this', runId: 'gone-run' });
    chats.save(chat);
    saveExecutionQueue({
      ...queue,
      items: [
        { id: 'read-one', text: 'Also do this', ts: Date.now(), reading: 'gone-run' },
        { id: 'unread-one', text: 'And this', ts: Date.now(), reading: 'gone-run' },
      ],
    });
    recoverExecution();
    expect(queuedMessages(chat.id, project.id).map((q) => q.id)).toEqual(['unread-one']);
    expect(agent.id).toBeTruthy();
  });
});

describe('saved delegation handles', () => {
  it('collects a completed child after losing its callback, and never runs an interrupted task again', async () => {
    const { run } = fixture();
    const handle = {
      id: 'saved-handle',
      from: 'asker',
      projectId: run.projectId,
      to: run.agentId,
      toName: 'Helper',
      chatId: run.chatId,
      runId: run.id,
      task: run.text,
      startedAt: run.startedAt,
    };
    saveHandoff(handle);
    admitExecution(run);
    updateExecution(run.id, { status: 'completed', answer: 'Saved answer', endedAt: Date.now() });
    recoverExecution();
    expect(await awaitHandoff(handle.id, 'asker')).toEqual({ text: 'Helper says:\nSaved answer' });
    expect(await awaitHandoff(handle.id, 'intruder')).toMatchObject({ isError: true });
    const other = fixture();
    saveHandoff({ ...handle, id: 'interrupted-handle', runId: other.run.id });
    admitExecution(other.run);
    recoverExecution();
    expect(await awaitHandoff('interrupted-handle', 'asker')).toMatchObject({
      isError: true,
      text: expect.stringContaining('restarted'),
    });
    expect(readExecution().runs).toHaveLength(2);
  });

  it('keeps handles and queues in their original project, including after a project copy', async () => {
    const { project, run, queue } = fixture();
    saveExecutionQueue(queue);
    saveHandoff({
      id: 'private-handle',
      from: 'asker',
      projectId: project.id,
      to: run.agentId,
      toName: 'Helper',
      chatId: run.chatId,
      runId: run.id,
      task: run.text,
      startedAt: run.startedAt,
      endedAt: Date.now(),
      answer: 'Private answer',
    });
    const other = await createProject({ name: 'Other saved work' });
    recoverExecution();
    await withProject(other, async () => {
      expect(listHandoffs('asker')).toContain('no handoffs');
      expect((await awaitHandoff('private-handle', 'asker')).isError).toBe(true);
      expect(queuedMessages(run.chatId)).toEqual([]);
    });
    expect(withProject(project, () => listHandoffs('asker'))).toContain('answer ready');
    expect(queuedMessages(run.chatId, project.id)).toEqual(queue.items);
    expect(fs.existsSync(dataPath('projects', project.id, 'runtime', 'execution.json'))).toBe(false);
  });
});
