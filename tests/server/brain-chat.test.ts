// The Brain chat: clearing it while an answer is on its way, and messages meant for another project.
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { activeProject, bus, listProjects, saveProjects, setActiveProject, workflows } from '../../server/store.ts';
import { ask, brainChatLine, clearHistory, history, steerAsks } from '../../server/overseer.ts';
import type { ServerEvent } from '../../shared/types.ts';

// Delegation metadata is real, but these chat tests must not launch a local CLI agent.
vi.mock('../../server/engines/index.ts', async (orig) => ({
  ...(await orig<typeof import('../../server/engines/index.ts')>()),
  askAgent: async () => 'Finished.',
}));

// the "model" answers only when the test says so (and tells what it does as it thinks through thinking's onPart)
const pending: ((text: string) => void)[] = [];
const thinking: (((p: unknown) => void) | undefined)[] = [];
vi.mock('../../server/brain.ts', async (orig) => ({
  ...(await orig<typeof import('../../server/brain.ts')>()),
  brainModel: () => ({ provider: 'openrouter', model: 'mock', fallback: false }),
  think: (_system: string, _prompt: string, opts?: { onPart?: (p: unknown) => void }) => {
    thinking.push(opts?.onPart);
    return new Promise<string>((resolve) => pending.push(resolve));
  },
}));
// handing work on waits while the test holds it (an answer past the point where it could be stopped)
const briefs: (() => void)[] = [];
let holdBriefs = false;
vi.mock('../../server/irc.ts', async (orig) => {
  const real = await orig<typeof import('../../server/irc.ts')>();
  return {
    ...real,
    sendBrief: async (...args: Parameters<typeof real.sendBrief>) => {
      // (held, then not handed on: no agent starts working in the test)
      if (holdBriefs) return new Promise<void>((r) => briefs.push(r));
      return real.sendBrief(...args);
    },
  };
});
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
  if (!ok()) throw new Error('timed out');
};
const answerNext = async (text: string) => {
  await until(() => pending.length > 0);
  pending.shift()!(text);
};

