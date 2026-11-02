import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { activeProject, listProjects, saveProjects, setActiveProject, withProject } from '../../server/store.ts';
import { newBatch, receiveSource, uploadsRoot } from '../../server/uploads.ts';
import { saveGatewayInstance, withGatewayRoute } from '../../server/gateways/instances.ts';
import { GatewayStateAdapter } from '../../server/gateways/state.ts';
import { GatewayInbox } from '../../server/gateways/inbox.ts';
import { GatewayFileProcessor, verifyGatewayFile } from '../../server/gateways/files.ts';
import type { GatewayDownloader } from '../../server/gateways/files.ts';
import type { GatewayInbound } from '../../shared/types.ts';
import { gatewayConfig, gatewayInput } from './gateway-fixtures.ts';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });
let account = 40000;
function source(text: string) { return { source: Readable.from([Buffer.from(text)]), declaredBytes: Buffer.byteLength(text) }; }
async function fixture(download: GatewayDownloader, limits?: { perFileBytes: number; perMessageBytes: number; filesPerMessage: number; dailyBytes: number }) {
  const config = { ...gatewayConfig(String(account++)), ...(limits ? { fileLimits: limits } : {}) };
  const instance = saveGatewayInstance(config);
  const state = new GatewayStateAdapter(instance.id); await state.connect();
  const inbox = new GatewayInbox(state);
  const abort = new AbortController();
  const processor = new GatewayFileProcessor(instance.id, inbox, download, abort.signal);
  closers.push(() => state.disconnect(), () => processor.stop());
  const accept = (id = '1', media: GatewayInbound['media'] = [{ kind: 'file', fileId: 'one', name: 'plan.txt', size: 5 }], album = false) => inbox.accept({
    ...gatewayInput(id), accountId: instance.accountId, text: '', media, ...(album ? { mediaGroupId: 'album-1' } : {}),
  })!;
  return { config, instance, state, inbox, processor, abort, accept };
}

