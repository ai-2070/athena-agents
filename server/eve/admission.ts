import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { agents, chats, withProject } from '../store.ts';
import { readExecution } from '../execution.ts';
import { cleanAttachments, safeUploadsRoot, withAttachmentsReadWhole } from '../uploads.ts';
import { isDocumentName } from '../documents.ts';
import { estimateTokens, stopMark } from '../context.ts';
import { listFiles, realTarget, isInside } from '../util.ts';
import { privateDataPath } from '../private.ts';
import { canonical } from '../../shared/canonical.ts';
import {
  beginRun,
  bindSession,
  conversationBinding,
  invalidateConversation,
  readRun,
  recordAdmissionReceipt,
  sessionContext,
  setRunStatus,
  settleRun,
} from './state.ts';
import type {
  EveAdmissionRecord,
  EveMessagePart,
  EveModelSelection,
  ExecutionRun,
  Project,
} from '../../shared/types.ts';
import type { Client } from 'eve/client';
import { selectEveModel } from './model.ts';
import { fileTokens } from './media.ts';
import { RecordFiles } from './records.ts';
import { buildInstructions, keepInstructions } from './snapshot.ts';

import { EVE_GENERATION } from './version.ts';
export { EVE_GENERATION } from './version.ts';
const file = (id: string) => privateDataPath('runtime', 'eve', 'admissions', `${id}.json`);
const hash = (value: unknown) => crypto.createHash('sha256').update(canonical(value)).digest('hex');
const identity = (record: EveAdmissionRecord) => ({
  id: record.id,
  bindingId: record.bindingId,
  mode: record.mode,
  sessionId: record.sessionId,
  message: record.message,
  history: record.history,
  historyKeys: record.historyKeys,
  selection: record.selection,
});
const MAX_FILE = 16 * 1024 * 1024;
const MAX_TOTAL = 24 * 1024 * 1024;

/** Conservative bounds for Eve's pinned media estimator; never import private harness code. */
export function messageTokens(parts: readonly EveMessagePart[]): number {
  return (
    128 +
    parts.reduce((sum, part) => {
      if (part.type === 'text')
        return sum + Math.max(estimateTokens(part.text), Math.ceil(Buffer.byteLength(JSON.stringify(part)) / 4));
      const encoded = part.data.slice(part.data.indexOf(',') + 1);
      return sum + 128 + fileTokens(part.mediaType, encoded);
    }, 0)
  );
}

// Inputs can hold large attachments: only some whole records stay in memory. A changed file is checked again.
const files = new RecordFiles<EveAdmissionRecord, Pick<EveAdmissionRecord, 'status' | 'selection'>>({
  maxBytes: 16 * 1024 * 1024,
  summarize: (record) => ({ status: record.status, selection: record.selection }),
  check: (record, saved) => {
    if (
      record.id !== path.basename(saved, '.json') ||
      record.fingerprint !== hash(identity(record)) ||
      record.messageHash !== hash(record.message)
    )
      throw new Error('The saved Eve input changed.');
  },
});
const idOk = (id: string) => /^[\w-]{1,120}$/.test(id);

export function readAdmission(id: string): EveAdmissionRecord | null {
  return idOk(id) ? files.read(file(id)) : null;
}

/** The turn's pinned model options, without reading its saved input again. */
export function admissionSelection(id: string): EveModelSelection | null {
  return idOk(id) ? files.summary(file(id))?.selection || null : null;
}

export function pendingAdmissions(): EveAdmissionRecord[] {
  return listFiles(privateDataPath('runtime', 'eve', 'admissions'), (name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -5))
    .filter((id) => idOk(id) && files.summary(file(id))?.status === 'prepared')
    .map((id) => readAdmission(id))
    .filter((item): item is EveAdmissionRecord => !!item && item.status === 'prepared');
}

/** For retention only. */
export function removeAdmission(id: string): void {
  if (idOk(id)) files.remove(file(id));
}

function receiptFor(runId: string): ExecutionRun {
  const receipt = readExecution().runs.find((item) => item.id === runId);
  if (!receipt) throw new Error('This Eve input has no saved run owner.');
  return receipt;
}

export function validAdmission(runId: string): boolean {
  const input = readAdmission(runId);
  const run = readRun(runId);
  if (
    !input ||
    !run ||
    input.bindingId !== run.bindingId ||
    input.status !== 'prepared' ||
    !['queued', 'running', 'waiting'].includes(run.status)
  )
    return false;
  let binding;
  try {
    binding = sessionContext(input.bindingId).binding;
  } catch {
    return false;
  }
  const receipt = readExecution().runs.find((item) => item.id === runId);
  return (
    !!receipt &&
    receipt.projectId === binding.projectId &&
    receipt.agentId === binding.agentId &&
    receipt.chatId === binding.chatId &&
    receipt.depth === run.depth &&
    receipt.parentRunId === run.parentRunId &&
    receipt.status === 'running' &&
    !receipt.stopRequested
  );
}

