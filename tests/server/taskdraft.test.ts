// "Draft with the Brain" on the Tasks board: what the Brain is told (the task, its comments, what you asked) and
// what comes back into the box. The Brain's model is a stand-in.
import { describe, expect, it, vi } from 'vitest';
import { createProject } from '../../server/projects.ts';
import { addBoardComment, addBoardTask } from '../../server/taskboard.ts';
import { draftBoardText } from '../../server/taskdraft.ts';

const asked: { system: string; user: string }[] = [];
const answers: string[] = [];
vi.mock('../../server/brain.ts', async (orig) => ({
  ...(await orig<typeof import('../../server/brain.ts')>()),
  think: async (system: string, user: string) => (asked.push({ system, user }), answers.shift() ?? ''),
}));

describe('Draft with the Brain', () => {
  it("drafts a task's title and description from what is there and what you asked", async () => {
    const p = await createProject({ name: 'Draft bakery', description: 'A small bakery' });
    answers.push('{"title":"Bake a test batch","description":"Bake **12** cupcakes.\\n- [ ] Taste them"}');
    const d = await draftBoardText({
      projectId: p.id,
      kind: 'task',
      title: 'cupcakes',
      instruction: 'make it a checklist',
    });
    expect(d).toEqual({
      kind: 'task',
      title: 'Bake a test batch',
      description: 'Bake **12** cupcakes.\n- [ ] Taste them',
    });
    expect(asked.at(-1)!.user).toContain('Project: Draft bakery (A small bakery)');
    expect(asked.at(-1)!.user).toContain('Title: cupcakes');
    expect(asked.at(-1)!.user).toContain('What the user wants: make it a checklist');
  });

  it('drafts a comment with the task and its thread in view', async () => {
    const p = await createProject({ name: 'Draft comments' });
    const t = addBoardTask(p.id, { title: 'Order flour', description: 'Two sacks.' });
    addBoardComment(p.id, t.id, 'The mill is closed until Monday.');
    answers.push('{"text":"Moving this to Monday, then."}');
    expect(await draftBoardText({ projectId: p.id, kind: 'comment', taskId: t.id, text: 'Monday?' })).toEqual({
      kind: 'comment',
      text: 'Moving this to Monday, then.',
    });
    const user = asked.at(-1)!.user;
    expect(user).toContain('Task #1: Order flour');
    expect(user).toContain('You: The mill is closed until Monday.');
    expect(user).toContain('The comment written so far:\nMonday?');
    await expect(draftBoardText({ projectId: p.id, kind: 'comment' })).rejects.toThrow(
      'Say which task the comment is for.',
    );
    answers.push('not json at all');
    await expect(draftBoardText({ projectId: p.id, kind: 'comment', taskId: t.id })).rejects.toThrow();
  });
});
