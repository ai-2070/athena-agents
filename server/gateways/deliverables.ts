import path from 'node:path';
import { z } from 'zod';
import { runInfo } from '../engines/index.ts';
import { readExecution } from '../execution.ts';
import { insideRoots, realTarget } from '../util.ts';
import { safeUploadsRoot } from '../uploads.ts';
import { readGatewayDocument } from './outgoing.ts';
import { getGatewayInstance } from './instances.ts';
import type { GatewayInbox } from './inbox.ts';
import type { GatewayInboxEvent, GatewayOutgoingFile } from '../../shared/types.ts';

const destinations = new Map<string, { inbox: GatewayInbox; signal: AbortSignal }>();
const unavailable = () => new Error('This run has no active gateway assignment for these files. Review the assignment and file access in Athena.');
const pathsSchema = z.array(z.string().min(1).max(16384)).min(1).max(10);
const filesSchema = z.array(z.strictObject({ path: z.string().min(1).max(16384), sha256: z.string().regex(/^[a-f0-9]{64}$/) })).min(1).max(10);

/** Only the live owner can hand files into its inbox. Reconnects revoke the old registration. */
export function registerGatewayDeliverables(instanceId: string, inbox: GatewayInbox, signal: AbortSignal): () => void {
  if (destinations.has(instanceId)) throw new Error('This gateway already has a file delivery owner.');
  const entry = { inbox, signal }; destinations.set(instanceId, entry);
  return () => { if (destinations.get(instanceId) === entry) destinations.delete(instanceId); };
}

function assignment(runId: string | null | undefined, agentId: string) {
  const run = runInfo(runId);
  if (!run || run.agentId !== agentId || !run.conversationId || run.signal.aborted) throw unavailable();
  const saved = readExecution().runs.find((item) => item.id === run.id && item.projectId === run.projectId && item.agentId === agentId);
  if (!saved || saved.status !== 'running' || saved.chatId !== run.chatId) throw unavailable();
  const matches: { inbox: GatewayInbox; event: GatewayInboxEvent; signal: AbortSignal }[] = [];
  for (const entry of destinations.values()) {
    if (entry.signal.aborted) continue;
    for (const event of entry.inbox.list()) {
      if (event.bindingId !== run.conversationId || event.route.projectId !== run.projectId || event.status !== 'running' || !event.dispatch || saved.startedAt < event.dispatch.startedAt) continue;
      entry.inbox.checkAccess(event);
      matches.push({ ...entry, event });
    }
  }
  if (matches.length !== 1) throw unavailable();
  return { ...matches[0]!, run };
}

async function inspect(runId: string | null | undefined, agentId: string, paths: string[]) {
  const current = assignment(runId, agentId);
  const { run, event } = current;
  const signal = AbortSignal.any([current.signal, run.signal]);
  const uploads = safeUploadsRoot(run.project);
  const workspace = run.agent.workspace && path.isAbsolute(run.agent.workspace) ? run.agent.workspace : run.project.brainPath;
  const root = realTarget(workspace);
  if (!root) throw unavailable();
  const source = { runId: run.id, agentId: run.agentId, chatId: run.chatId, workspace: root };
  const selected: Pick<GatewayOutgoingFile, 'path' | 'name' | 'size' | 'sha256' | 'source'>[] = [];
  for (const raw of paths) {
    if (!path.isAbsolute(raw) || !insideRoots(raw, [workspace, ...(uploads ? [uploads] : [])])) throw unavailable();
    const { path: real, name, size, sha256 } = await readGatewayDocument(event, raw, signal, source);
    if (selected.some((item) => item.path === real)) throw unavailable();
    selected.push({ path: real, name, size, sha256, source });
  }
  signal.throwIfAborted();
  const limits = getGatewayInstance(event.route.instanceId).fileLimits;
  if (selected.length > limits.filesPerMessage || selected.reduce((sum, file) => sum + file.size, 0) > limits.perMessageBytes) throw new Error('These files exceed this gateway’s limits. Choose fewer or smaller files.');
  const latest = assignment(runId, agentId);
  if (latest.inbox !== current.inbox || latest.event.id !== event.id) throw unavailable();
  return { ...current, selected };
}

/** Inspection discloses no bytes outside Athena and reserves no delivery. */
export async function prepareGatewayFiles(runId: string | null | undefined, agentId: string, raw: unknown) {
  const { paths } = z.strictObject({ paths: pathsSchema }).parse(raw);
  const { selected } = await inspect(runId, agentId, paths);
  return selected.map(({ path, name, size, sha256 }) => ({ path, name, size, sha256 }));
}

/** The high-risk tool's approved hashes bind its disclosure to these exact bytes. */
export async function sendGatewayFiles(runId: string | null | undefined, agentId: string, raw: unknown): Promise<number> {
  const { files } = z.strictObject({ files: filesSchema }).parse(raw);
  const current = await inspect(runId, agentId, files.map((file) => file.path));
  if (current.selected.some((file, index) => file.sha256 !== files[index]!.sha256)) throw new Error('A selected file changed. Inspect it again and request fresh approval.');
  const latest = assignment(runId, agentId);
  if (latest.inbox !== current.inbox || latest.event.id !== current.event.id) throw unavailable();
  current.inbox.selectOutgoing(current.event.id, current.selected);
  return current.selected.length;
}
