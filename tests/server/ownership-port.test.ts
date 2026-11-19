// The lock ports for the Eve worker (server/ownershipport.ts) stay clear of the ports systems hand
// out by themselves, so an unrelated socket can't make a claim fail; in tests, two folders never share one.
import { once } from 'node:events';
import net from 'node:net';
import path from 'node:path';
import { describe, expect, inject, it } from 'vitest';
import type { TestProject } from 'vitest/node';
import claimRunSlot from '../lock-ports.ts';
import { OWNERSHIP_PORT_COUNT, OWNERSHIP_PORT_FIRST, hashedPort, ownershipPort } from '../../server/ownershipport.ts';
import type { TestLockPorts } from '../../server/ownershipport.ts';
import { claimEveRuntime, eveOwnershipPort } from '../../server/eve/ownership.ts';
import { dataPath } from '../../server/util.ts';

/** True when nothing else holds this loopback port. */
async function free(port: number): Promise<boolean> {
  const server = net.createServer();
  try {
    server.listen({ host: '127.0.0.1', port, exclusive: true });
    await once(server, 'listening');
    return true;
  } catch {
    return false;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('lock ports', () => {
  it('stay below every range systems hand out ports from (Linux from 32768, Windows and macOS from 49152)', () => {
    expect(OWNERSHIP_PORT_FIRST + OWNERSHIP_PORT_COUNT - 1).toBe(32767);
    const ports = Array.from({ length: 5000 }, (_, i) =>
      hashedPort(path.join('/data', 'runtime', 'eve', `instance-${i}`)),
    );
    expect(Math.min(...ports)).toBeGreaterThanOrEqual(OWNERSHIP_PORT_FIRST);
    expect(Math.max(...ports)).toBeLessThanOrEqual(32767);
    // the whole range gets used, so two folders rarely share a port
    expect(new Set(ports).size).toBeGreaterThan(4000);
    expect(hashedPort('/data/x')).toBe(hashedPort('/data/x'));
  });

  it("in tests, come from this test worker's own block, one key per port", () => {
    const block = JSON.parse(process.env.DASH_TEST_LOCK_PORTS!) as TestLockPorts;
    expect(block.count).toBe(256);
    expect(block.first).toBeGreaterThanOrEqual(OWNERSHIP_PORT_FIRST);
    expect(block.first + block.count - 1).toBeLessThanOrEqual(32767);
    const keys = Array.from({ length: 40 }, (_, i) => path.join('/data', 'runtime', 'eve', `block-${i}`));
    const ports = keys.map(ownershipPort);
    expect(new Set(ports).size).toBe(40);
    for (const port of ports)
      (expect(port).toBeGreaterThanOrEqual(block.first), expect(port).toBeLessThan(block.first + block.count));
    expect(keys.map(ownershipPort)).toEqual(ports);
  });

  it('in tests, belong to this run alone: another run on this computer at the same time takes another share', async () => {
    let slot: number | undefined;
    const other = {
      provide: (_key: string, value: number) => {
        slot = value;
      },
    } as unknown as TestProject;
    const release = await claimRunSlot(other);
    try {
      expect(slot).toBeTypeOf('number');
      expect(slot).not.toBe(inject('lockSlot'));
    } finally {
      await release();
    }
  });

  it('never meet a port this system hands out by itself', async () => {
    const servers: net.Server[] = [];
    try {
      for (let i = 0; i < 50; i++) {
        const server = net.createServer();
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        servers.push(server);
      }
      for (const server of servers) expect((server.address() as net.AddressInfo).port).toBeGreaterThan(32767);
    } finally {
      await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    }
  });

  it('are the ones Eve claims hold', async () => {
    const directory = dataPath('runtime', 'eve', 'port-check');
    const eve = await claimEveRuntime(directory);
    expect(eveOwnershipPort(directory)).toBeLessThanOrEqual(32767);
    expect(await free(eveOwnershipPort(directory))).toBe(false);
    await eve();
  });
});
