// The JSON routes that have moved to oRPC: what each one takes and gives back, at the address it always had.
// The server implements them (server/api/), the page calls them (web/client/rpc.ts).
// docs/internal/plans/ORPC_PLAN.md says why and how; routes not here are still in server/index.ts.
import { agents } from './agents.ts';
import { brain } from './brain.ts';
import { projects } from './projects.ts';
import { taskBoard } from './taskboard.ts';
import { teams } from './teams.ts';
import { workflows } from './workflows.ts';
import { approvals, questions } from './needs.ts';
import { routines } from './routines.ts';
import { runs } from './runs.ts';
import { tasks } from './tasks.ts';
import { skills } from './skills.ts';
import { versions } from './versions.ts';
import { library, presets } from './library.ts';
import { status } from './status.ts';
import { accounts, settings } from './settings.ts';
import { engines, mcp } from './mcp.ts';
import { comfyui, programs } from './programs.ts';
import { assist } from './assist.ts';
import { world, worlds } from './world.ts';
import { gateways } from './gateways.ts';
import { outbox } from './outbox.ts';
import { artifacts, backups, files, layout, memory, terminals, uploads } from './files.ts';

export const contract = {
  agents,
  brain,
  projects,
  taskBoard,
  teams,
  workflows,
  questions,
  approvals,
  tasks,
  routines,
  runs,
  skills,
  versions,
  library,
  presets,
  status,
  settings,
  accounts,
  mcp,
  engines,
  programs,
  comfyui,
  assist,
  files,
  uploads,
  memory,
  artifacts,
  backups,
  layout,
  terminals,
  world,
  worlds,
  gateways,
  outbox,
};
