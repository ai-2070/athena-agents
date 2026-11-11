import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import {
  activeProject,
  agents,
  bus,
  getGatewaySecrets,
  listProjects,
  saveProjects,
  setActiveProject,
  withProject,
  workflows,
} from '../../server/store.ts';
import { dataPath } from '../../server/util.ts';
import {
  captureGatewayRoute,
  gatewayCredentialStatus,
  getGatewayInstance,
  listGatewayInstances,
  removeGatewayInstance,
  saveGatewayCredentials,
  saveGatewayInstance,
  withGatewayRoute,
  gatewayTargets,
  updateGatewayCredentials,
} from '../../server/gateways/instances.ts';
import type { GatewayPlatform, GatewayTarget } from '../../shared/types.ts';

const first = listProjects()[0];
const second = { ...first, id: 'other-project', name: 'Other project' };

function config(
  accountId = 'bot-1',
  platform: GatewayPlatform = 'telegram',
  target: GatewayTarget = { kind: 'brain' },
) {
  return {
    name: 'My gateway',
    platform,
    accountId:
      platform === 'slack'
        ? `T${accountId.replace(/[^a-zA-Z0-9]/g, '').toUpperCase()}`
        : platform === 'discord'
          ? String(
              100000000000000000n +
                BigInt([...accountId].reduce((sum, point) => sum * 31 + point.charCodeAt(0), 0) >>> 0),
            )
          : accountId,
    projectId: first.id,
    target,
    senderPolicy:
      platform === 'whatsapp'
        ? { platform, allowedPhones: ['+436641234567'] }
        : { platform, allowedUserIds: platform === 'slack' ? ['UALICE'] : ['12345'] },
    scope: { directMessages: true, conversationIds: [], guildIds: [] },
    fileLimits: { perFileBytes: 1024, perMessageBytes: 2048, filesPerMessage: 2, dailyBytes: 4096 },
    enabled: true,
  };
}

beforeEach(() => {
  for (const instance of listGatewayInstances()) removeGatewayInstance(instance.id);
  saveProjects([first, second]);
  setActiveProject(first.id);
});

