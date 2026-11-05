// Every area's procedures, implementing shared/api/. server/rpc.ts answers them.
import { implement } from '@orpc/server';
import { contract } from '../../shared/api/index.ts';
import { agentsRouter } from './agents.ts';
import { brainRouter } from './brain.ts';
import { projectsRouter } from './projects.ts';
import { taskBoard } from './taskboard.ts';
import { teamsRouter } from './teams.ts';
import { workflowsRouter } from './workflows.ts';

export const apiRouter = implement(contract).router({ agents: agentsRouter, brain: brainRouter, projects: projectsRouter, taskBoard, teams: teamsRouter, workflows: workflowsRouter });
