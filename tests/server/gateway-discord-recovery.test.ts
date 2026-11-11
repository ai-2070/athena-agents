import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { GatewayDiscordState } from '../../shared/types.ts';
import { discordGatewayIntents } from '../../server/gateways/discord-gateway.ts';
import { discordRecovery, reviewDiscordRecovery } from '../../server/gateways/discord-recovery.ts';
import { saveGatewayInstance } from '../../server/gateways/instances.ts';
import { GatewayStateAdapter } from '../../server/gateways/state.ts';
import { GatewaySupervisor } from '../../server/gateways/supervisor.ts';
import { GatewayInbox } from '../../server/gateways/inbox.ts';
import { gatewayConfig } from './gateway-fixtures.ts';

const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
});
let account = 700000000000000000n;
async function fixture() {
  const config = {
    ...gatewayConfig(String(account++)),
    platform: 'discord',
    senderPolicy: { platform: 'discord', allowedUserIds: [] },
    scope: { directMessages: true, conversationIds: [], guildIds: [] },
  };
  const instance = saveGatewayInstance(config);
  const state = new GatewayStateAdapter(instance.id);
  await state.connect();
  closes.push(() => state.disconnect());
  const inbox = new GatewayInbox(state);
  inbox.accept({
    platform: 'discord',
    accountId: instance.accountId,
    conversationId: '100000000000000001',
    threadId: '',
    sourceMessageId: '200000000000000001',
    sourceEventId: 'saved',
    actor: { id: '300000000000000001', label: 'Alice', kind: 'user' },
    directMessage: true,
    triggered: false,
    kind: 'message',
    text: 'Saved request',
    media: [],
  });
  saveGatewayInstance({ ...config, enabled: false }, instance.id);
  const saved: GatewayDiscordState = {
    version: 1,
    accountId: instance.accountId,
    intents: discordGatewayIntents,
    identifiedAt: Date.now() - 20000,
    retryAt: Date.now() + 7000,
    session: { id: 'PRIVATE_SESSION_ID', url: 'wss://gateway-us-east1-b.discord.gg/', sequence: 47 },
    gap: { at: Date.now() - 1000, reason: 'session-lost' },
  };
  const file = state.discordGatewayFile();
  fs.writeFileSync(file, JSON.stringify(saved));
  const request = () => ({ revision: discordRecovery(instance.id).gap!.revision, acknowledgeGap: true });
  return { config, instance, state, inbox, saved, file, request };
}

describe('explicit Discord recovery review', () => {
  it('previews only an opaque revision and date, then records the paused review without changing saved work', async () => {
    const f = await fixture();
    const before = fs.readFileSync(f.state.inboxFile(), 'utf8');
    const preview = discordRecovery(f.instance.id);
    expect(preview.gap).toMatchObject({ at: f.saved.gap!.at, revision: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(JSON.stringify(preview)).not.toContain('PRIVATE_');
    expect(JSON.stringify(preview)).not.toContain('discord.gg');
    expect(preview.gap).not.toHaveProperty('sequence');
    expect(reviewDiscordRecovery(f.state, f.request())).toEqual({ gap: null });
    const after = JSON.parse(fs.readFileSync(f.file, 'utf8')) as GatewayDiscordState;
    expect(after.session).toBeUndefined();
    expect(after.gap).toBeUndefined();
    expect(after.retryAt).toBe(f.saved.retryAt);
    expect(after.identifiedAt).toBe(f.saved.identifiedAt);
    expect(after.reviewedGaps).toEqual([
      { at: expect.any(Number), gapAt: f.saved.gap!.at, sequence: 47, revision: preview.gap!.revision },
    ]);
    expect(fs.readFileSync(f.state.inboxFile(), 'utf8')).toBe(before);
    expect(discordRecovery(f.instance.id)).toEqual({ gap: null });
  });

  it('requires a current explicit acknowledgement and refuses changes to a running instance', async () => {
    const f = await fixture();
    const original = fs.readFileSync(f.file, 'utf8');
    for (const body of [
      {},
      { revision: f.request().revision },
      { ...f.request(), acknowledgeGap: false },
      { ...f.request(), session: 'invented' },
      { ...f.request(), revision: 'a'.repeat(64) },
    ]) {
      expect(() => reviewDiscordRecovery(f.state, body)).toThrow();
      expect(fs.readFileSync(f.file, 'utf8')).toBe(original);
    }
    const body = f.request();
    saveGatewayInstance(f.config, f.instance.id);
    expect(() => reviewDiscordRecovery(f.state, body)).toThrow('Pause');
    expect(fs.readFileSync(f.file, 'utf8')).toBe(original);
  });

  it('rejects a stale preview and repeated submission without discarding a new gap', async () => {
    const f = await fixture();
    const body = f.request();
    fs.writeFileSync(f.file, JSON.stringify({ ...f.saved, session: { ...f.saved.session, sequence: 48 } }));
    expect(() => reviewDiscordRecovery(f.state, body)).toThrow('changed');
    const fresh = f.request();
    reviewDiscordRecovery(f.state, fresh);
    expect(() => reviewDiscordRecovery(f.state, fresh)).toThrow('changed');
  });

  it('does not reset corrupted, foreign-account or untrusted session records', async () => {
    const f = await fixture();
    const body = f.request();
    for (const value of [
      '{broken',
      JSON.stringify({ ...f.saved, accountId: '999' }),
      JSON.stringify({ ...f.saved, session: undefined }),
      JSON.stringify({ ...f.saved, session: { ...f.saved.session, url: 'wss://steal.invalid/' } }),
    ]) {
      fs.writeFileSync(f.file, value);
      expect(() => discordRecovery(f.instance.id)).toThrow('unreadable');
      expect(() => reviewDiscordRecovery(f.state, body)).toThrow('unreadable');
      expect(fs.readFileSync(f.file, 'utf8')).toBe(value);
    }
  });

  it('keeps review history instead of silently dropping old acknowledgements when it is full', async () => {
    const f = await fixture();
    const reviewedGaps = Array.from({ length: 1000 }, (_, index) => ({
      at: index,
      gapAt: index,
      sequence: index,
      revision: 'b'.repeat(64),
    }));
    fs.writeFileSync(f.file, JSON.stringify({ ...f.saved, reviewedGaps }));
    const original = fs.readFileSync(f.file, 'utf8');
    expect(() => reviewDiscordRecovery(f.state, f.request())).toThrow('need attention');
    expect(fs.readFileSync(f.file, 'utf8')).toBe(original);
  });

  it('acquires exclusive state and account ownership through the supervisor and leaves the instance paused', async () => {
    const f = await fixture();
    const supervisor = new GatewaySupervisor();
    closes.push(() => supervisor.stop());
    const body = f.request();
    await expect(supervisor.reviewDiscordRecovery(f.instance.id, body)).rejects.toThrow('claim');
    expect(discordRecovery(f.instance.id).gap).not.toBeNull();
    await f.state.disconnect();
    await supervisor.reviewDiscordRecovery(f.instance.id, body);
    expect(discordRecovery(f.instance.id)).toEqual({ gap: null });
    expect(supervisor.health()).toContainEqual(
      expect.objectContaining({ instanceId: f.instance.id, status: 'paused' }),
    );
    await f.state.connect();
    expect(f.inbox.list()).toHaveLength(1);
  });
});
