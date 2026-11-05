import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { activeProject, agents, chats, collection, workflows } from './store.ts';
import { privateDataPath } from './private.ts';
import type { Chat, PrivateConversation, Team } from '../shared/types.ts';

/** A Tasks board task's own conversation (board-<taskId>). */
export const isBoardConversation = (id: string | null | undefined): boolean => !!id && id.startsWith('board-');
/** Gateway conversations (and the Brain's private work for one) are the other private conversations. */
export const isGatewayConversation = (id: string | null | undefined): boolean => !!id && !isBoardConversation(id);

const records = collection<PrivateConversation>('runtime/private-conversations', { global: true });
const safeId = z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/);
const schema: z.ZodType<PrivateConversation> = z.strictObject({
  id: z.string().regex(/^[a-f0-9]{64}$/), projectId: safeId, conversationId: safeId,
  target: z.strictObject({ kind: z.enum(['agent', 'team']), id: safeId }),
  createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative().optional(),
});
export function checkConversationId(id: string): void {
  if (!safeId.safeParse(id).success) throw new Error('Invalid private conversation ID.');
}
function checkedDirectory(): void { privateDataPath('runtime', 'private-conversations'); }
function read(id: string): PrivateConversation | null {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid private conversation record ID.');
  checkedDirectory();
  privateDataPath('runtime', 'private-conversations', `${id}.json`);
  const value = records.get(id);
  if (!value && !fs.existsSync(path.join(records.dir, `${id}.json`))) return null;
  const parsed = schema.safeParse(value);
  if (!parsed.success || parsed.data.id !== id) throw new Error('The private conversation record is unreadable.');
  const item = parsed.data;
  const expected = digest(item.projectId, item.conversationId, item.target);
  if (expected !== item.id) throw new Error('The private conversation cannot change ownership.');
  return item;
}
function digest(projectId: string, conversationId: string, target: PrivateConversation['target']): string {
  return crypto.createHash('sha256').update(JSON.stringify([projectId, conversationId, target.kind, target.id])).digest('hex');
}
function ensure(conversationId: string, target: PrivateConversation['target']): PrivateConversation {
  checkConversationId(conversationId); checkConversationId(target.id);
  const projectId = activeProject().id;
  const id = digest(projectId, conversationId, target);
  const existing = read(id);
  if (existing) return existing;
  return records.save({ id, projectId, conversationId, target, createdAt: Date.now() });
}

export function privateAgentChat(conversationId: string, agentId: string): Chat {
  if (!agents.get(agentId)) throw new Error('No such agent in this project.');
  const record = ensure(conversationId, { kind: 'agent', id: agentId });
  const id = `private-chat-${record.id}`;
  const saved = chats.get(agentId, id);
  if (saved) {
    if (saved.conversationId !== conversationId || saved.agentId !== agentId) throw new Error('The private chat cannot change ownership.');
    return saved;
  }
  if (fs.existsSync(path.join(chats.dir(agentId), `${id}.json`))) throw new Error('The private chat is unreadable. Restore it before continuing.');
  return chats.save({ id, agentId, conversationId, title: 'New chat', items: [], sessionId: null, createdAt: Date.now(), updatedAt: Date.now() });
}

export function privateTeamId(conversationId: string, teamId: string): string {
  if (!workflows.get(teamId)) throw new Error('No such team in this project.');
  return `private-team-${ensure(conversationId, { kind: 'team', id: teamId }).id}`;
}

export function privateTeamRecord(teamId: string): PrivateConversation | null {
  const match = /^private-team-([a-f0-9]{64})$/.exec(teamId);
  if (!match) return null;
  const record = read(match[1]);
  if (!record || record.projectId !== activeProject().id || record.target.kind !== 'team') return null;
  return record;
}

export function privateTeamDefinition(teamId: string): Team | null {
  const record = privateTeamRecord(teamId);
  if (!record) return null;
  const source = workflows.get(record.target.id);
  if (!source) return null;
  const members = (Array.isArray(source.members) ? source.members : [...new Set((source.steps || []).flatMap((step) => step.type === 'agent' && step.agentId ? [step.agentId] : []))]).filter((id) => agents.get(id));
  return { ...source, members, lead: source.lead && members.includes(source.lead) ? source.lead : null, id: teamId, schedule: { type: 'none' }, enabled: false };
}

export function privateTeams(conversationId?: string): Team[] {
  checkedDirectory();
  return records.list().flatMap((value) => {
    const record = read(value.id)!;
    if (record.projectId !== activeProject().id || record.target.kind !== 'team' || (conversationId !== undefined && record.conversationId !== conversationId)) return [];
    const team = privateTeamDefinition(`private-team-${record.id}`);
    return team ? [team] : [];
  });
}

export function existingPrivateTeamId(conversationId: string, teamId: string): string | null {
  checkConversationId(conversationId); checkConversationId(teamId);
  const record = read(digest(activeProject().id, conversationId, { kind: 'team', id: teamId }));
  return record ? `private-team-${record.id}` : null;
}
