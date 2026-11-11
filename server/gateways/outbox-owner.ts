import type { GatewayOutboxApproval, GatewayOutboxDestination, GatewayOutboxPreview } from '../../shared/types.ts';
import { getGatewayInstance } from './instances.ts';
import type { GatewayOutboxLedger } from './outbox.ts';

const owners = new Map<string, { ledger: GatewayOutboxLedger; signal: AbortSignal }>();

/** A stopped worker cannot accept fresh approvals, even while its transport drains. */
export function registerGatewayOutbox(
  instanceId: string,
  ledger: GatewayOutboxLedger,
  signal: AbortSignal,
): () => void {
  if (owners.has(instanceId)) throw new Error('This gateway already has an Outbox owner.');
  const entry = { ledger, signal };
  owners.set(instanceId, entry);
  return () => {
    if (owners.get(instanceId) === entry) owners.delete(instanceId);
  };
}

function owner(instanceId: string, projectId: string) {
  const instance = getGatewayInstance(instanceId);
  const entry = owners.get(instanceId);
  if (!instance.enabled || instance.projectId !== projectId || !entry || entry.signal.aborted) {
    throw new Error('Connect the selected gateway in this project before reviewing or approving its Outbox send.');
  }
  return entry.ledger;
}

export function gatewayOutboxDestinations(projectId: string): GatewayOutboxDestination[] {
  const result: GatewayOutboxDestination[] = [];
  for (const [id, entry] of owners) {
    const instance = getGatewayInstance(id);
    if (
      !entry.signal.aborted &&
      instance.enabled &&
      instance.projectId === projectId &&
      (instance.platform === 'telegram' || instance.platform === 'discord')
    )
      result.push(...entry.ledger.destinations(projectId));
  }
  return result;
}

export function prepareGatewayOutbox(
  instanceId: string,
  projectId: string,
  postId: string,
  eventId: string,
  parts: string[],
): GatewayOutboxPreview {
  return owner(instanceId, projectId).prepare({ instanceId, projectId, postId, eventId, parts });
}

export function approveGatewayOutbox(value: GatewayOutboxApproval): void {
  owner(value.instanceId, value.projectId).approve(value);
}
