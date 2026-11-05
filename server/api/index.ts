// Every area's procedures, implementing shared/api/. server/rpc.ts answers them.
import { implement } from '@orpc/server';
import { contract } from '../../shared/api/index.ts';
import { agentsRouter } from './agents.ts';
import { brainRouter } from './brain.ts';
import { projectsRouter } from './projects.ts';
import { taskBoard } from './taskboard.ts';
import { teamsRouter } from './teams.ts';
import { workflowsRouter } from './workflows.ts';
import { approvalsRouter, questionsRouter } from './needs.ts';
import { routinesRouter } from './routines.ts';
import { runsRouter } from './runs.ts';
import { tasksRouter } from './tasks.ts';
import { skillsRouter } from './skills.ts';
import { versionsRouter } from './versions.ts';
import { libraryRouter, presetsRouter } from './library.ts';
import { statusRouter } from './status.ts';
import { accountsRouter, settingsRouter } from './settings.ts';
import { enginesRouter, mcpRouter } from './mcp.ts';
import { comfyRouter, programsRouter } from './programs.ts';
import { assistRouter } from './assist.ts';
import { worldRouter, worldsRouter } from './world.ts';
import { gatewaysRouter } from './gateways.ts';
import { outboxRouter } from './outbox.ts';
import { artifactsRouter, backupsRouter, filesRouter, layoutRouter, memoryRouter, terminalsRouter, uploadsRouter } from './files.ts';

export const apiRouter = implement(contract).router({ agents: agentsRouter, brain: brainRouter, projects: projectsRouter, taskBoard, teams: teamsRouter, workflows: workflowsRouter, questions: questionsRouter, approvals: approvalsRouter, tasks: tasksRouter, routines: routinesRouter, runs: runsRouter, skills: skillsRouter, versions: versionsRouter, library: libraryRouter, presets: presetsRouter, status: statusRouter, settings: settingsRouter, accounts: accountsRouter, mcp: mcpRouter, engines: enginesRouter, programs: programsRouter, comfyui: comfyRouter, assist: assistRouter, files: filesRouter, uploads: uploadsRouter, memory: memoryRouter, artifacts: artifactsRouter, backups: backupsRouter, layout: layoutRouter, terminals: terminalsRouter, world: worldRouter, worlds: worldsRouter, gateways: gatewaysRouter, outbox: outboxRouter });
