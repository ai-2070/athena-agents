// The teams themselves (shared/api/workflows.ts). A team is stored in the "workflows" collection; old ones are
// step lists, run by server/workflows.ts.
import { implement } from '@orpc/server';
import { workflows as contract } from '../../shared/api/workflows.ts';
import { agents, log, runs, workflows } from '../store.ts';
import * as teams from '../teams.ts';
import * as teamMarks from '../teammark.ts';
import * as wfs from '../workflows.ts';
import { cloneTeam } from '../presets.ts';
import { pickMember } from '../brain.ts';
import { cleanAttachments } from '../uploads.ts';
import { deleteAgent } from './agents.ts';
import { refuse } from './refuse.ts';
import type { Team } from '../../shared/types.ts';

const os = implement(contract);

const gone = (): never => refuse('That team is unavailable.', 404);
const saved = (id: string) => workflows.get(id) || gone();
// what comes in: a team's files only from this project's uploads, and its symbol only an emoji
const cleaned = <T extends { files?: string[]; mark?: string }>(body: T): T => ({
  ...body,
  ...(body.files !== undefined ? { files: cleanAttachments(body.files) } : {}),
  ...(body.mark !== undefined ? { mark: teamMarks.cleanMark(body.mark) } : {}),
});
// a picture or model that isn't right is refused in its own words
const marked = (fn: () => Team): Team => {
  try {
    return fn();
  } catch (e) {
    return refuse(e instanceof Error ? e.message : String(e), 400);
  }
};

export const workflowsRouter = os.router({
  list: os.list.handler(() =>
    teams
      .listTeams()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((t) => ({ ...t, state: teams.teamState(t.id), last: teams.getThread(t.id, 1).messages[0] || null })),
  ),
  create: os.create.handler(({ input }) => workflows.save({ name: 'New workflow', steps: [], schedule: { type: 'none' }, enabled: false, ...cleaned(input) })),
  get: os.get.handler(({ input }) => teams.getTeam(input.id) || gone()),
  change: os.change.handler(({ input: { id, ...body } }) => workflows.save({ ...saved(id), ...cleaned(body), id })),
  remove: os.remove.handler(({ input }) => {
    const team = teams.getTeam(input.id);
    if (!team) return { ok: true as const };
    workflows.remove(team.id);
    teamMarks.dropMarkFiles(team.id);
    log('team', `Deleted team ${team.name}`);
    // its agents go with it, except those still on another team
    const elsewhere = new Set(teams.listTeams().flatMap((t) => t.members));
    const deletedAgents: string[] = [];
    for (const agentId of team.members) {
      const a = agents.get(agentId);
      if (!a || elsewhere.has(agentId)) continue;
      deleteAgent(a);
      deletedAgents.push(agentId);
    }
    return { ok: true as const, deletedAgents };
  }),
  run: os.run.handler(({ input }) =>
    teams.isStepList(saved(input.id)) ? wfs.startWorkflow(input.id, input.input || '') : teams.postUserMessage(input.id, input.input || 'Go ahead.', { route: pickMember }),
  ),
  clone: os.clone.handler(({ input }) => {
    saved(input.id);
    return cloneTeam(input.id, { withAgents: !!input.withAgents });
  }),
  setMark: os.setMark.handler(({ input }) => {
    saved(input.id);
    return marked(() => teamMarks.setMarkFile(input.id, input.name, input.data));
  }),
  removeMark: os.removeMark.handler(({ input }) => {
    saved(input.id);
    return teamMarks.removeMarkFile(input.id);
  }),
  templates: {
    list: os.templates.list.handler(() => wfs.TEMPLATES.map(({ name, description, needs }) => ({ name, description, needs }))),
    create: os.templates.create.handler(({ input }) => {
      if (!wfs.TEMPLATES.some((t) => t.name === input.name)) return refuse('Pick one of the starter teams.', 404);
      return wfs.createFromTemplate(input.name);
    }),
  },
  active: os.active.handler(() => runs.list().filter((r) => r.status === 'running').map(wfs.runSummary)),
  runs: {
    list: os.runs.list.handler(({ input }) =>
      runs
        .list()
        .filter((r) => !input.workflowId || r.workflowId === input.workflowId)
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
        .slice(0, 50),
    ),
    stop: os.runs.stop.handler(({ input }) => ({ ok: wfs.stopWorkflowRun(input.id) })),
  },
});
