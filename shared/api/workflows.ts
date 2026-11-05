// The teams themselves (server/api/workflows.ts): the list, making, changing, copying, running and deleting a team,
// its picture or 3D model, the starter teams, and the runs of old step-list teams. They are stored as "workflows",
// hence the addresses. The list is also answered under /api/p/<project> for a project that isn't open. The picture
// itself (GET …/mark) is still sent by server/index.ts; a team's chat is shared/api/teams.ts.
import { oc, type } from '@orpc/contract';
import { z } from 'zod';
import type { RunSummary, Team, TeamListing, TeamMessage, WorkflowRun, WorkflowTemplateInfo } from '../types.ts';

const oneTeam = z.object({ id: z.string() });
const words = (field: string) => z.string({ error: `${field} must be text.` }).optional();
const names = (field: string) => z.array(z.string(), { error: `${field} must be a list.` }).optional();
const spot = z.number({ error: 'A place on the map is a number.' }).nullable().optional();

/** What can be set on a team; every field can be left out. Its picture or model (markFile) has its own routes,
 *  so saving a team can't point it at another file. */
const teamFields = {
  name: words('name'),
  description: words('description'),
  color: words('color'),
  /** an emoji; anything else becomes '' (the default) */
  mark: words('mark'),
  members: names('members'),
  lead: z.string({ error: 'lead must name an agent.' }).nullable().optional(),
  /** the tool groups and MCP servers its members get here (a list left out is none) */
  access: z.object({ toolGroups: z.array(z.string()).default([]), mcpServers: z.array(z.string()).default([]) }, { error: 'access must list its tool groups and MCP servers.' }).optional(),
  skills: names('skills'),
  /** reference files: only uploads of this project are kept */
  files: names('files'),
  // (a step can carry its tool's own settings, so its other fields are kept as they are)
  steps: z.array(z.looseObject({ type: z.string() }), { error: 'Each step needs a type.' }).optional(),
  schedule: z.object({
    type: z.string(),
    times: z.array(z.string()).optional(),
    minutes: z.number().optional(),
    days: z.array(z.number()).optional(),
    input: z.string().optional(),
  }, { error: 'schedule must say when it runs.' }).optional(),
  enabled: z.boolean({ error: 'enabled must be true or false.' }).optional(),
  pos: z.object({ x: z.number(), z: z.number() }, { error: 'A place on the map is x and z.' }).nullable().optional(),
  rot: spot,
  angle: spot,
};
const teamPatch = z.object(teamFields);
/** A change to a team, as the page sends it. */
export type TeamPatch = z.input<typeof teamPatch>;

export const workflows = {
  /** Every team, by name, with who is working and its latest message. */
  list: oc.route({ method: 'GET', path: '/workflows' }).output(type<TeamListing[]>()),
  /** A new team, off and unscheduled unless it says otherwise. */
  create: oc.route({ method: 'POST', path: '/workflows' }).input(teamPatch).output(type<Team>()),
  /** An old step list gets its members from its agent steps. */
  get: oc.route({ method: 'GET', path: '/workflows/{id}' }).input(oneTeam).output(type<Team>()),
  change: oc.route({ method: 'PUT', path: '/workflows/{id}' }).input(oneTeam.extend(teamFields)).output(type<Team>()),
  /** Deletes it; its agents go with it, except those still on another team (deletedAgents). */
  remove: oc.route({ method: 'DELETE', path: '/workflows/{id}' }).input(oneTeam).output(type<{ ok: true; deletedAgents?: string[] }>()),
  /** "Run": a step list runs its steps (the run); a team gets the input in its chat (the message). */
  run: oc.route({ method: 'POST', path: '/workflows/{id}/run' })
    .input(oneTeam.extend({ input: words('input') }))
    .output(type<WorkflowRun | TeamMessage>()),
  /** A copy in this project; withAgents: its members are copied too (otherwise the copy shares them). */
  clone: oc.route({ method: 'POST', path: '/workflows/{id}/clone' })
    .input(oneTeam.extend({ withAgents: z.boolean({ error: 'withAgents must be true or false.' }).optional() }))
    .output(type<Team>()),
  /** A picture (PNG, JPG, WebP, GIF) or 3D model in the middle of its pod instead of its emoji. data: a data: URL. */
  setMark: oc.route({ method: 'POST', path: '/workflows/{id}/mark' })
    .input(oneTeam.extend({ name: z.string({ error: 'Pick a picture or a 3D model.' }), data: z.string({ error: "Couldn't read that file." }) }))
    .output(type<Team>()),
  /** Back to the emoji. */
  removeMark: oc.route({ method: 'DELETE', path: '/workflows/{id}/mark' }).input(oneTeam).output(type<Team>()),
  /** The starter teams, and one made from them (its steps matched to your agents by name). */
  templates: {
    list: oc.route({ method: 'GET', path: '/workflow-templates' }).output(type<WorkflowTemplateInfo[]>()),
    create: oc.route({ method: 'POST', path: '/workflow-templates' })
      .input(z.object({ name: z.string({ error: 'Pick a starter team.' }) }))
      .output(type<Team>()),
  },
  /** The step lists running now, as the Station lights up their branches. */
  active: oc.route({ method: 'GET', path: '/workflow-active' }).output(type<RunSummary[]>()),
  runs: {
    /** The latest 50 runs, newest first; workflowId: only that team's. */
    list: oc.route({ method: 'GET', path: '/workflow-runs' })
      .input(z.object({ workflowId: z.string().optional() }))
      .output(type<WorkflowRun[]>()),
    stop: oc.route({ method: 'POST', path: '/workflow-runs/{id}/stop' }).input(oneTeam).output(type<{ ok: boolean }>()),
  },
};
