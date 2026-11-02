import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { GatewayIncomingFile, GatewayInboxEvent, ServerEvent } from '../../shared/types.ts';
import { bus } from '../store.ts';
import * as uploads from '../uploads.ts';
import { insideRoots } from '../util.ts';
import { withGatewayRoute } from './instances.ts';
import type { GatewayInbox } from './inbox.ts';
import { GatewayFileLimitError } from './inbox.ts';

export interface GatewayDownloadSource {
  source: AsyncIterable<Uint8Array>;
  declaredBytes?: number;
  cancel?(): Promise<void>;
}
export type GatewayDownloader = (fileId: string, maxBytes: number, signal: AbortSignal, event: GatewayInboxEvent) => Promise<GatewayDownloadSource>;

async function hashFile(file: string, signal: AbortSignal): Promise<string> {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file, { signal })) hash.update(chunk);
  return hash.digest('hex');
}

/** Files must remain ordinary files in their original project batch, with unchanged bytes. */
export async function verifyGatewayFile(event: GatewayInboxEvent, file: GatewayIncomingFile, signal: AbortSignal): Promise<boolean> {
  if (!event.fileBatch || !file.file || !file.sha256 || file.status !== 'saved') return false;
  return withGatewayRoute(event.route, async () => {
    const root = uploads.safeUploadsRoot();
    if (!root || !insideRoots(file.file!.path, [path.join(root, event.fileBatch!)])) return false;
    const stat = fs.lstatSync(file.file!.path);
    if (!stat.isFile() || stat.size !== file.file!.size || file.file!.kind !== 'file') return false;
    return await hashFile(file.file!.path, signal) === file.sha256;
  });
}

/** Downloads only, with no model invocation. A failed file holds the whole message for explicit retry. */
export class GatewayFileProcessor {
  private readonly instanceId: string;
  private readonly inbox: GatewayInbox;
  private readonly download: GatewayDownloader;
  private readonly signal: AbortSignal;
  private pending: Promise<void> | undefined;
  private stopped = false;
  private started = false;
  private again = false;
  private readonly abort = new AbortController();
  private readonly changed = (event: ServerEvent): void => {
    if (event.type === 'gateway-inbox' && event.instanceId === this.instanceId) void this.wake().catch(() => {});
  };

  constructor(instanceId: string, inbox: GatewayInbox, download: GatewayDownloader, signal: AbortSignal) {
    this.instanceId = instanceId; this.inbox = inbox; this.download = download;
    this.signal = AbortSignal.any([signal, this.abort.signal]);
  }

  start(): Promise<void> {
    if (!this.started) {
      this.started = true;
      for (const event of this.inbox.list()) {
        if (!event.fileBatch || !event.files) continue;
        try {
          this.inbox.checkAccess(event);
          withGatewayRoute(event.route, () => uploads.cleanOwnedBatch(event.fileBatch!, event.files!.filter((file) => file.status === 'saved' && file.file).map((file) => file.file!.path)));
        } catch { this.inbox.holdFiles(event.id); }
      }
      bus.on('event', this.changed);
    }
    return this.wake();
  }

  wake(): Promise<void> {
    if (this.stopped || this.signal.aborted) return Promise.resolve();
    if (this.pending) { this.again = true; return this.pending; }
    this.again = false;
    return this.pending = Promise.resolve().then(() => this.drain()).finally(() => {
      this.pending = undefined;
      if (this.again) return this.wake();
    });
  }

  private async drain(): Promise<void> {
    while (!this.stopped && !this.signal.aborted) {
      const event = this.inbox.list().find((item) => item.status === 'waiting-files' && (!item.files || item.files.some((file) => file.status === 'pending') || item.files.every((file) => file.status === 'saved')));
      if (!event) return;
      try { await this.save(event); }
      catch {
        // Never publish transport errors: they can include tokens or private download URLs.
        this.inbox.holdFiles(event.id);
      }
    }
  }

  private async save(receipt: GatewayInboxEvent): Promise<void> {
    const event = this.inbox.prepareFiles(receipt.id, () => uploads.newBatch().batch);
    const files = event.files!;
    const instance = this.inbox.checkAccess(event);
    await withGatewayRoute(event.route, async () => {
      // A crash between upload rename and journal commit leaves an unrecorded file in this owned batch.
      uploads.cleanOwnedBatch(event.fileBatch!, files.filter((file) => file.status === 'saved' && file.file).map((file) => file.file!.path));
      if (event.input.media.length > instance.fileLimits.filesPerMessage || event.input.media.reduce((sum, media) => sum + (media.size ?? 0), 0) > instance.fileLimits.perMessageBytes) {
        for (const file of files) if (file.status === 'pending') this.inbox.failFile(event.id, file.index, 'limit');
        return;
      }
      for (const file of files) {
        if (this.stopped || this.signal.aborted) return;
        if (file.status === 'saved') {
          const verified = await verifyGatewayFile(event, file, this.signal).catch(() => false);
          if (this.signal.aborted) return;
          if (!verified) this.inbox.failFile(event.id, file.index, 'changed');
          continue;
        }
        if (file.status !== 'pending') continue;
        try {
          this.inbox.checkAccess(event);
          const attempt = this.inbox.beginTransfer(event.id, file.index);
          const media = event.input.media[file.index];
          if ((media.size ?? 0) > attempt.budget) throw new GatewayFileLimitError('File exceeds its reserved download budget.');
          const source = await this.download(media.fileId, attempt.budget, this.signal, event);
          try {
            // Flatten remote names; an attachment cannot create a directory tree or choose its own root.
            const fallback = media.kind === 'image' ? 'image.jpg' : media.kind === 'audio' ? 'audio.ogg' : media.kind === 'video' ? 'video.mp4' : 'file.bin';
            const name = uploads.cleanName(media.name || fallback) || fallback;
            this.inbox.checkAccess(event);
            const saved = await uploads.receiveSource(source.source, event.fileBatch!, `${file.index + 1}-${name}`, { maxBytes: attempt.budget, declaredBytes: source.declaredBytes, signal: this.signal });
            const hash = await hashFile(saved.path, this.signal);
            this.inbox.finishTransfer(event.id, file.index, attempt.id, saved, hash);
          } finally { await source.cancel?.().catch(() => {}); }
        } catch (error) {
          const limit = error instanceof GatewayFileLimitError || (error instanceof Error && 'status' in error && error.status === 413);
          this.inbox.failFile(event.id, file.index, limit ? 'limit' : 'download');
          if (this.signal.aborted) return;
          this.inbox.checkAccess(event);
        }
      }
    });
    if (this.signal.aborted || this.stopped) return;
    const current = this.inbox.list().find((item) => item.id === event.id)!;
    if (current.status === 'waiting-files' && current.files?.every((file) => file.status === 'saved')) this.inbox.filesReady(event.id);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.abort.abort();
    bus.off('event', this.changed);
    await this.pending;
  }
}
