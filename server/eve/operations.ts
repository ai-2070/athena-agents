import crypto from 'node:crypto';
import { listFiles, readPlain, writeJSON } from '../util.ts';
import { privateDataPath } from '../private.ts';
import { readRun } from './state.ts';
import { canonical } from '../../shared/canonical.ts';
import type { EveToolOperation } from '../../shared/types.ts';
import type { ToolResult } from '../tools.ts';

const file = (id: string) => privateDataPath('runtime', 'eve', 'operations', `${id}.json`);
const jobs = new Map<string, Promise<ToolResult>>();

export const operationId = (bindingId: string, sessionId: string, runId: string, callId: string) => crypto.createHash('sha256').update(JSON.stringify([bindingId, sessionId, runId, callId])).digest('hex');

export function readOperation(id: string): EveToolOperation | null {
  return /^[0-9a-f]{64}$/.test(id) ? readPlain<EveToolOperation | null>(file(id), null) : null;
}

export function operationsForRun(runId: string): EveToolOperation[] {
  return listFiles(privateDataPath('runtime', 'eve', 'operations'), (name) => /^[0-9a-f]{64}\.json$/.test(name))
    .map((name) => readOperation(name.slice(0, -5))).filter((item): item is EveToolOperation => !!item && item.runId === runId);
}

export function saveOperation(operation: EveToolOperation): EveToolOperation {
  if (!/^[0-9a-f]{64}$/.test(operation.id)) throw new Error('Invalid Eve operation ID.');
  return writeJSON(file(operation.id), { ...operation, updatedAt: Date.now() });
}

export function prepareOperation(input: Pick<EveToolOperation, 'runId' | 'bindingId' | 'sessionId' | 'callId' | 'name' | 'args' | 'origin' | 'risk'>): EveToolOperation {
  if (!input.callId || !input.sessionId) throw new Error('An Eve operation needs a session and call identity.');
  const id = operationId(input.bindingId, input.sessionId, input.runId, input.callId);
  const fingerprint = canonical({ name: input.name, args: input.args, origin: input.origin });
  const existing = readOperation(id);
  if (existing) {
    if (existing.runId !== input.runId || existing.fingerprint !== fingerprint) throw new Error('The tool call changed its saved operation.');
    return existing;
  }
  if (operationsForRun(input.runId).some((item) => item.status === 'uncertain')) throw new Error('A tool outcome needs to be checked before more tools can run.');
  const at = Date.now();
  return saveOperation({ ...input, id, fingerprint, status: 'prepared', createdAt: at, updatedAt: at });
}

const uncertainResult = (): ToolResult => ({ text: 'This tool may already have taken effect. Its outcome must be checked in Athena before retrying. Do not repeat it.', isError: true });

/** Save intent before execution and return the same result for redelivered call identities. */
export async function executeOperation(id: string, execute: () => Promise<ToolResult>): Promise<ToolResult> {
  const operation = readOperation(id);
  if (!operation) throw new Error('No such Eve operation.');
  if (operation.status === 'completed') return operation.result || { text: '(no output)' };
  if (operation.status === 'cancelled') return { text: 'The operation was stopped.', isError: true, denied: true };
  if (operation.status === 'uncertain') return uncertainResult();
  const active = jobs.get(id);
  if (active) return active;
  if (operation.status === 'running') {
    saveOperation({ ...operation, status: 'uncertain' });
    return uncertainResult();
  }
  if (operation.status !== 'prepared') throw new Error('The operation is still waiting for approval.');
  const run = readRun(operation.runId);
  if (!run || !['running', 'waiting'].includes(run.status)) throw new Error('This Eve run is no longer active.');
  saveOperation({ ...operation, status: 'running' });
  const job = Promise.resolve().then(execute).then((result) => {
    const status = operation.risk === 'high' && result.isError && !result.denied ? 'uncertain' : 'completed';
    saveOperation({ ...readOperation(id)!, status, result });
    return status === 'uncertain' ? uncertainResult() : result;
  }, () => {
    saveOperation({ ...readOperation(id)!, status: 'uncertain' });
    return uncertainResult();
  }).finally(() => jobs.delete(id));
  jobs.set(id, job);
  return job;
}

/** Called before recovered work is accepted, never while this process still owns an executor. */
export function reconcileOperations(runId: string, stopped = false): void {
  for (const operation of operationsForRun(runId)) {
    if (jobs.has(operation.id)) continue;
    if (operation.status === 'running') saveOperation({ ...operation, status: 'uncertain' });
    else if (stopped && ['waiting', 'prepared'].includes(operation.status)) saveOperation({ ...operation, status: 'cancelled' });
  }
}
