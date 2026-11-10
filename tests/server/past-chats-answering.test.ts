// The Brain chat's conversations while the Brain is still answering: New chat (or opening an earlier one) takes the
// question along with the conversation it was asked in, its answer follows it there, and nothing lands in the new one.
import { describe, expect, it, vi } from 'vitest';
import { activeProject } from '../../server/store.ts';
import { dataPath, writeJSON } from '../../server/util.ts';
import { ask, brainThreads, history, newBrainThread, openBrainThread } from '../../server/overseer.ts';
import { readPast } from '../../server/pastchats.ts';
import type { BrainChatMessage } from '../../shared/types.ts';

// the Brain's model: each answer waits until the test lets it go
const waiting: ((answer: string) => void)[] = [];
vi.mock('../../server/brain.ts', async (orig) => ({
  ...(await orig<typeof import('../../server/brain.ts')>()),
  brainModel: () => ({ provider: 'openrouter', model: 'mock', effort: '', fallback: false }),
  think: () => new Promise<string>((go) => waiting.push(go)),
}));

const pid = () => activeProject().id;
const thinking = async () => {
  await vi.waitUntil(() => waiting.length > 0);
  return waiting.shift()!;
};
const pastOf = (id: string) => readPast<{ id?: string; messages: BrainChatMessage[] }>({ kind: 'brain' }, id)?.messages.map((m) => m.text);

describe('the Brain chat while the Brain answers', () => {
  it('New chat on an empty chat still starts another, and the late answer goes with the question', async () => {
    const first = newBrainThread();
    const answer = ask('What is left to do?');
    const go = await thinking();
    // (nothing was said in it yet, but a question is on its way: it is kept, and a new chat opens)
    const second = newBrainThread();
    expect(second.id).not.toBe(first.id);
    expect(pastOf(first.id)).toEqual(['What is left to do?', expect.stringContaining('not answered here')]);
    go('Two things are left.');
    await answer;
    // the new chat stays empty, and the answer took the note's place
    expect(history()).toEqual([]);
    expect(pastOf(first.id)).toEqual(['What is left to do?', 'Two things are left.']);
  });

  it('opening an earlier chat files the question with the one left, even when that one is opened again', async () => {
    writeJSON(dataPath('projects', pid(), 'brain-chat.json'), { id: 't_older', createdAt: 1, messages: [{ role: 'user', text: 'Older', ts: 1 }, { role: 'brain', text: 'Yes.', ts: 2 }] });
    const left = newBrainThread();
    const answer = ask('Plan the launch.');
    const go = await thinking();
    openBrainThread('t_older');
    expect(pastOf(left.id)?.[0]).toBe('Plan the launch.');
    // back to it before the answer comes: the answer lands in the open chat
    openBrainThread(left.id);
    go('Here is the plan.');
    await answer;
    expect(history().map((m) => m.text)).toEqual(['Plan the launch.', 'Here is the plan.']);
    expect(brainThreads()[0]).toMatchObject({ id: left.id, open: true, count: 2 });
  });
});
