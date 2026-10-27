// The Brain chat: clearing it while an answer is on its way, and messages meant for another project.
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { activeProject, listProjects, saveProjects, setActiveProject, workflows } from '../../server/store.ts';
import { ask, clearHistory, history, steerAsks } from '../../server/overseer.ts';

// the "model" answers only when the test says so
const pending: ((text: string) => void)[] = [];
vi.mock('../../server/brain.ts', async (orig) => ({
  ...(await orig<typeof import('../../server/brain.ts')>()),
  brainModel: () => ({ provider: 'openrouter', model: 'mock', fallback: false }),
  think: () => new Promise<string>((resolve) => pending.push(resolve)),
}));
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
  if (!ok()) throw new Error('timed out');
};
const answerNext = async (text: string) => {
  await until(() => pending.length > 0);
  pending.shift()!(text);
};

describe('the Brain chat', () => {
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
    steerAsks({ text: 'make a design team', attachments: [] });
    // (the next answer sees the question it cut off)
    expect(history(pid).map((m) => m.text)).toEqual(['make a design team', '(stopped before answering: the user sent a new message)']);
    await answerNext('On it\n```actions\n[{"do":"create_team","name":"Cut team","members":[{"new":{"name":"Cut"}}]}]\n```');
    const r = await cut;
    expect(workflows.list().some((w) => w.name === 'Cut team')).toBe(false);
    expect(r.done).toEqual([expect.objectContaining({ kind: 'error', text: expect.stringContaining('stopped') })]);
    expect(history(pid)).toHaveLength(2);
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
