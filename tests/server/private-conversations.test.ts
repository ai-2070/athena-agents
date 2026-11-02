import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { activeProject, chats, listProjects, saveProjects, setActiveProject, withProject, workflows, log } from '../../server/store.ts';
import { newAgent } from '../../server/library.ts';
import { privateAgentChat, privateTeamId, privateTeamRecord } from '../../server/private-conversations.ts';
import { getTeam, getThread, isTeamBusy, listTeams, otherTeams, postSystem, postUserMessage } from '../../server/teams.ts';
import { ask, clearHistory, history, snapshot, steerAsks } from '../../server/overseer.ts';
import { readConversation, searchConversations } from '../../server/conversations.ts';
import { bindSession, sessionContext } from '../../server/eve/state.ts';
import { dataPath } from '../../server/util.ts';
import type { Agent, Team } from '../../shared/types.ts';

const captured = vi.hoisted(() => ({ prompts: [] as string[], turns: [] as { agentId: string; prompt: string; chatId?: string | null }[], hold: false, waiting: [] as ((answer: string) => void)[] }));
vi.mock('../../server/brain.ts', async (original) => ({
  ...await original<typeof import('../../server/brain.ts')>(),
  brainModel: () => ({ provider: 'openrouter', model: 'mock', fallback: false }),
  think: async (_system: string, prompt: string) => {
    captured.prompts.push(prompt);
    if (captured.hold) return new Promise<string>((resolve) => captured.waiting.push(resolve));
    return 'Private answer.';
  },
}));
vi.mock('../../server/engines/index.ts', async (original) => ({
  ...await original<typeof import('../../server/engines/index.ts')>(),
  askAgent: async (agent: Agent, prompt: string, options: { chatId?: string | null }) => {
    captured.turns.push({ agentId: agent.id, prompt, chatId: options.chatId });
    return 'Finished the private task.';
  },
}));
function setup() {
  const agent = newAgent({ name: 'Private reviewer', engine: 'eve', toolGroups: [] });
  const team = workflows.save({ name: 'Private crew', members: [agent.id], lead: agent.id, steps: [], access: { toolGroups: ['files'], mcpServers: [] }, skills: [] } as Partial<Team>);
  return { agent, team };
}