function messageParts(receipt: ExecutionRun): Promise<EveMessagePart[]> {
  return eveMessage(receipt.text, receipt.attachments);
}

// PDF, Word, Excel and PowerPoint files go as their text, in the message: compatible APIs take no Office files and
// many no PDFs, and a PDF's pages cost far more than its text. Only a document whose text went along whole (or why it
// can't be read) is left out as a file. A PDF that didn't fit, or has no text (a scan), still goes as itself; an
// Office file never does, and the message points to read_document for what isn't there.
const officeFile = (file: string) => isDocumentName(file) && !/\.pdf$/i.test(file);

/** A message for Eve: its text (small text files and documents' text inline) and the attached files' bytes. */
export async function eveMessage(text: string, saved: readonly string[]): Promise<EveMessagePart[]> {
  const attachments = cleanAttachments([...saved]);
  if (attachments.length !== saved.length)
    throw new Error('An attached file is missing or outside this project. Attach it again before continuing.');
  const root = safeUploadsRoot();
  const realRoot = root && realTarget(root);
  const read = await withAttachmentsReadWhole(text, attachments, { inline: 24000, rest: 'read_document' });
  const parts: EveMessagePart[] = [{ type: 'text', text: read.text || 'Please examine the attached files.' }];
  let total = 0;
  for (const attachment of attachments) {
    const target = realTarget(attachment);
    if (!realRoot || !target || !isInside(realRoot, target))
      throw new Error('The attachment no longer belongs to this project.');
    const stat = fs.statSync(target);
    if (stat.isDirectory() || read.whole.has(attachment) || officeFile(target)) continue;
    if (stat.size > MAX_FILE || total + stat.size > MAX_TOTAL)
      throw new Error(
        'Eve accepts up to 16 MB per file and 24 MB per turn. Use smaller attachments or the file tools.',
      );
    const bytes = fs.readFileSync(target);
    if (bytes.length > MAX_FILE || total + bytes.length > MAX_TOTAL)
      throw new Error('The attached file grew too large. Attach a smaller copy.');
    total += bytes.length;
    const ext = path.extname(target).toLowerCase();
    const mediaType =
      (
        {
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.gif': 'image/gif',
          '.webp': 'image/webp',
          '.pdf': 'application/pdf',
          '.txt': 'text/plain',
          '.md': 'text/markdown',
          '.csv': 'text/csv',
          '.json': 'application/json',
        } as Record<string, string>
      )[ext] || 'application/octet-stream';
    parts.push({
      type: 'file',
      filename: path.basename(attachment),
      mediaType,
      data: `data:${mediaType};base64,${bytes.toString('base64')}`,
    });
  }
  return parts;
}

