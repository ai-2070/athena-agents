// Steering a pi or oh-my-pi agent: it runs in RPC mode with its input open, so a message sent while it works
// goes in as a steer and it reads it before its next step (the chat shows it when it says it read it, as a
// user message). One sent while it writes its final answer is read right after it, in the same run. A fake
// `pi` / `omp` here speaks the RPC protocol the real CLIs do (checked against pi 1.5.0 and oh-my-pi 18.16
// with a local model).
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import type { Chat } from '../../shared/types.ts';

interface Fake {
  args: string[];
  inputs: { id?: string; type: string; message?: string; cancelled?: boolean }[];
  out: (o: object) => void;
  ended: boolean;
}
const fake = vi.hoisted(() => ({ procs: [] as Fake[] }));
vi.mock('../../server/util.ts', async (orig) => {
  const real = await orig<typeof import('../../server/util.ts')>();
  return {
    ...real,
    which: (cmd: string) => (cmd === 'pi' || cmd === 'omp' ? `/usr/bin/${cmd}` : real.which(cmd)),
    killTree: (child: ChildProcess) => {
      (child.stdout as PassThrough | null)?.end();
      (child.stderr as PassThrough | null)?.end();
    },
    spawnCommand: (cmd: string, args: string[], opts: unknown) => {
      if (cmd !== 'pi' && cmd !== 'omp') return real.spawnCommand(cmd, args, opts as Parameters<typeof real.spawnCommand>[2]);
      const child = new EventEmitter() as ChildProcess & EventEmitter;
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const stdin = new PassThrough();
      Object.assign(child, { stdout, stderr, stdin, exitCode: null, pid: 0 });
      const p: Fake = { args, inputs: [], out: (o) => stdout.write(`${JSON.stringify(o)}\n`), ended: false };
      fake.procs.push(p);
      let buf = '';
      stdin.on('data', (d: Buffer) => {
        buf += String(d);
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
          p.inputs.push(JSON.parse(buf.slice(0, nl)) as Fake['inputs'][number]);
          buf = buf.slice(nl + 1);
        }
      });
      // its input closed: it exits
      stdin.on('finish', () => {
        p.ended = true;
        stdout.end();
        stderr.end();
      });
      stdout.on('end', () => setImmediate(() => child.emit('close', 0)));
      return child;
    },
  };
});

const { newAgent } = await import('../../server/library.ts');
const { chats } = await import('../../server/store.ts');
const { activeRuns, queuedMessages, startRun, steerChat } = await import('../../server/engines/index.ts');
const pi = await import('../../server/engines/pi.ts');

