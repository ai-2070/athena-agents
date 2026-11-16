// The Brain's own tools. It runs on an agent engine like any agent; these are the tools only it gets: building
// teams, hiring, handing out work, the Tasks board, routines, skills, MCP servers, models, the voxel world and its
// memory. Each takes one of the Brain's actions as its arguments ("do" says which) and applies it with the same
// checks as before (overseer.ts applyActions): an MCP server's settings only from what the user typed, GitHub
// installs only from links the user gave, a skill rewritten only once the Brain has read it whole.
// Kept light (no import of overseer.ts at load): tools.ts lists these, and overseer.ts imports tools.ts.
import { BRAIN_ID, brainAccess } from './brainmcp.ts';
import type { JSONSchema, ToolContext, ToolDef, ToolResult } from './tools.ts';
import type { BrainAccess, BrainDelegate, BrainDone, Project } from '../shared/types.ts';

export { BRAIN_ID, brainAccess };

/** What "new" means in a turn: the last team, agent, routine, skill, server and task it made, and the skills it
 *  last installed. Kept across the turn's tool calls, so one call can refer to what the one before made. */
export interface BrainRefs {
  team?: string | null;
  agent?: string | null;
  routine?: string | null;
  skill?: string | null;
  server?: string | null;
  task?: string;
  installed?: string[];
}

/** One turn of the Brain: what its tools need to know, and what they did (for the chat). */
export interface BrainTurn {
  project: Project;
  /** a private conversation (a gateway's, or a board task's own) */
  conversationId?: string;
  /** the user's own words in this conversation: MCP settings and GitHub links are checked against them */
  userWords: string;
  /** skills whose whole text the Brain has seen: only those can be rewritten */
  seenSkills: Set<string>;
  refs: BrainRefs;
  done: BrainDone[];
  delegate: BrainDelegate | null;
  /** what the user asked, handed on with a delegate (the follow-ups check the work against it) */
  objective: string;
  goal: boolean;
  attachments: string[];
  signal: AbortSignal;
  /** false once the turn is no longer wanted (stopped, a new conversation, a gateway gone quiet) */
  wanted?: () => boolean;
  /** MCP tools it used that can change things (named when the turn is stopped: they did happen) */
  used?: string[];
  /** GitHub installs in this turn (a few at most) */
  installs?: number;
  /** what this turn used of its limits: changes, MCP look-ups, characters of MCP results, model searches */
  changes?: number;
  lookups?: number;
  mcpText?: number;
  modelSearches?: number;
}

const turns = new Map<string, BrainTurn>();
export function beginBrainTurn(runId: string, turn: BrainTurn): void {
  turns.set(runId, turn);
}
export function endBrainTurn(runId: string): void {
  turns.delete(runId);
}
export const brainTurn = (runId: string | null | undefined): BrainTurn | undefined =>
  runId ? turns.get(runId) : undefined;

/** read_skill by the Brain: the skill counts as seen for the rest of its turn. */
export function sawSkill(runId: string | null | undefined, slug: string): void {
  brainTurn(runId)?.seenSkills.add(slug);
}

// Which actions each tool takes. Look-ups only read (and mcp_call asks for itself: brainmcp.ts).
const OPS = {
  team: ['create_team', 'add_members', 'remove_members', 'update_team', 'hire'],
  delegate: ['delegate'],
  stop_work: ['stop'],
  project: ['write_project_md', 'station_look', 'background'],
  board: ['board_add', 'board_update', 'board_remove', 'board_tag', 'board_comment', 'board_find'],
  tasks: ['TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList'],
  routine: ['create_routine', 'update_routine', 'run_routine', 'delete_routine'],
  skill: ['create_skill', 'update_skill', 'give_skill', 'take_skill', 'set_skills', 'install_skill', 'delete_skill'],
  mcp_servers: ['add_mcp', 'update_mcp', 'remove_mcp', 'give_mcp', 'take_mcp', 'set_mcp'],
  mcp_use: ['mcp_tools', 'mcp_call'],
  models: ['set_model', 'find_models'],
  world: ['build', 'world_env', 'world_light', 'world_effect', 'skin', 'animate', 'write_world_md', 'update_world_md'],
  memory: ['remember', 'write_memory'],
  project_overview: ['project_overview'],
} as const satisfies Record<string, readonly string[]>;
export type BrainToolName = keyof typeof OPS;
export const BRAIN_TOOL_NAMES = Object.keys(OPS) as BrainToolName[];
const LOOKUPS = new Set<string>([
  'board_find',
  'TaskGet',
  'TaskList',
  'find_models',
  'mcp_tools',
  'mcp_call',
  'project_overview',
]);
export const isLookup = (kind: string): boolean => LOOKUPS.has(kind);

