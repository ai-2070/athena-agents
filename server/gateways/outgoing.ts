import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { agents, chats, activeProject, listProjects } from '../store.ts';
import { readExecution } from '../execution.ts';
import { getTeam } from '../teams.ts';
import { DATA, insideRoots, realTarget } from '../util.ts';
import { withGatewayRoute, getGatewayInstance } from './instances.ts';
import { gatewayInputAllowed } from './inbox.ts';
import type { GatewayInbox } from './inbox.ts';
import type { GatewayInboxEvent, GatewayOutgoingFile } from '../../shared/types.ts';

export const GATEWAY_DOCUMENT_LIMIT = 20 * 1024 * 1024;
export type GatewayFileSender = (
  event: GatewayInboxEvent,
  file: GatewayOutgoingFile,
  signal: AbortSignal,
) => Promise<string>;
const unavailable = () => new Error('This file cannot be shared. Check its location, size and contents in Athena.');

function checkedPath(event: GatewayInboxEvent, file: string, source?: GatewayOutgoingFile['source']): string {
  const instance = getGatewayInstance(event.route.instanceId);
  if (!gatewayInputAllowed(instance, event.input) || !path.isAbsolute(file)) throw unavailable();
  return withGatewayRoute(event.route, () => {
    const target = event.route.target;
    const ids =
      target.kind === 'agent' ? [target.id] : target.kind === 'team' ? (getTeam(target.id)?.members ?? []) : [];
    const brain = activeProject().brainPath;
    const uploads = path.join(brain, 'uploads');
    let roots =
      target.kind === 'brain'
        ? [brain]
        : [
            ...ids.map((id) => {
              const workspace = agents.get(id)?.workspace;
              return workspace && path.isAbsolute(workspace) ? workspace : brain;
            }),
            ...(insideRoots(uploads, [brain]) ? [uploads] : []),
          ];
    if (source) {
      const run = readExecution().runs.find(
        (item) =>
          item.id === source.runId &&
          item.projectId === event.route.projectId &&
          item.agentId === source.agentId &&
          item.chatId === source.chatId,
      );
      const agent = agents.get(source.agentId);
      const chat = chats.get(source.agentId, source.chatId);
      const workspace = agent?.workspace && path.isAbsolute(agent.workspace) ? agent.workspace : brain;
      const current = realTarget(workspace);
      const original = realTarget(source.workspace);
      if (
        !run ||
        !['running', 'completed'].includes(run.status) ||
        !event.dispatch ||
        run.startedAt < event.dispatch.startedAt ||
        !agent ||
        chat?.conversationId !== event.bindingId ||
        !current ||
        !original ||
        path.relative(current, original) !== '' ||
        (chat.teamId && !getTeam(chat.teamId)?.members.includes(agent.id))
      )
        throw unavailable();
      roots = [source.workspace, ...(insideRoots(uploads, [brain]) ? [uploads] : [])];
    }
    const real = insideRoots(file, roots);
    // Runtime stores and account material never become gateway attachments, even with a broad workspace.
    const forbidden = (value: string) =>
      value
        .split(/[\\/]/)
        .some((part) =>
          /^(?:\.git|\.dashboard|\.ssh|\.aws|\.azure|\.kube|\.docker|\.gnupg|\.config|\.codex|\.claude|\.npmrc|\.netrc|\.pypirc|\.env(?:\..*)?|auth\.json|secrets?(?:\..*)?|credentials?(?:\..*)?|id_rsa|id_ed25519)$/i.test(
            part,
          ),
        ) || /\.(?:pem|key|p12|pfx|dashbackup)$/i.test(value);
    const unrelated =
      real &&
      !insideRoots(real, [activeProject().brainPath]) &&
      listProjects().some((project) => project.id !== event.route.projectId && insideRoots(real, [project.brainPath]));
    if (!real || insideRoots(real, [DATA]) || unrelated || forbidden(file) || forbidden(real)) throw unavailable();
    return real;
  });
}

/** Read a bounded regular file through one descriptor; send only these verified bytes. */
export async function readGatewayDocument(
  event: GatewayInboxEvent,
  raw: string,
  signal: AbortSignal,
  source?: GatewayOutgoingFile['source'],
): Promise<{ path: string; name: string; size: number; sha256: string; data: Buffer }> {
  signal.throwIfAborted();
  const real = checkedPath(event, raw, source);
  const handle = await fs.open(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const before = await handle.stat();
    const limit = Math.min(GATEWAY_DOCUMENT_LIMIT, getGatewayInstance(event.route.instanceId).fileLimits.perFileBytes);
    if (!before.isFile() || before.nlink !== 1 || before.size <= 0 || before.size > limit) throw unavailable();
    const data = Buffer.alloc(before.size);
    let at = 0;
    while (at < data.length) {
      signal.throwIfAborted();
      const { bytesRead } = await handle.read(data, at, Math.min(65536, data.length - at), at);
      if (!bytesRead) throw unavailable();
      at += bytesRead;
    }
    const after = await handle.stat();
    const current = await fs.stat(real);
    signal.throwIfAborted();
    if (
      checkedPath(event, raw, source) !== real ||
      current.dev !== before.dev ||
      current.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw unavailable();
    return {
      path: real,
      name: path
        .basename(real)
        .replace(/[\\/\x00-\x1f\x7f]/g, '_')
        .slice(0, 180),
      size: data.length,
      sha256: crypto.createHash('sha256').update(data).digest('hex'),
      data,
    };
  } finally {
    await handle.close();
  }
}

export async function verifyGatewayDocument(
  event: GatewayInboxEvent,
  file: GatewayOutgoingFile,
  signal: AbortSignal,
): Promise<Buffer> {
  const read = await readGatewayDocument(event, file.path, signal, file.source);
  if (read.sha256 !== file.sha256 || read.size !== file.size) throw unavailable();
  return read.data;
}

export async function selectGatewayDocuments(
  inbox: GatewayInbox,
  eventId: string,
  body: unknown,
  signal: AbortSignal,
): Promise<void> {
  try {
    const { paths } = z.strictObject({ paths: z.array(z.string().min(1).max(16384)).min(1).max(10) }).parse(body);
    const event = inbox.list().find((item) => item.id === eventId);
    if (!event) throw unavailable();
    inbox.checkAccess(event);
    const selected: Pick<GatewayOutgoingFile, 'path' | 'name' | 'size' | 'sha256'>[] = [];
    for (const file of paths) {
      const { path, name, size, sha256 } = await readGatewayDocument(event, file, signal);
      if (selected.some((item) => item.path === path)) throw unavailable();
      selected.push({ path, name, size, sha256 });
    }
    signal.throwIfAborted();
    inbox.selectOutgoing(eventId, selected);
  } catch {
    throw Object.assign(
      new Error('These files cannot be shared. Check the assignment, access, file locations and limits.'),
      { status: 400 },
    );
  }
}
