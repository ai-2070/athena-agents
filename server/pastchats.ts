// Past conversations of the Brain and of each team. The open conversation stays where it always was
// (brain-chat.json, teamchats/<team id>.json); New chat files it away here, and opening a past one swaps the two:
// data/projects/<project>/past-chats/brain/<id>.json and past-chats/teams/<team id>/<id>.json.
// Each file is the conversation as it was when open, plus its id and when it started and last changed.
import fs from 'node:fs';
import path from 'node:path';
import { activeProject } from './store.ts';
import { dataPath, listDirs, listFiles, readJSON, uid, writeJSON } from './util.ts';
import type { ThreadSummary } from '../shared/types.ts';

/** Whose conversations: the Brain's, or a team's. */
export type ThreadOwner = { kind: 'brain' } | { kind: 'team'; id: string };
/** What every saved conversation has besides its messages. */
export interface ThreadMeta {
  id?: string;
  createdAt?: number;
  updatedAt?: number;
}

const SAFE = /^[\w-]{1,80}$/;
export const PAST_DIR = 'past-chats';

export const newThreadId = (): string => uid('t');
/** What the open conversation is called in the list before it has an id (nothing was said in it yet). */
export const OPEN_THREAD = 'open';

function dir(owner: ThreadOwner, pid: string): string {
  if (owner.kind === 'brain') return dataPath('projects', pid, PAST_DIR, 'brain');
  if (!SAFE.test(owner.id)) throw new Error('No such team.');
  return dataPath('projects', pid, PAST_DIR, 'teams', owner.id);
}
function file(owner: ThreadOwner, id: string, pid: string): string | null {
  return SAFE.test(id) ? path.join(dir(owner, pid), `${id}.json`) : null;
}

/** The ids of its past conversations. */
export function pastIds(owner: ThreadOwner, pid = activeProject().id): string[] {
  return listFiles(dir(owner, pid), (n) => n.endsWith('.json')).map((n) => n.slice(0, -5)).filter((id) => SAFE.test(id));
}

export function readPast<T extends ThreadMeta>(owner: ThreadOwner, id: string, pid = activeProject().id): T | null {
  const f = file(owner, id, pid);
  const saved = f ? readJSON<T>(f) : null;
  return saved && typeof saved === 'object' ? { ...saved, id } : null;
}

/** Files a conversation away (under its own id, or a new one). Returns the id it was filed under. */
export function filePast<T extends ThreadMeta>(owner: ThreadOwner, thread: T, pid = activeProject().id): string {
  const id = thread.id && SAFE.test(thread.id) ? thread.id : newThreadId();
  writeJSON(file(owner, id, pid)!, { ...thread, id });
  return id;
}

/** Deletes a past conversation; false when there was none. */
export function dropPast(owner: ThreadOwner, id: string, pid = activeProject().id): boolean {
  const f = file(owner, id, pid);
  if (!f || !fs.existsSync(f)) return false;
  fs.rmSync(f, { force: true });
  return true;
}

/** Every past conversation, read whole. */
export function allPast<T extends ThreadMeta>(owner: ThreadOwner, pid = activeProject().id): (T & { id: string })[] {
  return pastIds(owner, pid).flatMap((id) => {
    const t = readPast<T>(owner, id, pid);
    return t ? [t as T & { id: string }] : [];
  });
}

/** Where a past conversation is kept, under past-chats/ (how backups name them). */
export const PAST_NAME = /^(brain|teams\/[\w-]{1,80})\/[\w-]{1,80}\.json$/;
/** Every past conversation of a project, for a backup. */
export function packPast(pid: string): { name: string; data: unknown }[] {
  const root = dataPath('projects', pid, PAST_DIR);
  const names = [
    ...listFiles(path.join(root, 'brain'), (n) => n.endsWith('.json')).map((n) => `brain/${n}`),
    ...listDirs(path.join(root, 'teams')).flatMap((t) => listFiles(path.join(root, 'teams', t), (n) => n.endsWith('.json')).map((n) => `teams/${t}/${n}`)),
  ];
  return names.filter((n) => PAST_NAME.test(n)).flatMap((name) => {
    const data = readJSON<unknown>(path.join(root, ...name.split('/')));
    return data != null ? [{ name, data }] : [];
  });
}
/** Puts a backup's past conversations back (names that aren't one's place are skipped). */
export function unpackPast(pid: string, list: { name: string; data: unknown }[]): void {
  for (const { name, data } of list) if (PAST_NAME.test(name) && data != null) writeJSON(dataPath('projects', pid, PAST_DIR, ...name.split('/')), data);
}

/** A conversation's name: the start of the first thing you wrote in it. */
export function threadTitle(first: string | undefined): string {
  const t = String(first || '').replace(/\s+/g, ' ').trim();
  if (!t) return 'New chat';
  return t.length > 60 ? `${t.slice(0, 59).trimEnd()}…` : t;
}

/** One line of the list. messages: what's in it (yours are the ones for which mine() is true). */
export function summarize<M extends { ts?: number }>(thread: ThreadMeta, messages: M[], mine: (m: M) => string | null, open: boolean): ThreadSummary {
  const first = messages.map(mine).find((t) => t != null);
  const createdAt = thread.createdAt || messages[0]?.ts || 0;
  const last = messages.at(-1)?.ts;
  return { id: thread.id || '', title: threadTitle(first ?? undefined), count: messages.length, createdAt, updatedAt: Math.max(last || 0, thread.updatedAt || 0, createdAt), open };
}

/** The open one first, then the rest newest first. */
export const byRecent = (list: ThreadSummary[]): ThreadSummary[] => list.sort((a, b) => Number(b.open) - Number(a.open) || b.updatedAt - a.updatedAt);
