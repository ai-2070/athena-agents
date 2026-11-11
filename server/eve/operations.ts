import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { listFiles } from '../util.ts';
import { privateDataPath } from '../private.ts';
import { readRunSummary } from './state.ts';
import { canonical } from '../../shared/canonical.ts';
import type { EveToolOperation, EveToolResult } from '../../shared/types.ts';
import type { ToolResult } from '../tools.ts';
import { captureToolImages } from './media.ts';
import { RecordFiles } from './records.ts';
import { eveCounts } from './counts.ts';

const folder = () => privateDataPath('runtime', 'eve', 'operations');
const file = (id: string) => privateDataPath('runtime', 'eve', 'operations', `${id}.json`);
const ID = /^[0-9a-f]{64}$/;
const jobs = new Map<string, Promise<EveToolResult>>();

/** What the run's checks need from an operation, without its arguments and result. */
export type EveOperationSummary = Pick<
  EveToolOperation,
  | 'id'
  | 'runId'
  | 'callId'
  | 'status'
  | 'approvalId'
  | 'questionId'
  | 'interactionId'
  | 'interactionSettled'
  | 'responseDeliveryId'
>;

// Operation ids by run, kept with the cache, so one run's operations are found without reading the others.
const byRun = new Map<string, Set<string>>();
const runOf = new Map<string, string>();
function index(id: string, runId: string | null): void {
  const previous = runOf.get(id);
  if (previous === runId) return;
  const before = previous ? byRun.get(previous) : undefined;
  if (before) {
    before.delete(id);
    if (!before.size) byRun.delete(previous!);
  }
  if (!runId) {
    runOf.delete(id);
    return;
  }
  runOf.set(id, runId);
  let ids = byRun.get(runId);
  if (!ids) byRun.set(runId, (ids = new Set()));
  ids.add(id);
}

// Results can hold images: only some whole records stay in memory, every summary does.
const files = new RecordFiles<EveToolOperation, EveOperationSummary>({
  maxBytes: 16 * 1024 * 1024,
  summarize: (operation) => ({
    id: operation.id,
    runId: operation.runId,
    callId: operation.callId,
    status: operation.status,
    approvalId: operation.approvalId,
    questionId: operation.questionId,
    interactionId: operation.interactionId,
    interactionSettled: operation.interactionSettled,
    responseDeliveryId: operation.responseDeliveryId,
  }),
  changed: (saved, summary) =>
    index(path.basename(saved, '.json'), typeof summary?.runId === 'string' ? summary.runId : null),
  readFromDisk: () => {
    eveCounts.operationReads++;
  },
});

// Files this module didn't write are found by listing the folder again, but only after the folder changed.
let listed: { mtimeMs: number; ino: number } | null = null;
function discover(): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(folder());
  } catch {
    return;
  }
  if (listed && listed.mtimeMs === stat.mtimeMs && listed.ino === stat.ino) return;
  for (const name of listFiles(folder(), (item) => /^[0-9a-f]{64}\.json$/.test(item))) {
    const id = name.slice(0, -5);
    if (!runOf.has(id)) files.summary(file(id));
  }
  listed = { mtimeMs: stat.mtimeMs, ino: stat.ino };
}
const idsOf = (runId: string): string[] => {
  discover();
  return [...(byRun.get(runId) || [])].sort();
};

export const operationId = (bindingId: string, sessionId: string, runId: string, callId: string) =>
  crypto
    .createHash('sha256')
    .update(JSON.stringify([bindingId, sessionId, runId, callId]))
    .digest('hex');

export function readOperation(id: string): EveToolOperation | null {
  return ID.test(id) ? files.read(file(id)) : null;
}

export function operationsForRun(runId: string): EveToolOperation[] {
  return idsOf(runId)
    .map((id) => readOperation(id))
    .filter((item): item is EveToolOperation => !!item && item.runId === runId);
}

/** The run's operations without their arguments and results, for checks made on every step. */
export function operationSummaries(runId: string): EveOperationSummary[] {
  return idsOf(runId)
    .map((id) => files.summary(file(id)))
    .filter((item): item is EveOperationSummary => !!item && item.runId === runId);
}

export function saveOperation(operation: EveToolOperation): EveToolOperation {
  if (!ID.test(operation.id)) throw new Error('Invalid Eve operation ID.');
  return files.write(file(operation.id), { ...operation, updatedAt: Date.now() });
}

/** For retention only. */
export function removeOperation(id: string): void {
  if (ID.test(id)) files.remove(file(id));
}

export function prepareOperation(
  input: Pick<EveToolOperation, 'runId' | 'bindingId' | 'sessionId' | 'callId' | 'name' | 'args' | 'origin' | 'risk'>,
): EveToolOperation {
  if (!input.callId || !input.sessionId) throw new Error('An Eve operation needs a session and call identity.');
  const id = operationId(input.bindingId, input.sessionId, input.runId, input.callId);
  const fingerprint = canonical({ name: input.name, args: input.args, origin: input.origin });
  const existing = readOperation(id);
  if (existing) {
    if (existing.runId !== input.runId || existing.fingerprint !== fingerprint)
      throw new Error('The tool call changed its saved operation.');
    return existing;
  }
  if (operationSummaries(input.runId).some((item) => item.status === 'uncertain'))
    throw new Error('A tool outcome needs to be checked before more tools can run.');
  const at = Date.now();
  return saveOperation({ ...input, id, fingerprint, status: 'prepared', createdAt: at, updatedAt: at });
}

const uncertainResult = (): ToolResult => ({
  text: 'This tool may already have taken effect. Its outcome must be checked in Athena before retrying. Do not repeat it.',
  isError: true,
});

/** Save intent before execution and return the same result for redelivered call identities. */
export async function executeOperation(id: string, execute: () => Promise<ToolResult>): Promise<EveToolResult> {
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
  const run = readRunSummary(operation.runId);
  if (!run || !['running', 'waiting'].includes(run.status)) throw new Error('This Eve run is no longer active.');
  saveOperation({ ...operation, status: 'running' });
  const job = Promise.resolve()
    .then(execute)
    .then(captureToolImages)
    .then(
      (result) => {
        const status = operation.risk === 'high' && result.isError && !result.denied ? 'uncertain' : 'completed';
        saveOperation({ ...readOperation(id)!, status, result });
        return status === 'uncertain' ? uncertainResult() : result;
      },
      () => {
        saveOperation({ ...readOperation(id)!, status: 'uncertain' });
        return uncertainResult();
      },
    )
    .finally(() => jobs.delete(id));
  jobs.set(id, job);
  return job;
}

/** Called before recovered work is accepted, never while this process still owns an executor. */
export function reconcileOperations(runId: string, stopped = false): void {
  for (const operation of operationsForRun(runId)) {
    if (jobs.has(operation.id)) continue;
    if (operation.status === 'running') saveOperation({ ...operation, status: 'uncertain' });
    else if (stopped && ['waiting', 'prepared'].includes(operation.status))
      saveOperation({ ...operation, status: 'cancelled' });
  }
}
