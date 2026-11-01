import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { newAgent } from '../../server/library.ts';
import { activeProject, agents, chats, setActiveProject, withProject, workflows } from '../../server/store.ts';
import { createProject } from '../../server/projects.ts';
import { cloneProject } from '../../server/backup.ts';
import { clearThread, teamMessages } from '../../server/teams.ts';
import { dataPath, writeJSON } from '../../server/util.ts';
import { callTool, toolsForAgent } from '../../server/tools.ts';
import { readConversation, searchConversations } from '../../server/conversations.ts';
import { compactChat } from '../../server/compaction.ts';
import type { ConversationReadResult, ConversationSearchResult, Team } from '../../shared/types.ts';

const setup = () => {
  const me = newAgent({ name: 'Searcher', toolGroups: [] });
  const other = newAgent({ name: 'Private peer', toolGroups: [] });
  const team = workflows.save({ name: 'Shared work', members: [me.id, other.id], lead: null, steps: [] } as Partial<Team>);
  const own = chats.create(me.id, 'Old planning chat');
  own.items.push({ type: 'user', text: 'Launch decision: use ORCHID, never CEDAR.', ts: 1 });
  own.items.push({ type: 'tool', id: 'file', name: 'read_file', args: { path: 'design.txt' }, result: 'ORCHID result', status: 'done', ts: 2 });
  chats.save(own);
  const privateChat = chats.create(other.id, 'Private');
  privateChat.items.push({ type: 'user', text: 'ORCHID PRIVATE_SECRET', ts: 3 });
  chats.save(privateChat);
  const outsiderTeam = workflows.save({ name: 'Not mine', members: [other.id], lead: null, steps: [] } as Partial<Team>);
  const thread = (id: string, text: string) => writeJSON(dataPath('projects', activeProject().id, 'teamchats', `${id}.json`), { messages: [{ id: 'stable-message', ts: 4, from: other.id, text, mentions: [] }], sessions: {}, seen: {} });
  thread(team.id, 'Shared ORCHID decision.');
  thread(outsiderTeam.id, 'ORCHID OUTSIDE_SECRET');
  return { me, other, team, own, privateChat, outsiderTeam };
};