/** Save the exact bytes before dispatch; retry never rereads an edited or deleted attachment. */
export async function prepareAdmission(runId: string, project: Project): Promise<EveAdmissionRecord> {
  const existing = readAdmission(runId);
  const receipt = receiptFor(runId);
  if (receipt.projectId !== project.id || receipt.status !== 'running' || receipt.stopRequested)
    throw new Error('This input is no longer active in its project.');
  if (existing) return existing;
  return withProject(project, async () => {
    const agent = agents.get(receipt.agentId);
    const chat = chats.get(receipt.agentId, receipt.chatId);
    if (!agent || !chat) throw new Error('This conversation no longer exists.');
    const selection = await selectEveModel(agent, chat);
    const generation = hash({
      runtime: EVE_GENERATION,
      engine: agent.engine,
      model: selection,
      reset: chat.items.findLastIndex((item) => item.type === 'meta' && item.reset),
    });
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
        const asked = item.type === 'user' || item.type === 'steer';
        const key = asked && item.teamMessageId ? `team:${item.teamMessageId}` : `chat:${reset + 1 + i}`;
        if (history.some((entry) => entry.id === key)) continue;
        if (asked && item.teamMessageId) historyKeys.push(key);
        const text = asked
          ? `${item.from ? `${item.from}:\n` : ''}${item.text}${item.attachments?.length ? `\n\nHistorical attachments (use the file tools to read them):\n${item.attachments.join('\n')}` : ''}`
          : item.type === 'assistant'
            ? item.text
            : item.type === 'tool'
              ? `Previous tool ${item.name}\nInput: ${JSON.stringify(item.args || {})}\nResult: ${item.result ?? '(unfinished)'}`
              : stopMark(item);
        if (text.trim()) history.push({ id: key, role: asked ? 'user' : 'assistant', text });
      }
    } else
      for (const item of receipt.context || []) {
        const key = `team:${item.id}`;
        if (imported.has(key)) continue;
        imported.add(key);
        historyKeys.push(key);
        history.push({ id: key, role: 'user', text: item.text });
      }
    const message = await messageParts(receipt);
    const { gatherTools } = await import('../apitools.ts');
    const current = sessionContext(binding.id);
    const [{ defs }, instructions] = await Promise.all([
      gatherTools(current.agent, () => {}, { engine: 'eve', conversationId: chat.conversationId }),
      buildInstructions(current.agent, chat, receipt.depth),
    ]);
    const window = selection.contextWindow;
    const standing = JSON.stringify({ instructions, tools: defs });
    const envelope = Math.max(estimateTokens(standing), Math.ceil(Buffer.byteLength(standing) / 4)) + 1024;
    const addressed = messageTokens(message);
    // Eve retains at most 20k tokens or half its remaining compaction threshold for the current input.
    const currentLimit = Math.min(20000, Math.floor((window * 0.9 - envelope) / 2));
    const originalHistory = history.map((item) => ({ role: item.role, content: item.text }));
    const historySize = Math.max(
      estimateTokens(history.map((item) => item.text).join('\n')),
      Math.ceil(Buffer.byteLength(JSON.stringify(originalHistory)) / 4),
    );
    const tokens = envelope + historySize + addressed;
    if (tokens > window * 0.85)
      throw new Error(
        'The saved conversation does not fit this model. Choose a larger-context model or clear memory. No original messages were discarded.',
      );
    if (addressed > currentLimit)
      throw new Error(
        'This request and its files exceed the space Eve keeps intact during compaction. Send a smaller request or use the file tools. No input was shortened or sent.',
      );
    // Awaited model metadata must not revive a run stopped in the meantime.
    if (receiptFor(runId).stopRequested || receiptFor(runId).status !== 'running') throw new Error('Stopped.');
    sessionContext(binding.id);
    beginRun(runId, binding.id, receipt.depth, receipt.parentRunId);
    // The run sends the instructions measured here, built once for the whole run.
    keepInstructions(runId, instructions);
    const input = {
      id: runId,
      bindingId: binding.id,
      mode: binding.sessionId ? 'send' : 'create',
      sessionId: binding.sessionId,
      message,
      history,
      historyKeys,
      selection,
      messageHash: hash(message),
      status: 'prepared',
      createdAt: Date.now(),
    } satisfies Omit<EveAdmissionRecord, 'fingerprint'>;
    const record: EveAdmissionRecord = { ...input, fingerprint: hash(identity({ ...input, fingerprint: '' })) };
    files.write(file(runId), record);
    setRunStatus(runId, 'running');
    return record;
  });
}

/** Called by the authenticated channel before dispatching history into its native context. */
export function admissionHistory(bindingId: string, runId: string, messageHash: string, sessionId?: string) {
  const input = readAdmission(runId);
  if (
    !input ||
    input.bindingId !== bindingId ||
    input.messageHash !== messageHash ||
    input.sessionId !== (sessionId || null) ||
    !validAdmission(runId)
  )
    throw new Error('The Eve message does not match its saved admission.');
  return input.history;
}

export async function submitAdmission(input: EveAdmissionRecord, client: Client, signal?: AbortSignal): Promise<void> {
  const current = readAdmission(input.id);
  if (!current || current.fingerprint !== input.fingerprint) throw new Error('The saved Eve input changed.');
  if (current.status === 'accepted') return;
  if (current.status !== 'prepared' || !validAdmission(input.id))
    throw new Error('This Eve input cannot be dispatched.');
  const route = input.mode === 'create' ? '/eve/v1/session' : `/eve/v1/session/${encodeURIComponent(input.sessionId!)}`;
  const response = await client.fetch(route, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-athena-run': input.id },
    body: JSON.stringify({
      message: input.message,
      ...(input.mode === 'create'
        ? { operationId: `athena:${input.bindingId}` }
        : { idempotencyKey: `athena:${input.id}` }),
    }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    if (response.status >= 400 && response.status < 500 && ![408, 409, 429].includes(response.status)) {
      files.write(file(input.id), { ...current, status: 'cancelled' });
      settleRun(input.id, 'failed', '', 'Eve could not accept this saved input.');
    }
    throw new Error('Eve could not acknowledge the saved input.');
  }
  const receipt: unknown = await response.json();
  if (
    !receipt ||
    typeof receipt !== 'object' ||
    !('sessionId' in receipt) ||
    typeof receipt.sessionId !== 'string' ||
    !('deliveryId' in receipt) ||
    typeof receipt.deliveryId !== 'string' ||
    (input.sessionId && receipt.sessionId !== input.sessionId)
  )
    throw new Error('Eve returned an invalid input receipt.');
  recordAdmissionReceipt(input.id, receipt.sessionId, receipt.deliveryId, input.historyKeys);
  files.write(file(input.id), { ...current, status: 'accepted' });
}
