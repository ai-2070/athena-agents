// "Needs you": anything an agent wants to do that you asked to check first.
// Each request is a promise that resolves when you click Allow / Deny in the dashboard.
// With "The Brain approves" on (the default), the Brain looks first: it allows routine, on-task
// actions itself and only passes the risky or unclear ones on to you.
import crypto from 'node:crypto';
import { emit, log, getSettings, activeProject, listProjects, withProject } from './store.ts';
import { listFiles, readPlain, uid, writeJSON } from './util.ts';
import { privateDataPath } from './private.ts';
import { canonical } from '../shared/canonical.ts';
import type { Approval, ApprovalDecision, DurableApprovalRecord } from '../shared/types.ts';
export type { ApprovalDecision } from '../shared/types.ts';

/** What you answered (or what happened instead: a timeout or a stopped run). */
export interface ApprovalRequest {
  kind?: string;
  title: string;
  detail?: string;
  agentId?: string | null;
  agentName?: string;
  data?: Record<string, unknown>;
  editable?: unknown;
  timeoutMs?: number;
  operationId?: string;
}

/** The Brain's verdict on a request: allow it, or pass it on to you with a reason. */
export interface BrainVerdict {
  approve: boolean;
  reason: string;
}
export type Reviewer = (item: Approval) => Promise<BrainVerdict>;

interface Pending {
  item: Approval;
  resolve: (decision: ApprovalDecision) => void;
  timer: ReturnType<typeof setTimeout>;
  /** The Brain is still looking at it: not shown to you yet. */
  reviewing: boolean;
  durable?: DurableApprovalRecord;
}

const pending = new Map<string, Pending>();
const durableId = (operationId: string) => 'ap' + crypto.createHash('sha256').update(operationId).digest('hex');
const durableFile = (id: string) => privateDataPath('runtime', 'eve', 'approvals', `${id}.json`);

function durableById(id: string): DurableApprovalRecord | null {
  return /^ap[0-9a-f]{64}$/.test(id) ? readPlain<DurableApprovalRecord | null>(durableFile(id), null) : null;
}

export function durableApproval(operationId: string): DurableApprovalRecord | null {
  return durableById(durableId(operationId));
}

export const approvalFingerprint = (request: ApprovalRequest): string => canonical({ project: activeProject().id, agent: request.agentId || null, kind: request.kind || 'tool', data: request.data || {} });

export function cancelDurableApproval(operationId: string, message: string): void {
  const saved = durableApproval(operationId);
  if (saved) restoreDurable(saved);
  if (saved && !saved.decision) finish(saved.id, { approved: false, message });
}

function restoreDurable(record: DurableApprovalRecord) {
  if (record.decision) return;
  if (pending.has(record.id)) {
    if (record.expiresAt <= Date.now()) finish(record.id, { approved: false, message: 'The approval expired.' });
    return;
  }
  // An interrupted review goes to the user; no vanished promise grants consent.
  if (record.reviewing) {
    record.reviewing = false;
    record.item.brainNote = 'The review was interrupted. Please check this request.';
    writeJSON(durableFile(record.id), record);
  }
  const timer = setTimeout(() => finish(record.id, { approved: false, message: 'The approval expired.' }), Math.max(1, record.expiresAt - Date.now()));
  timer.unref();
  record.item.projectId ??= record.projectId;
  pending.set(record.id, { item: record.item, resolve: () => {}, timer, reviewing: false, durable: record });
  if (record.expiresAt <= Date.now()) finish(record.id, { approved: false, message: 'The approval expired.' });
}

function restoreDurableApprovals() {
  for (const name of listFiles(privateDataPath('runtime', 'eve', 'approvals'), (file) => /^ap[0-9a-f]{64}\.json$/.test(file))) {
    const record = durableById(name.slice(0, -5));
    if (record) restoreDurable(record);
  }
}

/** Persist a request without waiting in an ordinary tool executor. Eve parks the call itself. */
export function ensureDurableApproval(operationId: string, request: ApprovalRequest): DurableApprovalRecord {
  const id = durableId(operationId);
  const fingerprint = approvalFingerprint(request);
  const existing = durableById(id);
  if (existing) {
    if (existing.fingerprint !== fingerprint) throw new Error('The approval does not match this operation.');
    restoreDurable(existing);
    return durableById(id) || existing;
  }
  const item: Approval = { id, kind: request.kind || 'tool', title: request.title, detail: request.detail || '', agentId: request.agentId || null, agentName: request.agentName || '', data: request.data || {}, editable: request.editable ?? null, createdAt: Date.now(), projectId: activeProject().id };
  const reviewing = brainChecks(item);
  const record: DurableApprovalRecord = { id, operationId, fingerprint, item, projectId: activeProject().id, expiresAt: Date.now() + (request.timeoutMs ?? 30 * 60_000), reviewing };
  writeJSON(durableFile(id), record);
  const timer = setTimeout(() => finish(id, { approved: false, message: 'The approval expired.' }), Math.max(1, record.expiresAt - Date.now()));
  timer.unref();
  pending.set(id, { item, resolve: () => {}, timer, reviewing, durable: record });
  if (reviewing) void brainReview(id);
  else askUser(id);
  return durableById(id) || record;
}