describe('conversation search tools', () => {
  it('are read-only core tools available without granting Files', async () => {
    const { me } = setup();
    for (const name of ['search_conversations', 'read_conversation']) {
      expect(toolsForAgent(me).find((t) => t.name === name)).toMatchObject({ group: 'core', risk: 'none' });
    }
    const result = await callTool(me, 'search_conversations', { query: 'orchid decision' });
    expect(result.isError).toBe(false);
    const data = JSON.parse(result.text) as ConversationSearchResult;
    expect(data.total).toBe(2);
    expect(data.hits.map((h) => h.source).sort()).toEqual(['own', 'team']);
    expect(result.text).not.toContain('PRIVATE_SECRET');
    expect(result.text).not.toContain('OUTSIDE_SECRET');
    const hit = data.hits[0];
    const read = await callTool(me, 'read_conversation', { ...hit });
    expect(read.isError).toBe(false);
    expect((JSON.parse(read.text) as ConversationReadResult).text).toContain('ORCHID');
  });

  it('refuses another agent\'s chat, another team, stand-ins and traversal ids', async () => {
    const { me, privateChat, outsiderTeam } = setup();
    expect((await callTool(me, 'read_conversation', { source: 'own', conversationId: privateChat.id, messageId: '0' })).isError).toBe(true);
    expect((await callTool(me, 'read_conversation', { source: 'team', conversationId: outsiderTeam.id, messageId: 'stable-message' })).isError).toBe(true);
    expect((await callTool(me, 'search_conversations', { query: 'ORCHID', scope: 'team', teamId: outsiderTeam.id })).isError).toBe(true);
    expect((await callTool(me, 'read_conversation', { source: 'own', conversationId: '../secrets', messageId: '0' })).isError).toBe(true);
    expect((await callTool({ id: '_external', name: 'Outside' }, 'search_conversations', { query: 'ORCHID' })).isError).toBe(true);
  });

  it('paginates hits and long original messages through their final character', () => {
    const { me, own } = setup();
    const original = 'Beginning. ' + 'long words '.repeat(10000) + 'IMPORTANT_TAIL';
    own.items.push({ type: 'assistant', text: original, ts: 5 });
    chats.save(own);
    const first = searchConversations(me.id, { query: 'ORCHID', limit: 1 });
    expect(first.total).toBe(3);
    expect(first.nextOffset).toBe(1);
    const second = searchConversations(me.id, { query: 'ORCHID', limit: 1, offset: first.nextOffset! });
    expect(second.hits[0]).not.toEqual(first.hits[0]);
    let offset = 0;
    let text = '';
    for (;;) {
      const page = readConversation(me.id, { source: 'own', conversationId: own.id, messageId: '2', offset });
      text += page.text;
      if (page.nextOffset == null) break;
      offset = page.nextOffset;
    }
    expect(text).toBe(original);
    expect(searchConversations(me.id, { query: 'IMPORTANT_TAIL', scope: 'own' }).hits[0].messageId).toBe('2');
  });

  it('keeps escaped tool responses within the engine limit without losing the next page', () => {
    const { me, own } = setup();
    const original = '\u0001"\\\n'.repeat(10000) + 'ESCAPED_TAIL';
    own.items.push({ type: 'assistant', text: original });
    chats.save(own);
    let offset = 0;
    let combined = '';
    for (;;) {
      const page = readConversation(me.id, { source: 'own', conversationId: own.id, messageId: '2', offset, limit: 16000 });
      expect(JSON.stringify(page).length).toBeLessThanOrEqual(20000);
      combined += page.text;
      if (page.nextOffset == null) break;
      expect(page.nextOffset).toBeGreaterThan(offset);
      offset = page.nextOffset;
    }
    expect(combined).toBe(original);
  });

  it('finds originals after compaction, without searching copies from recovery tools', async () => {
    const { me, own } = setup();
    own.items[0] = { type: 'user', text: 'x'.repeat(20000) + ' UNIQUE_COMPACTED_TAIL', ts: 1 };
    own.items.push({ type: 'tool', id: 'search', name: 'search_conversations', args: { query: 'UNIQUE_COMPACTED_TAIL' }, result: 'UNIQUE_COMPACTED_TAIL', status: 'done' });
    await compactChat(own, { trigger: 'manual', mode: 'instant', current: false, window: 8000, keepMessages: 0 });
    chats.save(own);
    const result = searchConversations(me.id, { query: 'UNIQUE_COMPACTED_TAIL', scope: 'own' });
    expect(result.total).toBe(1);
    expect(readConversation(me.id, { ...result.hits[0], offset: 19000 }).text).toContain('UNIQUE_COMPACTED_TAIL');
  });

  it('removes access when membership changes or conversations are explicitly cleared or deleted', () => {
    const { me, team, own } = setup();
    clearThread(team.id);
    expect(teamMessages(team.id)).toEqual([]);
    expect(searchConversations(me.id, { query: 'ORCHID', scope: 'team' }).total).toBe(0);
    chats.remove(me.id, own.id);
    expect(searchConversations(me.id, { query: 'ORCHID' }).total).toBe(0);
    workflows.save({ ...team, members: [] });
    expect(() => readConversation(me.id, { source: 'team', conversationId: team.id, messageId: 'stable-message' })).toThrow('not available');
  });

  it('keeps a cloned project\'s private and shared history separate', async () => {
    const a = await createProject({ name: 'Search A', mode: 'new', folder: path.join(os.homedir(), 'search-a') });
    const { me, team, own } = setup();
    const b = (await cloneProject(a.id, 'Search B')).project;
    setActiveProject(a.id);
    own.items.push({ type: 'user', text: 'AFTER_CLONE_PRIVATE' });
    chats.save(own);
    const thread = teamMessages(team.id);
    thread.push({ id: 'after-clone', ts: 5, from: me.id, text: 'AFTER_CLONE_TEAM', mentions: [] });
    writeJSON(dataPath('projects', a.id, 'teamchats', `${team.id}.json`), { messages: thread, sessions: {}, seen: {} });
    setActiveProject(b.id);
    expect(agents.get(me.id)).not.toBeNull();
    expect(searchConversations(me.id, { query: 'AFTER_CLONE' }).total).toBe(0);
    expect(() => readConversation(me.id, { source: 'team', conversationId: team.id, messageId: 'after-clone' })).toThrow('not available');
    expect(withProject(a, () => searchConversations(me.id, { query: 'AFTER_CLONE' }).total)).toBe(2);
  });
});
