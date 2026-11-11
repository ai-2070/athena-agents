import { Chat } from 'chat';
import type { Logger } from 'chat';
import { getGatewaySecrets } from '../store.ts';
import { getGatewayInstance } from './instances.ts';
import { GatewaySetupError } from './telegram.ts';
import { DiscordIntakeAdapter } from './discord.ts';
import { checkDiscordGatewayState } from './discord-gateway.ts';
import type { DiscordGateway } from './discord-gateway.ts';
import type { GatewayStateAdapter } from './state.ts';
import type { GatewayInbox } from './inbox.ts';
import type { Transport } from './worker.ts';

const quiet: Logger = { child: () => quiet, debug() {}, info() {}, warn() {}, error() {} };

export function discordTransport(
  state: GatewayStateAdapter,
  inbox: GatewayInbox,
  activity: (connected: boolean) => void,
  signal: AbortSignal,
  options: { apiUrl?: string; fileOrigin?: string; testOrigin?: string } = {},
): Transport {
  const botToken = getGatewaySecrets(state.instanceId).botToken;
  if (!botToken) throw new GatewaySetupError('Add a Discord bot token before connecting.');
  const discord = new DiscordIntakeAdapter(state.instanceId, inbox, botToken, {
    signal,
    apiUrl: options.apiUrl,
    fileOrigin: options.fileOrigin,
  });
  const chat = new Chat({ userName: 'Athena', adapters: { discord }, state, logger: quiet, concurrency: 'concurrent' });
  let gateway: DiscordGateway | undefined;
  let failure: Error | undefined;
  return {
    start: async () => {
      checkDiscordGatewayState(state, getGatewayInstance(state.instanceId).accountId, options.testOrigin);
      await chat.initialize();
      gateway = discord.createGateway(state, {
        testOrigin: options.testOrigin,
        onDisconnect: (error) => {
          failure ??= error;
          activity(false);
        },
      });
      await gateway.start();
    },
    stop: async () => {
      await gateway?.stop();
      await discord.disconnect();
      await chat.shutdown();
    },
    alive: () => gateway?.alive === true,
    failure: () => failure,
    download: (id, maxBytes, signal, event) => discord.downloadFileSource(id, maxBytes, signal, event),
    reply: (event, text, signal, approved) => discord.replyText(event, text, signal, approved),
    upload: (event, file, signal) => discord.replyDocument(event, file, signal),
  };
}
