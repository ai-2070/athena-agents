// A loopback port that stands for a lock (a gateway's state, the Eve worker's files): whoever listens on it holds the
// lock, and the kernel lets go when that process dies, so no stale lock file is left to steal. Every process works
// out the same port for the same key; if anything else is listening there, the claim fails closed.
//
// The ports stay below 32768. Systems hand out ports from 49152 up (Windows, macOS) and from 32768 up (Linux) to every
// listen(0) and outgoing connection, so a lock port up there was now and then taken by some unrelated socket and the
// claim failed for nothing: often enough under load to make the test suite flaky, and rarely for a real gateway.
import crypto from 'node:crypto';

/** The first lock port: most fixed services (3000, 5432, 8080, 11434…) sit below it. */
export const OWNERSHIP_PORT_FIRST = 16384;
/** How many lock ports there are: up to 32767, the last port no system hands out by itself. */
export const OWNERSHIP_PORT_COUNT = 16384;

/** The lock port for a key (a resolved path): the same in every process and on every run. */
export function ownershipPort(key: string): number {
  return OWNERSHIP_PORT_FIRST + (crypto.createHash('sha256').update(key).digest().readUInt32BE(0) % OWNERSHIP_PORT_COUNT);
}
