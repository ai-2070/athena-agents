// What gateways keep: the instances (global, like accounts: each names its project), their tokens (with the other
// secrets, never sent to the page), and per instance the messages it got and the chats it has talked in.
import fs from 'node:fs';
import crypto from 'node:crypto';
import {
  agents,
  collection,
  emit,
  getGatewaySecrets,
  listProjects,
  setGatewaySecrets,
  withProject,
  workflows,
} from '../store.ts';
import { dataPath, readJSON, uid, writeJSON } from '../util.ts';
import type {
  GatewayChat,
  GatewayInstance,
  GatewayMessage,
  GatewayPlatform,
  GatewayTarget,
  Project,
} from '../../shared/types.ts';

const fail = (message: string, status = 400): never => {
  throw Object.assign(new Error(message), { status });
};

export const instances = collection<GatewayInstance>('chat-gateways', { global: true });

export const PLATFORM_NAME: Record<GatewayPlatform, string> = {
  telegram: 'Telegram',
  slack: 'Slack',
  discord: 'Discord',
};

export function getInstance(id: string): GatewayInstance {
  return instances.get(id) || fail('That gateway is gone.', 404);
}

export function instanceProject(instance: GatewayInstance): Project | null {
  return listProjects().find((p) => p.id === instance.projectId) || null;
}

/** Runs fn in the instance's own project (whatever project is open in the dashboard). */
export function inInstanceProject<T>(instance: GatewayInstance, fn: (project: Project) => T): T {
  const project = instanceProject(instance) || fail(`The project of ${instance.name} was removed.`);
  return withProject(project, () => fn(project));
}

/** The target's name in its project, or null when it is gone. */
export function targetName(instance: GatewayInstance): string | null {
  const project = instanceProject(instance);
  if (!project) return null;
  return withProject(project, () => {
    const t = instance.target;
    if (t.kind === 'brain') return 'Brain';
    if (t.kind === 'agent') return agents.get(t.id)?.name ?? null;
    return workflows.get(t.id)?.name ?? null;
  });
}

export interface InstanceInput {
  platform: GatewayPlatform;
  name: string;
  projectId: string;
  target: GatewayTarget;
  users: string[];
  channels: string[];
}

const cleanIds = (list: string[]) => [...new Set(list.map((x) => x.trim()).filter(Boolean))];

/** Saves a new instance or changes one; it starts paused, and changing what it does pauses nothing. */
export function saveInstance(input: InstanceInput, id?: string): GatewayInstance {
  const before = id ? getInstance(id) : null;
  if (before && before.platform !== input.platform) fail("A gateway's app can't change. Add a new one instead.");
  const next: GatewayInstance = {
    id: before?.id ?? uid('gw'),
    platform: input.platform,
    name: input.name.trim() || PLATFORM_NAME[input.platform],
    projectId: input.projectId,
    target: input.target,
    users: cleanIds(input.users),
    channels: cleanIds(input.channels),
    enabled: before?.enabled ?? false,
    createdAt: before?.createdAt ?? Date.now(),
    updatedAt: Date.now(),
  };
  if (!instanceProject(next)) fail('Choose a project.');
  if (targetName(next) === null) fail('Choose who answers: the Brain, a team or an agent of that project.');
  const bad = [...next.users, ...next.channels].find((x) => !/^[A-Za-z0-9_-]{1,64}$/.test(x));
  if (bad) fail(`"${bad}" isn't an ID. Use the numbers or codes the app shows for users and channels.`);
  if (next.enabled) checkReady(next);
  return instances.save(next);
}

/** Why an instance can't be turned on (it throws), or nothing. */
export function checkReady(instance: GatewayInstance): void {
  const secrets = getGatewaySecrets(instance.id);
  if (!secrets.botToken) fail('Add the bot token first.');
  if (instance.platform === 'slack' && !secrets.appToken) fail('Add the app-level token (xapp-…) first.');
  if (targetName(instance) === null) fail('Who answers is gone from the project: choose again.');
}

export function setEnabled(id: string, enabled: boolean): GatewayInstance {
  const instance = getInstance(id);
  if (enabled) checkReady(instance);
  return instances.save({ ...instance, enabled });
}

