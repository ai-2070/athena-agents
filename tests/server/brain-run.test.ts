// The Brain's turn as a real agent run (brainrun.ts → askAgent → startRun) on a stand-in Eve engine that calls the
// Brain's tools the way a model would; and each engine keeping the Brain to reading files.
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { activeProject, chats, saveSettings, setActiveProject, withProject, workflows } from '../../server/store.ts';
import { createProject } from '../../server/projects.ts';
import { decide, listApprovals } from '../../server/approvals.ts';
import { brainGrants, forgetBrainGrant } from '../../server/mcp.ts';
import {
  addBrainNote,
  ask,
  brainThreads,
  clearHistory,
  history,
  newBrainThread,
  removeBrainThread,
  stopAsks,
} from '../../server/overseer.ts';
import { askAgent } from '../../server/engines/index.ts';
import { callTool, toolsForAgent } from '../../server/tools.ts';
import { claudeArgs } from '../../server/engines/claude.ts';
import { codexArgs } from '../../server/engines/codex.ts';
import { hermesArgs } from '../../server/engines/hermes.ts';
import { permissionRules } from '../../server/engines/opencode.ts';
import { brainAgent } from '../../server/brainrun.ts';
import { BRAIN_ID } from '../../server/braintools.ts';
import type { EngineRunArgs } from '../../server/engines/index.ts';
import type { ToolResult } from '../../server/tools.ts';

vi.mock('../../server/brain.ts', async (orig) => ({
  ...(await orig<typeof import('../../server/brain.ts')>()),
  brainModel: () => ({ provider: 'openrouter', model: 'mock', effort: '', fallback: false }),
}));

// what each turn the engine got, and what the "model" does in it
const seen: { system: string; text: string; tools: string[]; chatId: string; engine: string; project: string }[] = [];
let script: (args: EngineRunArgs) => Promise<string> = async () => 'Hello.';
vi.mock('../../server/engines/eve.ts', async (orig) => ({
  ...(await orig<typeof import('../../server/engines/eve.ts')>()),
  run: async (args: EngineRunArgs) => {
    seen.push({
      system: args.systemPrompt,
      text: args.text,
      tools: toolsForAgent(args.agent, { engine: args.agent.engine }).map((t) => t.name),
      chatId: args.chat.id,
      engine: args.agent.engine,
      project: activeProject().id,
    });
    return { text: await script(args) };
  },
}));

// the Brain on Codex: what each message its session got said
const codexHeard: string[] = [];
vi.mock('../../server/engines/codex.ts', async (orig) => ({
  ...(await orig<typeof import('../../server/engines/codex.ts')>()),
  run: async (args: EngineRunArgs) => {
    codexHeard.push(args.chat.sessionId ? args.text : `${args.systemPrompt}\n\n${args.text}`);
    args.chat.sessionId = 'codex-session';
    return { text: 'Ok.' };
  },
}));

let n = 0;
/** One tool call as a model makes it: the engine says so, the dashboard runs it, the result comes back. */
async function use(a: EngineRunArgs, name: string, input: Record<string, unknown>) {
  const id = `call-${++n}`;
  a.onEvent({ kind: 'tool', id, name, args: input });
  const r = await callTool(a.agent, name, input, { runId: a.runId, signal: a.signal });
  a.onEvent({ kind: 'tool_result', id, text: r.text, isError: r.isError });
  return r;
}

