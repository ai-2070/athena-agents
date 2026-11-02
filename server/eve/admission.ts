import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { agents, chats, withProject } from '../store.ts';
import { readExecution } from '../execution.ts';
import { cleanAttachments, safeUploadsRoot, withAttachments } from '../uploads.ts';
import { estimateTokens } from '../context.ts';
import { listFiles, readPlain, realTarget, isInside, writeJSON } from '../util.ts';
import { privateDataPath } from '../private.ts';
import { canonical } from '../../shared/canonical.ts';
import { beginRun, bindSession, conversationBinding, invalidateConversation, readRun, recordAdmissionReceipt, sessionContext, setRunStatus, settleRun } from './state.ts';
import type { EveAdmissionRecord, EveMessagePart, ExecutionRun, Project } from '../../shared/types.ts';
import type { Client } from 'eve/client';
import { selectEveModel } from './model.ts';

import { EVE_GENERATION } from './version.ts';
export { EVE_GENERATION } from './version.ts';
const file = (id: string) => privateDataPath('runtime', 'eve', 'admissions', `${id}.json`);
const hash = (value: unknown) => crypto.createHash('sha256').update(canonical(value)).digest('hex');
const identity = (record: EveAdmissionRecord) => ({ id: record.id, bindingId: record.bindingId, mode: record.mode, sessionId: record.sessionId, message: record.message, history: record.history, historyKeys: record.historyKeys, selection: record.selection });
const MAX_FILE = 16 * 1024 * 1024;
const MAX_TOTAL = 24 * 1024 * 1024;

export function readAdmission(id: string): EveAdmissionRecord | null {
  if (!/^[\w-]{1,120}$/.test(id)) return null;
  const record = readPlain<EveAdmissionRecord | null>(file(id), null);
  if (record && (record.id !== id || record.fingerprint !== hash(identity(record)) || record.messageHash !== hash(record.message))) throw new Error('The saved Eve input changed.');
  return record;
}

export function pendingAdmissions(): EveAdmissionRecord[] {
  return listFiles(privateDataPath('runtime', 'eve', 'admissions'), (name) => name.endsWith('.json')).map((name) => readAdmission(name.slice(0, -5))).filter((item): item is EveAdmissionRecord => !!item && item.status === 'prepared');
}

function receiptFor(runId: string): ExecutionRun {
  const receipt = readExecution().runs.find((item) => item.id === runId);
  if (!receipt) throw new Error('This Eve input has no saved run owner.');
  return receipt;
}

export function validAdmission(runId: string): boolean {
  const input = readAdmission(runId);
  const run = readRun(runId);
  if (!input || !run || input.bindingId !== run.bindingId || input.status !== 'prepared' || !['queued', 'running', 'waiting'].includes(run.status)) return false;
  let binding;
  try { binding = sessionContext(input.bindingId).binding; }
  catch { return false; }
  const receipt = readExecution().runs.find((item) => item.id === runId);
  return !!receipt && receipt.projectId === binding.projectId && receipt.agentId === binding.agentId && receipt.chatId === binding.chatId && receipt.depth === run.depth && receipt.parentRunId === run.parentRunId && receipt.status === 'running' && !receipt.stopRequested;
}

function messageParts(receipt: ExecutionRun): EveMessagePart[] {
  const attachments = cleanAttachments(receipt.attachments);
  if (attachments.length !== receipt.attachments.length) throw new Error('An attached file is missing or outside this project. Attach it again before continuing.');
  const root = safeUploadsRoot();
  const realRoot = root && realTarget(root);
  const parts: EveMessagePart[] = [{ type: 'text', text: withAttachments(receipt.text, attachments, { inline: 24000 }) || 'Please examine the attached files.' }];
  let total = 0;
  for (const attachment of attachments) {
    const target = realTarget(attachment);
    if (!realRoot || !target || !isInside(realRoot, target)) throw new Error('The attachment no longer belongs to this project.');
    const stat = fs.statSync(target);
    if (stat.isDirectory()) continue;
    if (stat.size > MAX_FILE || total + stat.size > MAX_TOTAL) throw new Error('Eve accepts up to 16 MB per file and 24 MB per turn. Use smaller attachments or the file tools.');
    const bytes = fs.readFileSync(target);
    if (bytes.length > MAX_FILE || total + bytes.length > MAX_TOTAL) throw new Error('The attached file grew too large. Attach a smaller copy.');
    total += bytes.length;
    const ext = path.extname(target).toLowerCase();
    const mediaType = ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json' } as Record<string, string>)[ext] || 'application/octet-stream';
    parts.push({ type: 'file', filename: path.basename(attachment), mediaType, data: `data:${mediaType};base64,${bytes.toString('base64')}` });
  }
  return parts;
}

