// The lock ports for gateway state and the Eve worker (server/ownershipport.ts) stay clear of the ports systems hand
// out by themselves, so an unrelated socket can't make a claim fail; in tests, two folders never share one.
import { once } from 'node:events';
import net from 'node:net';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { OWNERSHIP_PORT_COUNT, OWNERSHIP_PORT_FIRST, hashedPort, ownershipPort } from '../../server/ownershipport.ts';
import type { TestLockPorts } from '../../server/ownershipport.ts';
import { claimGatewayAccount, claimGatewayState, gatewayOwnershipPort, gatewayStateDirectory } from '../../server/gateways/ownership.ts';
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
    const ports = Array.from({ length: 5000 }, (_, i) => hashedPort(path.join('/data', 'gateways-runtime', `instance-${i}`)));
    expect(Math.min(...ports)).toBeGreaterThanOrEqual(OWNERSHIP_PORT_FIRST);
    expect(Math.max(...ports)).toBeLessThanOrEqual(32767);
    // the whole range gets used, so two folders rarely share a port
    expect(new Set(ports).size).toBeGreaterThan(4000);
    expect(hashedPort('/data/x')).toBe(hashedPort('/data/x'));
  });

  it('in tests, come from this test worker\'s own block, one key per port', () => {
    const block = JSON.parse(process.env.DASH_TEST_LOCK_PORTS!) as TestLockPorts;
    expect(block.count).toBe(1024);
    expect(block.first).toBeGreaterThanOrEqual(OWNERSHIP_PORT_FIRST);
    expect(block.first + block.count - 1).toBeLessThanOrEqual(32767);
    const keys = Array.from({ length: 40 }, (_, i) => path.join('/data', 'gateways-runtime', `block-${i}`));
    const ports = keys.map(ownershipPort);
    expect(new Set(ports).size).toBe(40);
    for (const port of ports) expect(port).toBeGreaterThanOrEqual(block.first), expect(port).toBeLessThan(block.first + block.count);
    expect(keys.map(ownershipPort)).toEqual(ports);
  });

  it("never meet a port this system hands out by itself", async () => {
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

  it('are the ones gateway and Eve claims hold', async () => {
    const state = await claimGatewayState('port-check');
    const port = gatewayOwnershipPort(gatewayStateDirectory('port-check'));
    expect(port).toBeLessThanOrEqual(32767);
    expect(await free(port)).toBe(false);
    await state();
    expect(await free(port)).toBe(true);
    const account = await claimGatewayAccount('telegram', 'port-check');
    await account();
    const directory = dataPath('runtime', 'eve', 'port-check');
    const eve = await claimEveRuntime(directory);
    expect(eveOwnershipPort(directory)).toBeLessThanOrEqual(32767);
    expect(await free(eveOwnershipPort(directory))).toBe(false);
    await eve();
  });
});