describe("the Brain's turn as an agent run", () => {
  it('runs on its engine with its own tools, acts, and keeps one session per conversation', async () => {
    clearHistory();
    seen.length = 0;
    script = async (a) => {
      a.onEvent({ kind: 'text', text: 'Let me build it.' });
      const r = await use(a, 'team', {
        do: 'create_team',
        name: 'Real crew',
        members: [{ new: { name: 'Realist', specialty: 'tests' } }],
      });
      expect(r.isError).toBe(false);
      a.onEvent({ kind: 'text', text: 'Built the Real crew.' });
      return 'Built the Real crew.';
    };
    const r = await ask('build a crew');
    expect(r.answer).toBe('Built the Real crew.');
    expect(r.done.map((d) => d.kind)).toEqual(['hired', 'team']);
    expect(workflows.list().some((w) => w.name === 'Real crew')).toBe(true);
    // what it was given
    expect(seen[0].engine).toBe('eve');
    expect(seen[0].system).toContain('You are the Brain');
    expect(seen[0].system).toContain('team {"do":"create_team"');
    expect(seen[0].system).not.toContain('```actions');
    expect(seen[0].text).toMatch(/^SNAPSHOT \(a summary: project_overview shows the rest\)/);
    expect(seen[0].text).toContain('AGENTS (');
    expect(seen[0].text).not.toContain('FOLDER TREE');
    expect(seen[0].tools).toEqual(expect.arrayContaining(['team', 'delegate', 'project_overview', 'read_file']));
    expect(seen[0].tools).not.toContain('write_file');
    // the chat keeps the answer and the step; the engine's own chat has the turn
    const saved = history().at(-1)!;
    expect(saved.text).toBe('Built the Real crew.');
    expect(saved.steps?.map((st) => st.name)).toEqual(['team']);
    const engineChat = chats.get(BRAIN_ID, seen[0].chatId)!;
    expect(engineChat.items.map((i) => i.type)).toEqual(['user', 'assistant', 'tool', 'assistant']);

    // the next message goes to the same session, without the last messages again
    script = async () => 'Sure.';
    await ask('thanks');
    expect(seen[1].chatId).toBe(seen[0].chatId);
    expect(seen[1].text).not.toContain('EARLIER IN THIS CHAT');
    // a new conversation starts a new session, and the old one goes with the conversation
    clearHistory();
    expect(chats.get(BRAIN_ID, seen[0].chatId)).toBeNull();
    await ask('hi again');
    expect(seen[2].chatId).not.toBe(seen[0].chatId);
    // a conversation filed away keeps its session; deleting it deletes that too
    newBrainThread();
    expect(chats.get(BRAIN_ID, seen[2].chatId)).not.toBeNull();
    const filed = brainThreads().find((t) => t.title.includes('hi again'))!;
    removeBrainThread(filed.id);
    expect(chats.get(BRAIN_ID, seen[2].chatId)).toBeNull();
  });

  it('stop ends the run; what it did before stays done and is said', async () => {
    clearHistory();
    script = async (a) => {
      await use(a, 'team', { do: 'create_team', name: 'Half crew', members: [{ new: { name: 'Halfway' } }] });
      stopAsks();
      await new Promise((r) => setTimeout(r, 20));
      if (a.signal.aborted) return '';
      await use(a, 'team', { do: 'create_team', name: 'Never crew', members: [{ new: { name: 'Never' } }] });
      return 'Done.';
    };
    const r = await ask('build two crews');
    expect(workflows.list().some((w) => w.name === 'Half crew')).toBe(true);
    expect(workflows.list().some((w) => w.name === 'Never crew')).toBe(false);
    expect(r.done.at(-1)).toMatchObject({
      kind: 'error',
      text: expect.stringContaining('You stopped the Brain; before that it'),
    });
  });

  it('Ask first: building a team waits for you in Needs you; Always allow lets it through from then on', async () => {
    saveSettings({ brainAccess: 'ask' });
    try {
      clearHistory();
      const crew = (name: string) => async (a: EngineRunArgs) => {
        await use(a, 'project_overview', { section: 'library' });
        const r = await use(a, 'team', { do: 'create_team', name, members: [{ new: { name: `${name} one` } }] });
        return r.isError ? 'Could not.' : 'Built it.';
      };
      script = crew('Asked crew');
      const going = ask('build a crew');
      await vi.waitFor(() => expect(listApprovals()).toHaveLength(1));
      const req = listApprovals()[0];
      expect(req).toMatchObject({ agentId: BRAIN_ID, title: expect.stringContaining('The Brain wants to use team') });
      expect(workflows.list().some((w) => w.name === 'Asked crew')).toBe(false);
      decide(req.id, { approved: true, always: true });
      expect((await going).answer).toBe('Built it.');
      expect(workflows.list().some((w) => w.name === 'Asked crew')).toBe(true);
      expect(brainGrants()).toContainEqual({ server: '', tool: 'team:high' });
      // the next turn doesn't ask
      script = crew('Trusted crew');
      expect((await ask('another one')).answer).toBe('Built it.');
      expect(listApprovals()).toEqual([]);
      expect(workflows.list().some((w) => w.name === 'Trusted crew')).toBe(true);
    } finally {
      forgetBrainGrant('');
      saveSettings({ brainAccess: 'full' });
    }
  });

  it('messages that come while it answers wait their turn, one at a time', async () => {
    clearHistory();
    seen.length = 0;
    let running = 0;
    let most = 0;
    let go = () => {};
    const first = new Promise<void>((r) => (go = r));
    script = async (a) => {
      running++;
      most = Math.max(most, running);
      if (a.text.includes('first')) await first;
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return `Done: ${a.text.slice(a.text.lastIndexOf('\n') + 1)}`;
    };
    const answers = [ask('first'), ask('second'), ask('third')];
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    go();
    const done = await Promise.all(answers);
    expect(done.map((r) => r.answer)).toEqual(['Done: first', 'Done: second', 'Done: third']);
    expect(most).toBe(1);
    expect(new Set(seen.map((x) => x.chatId)).size).toBe(1);
  });

  it('opening another project while it waits or answers: the turn stays in the project it was asked in', async () => {
    const home = activeProject();
    const other = await createProject({
      name: 'Elsewhere',
      mode: 'new',
      folder: path.join(os.homedir(), 'projects', 'brain-elsewhere'),
    });
    setActiveProject(home.id);
    clearHistory();
    seen.length = 0;
    let go = () => {};
    const first = new Promise<void>((r) => (go = r));
    script = async (a) => {
      if (a.text.includes('wait here')) await first;
      else await use(a, 'team', { do: 'create_team', name: 'Home crew', members: [{ new: { name: 'Homebody' } }] });
      return 'Done.';
    };
    try {
      const waiting = ask('wait here');
      await vi.waitFor(() => expect(seen).toHaveLength(1));
      const queued = ask('build a crew');
      setActiveProject(other.id);
      go();
      await Promise.all([waiting, queued]);
      expect(seen.map((x) => x.project)).toEqual([home.id, home.id]);
      // its engine chat, and what it built, are in the project it was asked in
      expect(chats.get(BRAIN_ID, seen[1].chatId)).toBeNull();
      expect(workflows.list().some((w) => w.name === 'Home crew')).toBe(false);
      withProject(home, () => {
        expect(chats.get(BRAIN_ID, seen[1].chatId)).not.toBeNull();
        expect(workflows.list().some((w) => w.name === 'Home crew')).toBe(true);
      });
    } finally {
      setActiveProject(home.id);
    }
  });

  it('one answer makes at most 12 changes and hands the work to one agent or team', async () => {
    clearHistory();
    const results: boolean[] = [];
    script = async (a) => {
      for (let i = 0; i < 13; i++)
        results.push(
          (await use(a, 'team', { do: 'create_team', name: `Crew ${i}`, members: [{ new: { name: `Mate ${i}` } }] }))
            .isError === true,
        );
      return 'Built them.';
    };
    await ask('build thirteen crews');
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.at(-1)).toBe(true);

    let second: ToolResult | null = null;
    script = async (a) => {
      const crew = workflows.list().find((w) => w.name === 'Crew 0')!;
      await use(a, 'delegate', { do: 'delegate', to: 'team', id: crew.id, message: 'Do the first thing.' });
      second = await use(a, 'delegate', { do: 'delegate', to: 'team', id: crew.id, message: 'And another.' });
      return 'Handed on.';
    };
    const r = await ask('hand it on twice');
    expect(second).toMatchObject({ isError: true, text: expect.stringContaining('At most one delegate') });
    expect(r.delegate?.message).toBe('Do the first thing.');
  });

  it('notes put in the chat between its turns (finished work) reach its session with the next message', async () => {
    clearHistory();
    seen.length = 0;
    script = async () => 'Handed it on.';
    await ask('research the market');
    addBrainNote(activeProject().id, 'Researcher finished: the market is small.');
    script = async () => 'Will do.';
    await ask('good, put that on the board');
    expect(seen[1].chatId).toBe(seen[0].chatId);
    expect(seen[1].text).toContain('ADDED TO THIS CHAT SINCE YOUR LAST MESSAGE');
    expect(seen[1].text).toContain('Researcher finished: the market is small.');
    expect(seen[1].text).not.toContain('research the market');
    // (once heard, not again)
    await ask('thanks');
    expect(seen[2].text).not.toContain('Researcher finished');
  });

  it('its instructions point to the Agent library through project_overview', async () => {
    seen.length = 0;
    script = async () => 'Ok.';
    await ask('hi');
    expect(seen[0].system).not.toContain('LIBRARY');
    expect(seen[0].system).toContain('project_overview library');
  });

  it('a new conversation while it answers: its engine chat goes when the turn ends', async () => {
    clearHistory();
    seen.length = 0;
    let go = () => {};
    const held = new Promise<void>((r) => (go = r));
    script = async () => {
      await held;
      return 'Late.';
    };
    const answer = ask('take your time');
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    clearHistory();
    go();
    await answer;
    expect(chats.get(BRAIN_ID, seen[0].chatId)).toBeNull();
  });

  it("deleting a conversation of a project that isn't open deletes its engine chat there", async () => {
    const home = activeProject();
    const other = await createProject({
      name: 'Other brain',
      mode: 'new',
      folder: path.join(os.homedir(), 'projects', 'other-brain'),
    });
    seen.length = 0;
    script = async () => 'Hello there.';
    try {
      setActiveProject(other.id);
      clearHistory();
      await ask('hello from there');
      newBrainThread();
      const filed = brainThreads().find((t) => t.title.includes('hello from there'))!;
      setActiveProject(home.id);
      expect(withProject(other, () => chats.get(BRAIN_ID, seen[0].chatId))).not.toBeNull();
      removeBrainThread(filed.id, other.id);
      expect(withProject(other, () => chats.get(BRAIN_ID, seen[0].chatId))).toBeNull();
    } finally {
      setActiveProject(home.id);
    }
  });

  it('on Codex, a session that goes on hears its new instructions when they change', async () => {
    codexHeard.length = 0;
    const brain = (system: string) => ({ ...brainAgent(system, '/tmp/brain'), engine: 'codex' as const });
    const chat = chats.create(BRAIN_ID, 'The Brain', null);
    await askAgent(brain('Rules one.'), 'first', { chatId: chat.id, depth: 0 });
    await askAgent(brain('Rules one.'), 'second', { chatId: chat.id, depth: 0 });
    await askAgent(brain('Rules two: read only.'), 'third', { chatId: chat.id, depth: 0 });
    expect(codexHeard[0]).toContain('Rules one.');
    expect(codexHeard[1]).toBe('second');
    expect(codexHeard[2]).toMatch(/^<instructions-update>[\s\S]*Rules two: read only\.[\s\S]*<\/instructions-update>/);
    expect(codexHeard[2]).toContain('third');
    chats.remove(BRAIN_ID, chat.id);
  });

  it('read only: the run is offered no tools that change things', async () => {
    saveSettings({ brainAccess: 'read' });
    try {
      seen.length = 0;
      script = async () => 'I can only look.';
      await ask('build a crew');
      expect(seen[0].tools).not.toContain('team');
      expect(seen[0].tools).toContain('project_overview');
    } finally {
      saveSettings({ brainAccess: 'full' });
    }
  });
});

