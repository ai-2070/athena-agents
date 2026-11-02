import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { activeProject, agents, chats, workflows, withProject } from '../../server/store.ts';
import { newAgent } from '../../server/library.ts';
import { createProject } from '../../server/projects.ts';
import { addBrief, listBriefs } from '../../server/briefs.ts';
import { resumeInTeam } from '../../server/commands.ts';
import { admitExecution, readExecution, updateExecution } from '../../server/execution.ts';
import { finishNativeRun, nativeRunPromise, recoverExecution, restoreNativeRun } from '../../server/engines/index.ts';
import { attachSession, beginRun, bindSession, readRun, sessionContext, setRunStatus, settleRun } from '../../server/eve/state.ts';
import { prepareEveRecovery, stopEveRun } from '../../server/eve/recovery.ts';
import { clearThread, getThread, isTeamBusy, postUserMessage, queueUserMessage, recoverTeamWork, resumeTeam, setBrainHandlers, stopTeam, teamMessages, teamState, unqueueTeam } from '../../server/teams.ts';
import { readRelayWork, readTeamWork, saveRelayWork, saveTeamWork } from '../../server/teamwork.ts';
import { dataPath, readJSON, writeJSON } from '../../server/util.ts';
import type { ExecutionRun, SavedTeamWork, Team, TeamMessage } from '../../shared/types.ts';

function fixture() {
  const project = activeProject();
  const agent = newAgent({ name: 'Team reader', engine: 'eve', toolGroups: [] });
  const team = workflows.save({ name: 'Saved team', members: [agent.id], lead: agent.id, steps: [] } as Partial<Team>);
  const chat = chats.create(agent.id, 'Member memory', team.id);
  const message: TeamMessage = { id: 'original-message', ts: Date.now(), from: 'user', text: 'Original assignment', mentions: [agent.id] };
  const threadFile = dataPath('projects', project.id, 'teamchats', `${team.id}.json`);
  writeJSON(threadFile, { messages: [message], sessions: { [agent.id]: chat.id }, seen: { [agent.id]: 0 }, filesSent: {} });
  const work: SavedTeamWork = { projectId: project.id, teamId: team.id, current: [{ agentId: agent.id, msgIds: [message.id], skills: ['original-skill'], returning: false, delivery: { runId: `member-${agent.id}`, chatId: chat.id, from: 0, readUpto: 1, files: [] } }], queue: [], interrupted: [], held: [], pending: [], assigned: [JSON.stringify([agent.id, message.id])], brain: [], episode: { turns: 1 }, stopped: false, epoch: 0 };
  const run: ExecutionRun = { id: work.current[0]!.delivery!.runId, projectId: project.id, agentId: agent.id, chatId: chat.id, engine: agent.engine, parentRunId: `team:${project.id}/${team.id}`, ownerChatId: chat.id, ownerAgentId: agent.id, depth: 1, text: 'Member task', from: `team ${team.name}`, attachments: [], startedAt: Date.now(), status: 'running' };
  return { project, agent, team, chat, message, threadFile, work, run };
}

function nativeFixture() {
  const own = fixture();
  saveTeamWork(own.work);
  admitExecution(own.run);
  const binding = bindSession(own.agent, own.chat, own.project, 'proof');
  attachSession(binding.id, `session-${own.run.id}`);
  beginRun(own.run.id, binding.id, own.run.depth, own.run.parentRunId);
  setRunStatus(own.run.id, 'running', 'original-delivery');
  return own;
}

