import { durableApproval, removeDurableApproval } from '../approvals.ts';
import { readBinding, removeRun, retireSession, runEnded, runSummaries } from './state.ts';
import { operationSummaries, removeOperation } from './operations.ts';
import { removeAdmission } from './admission.ts';

/** How long Eve keeps a finished run's receipts: its run, operation, input and consent files. */
export const EVE_RECEIPT_DAYS = 30;
const DAY = 24 * 60 * 60 * 1000;
const OPEN = ['waiting', 'running', 'prepared', 'uncertain'];

const undecided = (key: string) => {
  const approval = durableApproval(key);
  return !!approval && !approval.decision;
};

/**
 * Removes the receipts of runs that ended long ago, once everything in them is in the chat and nothing
 * waits for a person: no open operation, no consent or outcome check still undecided. Returns the run ids.
 */
export function removeOldEveReceipts({
  now = Date.now(),
  keepMs = EVE_RECEIPT_DAYS * DAY,
}: { now?: number; keepMs?: number } = {}): string[] {
  const runs = runSummaries();
  const working = new Set(runs.filter((run) => !runEnded(run.status)).map((run) => run.bindingId));
  const removed: string[] = [];
  for (const run of runs) {
    // Runs saved before endedAt was kept for every ending count from their last change.
    const ended = run.endedAt ?? run.updatedAt;
    if (!runEnded(run.status) || !Number.isFinite(ended) || now - ended <= keepMs) continue;
    if ((run.projected || 0) < run.events) continue;
    const operations = operationSummaries(run.id);
    if (
      operations.some(
        (operation) =>
          OPEN.includes(operation.status) || undecided(operation.id) || undecided(`reconcile:${operation.id}`),
      )
    )
      continue;
    if (run.status !== 'completed') {
      // conversationBinding() skips a binding by its failed, stopped or interrupted run: without the run
      // the binding must already be retired, or it would be used again.
      if (working.has(run.bindingId)) continue;
      const binding = readBinding(run.bindingId);
      if (binding && !binding.retired) retireSession(binding.id);
    }
    for (const operation of operations) {
      removeDurableApproval(operation.id);
      removeDurableApproval(`reconcile:${operation.id}`);
      removeOperation(operation.id);
    }
    removeAdmission(run.id);
    // The run goes last: if this stops halfway, the next sweep finds the run and finishes.
    removeRun(run.id);
    removed.push(run.id);
  }
  return removed;
}
