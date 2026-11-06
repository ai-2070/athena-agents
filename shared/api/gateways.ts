// Gateways (server/api/gateways.ts): the Telegram, Discord, Slack and WhatsApp connections, their inboxes, and
// reviewing what they received and what they send. Every body here is checked by server/gateways/ with its own
// strict schemas (a review's revision, what you acknowledged), so it is passed on exactly as it came: those routes
// take { params, body } (inputStructure 'detailed'), and the contract only says the body is a JSON object.
import { oc, type } from '@orpc/contract';
import { z } from 'zod';
import type {
  GatewayDeliveryReview, GatewayDiscordRecovery, GatewayHealth, GatewayInboxEvent, GatewayInstance, GatewayListing, GatewayReconciliation, GatewayRequestReview,
  GatewayRetiredFinishReview, GatewayRetiredInstance, GatewayTargets, GatewayTelegramSetup, GatewayWhatsAppCheck, GatewayWhatsAppRecovery,
  GatewayWhatsAppReplacement, GatewayWhatsAppSenders, GatewayWhatsAppSetup, GatewayWorkReview,
} from '../types.ts';

/** What the gateway code reads and checks itself, as it came: server/rpc.ts already reads no body as {} and
 *  refuses null or a bare value, as the old routes did. */
const gatewayBody = z.unknown();
const one = { id: z.string() };
const event = { id: z.string(), eventId: z.string() };
/** A route whose body goes to the gateway code as it came (the Outbox's gateway deliveries use these too). */
export const post = (path: `/${string}`) => oc.route({ method: 'POST', path, inputStructure: 'detailed' });
export const withBody = <P extends z.ZodRawShape>(params: P) => z.object({ params: z.object(params), body: gatewayBody });
const ok = type<{ ok: true }>();

