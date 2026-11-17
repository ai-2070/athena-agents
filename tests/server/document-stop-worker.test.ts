// Stop while a PDF is read ends its reader thread then, not when the thread's own time limit comes (BH-108).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ToolAgent } from '../../server/tools.ts';

// a PDF reader thread that never answers, and says when it is ended
const threads = vi.hoisted(() => ({ started: 0, ended: 0 }));
vi.mock('node:worker_threads', async (orig) => {
  const real = await orig<typeof import('node:worker_threads')>();
  const { EventEmitter } = await import('node:events');
  class Worker extends EventEmitter {
    constructor() {
      super();
      threads.started++;
    }
    terminate() {
      threads.ended++;
      return Promise.resolve(0);
    }
  }
  return { ...real, Worker, default: { ...real, Worker } };
});

const { callTool } = await import('../../server/tools.ts');
const { pdf } = await import('./fixtures/documents.ts');

describe('Stop while a PDF is read', () => {
  it('ends the reader thread at once', async () => {
    const workspace = fs.mkdtempSync(path.join(os.homedir(), 'doc-stop-'));
    fs.writeFileSync(path.join(workspace, 'contract.pdf'), pdf('Signed on 3 May'));
    const agent: ToolAgent = {
      id: 'doc-stopper',
      name: 'Reader',
      engine: 'eve',
      toolGroups: ['files'],
      autonomy: 'auto',
      workspace,
      knowledge: { folders: [] },
    };
    for (const tool of ['read_document', 'read_file']) {
      const before = { ...threads };
      const stop = new AbortController();
      const reading = callTool(agent, tool, { path: 'contract.pdf' }, { signal: stop.signal });
      for (let i = 0; i < 50 && threads.started === before.started; i++) await new Promise((r) => setTimeout(r, 10));
      expect(threads.started).toBe(before.started + 1);
      stop.abort(new Error('Stopped.'));
      await reading;
      // (well before the reader's own time limit)
      await new Promise((r) => setTimeout(r, 50));
      expect(threads.ended, tool).toBe(before.ended + 1);
    }
  });
});
