// Webhooks (shared/api/webhooks.ts). server/webhooks/ cleans what comes in and refuses with a status.
import { implement } from '@orpc/server';
import { webhooks as contract } from '../../shared/api/webhooks.ts';
import * as hooks from '../webhooks/hooks.ts';
import { runAgain } from '../webhooks/intake.ts';
import { refusing } from './refuse.ts';

const os = implement(contract);

export const webhooksRouter = os.router({
  list: os.list.handler(({ input }) => hooks.listWebhooks(input.routineId || undefined)),
  create: os.create.handler(({ input }) => refusing(() => hooks.createWebhook(input))),
  change: os.change.handler(({ input: { id, ...patch } }) => refusing(() => hooks.changeWebhook(id, patch))),
  remove: os.remove.handler(async ({ input }) => (await hooks.removeWebhook(input.id), { ok: true as const })),
  newAddress: os.newAddress.handler(({ input }) => refusing(() => hooks.newAddress(input.id))),
  newSecret: os.newSecret.handler(({ input }) => refusing(() => hooks.newSecret(input.id, input.secret))),
  deliveries: os.deliveries.handler(({ input }) => refusing(() => hooks.listDeliveries(input.id))),
  removeBodies: os.removeBodies.handler(({ input }) =>
    refusing(() => (hooks.getWebhook(input.id), hooks.removeBodies(input.id), { ok: true as const })),
  ),
  runAgain: os.runAgain.handler(({ input }) => refusing(() => runAgain(input.id))),
  test: os.test.handler(({ input }) => refusing(() => hooks.testWebhook(input.id))),
  status: os.status.handler(() => hooks.webhookStatus()),
  setup: os.setup.handler(({ input }) => refusing(() => hooks.setupWebhooks(input))),
  check: os.check.handler(() => hooks.checkNow()),
  seen: os.seen.handler(() => hooks.addressesSeen()),
  address: os.address.handler(({ input }) => refusing(() => ({ address: hooks.showAddress(input.id) }))),
});
