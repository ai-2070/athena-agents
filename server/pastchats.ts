// Past conversations of the Brain and of each team. The open conversation stays where it always was
// (brain-chat.json, teamchats/<team id>.json); New chat files it away here, and opening a past one swaps the two:
// data/projects/<project>/past-chats/brain/<id>.json and past-chats/teams/<team folder>/<id>.json.
// Each file is the conversation as it was when open, plus its id and when it started and last changed.
// The steps (list, new, open, delete) are the same for both; each place says how its conversations are kept (ThreadPlace).
import crypto from 'node:crypto';
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
type Thread<M> = ThreadMeta & { messages: M[] };

const SAFE = /^[\w-]{1,80}$/;
export const PAST_DIR = 'past-chats';
/** The most past conversations a place keeps: past this, the ones used longest ago go. */
export const PAST_KEEP = 500;

export const newThreadId = (): string => uid('t');
/** What the open conversation is called in the list before it has an id (nothing was said in it yet). */
export const OPEN_THREAD = 'open';

// A team's folder: its id, or for an id that can't name a folder (a dot, a space…), a name made from it.
const folderOf = (teamId: string) => (SAFE.test(teamId) ? teamId : `x-${crypto.createHash('sha256').update(teamId).digest('hex').slice(0, 40)}`);
function dir(owner: ThreadOwner, pid: string): string {
  if (owner.kind === 'brain') return dataPath('projects', pid, PAST_DIR, 'brain');
  return dataPath('projects', pid, PAST_DIR, 'teams', folderOf(owner.id));
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
  const f = file(owner, id, pid)!;
  writeJSON(f, { ...thread, id });
  digests.delete(f);
  return id;
}

/** Deletes a past conversation; false when there was none. */
export function dropPast(owner: ThreadOwner, id: string, pid = activeProject().id): boolean {
  const f = file(owner, id, pid);
  if (!f || !fs.existsSync(f)) return false;
  fs.rmSync(f, { force: true });
  digests.delete(f);
  return true;
}

// ---------- the list, without reading every conversation each time ----------
/** A past conversation's line in the list, and what it holds on to (holds: a team's agent sessions). */
interface Digest {
  summary: ThreadSummary;
  holds: string[];
}
// by file; a file read again only once it changed (or this server wrote it)
const digests = new Map<string, { mtimeMs: number; size: number; digest: Digest | null }>();
type Digested<M extends { ts?: number }, T extends Thread<M>> = Pick<ThreadPlace<M, T>, 'owner' | 'pid' | 'yours' | 'holds'>;
function pastDigests<M extends { ts?: number }, T extends Thread<M>>(place: Digested<M, T>): Digest[] {
  const folder = dir(place.owner, place.pid);
  const seen = new Set<string>();
  const out = pastIds(place.owner, place.pid).flatMap((id) => {
    const f = path.join(folder, `${id}.json`);
    let st: fs.Stats;
    try {
      st = fs.statSync(f);
    } catch {
      return [];
    }
    seen.add(f);
    const was = digests.get(f);
    if (was && was.mtimeMs === st.mtimeMs && was.size === st.size) return was.digest ? [was.digest] : [];
    const t = readPast<T>(place.owner, id, place.pid);
    const digest = t && Array.isArray(t.messages) ? { summary: summarize(t, t.messages, place.yours, false), holds: place.holds?.(t) || [] } : null;
    digests.set(f, { mtimeMs: st.mtimeMs, size: st.size, digest });
    return digest ? [digest] : [];
  });
  // (files gone since: forgotten here too)
  for (const f of digests.keys()) if (path.dirname(f) === folder && !seen.has(f)) digests.delete(f);
  return out;
}
/** What the place's past conversations hold on to (ThreadPlace.holds). */
export function pastHolds<M extends { ts?: number }, T extends Thread<M>>(place: Digested<M, T>): Set<string> {
  return new Set(pastDigests(place).flatMap((d) => d.holds));
}

// ---------- the steps ----------
/** A place with conversations (the Brain chat, a team's chat): how its open one is kept, and what happens around it. */
export interface ThreadPlace<M extends { ts?: number }, T extends Thread<M>> {
  owner: ThreadOwner;
  pid: string;
  /** the open conversation, as it is saved */
  open(): T;
  /** an empty conversation (the steps give it its id) */
  blank(): T;
  /** what you wrote in one of its messages, or null when it isn't yours (a chat is named by the first) */
  yours(m: M): string | null;
  /** what a past one holds on to (a team's agent sessions), for pastHolds() */
  holds?(t: T): string[];
  /** false while something is on its way into the open one: New chat then files it away even if it is empty */
  settled?(): boolean;
  /** before another conversation opens: what goes on in the open one ends, and it is filed away (or dropped: empty) */
  leave(open: T): void;
  /** makes this the open one: a new one, or a past one opened again */
  show(thread: T, how: 'new' | 'opened'): void;
  /** empties the open one */
  clear(): void;
  /** a past one was deleted (or let go: there were more than PAST_KEEP) */
  forget(past: T): void;
}

