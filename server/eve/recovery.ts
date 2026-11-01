import { Client } from 'eve/client';
import { cancelForRun, durableApproval, ensureDurableApproval } from '../approvals.ts';
import { listProjects, questions, withProject } from '../store.ts';
import { closeQuestion, WAIT_MS } from '../questions.ts';
import { eveRuns, markSessionEnded, readBinding, readRun, retireSession, sessionContext, setRunStatus, settleRun, stageTerminal } from './state.ts';
import { operationsForRun, readOperation, reconcileOperations, saveOperation } from './operations.ts';
import { EveProjectionError, projectEvent } from './projection.ts';
import type { EveHost } from './host.ts';
import type { SessionSnapshot, SessionStreamEvent } from 'eve/client';

export function eveClient(host: Pick<EveHost, 'url' | 'token'>, bindingId: string): Client {
  return new Client({ baseUrl: host.url, auth: { bearer: host.token }, headers: { 'x-athena-binding': bindingId } });
}

function cancelQuestions(runId: string) {
  const run = readRun(runId);
  if (!run) return;
  try {
    const binding = readBinding(run.bindingId);
    const project = binding && listProjects().find((item) => item.id === binding.projectId);
    if (!project) return;
    withProject(project, () => {
      for (const operation of operationsForRun(runId)) {
        const question = operation.questionId && questions.get(operation.questionId);
        if (question && question.runId === runId && question.status === 'waiting') closeQuestion(question.id, 'The run was stopped or interrupted.');
      }
    });
  } catch { /* A deleted owner has no conversation to resume. */ }
}

function checkOutcomes(runId: string) {
  const run = readRun(runId);
  if (!run) return;
  const { project, agent } = sessionContext(run.bindingId);
  withProject(project, () => {
    for (const operation of operationsForRun(runId).filter((item) => item.status === 'uncertain')) {
      const key = `reconcile:${operation.id}`;
      const approval = durableApproval(key) || ensureDurableApproval(key, {
        kind: 'workflow', title: `Check the outcome of ${operation.name}`,
        detail: 'This tool may already have made changes. Check its outcome before starting more work. Allow to mark this check done; this run stays interrupted and the tool will not be repeated.',
        agentId: agent.id, agentName: agent.name, data: { tool: operation.name, args: operation.args, runId, outcomeCheck: true },
      });
      if (approval.decision?.approved) saveOperation({ ...operation, status: 'cancelled' });
    }
  });
}

async function endSession(bindingId: string, client: Client) {
  const binding = readBinding(bindingId);
  if (!binding?.sessionId || binding.runtimeEnded) return;
  const response = await client.fetch(`/eve/v1/session/${encodeURIComponent(binding.sessionId)}/end`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'Stopped or interrupted in Athena.' }), signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    const error: unknown = await response.json();
    if (!error || typeof error !== 'object' || !('code' in error) || !['session_not_active', 'session_expired'].includes(String(error.code))) throw new Error('Eve could not retire this stopped session.');
  }
  markSessionEnded(bindingId);
}

/** Save Stop before contacting the worker. A lost HTTP reply cannot undo the user's decision. */
export async function stopEveRun(runId: string, client?: Client): Promise<void> {
  const run = readRun(runId);
  if (!run) return;
  if (['completed', 'failed'].includes(run.status)) return;
  if (['queued', 'running', 'waiting'].includes(run.status)) setRunStatus(runId, 'stopped');
  cancelForRun(runId);
  cancelQuestions(runId);
  reconcileOperations(runId, true);
  const binding = readBinding(run.bindingId);
  retireSession(run.bindingId);
  if (client && binding?.sessionId) await endSession(binding.id, client);
}