describe('every engine keeps the Brain to reading files', () => {
  const brain = (engine: string) => ({ ...brainAgent('x', '/tmp/brain'), engine }) as ReturnType<typeof brainAgent>;
  it('Claude Code: only Read, Glob and Grep of its own', () => {
    const args = claudeArgs(brain('claude-code'), { promptFile: 'p.md', mcpFile: 'm.json' });
    expect(args.join(' ')).toContain('--tools Read,Glob,Grep');
  });
  it('Codex: the read-only sandbox, even on Full', () => {
    const args = codexArgs({ ...brain('codex'), autonomy: 'full' });
    expect(args.join(' ')).toContain('-s read-only');
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  });
  it('Hermes: never --yolo, and none of its terminal, file or code tools', () => {
    const args = hermesArgs({ ...brain('hermes'), autonomy: 'full' });
    expect(args).not.toContain('--yolo');
    const toolsets = args[args.indexOf('-t') + 1].split(',');
    expect(args).toContain('-t');
    for (const own of ['terminal', 'file', 'code_execution', 'browser', 'computer_use', 'delegation', 'cronjob'])
      expect(toolsets).not.toContain(own);
    // (it reads with the dashboard's file tools instead)
    const tools = toolsForAgent(brain('hermes'), { engine: 'hermes' }).map((t) => t.name);
    expect(tools).toContain('read_file');
    expect(tools).not.toContain('write_file');
    // an agent of yours on Hermes keeps every toolset of its profile
    expect(hermesArgs({ ...brain('hermes'), id: 'someone' })).not.toContain('-t');
  });
  it('opencode: reading, and its dashboard tools', () => {
    const rules = permissionRules({ ...brain('opencode'), autonomy: 'full' });
    expect(rules[0]).toEqual({ action: '*', resource: '*', effect: 'deny' });
    expect(rules).toContainEqual({ action: 'read', resource: '*', effect: 'allow' });
    expect(rules).toContainEqual({ action: 'dashboard_*', resource: '*', effect: 'allow' });
    expect(rules).not.toContainEqual({ action: 'edit', resource: '*', effect: 'allow' });
  });
});