/** Its conversations: the open one first, then the past ones newest first. */
export function listThreads<M extends { ts?: number }, T extends Thread<M>>(place: ThreadPlace<M, T>): ThreadSummary[] {
  const open = place.open();
  const past = pastDigests(place).map((d) => d.summary);
  return byRecent([summarize({ ...open, id: open.id || OPEN_THREAD }, open.messages, place.yours, true), ...past]);
}

/** New chat: the open conversation is kept with the others, and an empty one opens. */
export function startThread<M extends { ts?: number }, T extends Thread<M>>(place: ThreadPlace<M, T>): { id: string } {
  const open = place.open();
  // (already a new one: nothing to file away)
  if (!open.messages.length && open.id && (place.settled?.() ?? true)) return { id: open.id };
  place.leave(open);
  const id = newThreadId();
  place.show({ ...place.blank(), id, createdAt: Date.now() }, 'new');
  keepFew(place);
  return { id };
}

/** Opens a past conversation: the one open now takes its place among the others. */
export function reopenThread<M extends { ts?: number }, T extends Thread<M>>(place: ThreadPlace<M, T>, id: string): { id: string } {
  const open = place.open();
  if (id === OPEN_THREAD || id === open.id) return { id: open.id || OPEN_THREAD };
  const past = readPast<T>(place.owner, id, place.pid);
  if (!past || !Array.isArray(past.messages)) throw new Error('That chat is no longer there.');
  place.leave(open);
  const { updatedAt: _left, ...thread } = past;
  place.show({ ...place.blank(), ...thread, id, createdAt: past.createdAt || past.messages[0]?.ts || Date.now() }, 'opened');
  dropPast(place.owner, id, place.pid);
  keepFew(place);
  return { id };
}

/** Deletes a conversation. The open one is emptied instead. */
export function deleteThread<M extends { ts?: number }, T extends Thread<M>>(place: ThreadPlace<M, T>, id: string): void {
  const open = place.open();
  if (id === OPEN_THREAD || id === open.id) return place.clear();
  const past = readPast<T>(place.owner, id, place.pid);
  if (!past || !dropPast(place.owner, id, place.pid)) throw new Error('That chat is no longer there.');
  place.forget(past);
}

// more than PAST_KEEP: the ones used longest ago go
function keepFew<M extends { ts?: number }, T extends Thread<M>>(place: ThreadPlace<M, T>): void {
  const list = pastDigests(place);
  if (list.length <= PAST_KEEP) return;
  for (const d of list.sort((a, b) => b.summary.updatedAt - a.summary.updatedAt).slice(PAST_KEEP)) {
    const t = readPast<T>(place.owner, d.summary.id, place.pid);
    if (t && dropPast(place.owner, d.summary.id, place.pid)) place.forget(t);
  }
}

// ---------- backups ----------
/** Where a past conversation is kept, under past-chats/ (how backups name them). */
export const PAST_NAME = /^(brain|teams\/[\w-]{1,80})\/[\w-]{1,80}\.json$/;
/** A project's past conversations for a backup, the newest first, as many as fit in budget (bytes); the rest are
 *  counted in budget.omitted. */
export function packPast(pid: string, budget: { left: number; omitted: number }): { name: string; data: unknown }[] {
  const root = dataPath('projects', pid, PAST_DIR);
  const names = [
    ...listFiles(path.join(root, 'brain'), (n) => n.endsWith('.json')).map((n) => `brain/${n}`),
    ...listDirs(path.join(root, 'teams')).flatMap((t) => listFiles(path.join(root, 'teams', t), (n) => n.endsWith('.json')).map((n) => `teams/${t}/${n}`)),
  ];
  const files = names.filter((n) => PAST_NAME.test(n)).flatMap((name) => {
    const f = path.join(root, ...name.split('/'));
    try {
      const st = fs.lstatSync(f);
      return st.isFile() ? [{ name, f, size: st.size, at: st.mtimeMs }] : [];
    } catch {
      return [];
    }
  });
  return files.sort((a, b) => b.at - a.at).flatMap(({ name, f, size }) => {
    if (size > budget.left) {
      budget.omitted++;
      return [];
    }
    const data = readJSON<unknown>(f);
    if (data == null) return [];
    budget.left -= size;
    return [{ name, data }];
  });
}
/** Puts a backup's past conversations back (names that aren't one's place are skipped). */
export function unpackPast(pid: string, list: { name: string; data: unknown }[]): void {
  for (const { name, data } of list) if (PAST_NAME.test(name) && data != null) writeJSON(dataPath('projects', pid, PAST_DIR, ...name.split('/')), data);
}

// ---------- the list's lines ----------
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