/** Replay a bounded durable prefix before deciding whether there is still machine work to follow. */
export function observeEveEvent(runId: string, event: SessionStreamEvent) {
  const run = readRun(runId);
  if (!run || !['queued', 'running', 'waiting'].includes(run.status)) return [];
  if (!run.cursor && !(event.type === 'delivery.admitted' && event.data.deliveryId === run.deliveryId)) return [];
  const projected = projectEvent(runId, event);
  const current = readRun(runId)!;
  if (event.type === 'turn.settled' && event.data.turnId === current.turnId) {
    stageTerminal(runId, { line: event.meta.position.line, status: event.data.outcome === 'cancelled' ? 'stopped' : event.data.outcome === 'completed' ? 'completed' : 'failed', parts: [...(event.data.reply || [])], error: event.data.error?.message });
  } else if (event.type === 'session.ended') {
    stageTerminal(runId, { line: event.meta.position.line, status: event.data.outcome === 'failed' ? 'failed' : current.pendingTerminal?.status || 'interrupted', parts: current.pendingTerminal?.parts || [], error: event.data.error?.message || current.pendingTerminal?.error || 'The Eve session ended before this turn finished.' });
  } else if (event.type === 'turn.paused' && event.data.turnId === current.turnId) {
    const waiting = event.data.awaiting.some(({ interactionId }) => operationsForRun(runId).some((operation) => operation.interactionId === interactionId && !operation.interactionSettled));
    setRunStatus(runId, waiting ? 'waiting' : 'running');
  } else if (event.type === 'interaction.settled') {
    const waiting = operationsForRun(runId).some((operation) => operation.interactionId && !operation.interactionSettled);
    setRunStatus(runId, waiting ? 'waiting' : 'running');
  }
  const ready = readRun(runId)!;
  if (ready.pendingTerminal && event.meta.endOfLine !== false && event.meta.position.line >= ready.pendingTerminal.line) {
    const text = ready.pendingTerminal.parts.map((part) => {
      const original = ready.events.find((item) => item.id === ready.textParts?.[part])?.event;
      if (original?.kind !== 'text') throw new EveProjectionError('Eve reply needs its original content before it can finish.');
      return original.text;
    }).join('');
    settleRun(runId, ready.pendingTerminal.status, text, ready.pendingTerminal.error);
    cancelForRun(runId);
  }
  return projected;
}

export function reconcileSnapshot(runId: string, snapshot: SessionSnapshot) {
  const run = readRun(runId);
  if (!run) throw new Error('No such Eve run.');
  const { binding } = sessionContext(run.bindingId);
  if (snapshot.session.sessionId !== binding.sessionId) throw new Error('The snapshot does not belong to this Eve binding.');
  if (!['queued', 'running', 'waiting'].includes(run.status)) return [];
  const start = snapshot.events.findIndex((event) => event.type === 'delivery.admitted' && event.data.deliveryId === run.deliveryId);
  if (start < 0) return [];
  const events = snapshot.events.slice(start);
  return events.flatMap((event) => observeEveEvent(runId, event));
}

