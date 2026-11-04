// Steering a Claude Code agent: its input stays open while it works, so a message sent meanwhile goes in
// and Claude reads it at its next step (the chat shows it when Claude says it read it). One sent while it
// writes its final answer: Claude answers it as one more turn of the same run. A fake `claude` here speaks
// the stream-json protocol the real CLI does (checked against Claude Code 2.1).
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import type { Chat } from '../../shared/types.ts';

interface Fake {
  args: string[];
  inputs: { uuid: string; content: string }[];
  out: (o: object) => void;
  ended: boolean;
}
const fake = vi.hoisted(() => ({ procs: [] as Fake[] }));
vi.mock('../../server/util.ts', async (orig) => {
  const real = await orig<typeof import('../../server/util.ts')>();
  return {
    ...real,
    which: (cmd: string) => (cmd === 'claude' ? '/usr/bin/claude' : real.which(cmd)),
    killTree: (child: ChildProcess) => {
      (child.stdout as PassThrough | null)?.end();
      (child.stderr as PassThrough | null)?.end();
    },
    spawnCommand: (cmd: string, args: string[]) => {
      if (cmd !== 'claude') return real.spawnCommand(cmd, args);
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
          const m = JSON.parse(buf.slice(0, nl)) as { uuid: string; message: { content: string } };
          buf = buf.slice(nl + 1);
          p.inputs.push({ uuid: m.uuid, content: m.message.content });
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
const { activeRuns, joinChatTurn, missedMessages, queuedMessages, startRun, steerChat, stopRun } = await import('../../server/engines/index.ts');
const claude = await import('../../server/engines/claude.ts');

const until = async (ok: () => boolean, ms = 5000) => {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (ok()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('timed out');
};
const idle = (chat: Chat) => !activeRuns().some((r) => r.chatId === chat.id);
const said = (chat: Chat) => chat.items.flatMap((i) => (i.type === 'user' || i.type === 'steer' || i.type === 'assistant' || i.type === 'error' ? [`${i.type}: ${i.text}`] : i.type === 'tool' ? [`tool: ${i.name}`] : []));
// what the CLI prints: its start, a message echoed as it reads it, its words, a tool call and result, the turn's end
const init = { type: 'system', subtype: 'init', session_id: 'claude-session' };
const echo = (input: { uuid: string; content: string }) => ({ type: 'user', isReplay: true, uuid: input.uuid, message: { role: 'user', content: input.content } });
const says = (id: string, text: string) => ({ type: 'assistant', message: { id, content: [{ type: 'text', text }] } });
const result = (text: string, cost: number, cacheRead: number) => ({ type: 'result', subtype: 'success', result: text, is_error: false, total_cost_usd: cost, usage: { cache_read_input_tokens: cacheRead } });

async function start(name: string, depth = 0) {
  const a = newAgent({ name, engine: 'claude-code', toolGroups: [] });
  const chat = chats.create(a.id);
  fake.procs.length = 0;
  const { runId, promise } = startRun(a, chat, 'do the long job', { depth });
  await until(() => fake.procs[0]?.inputs.length === 1);
  const p = fake.procs[0]!;
  p.out(init);
  p.out(echo(p.inputs[0]!));
  return { a, chat, runId, promise, p };
}

describe('steering a Claude Code agent', () => {
  it('reads its messages as JSON lines and echoes each as it reads it', () => {
    const args = claude.claudeArgs(newAgent({ name: 'Args', engine: 'claude-code' }), { promptFile: 'p.md', mcpFile: 'm.json' });
    expect(args).toEqual(expect.arrayContaining(['--input-format', 'stream-json', '--replay-user-messages']));
  });

  it('a message while it works goes into the turn: the same run reads it at its next step', async () => {
    const { a, chat, runId, promise, p } = await start('Joiner');
    p.out({ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'sleep 8' } }] } });
    await until(() => chat.items.some((i) => i.type === 'tool'));
    const steered = await steerChat(a, chat, 'also make it blue');
    expect(steered.runId).toBe(runId);
    expect(steered.steerId).toBeTruthy();
    await until(() => p.inputs.length === 2);
    expect(p.inputs[1]!.content).toBe('also make it blue');
    // (shown once Claude says it read it, where it read it; until then it waits first in the queue, marked as sent)
    expect(chat.items.some((i) => i.type === 'steer')).toBe(false);
    expect(queuedMessages(chat.id)).toEqual([expect.objectContaining({ id: steered.steerId, text: 'also make it blue', reading: runId })]);
    p.out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'slept' }] } });
    p.out(echo(p.inputs[1]!));
    await until(() => !queuedMessages(chat.id).length);
    p.out(says('m2', 'Done, and it is blue.'));
    p.out(result('Done, and it is blue.', 0.01, 100));
    expect(await promise).toBe('Done, and it is blue.');
    await until(() => idle(chat));
    expect(p.ended).toBe(true);
    expect(said(chat)).toEqual(['user: do the long job', 'tool: Bash', 'steer: also make it blue', 'assistant: Done, and it is blue.']);
    expect(chat.items.find((i) => i.type === 'steer')).toMatchObject({ steerId: steered.steerId, runId });
    expect(fake.procs).toHaveLength(1);
  });

  it('one sent while it writes its final answer: it answers that too, as one more turn of the same run', async () => {
    const { a, chat, runId, promise, p } = await start('Late');
    p.out(says('m1', 'Answer one.'));
    await until(() => chat.items.some((i) => i.type === 'assistant'));
    expect((await steerChat(a, chat, 'and a summary')).runId).toBe(runId);
    await until(() => p.inputs.length === 2);
    // its first answer ends with your message unread: its input stays open for the turn that reads it
    p.out(result('Answer one.', 0.01, 100));
    await new Promise((r) => setTimeout(r, 30));
    expect(p.ended).toBe(false);
    p.out(init);
    p.out(echo(p.inputs[1]!));
    p.out(says('m2', 'Answer two.'));
    p.out(result('Answer two.', 0.03, 50));
    // (the run's answer is both turns': a team or agent waiting on it gets the first one too)
    expect(await promise).toBe('Answer one.\n\nAnswer two.');
    await until(() => idle(chat));
    expect(said(chat)).toEqual(['user: do the long job', 'assistant: Answer one.', 'steer: and a summary', 'assistant: Answer two.']);
  });

  it('one echo for messages that waited together: each shows as read', async () => {
    const { a, chat, promise, p } = await start('Together');
    p.out({ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'sleep 8' } }] } });
    await steerChat(a, chat, 'make it blue');
    await steerChat(a, chat, 'and round');
    await until(() => p.inputs.length === 3);
    p.out({ type: 'user', isReplay: true, uuid: p.inputs[1]!.uuid, message: { role: 'user', content: 'make it blue\nand round' } });
    p.out(says('m2', 'Blue and round.'));
    p.out(result('Blue and round.', 0, 0));
    await promise;
    await until(() => idle(chat));
    expect(said(chat)).toEqual(['user: do the long job', 'tool: Bash', 'steer: make it blue', 'steer: and round', 'assistant: Blue and round.']);
    expect(queuedMessages(chat.id)).toEqual([]);
    expect(fake.procs).toHaveLength(1);
  });

  it('one it never says it read: its input closes once it is quiet, and the message goes next as its own turn', async () => {
    const wait = claude.READ_WAIT.ms;
    claude.READ_WAIT.ms = 50;
    try {
      const { a, chat, promise, p } = await start('Unread');
      await steerChat(a, chat, 'and a summary');
      await until(() => p.inputs.length === 2);
      p.out(says('m1', 'Answer one.'));
      p.out(result('Answer one.', 0, 0));
      // (no echo, no new turn: it isn't going to read it)
      expect(await promise).toBe('Answer one.');
      expect(p.ended).toBe(true);
      await until(() => fake.procs.length === 2 && fake.procs[1]!.inputs.length === 1);
      const q = fake.procs[1]!;
      expect(q.inputs[0]!.content).toContain('and a summary');
      q.out(init);
      q.out(echo(q.inputs[0]!));
      q.out(says('m2', 'The summary.'));
      q.out(result('The summary.', 0, 0));
      // (the queued turn reads the chat afresh)
      await until(() => idle(chat) && said(chats.get(a.id, chat.id)!).length === 4);
      expect(said(chats.get(a.id, chat.id)!)).toEqual(['user: do the long job', 'assistant: Answer one.', 'user: and a summary', 'assistant: The summary.']);
    } finally {
      claude.READ_WAIT.ms = wait;
    }
  });

  it('Stop before it read one: the message is given back with the queue, not lost or sent', async () => {
    const { a, chat, runId, promise, p } = await start('Stopped');
    await steerChat(a, chat, 'never mind that');
    await until(() => p.inputs.length === 2);
    expect(queuedMessages(chat.id)).toHaveLength(1);
    stopRun(runId);
    await promise.catch(() => {});
    await until(() => idle(chat));
    expect(queuedMessages(chat.id)).toEqual([]);
    expect(fake.procs).toHaveLength(1);
  });

  it("in a team's turn, one it never read comes back to the team to send again", async () => {
    const wait = claude.READ_WAIT.ms;
    claude.READ_WAIT.ms = 50;
    try {
      const { chat, runId, promise, p } = await start('Member', 1);
      expect(await joinChatTurn(chat.id, { text: 'You (the user): and a summary', teamMessageId: 'm-late' })).toBe(true);
      await until(() => p.inputs.length === 2);
      // (a team's message waits in the team, not in the member's own queue)
      expect(queuedMessages(chat.id)).toEqual([]);
      p.out(says('m1', 'The report.'));
      p.out(result('The report.', 0, 0));
      expect(await promise).toBe('The report.');
      expect(await missedMessages(runId)).toEqual([{ teamMessageId: 'm-late' }]);
      expect(await missedMessages(runId)).toEqual([]);
    } finally {
      claude.READ_WAIT.ms = wait;
    }
  });

  it('once it has answered and nothing waits, it reads no more: a message then goes the ordinary way', async () => {
    const { runId, promise, p } = await start('Done');
    expect(claude.steer.can(runId)).toBe(true);
    p.out(says('m1', 'All done.'));
    p.out(result('All done.', 0, 0));
    await promise;
    expect(p.ended).toBe(true);
    expect(claude.steer.can(runId)).toBe(false);
    await expect(claude.steer.send(runId, { id: 's1', text: 'too late' })).rejects.toThrow('no longer reading');
  });
});
