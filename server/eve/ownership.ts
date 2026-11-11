import net from 'node:net';
import { once } from 'node:events';
import { DATA, IS_WIN, isInside, realTarget } from '../util.ts';
import { ownershipPort } from '../ownershipport.ts';
import { privateDataPath } from '../private.ts';

export class EveOwnershipError extends Error {
  constructor() {
    super(
      'Eve cannot claim its private ownership port. Close the other dashboard using this data folder, or check which local program is using that port.',
    );
    this.name = 'EveOwnershipError';
  }
}

export function eveOwnershipPort(directory: string): number {
  const root = realTarget(DATA);
  const target = realTarget(directory);
  if (!root || !target || !isInside(root, target)) throw new Error('Eve ownership must stay under the data folder.');
  return ownershipPort(IS_WIN ? target.toLowerCase() : target);
}

/** A kernel-held lease has no stale file to steal. A port collision fails closed. */
export async function claimEveRuntime(
  directory = privateDataPath('runtime', 'eve', 'worker'),
): Promise<() => Promise<void>> {
  const server = net.createServer((socket) => socket.destroy());
  try {
    server.listen({ host: '127.0.0.1', port: eveOwnershipPort(directory), exclusive: true });
    await once(server, 'listening');
  } catch {
    server.close();
    throw new EveOwnershipError();
  }
  server.unref();
  let closing: Promise<void> | undefined;
  return () => (closing ??= new Promise<void>((resolve) => server.close(() => resolve())));
}
