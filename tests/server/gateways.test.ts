// Chat gateways end to end with a fake Telegram (fetch stubbed): who is let in, a message saved and answered as a reply,
// files in and out, a failure noted once, a retry that sends only what didn't arrive, and a restart in the middle.
// The Brain/team/agent run is a stand-in (run.ts has its own tests through the real services elsewhere).
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activeProject, setGatewaySecrets } from '../../server/store.ts';
import {
  addMessage,
  conversationOf,
  instances,
  listChats,
  listMessages,
  saveInstance,
  setEnabled,
} from '../../server/gateways/store.ts';
import { admits, gateways, splitText } from '../../server/gateways/supervisor.ts';
import type { Incoming } from '../../server/gateways/transport.ts';
import type { GatewayInstance } from '../../shared/types.ts';
import type { GatewayRunInput } from '../../server/gateways/run.ts';

const runs = vi.hoisted(() => ({
  inputs: [] as GatewayRunInput[],
  answer: async (_input: GatewayRunInput): Promise<string> => 'Hi back',
}));
vi.mock('../../server/gateways/run.ts', () => ({
  runGatewayMessage: (input: GatewayRunInput) => {
    runs.inputs.push(input);
    return runs.answer(input);
  },
}));

// ---------- a fake Telegram ----------
interface Call {
  method: string;
  body: Record<string, unknown>;
  form?: FormData;
}
let calls: Call[] = [];
let updates: unknown[] = [];
let failSend = 0;
function telegram() {
  return vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/file/bot')) return new Response('file body', { headers: { 'content-length': '9' } });
    const method = url.split('/').pop()!;
    const form = init?.body instanceof FormData ? init.body : undefined;
    const body = form ? {} : (JSON.parse(String(init?.body || '{}')) as Record<string, unknown>);
    calls.push({ method, body, ...(form ? { form } : {}) });
    const ok = (result: unknown) => Response.json({ ok: true, result });
    if (method === 'getMe') return ok({ id: 999, username: 'athena_bot' });
    if (method === 'getUpdates') {
      if (updates.length) return ok(updates.splice(0));
      // (a long poll: nothing new until it is stopped)
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const timer = setTimeout(() => _resolve(ok([])), 200);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('aborted'));
        });
      });
    }
    if (method === 'getFile') return ok({ file_path: 'documents/notes.txt' });
    if (method === 'sendMessage' && failSend > 0) {
      failSend--;
      return Response.json({ ok: false, description: 'Too Many Requests' }, { status: 429 });
    }
    return ok({});
  });
}

const message = (id: number, from: number, text: string, extra: Record<string, unknown> = {}) => ({
  update_id: id,
  message: {
    message_id: id * 10,
    from: { id: from, is_bot: false, first_name: 'Ann' },
    chat: { id: from, type: 'private' },
    text,
    ...extra,
  },
});