describe('private local conversations', () => {
  it('keeps stable agent sessions separate by binding and project, with no fallback after deletion', () => {
    const { agent } = setup();
    const one = privateAgentChat('binding-one', agent.id);
    one.items.push({ type: 'user', text: 'PRIVATE_ALPHA', ts: 1 }); chats.save(one);
    const two = privateAgentChat('binding-two', agent.id);
    const regular = chats.create(agent.id); regular.items.push({ type: 'user', text: 'PUBLIC_ALPHA', ts: 2 }); chats.save(regular);
    expect(privateAgentChat('binding-one', agent.id).items[0]).toMatchObject({ text: 'PRIVATE_ALPHA' });
    expect(one.id).not.toBe(two.id);
    expect(searchConversations(agent.id, { query: 'ALPHA' }).hits.map((hit) => hit.conversationId)).toEqual([regular.id]);
    expect(searchConversations(agent.id, { query: 'ALPHA' }, 'binding-one').hits.map((hit) => hit.conversationId)).toEqual([one.id]);
    expect(searchConversations(agent.id, { query: 'ALPHA' }, 'binding-two').hits).toEqual([]);
    expect(() => readConversation(agent.id, { source: 'own', conversationId: one.id, messageId: '0' }, 'binding-two')).toThrow('not available');
    const project = activeProject(); const second = { ...project, id: 'private-other-project', name: 'Other' };
    saveProjects([...listProjects(), second]);
    expect(() => withProject(second, () => privateAgentChat('binding-one', agent.id))).toThrow('No such agent');
    expect(() => privateAgentChat('../escape', agent.id)).toThrow('Invalid private');
  });

  it('isolates team threads, member sessions, sender attribution and conversation tools', async () => {
    const { agent, team } = setup();
    postSystem(team.id, 'DEFAULT_TEAM_SECRET');
    const one = privateTeamId('team-binding-one', team.id);
    const two = privateTeamId('team-binding-two', team.id);
    expect(privateTeamId('team-binding-one', team.id)).toBe(one);
    expect(listTeams().some((item) => item.id === one)).toBe(false);
    expect(otherTeams(one)).toEqual([]);
    await postUserMessage(one, 'PRIVATE_TEAM_ALPHA', { messageId: 'external-one', sender: 'telegram: Alice (123)', track: false });
    await postUserMessage(two, 'PRIVATE_TEAM_BETA', { messageId: 'external-two', sender: 'telegram: Bob (456)', track: false });
    await expect.poll(() => isTeamBusy(one) || isTeamBusy(two)).toBe(false);
    const a = getThread(one); const b = getThread(two);
    expect(a.sessions[agent.id]).not.toBe(b.sessions[agent.id]);
    expect(chats.get(agent.id, a.sessions[agent.id])?.conversationId).toBe('team-binding-one');
    expect(a.messages[0].sender).toBe('telegram: Alice (123)');
    expect(JSON.stringify(a)).not.toContain('PRIVATE_TEAM_BETA');
    expect(JSON.stringify(getThread(team.id))).not.toContain('PRIVATE_TEAM_ALPHA');
    const promptA = captured.turns.find((turn) => turn.chatId === a.sessions[agent.id])!.prompt;
    expect(promptA).toContain('telegram: Alice (123)');
    expect(promptA).not.toContain('PRIVATE_TEAM_BETA'); expect(promptA).not.toContain('DEFAULT_TEAM_SECRET');
    expect(searchConversations(agent.id, { query: 'PRIVATE_TEAM_ALPHA' }, 'team-binding-one').hits.length).toBeGreaterThan(0);
    expect(searchConversations(agent.id, { query: 'PRIVATE_TEAM_ALPHA' }, 'team-binding-two').hits).toEqual([]);
    expect(() => readConversation(agent.id, { source: 'team', conversationId: one, messageId: a.messages[0].id }, 'team-binding-two')).toThrow('not available');
    const native = bindSession(agent, chats.get(agent.id, a.sessions[agent.id])!, activeProject(), 'private-generation');
    expect(sessionContext(native.id).agent.toolGroups).toContain('files');
    const memberChat = chats.get(agent.id, a.sessions[agent.id])!;
    chats.save({ ...memberChat, conversationId: 'team-binding-two' });
    expect(() => sessionContext(native.id)).toThrow('conversation no longer exists');
    chats.save(memberChat);
    workflows.remove(team.id);
    expect(getTeam(one)).toBeNull();
    expect(() => sessionContext(native.id)).toThrow('no longer belongs');
  });

  it('keeps private Brain history and snapshots apart from dashboard and other binding activity', async () => {
    const pid = activeProject().id;
    const { team } = setup(); postSystem(team.id, 'SNAPSHOT_DEFAULT_SECRET'); log('team', 'ACTIVITY_DEFAULT_SECRET');
    await ask('DASHBOARD_BRAIN_SECRET');
    await ask('PRIVATE_BRAIN_ALPHA', { conversationId: 'brain-binding-one', from: 'telegram: Alice (123)' });
    const promptA = captured.prompts.at(-1)!;
    expect(promptA).toContain('telegram: Alice (123)');
    expect(promptA).not.toContain('DASHBOARD_BRAIN_SECRET');
    expect(promptA).not.toContain('SNAPSHOT_DEFAULT_SECRET'); expect(promptA).not.toContain('ACTIVITY_DEFAULT_SECRET');
    await ask('PRIVATE_BRAIN_BETA', { conversationId: 'brain-binding-two' });
    expect(captured.prompts.at(-1)).not.toContain('PRIVATE_BRAIN_ALPHA');
    expect(history(pid, 'brain-binding-one')[0].from).toBe('telegram: Alice (123)');
    expect(JSON.stringify(history(pid))).not.toContain('PRIVATE_BRAIN_ALPHA');
    clearHistory(pid, 'brain-binding-one');
    expect(history(pid, 'brain-binding-one')).toEqual([]);
    expect(history(pid, 'brain-binding-two')).toHaveLength(2);
    expect(await snapshot({ conversationId: 'brain-binding-two' })).not.toContain('SNAPSHOT_DEFAULT_SECRET');
  });

  it('separates Brain Stop/Clear controls and keeps a private answer pinned across global project switches', async () => {
    const first = activeProject(); const second = listProjects().find((project) => project.id !== first.id)!;
    captured.hold = true;
    const going = ask('PRIVATE_SWITCH_INPUT', { conversationId: 'switch-binding' });
    await expect.poll(() => captured.waiting.length).toBe(1);
    steerAsks(first.id); clearHistory(first.id, 'another-binding'); setActiveProject(second.id);
    captured.waiting.shift()!('Private pinned answer.');
    await going; captured.hold = false;
    expect(history(first.id, 'switch-binding').map((message) => message.text)).toEqual(['PRIVATE_SWITCH_INPUT', 'Private pinned answer.']);
    expect(history(second.id, 'switch-binding')).toEqual([]);
    setActiveProject(first.id);
  });

  it('fails closed on corrupt private records or histories instead of selecting the dashboard conversation', async () => {
    const { team } = setup();
    const id = privateTeamId('corrupt-binding', team.id);
    const record = privateTeamRecord(id)!;
    fs.writeFileSync(dataPath('runtime', 'private-conversations', `${record.id}.json`), '{broken');
    expect(() => getTeam(id)).toThrow('unreadable');
    const file = dataPath('runtime', 'brain-conversations', activeProject().id, 'corrupt-brain.json');
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '{broken');
    await expect(ask('Must not use default history', { conversationId: 'corrupt-brain' })).rejects.toThrow('unreadable');
  });

  it('does not bring back a cleared private answer or cancel another binding', async () => {
    captured.hold = true;
    const pid = activeProject().id;
    const one = ask('PRIVATE_CLEAR_ONE', { conversationId: 'clear-one' });
    await expect.poll(() => captured.waiting.length).toBe(1);
    const two = ask('PRIVATE_CLEAR_TWO', { conversationId: 'clear-two' });
    await expect.poll(() => captured.waiting.length).toBe(2);
    clearHistory(pid, 'clear-one');
    captured.waiting.shift()!('Late answer\n```actions\n[{"do":"create_team","name":"Must not be created"}]\n```');
    captured.waiting.shift()!('Other binding answer.');
    await Promise.all([one, two]); captured.hold = false;
    expect(history(pid, 'clear-one')).toEqual([]);
    expect(history(pid, 'clear-two')).toHaveLength(2);
    expect(workflows.list().some((team) => team.name === 'Must not be created')).toBe(false);
    expect(() => clearHistory(pid, '')).toThrow('Invalid private');
  });

  it('keeps Brain delegation in the same private scope instead of using the dashboard team thread', async () => {
    const { team } = setup(); postSystem(team.id, 'ORIGINAL_THREAD_SECRET');
    captured.hold = true;
    const going = ask('Delegate a private review', { conversationId: 'private-delegation' });
    await expect.poll(() => captured.waiting.length).toBe(1);
    captured.waiting.shift()!(`On it.\n\`\`\`actions\n${JSON.stringify([{ do: 'delegate', to: 'team', id: team.id, message: 'PRIVATE_DELEGATED_REVIEW' }])}\n\`\`\``);
    const answer = await going; captured.hold = false;
    expect(answer.delegate?.id).toBe(privateTeamId('private-delegation', team.id));
    await expect.poll(() => isTeamBusy(answer.delegate!.id)).toBe(false);
    expect(JSON.stringify(getThread(team.id))).not.toContain('PRIVATE_DELEGATED_REVIEW');
    expect(JSON.stringify(getThread(answer.delegate!.id))).not.toContain('ORIGINAL_THREAD_SECRET');
  });
});
