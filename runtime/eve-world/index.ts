import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { reenqueueActiveRuns } from '@workflow/world';
import type { LocalWorld } from '@workflow/world-local';

export default async function createWorld() {
  // Keep this import at runtime: Eve's compiler otherwise inlines package-relative files.
  const specifier = ['@workflow', 'world-local'].join('/');
  const module: typeof import('@workflow/world-local') = await import(specifier);
  const world = module.createWorld({
    dataDir: path.join(process.cwd(), '.eve', '.workflow-data'),
    recoverActiveRuns: false,
  });
  return secureWorld(world);
}

/** Custom worlds must protect internal queue deliveries and wake saved work themselves. */
export function secureWorld(world: LocalWorld): LocalWorld {
  const token = randomBytes(32).toString('hex');
  const header = 'x-athena-eve-delivery';
  const secured: typeof world = {
    ...world,
    queue: (name, message, options) =>
      world.queue(name, message, { ...options, headers: { ...options?.headers, [header]: token } }),
    createQueueHandler: (prefix, handler) => {
      const consume = world.createQueueHandler(prefix, handler);
      return (request) => {
        const supplied = Buffer.from(request.headers.get(header) || '');
        const expected = Buffer.from(token);
        return supplied.length === expected.length && timingSafeEqual(supplied, expected)
          ? consume(request)
          : Promise.resolve(new Response(null, { status: 401 }));
      };
    },
    start: async () => {
      await world.start?.();
      await reenqueueActiveRuns(world.runs, secured.queue, 'athena-eve-world');
    },
  };
  return secured;
}
