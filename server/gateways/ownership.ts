import crypto from 'node:crypto';
import net from 'node:net';
import { once } from 'node:events';
import { IS_WIN, realTarget } from '../util.ts';
import { privateDataPath } from '../private.ts';
import type { GatewayPlatform } from '../../shared/types.ts';

export function gatewayStateDirectory(instanceId: string): string {
  if (!/^[a-zA-Z0-9_-]{1,200}$/.test(instanceId)) throw new Error('Invalid gateway instance ID.');
  return privateDataPath('gateways-runtime', instanceId);
}

function ownershipPort(location: string): number {
  const directory = realTarget(location);
  if (!directory) throw new Error('Cannot resolve the gateway state folder.');
  const key = IS_WIN ? directory.toLowerCase() : directory;
  return 16384 + crypto.createHash('sha256').update(key).digest().readUInt32BE(0) % 49152;
}

/** A kernel-held claim releases on process death; a port collision fails closed. */
export async function claimGatewayState(instanceId: string): Promise<() => Promise<void>> {
  return claimDirectory(gatewayStateDirectory(instanceId));
}

/** Account claims also guard against two instance records created by competing dashboard processes. */
export function claimGatewayAccount(platform: GatewayPlatform, accountId: string): Promise<() => Promise<void>> {
  const key = crypto.createHash('sha256').update(JSON.stringify([platform, accountId])).digest('hex');
  return claimDirectory(privateDataPath('gateways-accounts', key));
}

async function claimDirectory(directory: string): Promise<() => Promise<void>> {
  const server = net.createServer((socket) => socket.destroy());
  try {
    server.listen({ host: '127.0.0.1', port: ownershipPort(directory), exclusive: true });
    await once(server, 'listening');
  } catch {
    server.close();
    throw new Error('Cannot claim this gateway instance. Another worker or local program owns its private ownership port.');
  }
  server.unref();
  let closing: Promise<void> | undefined;
  return () => closing ??= new Promise<void>((resolve) => server.close(() => resolve()));
}
