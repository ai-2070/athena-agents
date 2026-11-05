// The JSON routes that have moved to oRPC: what each one takes and gives back, at the address it always had.
// The server implements them (server/api/), the page calls them (web/client/rpc.ts).
// docs/internal/plans/ORPC_PLAN.md says why and how; routes not here are still in server/index.ts.
import { agents } from './agents.ts';
import { projects } from './projects.ts';
import { taskBoard } from './taskboard.ts';

export const contract = { agents, projects, taskBoard };