export const gateways = {
  list: oc.route({ method: 'GET', path: '/gateways' }).output(type<{ instances: GatewayListing[]; health: GatewayHealth[] }>()),
  create: post('/gateways').input(z.object({ body: gatewayBody })).output(type<GatewayInstance>()),
  change: oc.route({ method: 'PUT', path: '/gateways/{id}', inputStructure: 'detailed' }).input(withBody(one)).output(type<GatewayInstance>()),
  remove: oc.route({ method: 'DELETE', path: '/gateways/{id}' }).input(z.object(one)).output(ok),
  /** Saves its secrets (all of them), or changes some; only which ones are saved comes back. */
  setCredentials: oc.route({ method: 'PUT', path: '/gateways/{id}/credentials', inputStructure: 'detailed' }).input(withBody(one)).output(type<Record<string, boolean>>()),
  updateCredentials: post('/gateways/{id}/credentials').input(withBody(one)).output(type<Record<string, boolean>>()),
  reconnect: oc.route({ method: 'POST', path: '/gateways/{id}/reconnect' }).input(z.object(one)).output(ok),
  /** The agents and teams of a project a connection can answer as. */
  targets: oc.route({ method: 'GET', path: '/gateways/targets/{projectId}' }).input(z.object({ projectId: z.string() })).output(type<GatewayTargets>()),
  inbox: {
    list: oc.route({ method: 'GET', path: '/gateways/{id}/inbox' }).input(z.object(one)).output(type<{ events: GatewayInboxEvent[] }>()),
    cleanup: post('/gateways/{id}/inbox/cleanup').input(withBody(one)).output(type<{ removed: number }>()),
    review: oc.route({ method: 'GET', path: '/gateways/{id}/inbox/{eventId}/review' }).input(z.object(event)).output(type<GatewayRequestReview>()),
    dismiss: post('/gateways/{id}/inbox/{eventId}/dismiss').input(withBody(event)).output(ok),
    workReview: oc.route({ method: 'GET', path: '/gateways/{id}/inbox/{eventId}/work-review' }).input(z.object(event)).output(type<GatewayWorkReview>()),
    prepareWorkReview: oc.route({ method: 'POST', path: '/gateways/{id}/inbox/{eventId}/work-review/prepare' }).input(z.object(event)).output(type<GatewayWorkReview>()),
    keepWork: post('/gateways/{id}/inbox/{eventId}/work-review/keep').input(withBody(event)).output(type<GatewayWorkReview>()),
    deliveryReview: oc.route({ method: 'GET', path: '/gateways/{id}/inbox/{eventId}/delivery-review' }).input(z.object(event)).output(type<GatewayDeliveryReview>()),
    prepareDeliveryReview: oc.route({ method: 'POST', path: '/gateways/{id}/inbox/{eventId}/delivery-review/prepare' }).input(z.object(event)).output(type<GatewayDeliveryReview>()),
    reviewDelivery: post('/gateways/{id}/inbox/{eventId}/delivery-review').input(withBody(event)).output(type<GatewayDeliveryReview>()),
    retryFiles: oc.route({ method: 'POST', path: '/gateways/{id}/inbox/{eventId}/retry-files' }).input(z.object(event)).output(ok),
    retryReply: oc.route({ method: 'POST', path: '/gateways/{id}/inbox/{eventId}/retry-reply' }).input(z.object(event)).output(ok),
    reconcile: oc.route({ method: 'POST', path: '/gateways/{id}/inbox/{eventId}/reconcile' }).input(z.object(event)).output(type<GatewayReconciliation>()),
    groupAlbum: post('/gateways/{id}/inbox/{eventId}/group-album').input(withBody(event)).output(type<{ leaderId: string }>()),
    /** Which of a message's files to take, and retrying or skipping one (index as the review lists it). */
    selectFiles: post('/gateways/{id}/inbox/{eventId}/files').input(withBody(event)).output(ok),
    retryFile: oc.route({ method: 'POST', path: '/gateways/{id}/inbox/{eventId}/files/{index}/retry' }).input(z.object({ ...event, index: z.string() })).output(ok),
    skipFile: oc.route({ method: 'POST', path: '/gateways/{id}/inbox/{eventId}/files/{index}/skip' }).input(z.object({ ...event, index: z.string() })).output(ok),
  },
  telegram: {
    setup: oc.route({ method: 'GET', path: '/gateways/{id}/telegram-setup' }).input(z.object(one)).output(type<GatewayTelegramSetup>()),
    check: oc.route({ method: 'POST', path: '/gateways/{id}/telegram-setup/check' }).input(z.object(one)).output(type<GatewayTelegramSetup>()),
    switchToPolling: post('/gateways/{id}/telegram-setup/switch').input(withBody(one)).output(type<GatewayTelegramSetup>()),
  },
  discord: {
    recovery: oc.route({ method: 'GET', path: '/gateways/{id}/discord-recovery' }).input(z.object(one)).output(type<GatewayDiscordRecovery>()),
    reviewRecovery: post('/gateways/{id}/discord-recovery').input(withBody(one)).output(type<{ gap: null }>()),
  },
  whatsapp: {
    setup: oc.route({ method: 'GET', path: '/gateways/{id}/whatsapp-setup' }).input(z.object(one)).output(type<GatewayWhatsAppSetup>()),
    check: oc.route({ method: 'POST', path: '/gateways/{id}/whatsapp-setup/check' }).input(z.object(one)).output(type<GatewayWhatsAppCheck>()),
    recovery: oc.route({ method: 'GET', path: '/gateways/{id}/whatsapp-recovery' }).input(z.object(one)).output(type<GatewayWhatsAppRecovery>()),
    inspectRecovery: oc.route({ method: 'POST', path: '/gateways/{id}/whatsapp-recovery/inspect' }).input(z.object(one)).output(type<GatewayWhatsAppRecovery>()),
    reviewRecovery: post('/gateways/{id}/whatsapp-recovery').input(withBody(one)).output(type<GatewayWhatsAppRecovery>()),
    restoreRecovery: post('/gateways/{id}/whatsapp-recovery/restore').input(withBody(one)).output(type<GatewayWhatsAppRecovery>()),
    replacement: oc.route({ method: 'GET', path: '/gateways/{id}/whatsapp-replacement' }).input(z.object(one)).output(type<GatewayWhatsAppReplacement>()),
    senders: oc.route({ method: 'GET', path: '/gateways/{id}/whatsapp-senders' }).input(z.object(one)).output(type<GatewayWhatsAppSenders>()),
    reviewSender: post('/gateways/{id}/whatsapp-senders/review').input(withBody(one)).output(type<GatewayWhatsAppSenders>()),
    pair: post('/gateways/{id}/whatsapp-pairing').input(withBody(one)).output(type<GatewayWhatsAppSetup>()),
    replacePairing: post('/gateways/{id}/whatsapp-pairing/replace').input(withBody(one)).output(type<GatewayWhatsAppSetup>()),
    finishPairing: post('/gateways/{id}/whatsapp-pairing/finish').input(withBody(one)).output(type<GatewayWhatsAppSetup>()),
    reviewPairing: post('/gateways/{id}/whatsapp-pairing/review').input(withBody(one)).output(type<GatewayWhatsAppSetup>()),
  },
  /** Connections that were removed, kept until what they owed is finished locally. */
  retired: {
    list: oc.route({ method: 'GET', path: '/gateways/retired' }).output(type<{ instances: GatewayRetiredInstance[] }>()),
    inbox: oc.route({ method: 'GET', path: '/gateways/retired/{id}/inbox' }).input(z.object(one)).output(type<{ events: GatewayInboxEvent[] }>()),
    finishReview: oc.route({ method: 'GET', path: '/gateways/retired/{id}/inbox/{eventId}/local-finish' }).input(z.object(event)).output(type<GatewayRetiredFinishReview>()),
    prepareFinish: post('/gateways/retired/{id}/inbox/{eventId}/local-finish/prepare').input(withBody(event)).output(type<GatewayRetiredFinishReview>()),
    finish: post('/gateways/retired/{id}/inbox/{eventId}/local-finish').input(withBody(event)).output(type<GatewayRetiredFinishReview>()),
  },
};
