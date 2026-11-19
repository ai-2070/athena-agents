// Each test run takes its own share of the lock ports (server/ownershipport.ts), so two runs on one computer at the
// same time (two worktrees, two agents) don't claim each other's ports: before, worker 1 of every run used the same
// block, and the second run's claims failed at once.
//
// A run holds its slot by listening on a guard port just below the lock ports for as long as it runs; the system lets
// go of it when the run ends, however it ends.
import { once } from 'node:events';
import net from 'node:net';
import type { TestProject } from 'vitest/node';
import { OWNERSHIP_PORT_FIRST } from '../server/ownershipport.ts';

/** How many runs can share the lock ports at once, and the most test workers one run can have. */
export const RUN_SLOTS = 8;
export const SLOT_WORKERS = 8;

declare module 'vitest' {
  export interface ProvidedContext {
    lockSlot: number;
  }
}

async function claim(port: number): Promise<net.Server | null> {
  const server = net.createServer();
  server.listen({ host: '127.0.0.1', port, exclusive: true });
  try {
    await Promise.race([once(server, 'listening'), once(server, 'error').then(([e]) => Promise.reject(e))]);
    return server;
  } catch {
    server.close();
    return null;
  }
}

export default async function setup(project: TestProject) {
  // (while every slot is taken, wait for a run to end rather than collide with it)
  const until = Date.now() + 10 * 60_000;
  let waited = false;
  for (;;) {
    for (let slot = 0; slot < RUN_SLOTS; slot++) {
      const guard = await claim(OWNERSHIP_PORT_FIRST - RUN_SLOTS + slot);
      if (!guard) continue;
      project.provide('lockSlot', slot);
      return () => new Promise<void>((resolve) => guard.close(() => resolve()));
    }
    if (Date.now() > until)
      throw new Error(
        `${RUN_SLOTS} other test runs have been going on this computer for ten minutes; try again when one ends.`,
      );
    if (!waited) console.log(`${RUN_SLOTS} other test runs are going on this computer; waiting for one to end.`);
    waited = true;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}
