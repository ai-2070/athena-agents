import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Message } from 'chat';
import { afterEach, describe, expect, it } from 'vitest';
import { GatewayStateAdapter } from '../../server/gateways/state.ts';
import { gatewayStateDirectory } from '../../server/gateways/ownership.ts';
import { dataPath } from '../../server/util.ts';

const open = new Set<GatewayStateAdapter>();
async function connect(id: string): Promise<GatewayStateAdapter> {
  const adapter = new GatewayStateAdapter(id);
  open.add(adapter);
  await adapter.connect();
  return adapter;
}
afterEach(async () => {
  await Promise.all([...open].map((adapter) => adapter.disconnect()));
  open.clear();
});

function message(id: string): Message {
  return new Message({
    id,
    threadId: 'telegram:thread',
    text: `Message ${id}`,
    raw: {},
    formatted: { type: 'root', children: [] },
    author: { userId: '123', userName: 'test', fullName: 'Test', isBot: false, isMe: false },
    metadata: { dateSent: new Date(), edited: false },
    attachments: [
      {
        type: 'file',
        name: 'test.txt',
        fetchMetadata: { fileId: 'private-file' },
        fetchData: async () => Buffer.from('test'),
      },
    ],
  });
}

describe('durable gateway SDK state', () => {
  it('retains subscriptions, cache, lists and queues after reconnect, isolated by instance', async () => {
    let state = await connect('restart');
    const other = await connect('isolated');
    await state.subscribe('thread');
    await state.subscribe('thread');
    await state.set('cursor', { offset: 42 });
    await state.appendToList('list', 'first');
    await state.appendToList('list', 'second', { maxLength: 2 });
    await state.appendToList('list', 'third', { maxLength: 2 });
    await state.enqueue(
      'thread',
      { enqueuedAt: Date.now(), expiresAt: Date.now() + 60000, message: message('one') },
      5,
    );
    expect(await other.get('cursor')).toBeNull();
    expect(await other.isSubscribed('thread')).toBe(false);
    expect(await other.queueDepth('thread')).toBe(0);
    await state.disconnect();
    state = await connect('restart');
    expect(await state.isSubscribed('thread')).toBe(true);
    expect(await state.get('cursor')).toEqual({ offset: 42 });
    expect(await state.getList('list')).toEqual(['second', 'third']);
    const entry = await state.dequeue('thread');
    expect(entry?.message).toBeInstanceOf(Message);
    expect(entry?.message.metadata.dateSent).toBeInstanceOf(Date);
    expect(entry?.message.attachments[0].fetchMetadata).toEqual({ fileId: 'private-file' });
    expect(entry?.message.attachments[0].fetchData).toBeUndefined();
    expect(await state.dequeue('thread')).toBeNull();
    await state.unsubscribe('thread');
    expect(await state.isSubscribed('thread')).toBe(false);
  });

  it('expires cache, lists, locks and queues without resurrecting old lock tokens', async () => {
    const state = await connect('expiry');
    await state.set('cache', 1, 40);
    await state.appendToList('list', 1, { ttlMs: 40 });
    const stale = await state.acquireLock('thread', 40);
    expect(stale).not.toBeNull();
    await state.enqueue(
      'thread',
      { enqueuedAt: Date.now(), expiresAt: Date.now() + 40, message: message('expires') },
      5,
    );
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(await state.get('cache')).toBeNull();
    expect(await state.getList('list')).toEqual([]);
    expect(await state.queueDepth('thread')).toBe(0);
    expect(await state.extendLock(stale!, 1000)).toBe(false);
    const fresh = await state.acquireLock('thread', 1000);
    expect(fresh?.token).not.toBe(stale?.token);
    await state.releaseLock(stale!);
    expect(await state.acquireLock('thread', 1000)).toBeNull();
    expect(await state.extendLock(fresh!, 2000)).toBe(true);
    await state.forceReleaseLock('thread');
    expect(await state.extendLock(fresh!, 1000)).toBe(false);
  });

  it('makes concurrent claims atomic and returns copies that cannot mutate stored state', async () => {
    const state = await connect('atomic');
    const claims = await Promise.all(Array.from({ length: 10 }, () => state.setIfNotExists('__proto__', { value: 1 })));
    expect(claims.filter(Boolean)).toHaveLength(1);
    const locks = await Promise.all(Array.from({ length: 10 }, () => state.acquireLock('same', 1000)));
    expect(locks.filter(Boolean)).toHaveLength(1);
    const value = await state.get<{ value: number }>('__proto__');
    value!.value = 99;
    expect(await state.get('__proto__')).toEqual({ value: 1 });
    await state.set('nullable', null);
    expect(await state.setIfNotExists('nullable', 'replace')).toBe(false);
    await state.delete('__proto__');
    expect(await state.setIfNotExists('__proto__', 2)).toBe(true);
  });

  it('refuses overflow without losing queued messages and keeps FIFO order', async () => {
    const state = await connect('capacity');
    const entry = (id: string) => ({ enqueuedAt: Date.now(), expiresAt: Date.now() + 60000, message: message(id) });
    await state.enqueue('thread', entry('first'), 2);
    await state.enqueue('thread', entry('second'), 2);
    await expect(state.enqueue('thread', entry('third'), 2)).rejects.toThrow('queue is full');
    expect(await state.queueDepth('thread')).toBe(2);
    expect((await state.dequeue('thread'))?.message.id).toBe('first');
    expect((await state.dequeue('thread'))?.message.id).toBe('second');
  });

  it('fails closed on corrupt state, invalid input and unsafe filesystem paths', async () => {
    const state = await connect('invalid');
    await state.set('good', 'saved');
    await expect(state.set('bad', { fetchData: () => 'secret' })).rejects.toThrow('serializable');
    await expect(state.set('bad', Number.NaN)).rejects.toThrow('serializable');
    await expect(state.set('bad', 'value', -1)).rejects.toThrow('lifetime');
    expect(await state.get('good')).toBe('saved');
    await state.disconnect();
    await expect(state.get('good')).rejects.toThrow('not connected');
    const file = path.join(gatewayStateDirectory('invalid'), 'sdk-state.json');
    fs.writeFileSync(file, '{broken');
    await expect(state.connect()).rejects.toThrow('unreadable');
    expect(fs.readFileSync(file, 'utf8')).toBe('{broken');
    fs.unlinkSync(file);
    await state.connect();
    expect(() => new GatewayStateAdapter('../outside')).toThrow('Invalid gateway');
    fs.symlinkSync(
      gatewayStateDirectory('invalid'),
      gatewayStateDirectory('alias'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await expect(connect('alias')).rejects.toThrow('ownership port');
    const outside = path.resolve(dataPath(), '..', 'outside-data');
    fs.mkdirSync(outside, { recursive: true });
    fs.symlinkSync(outside, dataPath('gateways-runtime', 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => new GatewayStateAdapter('escape')).toThrow('data folder');
  });

  it('rejects a second owner and reconnects safely after a process is killed', async () => {
    const code = `import { GatewayStateAdapter } from './server/gateways/state.ts';
const state = new GatewayStateAdapter('crashed'); await state.connect();
await state.subscribe('thread'); await state.set('cursor', {offset: 77});
await state.acquireLock('thread', 40); console.log('committed'); setInterval(()=>{},1000);`;
    const child = spawn('bun', ['--eval', code], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    try {
      const ready = await Promise.race([
        once(child.stdout!, 'data').then((chunks: unknown[]) => String(chunks[0])),
        once(child, 'exit').then(() => {
          throw new Error('Gateway fixture exited early.');
        }),
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error('Gateway fixture timed out.')), 10000).unref();
        }),
      ]);
      expect(ready).toContain('committed');
      const competing = new GatewayStateAdapter('crashed');
      await expect(competing.connect()).rejects.toThrow('ownership port');
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
      const state = await connect('crashed');
      expect(await state.get('cursor')).toEqual({ offset: 77 });
      expect(await state.isSubscribed('thread')).toBe(true);
      await expect(connect('crashed')).rejects.toThrow('ownership port');
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(await state.acquireLock('thread', 1000)).not.toBeNull();
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  });
});
