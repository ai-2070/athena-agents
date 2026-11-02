import { z } from 'zod';
import type { GatewayInstance, GatewayRoute, GatewayTarget } from '../../shared/types.ts';
import { agents, collection, getGatewaySecrets, listProjects, setGatewaySecrets, withProject, workflows } from '../store.ts';
import { uid } from '../util.ts';

const instances = collection<GatewayInstance>('gateways', { global: true });
const id = z.string().regex(/^[a-zA-Z0-9_-]+$/).max(200);
const externalId = z.string().trim().min(1).max(200);
const userIds = z.array(externalId).max(1000);
const target = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('brain') }),
  z.strictObject({ kind: z.literal('team'), id }),
  z.strictObject({ kind: z.literal('agent'), id }),
]);
const config = z.strictObject({
  name: z.string().trim().min(1).max(100),
  platform: z.enum(['telegram', 'slack', 'discord', 'whatsapp']),
  accountId: externalId,
  projectId: id,
  target,
  senderPolicy: z.discriminatedUnion('platform', [
    z.strictObject({ platform: z.literal('telegram'), allowedUserIds: z.array(z.string().regex(/^[1-9]\d*$/)).max(1000) }),
    z.strictObject({ platform: z.literal('whatsapp'), allowedPhones: z.array(z.string().regex(/^\+[1-9]\d{1,14}$/)).max(1000) }),
    z.strictObject({ platform: z.literal('slack'), allowedUserIds: userIds }),
    z.strictObject({ platform: z.literal('discord'), allowedUserIds: z.array(z.string().regex(/^[1-9]\d*$/)).max(1000) }),
  ]),
  scope: z.strictObject({ directMessages: z.boolean(), conversationIds: userIds, guildIds: userIds }),
  fileLimits: z.strictObject({
    perFileBytes: z.number().int().positive().max(20 * 1024 * 1024),
    perMessageBytes: z.number().int().positive().max(50 * 1024 * 1024),
    filesPerMessage: z.number().int().positive().max(10),
    dailyBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  }),
  enabled: z.boolean(),
});

function fail(message: string): never {
  throw Object.assign(new Error(message), { status: 400 });
}

function requireInstance(instanceId: string): GatewayInstance {
  if (!id.safeParse(instanceId).success) fail('Invalid gateway instance ID.');
  const instance = instances.get(instanceId);
  if (!instance) throw Object.assign(new Error('No such gateway instance.'), { status: 404 });
  return instance;
}

function checkTarget(projectId: string, destination: GatewayTarget): void {
  const project = listProjects().find((p) => p.id === projectId);
  if (!project) fail('Choose an existing project.');
  withProject(project, () => {
    if (destination.kind === 'agent' && !agents.get(destination.id)) fail('Choose an agent in this project.');
    if (destination.kind === 'team' && !workflows.get(destination.id)) fail('Choose a team in this project.');
  });
}

export function listGatewayInstances(): GatewayInstance[] {
  return instances.list();
}

export function getGatewayInstance(instanceId: string): GatewayInstance {
  return requireInstance(instanceId);
}

/** Full replacement keeps unknown fields (including credentials) out of safe records. */
export function saveGatewayInstance(input: unknown, instanceId?: string): GatewayInstance {
  const parsed = config.safeParse(input);
  if (!parsed.success) fail('Check the gateway fields, sender IDs and file limits.');
  const next = parsed.data;
  const before = instanceId === undefined ? null : requireInstance(instanceId);
  if (before && (before.platform !== next.platform || before.accountId !== next.accountId)) {
    fail('Add a new instance to connect a different account.');
  }
  if (next.senderPolicy.platform !== next.platform) fail('The sender guard must match the platform.');
  if (instances.list().some((other) => other.id !== before?.id && other.platform === next.platform && other.accountId === next.accountId)) {
    fail('This account already has a gateway instance.');
  }
  checkTarget(next.projectId, next.target);
  if (next.fileLimits.perFileBytes > next.fileLimits.perMessageBytes || next.fileLimits.perMessageBytes > next.fileLimits.dailyBytes) {
    fail('File limits must fit within the message and daily limits.');
  }
  if (next.enabled) {
    const policy = next.senderPolicy;
    if ((policy.platform === 'telegram' && !policy.allowedUserIds.length) || (policy.platform === 'whatsapp' && !policy.allowedPhones.length)) {
      fail('Add at least one allowed sender before enabling this instance.');
    }
    if (!next.scope.directMessages && !next.scope.conversationIds.length) fail('Choose a conversation scope before enabling this instance.');
    if (next.platform === 'discord' && next.scope.conversationIds.length && !next.scope.guildIds.length) fail('Choose the Discord servers for these channels.');
  }
  const changed = before && (before.projectId !== next.projectId || JSON.stringify(before.target) !== JSON.stringify(next.target));
  return instances.save({
    ...next,
    id: before?.id ?? uid('gateway-'),
    routeGeneration: before ? before.routeGeneration + (changed ? 1 : 0) : 1,
    createdAt: before?.createdAt ?? Date.now(),
  });
}

const secrets = z.strictObject({
  botToken: z.string().min(1).max(4096).optional(),
  appToken: z.string().min(1).max(4096).optional(),
  signingSecret: z.string().min(1).max(4096).optional(),
  verificationToken: z.string().min(1).max(4096).optional(),
  accessToken: z.string().min(1).max(4096).optional(),
  relayKey: z.string().min(1).max(4096).optional(),
});

export function saveGatewayCredentials(instanceId: string, input: unknown): void {
  requireInstance(instanceId);
  const parsed = secrets.safeParse(input);
  if (!parsed.success) fail('Check the gateway credentials.');
  setGatewaySecrets(instanceId, parsed.data);
}

/** Presence only: no token suffixes or private connection details reach the browser. */
export function gatewayCredentialStatus(instanceId: string): Record<string, boolean> {
  requireInstance(instanceId);
  return Object.fromEntries(Object.entries(getGatewaySecrets(instanceId)).map(([key, value]) => [key, Boolean(value)]));
}

export function removeGatewayInstance(instanceId: string): void {
  // Stop intake before removing credentials. Transport/relay cleanup will hook in here.
  const instance = requireInstance(instanceId);
  instances.save({ ...instance, enabled: false });
  setGatewaySecrets(instanceId, null);
  instances.remove(instanceId);
}

export function captureGatewayRoute(instanceId: string): GatewayRoute {
  const instance = requireInstance(instanceId);
  if (!instance.enabled) fail('This gateway instance is paused.');
  try {
    checkTarget(instance.projectId, instance.target);
  } catch (error) {
    instances.save({ ...instance, enabled: false });
    throw error;
  }
  return { instanceId, projectId: instance.projectId, target: instance.target, generation: instance.routeGeneration };
}

/** Changed routes need reconciliation; queued work must never follow a new target. */
export function withGatewayRoute<T>(route: GatewayRoute, fn: () => T): T {
  const current = captureGatewayRoute(route.instanceId);
  if (current.generation !== route.generation || current.projectId !== route.projectId || JSON.stringify(current.target) !== JSON.stringify(route.target)) {
    fail('The gateway destination changed. Review the queued message before retrying.');
  }
  const project = listProjects().find((p) => p.id === route.projectId);
  if (!project) fail('The gateway project was removed.');
  return withProject(project, fn);
}
