import fs from 'node:fs';
import { z } from 'zod';
import type { GatewayInstance, GatewayRetiredInstance } from '../../shared/types.ts';
import { privateDataPath } from '../private.ts';
import { emit } from '../store.ts';
import { readJSON, writeJSON } from '../util.ts';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/);
const stamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const schema = z
  .strictObject({
    version: z.literal(1),
    id,
    name: z.string().min(1).max(100),
    platform: z.enum(['telegram', 'slack', 'discord', 'whatsapp']),
    accountId: z.string().min(1).max(200),
    projectId: id,
    target: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('brain') }),
      z.strictObject({ kind: z.literal('team'), id }),
      z.strictObject({ kind: z.literal('agent'), id }),
    ]),
    routeGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    startedAt: stamp,
    completedAt: stamp.optional(),
  })
  .refine((value) => value.completedAt === undefined || value.completedAt >= value.startedAt);

function file(instanceId: string): string {
  if (!id.safeParse(instanceId).success)
    throw Object.assign(new Error('Invalid gateway instance ID.'), { status: 400 });
  return privateDataPath('gateways-retired', `${instanceId}.json`);
}

/** Even an unreadable retirement record must prevent a worker from reconnecting. */
export function gatewayRetirementStarted(instanceId: string): boolean {
  return fs.existsSync(file(instanceId));
}

export function gatewayRetirement(instanceId: string): GatewayRetiredInstance | undefined {
  const location = file(instanceId);
  if (!fs.existsSync(location)) return undefined;
  const parsed = schema.safeParse(readJSON(location));
  if (!parsed.success || parsed.data.id !== instanceId)
    throw Object.assign(new Error('This gateway removal record is unreadable. Restore it before continuing removal.'), {
      status: 503,
    });
  return parsed.data;
}

export function gatewayRetirementIds(): string[] {
  const directory = privateDataPath('gateways-retired');
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -5));
}

export function listGatewayRetirements(): GatewayRetiredInstance[] {
  return gatewayRetirementIds()
    .map((id) => {
      const saved = gatewayRetirement(id);
      if (!saved)
        throw Object.assign(new Error('Gateway removal records changed. Reload before continuing.'), { status: 409 });
      return saved;
    })
    .sort((a, b) => b.startedAt - a.startedAt || a.id.localeCompare(b.id));
}

export function beginGatewayRetirement(instance: GatewayInstance): GatewayRetiredInstance {
  const before = gatewayRetirement(instance.id);
  if (before) return before;
  const { id, name, platform, accountId, projectId, target, routeGeneration } = instance;
  const saved: GatewayRetiredInstance = {
    version: 1,
    id,
    name,
    platform,
    accountId,
    projectId,
    target,
    routeGeneration,
    startedAt: Date.now(),
  };
  writeJSON(file(id), schema.parse(saved));
  emit('gateways', { id });
  return saved;
}

/** The caller has drained the worker and holds both account and private-state ownership. */
export function completeGatewayRetirement(instanceId: string): void {
  const before = gatewayRetirement(instanceId);
  if (!before) throw new Error('Save the gateway removal record before clearing its setup.');
  if (before.completedAt !== undefined) return;
  writeJSON(file(instanceId), { ...before, completedAt: Math.max(Date.now(), before.startedAt) });
  emit('gateways', { id: instanceId, removed: true });
}
