// Programs on this PC and ComfyUI (server/api/programs.ts): the programs the dashboard knows and the Start menu's,
// starting one or opening a file or link, and ComfyUI's queue, its saved workflows and running one.
import { oc, type } from '@orpc/contract';
import { z } from 'zod';
import type { ComfyQueueStatus, Program, PromptNodes, RunWorkflowDone, StartMenuApp } from '../types.ts';

export const programs = {
  /** The programs the dashboard knows, found on this PC (force=1: look again now). */
  list: oc
    .route({ method: 'GET', path: '/programs' })
    .input(z.object({ force: z.string().optional() }))
    .output(type<Program[]>()),
  /** Everything in the Start menu. */
  all: oc.route({ method: 'GET', path: '/programs/all' }).output(type<StartMenuApp[]>()),
  /** Starts one (by its id or name), with a file to open in it. message: how it went. */
  launch: oc
    .route({ method: 'POST', path: '/programs/launch' })
    .input(
      z.object({
        program: z.string({ error: 'Pick a program.' }),
        file: z.string({ error: 'file must be a path.' }).optional(),
      }),
    )
    .output(type<{ message: string }>()),
  /** Opens a file, folder or link the way this PC opens it. */
  open: oc
    .route({ method: 'POST', path: '/programs/open' })
    .input(z.object({ target: z.string({ error: 'Say what to open.' }) }))
    .output(type<{ ok: true }>()),
};

export const comfyui = {
  /** Whether it is running (its queue and graphics cards), and the saved workflows. */
  status: oc
    .route({ method: 'GET', path: '/comfyui' })
    .output(type<{ status: ComfyQueueStatus; workflows: { name: string; dir: string }[] }>()),
  /** A workflow's prompt nodes and the inputs that can be set (its first one unless named). */
  describe: oc
    .route({ method: 'GET', path: '/comfyui/describe' })
    .input(z.object({ workflow: z.string().optional() }))
    .output(
      type<{
        workflow: string;
        file: string;
        prompts: PromptNodes;
        editable: Record<string, { node: string; value: unknown }>;
        warnings: string[];
      }>(),
    ),
  /** Runs a workflow with a prompt (and inputs by "nodeId.input") and waits for what it makes. */
  run: oc
    .route({ method: 'POST', path: '/comfyui/run' })
    .input(
      z.object({
        workflow: z.string({ error: 'Pick a workflow.' }),
        prompt: z.string({ error: 'The prompt must be text.' }).optional(),
        negative: z.string({ error: 'The negative prompt must be text.' }).optional(),
        inputs: z.record(z.string(), z.unknown(), { error: 'inputs must be names and values.' }).optional(),
      }),
    )
    .output(type<RunWorkflowDone>()),
  start: oc.route({ method: 'POST', path: '/comfyui/start' }).output(type<{ message: string }>()),
  /** Saves a workflow in API format (json: ComfyUI's "Export (API)"). */
  saveWorkflow: oc
    .route({ method: 'POST', path: '/comfyui/workflows' })
    .input(z.object({ name: z.string({ error: 'Name the workflow.' }), json: z.unknown() }))
    .output(type<{ file: string }>()),
};