describe('gateway instances', () => {
  it('updates each Slack token without exposing or removing the other saved secret', () => {
    const instance = saveGatewayInstance(config('tokens', 'slack'));
    saveGatewayCredentials(instance.id, { botToken: 'private-bot', appToken: 'private-app' });
    updateGatewayCredentials(instance.id, { botToken: 'replacement-bot' });
    expect(getGatewaySecrets(instance.id)).toEqual({ botToken: 'replacement-bot', appToken: 'private-app' });
    expect(gatewayCredentialStatus(instance.id)).toEqual({ botToken: true, appToken: true });
    updateGatewayCredentials(instance.id, { appToken: null });
    expect(getGatewaySecrets(instance.id)).toEqual({ botToken: 'replacement-bot' });
    expect(() => updateGatewayCredentials(instance.id, { unknown: 'value' })).toThrow('credentials');
  });

  it('checks Slack workspace, user and conversation IDs before enabling a saved draft', () => {
    const good = config('scope', 'slack');
    for (const change of [
      { accountId: 'a workspace' },
      { senderPolicy: { platform: 'slack', allowedUserIds: ['@alice'] } },
      { scope: { directMessages: false, conversationIds: ['general'], guildIds: [] } },
      { scope: { directMessages: false, conversationIds: ['CLOCAL/not-a-timestamp'], guildIds: [] } },
    ]) {
      expect(() => saveGatewayInstance({ ...good, ...change })).toThrow('Slack workspace');
    }
    expect(
      saveGatewayInstance({
        ...good,
        senderPolicy: { platform: 'slack', allowedUserIds: [] },
        scope: { directMessages: false, conversationIds: ['CLOCAL/1700000000.000001'], guildIds: [] },
      }).enabled,
    ).toBe(true);
  });
  it('checks Discord snowflakes and scopes before enabling, with an optional sender list', () => {
    const good = config('ids', 'discord');
    for (const change of [
      { accountId: 'bot-name' },
      { accountId: '18446744073709551616' },
      { senderPolicy: { platform: 'discord', allowedUserIds: ['18446744073709551616'] } },
      { scope: { directMessages: true, guildIds: ['18446744073709551616'], conversationIds: ['123'] } },
      { scope: { directMessages: true, guildIds: ['123'], conversationIds: ['channel-name'] } },
    ]) {
      expect(() => saveGatewayInstance({ ...good, ...change })).toThrow('Discord');
    }
    expect(saveGatewayInstance({ ...good, senderPolicy: { platform: 'discord', allowedUserIds: [] } }).enabled).toBe(
      true,
    );
  });

  it('lists only target names and IDs in the chosen project without moving the open project', () => {
    agents.save({ id: 'visible-first', name: 'First', workspace: 'private path' });
    withProject(second, () => {
      agents.save({ id: 'visible-second', name: 'Second', workspace: 'other private path' });
      workflows.save({ id: 'team-second', name: 'Other team' });
    });
    const targets = gatewayTargets(second.id);
    expect(targets.agents).toContainEqual({ id: 'visible-second', name: 'Second' });
    expect(targets.agents.some((item) => item.id === 'visible-first')).toBe(false);
    expect(targets.teams).toContainEqual({ id: 'team-second', name: 'Other team' });
    expect(JSON.stringify(targets)).not.toContain('private path');
    expect(activeProject().id).toBe(first.id);
    expect(() => gatewayTargets('missing')).toThrow('existing project');
  });

  it.each<GatewayPlatform>(['telegram', 'slack', 'discord', 'whatsapp'])(
    'keeps multiple %s instances and targets independent',
    (platform) => {
      const agent = agents.save({ id: 'gateway-agent', name: 'Gateway agent' });
      const team = workflows.save({ id: 'gateway-team', name: 'Gateway team' });
      const brainInstance = saveGatewayInstance(config('one', platform));
      const agentInstance = saveGatewayInstance(config('two', platform, { kind: 'agent', id: agent.id }));
      const teamInstance = saveGatewayInstance(config('three', platform, { kind: 'team', id: team.id }));
      expect(new Set(listGatewayInstances().map((i) => i.id)).size).toBe(3);
      expect(captureGatewayRoute(agentInstance.id).target).toEqual({ kind: 'agent', id: agent.id });
      expect(captureGatewayRoute(teamInstance.id).target).toEqual({ kind: 'team', id: team.id });
      saveGatewayInstance({ ...config('one', platform), enabled: false }, brainInstance.id);
      expect(() => captureGatewayRoute(brainInstance.id)).toThrow('paused');
      expect(captureGatewayRoute(agentInstance.id).instanceId).toBe(agentInstance.id);
      removeGatewayInstance(brainInstance.id);
      expect(listGatewayInstances()).toHaveLength(2);
    },
  );

  it('rejects duplicate account ownership even when an instance is paused', () => {
    const instance = saveGatewayInstance({ ...config(), enabled: false });
    expect(() => saveGatewayInstance(config())).toThrow('already has');
    expect(() => saveGatewayInstance(config('another-account'), instance.id)).toThrow('different account');
    expect(saveGatewayInstance(config('bot-1', 'slack')).id).not.toBe(instance.id);
  });

  it('validates targets in the selected project instead of the open project', () => {
    agents.save({ id: 'only-here' });
    expect(() =>
      saveGatewayInstance({ ...config('x', 'telegram', { kind: 'agent', id: 'only-here' }), projectId: second.id }),
    ).toThrow('agent in this project');
    withProject(second, () => agents.save({ id: 'only-there' }));
    const instance = saveGatewayInstance({
      ...config('x', 'telegram', { kind: 'agent', id: 'only-there' }),
      projectId: second.id,
    });
    expect(withGatewayRoute(captureGatewayRoute(instance.id), () => activeProject().id)).toBe(second.id);
    expect(activeProject().id).toBe(first.id);
    expect(() => saveGatewayInstance({ ...config(), projectId: 'missing' })).toThrow('existing project');
  });

  it('pins routes across global switches and blocks stale queued routes after edits', () => {
    const instance = saveGatewayInstance(config());
    const route = captureGatewayRoute(instance.id);
    setActiveProject(second.id);
    expect(withGatewayRoute(route, () => activeProject().id)).toBe(first.id);
    const renamed = saveGatewayInstance({ ...config(), name: 'Renamed' }, instance.id);
    expect(renamed.routeGeneration).toBe(1);
    const rebound = saveGatewayInstance({ ...config(), projectId: second.id }, instance.id);
    expect(rebound.routeGeneration).toBe(2);
    expect(route.projectId).toBe(first.id);
    expect(() => withGatewayRoute(route, () => 'must not run')).toThrow('destination changed');
  });

  it('pauses instead of falling back when a project or target is removed', () => {
    const agent = agents.save({ id: 'removed-agent' });
    const instance = saveGatewayInstance(config('one', 'telegram', { kind: 'agent', id: agent.id }));
    agents.remove(agent.id);
    expect(() => captureGatewayRoute(instance.id)).toThrow('agent in this project');
    expect(getGatewayInstance(instance.id).enabled).toBe(false);
    const other = saveGatewayInstance({ ...config('two'), projectId: second.id });
    saveProjects([first]);
    expect(() => captureGatewayRoute(other.id)).toThrow('existing project');
    expect(getGatewayInstance(other.id).enabled).toBe(false);
  });

  it('requires exact platform guards and explicit scope before enabling', () => {
    expect(() =>
      saveGatewayInstance({ ...config(), senderPolicy: { platform: 'telegram', allowedUserIds: [] } }),
    ).toThrow('allowed sender');
    expect(() =>
      saveGatewayInstance({ ...config('wa', 'whatsapp'), senderPolicy: { platform: 'whatsapp', allowedPhones: [] } }),
    ).toThrow('allowed sender');
    expect(() => saveGatewayInstance({ ...config(), senderPolicy: { platform: 'slack', allowedUserIds: [] } })).toThrow(
      'match the platform',
    );
    expect(() =>
      saveGatewayInstance({ ...config(), scope: { directMessages: false, conversationIds: [], guildIds: [] } }),
    ).toThrow('conversation scope');
    expect(
      saveGatewayInstance({ ...config('slack', 'slack'), senderPolicy: { platform: 'slack', allowedUserIds: [] } })
        .enabled,
    ).toBe(true);
    expect(() =>
      saveGatewayInstance({
        ...config('discord', 'discord'),
        scope: { directMessages: false, conversationIds: ['123'], guildIds: [] },
      }),
    ).toThrow('Discord servers');
    expect(
      saveGatewayInstance({ ...config(), enabled: false, senderPolicy: { platform: 'telegram', allowedUserIds: [] } })
        .enabled,
    ).toBe(false);
  });

  it.each(['@someone', '123abc', '', '0'])('rejects nonnumeric Telegram sender %j', (sender) => {
    expect(() =>
      saveGatewayInstance({ ...config(), senderPolicy: { platform: 'telegram', allowedUserIds: [sender] } }),
    ).toThrow('sender IDs');
  });

  it.each(['06641234567', '00436641234567', '+43 664 1234567', '+0123'])(
    'requires canonical WhatsApp phone %j',
    (phone) => {
      expect(() =>
        saveGatewayInstance({
          ...config('wa', 'whatsapp'),
          senderPolicy: { platform: 'whatsapp', allowedPhones: [phone] },
        }),
      ).toThrow('sender IDs');
    },
  );

  it('rejects oversized limits, credential fields and unsafe identifiers', () => {
    const base = config();
    expect(() =>
      saveGatewayInstance({ ...base, fileLimits: { ...base.fileLimits, perFileBytes: 21 * 1024 * 1024 } }),
    ).toThrow('file limits');
    expect(() => saveGatewayInstance({ ...base, fileLimits: { ...base.fileLimits, dailyBytes: 1 } })).toThrow(
      'daily limits',
    );
    expect(() => saveGatewayInstance({ ...base, botToken: 'secret' })).toThrow('gateway fields');
    expect(() => getGatewayInstance('../secret')).toThrow('Invalid gateway');
    expect(() => saveGatewayInstance({ ...base, target: { kind: 'agent', id: '../agent' } })).toThrow('gateway fields');
  });

  it('separates credentials and clears only the deleted instance credentials', () => {
    const one = saveGatewayInstance(config());
    const two = saveGatewayInstance(config('two'));
    const events: unknown[] = [];
    const listener = (event: unknown) => events.push(event);
    bus.on('event', listener);
    try {
      saveGatewayCredentials(one.id, { botToken: 'secret-one' });
      saveGatewayCredentials(two.id, { botToken: 'secret-two' });
      expect(gatewayCredentialStatus(one.id)).toEqual({ botToken: true });
      expect(getGatewaySecrets(two.id).botToken).toBe('secret-two');
      expect(JSON.stringify([listGatewayInstances(), gatewayCredentialStatus(one.id), events])).not.toContain(
        'secret-',
      );
      expect(fs.readFileSync(dataPath('gateways', `${one.id}.json`), 'utf8')).not.toContain('secret-one');
      expect(fs.existsSync(dataPath('projects', first.id, 'gateway-secrets.json'))).toBe(false);
      removeGatewayInstance(one.id);
      expect(getGatewaySecrets(one.id)).toEqual({});
      expect(getGatewaySecrets(two.id).botToken).toBe('secret-two');
      expect(() => saveGatewayCredentials(one.id, { botToken: 'gone' })).toThrow('No such gateway');
      expect(() => saveGatewayCredentials(two.id, { unknown: 'secret' })).toThrow('credentials');
    } finally {
      bus.off('event', listener);
    }
  });
});
