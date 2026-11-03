import { Chat } from 'chat';
import type { Logger } from 'chat';
import { getGatewaySecrets } from '../store.ts';
import { WhatsAppGatewayAdapter } from './whatsapp.ts';
import { WhatsAppRelayConsumer, WhatsAppRelayError } from './whatsapp-relay.ts';
import { GatewaySetupError } from './telegram.ts';
import type { GatewayStateAdapter } from './state.ts';
import type { GatewayInbox } from './inbox.ts';
import type { Transport } from './worker.ts';

const quiet: Logger = { child: () => quiet, debug() {}, info() {}, warn() {}, error() {} };

export function whatsAppTransport(state: GatewayStateAdapter, inbox: GatewayInbox, activity: (connected: boolean) => void, signal: AbortSignal,
  options: { testOrigin?: string; request?: (url: string, init: RequestInit) => Promise<Response> } = {}): Transport {
  const { accessToken, signingSecret, relayKey, whatsappPairing } = getGatewaySecrets(state.instanceId);
  if (whatsappPairing !== undefined) throw new GatewaySetupError('Finish or review the pending WhatsApp pairing before connecting.');
  const connection = inbox.whatsAppRelayState()?.connection;
  if (!accessToken || !signingSecret || !relayKey) throw new GatewaySetupError('Add the WhatsApp access token, app secret and relay pull key before connecting.');
  if (!connection) throw new WhatsAppRelayError('setup');
  const relay = new WhatsAppRelayConsumer({ inbox, token: relayKey, appSecret: signingSecret, signal, request: options.request,
    onDisconnect: () => activity(false) });
  const whatsapp = new WhatsAppGatewayAdapter(state.instanceId, inbox,
    { businessAccountId: connection.businessAccountId, accessToken, appSecret: signingSecret }, { signal, testOrigin: options.testOrigin });
  const chat = new Chat({ userName: 'Athena', adapters: { whatsapp }, state, logger: quiet, concurrency: 'concurrent' });
  return {
    start: async () => { await chat.initialize(); signal.throwIfAborted(); await relay.start(); },
    stop: async () => { await relay.stop(); await whatsapp.disconnect(); await chat.shutdown(); },
    alive: () => relay.alive(), failure: () => relay.failure(),
    download: (id, maxBytes, signal, event) => whatsapp.downloadFileSource(id, maxBytes, signal, event),
    reply: (event, text, signal) => whatsapp.replyText(event, text, signal),
    upload: (event, file, signal) => whatsapp.replyDocument(event, file, signal),
  };
}
