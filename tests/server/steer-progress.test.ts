// Steering keeps a turn's progress: a command-line agent (pi here) stopped partway keeps its own
// session, and its next turn is told it was cut off, so it builds on what it did instead of starting over.
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import type { Chat } from '../../shared/types.ts';

// a fake pi: each start says something, then either answers or keeps working until it is killed
type Mode = 'hang' | 'silent' | 'answer';
const fake = vi.hoisted(() => ({ modes: [] as Mode[], calls: [] as { args: string[]; input: string }[] }));
vi.mock('../../server/util.ts', async (orig) => {
  const real = await orig<typeof import('../../server/util.ts')>();
  const line = (o: object) => `${JSON.stringify(o)}\n`;
  return {
    ...real,
    which: (cmd: string) => (cmd === 'pi' ? '/usr/bin/pi' : real.which(cmd)),
    // (the fake's streams are PassThroughs: ending them is pi exiting)
    killTree: (child: ChildProcess) => {
      (child.stdout as PassThrough | null)?.end();
      (child.stderr as PassThrough | null)?.end();
    },
    spawnCommand: (_cmd: string, args: string[]) => {
      const child = new EventEmitter() as ChildProcess & EventEmitter;
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const stdin = new PassThrough();
      Object.assign(child, { stdout, stderr, stdin, exitCode: null, pid: 0 });
      const call = { args, input: '' };
      fake.calls.push(call);
      const mode = fake.modes.shift() || 'answer';
      stdin.on('data', (d: Buffer) => (call.input += String(d)));
      stdin.on('finish', () => {
        if (mode === 'silent') return;
        stdout.write(line({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: mode === 'hang' ? 'Working on the long one' : 'Switched.' } }));
        if (mode === 'hang') return;
        stdout.write(line({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Switched.' }], stopReason: 'stop' } }));
        stdout.end();
        stderr.end();
      });
      stdout.on('end', () => setImmediate(() => child.emit('close', mode === 'answer' ? 0 : null)));
      return child;
    },
  };
});

const { newAgent } = await import('../../server/library.ts');
const { chats } = await import('../../server/store.ts');
const { activeRuns, startRun, steerChat, stoppedBefore, STOP_NOTE } = await import('../../server/engines/index.ts');

const until = async (ok: () => boolean, ms = 10000) => {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (ok()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('timed out');
};
const idle = (chat: Chat) => !activeRuns().some((r) => r.chatId === chat.id);
const sessionArg = (args: string[]) => args[args.indexOf('--session-id') + 1];
// a team's turn brings the thread's messages along (they are what a failed turn must replay)
const context = [{ id: 'tm1', text: '@Lead: build the long one', from: '@Lead', ts: 1 }];

describe('steering a command-line agent', () => {
  it('keeps the session it was working in, and tells it the last turn was cut off', async () => {
    const a = newAgent({ name: 'Coder', engine: 'pi', toolGroups: [] });
    const chat = chats.create(a.id);
    fake.modes = ['hang', 'answer'];
    fake.calls = [];
    startRun(a, chat, 'do the long job', { context });
    await until(() => chat.items.some((i) => i.type === 'assistant' && i.text.includes('Working on')));
    const session = chat.sessionId;
    expect(session).toBeTruthy();
    await steerChat(a, chat, 'change of plan');
    await until(() => fake.calls.length === 2 && idle(chat));
    // the same session: what it did before the stop is still in it
    expect(sessionArg(fake.calls[1].args)).toBe(sessionArg(fake.calls[0].args));
    expect(chat.sessionId).toBe(session);
    expect(fake.calls[1].input).not.toContain('Earlier conversation');
    expect(fake.calls[1].input).toBe(`${STOP_NOTE.steer}change of plan`);
    // the chat keeps the stopped turn's work, then a quiet note of why it stopped
    const err = chat.items.find((i) => i.type === 'error');
    expect(err).toMatchObject({ text: 'Stopped to take your new message.', stopped: 'steer' });
    expect(chat.items.some((i) => i.type === 'assistant' && i.text === 'Working on the long one')).toBe(true);
  });

  it('one stopped before it said anything replays the saved conversation, with where it was cut off', async () => {
    const a = newAgent({ name: 'Quiet', engine: 'pi', toolGroups: [] });
    const chat = chats.create(a.id);
    fake.modes = ['silent', 'answer'];
    fake.calls = [];
    startRun(a, chat, 'do the long job', { context });
    await until(() => fake.calls.length === 1);
    await steerChat(a, chat, 'change of plan');
    await until(() => fake.calls.length === 2 && idle(chat));
    // (it may never have read the team's messages: a new session gets them all)
    expect(fake.calls[1].input).toContain('Earlier conversation');
    expect(fake.calls[1].input).toContain('@Lead: build the long one');
    expect(fake.calls[1].input).toContain('My turn was stopped here, before it finished, to take the next message.');
    expect(fake.calls[1].input).toContain('Current request:\nchange of plan');
  });
});

describe('stoppedBefore()', () => {
  it('reads the last thing in the chat, cost lines aside', () => {
    expect(stoppedBefore([{ type: 'error', text: 'Stopped.', stopped: 'stop' }, { type: 'meta', text: '$0.01' }])).toBe('stop');
    expect(stoppedBefore([{ type: 'error', text: 'Stopped to take your new message.', stopped: 'steer' }])).toBe('steer');
    expect(stoppedBefore([{ type: 'error', text: 'rate limited' }])).toBeNull();
    expect(stoppedBefore([{ type: 'error', text: 'Stopped.', stopped: 'stop' }, { type: 'assistant', text: 'Done.' }])).toBeNull();
    expect(stoppedBefore([])).toBeNull();
  });
});
