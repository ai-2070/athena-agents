// The Overview page's picture of every project: who works, what needs you, and when each last changed, read in each
// project whichever is open, without any chat contents.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chats, questions, setActiveProject, withProject, workflows } from '../../server/store.ts';
import { newAgent } from '../../server/library.ts';
import { createProject } from '../../server/projects.ts';
import { addBrief, updateBrief } from '../../server/briefs.ts';
import { addBoardTask, editBoardTask } from '../../server/taskboard.ts';
import { overview } from '../../server/overview.ts';
import type { ActiveRun, Approval, Terminal } from '../../shared/types.ts';

const fake = vi.hoisted(() => ({ runs: [] as ActiveRun[], approvals: [] as Approval[], terminals: [] as Terminal[] }));
vi.mock('../../server/terminals.ts', () => ({ listTerminals: () => fake.terminals }));
vi.mock('../../server/engines/index.ts', async (original) => ({
  ...(await original<typeof import('../../server/engines/index.ts')>()),
  activeRuns: () => fake.runs,
}));
vi.mock('../../server/approvals.ts', async (original) => ({
  ...(await original<typeof import('../../server/approvals.ts')>()),
  listApprovals: () => fake.approvals,
}));
afterEach(() => {
  fake.runs = [];
  fake.approvals = [];
  fake.terminals = [];
});