async function until(check: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

let instance: GatewayInstance;
const sent = (method = 'sendMessage') => calls.filter((c) => c.method === method);

beforeEach(() => {
  calls = [];
  updates = [];
  failSend = 0;
  runs.inputs = [];
  runs.answer = async () => 'Hi back';
  vi.stubGlobal('fetch', telegram());
  instance = saveInstance({
    platform: 'telegram',
    name: 'Phone',
    projectId: activeProject().id,
    target: { kind: 'brain' },
    users: ['42'],
    channels: [],
  });
  setGatewaySecrets(instance.id, { botToken: 'TOKEN' });
});
afterEach(async () => {
  await gateways.stop();
  for (const i of instances.list()) instances.remove(i.id);
  vi.unstubAllGlobals();
});

describe('a Telegram gateway', () => {
  it('answers an allowed person as a reply, in a conversation of its own, and remembers the chat', async () => {
    setEnabled(instance.id, true);
    updates = [message(1, 42, 'Hello')];
    gateways.start();
    await until(() => listMessages(instance.id)[0]?.status === 'done');
    expect(runs.inputs).toEqual([
      expect.objectContaining({
        projectId: activeProject().id,
        conversationId: conversationOf(instance.id, '42'),
        target: { kind: 'brain' },
        text: 'Hello',
        attachments: [],
        from: 'Telegram: Ann (42)',
      }),
    ]);
    expect(sent()[0].body).toMatchObject({
      chat_id: '42',
      text: 'Hi back',
      reply_parameters: { message_id: 10, allow_sending_without_reply: true },
    });
    expect(listChats(instance.id)).toEqual([expect.objectContaining({ key: '42', title: 'Ann' })]);
    expect(gateways.health(instance.id)).toMatchObject({ status: 'connected', bot: '@athena_bot' });
    // (the next update is asked for: a restart never takes the same one again)
    await until(() => calls.some((c) => c.method === 'getUpdates' && c.body.offset === 2));
  });

  it('ignores people not on its list and shows them, to let them in', async () => {
    setEnabled(instance.id, true);
    updates = [message(1, 7, 'Let me in')];
    gateways.start();
    await until(() => gateways.listing()[0]?.refused.length === 1);
    expect(gateways.listing()[0].refused[0]).toMatchObject({ kind: 'user', id: '7', name: 'Ann' });
    expect(listMessages(instance.id)).toEqual([]);
    expect(runs.inputs).toEqual([]);
  });

  it('in a group, answers only when mentioned or replied to', () => {
    const group = (text: string, extra: Partial<Incoming> = {}): Incoming => ({
      sourceId: '1',
      chat: { chatId: '-100', title: 'Team', direct: false },
      sender: { id: '42', name: 'Ann', bot: false },
      text,
      addressed: false,
      files: [],
      ...extra,
    });
    expect(admits(instance, group('chatter')).ok).toBe(false);
    expect(admits(instance, group('@athena_bot hi', { addressed: true })).ok).toBe(true);
    expect(admits(instance, group('hi', { addressed: true, sender: { id: '42', name: 'Bot', bot: true } })).ok).toBe(
      false,
    );
  });

  it('saves the files that come with a message in the project uploads and hands them on', async () => {
    setEnabled(instance.id, true);
    updates = [
      message(1, 42, '', {
        caption: 'Read this',
        document: { file_id: 'F1', file_name: 'notes.txt', file_size: 9 },
      }),
    ];
    gateways.start();
    await until(() => listMessages(instance.id)[0]?.status === 'done');
    const [m] = listMessages(instance.id);
    expect(m.text).toBe('Read this');
    expect(m.files[0]).toMatchObject({ name: 'notes.txt', size: 9 });
    expect(fs.readFileSync(m.files[0].path!, 'utf8')).toBe('file body');
    expect(runs.inputs[0].attachments).toEqual([m.files[0].path]);
    // (the platform's file handle stays on the server)
    expect(JSON.stringify(gateways.messages(instance.id))).not.toContain('F1');
  });

  it('sends files the agent chose after its answer', async () => {
    setEnabled(instance.id, true);
    const file = `${activeProject().brainPath}/report.txt`;
    fs.writeFileSync(file, 'report');
    runs.answer = async (input) => {
      gateways.queueFiles(input.conversationId, [{ path: file, name: 'report.txt' }]);
      return 'Here it is';
    };
    updates = [message(1, 42, 'Send me the report')];
    gateways.start();
    await until(() => listMessages(instance.id)[0]?.status === 'done');
    expect(sent()[0].body.text).toBe('Here it is');
    const doc = sent('sendDocument')[0];
    expect(doc.form!.get('chat_id')).toBe('42');
    expect((doc.form!.get('document') as File).name).toBe('report.txt');
    expect(listMessages(instance.id)[0].outFiles).toEqual([
      expect.objectContaining({ name: 'report.txt', sent: true }),
    ]);
    expect(() => gateways.queueFiles('gw-nobody', [{ path: file, name: 'x' }])).toThrow('No message');
  });

  it('notes a failure once, and a retry sends only the parts that had not arrived', async () => {
    setEnabled(instance.id, true);
    runs.answer = async () => `${'a'.repeat(4000)}\n\n${'b'.repeat(100)}`;
    // (the first part arrives, the second is refused; with part of the answer there, no "sorry" notice)
    const fetchNow = globalThis.fetch;
    let parts = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        if (String(input).endsWith('/sendMessage') && ++parts === 2) failSend = 1;
        return fetchNow(input, init);
      }),
    );
    updates = [message(1, 42, 'Long one')];
    gateways.start();
    await until(() => listMessages(instance.id)[0]?.status === 'failed');
    const [failed] = listMessages(instance.id);
    expect(failed).toMatchObject({ sentParts: 1, error: 'Telegram: Too Many Requests' });
    expect(sent().map((c) => String(c.body.text).slice(0, 1))).toEqual(['a', 'b']);
    gateways.retry(instance.id, failed.id);
    await until(() => listMessages(instance.id)[0]?.status === 'done');
    expect(runs.inputs).toHaveLength(1);
    expect(sent().map((c) => String(c.body.text).slice(0, 1))).toEqual(['a', 'b', 'b']);
  });

  it('tells the person once when nothing could be answered', async () => {
    setEnabled(instance.id, true);
    runs.answer = async () => {
      throw new Error('The Brain couldn’t answer this.');
    };
    updates = [message(1, 42, 'Hello')];
    gateways.start();
    await until(() => listMessages(instance.id)[0]?.status === 'failed');
    expect(listMessages(instance.id)[0].error).toBe('The Brain couldn’t answer this.');
    await until(() => sent().length === 1);
    expect(sent()[0].body.text).toContain('waiting in Athena');
    gateways.retry(instance.id, listMessages(instance.id)[0].id);
    await until(() => runs.inputs.length === 2 && listMessages(instance.id)[0]?.status === 'failed');
    expect(sent()).toHaveLength(1);
  });

  it('after a restart, marks a message that was being worked on as failed instead of running it twice', async () => {
    setEnabled(instance.id, true);
    addMessage({
      id: 'm1',
      instanceId: instance.id,
      chatKey: '42',
      chatTitle: 'Ann',
      sourceId: '10',
      sender: { id: '42', name: 'Ann' },
      text: 'Halfway',
      files: [],
      status: 'working',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    gateways.start();
    expect(listMessages(instance.id)[0]).toMatchObject({ status: 'failed', error: expect.stringContaining('Retry') });
    expect(runs.inputs).toEqual([]);
  });

  it('sends Outbox messages to a chat it knows, part by part', async () => {
    updates = [message(1, 42, 'Hello')];
    setEnabled(instance.id, true);
    gateways.start();
    await until(() => listChats(instance.id).length === 1);
    const progress: number[] = [];
    await gateways.sendToChat(instance.id, '42', ['one', 'two'], 0, (n) => progress.push(n));
    expect(progress).toEqual([1, 2]);
    expect(gateways.chats(activeProject().id)).toEqual([
      expect.objectContaining({ instanceId: instance.id, chatKey: '42', title: 'Ann', platform: 'telegram' }),
    ]);
    await expect(gateways.sendToChat(instance.id, 'unknown', ['x'])).rejects.toThrow('unknown');
  });
});

