// The Brain chat: clearing it while an answer is on its way, and messages meant for another project.
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { activeProject, listProjects, saveProjects, workflows } from '../../server/store.ts';
import { ask, clearHistory, history } from '../../server/overseer.ts';

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
});