describe('the Overview', () => {
  it("shows every project's agents, teams, the Brain and tasks at work, with what works and what needs you", async () => {
    const bakery = await createProject({ name: 'Overview bakery' });
    const podcast = await createProject({ name: 'Overview podcast' });
    const writer = withProject(bakery, () => newAgent({ name: 'Overview writer' }));
    const baker = withProject(bakery, () => newAgent({ name: 'Overview baker' }));
    const host = withProject(podcast, () => newAgent({ name: 'Overview host' }));
    const team = withProject(podcast, () =>
      workflows.save({ name: 'Overview show', members: [host.id], lead: host.id, steps: [] }),
    );
    // the podcast is open; the bakery isn't
    setActiveProject(podcast.id);

    fake.terminals = [
      {
        id: 't1',
        title: 'PowerShell',
        agentId: null,
        createdAt: 5,
        exited: false,
        exitCode: null,
        command: 'pwsh',
        projectId: bakery.id,
      },
      {
        id: 't2',
        title: 'Dev server',
        agentId: null,
        createdAt: 6,
        exited: true,
        exitCode: 1,
        command: 'npm run dev',
        projectId: podcast.id,
      },
    ];
    fake.runs = [
      {
        id: 'r1',
        agentId: writer.id,
        chatId: 'c1',
        projectId: bakery.id,
        startedAt: 1,
        agentName: writer.name,
        parentRunId: null,
      },
    ];
    fake.approvals = [
      {
        id: 'ap1',
        kind: 'tool',
        title: 'Run a command',
        detail: '',
        agentId: baker.id,
        agentName: baker.name,
        data: {},
        editable: null,
        createdAt: 1,
        projectId: bakery.id,
      },
    ];
    withProject(podcast, () =>
      questions.save({
        id: 'q1',
        question: 'Which intro music?',
        choices: [],
        status: 'waiting',
        teamId: team.id,
        createdAt: 1,
      } as never),
    );
    const brief = addBrief(
      { kind: 'agent', targetId: host.id, name: host.name, text: 'Edit', ts: Date.now() },
      podcast.id,
    );
    updateBrief(brief.id, { status: 'blocked', summary: 'It needs the raw recording.' }, podcast.id);
    const task = addBoardTask(bakery.id, { title: 'Bake bread', assignee: `agent:${writer.id}` });
    editBoardTask(bakery.id, task.id, (t) => {
      t.work = {
        operationId: 'r9',
        conversationId: `board-${t.id}`,
        target: { kind: 'agent', id: writer.id },
        startedAt: 1,
        state: 'waiting',
      };
    });

    // chats: the newest ordinary one is named; private ones (gateways, board tasks) aren't
    withProject(bakery, () => {
      chats.save({
        id: 'c-old',
        agentId: writer.id,
        title: 'Old',
        items: [{ type: 'user', text: 'SECRET WORDS', ts: 1 }],
        sessionId: null,
        createdAt: 1,
        updatedAt: 1,
      } as never);
      chats.save({
        id: 'c-new',
        agentId: writer.id,
        title: 'New',
        items: [],
        sessionId: null,
        createdAt: 2,
        updatedAt: 2,
      } as never);
      chats.save({
        id: 'private-chat-x',
        agentId: writer.id,
        conversationId: 'board-x',
        title: 'Private',
        items: [],
        sessionId: null,
        createdAt: 3,
        updatedAt: 3,
      } as never);
      // (the old one was last changed long ago; the private one just now)
      fs.utimesSync(path.join(chats.dir(writer.id), 'c-old.json'), new Date(2020, 0, 1), new Date(2020, 0, 1));
    });

    const o = overview();
    expect(o.active).toBe(podcast.id);
    expect(o.projects[0].id).toBe(podcast.id);
    const b = o.projects.find((p) => p.id === bakery.id)!;
    const p = o.projects.find((x) => x.id === podcast.id)!;
    const of = (proj: typeof b, id: string) => proj.sessions.find((s) => s.id === id)!;
    expect(of(b, writer.id)).toMatchObject({ kind: 'agent', status: 'working', chatId: 'c-new' });
    expect(of(b, writer.id).updatedAt).toBeGreaterThan(0);
    expect(of(b, baker.id)).toMatchObject({ status: 'needs-you', why: 'Approval: Run a command' });
    expect(of(b, task.id)).toMatchObject({
      kind: 'task',
      number: task.number,
      name: 'Bake bread',
      status: 'needs-you',
    });
    expect(of(p, team.id)).toMatchObject({ kind: 'team', status: 'needs-you', why: 'Question: Which intro music?' });
    expect(of(p, host.id)).toMatchObject({ status: 'needs-you', why: 'It needs the raw recording.' });
    expect(of(p, 'brain')).toMatchObject({ kind: 'brain', status: 'idle' });
    // each terminal under the project it was opened in; an ended one says so
    expect(of(b, 't1')).toMatchObject({ kind: 'terminal', name: 'PowerShell', status: 'idle' });
    expect(of(b, 't1').ended).toBeUndefined();
    expect(of(p, 't2')).toMatchObject({ kind: 'terminal', ended: true, why: 'Ended (exit code 1)' });
    expect(b.sessions.some((x) => x.id === 't2')).toBe(false);
    expect(b).toMatchObject({ working: 1, needsYou: 2, boardOpen: 1 });
    expect(p).toMatchObject({ working: 0, needsYou: 2 });
    // names and times only
    expect(JSON.stringify(o)).not.toContain('SECRET WORDS');
  });
  it("keeps each agent's newest chat from the chats' saves, without reading every chat file again", async () => {
    const p = await createProject({ name: 'Overview busy' });
    const agent = withProject(p, () => newAgent({ name: 'Overview chatter' }));
    const first = withProject(p, () => chats.create(agent.id));
    const of = () =>
      overview()
        .projects.find((x) => x.id === p.id)!
        .sessions.find((s) => s.id === agent.id)!;
    expect(of().chatId).toBe(first.id);
    const stat = vi.spyOn(fs, 'statSync');
    try {
      // a new chat, and a private one (a gateway's): the newest is the new one, known without looking at the files
      const second = withProject(p, () => chats.create(agent.id));
      withProject(p, () =>
        chats.save({
          id: 'private-chat-x',
          agentId: agent.id,
          title: 'Gateway',
          items: [],
          sessionId: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }),
      );
      expect(of().chatId).toBe(second.id);
      const chatFiles = stat.mock.calls.filter(([f]) => String(f).includes(`${path.sep}chats${path.sep}`));
      expect(chatFiles).toEqual([]);
    } finally {
      stat.mockRestore();
    }
  });
});
