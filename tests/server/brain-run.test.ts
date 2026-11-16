// The Brain's turn as a real agent run (brainrun.ts → askAgent → startRun) on a stand-in Eve engine that calls the
// Brain's tools the way a model would; and each engine keeping the Brain to reading files.
import { describe, expect, it, vi } from 'vitest';
import { chats, saveSettings, workflows } from '../../server/store.ts';
import { decide, listApprovals } from '../../server/approvals.ts';
import { brainGrants, forgetBrainGrant } from '../../server/mcp.ts';
import { ask, clearHistory, history, stopAsks } from '../../server/overseer.ts';
import { callTool, toolsForAgent } from '../../server/tools.ts';
import { claudeArgs } from '../../server/engines/claude.ts';
import { codexArgs } from '../../server/engines/codex.ts';
import { hermesArgs } from '../../server/engines/hermes.ts';
import { permissionRules } from '../../server/engines/opencode.ts';
import { brainAgent } from '../../server/brainrun.ts';
import { BRAIN_ID } from '../../server/braintools.ts';
import type { EngineRunArgs } from '../../server/engines/index.ts';

vi.mock('../../server/brain.ts', async (orig) => ({
  ...(await orig<typeof import('../../server/brain.ts')>()),
  brainModel: () => ({ provider: 'openrouter', model: 'mock', effort: '', fallback: false }),
}));

// what each turn the engine got, and what the "model" does in it
const seen: { system: string; text: string; tools: string[]; chatId: string; engine: string }[] = [];
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
    });
    return { text: await script(args) };
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
    // a new conversation starts a new session
    clearHistory();
    await ask('hi again');
    expect(seen[2].chatId).not.toBe(seen[0].chatId);
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
  it('Hermes: never --yolo', () => {
    expect(hermesArgs({ ...brain('hermes'), autonomy: 'full' })).not.toContain('--yolo');
  });
  it('opencode: reading, and its dashboard tools', () => {
    const rules = permissionRules({ ...brain('opencode'), autonomy: 'full' });
    expect(rules[0]).toEqual({ action: '*', resource: '*', effect: 'deny' });
    expect(rules).toContainEqual({ action: 'read', resource: '*', effect: 'allow' });
    expect(rules).toContainEqual({ action: 'dashboard_*', resource: '*', effect: 'allow' });
    expect(rules).not.toContainEqual({ action: 'edit', resource: '*', effect: 'allow' });
  });
});
