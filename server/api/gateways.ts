// Gateways (shared/api/gateways.ts). Every body goes to server/gateways/ as it came ({} when there is none, as the old
// routes passed it); that code checks it and refuses with its own status, unchanged here.
import { implement } from '@orpc/server';
import { gateways as contract } from '../../shared/api/gateways.ts';
import * as instances from '../gateways/instances.ts';
import { discordRecovery } from '../gateways/discord-recovery.ts';
import { whatsAppSetup } from '../gateways/whatsapp-setup.ts';
import { telegramSetup } from '../gateways/telegram-setup.ts';
import { gatewaySupervisor as supervisor } from '../gateways/live.ts';
import { gatewayDeliveryReview, gatewayInboxHistory, gatewayRequestReview, gatewayRetiredFinishReview, gatewayRetiredInboxHistory, gatewayWhatsAppRecovery, gatewayWhatsAppReplacement, gatewayWhatsAppSenders, gatewayWorkReview } from '../gateways/inbox.ts';
import { listGatewayRetirements } from '../gateways/retirement.ts';

const os = implement(contract);
const ok = { ok: true as const };
// a file's place in a message's list ("2"); anything else is no file
const fileIndex = (index: string): number => (/^\d+$/.test(index) ? Number(index) : -1);

export const gatewaysRouter = os.router({
  list: os.list.handler(() => ({
    instances: instances.listGatewayInstances().map((instance) => ({ ...instance, targetName: instances.gatewayTargetName(instance), credentials: instances.gatewayCredentialStatus(instance.id) })),
    health: supervisor.health(),
  })),
  create: os.create.handler(({ input }) => instances.saveGatewayInstance(input.body)),
  change: os.change.handler(({ input }) => instances.saveGatewayInstance(input.body, input.params.id)),
  remove: os.remove.handler(async ({ input }) => (await supervisor.removeInstance(input.id), ok)),
  setCredentials: os.setCredentials.handler(({ input }) => {
    instances.saveGatewayCredentials(input.params.id, input.body);
    return instances.gatewayCredentialStatus(input.params.id);
  }),
  updateCredentials: os.updateCredentials.handler(({ input }) => {
    instances.updateGatewayCredentials(input.params.id, input.body);
    return instances.gatewayCredentialStatus(input.params.id);
  }),
  reconnect: os.reconnect.handler(async ({ input }) => {
    instances.getGatewayInstance(input.id);
    await supervisor.reconnect(input.id);
    return ok;
  }),
  targets: os.targets.handler(({ input }) => instances.gatewayTargets(input.projectId)),
  inbox: {
    list: os.inbox.list.handler(({ input }) => ({ events: gatewayInboxHistory(input.id) })),
    cleanup: os.inbox.cleanup.handler(({ input }) => supervisor.cleanup(input.params.id, input.body)),
    review: os.inbox.review.handler(({ input }) => gatewayRequestReview(input.id, input.eventId)),
    dismiss: os.inbox.dismiss.handler(async ({ input: { params, body: b } }) => (await supervisor.dismissRequest(params.id, params.eventId, b), ok)),
    workReview: os.inbox.workReview.handler(({ input }) => gatewayWorkReview(input.id, input.eventId)),
    prepareWorkReview: os.inbox.prepareWorkReview.handler(({ input }) => supervisor.prepareWorkReview(input.id, input.eventId)),
    keepWork: os.inbox.keepWork.handler(({ input: { params, body: b } }) => supervisor.keepWork(params.id, params.eventId, b)),
    deliveryReview: os.inbox.deliveryReview.handler(({ input }) => gatewayDeliveryReview(input.id, input.eventId)),
    prepareDeliveryReview: os.inbox.prepareDeliveryReview.handler(({ input }) => supervisor.prepareDeliveryReview(input.id, input.eventId)),
    reviewDelivery: os.inbox.reviewDelivery.handler(({ input: { params, body: b } }) => supervisor.reviewDelivery(params.id, params.eventId, b)),
    retryFiles: os.inbox.retryFiles.handler(({ input }) => (supervisor.retryFiles(input.id, input.eventId), ok)),
    retryReply: os.inbox.retryReply.handler(({ input }) => (supervisor.retryReply(input.id, input.eventId), ok)),
    reconcile: os.inbox.reconcile.handler(({ input }) => supervisor.reconcile(input.id, input.eventId)),
    groupAlbum: os.inbox.groupAlbum.handler(({ input: { params, body: b } }) => supervisor.groupAlbum(params.id, params.eventId, b)),
    selectFiles: os.inbox.selectFiles.handler(async ({ input: { params, body: b } }) => (await supervisor.selectDocuments(params.id, params.eventId, b), ok)),
    retryFile: os.inbox.retryFile.handler(({ input }) => (supervisor.changeDocument(input.id, input.eventId, fileIndex(input.index), 'retry'), ok)),
    skipFile: os.inbox.skipFile.handler(({ input }) => (supervisor.changeDocument(input.id, input.eventId, fileIndex(input.index), 'skip'), ok)),
  },
  telegram: {
    setup: os.telegram.setup.handler(({ input }) => telegramSetup(input.id)),
    check: os.telegram.check.handler(({ input }) => supervisor.checkTelegramSetup(input.id)),
    switchToPolling: os.telegram.switchToPolling.handler(({ input }) => supervisor.switchTelegramToPolling(input.params.id, input.body)),
  },
  discord: {
    recovery: os.discord.recovery.handler(({ input }) => discordRecovery(input.id)),
    reviewRecovery: os.discord.reviewRecovery.handler(async ({ input }) => {
      await supervisor.reviewDiscordRecovery(input.params.id, input.body);
      return { gap: null };
    }),
  },
  whatsapp: {
    setup: os.whatsapp.setup.handler(({ input }) => whatsAppSetup(input.id)),
    check: os.whatsapp.check.handler(({ input }) => supervisor.checkWhatsAppSetup(input.id)),
    recovery: os.whatsapp.recovery.handler(({ input }) => gatewayWhatsAppRecovery(input.id)),
    inspectRecovery: os.whatsapp.inspectRecovery.handler(({ input }) => supervisor.inspectWhatsAppRecovery(input.id)),
    reviewRecovery: os.whatsapp.reviewRecovery.handler(({ input }) => supervisor.reviewWhatsAppRecovery(input.params.id, input.body)),
    restoreRecovery: os.whatsapp.restoreRecovery.handler(({ input }) => supervisor.restoreWhatsAppRecovery(input.params.id, input.body)),
    replacement: os.whatsapp.replacement.handler(({ input }) => gatewayWhatsAppReplacement(input.id)),
    senders: os.whatsapp.senders.handler(({ input }) => gatewayWhatsAppSenders(input.id)),
    reviewSender: os.whatsapp.reviewSender.handler(({ input }) => supervisor.reviewWhatsAppSender(input.params.id, input.body)),
    pair: os.whatsapp.pair.handler(({ input }) => supervisor.pairWhatsApp(input.params.id, input.body)),
    replacePairing: os.whatsapp.replacePairing.handler(({ input }) => supervisor.replaceWhatsAppPairing(input.params.id, input.body)),
    finishPairing: os.whatsapp.finishPairing.handler(({ input }) => supervisor.finishWhatsAppPairing(input.params.id, input.body)),
    reviewPairing: os.whatsapp.reviewPairing.handler(({ input }) => supervisor.reviewWhatsAppPairing(input.params.id, input.body)),
  },
  retired: {
    list: os.retired.list.handler(() => ({ instances: listGatewayRetirements() })),
    inbox: os.retired.inbox.handler(({ input }) => ({ events: gatewayRetiredInboxHistory(input.id) })),
    finishReview: os.retired.finishReview.handler(({ input }) => gatewayRetiredFinishReview(input.id, input.eventId)),
    prepareFinish: os.retired.prepareFinish.handler(({ input: { params, body: b } }) => supervisor.prepareRetiredFinish(params.id, params.eventId, b)),
    finish: os.retired.finish.handler(({ input: { params, body: b } }) => supervisor.finishRetired(params.id, params.eventId, b)),
  },
});