/** A stable input key covers a crash after Eve accepts an answer but before Athena saves its receipt. */
export async function deliverApprovalDecisions(runId: string, client: Client): Promise<void> {
  const run = readRun(runId);
  if (!run || !['running', 'waiting'].includes(run.status)) return;
  const { binding, project } = sessionContext(run.bindingId);
  if (!binding.sessionId) return;
  for (const operation of operationsForRun(runId)) {
    if (!operation.interactionId || operation.interactionSettled || operation.responseDeliveryId) continue;
    const approval = durableApproval(operation.id);
    const question = operation.questionId ? withProject(project, () => questions.get(operation.questionId!)) : null;
    if (question?.status === 'waiting' && (question.createdAt || 0) + WAIT_MS <= Date.now()) withProject(project, () => questions.save({ ...question, status: 'closed', note: 'The question expired.' }));
    const answered = operation.questionId ? withProject(project, () => questions.get(operation.questionId!)?.status !== 'waiting') : false;
    if (!approval?.decision && !answered) continue;
    const response = await client.fetch(`/eve/v1/session/${encodeURIComponent(binding.sessionId)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(10000),
      body: JSON.stringify({ answers: [{ interactionId: operation.interactionId, optionId: answered || approval?.decision?.approved ? 'approve' : 'deny' }], idempotencyKey: `approval:${operation.id}:${operation.interactionId}` }),
    });
    if (!response.ok) throw new Error('Eve could not accept the saved approval decision.');
    const receipt: unknown = await response.json();
    if (!receipt || typeof receipt !== 'object' || !('sessionId' in receipt) || receipt.sessionId !== binding.sessionId || !('deliveryId' in receipt) || typeof receipt.deliveryId !== 'string') throw new Error('Eve returned an invalid approval receipt.');
    // Execution may already have updated the operation while the receipt was in flight.
    saveOperation({ ...readOperation(operation.id)!, responseDeliveryId: receipt.deliveryId });
  }
}

/** Reconcile ownership and execution intents before a worker can automatically resume its queue. */
export function prepareEveRecovery(): void {
  for (const run of eveRuns()) {
    if (run.status === 'completed' || run.status === 'failed') continue;
    if (run.status === 'stopped') {
      cancelForRun(run.id);
      cancelQuestions(run.id);
      reconcileOperations(run.id, true);
      retireSession(run.bindingId);
      continue;
    }
    let binding;
    try { binding = sessionContext(run.bindingId).binding; }
    catch {
      if (run.status !== 'interrupted') setRunStatus(run.id, 'interrupted');
      cancelForRun(run.id, { keepOutcomeChecks: true });
      cancelQuestions(run.id);
      reconcileOperations(run.id, true);
      retireSession(run.bindingId);
      continue;
    }
    reconcileOperations(run.id);
    if (run.status === 'interrupted' || !binding.sessionId || !run.deliveryId || operationsForRun(run.id).some((operation) => operation.status === 'uncertain')) {
      setRunStatus(run.id, 'interrupted');
      cancelForRun(run.id, { keepOutcomeChecks: true });
      cancelQuestions(run.id);
      reconcileOperations(run.id, true);
      checkOutcomes(run.id);
    }
  }
  // A vanished CLI/team Promise cannot be reconstructed from its parent's saved text.
  // Check ancestors after every operation intent has been reconciled, regardless of file order.
  const canResume = (id: string, projectId: string, seen = new Set<string>()): boolean => {
    if (seen.has(id)) return false;
    seen.add(id);
    const run = readRun(id);
    if (!run || !['queued', 'running', 'waiting'].includes(run.status)) return false;
    try {
      if (sessionContext(run.bindingId).project.id !== projectId) return false;
    } catch { return false; }
    return !run.parentRunId || canResume(run.parentRunId, projectId, seen);
  };
  for (const run of eveRuns().filter((item) => ['queued', 'running', 'waiting'].includes(item.status))) {
    const { project } = sessionContext(run.bindingId);
    if (canResume(run.id, project.id)) continue;
    setRunStatus(run.id, 'interrupted');
    cancelForRun(run.id, { keepOutcomeChecks: true });
    cancelQuestions(run.id);
    reconcileOperations(run.id, true);
  }
}

/** Called with the new private worker before new Athena work is admitted. Transport failure is retried. */
export async function recoverEveRuns(host: Pick<EveHost, 'url' | 'token'>): Promise<{ runId: string; status: string }[]> {
  prepareEveRecovery();
  const recovered: { runId: string; status: string }[] = [];
  for (const run of eveRuns()) {
    if (run.status === 'completed' || run.status === 'failed') continue;
    const client = eveClient(host, run.bindingId);
    const binding = readBinding(run.bindingId);
    if (run.status === 'stopped' || run.status === 'interrupted') {
      if (binding?.sessionId) await endSession(binding.id, client);
    } else if (binding?.sessionId) {
      try {
        const snapshot = await client.sessions.attach(binding.sessionId).snapshot({ signal: AbortSignal.timeout(10000) });
        reconcileSnapshot(run.id, snapshot);
        await deliverApprovalDecisions(run.id, client);
      } catch (error) {
        if (!(error instanceof EveProjectionError)) throw error;
        settleRun(run.id, 'interrupted', '', 'Eve returned a saved event Athena could not read. Check its results before continuing.');
        cancelForRun(run.id, { keepOutcomeChecks: true });
        cancelQuestions(run.id);
        reconcileOperations(run.id, true);
        checkOutcomes(run.id);
        await endSession(binding.id, client);
      }
    }
    recovered.push({ runId: run.id, status: readRun(run.id)!.status });
  }
  return recovered;
}