describe('saved team assignments', () => {
  it('joins a native turn after restart and posts one result with its original read boundary', async () => {
    const own = nativeFixture();
    expect(sessionContext(readRun(own.run.id)!.bindingId).agent._teamSkills).toEqual(['original-skill']);
    prepareEveRecovery();
    expect(readRun(own.run.id)?.status).toBe('running');
    expect(restoreNativeRun(own.run.id, () => stopEveRun(own.run.id))).toBe(true);
    recoverExecution();
    recoverTeamWork();
    recoverTeamWork();
    expect(teamState(own.team.id)).toMatchObject({ working: [own.agent.id], resumable: false });
    expect(readTeamWork(own.project.id, own.team.id)?.current[0]?.delivery).toEqual(own.work.current[0]?.delivery);
    const done = nativeRunPromise(own.run.id)!;
    const later = readJSON<{ messages: TeamMessage[]; sessions: Record<string, string>; seen: Record<string, number> }>(own.threadFile)!;
    later.messages.push({ id: 'later-message', from: 'system', text: 'A message arriving while this turn works', ts: Date.now(), mentions: [] });
    writeJSON(own.threadFile, later);
    const other = await createProject({ name: 'Another open project' });
    await withProject(other, async () => {
      settleRun(own.run.id, 'completed', 'Native team result');
      finishNativeRun(own.run.id);
      expect(await done).toBe('Native team result');
    });
    await expect.poll(() => withProject(own.project, () => teamState(own.team.id).working.length)).toBe(0);
    expect(withProject(own.project, () => teamMessages(own.team.id).filter((m) => m.from === own.agent.id))).toMatchObject([{ id: `reply-${own.run.id}`, text: 'Native team result' }]);
    expect(readJSON<{ seen: Record<string, number> }>(own.threadFile)!.seen[own.agent.id]).toBe(1);
    expect(readExecution().runs.filter((run) => run.chatId === own.chat.id)).toHaveLength(1);
    expect(readTeamWork(own.project.id, own.team.id)?.current).toEqual([]);
  });

  it('keeps unstarted work paused while collecting a live native result', async () => {
    const own = nativeFixture();
    own.work.queue = [{ agentId: own.agent.id, msgIds: ['not-started'], skills: [], returning: false }];
    own.work.held = [{ id: 'held-next', text: 'Must wait', ts: Date.now() }];
    saveTeamWork(own.work);
    restoreNativeRun(own.run.id, () => stopEveRun(own.run.id));
    recoverExecution();
    recoverTeamWork();
    expect(teamState(own.team.id)).toMatchObject({ working: [own.agent.id], resumable: true });
    settleRun(own.run.id, 'completed', 'One recovered reply');
    finishNativeRun(own.run.id);
    await expect.poll(() => teamState(own.team.id).working.length).toBe(0);
    expect(teamMessages(own.team.id).filter((m) => m.from === own.agent.id).map((m) => m.text)).toEqual(['One recovered reply']);
    expect(readTeamWork(own.project.id, own.team.id)?.interrupted).toEqual(own.work.queue);
    expect(teamState(own.team.id).held).toEqual(own.work.held);
    expect(readExecution().runs.filter((run) => run.chatId === own.chat.id)).toHaveLength(1);
    stopTeam(own.team.id);
  });

  it('does not advance read marks or file delivery after a recovered native failure', async () => {
    const own = nativeFixture();
    own.work.current[0]!.delivery!.files = ['original-file'];
    saveTeamWork(own.work);
    restoreNativeRun(own.run.id, () => stopEveRun(own.run.id));
    recoverTeamWork();
    settleRun(own.run.id, 'failed', '', 'The model disconnected.');
    finishNativeRun(own.run.id);
    await expect.poll(() => teamState(own.team.id).working.length).toBe(0);
    expect(readJSON<{ seen: Record<string, number>; filesSent: Record<string, string[]> }>(own.threadFile)).toMatchObject({ seen: { [own.agent.id]: 0 }, filesSent: {} });
    expect(teamMessages(own.team.id).find((m) => m.from === own.agent.id)?.text).toContain('hit a problem');
  });

  it('honours Stop on a joined native turn and retains previously paused assignments', async () => {
    const own = nativeFixture();
    own.work.interrupted = [{ agentId: own.agent.id, msgIds: ['paused-earlier'], skills: [], returning: false }];
    saveTeamWork(own.work);
    restoreNativeRun(own.run.id, () => stopEveRun(own.run.id));
    recoverTeamWork();
    stopTeam(own.team.id);
    finishNativeRun(own.run.id);
    await expect.poll(() => teamState(own.team.id).working.length).toBe(0);
    expect(readTeamWork(own.project.id, own.team.id)?.interrupted?.map((q) => q.msgIds)).toEqual([[own.message.id], ['paused-earlier']]);
    expect(teamMessages(own.team.id).filter((m) => m.from === own.agent.id)).toEqual([]);
    prepareEveRecovery();
    expect(readRun(own.run.id)?.status).toBe('stopped');
  });

  it('interrupts a native team turn without its exact saved current assignment', () => {
    const own = nativeFixture();
    own.work.queue = own.work.current;
    own.work.current = [];
    saveTeamWork(own.work);
    prepareEveRecovery();
    expect(readRun(own.run.id)?.status).toBe('interrupted');
  });

  it('pauses after a restart without advancing read marks or discarding queued messages', () => {
    const { project, agent, team, threadFile, work, run } = fixture();
    work.held = [{ id: 'held-message', text: 'Next assignment', attachments: ['notes.txt'], replyTo: 'original-message', ts: Date.now() }];
    saveTeamWork(work);
    admitExecution(run);
    recoverExecution();
    recoverTeamWork();
    recoverTeamWork();
    expect(teamState(team.id)).toMatchObject({ working: [], queued: [], resumable: true, held: work.held });
    expect(readTeamWork(project.id, team.id)?.interrupted).toEqual(work.current);
    expect(readJSON<{ seen: Record<string, number> }>(threadFile)!.seen[agent.id]).toBe(0);
    expect(teamMessages(team.id).filter((m) => m.from === 'system')).toHaveLength(1);
    expect(unqueueTeam(team.id).map((q) => q.id)).toEqual(['held-message']);
    stopTeam(team.id);
  });

  it('delivers a completed run after losing the team callback, with no new run and the original read boundary', async () => {
    const { project, agent, team, chat, threadFile, work, run } = fixture();
    saveTeamWork(work);
    admitExecution(run);
    chat.items = [{ type: 'user', text: run.text, runId: run.id }, { type: 'assistant', text: 'Saved result' }];
    chats.save(chat);
    // A paused team can collect an answer after the ordinary receipt retention window.
    updateExecution(run.id, { status: 'completed', answer: 'Saved result', endedAt: Date.now() - 7 * 60 * 60 * 1000, settled: true });
    recoverTeamWork();
    expect(resumeTeam(team.id)).toBe(1);
    await expect.poll(() => teamState(team.id).working.length).toBe(0);
    const replies = teamMessages(team.id).filter((m) => m.from === agent.id);
    expect(replies.map((m) => m.text)).toEqual(['Saved result']);
    expect(replies[0]?.id).toBe(`reply-${run.id}`);
    expect(readJSON<{ seen: Record<string, number> }>(threadFile)!.seen[agent.id]).toBe(1);
    expect(readTeamWork(project.id, team.id)?.current).toEqual([]);
    expect(chats.get(agent.id, chat.id)!.items).toHaveLength(2);
    expect(resumeTeam(team.id)).toBe(0);
  });

  it('does not duplicate a posted reply when recovery repeats between posting and finishing the assignment', async () => {
    const { agent, team, threadFile, work, run } = fixture();
    const original = readJSON<{ messages: TeamMessage[]; sessions: Record<string, string>; seen: Record<string, number> }>(threadFile)!;
    original.messages.push({ id: `reply-${run.id}`, ts: Date.now(), from: agent.id, text: 'Already posted', mentions: [] });
    writeJSON(threadFile, original);
    saveTeamWork(work);
    admitExecution(run);
    updateExecution(run.id, { status: 'completed', answer: 'Already posted', endedAt: Date.now(), settled: true });
    recoverTeamWork();
    resumeTeam(team.id);
    await expect.poll(() => teamState(team.id).working.length).toBe(0);
    expect(teamMessages(team.id).filter((m) => m.id === `reply-${run.id}`)).toHaveLength(1);
  });

  it('reopens a stopped assignment before its saved result triggers completion', async () => {
    const { team, work, run } = fixture();
    const brief = addBrief({ kind: 'team', targetId: team.id, name: team.name, text: 'Finish this', ts: Date.now() });
    saveTeamWork(work);
    admitExecution(run);
    updateExecution(run.id, { status: 'completed', answer: 'Finished', endedAt: Date.now(), settled: true });
    recoverTeamWork();
    expect(listBriefs().find((b) => b.id === brief.id)?.status).toBe('stopped');
    const observed: string[] = [];
    setBrainHandlers({ reply: async () => null, idle: (id) => {
      if (id === team.id) observed.push(listBriefs().find((b) => b.id === brief.id)!.status);
    } });
    try {
      expect(resumeInTeam(team.id)).toEqual({ resumed: true });
      await expect.poll(() => observed.length).toBeGreaterThan(0);
      expect(observed).toEqual(['open']);
    } finally { setBrainHandlers(null); }
  });

  it('claims a held message once when the process ended after routing but before queue cleanup', async () => {
    const { project, agent, team, work, run } = fixture();
    work.held = [{ id: 'original-message', text: 'Original assignment', ts: Date.now() }];
    work.pending = [{ id: 'original-message', from: 'user', text: 'Original assignment', replyTo: null, attachments: [], skills: [], to: [agent.id], track: true }];
    saveTeamWork(work);
    admitExecution(run);
    updateExecution(run.id, { status: 'completed', answer: 'One result', endedAt: Date.now(), settled: true });
    recoverTeamWork();
    expect(teamState(team.id).held).toEqual([]);
    expect(readTeamWork(project.id, team.id)?.pending).toEqual([]);
    expect(resumeTeam(team.id)).toBe(1);
    await expect.poll(() => teamState(team.id).working.length).toBe(0);
    expect(teamMessages(team.id).filter((m) => m.from === agent.id).map((m) => m.text)).toEqual(['One result']);
    expect(teamMessages(team.id).filter((m) => m.id === 'original-message')).toHaveLength(1);
  });

  it('restores a cross-team request and returns its saved result without repeating either delivery', async () => {
    const { project, agent, team, threadFile, work, run } = fixture();
    const asker = workflows.save({ name: 'Asking team', members: [agent.id], lead: agent.id, steps: [] } as Partial<Team>);
    const source: TeamMessage = { id: 'cross-team-question', ts: Date.now(), from: 'user', text: '#Saved team please help', mentions: [] };
    writeJSON(dataPath('projects', project.id, 'teamchats', `${asker.id}.json`), { messages: [source], sessions: {}, seen: {} });
    const thread = readJSON<{ messages: TeamMessage[]; sessions: Record<string, string>; seen: Record<string, number> }>(threadFile)!;
    thread.messages[0] = { ...thread.messages[0]!, id: 'forwarded-question', from: `team:${asker.id}`, text: source.text };
    writeJSON(threadFile, thread);
    work.current[0]!.msgIds = ['forwarded-question'];
    work.assigned = [JSON.stringify([agent.id, 'forwarded-question'])];
    saveTeamWork(work);
    saveRelayWork({ active: [{ id: 'saved-relay', from: asker.id, to: team.id, by: 'user', askId: source.id, postedId: 'forwarded-question', pid: project.id, depth: 1, returning: false, skills: [], deliveries: [{ id: 'forwarded-question', messageId: source.id }] }], closed: [] });
    admitExecution(run);
    updateExecution(run.id, { status: 'completed', answer: 'Saved team result', endedAt: Date.now(), settled: true });
    recoverTeamWork();
    expect(teamState(asker.id).resumable).toBe(true);
    expect(resumeTeam(team.id)).toBe(2);
    await expect.poll(() => readRelayWork().active.length).toBe(0);
    expect(teamMessages(asker.id).filter((m) => m.id === 'relay-answer-saved-relay').map((m) => m.text)).toEqual(['Saved team result']);
    expect(teamState(asker.id).resumable).toBe(false);
    expect(readRelayWork().closed).toContain(JSON.stringify([project.id, asker.id, team.id, source.id]));
    recoverTeamWork();
    expect(teamMessages(asker.id).filter((m) => m.id === 'relay-answer-saved-relay')).toHaveLength(1);
  });

  it('does not restore the private assignment in a different project with the same team and agent IDs', async () => {
    const { project, agent, team, work } = fixture();
    saveTeamWork(work);
    const other = await createProject({ name: 'Copied team' });
    withProject(other, () => {
      agents.save(agent);
      workflows.save(team);
      expect(readTeamWork(other.id, team.id)).toBeNull();
      expect(teamState(team.id)).toMatchObject({ working: [], queued: [], held: [], resumable: false });
    });
    withProject(project, () => expect(teamState(team.id).resumable).toBe(true));
  });

  it('Stop removes saved queued and routing inputs before stopping members; clear also removes assignments', () => {
    const { project, team, work } = fixture();
    work.held = [{ id: 'held-stop', text: 'Queued', ts: Date.now() }];
    work.pending = [{ id: 'routing-stop', from: 'user', text: 'Routing', replyTo: null, attachments: [], skills: [], to: [], track: true }];
    saveTeamWork(work);
    stopTeam(team.id);
    expect(readTeamWork(project.id, team.id)).toMatchObject({ held: [], pending: [], stopped: true });
    clearThread(team.id);
    expect(readTeamWork(project.id, team.id)).toMatchObject({ held: [], pending: [], interrupted: [], current: [], queue: [] });
    expect(getThread(team.id).resumable).toBe(false);
    expect(teamMessages(team.id)).toEqual([]);
  });

  it('recovers a pending Brain message from its posted answer without asking the Brain again', async () => {
    const { team, threadFile, work } = fixture();
    work.current = [];
    const msg: TeamMessage = { id: 'question-for-brain', ts: Date.now(), from: 'user', text: '@Brain check this', mentions: [] };
    work.brain = [msg];
    const thread = readJSON<{ messages: TeamMessage[] }>(threadFile)!;
    thread.messages.push(msg, { id: `brain-${msg.id}`, ts: Date.now(), from: 'brain', text: 'Saved Brain answer', mentions: [], replyTo: msg.id });
    writeJSON(threadFile, thread);
    saveTeamWork(work);
    let asked = 0;
    setBrainHandlers({ reply: async () => { asked++; return 'New answer'; }, idle: () => {} });
    try {
      recoverTeamWork();
      expect(resumeTeam(team.id)).toBe(1);
      await expect.poll(() => teamState(team.id).working.length).toBe(0);
      expect(asked).toBe(0);
      expect(teamMessages(team.id).filter((m) => m.id === `brain-${msg.id}`)).toHaveLength(1);
    } finally { setBrainHandlers(null); }
  });

  it('survives an independent process ending during routing without posting the original twice', () => {
    const script = `
      import { newAgent } from './server/library.ts';
      import { workflows, activeProject } from './server/store.ts';
      import { postUserMessage } from './server/teams.ts';
      const agent = newAgent({name:'Routing member',engine:'eve',toolGroups:[]});
      const team = workflows.save({name:'Routing crash',members:[agent.id],lead:null,steps:[]});
      void postUserMessage(team.id, 'Pending routing', {route:()=>new Promise(()=>{})});
      console.log(JSON.stringify({projectId:activeProject().id,teamId:team.id}));
      process.exit(0);
    `;
    const child = spawnSync('bun', ['--eval', script], { encoding: 'utf8', env: process.env, timeout: 15000 });
    expect(child.status, child.stderr).toBe(0);
    const saved = JSON.parse(child.stdout.trim()) as { projectId: string; teamId: string };
    recoverTeamWork();
    expect(teamState(saved.teamId).resumable).toBe(true);
    expect(readTeamWork(saved.projectId, saved.teamId)?.pending[0]?.text).toBe('Pending routing');
    expect(teamMessages(saved.teamId).filter((m) => m.text === 'Pending routing')).toHaveLength(1);
    expect(fs.existsSync(dataPath('projects', saved.projectId, 'runtime', 'teams'))).toBe(false);
    stopTeam(saved.teamId);
  });

  it('keeps a new queued message behind pending routing and removes a cancelled routing input', async () => {
    const { project, agent, team } = fixture();
    workflows.save({ ...team, lead: null });
    const controller = new AbortController();
    let pick = (_id: string) => {};
    const routed = new Promise<string>((resolve) => { pick = resolve; });
    const pending = postUserMessage(team.id, 'Choose a member', { route: () => routed, signal: controller.signal });
    expect(isTeamBusy(team.id)).toBe(true);
    expect(await queueUserMessage(team.id, 'Wait for routing')).toHaveProperty('queued');
    controller.abort();
    pick(agent.id);
    await expect(pending).rejects.toThrow('Stopped.');
    expect(readTeamWork(project.id, team.id)?.pending).toEqual([]);
    stopTeam(team.id);
    expect(readTeamWork(project.id, team.id)?.held).toEqual([]);
  });
});