/** Save the exact bytes before dispatch; retry never rereads an edited or deleted attachment. */
export async function prepareAdmission(runId: string, project: Project): Promise<EveAdmissionRecord> {
  const existing = readAdmission(runId);
  const receipt = receiptFor(runId);
  if (receipt.projectId !== project.id || receipt.status !== 'running' || receipt.stopRequested) throw new Error('This input is no longer active in its project.');
  if (existing) return existing;
  return withProject(project, async () => {
    const agent = agents.get(receipt.agentId);
    const chat = chats.get(receipt.agentId, receipt.chatId);
    if (!agent || !chat) throw new Error('This conversation no longer exists.');
    const selection = await selectEveModel(agent, chat);
    const generation = hash({ runtime: EVE_GENERATION, engine: agent.engine, model: selection, reset: chat.items.findLastIndex((item) => item.type === 'meta' && item.reset) });
    let binding = conversationBinding(project.id, agent.id, chat.id, generation);
    if (!binding) {
      invalidateConversation(project.id, chat.id);
      binding = bindSession(agent, chat, project, generation);
    }
    sessionContext(binding.id);
    const imported = new Set(binding.imported || []);
    const history: EveAdmissionRecord['history'] = [];
    const historyKeys: string[] = [];
    if (!binding.sessionId) {
      const upto = chat.items.findIndex((item) => item.type === 'user' && item.runId === runId);
      const before = upto < 0 ? chat.items : chat.items.slice(0, upto);
      const reset = before.findLastIndex((item) => item.type === 'meta' && item.reset);
      for (const [i, item] of before.slice(reset + 1).entries()) {
        const key = item.type === 'user' && item.teamMessageId ? `team:${item.teamMessageId}` : `chat:${reset + 1 + i}`;
        if (history.some((entry) => entry.id === key)) continue;
        if (item.type === 'user' && item.teamMessageId) historyKeys.push(key);
        const text = item.type === 'user' ? `${item.from ? `${item.from}:\n` : ''}${item.text}${item.attachments?.length ? `\n\nHistorical attachments (use the file tools to read them):\n${item.attachments.join('\n')}` : ''}`
          : item.type === 'assistant' ? item.text : item.type === 'tool' ? `Previous tool ${item.name}\nInput: ${JSON.stringify(item.args || {})}\nResult: ${item.result ?? '(unfinished)'}` : '';
        if (text.trim()) history.push({ id: key, role: item.type === 'user' ? 'user' : 'assistant', text });
      }
    } else for (const item of receipt.context || []) {
      const key = `team:${item.id}`;
      if (imported.has(key)) continue;
      imported.add(key);
      historyKeys.push(key);
      history.push({ id: key, role: 'user', text: item.text });
    }
    const message = messageParts(receipt);
    const [{ buildSystemPrompt }, { richSection }, { gatherTools }] = await Promise.all([import('../engines/index.ts'), import('../richanswers.ts'), import('../apitools.ts')]);
    const current = sessionContext(binding.id);
    const [{ defs }, rich] = await Promise.all([gatherTools(current.agent, () => {}), richSection(current.agent, chat, receipt.depth)]);
    const window = selection.contextWindow;
    const tokens = estimateTokens(buildSystemPrompt(current.agent) + rich + JSON.stringify(defs) + history.map((item) => item.text).join('\n') + message.filter((part) => part.type === 'text').map((part) => part.text).join('\n'));
    if (tokens > window * 0.85) throw new Error('The saved conversation does not fit this model. Choose a larger-context model or clear memory. No original messages were discarded.');
    // Awaited model metadata must not revive a run stopped in the meantime.
    if (receiptFor(runId).stopRequested || receiptFor(runId).status !== 'running') throw new Error('Stopped.');
    sessionContext(binding.id);
    beginRun(runId, binding.id, receipt.depth, receipt.parentRunId);
    const input = { id: runId, bindingId: binding.id, mode: binding.sessionId ? 'send' : 'create', sessionId: binding.sessionId, message, history, historyKeys, selection, messageHash: hash(message), status: 'prepared', createdAt: Date.now() } satisfies Omit<EveAdmissionRecord, 'fingerprint'>;
    const record: EveAdmissionRecord = { ...input, fingerprint: hash(identity({ ...input, fingerprint: '' })) };
    writeJSON(file(runId), record);
    setRunStatus(runId, 'running');
    return record;
  });
}

/** Called by the authenticated channel before dispatching history into its native context. */
export function admissionHistory(bindingId: string, runId: string, messageHash: string, sessionId?: string) {
  const input = readAdmission(runId);
  if (!input || input.bindingId !== bindingId || input.messageHash !== messageHash || input.sessionId !== (sessionId || null) || !validAdmission(runId)) throw new Error('The Eve message does not match its saved admission.');
  return input.history;
}

export async function submitAdmission(input: EveAdmissionRecord, client: Client, signal?: AbortSignal): Promise<void> {
  const current = readAdmission(input.id);
  if (!current || current.fingerprint !== input.fingerprint) throw new Error('The saved Eve input changed.');
  if (current.status === 'accepted') return;
  if (current.status !== 'prepared' || !validAdmission(input.id)) throw new Error('This Eve input cannot be dispatched.');
  const route = input.mode === 'create' ? '/eve/v1/session' : `/eve/v1/session/${encodeURIComponent(input.sessionId!)}`;
  const response = await client.fetch(route, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-athena-run': input.id },
    body: JSON.stringify({ message: input.message, ...(input.mode === 'create' ? { operationId: `athena:${input.bindingId}` } : { idempotencyKey: `athena:${input.id}` }) }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    if (response.status >= 400 && response.status < 500 && ![408, 409, 429].includes(response.status)) {
      writeJSON(file(input.id), { ...current, status: 'cancelled' });
      settleRun(input.id, 'failed', '', 'Eve could not accept this saved input.');
    }
    throw new Error('Eve could not acknowledge the saved input.');
  }
  const receipt: unknown = await response.json();
  if (!receipt || typeof receipt !== 'object' || !('sessionId' in receipt) || typeof receipt.sessionId !== 'string' || !('deliveryId' in receipt) || typeof receipt.deliveryId !== 'string' || input.sessionId && receipt.sessionId !== input.sessionId) throw new Error('Eve returned an invalid input receipt.');
  recordAdmissionReceipt(input.id, receipt.sessionId, receipt.deliveryId, input.historyKeys);
  writeJSON(file(input.id), { ...current, status: 'accepted' });
}
