// A loopback port that stands for a lock (the Eve worker's files): whoever listens on it holds the
// lock, and the kernel lets go when that process dies, so no stale lock file is left to steal. Every process works
// out the same port for the same key; if anything else is listening there, the claim fails closed.
//
// The ports stay below 32768. Systems hand out ports from 49152 up (Windows, macOS) and from 32768 up (Linux) to every
// listen(0) and outgoing connection, so a lock port up there was now and then taken by some unrelated socket and the
// claim failed for nothing: often enough under load to make the test suite flaky, and now and then for real.
//
// The test suite claims about two thousand locks per run, in four processes at once, so two random folders landing on
// one port (or on a local program's port) still happened about once in every few runs. Tests set DASH_TEST_LOCK_PORTS:
// each test worker gets its own block of ports, and a key takes the next free one in it, recorded in a folder that the
// processes a test starts share, so they find the same port for the same key.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** The first lock port: most fixed services (3000, 5432, 8080, 11434…) sit below it. */
export const OWNERSHIP_PORT_FIRST = 16384;
/** How many lock ports there are: up to 32767, the last port no system hands out by itself. */
export const OWNERSHIP_PORT_COUNT = 16384;

/** The lock port for a key (a resolved path): the same in every process and on every run. */
export function ownershipPort(key: string): number {
  return testPort(key) ?? hashedPort(key);
}

/** The port a key hashes to (what every dashboard uses). */
export function hashedPort(key: string): number {
  return (
    OWNERSHIP_PORT_FIRST + (crypto.createHash('sha256').update(key).digest().readUInt32BE(0) % OWNERSHIP_PORT_COUNT)
  );
}

/** Tests only: { dir, first, count }, a test worker's block of ports and where it records which key has which. */
export interface TestLockPorts {
  dir: string;
  first: number;
  count: number;
}

function testPort(key: string): number | null {
  const raw = process.env.DASH_TEST_LOCK_PORTS;
  if (!raw) return null;
  const set: unknown = JSON.parse(raw);
  if (!set || typeof set !== 'object') throw new Error('DASH_TEST_LOCK_PORTS is unreadable.');
  const { dir, first, count } = set as Partial<TestLockPorts>;
  if (typeof dir !== 'string' || !Number.isInteger(first) || !Number.isInteger(count))
    throw new Error('DASH_TEST_LOCK_PORTS is unreadable.');
  fs.mkdirSync(dir, { recursive: true });
  for (let port = first!; port < first! + count!; port++) {
    const file = path.join(dir, String(port));
    let owner = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    if (owner === null) {
      // (a link appears whole or not at all: two processes taking the same port can't both win, or read half a key)
      const temp = path.join(dir, `${port}-${crypto.randomUUID()}`);
      fs.writeFileSync(temp, key);
      try {
        fs.linkSync(temp, file);
        owner = key;
      } catch {
        owner = fs.readFileSync(file, 'utf8');
      } finally {
        fs.rmSync(temp, { force: true });
      }
    }
    if (owner === key) return port;
  }
  throw new Error('The test lock ports ran out.');
}