describe('saving gateway files', () => {
  it('saves file-only input in its bound project, with safe names, hashes and no duplicate retries', async () => {
    let downloads = 0;
    const f = await fixture(async () => { downloads++; return source('hello'); });
    const event = f.accept('1', [{ kind: 'file', fileId: 'one', name: '../../CON.txt', size: 5 }]);
    const first = activeProject();
    const second = { ...first, id: 'gateway-files-other', name: 'Other' };
    saveProjects([...listProjects(), second]); setActiveProject(second.id);
    await f.processor.start();
    const saved = f.inbox.list()[0];
    expect(saved.status).toBe('queued');
    const file = saved.files![0];
    expect(file.status).toBe('saved');
    expect(file.file!.path.startsWith(withProject(first, uploadsRoot) + path.sep)).toBe(true);
    expect(file.file!.name).not.toContain('/');
    expect(fs.readFileSync(file.file!.path, 'utf8')).toBe('hello');
    expect(file.sha256).toBe(crypto.createHash('sha256').update('hello').digest('hex'));
    expect(await verifyGatewayFile(saved, file, f.abort.signal)).toBe(true);
    expect(f.inbox.accept({ ...event.input, sourceEventId: 'replay' })?.id).toBe(event.id);
    await f.processor.wake(); expect(downloads).toBe(1);
    expect(activeProject().id).toBe(second.id);
  });

  it('keeps successful files after a partial failure and retries only after an explicit request', async () => {
    let failed = true;
    const calls: string[] = [];
    const f = await fixture(async (id) => {
      calls.push(id);
      if (id === 'two' && failed) throw new Error('https://api.example/botPRIVATE_TOKEN');
      return source('hello');
    });
    const event = f.accept('1', [{ kind: 'file', fileId: 'one', name: 'one.txt' }, { kind: 'file', fileId: 'two', name: 'two.txt' }]);
    await f.processor.start();
    const partial = f.inbox.list()[0];
    expect(partial.status).toBe('waiting-files');
    expect(partial.files!.map((file) => file.status)).toEqual(['saved', 'failed']);
    expect(JSON.stringify(partial)).not.toContain('PRIVATE_TOKEN');
    expect(f.inbox.claimNext()).toBeNull();
    await f.processor.wake(); expect(calls).toEqual(['one', 'two']);
    failed = false; f.inbox.retryFiles(event.id); await f.processor.wake();
    const complete = f.inbox.list()[0];
    expect(complete.status).toBe('queued');
    expect(complete.files![0].file!.path).toBe(partial.files![0].file!.path);
    expect(calls).toEqual(['one', 'two', 'two']);
    expect(fs.readdirSync(path.dirname(complete.files![0].file!.path))).toHaveLength(2);
  });

  it('checks declared sizes and file counts before download and caps misleading streams during transfer', async () => {
    let downloads = 0;
    const f = await fixture(async () => { downloads++; return { source: Readable.from([Buffer.alloc(1025)]), declaredBytes: 1 }; });
    f.accept('1', [{ kind: 'file', fileId: 'large', size: 1500 }]);
    await f.processor.start(); expect(downloads).toBe(0);
    expect(f.inbox.list()[0].files![0].reason).toContain('limit');
    f.accept('2', [{ kind: 'file', fileId: 'liar', size: 1 }]);
    await f.processor.wake(); expect(downloads).toBe(1);
    const failed = f.inbox.list()[1];
    expect(failed.files![0].status).toBe('failed');
    expect(failed.status).toBe('waiting-files');
    expect(withGatewayRoute(failed.route, () => fs.readdirSync(path.join(uploadsRoot(), failed.fileBatch!)))) .toEqual([]);
    f.accept('3', ['a', 'b', 'c'].map((fileId) => ({ kind: 'file', fileId })));
    await f.processor.wake(); expect(downloads).toBe(1);
  });

  it('reserves the daily budget before network I/O and retains reservations for failed attempts', async () => {
    let calls = 0;
    const f = await fixture(async () => { calls++; throw new Error('expired'); }, { perFileBytes: 16, perMessageBytes: 32, filesPerMessage: 2, dailyBytes: 32 });
    const one = f.accept('1'); f.accept('2'); f.accept('3');
    await f.processor.start();
    expect(calls).toBe(2);
    expect(f.inbox.list().every((event) => event.files?.[0].status === 'failed')).toBe(true);
    f.inbox.retryFiles(one.id); await f.processor.wake(); expect(calls).toBe(2);
    expect(f.inbox.list()[0].files![0].reason).toContain('daily');
  });

  it('does not fetch after rebinding or sender revocation and does not redirect the upload project', async () => {
    let calls = 0;
    const f = await fixture(async () => { calls++; return source('hello'); });
    f.accept();
    saveGatewayInstance({ ...f.config, senderPolicy: { platform: 'telegram', allowedUserIds: ['777'] } }, f.instance.id);
    await f.processor.start();
    expect(calls).toBe(0); expect(f.inbox.list()[0].status).toBe('needs-review');
  });

  it('cancels an opened source if access changes before saving and retains the message for review', async () => {
    let cancelled = false;
    const f = await fixture(async () => {
      saveGatewayInstance({ ...f.config, senderPolicy: { platform: 'telegram', allowedUserIds: ['777'] } }, f.instance.id);
      return { ...source('hello'), cancel: async () => { cancelled = true; } };
    });
    f.accept(); await f.processor.start();
    expect(cancelled).toBe(true); expect(f.inbox.list()[0].status).toBe('needs-review');
    expect(f.inbox.list()[0].files![0].file).toBeUndefined();
  });

  it('cleans an unrecorded completed upload and partial file after restart without automatic redownload', async () => {
    let calls = 0;
    const f = await fixture(async () => { calls++; return source('hello'); });
    const initial = f.accept();
    const event = f.inbox.prepareFiles(initial.id, () => newBatch().batch);
    f.inbox.beginTransfer(event.id, 0);
    const orphan = await withGatewayRoute(event.route, () => receiveSource(source('hello').source, event.fileBatch!, 'orphan.txt', { maxBytes: 1024 }));
    fs.writeFileSync(orphan.path + '.part', 'partial');
    await f.state.disconnect(); await f.state.connect(); f.inbox.recover();
    await f.processor.start();
    expect(calls).toBe(0); expect(fs.existsSync(orphan.path)).toBe(false); expect(fs.existsSync(orphan.path + '.part')).toBe(false);
    expect(f.inbox.list()[0].files![0].status).toBe('failed');
    f.inbox.retryFiles(event.id); await f.processor.wake();
    expect(calls).toBe(1); expect(f.inbox.list()[0].status).toBe('queued');
  });

  it('detects changed saved bytes and keeps albums out of dispatch until grouping is implemented', async () => {
    const f = await fixture(async () => source('hello'));
    f.accept('1', undefined, true); await f.processor.start();
    const album = f.inbox.list()[0]; expect(album.status).toBe('needs-review');
    expect(album.reason).toContain('Album'); expect(f.inbox.claimNext()).toBeNull();
    fs.writeFileSync(album.files![0].file!.path, 'other');
    expect(await verifyGatewayFile(album, album.files![0], f.abort.signal)).toBe(false);
  });

  it('stops an active streamed upload and removes its temporary files before releasing ownership', async () => {
    let streaming = false;
    const f = await fixture(async (_id, _budget, signal) => ({ source: (async function* () {
      streaming = true; yield Buffer.from('first');
      signal.throwIfAborted();
      await new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    })() }));
    f.accept();
    const running = f.processor.start();
    await expect.poll(() => streaming).toBe(true);
    await f.processor.stop(); await running;
    const event = f.inbox.list()[0];
    expect(event.files![0].status).toBe('failed');
    expect(withGatewayRoute(event.route, () => fs.readdirSync(path.join(uploadsRoot(), event.fileBatch!)))).toEqual([]);
  });
});