describe('the Brain chat', () => {
  it('keeps the files it read with its answer, so a reopened chat shows them', async () => {
    const pid = activeProject().id;
    clearHistory(pid);
    const going = ask('what does the readme say?');
    await until(() => pending.length > 0);
    const tell = thinking.at(-1)!;
    tell({ kind: 'tool', id: 't1', name: 'Read', args: { file_path: 'README.md' } });
    tell({ kind: 'tool_result', id: 't1', text: 'x'.repeat(5000) });
    tell({ kind: 'tool', id: 't2', name: 'Glob', args: { pattern: '*.md' } });
    pending.shift()!('It says hello.');
    await going;
    const saved = history(pid)[1];
    expect(saved.text).toBe('It says hello.');
    expect(saved.steps).toEqual([
      { id: 't1', name: 'Read', input: { file_path: 'README.md' }, state: 'done', output: expect.stringMatching(/^x{2000}…$/) },
      // (no result came: not shown as still running)
      { id: 't2', name: 'Glob', input: { pattern: '*.md' }, state: 'error', output: '(no result)' },
    ]);
    clearHistory(pid);
  });

  it('keeps where it handed the work, so a reopened chat follows it again', async () => {
    const pid = activeProject().id;
    clearHistory(pid);
    const going = ask('get a review going');
    await answerNext('On it.\n```actions\n[{"do":"create_team","name":"Review crew","members":[{"new":{"name":"Reviewer"}}]},{"do":"delegate","to":"team","id":"new","message":"Review the app."}]\n```');
    await going;
    const saved = history(pid)[1];
    expect(saved.delegate).toMatchObject({ kind: 'branch', name: 'Review crew', sent: { messageId: expect.any(String), ts: expect.any(Number) } });
    clearHistory(pid);
  });

  it('a late answer does not bring back a conversation you cleared, or change anything', async () => {
    const pid = activeProject().id;
    const first = ask('old-question-sentinel');
    await answerNext('old-answer-sentinel');
    await first;
    expect(history(pid).map((m) => m.text)).toEqual(['old-question-sentinel', 'old-answer-sentinel']);

    const late = ask('pending-question-sentinel');
    await until(() => pending.length > 0);
    clearHistory();
    expect(history(pid)).toEqual([]);
    await answerNext('late-answer-sentinel\n```actions\n[{"do":"create_team","name":"Late team","members":[{"new":{"name":"Late"}}]}]\n```');
    const r = await late;
    expect(history(pid)).toEqual([]);
    expect(workflows.list().some((w) => w.name === 'Late team')).toBe(false);
    expect(r.delegate).toBeNull();
    expect(r.done).toEqual([expect.objectContaining({ kind: 'error' })]);
  });

  it('a new message while it answers: that answer changes nothing, and its question stays in the history', async () => {
    const pid = activeProject().id;
    clearHistory();
    const cut = ask('make a design team');
    await until(() => pending.length > 0);
    steerAsks();
    await answerNext('On it\n```actions\n[{"do":"create_team","name":"Cut team","members":[{"new":{"name":"Cut"}}]}]\n```');
    const r = await cut;
    expect(workflows.list().some((w) => w.name === 'Cut team')).toBe(false);
    expect(r.done).toEqual([expect.objectContaining({ kind: 'error', text: expect.stringContaining('stopped') })]);
    // (the next answer sees the question it cut off)
    expect(history(pid).map((m) => m.text)).toEqual(['make a design team', '(stopped before answering: the user sent a new message)']);
  });

  it('a new message after the answer was too far along to stop: what it did stands, once, and the chat hears it', async () => {
    const pid = activeProject().id;
    clearHistory();
    const late: ServerEvent[] = [];
    const hear = (e: ServerEvent) => void (e.type === 'brain-late' && late.push(e));
    bus.on('event', hear);
    holdBriefs = true;
    try {
      const going = ask('build the launch team');
      await answerNext('Done\n```actions\n[{"do":"create_team","name":"Launch crew","members":[{"new":{"name":"Launcher"}}]},{"do":"delegate","to":"team","id":"new","message":"Plan the launch."}]\n```');
      // (handing the work on: past the point where it could be stopped)
      await until(() => briefs.length > 0);
      steerAsks();
      briefs.shift()!();
      const r = await going;
      expect(workflows.list().some((w) => w.name === 'Launch crew')).toBe(true);
      expect(r.delegate).toMatchObject({ kind: 'branch', name: 'Launch crew' });
      // its question once, with its own answer (no "stopped before answering" next to it)
      expect(history(pid).map((m) => m.role)).toEqual(['user', 'brain']);
      // what it did is kept apart from what it said (a reopened chat shows it as actions), and read back to it as before
      const saved = history(pid)[1];
      expect(saved.text).toBe('Done');
      expect(saved.done?.map((d) => d.kind)).toEqual(['hired', 'team']);
      expect(saved.delegate).toMatchObject({ kind: 'branch', name: 'Launch crew', message: 'Plan the launch.' });
      expect(brainChatLine(saved)).toMatch(/^Done\n\(Created a new agent: .*Launcher\)\n\(Built the team "Launch crew".*\)\n\(handed to Launch crew: Plan the launch\.\)$/);
      expect(late).toEqual([expect.objectContaining({ projectId: pid, answer: expect.objectContaining({ delegate: expect.objectContaining({ name: 'Launch crew' }) }) })]);
    } finally {
      holdBriefs = false;
      bus.off('event', hear);
    }
  });

  it('a /goal it was answering is not kept as a stopped question', async () => {
    const pid = activeProject().id;
    clearHistory();
    const cut = ask('ship it', { goal: true });
    await until(() => pending.length > 0);
    steerAsks();
    await answerNext('On it');
    await cut;
    expect(history(pid)).toEqual([]);
  });

  it('two answers that overlap are both kept', async () => {
    const pid = activeProject().id;
    clearHistory();
    const a = ask('first');
    const b = ask('second');
    await until(() => pending.length === 2);
    pending.shift()!('answer one');
    await a;
    pending.shift()!('answer two');
    await b;
    expect(history(pid).map((m) => m.text)).toEqual(['first', 'answer one', 'second', 'answer two']);
  });

  it('refuses a message typed in another project, before asking the model', async () => {
    const home = activeProject();
    saveProjects([...listProjects(), { ...home, id: 'elsewhere', name: 'Elsewhere', brainPath: path.join(path.dirname(home.brainPath), 'elsewhere') }]);
    clearHistory();
    await expect(ask('meant for elsewhere', { project: 'elsewhere' })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('Elsewhere') });
    expect(pending).toEqual([]);
    expect(history(home.id)).toEqual([]);
    // the project it is open in is fine
    const ok = ask('meant for here', { project: home.id });
    await answerNext('Sure.');
    expect((await ok).answer).toBe('Sure.');
  });

  it('changes nothing when you switched away and back while it thought', async () => {
    const home = activeProject();
    if (!listProjects().some((x) => x.id === 'away')) saveProjects([...listProjects(), { ...home, id: 'away', name: 'Away', brainPath: path.join(path.dirname(home.brainPath), 'away') }]);
    const r = ask('build a team');
    await until(() => pending.length > 0);
    setActiveProject('away');
    setActiveProject(home.id);
    await answerNext('On it.\n```actions\n[{"do":"create_team","name":"Round trip team","members":[{"new":{"name":"Rounder"}}]}]\n```');
    const out = await r;
    expect(out.done).toEqual([expect.objectContaining({ kind: 'error', text: expect.stringContaining('switched projects') })]);
    expect(workflows.list().some((w) => w.name === 'Round trip team')).toBe(false);
    // re-opening the project you're already in is not a switch
    setActiveProject(home.id);
    const again = ask('build it now');
    await until(() => pending.length > 0);
    setActiveProject(home.id);
    await answerNext('Done.\n```actions\n[{"do":"create_team","name":"Stayed team","members":[{"new":{"name":"Stayer"}}]}]\n```');
    expect((await again).done.map((d) => d.kind)).toEqual(['hired', 'team']);
  });
});
