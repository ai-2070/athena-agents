// "Needs you": anything an agent wants to do that you asked to check first.
// Each request is a promise that resolves when you click Allow / Deny in the dashboard.
import { emit, log } from './store.ts';
import { uid } from './util.ts';
import type { Approval } from '../shared/types.ts';

/** What you answered (or what happened instead: a timeout or a stopped run). */
export interface ApprovalDecision {
  approved: boolean;
  message: string;
  edited?: unknown;
  always?: boolean;
}

export interface ApprovalRequest {
  kind?: string;
  title: string;
  detail?: string;
  agentId?: string | null;
  agentName?: string;
  data?: Record<string, unknown>;
  editable?: unknown;
  timeoutMs?: number;
}

interface Pending {
  item: Approval;
  resolve: (decision: ApprovalDecision) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, Pending>();

export function requestApproval({ kind = 'tool', title, detail = '', agentId = null, agentName = '', data = {}, editable = null, timeoutMs = 30 * 60_000 }: ApprovalRequest): Promise<ApprovalDecision> {
  const id = uid('ap');
  return new Promise((resolve) => {
    const item: Approval = { id, kind, title, detail, agentId, agentName, data, editable, createdAt: Date.now() };
    const timer = setTimeout(() => finish(id, { approved: false, message: 'No answer within 30 minutes, so it was skipped.' }), timeoutMs);
    pending.set(id, { item, resolve, timer });
    emit('approvals');
    log('approval', `${agentName || 'Dashboard'} is waiting for you: ${title}`, { agentId });
  });
}

function finish(id: string, decision: ApprovalDecision): boolean {
  const p = pending.get(id);
  if (!p) return false;
  clearTimeout(p.timer);
  pending.delete(id);
  p.resolve(decision);
  emit('approvals');
  return true;
}

export function decide(id: string, { approved, message = '', edited = null, always = false }: { approved?: unknown; message?: string; edited?: unknown; always?: boolean }): boolean {
  const p = pending.get(id);
  if (!p) return false;
  log('approval', `${approved ? 'Allowed' : 'Denied'}: ${p.item.title}`, { agentId: p.item.agentId });
  return finish(id, { approved: !!approved, message, edited, always });
}

export function listApprovals(): Approval[] {
  return [...pending.values()].map((p) => p.item).sort((a, b) => a.createdAt - b.createdAt);
}

// Cancel everything a stopped run was waiting on.
export function cancelForRun(runId: string) {
  for (const [id, p] of pending) if (p.item.data?.runId === runId) finish(id, { approved: false, message: 'The run was stopped.' });
}
