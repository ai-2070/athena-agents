// Every area's procedures, implementing shared/api/. server/rpc.ts answers them.
import { implement } from '@orpc/server';
import { contract } from '../../shared/api/index.ts';
import { agentsRouter } from './agents.ts';
import { projectsRouter } from './projects.ts';
import { taskBoard } from './taskboard.ts';

export const apiRouter = implement(contract).router({ agents: agentsRouter, projects: projectsRouter, taskBoard });