describe('who a Slack or Discord gateway answers', () => {
  const base = (platform: 'slack' | 'discord', users: string[], channels: string[]): GatewayInstance => ({
    ...instance,
    platform,
    users,
    channels,
  });
  const msg = (direct: boolean, extra: Partial<Incoming['chat']> = {}): Incoming => ({
    sourceId: '1',
    chat: { chatId: 'C1', title: '#general', direct, ...extra },
    sender: { id: 'U1', name: 'Ann', bot: false },
    text: 'hi',
    addressed: true,
    files: [],
  });
  it('Slack: everyone in direct messages unless there is a list; mentions only in listed channels', () => {
    expect(admits(base('slack', [], []), msg(true)).ok).toBe(true);
    expect(admits(base('slack', ['U2'], []), msg(true))).toMatchObject({ ok: false, refused: { kind: 'user' } });
    expect(admits(base('slack', [], []), msg(false))).toMatchObject({
      ok: false,
      refused: { kind: 'channel', id: 'C1' },
    });
    expect(admits(base('slack', [], ['C1']), msg(false)).ok).toBe(true);
  });
  it('Discord: direct messages need the user list; a thread counts as its channel', () => {
    expect(admits(base('discord', [], ['C1']), msg(true))).toMatchObject({ ok: false, refused: { kind: 'user' } });
    expect(admits(base('discord', ['U1'], []), msg(true)).ok).toBe(true);
    expect(admits(base('discord', [], ['C1']), msg(false, { chatId: 'T9', parentId: 'C1' })).ok).toBe(true);
    expect(admits(base('discord', [], ['C2']), msg(false, { chatId: 'T9', parentId: 'C1' }))).toMatchObject({
      refused: { kind: 'channel', id: 'C1' },
    });
  });
});

describe('splitting an answer', () => {
  it('keeps messages under the limit, cutting at paragraphs, lines or words', () => {
    expect(splitText('short', 10)).toEqual(['short']);
    expect(splitText('one two three four', 9)).toEqual(['one two', 'three', 'four']);
    expect(splitText(`${'a'.repeat(6)}\n\n${'b'.repeat(6)}`, 10)).toEqual(['aaaaaa', 'bbbbbb']);
    const emoji = splitText('😀'.repeat(6), 5);
    expect(emoji.join('')).toBe('😀'.repeat(6));
    expect(emoji.every((p) => p.length <= 5 && !/[\ud800-\udbff]$/.test(p))).toBe(true);
    expect(splitText('', 10)).toEqual([]);
  });
});