export function setTokens(id: string, tokens: { botToken?: string | null; appToken?: string | null }): void {
  const instance = getInstance(id);
  const next = { ...getGatewaySecrets(id) };
  for (const key of ['botToken', 'appToken'] as const) {
    const value = tokens[key];
    if (value === undefined) continue;
    if (value === null || !value.trim()) delete next[key];
    else next[key] = value.trim();
  }
  if (instance.platform === 'slack') {
    if (next.botToken && !next.botToken.startsWith('xoxb-')) fail('The Slack bot token starts with xoxb-.');
    if (next.appToken && !next.appToken.startsWith('xapp-')) fail('The Slack app-level token starts with xapp-.');
  }
  setGatewaySecrets(id, next);
  // (no token, no connection)
  if (instance.enabled && (!next.botToken || (instance.platform === 'slack' && !next.appToken)))
    instances.save({ ...instance, enabled: false });
}

export function removeInstance(id: string): void {
  getInstance(id);
  instances.remove(id);
  setGatewaySecrets(id, null);
  // (its messages and chats; files it saved stay in the project's uploads)
  fs.rmSync(dataPath('gateway-runtime', id), { recursive: true, force: true });
}

// ---------- messages and chats ----------
const KEEP = 200;
const messagesFile = (id: string) => dataPath('gateway-runtime', id, 'messages.json');
const chatsFile = (id: string) => dataPath('gateway-runtime', id, 'chats.json');
const stateFile = (id: string) => dataPath('gateway-runtime', id, 'state.json');

export function listMessages(instanceId: string): GatewayMessage[] {
  return readJSON<GatewayMessage[]>(messagesFile(instanceId), []);
}

export function getMessage(instanceId: string, id: string): GatewayMessage {
  return listMessages(instanceId).find((m) => m.id === id) || fail('That message is gone.', 404);
}

/** Adds a message (false when it was already there: platforms send some twice). Old finished ones go. */
export function addMessage(message: GatewayMessage): boolean {
  const list = listMessages(message.instanceId);
  if (list.some((m) => m.id === message.id)) return false;
  list.push(message);
  const finished = list.filter((m) => m.status === 'done');
  const drop = new Set(finished.slice(0, Math.max(0, list.length - KEEP)));
  writeJSON(
    messagesFile(message.instanceId),
    list.filter((m) => !drop.has(m)),
  );
  emit('gateway-messages', { id: message.instanceId });
  return true;
}

export function updateMessage(
  instanceId: string,
  id: string,
  patch: Partial<GatewayMessage> | ((m: GatewayMessage) => Partial<GatewayMessage>),
): GatewayMessage {
  const list = listMessages(instanceId);
  const at = list.findIndex((m) => m.id === id);
  if (at < 0) fail('That message is gone.', 404);
  const change = typeof patch === 'function' ? patch(list[at]) : patch;
  list[at] = { ...list[at], ...change, id, updatedAt: Date.now() };
  writeJSON(messagesFile(instanceId), list);
  emit('gateway-messages', { id: instanceId });
  return list[at];
}

export function removeMessage(instanceId: string, id: string): void {
  writeJSON(
    messagesFile(instanceId),
    listMessages(instanceId).filter((m) => m.id !== id),
  );
  emit('gateway-messages', { id: instanceId });
}

/** A message's id from where it came from, so the same one is never taken twice. */
export const messageId = (instanceId: string, chatKey: string, sourceId: string): string =>
  `${instanceId}-${crypto.createHash('sha256').update(`${chatKey}\n${sourceId}`).digest('hex').slice(0, 20)}`;

/** The private conversation (private-conversations.ts) that one chat with a gateway is. */
export const conversationOf = (instanceId: string, chatKey: string): string =>
  `gw-${instanceId}-${crypto.createHash('sha256').update(chatKey).digest('hex').slice(0, 20)}`;

export function listChats(instanceId: string): GatewayChat[] {
  return readJSON<GatewayChat[]>(chatsFile(instanceId), []);
}

export function getChat(instanceId: string, key: string): GatewayChat {
  return listChats(instanceId).find((c) => c.key === key) || fail('That chat is unknown to the gateway.');
}

export function rememberChat(chat: GatewayChat): void {
  const list = listChats(chat.instanceId).filter((c) => c.key !== chat.key);
  list.push(chat);
  list.sort((a, b) => b.lastAt - a.lastAt);
  writeJSON(chatsFile(chat.instanceId), list.slice(0, 100));
}

/** Small things a connection keeps between restarts (Telegram's next update). */
export function readState<T extends object>(instanceId: string): Partial<T> {
  return readJSON<Partial<T>>(stateFile(instanceId), {});
}
export function writeState<T extends object>(instanceId: string, value: Partial<T>): void {
  writeJSON(stateFile(instanceId), value);
}

export { getGatewaySecrets };