// Set by the server at start (kept out of this file so approvals don't depend on the Brain's code).
let reviewer: Reviewer | null = null;
export function setReviewer(fn: Reviewer | null) {
  reviewer = fn;
}

// The Brain checks what agents and teams want to do. Workflow checkpoints are steps you put
// there to check yourself, an outside MCP client isn't one of your agents, and a setting is yours
// (an agent asking isn't you asking): those always come to you.
const brainChecks = (item: Approval) => !!reviewer && item.kind !== 'workflow' && item.kind !== 'setting' && item.agentId !== '_external' && getSettings().brainApproves !== false;

export function requestApproval(request: ApprovalRequest): Promise<ApprovalDecision> {
  if (request.operationId) {
    const record = ensureDurableApproval(request.operationId, request);
    if (record.decision) return Promise.resolve(record.decision);
    return new Promise((resolve) => {
      const entry = pending.get(record.id);
      if (!entry) return resolve({ approved: false, message: 'The approval is no longer available.' });
      const previous = entry.resolve;
      entry.resolve = (decision) => { previous(decision); resolve(decision); };
    });
  }
  const { kind = 'tool', title, detail = '', agentId = null, agentName = '', data = {}, editable = null, timeoutMs = 30 * 60_000 } = request;
  const id = uid('ap');
  return new Promise((resolve) => {
    const item: Approval = { id, kind, title, detail, agentId, agentName, data, editable, createdAt: Date.now(), projectId: activeProject().id };
    const timer = setTimeout(() => finish(id, { approved: false, message: 'No answer within 30 minutes, so it was skipped.' }), timeoutMs);
    const review = brainChecks(item);
    pending.set(id, { item, resolve, timer, reviewing: review });
    if (review) void brainReview(id);
    else askUser(id);
  });
}

function askUser(id: string, note?: string) {
  const p = pending.get(id);
  if (!p) return;
  p.reviewing = false;
  if (note) p.item.brainNote = note;
  if (p.durable) writeJSON(durableFile(id), { ...p.durable, item: p.item, reviewing: false });
  emit('approvals');
  log('approval', `${p.item.agentName || 'Dashboard'} is waiting for you: ${p.item.title}${note ? ` (the Brain: ${note})` : ''}`, { agentId: p.item.agentId });
}

async function brainReview(id: string) {
  const p = pending.get(id);
  if (!p || !reviewer) return askUser(id);
  let verdict: BrainVerdict;
  try {
    const project = p.durable ? listProjects().find((item) => item.id === p.durable?.projectId) : null;
    if (p.durable && !project) return void finish(id, { approved: false, message: 'The request project no longer exists.' });
    verdict = await (project ? withProject(project, () => reviewer!(p.item)) : reviewer(p.item));
  } catch (e) {
    return askUser(id, `couldn't check this (${String(e instanceof Error ? e.message : e).slice(0, 160)})`);
  }
  // you may have answered it already, or the run was stopped
  if (!pending.has(id)) return;
  if (!verdict.approve) return askUser(id, verdict.reason || 'not sure about this one');
  log('approval', `The Brain allowed: ${p.item.title}${verdict.reason ? ` (${verdict.reason})` : ''}`, { agentId: p.item.agentId });
  finish(id, { approved: true, message: '' });
}

function finish(id: string, decision: ApprovalDecision): boolean {
  const p = pending.get(id);
  if (!p) return false;
  clearTimeout(p.timer);
  if (p.durable) writeJSON(durableFile(id), { ...p.durable, item: p.item, reviewing: false, decision });
  pending.delete(id);
  p.resolve(decision);
  if (!p.reviewing) emit('approvals');
  return true;
}

export function decide(id: string, { approved, message = '', edited = null, always = false }: { approved?: unknown; message?: string; edited?: unknown; always?: boolean }): boolean {
  const saved = durableById(id);
  if (saved) restoreDurable(saved);
  const p = pending.get(id);
  if (!p) return false;
  log('approval', `${approved ? 'Allowed' : 'Denied'}: ${p.item.title}`, { agentId: p.item.agentId });
  return finish(id, { approved: !!approved, message, edited, always });
}

/** What waits for you (requests the Brain is still checking aren't shown yet). */
export function listApprovals(): Approval[] {
  restoreDurableApprovals();
  return [...pending.values()]
    .filter((p) => !p.reviewing)
    .map((p) => p.item)
    .sort((a, b) => a.createdAt - b.createdAt);
}

// Cancel everything a stopped run was waiting on.
export function cancelForRun(runId: string, { keepOutcomeChecks = false }: { keepOutcomeChecks?: boolean } = {}) {
  restoreDurableApprovals();
  for (const [id, p] of pending) if (p.item.data?.runId === runId && !(keepOutcomeChecks && p.item.data.outcomeCheck === true)) finish(id, { approved: false, message: 'The run was stopped.' });
}
