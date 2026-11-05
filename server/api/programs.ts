// Programs on this PC and ComfyUI (shared/api/programs.ts). ComfyUI's functions refuse in plain words (no workflow by
// that name, ComfyUI not running); those are 400s here.
import { implement } from '@orpc/server';
import { comfyui as comfyContract, programs as programsContract } from '../../shared/api/programs.ts';
import { log } from '../store.ts';
import * as programs from '../programs.ts';
import * as comfy from '../comfyui.ts';
import { openWithShell } from '../util.ts';
import { refusing } from './refuse.ts';

const p = implement(programsContract);
const c = implement(comfyContract);

export const programsRouter = p.router({
  list: p.list.handler(({ input }) => programs.discoverPrograms(!!input.force)),
  all: p.all.handler(() => programs.startMenuApps(true)),
  launch: p.launch.handler(async ({ input }) => {
    const message = await refusing(() => programs.launchProgram(input.program, { file: input.file }));
    log('program', message);
    return { message };
  }),
  open: p.open.handler(({ input }) => (openWithShell(input.target), { ok: true as const })),
});

export const comfyRouter = c.router({
  status: c.status.handler(async () => ({ status: await comfy.queueStatus(), workflows: comfy.listWorkflows().map(({ name, dir }) => ({ name, dir })) })),
  describe: c.describe.handler(({ input }) => refusing(() => comfy.describeWorkflow(input.workflow))),
  run: c.run.handler(({ input }) => refusing(() => comfy.runWorkflow({ workflow: input.workflow, prompt: input.prompt || undefined, negative: input.negative || undefined, inputs: input.inputs || {} }))),
  start: c.start.handler(async () => ({ message: await refusing(() => comfy.startComfy()) })),
  saveWorkflow: c.saveWorkflow.handler(({ input }) => ({ file: refusing(() => comfy.saveApiWorkflow(input.name, input.json)) })),
});