const until = async (ok: () => boolean, ms = 5000) => {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (ok()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('timed out');
};
const idle = (chat: Chat) => !activeRuns().some((r) => r.chatId === chat.id);
const said = (chat: Chat) => chat.items.flatMap((i) => (i.type === 'user' || i.type === 'steer' || i.type === 'assistant' || i.type === 'error' ? [`${i.type}: ${i.text}`] : i.type === 'tool' ? [`tool: ${i.name}`] : []));
// what pi prints: a user message as it reads it, its words, a tool call and result, the run's end
const user = (text: string) => ({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text }] } });
const says = (text: string) => ({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop', usage: { input: 3, output: 2, totalTokens: 5 } } });
const tool = (id: string) => ({ type: 'tool_execution_start', toolCallId: id, toolName: 'bash', args: { command: 'sleep 8' } });
const toolDone = (id: string) => ({ type: 'tool_execution_end', toolCallId: id, toolName: 'bash', result: { content: [{ type: 'text', text: 'slept' }] } });
const settled = [{ type: 'agent_end' }, { type: 'agent_settled' }];

async function start(name: string) {
  const a = newAgent({ name, engine: 'pi', toolGroups: [] });
  const chat = chats.create(a.id);
  fake.procs.length = 0;
  const { runId, promise } = startRun(a, chat, 'do the long job');
  await until(() => fake.procs[0]?.inputs.length === 1);
  const p = fake.procs[0]!;
  p.out({ type: 'response', id: 'prompt', command: 'prompt', success: true, data: { disposition: 'started' } });
  p.out({ type: 'agent_start' });
  p.out(user(p.inputs[0]!.message!));
  return { a, chat, runId, promise, p };
}

describe('steering a pi agent', () => {
  it('sends its message as an RPC prompt', async () => {
    const { p, promise } = await start('Prompt');
    expect(p.args).toEqual(expect.arrayContaining(['--mode', 'rpc']));
    expect(p.inputs[0]).toEqual({ id: 'prompt', type: 'prompt', message: 'do the long job' });
    p.out(says('Done.'));
    for (const e of settled) p.out(e);
    expect(await promise).toBe('Done.');
    expect(p.ended).toBe(true);
  });

  it('a message while it works goes in as a steer: the same run reads it before its next step', async () => {
    const { a, chat, runId, promise, p } = await start('Joiner');
    p.out(tool('t1'));
    await until(() => chat.items.some((i) => i.type === 'tool'));
    const steered = await steerChat(a, chat, 'also make it blue');
    expect(steered.runId).toBe(runId);
    await until(() => p.inputs.length === 2);
    expect(p.inputs[1]).toEqual({ id: `steer-${steered.steerId}`, type: 'steer', message: 'also make it blue' });
    // (shown once pi says it read it; until then it waits first in the queue, marked as sent)
    expect(chat.items.some((i) => i.type === 'steer')).toBe(false);
    expect(queuedMessages(chat.id)).toEqual([expect.objectContaining({ id: steered.steerId, reading: runId })]);
    p.out(toolDone('t1'));
    p.out(user('also make it blue'));
    await until(() => !queuedMessages(chat.id).length);
    p.out(says('Done, and it is blue.'));
    for (const e of settled) p.out(e);
    expect(await promise).toBe('Done, and it is blue.');
    await until(() => idle(chat));
    expect(said(chat)).toEqual(['user: do the long job', 'tool: bash', 'steer: also make it blue', 'assistant: Done, and it is blue.']);
    expect(fake.procs).toHaveLength(1);
  });

  it('one sent while it writes its final answer: read right after it, in the same run, and both answers come back', async () => {
    const { a, chat, promise, p } = await start('Late');
    p.out({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Answer one.' } });
    await until(() => chat.items.some((i) => i.type === 'assistant'));
    await steerChat(a, chat, 'and a summary');
    await until(() => p.inputs.length === 2);
    p.out(says('Answer one.'));
    p.out(user('and a summary'));
    p.out(says('Answer two.'));
    for (const e of settled) p.out(e);
    expect(await promise).toBe('Answer one.\n\nAnswer two.');
    await until(() => idle(chat));
    expect(said(chat)).toEqual(['user: do the long job', 'assistant: Answer one.', 'steer: and a summary', 'assistant: Answer two.']);
  });

  it('one it refuses goes next, as its own message', async () => {
    const { a, chat, promise, p } = await start('Refused');
    p.out(tool('t1'));
    const steered = await steerChat(a, chat, 'the one it refused');
    await until(() => p.inputs.length === 2);
    p.out({ type: 'response', id: `steer-${steered.steerId}`, command: 'steer', success: false, error: 'Extension commands cannot be queued (say)' });
    p.out(toolDone('t1'));
    p.out(says('Done.'));
    for (const e of settled) p.out(e);
    await promise;
    // (a new pi, started with it)
    await until(() => fake.procs.length === 2 && fake.procs[1]!.inputs.length === 1);
    expect(fake.procs[1]!.inputs[0]).toMatchObject({ type: 'prompt', message: 'the one it refused' });
    const q = fake.procs[1]!;
    q.out(user('the one it refused'));
    q.out(says('Ran it.'));
    for (const e of settled) q.out(e);
    await until(() => idle(chat) && said(chats.get(a.id, chat.id)!).length === 5);
    expect(said(chats.get(a.id, chat.id)!)).toEqual(['user: do the long job', 'tool: bash', 'assistant: Done.', 'user: the one it refused', 'assistant: Ran it.']);
  });

  it("an extension's question gets no answer from anyone (as without a screen); its notes are ignored", async () => {
    const { promise, p } = await start('Asked');
    p.out({ type: 'extension_ui_request', id: 'q1', method: 'confirm', title: 'Allow?' });
    p.out({ type: 'extension_ui_request', id: 'q2', method: 'notify', message: 'hello' });
    await until(() => p.inputs.length === 2);
    expect(p.inputs[1]).toEqual({ type: 'extension_ui_response', id: 'q1', cancelled: true });
    p.out(says('Done.'));
    for (const e of settled) p.out(e);
    await promise;
    expect(p.inputs).toHaveLength(2);
  });

  it('a prompt it refuses fails the run with why', async () => {
    const { chat, promise, p } = await start('Rejected');
    p.out({ type: 'response', id: 'prompt', command: 'prompt', success: false, error: 'No model selected' });
    await promise;
    expect(p.ended).toBe(true);
    expect(said(chat).at(-1)).toBe('error: pi refused the message: No model selected');
  });

  it('a run that ends but never says it settled: its input closes anyway', async () => {
    const wait = pi.SETTLE_WAIT.ms;
    pi.SETTLE_WAIT.ms = 50;
    try {
      const { promise, p } = await start('Unsettled');
      p.out(says('Done.'));
      p.out({ type: 'agent_end' });
      expect(await promise).toBe('Done.');
      expect(p.ended).toBe(true);
    } finally {
      pi.SETTLE_WAIT.ms = wait;
    }
  });

  it('once it has settled, it reads no more: a message then goes the ordinary way', async () => {
    const { runId, promise, p } = await start('Done');
    expect(pi.steer.can(runId)).toBe(true);
    p.out(says('All done.'));
    for (const e of settled) p.out(e);
    await promise;
    expect(pi.steer.can(runId)).toBe(false);
    await expect(pi.steer.send(runId, { id: 's1', text: 'too late' })).rejects.toThrow('no longer reading');
  });
});

describe('steering an oh-my-pi agent', () => {
  it('the same: a message while it works goes in as a steer and shows where it read it; it settles with session_settled', async () => {
    const a = newAgent({ name: 'Omp', engine: 'omp', toolGroups: [] });
    const chat = chats.create(a.id);
    fake.procs.length = 0;
    const { runId, promise } = startRun(a, chat, 'do the long job');
    await until(() => fake.procs[0]?.inputs.length === 2);
    const p = fake.procs[0]!;
    // (its prompt, then which session it named)
    expect(p.inputs).toEqual([{ id: 'prompt', type: 'prompt', message: 'do the long job' }, { id: 'state', type: 'get_state' }]);
    p.out({ type: 'ready', protocolVersion: 1 });
    p.out({ type: 'response', id: 'prompt', command: 'prompt', success: true });
    p.out({ type: 'response', id: 'state', command: 'get_state', success: true, data: { sessionId: 'omp-session' } });
    p.out(user('do the long job'));
    p.out(tool('t1'));
    await until(() => chat.items.some((i) => i.type === 'tool'));
    expect(chat.sessionId).toBe('omp-session');
    const steered = await steerChat(a, chat, 'also make it blue');
    expect(steered.runId).toBe(runId);
    await until(() => p.inputs.length === 3);
    expect(p.inputs[2]).toEqual({ id: `steer-${steered.steerId}`, type: 'steer', message: 'also make it blue' });
    // (its own kind of question: no answer from anyone)
    p.out({ type: 'extension_ui_request', id: 'q1', method: 'ask', questions: [] });
    await until(() => p.inputs.length === 4);
    expect(p.inputs[3]).toEqual({ type: 'extension_ui_response', id: 'q1', cancelled: true });
    p.out(toolDone('t1'));
    p.out(user('also make it blue'));
    p.out(says('Done, and it is blue.'));
    p.out({ type: 'agent_end' });
    p.out({ type: 'prompt_result', id: 'prompt', status: 'completed', sessionSettled: true });
    p.out({ type: 'session_settled' });
    expect(await promise).toBe('Done, and it is blue.');
    expect(p.ended).toBe(true);
    await until(() => idle(chat));
    expect(said(chat)).toEqual(['user: do the long job', 'tool: bash', 'steer: also make it blue', 'assistant: Done, and it is blue.']);
  });
});
