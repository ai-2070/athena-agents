import crypto from 'node:crypto';
import { z } from 'zod';
import type { GatewayDiscordRecovery, GatewayDiscordState } from '../../shared/types.ts';
import { privateDataPath } from '../private.ts';
import { writeJSON } from '../util.ts';
import { getGatewayInstance } from './instances.ts';
import { discordStateSchema, readDiscordGatewayState } from './discord-gateway.ts';
import type { GatewayStateAdapter } from './state.ts';

const fail = (message: string, status = 400): never => {
  throw Object.assign(new Error(message), { status });
};
const revision = (saved: GatewayDiscordState) =>
  crypto
    .createHash('sha256')
    .update(JSON.stringify([saved.accountId, saved.intents, saved.session, saved.gap]))
    .digest('hex');

export function discordRecovery(instanceId: string): GatewayDiscordRecovery {
  const instance = getGatewayInstance(instanceId);
  if (instance.platform !== 'discord') return fail('Choose a Discord instance.');
  try {
    const saved = readDiscordGatewayState(
      privateDataPath('gateways-runtime', instanceId, 'discord-gateway.json'),
      instance.accountId,
    );
    return { gap: saved.gap ? { at: saved.gap.at, revision: revision(saved) } : null };
  } catch {
    return fail('Discord recovery state is unreadable. Restore it before reviewing a new session.', 503);
  }
}

/** Ownership is held by the supervisor; acknowledging a gap never reconnects or restarts native work. */
export function reviewDiscordRecovery(state: GatewayStateAdapter, body: unknown): GatewayDiscordRecovery {
  const parsed = z
    .strictObject({ revision: z.string().regex(/^[a-f0-9]{64}$/), acknowledgeGap: z.literal(true) })
    .safeParse(body);
  if (!parsed.success)
    return fail('Review the saved Discord gap and acknowledge that missed messages cannot be recovered.');
  const instance = getGatewayInstance(state.instanceId);
  if (instance.platform !== 'discord' || instance.enabled)
    return fail('Pause this Discord instance before reviewing its recovery gap.');
  let saved: GatewayDiscordState;
  try {
    saved = readDiscordGatewayState(state.discordGatewayFile(), instance.accountId);
  } catch {
    return fail('Discord recovery state is unreadable. Restore it before reviewing a new session.', 503);
  }
  if (!saved.gap || !saved.session || revision(saved) !== parsed.data.revision)
    return fail('This Discord gap changed. Reload and review it again.', 409);
  const reviewedGaps = [
    ...(saved.reviewedGaps ?? []),
    { at: Date.now(), gapAt: saved.gap.at, sequence: saved.session.sequence, revision: parsed.data.revision },
  ];
  const next = discordStateSchema.safeParse({ ...saved, reviewedGaps, gap: undefined, session: undefined });
  if (!next.success) return fail('The saved recovery reviews need attention before starting another session.', 409);
  writeJSON(state.discordGatewayFile(), next.data);
  return { gap: null };
}
