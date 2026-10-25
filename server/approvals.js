// "Needs you": anything an agent wants to do that you asked to check first.
// Each request is a promise that resolves when you click Allow / Deny in the dashboard.
import { emit, log } from './store.js';
import { uid } from './util.js';

const pending = new Map();

export function requestApproval({ kind = 'tool', title, detail = '', agentId = null, agentName = '', data = {}, editable = null, timeoutMs = 30 * 60_000 }) {
  const id = uid('ap');
  return new Promise((resolve) => {
    const item = { id, kind, title, detail, agentId, agentName, data, editable, createdAt: Date.now() };
    const timer = setTimeout(() => finish(id, { approved: false, message: 'No answer within 30 minutes, so it was skipped.' }), timeoutMs);
    pending.set(id, { item, resolve, timer });
    emit('approvals');
    log('approval', `${agentName || 'Dashboard'} is waiting for you: ${title}`, { agentId });
  });
}

function finish(id, decision) {
  const p = pending.get(id);
  if (!p) return false;
  clearTimeout(p.timer);
  pending.delete(id);
  p.resolve(decision);
  emit('approvals');
  return true;
}

export function decide(id, { approved, message = '', edited = null, always = false }) {
  const p = pending.get(id);
  if (!p) return false;
  log('approval', `${approved ? 'Allowed' : 'Denied'}: ${p.item.title}`, { agentId: p.item.agentId });
  return finish(id, { approved: !!approved, message, edited, always });
}

export function listApprovals() {
  return [...pending.values()].map((p) => p.item).sort((a, b) => a.createdAt - b.createdAt);
}

// Cancel everything a stopped run was waiting on.
export function cancelForRun(runId) {
  for (const [id, p] of pending) if (p.item.data?.runId === runId) finish(id, { approved: false, message: 'The run was stopped.' });
}
