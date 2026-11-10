// Runs before each server test file: point the dashboard at a fresh, empty data folder
// (and a fake home for the Claude/Codex lookups), so tests never read or change your real data.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, inject } from 'vitest';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-test-'));
process.env.DASH_DATA = path.join(dir, 'data');
fs.mkdirSync(process.env.DASH_DATA, { recursive: true });
// project folders default to <home>/Documents/Athena Agents: keep those in the throwaway folder too
const home = path.join(dir, 'home');
fs.mkdirSync(home, { recursive: true });
process.env.HOME = home;
process.env.USERPROFILE = home;
// pi prefers this over the home folder: an inherited one would let pi's tests write your real mcp.json
process.env.PI_CODING_AGENT_DIR = path.join(home, '.pi', 'agent');
// lock ports (server/ownershipport.ts): a block for this test worker within this run's share (tests/lock-ports.ts),
// handed out one key at a time, so two folders never meet on one port, not even another run's; the processes a test
// starts inherit it and find the same ports. (The busiest file takes under a hundred.)
const { OWNERSHIP_PORT_FIRST, OWNERSHIP_PORT_COUNT } = await import('../../server/ownershipport.ts');
const { RUN_SLOTS, SLOT_WORKERS } = await import('../lock-ports.ts');
const pool = Number(process.env.VITEST_POOL_ID) || 1;
const count = OWNERSHIP_PORT_COUNT / RUN_SLOTS / SLOT_WORKERS;
const block = inject('lockSlot') * SLOT_WORKERS + ((pool - 1) % SLOT_WORKERS);
process.env.DASH_TEST_LOCK_PORTS = JSON.stringify({ dir: path.join(dir, 'lock-ports'), first: OWNERSHIP_PORT_FIRST + block * count, count });
if (os.homedir() !== home) throw new Error(`Tests could not use a throwaway home folder (got ${os.homedir()}); stopping so your real files stay untouched.`);
// and the dashboard really uses the throwaway data folder
const { dataPath } = await import('../../server/util.ts');
if (!path.resolve(dataPath()).startsWith(path.resolve(dir))) throw new Error(`The data folder is ${dataPath()}, not the throwaway one; stopping so your real data stays untouched.`);

afterAll(async () => {
  const { stopAllRuns } = await import('../../server/engines/index.ts');
  const { eveCoordinator } = await import('../../server/eve/coordinator.ts');
  const { eveRuntime } = await import('../../server/eve/runtime.ts');
  await stopAllRuns(1000);
  await Promise.allSettled([eveCoordinator.close(), eveRuntime.close()]);
  fs.rmSync(dir, { recursive: true, force: true });
});