/** The tool that takes an action (create_team → team). */
export function toolOf(kind: string): BrainToolName | undefined {
  return BRAIN_TOOL_NAMES.find((t) => (OPS[t] as readonly string[]).includes(kind));
}
/** When the Brain may only read, a tool is offered only if it has a look-up (its other actions are refused). */
export const brainToolOffered = (name: string, access: BrainAccess = brainAccess()): boolean =>
  access !== 'read' ||
  (OPS[name as BrainToolName] as readonly string[] | undefined)?.some((k) => LOOKUPS.has(k)) === true;

export const OVERVIEW_SECTIONS = [
  'files',
  'tasks',
  'board',
  'routines',
  'skills',
  'mcp',
  'activity',
  'world',
  'library',
] as const;
export type OverviewSection = (typeof OVERVIEW_SECTIONS)[number];

const ABOUT: Record<BrainToolName, string> = {
  team: 'Build and change teams, and hire agents: create_team, add_members, remove_members, update_team, hire.',
  delegate:
    "Hand work to a team or an agent with a clear brief: it goes out as your message at once (a team chat, or the agent's own chat), with the files the user attached.",
  stop_work: 'Stop the work going on now: an agent, a team, or everything running in this project.',
  project: "Write PROJECT.md (write_project_md), switch the Station's look (station_look), set its background.",
  board:
    "The user's Tasks board: board_add, board_update, board_remove, board_tag, board_comment, and board_find (only reads).",
  tasks: 'Saved task lists for work with several steps: TaskCreate, TaskUpdate, and TaskGet / TaskList (only read).',
  routine:
    'Routines (saved work run by hand or on a schedule): create_routine, update_routine, run_routine, delete_routine.',
  skill:
    'Skills: create_skill, update_skill, give_skill, take_skill, set_skills, install_skill (GitHub links the user gave), delete_skill. Open one with read_skill before rewriting it.',
  mcp_servers: 'MCP servers for agents and teams: add_mcp, update_mcp, remove_mcp, give_mcp, take_mcp, set_mcp.',
  mcp_use:
    "Use the tools of the MCP servers that are on yourself: mcp_tools lists a server's tools, mcp_call calls one.",
  models: "Agents' models: set_model, and find_models to look up a provider's model ids (only reads).",
  world:
    'The voxel world: build, world_env, world_light, world_effect, skin, animate, write_world_md, update_world_md.',
  memory: 'Your own MEMORY.md (or an agent\'s, with "to":"agent"): remember adds a note, write_memory rewrites it.',
  project_overview:
    "The parts of the project the summary with each message leaves out, one section at a time: files (folder tree, key files, Git), tasks, board, routines, skills, mcp (servers, ready-made ones, suggestions), activity, world, library (the Agent library's agents to hire).",
};

function params(name: BrainToolName): JSONSchema {
  if (name === 'project_overview')
    return {
      type: 'object',
      properties: { section: { type: 'string', enum: [...OVERVIEW_SECTIONS], description: 'Which part to show' } },
      required: ['section'],
    };
  const ops = OPS[name];
  return {
    type: 'object',
    properties: {
      do: {
        type: 'string',
        enum: [...ops],
        description:
          ops.length === 1
            ? `Always "${ops[0]}"`
            : 'Which action: its other arguments are as in the reference in your instructions',
      },
    },
    required: ops.length === 1 ? [] : ['do'],
    additionalProperties: true,
  };
}

const refuse = (text: string): ToolResult => ({ text, isError: true });

export function brainTools(): ToolDef[] {
  return BRAIN_TOOL_NAMES.map((name): ToolDef => ({
    name,
    group: 'brain',
    // look-ups only read; anything else changes the project (Ask first: it waits for the user)
    risk: (args) => {
      const kind = name === 'project_overview' ? 'project_overview' : String(args.do ?? OPS[name][0]);
      return LOOKUPS.has(kind) ? 'none' : 'high';
    },
    description: ABOUT[name],
    parameters: params(name),
    run: async (args, ctx: ToolContext) => {
      const turn = brainTurn(ctx.runId);
      if (ctx.agent.id !== BRAIN_ID || !turn) return refuse("Only the Brain's own turns can use this.");
      const ops = OPS[name] as readonly string[];
      const kind =
        name === 'project_overview' ? 'project_overview' : String(args.do ?? (ops.length === 1 ? ops[0] : ''));
      if (!ops.includes(kind)) return refuse(`${name} takes "do": ${ops.join(', ')}.`);
      if (!LOOKUPS.has(kind) && brainAccess() === 'read')
        return refuse(
          'The Brain may only read and look things up (Settings › What the Brain may do). Tell the user what you would change.',
        );
      if (turn.signal.aborted || turn.wanted?.() === false)
        return refuse('The user stopped you or moved on to another conversation: change nothing more, just answer.');
      const { brainToolCall } = await import('./overseer.ts');
      return brainToolCall(kind, args, turn, ctx);
    },
  }));
}
