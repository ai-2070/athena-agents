import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createWorld } from '@workflow/world-local';
import { dataPath } from '../../server/util.ts';
import { secureWorld } from '../../runtime/eve-world/index.ts';

describe('the pinned Eve local store', () => {
  it('refuses forged internal queue deliveries before parsing their bodies', async () => {
    const world = secureWorld(createWorld({ dataDir: dataPath('eve-world-guard'), recoverActiveRuns: false }));
    try {
      const prefix = '__proof_wkf_workflow_' as Parameters<typeof world.createQueueHandler>[0];
      const called = vi.fn(async () => {});
      const handler = world.createQueueHandler(prefix, called);
      const response = await handler(new Request('http://127.0.0.1/queue', { method: 'POST', body: '{' }));
      expect(response.status).toBe(401);
      expect(called).not.toHaveBeenCalled();
    } finally {
      await world.close?.();
    }
  });
  for (const outcome of ['completed', 'failed'] as const) {
    for (const window of ['step', 'event'] as const) {
      it(`finishes a ${outcome} checkpoint after a crash before its ${window} write`, async () => {
        const options = { dataDir: dataPath(`eve-world-${outcome}-${window}`), recoverActiveRuns: false };
        const world = createWorld(options);
        await world.start?.();
        const created = await world.events.create(null, {
          eventType: 'run_created',
          specVersion: 8,
          eventData: { deploymentId: 'fixture', workflowName: 'workflow//fixture//work', input: new Uint8Array([1]) },
        });
        const id = created.run?.runId;
        if (!id) throw new Error('The fixture run was not saved.');
        const call = 'step_fixture';
        await world.events.create(id, {
          eventType: 'step_created',
          specVersion: 8,
          correlationId: call,
          eventData: { stepName: 'step//fixture//work', input: new Uint8Array([2]) },
        });
        await world.events.create(id, { eventType: 'step_started', specVersion: 8, correlationId: call });
        const original = fs.promises.writeFile;
        let injected = false;
        const fault = vi.spyOn(fs.promises, 'writeFile').mockImplementation(async (file, data, options) => {
          if (typeof data === 'string') {
            let record: unknown;
            try {
              record = JSON.parse(data);
            } catch {
              /* not a JSON write */
            }
            if (
              record &&
              typeof record === 'object' &&
              (window === 'step'
                ? 'status' in record && record.status === outcome && 'stepId' in record && record.stepId === call
                : 'eventType' in record && record.eventType === `step_${outcome}`)
            ) {
              injected = true;
              throw new Error('Simulated process crash');
            }
          }
          return original(file, data, options);
        });
        try {
          const terminal =
            outcome === 'completed'
              ? ({
                  eventType: 'step_completed',
                  specVersion: 8,
                  correlationId: call,
                  eventData: { result: new Uint8Array([42]), stepName: 'step//fixture//work' },
                } as const)
              : ({
                  eventType: 'step_failed',
                  specVersion: 8,
                  correlationId: call,
                  eventData: { error: new Uint8Array([77]), stepName: 'step//fixture//work' },
                } as const);
          await expect(world.events.create(id, terminal)).rejects.toThrow('Simulated process crash');
        } finally {
          fault.mockRestore();
          await world.close?.();
        }
        expect(injected).toBe(true);
        const recovered = createWorld(options);
        try {
          await recovered.start?.();
          await recovered.start?.();
          const saved = await recovered.steps.get(id, call);
          expect(saved.status).toBe(outcome);
          expect(outcome === 'completed' ? saved.output : saved.error).toEqual(
            new Uint8Array([outcome === 'completed' ? 42 : 77]),
          );
          const history = await recovered.events.listByCorrelationId?.({ runId: id, correlationId: call });
          expect(history?.data.filter((item) => item.eventType === `step_${outcome}`)).toHaveLength(1);
          const markerDirectory = dataPath(`eve-world-${outcome}-${window}`, '.locks', 'steps');
          const markers = fs.readdirSync(markerDirectory).filter((file) => file.endsWith('.terminal'));
          expect(markers).toHaveLength(1);
          expect(fs.readFileSync(`${markerDirectory}/${markers[0]}`, 'utf8')).toBe('');
        } finally {
          await recovered.close?.();
        }
      });
    }
  }
  // Windows: replacing a file fails while something holds it open, even an antivirus scan that lets it be deleted
  it.runIf(process.platform === 'win32')(
    'saves over a file that cannot be replaced while something holds it',
    async () => {
      const dataDir = dataPath('eve-world-held');
      const world = createWorld({ dataDir, recoverActiveRuns: false });
      await world.start?.();
      try {
        const created = await world.events.create(null, {
          eventType: 'run_created',
          specVersion: 8,
          eventData: { deploymentId: 'fixture', workflowName: 'workflow//fixture//work', input: new Uint8Array([1]) },
        });
        const id = created.run?.runId;
        if (!id) throw new Error('The fixture run was not saved.');
        const record = `${id}.json`;
        const original = fs.promises.rename;
        let refused = 0;
        const held = vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
          if (String(to).endsWith(record) && fs.existsSync(to)) {
            refused++;
            throw Object.assign(new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`), {
              code: 'EPERM',
              syscall: 'rename',
            });
          }
          return original(from, to);
        });
        try {
          await world.events.create(id, { eventType: 'run_started', specVersion: 8 });
        } finally {
          held.mockRestore();
        }
        expect(refused).toBeGreaterThan(1);
        expect((await world.runs.get(id)).status).toBe('running');
        const runs = fs.readdirSync(`${dataDir}/runs`);
        expect(runs.filter((file) => file.includes('.tmp.'))).toEqual([]);
      } finally {
        await world.close?.();
      }
    },
  );
  // ...and when the new file is the one held too, the old one goes back: the write fails, nothing is lost
  it.runIf(process.platform === 'win32')(
    'keeps the old file when neither the old nor the new one can be moved into place',
    async () => {
      const dataDir = dataPath('eve-world-both-held');
      const world = createWorld({ dataDir, recoverActiveRuns: false });
      await world.start?.();
      try {
        const created = await world.events.create(null, {
          eventType: 'run_created',
          specVersion: 8,
          eventData: { deploymentId: 'fixture', workflowName: 'workflow//fixture//work', input: new Uint8Array([1]) },
        });
        const id = created.run?.runId;
        if (!id) throw new Error('The fixture run was not saved.');
        const record = `${id}.json`;
        const before = fs.readFileSync(`${dataDir}/runs/${record}`, 'utf8');
        const eperm = (from: unknown, to: unknown) =>
          Object.assign(new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`), {
            code: 'EPERM',
            syscall: 'rename',
          });
        const originalSync = fs.renameSync;
        const original = fs.promises.rename;
        const held = vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
          if (String(to).endsWith(record) && fs.existsSync(to)) throw eperm(from, to);
          return original(from, to);
        });
        const heldSync = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
          if (String(from).includes(`${record}.tmp.`) && !String(from).endsWith('.old')) throw eperm(from, to);
          return originalSync(from, to);
        });
        try {
          await expect(world.events.create(id, { eventType: 'run_started', specVersion: 8 })).rejects.toMatchObject({
            code: 'EPERM',
          });
        } finally {
          held.mockRestore();
          heldSync.mockRestore();
        }
        expect(fs.readFileSync(`${dataDir}/runs/${record}`, 'utf8')).toBe(before);
        expect(fs.readdirSync(`${dataDir}/runs`).filter((file) => file.includes('.tmp.'))).toEqual([]);
        expect((await world.runs.get(id)).status).toBe('pending');
      } finally {
        await world.close?.();
      }
    },
  );
});
