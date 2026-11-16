// Built-in tools. Every agent gets the groups switched on in its settings.
// Risk decides when you're asked first: autonomy "ask" checks low + high, "auto" checks high only, "full" never asks.
import fs from 'node:fs';
import path from 'node:path';
import {
  HOME,
  ROOT,
  IS_WIN,
  dataPath,
  ensureDir,
  run,
  truncate,
  truncateMiddle,
  tmpFile,
  openWithShell,
  launchDetached,
  exists,
  which,
  insideRoots,
  asOpened,
  runnable,
  commandShell,
  uid,
} from './util.ts';
import * as assetLib from './assets.ts';
import type { AssetSource, AssetKind } from './assets.ts';
import {
  mayaScript,
  houdiniScript,
  sibling,
  sbsrenderArgs,
  openscadArgs,
  prusaSlicerArgs,
  runsAfterSlicing,
  nvttArgs,
  handbrakeArgs,
  GPU_FIELDS,
  formatGpus,
} from './dcc.ts';
import { agents as agentStore, chats, getSettings, emit, log, rememberAlwaysAllow } from './store.ts';
import { startHandoff, awaitHandoff, awaitHandoffs, listHandoffs, DEFAULT_WAIT_S, MAX_WAIT_S } from './handoffs.ts';

/** Hermes' own MCP tool timeout is 300 s: await_agent answers it well within that. */
const HERMES_WAIT_S = 240;
import { requestApproval, withdrawApprovals } from './approvals.ts';
import type { ApprovalDecision, ApprovalRequest } from './approvals.ts';
import { readPage, pagePart, PAGE_CHARS, PAGE_MAX_CHARS } from './webread.ts';
import * as files from './filetools.ts';
import { readDocumentPart } from './documents.ts';
import { accountOf } from './mcp.ts';
import { knownPrograms, launchProgram, launchTarget, programExe, startMenuApps } from './programs.ts';
import * as comfy from './comfyui.ts';
import { MODEL_MAX_BYTES, imageType } from './toolimages.ts';
import * as social from './social.ts';
import * as reddit from './reddit.ts';
import * as kb from './knowledge.ts';
import * as memory from './memory.ts';
import { withActor } from './versions.ts';
import { recordAsked, recordClipped, recordToolCall } from './toolstats.ts';
import { ensureBrain } from './projects.ts';
import { safeUploadsRoot } from './uploads.ts';
import * as skills from './skills.ts';
import { findAgent } from '../shared/agentref.ts';
import * as voxel from './voxel/tools.ts';
import { taskTools } from './tasktools.ts';
import { goalTool } from './goaltool.ts';
import { isBoardConversation, isGatewayConversation } from './private-conversations.ts';
import type { Agent, ToolGroup, ToolListing } from '../shared/types.ts';

/** none: never asks. low: asks when autonomy is "ask". high: asks unless autonomy is "full". */
export type Risk = 'none' | 'low' | 'high';

/** The JSON Schema of a tool's arguments (what the model sees). */
export interface JSONSchema {
  type?: string;
  description?: string;
  properties?: Record<string, JSONSchema>;
  required?: string[];
  items?: JSONSchema;
  [k: string]: unknown;
}

/** Arguments as the model sent them (parsed JSON, not checked against the schema). */
export type ToolArgs = Record<string, unknown>;

export interface ToolResult {
  text: string;
  isError?: boolean;
  images?: string[];
  /** Set by gate() when the user said no. */
  denied?: boolean;
}

/** The part of an agent the tools use. Dashboard agents fit; so do stand-ins (workflows, external MCP clients). */
export type ToolAgent = Pick<Agent, 'id' | 'name'> &
  Partial<Pick<Agent, 'toolGroups' | 'autonomy' | 'alwaysAllow' | 'workspace' | 'knowledge' | 'engine'>>;

/** Which run a tool call belongs to: approvals, the Stop button and delegation depth come from here. */
export interface ToolRunInfo {
  runId?: string | null;
  depth?: number;
  signal?: AbortSignal;
  /** Shows a status line while a slow tool works. */
  progress?: (text: string) => void;
  /** The MCP server an API-model agent's tool call goes to: its approval names the account. */
  mcpServer?: string;
  /** What "Always allow" remembers for this call when it isn't the tool's name (an MCP tool: mcpGrant()). */
  grantName?: string;
  /** Stable, server-issued identity for one durable tool operation. */
  operationId?: string;
  /** The input originally shown for an operation whose approval edited the arguments. */
  approvalArgs?: Record<string, unknown>;
  /** A durable executor only reads saved consent here; it never waits for a new decision. */
  approvalDecision?: (request: ApprovalRequest) => Promise<ApprovalDecision>;
  approvalScope?: Record<string, unknown>;
}

export interface ToolContext extends ToolRunInfo {
  agent: ToolAgent;
}

// Declared as methods so each tool can name the arguments it expects (the model's JSON is taken as that shape).
type RiskOf = { bivarianceHack(args: ToolArgs): Risk }['bivarianceHack'];

/** What a tool list depends on besides the agent. */
export interface ToolScope {
  /** The run's private conversation: "board-<task id>" for a Tasks board task, a gateway's conversation otherwise. */
  conversationId?: string | null;
  /** The agent's engine: engines with their own file and shell tools don't get the dashboard's too. */
  engine?: string;
}

/** An earlier name of a tool (saved workflow steps still use it); args turns its arguments into the tool's. */
export interface ToolAlias {
  name: string;
  args?: (args: ToolArgs) => ToolArgs;
}

export interface ToolDef {
  name: string;
  group: string;
  risk: Risk | RiskOf;
  description: string;
  parameters: JSONSchema;
  run(args: ToolArgs, ctx: ToolContext): Promise<ToolResult>;
  /** Listed only where it can work. A call is still checked by the tool itself, wherever it comes from. */
  when?: (scope: ToolScope) => boolean;
  /** Earlier names: accepted when called, never shown to the model. */
  aliases?: ToolAlias[];
}

/** What the engines and the MCP bridge tell the model about a tool. */
export type ToolSpec = Pick<ToolDef, 'name' | 'description' | 'parameters'>;

export const TOOL_GROUPS: ToolGroup[] = [
  { id: 'programs', label: 'Programs', description: 'See what is installed and start programs, files and folders.' },
  { id: 'browser', label: 'Browser', description: 'Open pages in your browser and read web pages.' },
  { id: 'comfyui', label: 'ComfyUI', description: 'Run your ComfyUI workflows and get the images back.' },
  { id: 'blender', label: 'Blender', description: 'Run Blender Python (modeling, rendering, exports).' },
  { id: 'adobe', label: 'Adobe', description: 'Photoshop and After Effects scripts, open Premiere projects.' },
  { id: 'maya', label: 'Maya', description: 'Run Maya Python (scenes, rigging, animation, renders, exports).' },
  {
    id: 'houdini',
    label: 'Houdini',
    description: 'Run Houdini Python (node networks, simulations, renders, exports).',
  },
  {
    id: 'substance',
    label: 'Substance 3D',
    description: 'Render Substance materials to texture maps, open Painter, Designer and Sampler.',
  },
  {
    id: 'cad',
    label: 'CAD and 3D printing',
    description: 'Turn OpenSCAD models into STL and other files, slice models into G-code.',
  },
  { id: 'nvidia', label: 'NVIDIA', description: 'See how busy the graphics cards are, convert textures to DDS.' },
  {
    id: 'assets',
    label: 'Free asset libraries',
    description: 'Search and download free CC0 HDRIs, PBR textures and models from Poly Haven and ambientCG.',
  },
  {
    id: 'media',
    label: 'FFmpeg, HandBrake and ImageMagick',
    description:
      'Convert, cut and inspect audio and video, shrink videos with HandBrake presets, edit images in bulk with ImageMagick.',
  },
  {
    id: 'social',
    label: 'Social',
    description:
      'Draft X and Reddit posts (they wait in the Outbox unless auto-post is on), read posts, mentions and subreddits, Telegram, Discord.',
  },
  { id: 'agents', label: 'Delegate', description: 'Ask other agents and Hermes profiles for help.' },
  {
    id: 'files',
    label: 'Files',
    description:
      'Read, change and search files in its workspace and folders you allow. For API models (Eve): Claude Code, Codex and the other coding engines use their own file tools.',
  },
  { id: 'orca', label: 'Orca', description: 'Run Orca CLI commands (worktrees, terminals, its browser).' },
  {
    id: 'world',
    label: 'Voxel world',
    description:
      'Build the voxel world around the Station (places, props, prefabs to place many times) and keep its WORLD.md up to date.',
  },
  {
    id: 'shell',
    label: 'Shell',
    description:
      'Run any command (PowerShell on Windows, bash on Mac and Linux). Powerful: you are asked each time unless autonomy is Full. For API models (Eve): the coding engines use their own.',
  },
];

export function workspaceOf(agent: { workspace?: string }): string {
  // By default every agent works in the project's Brain folder.
  return ensureDir(agent.workspace && path.isAbsolute(agent.workspace) ? agent.workspace : ensureBrain());
}

// Reading: workspace, outputs, knowledge, allowed folders. Writing: not linked knowledge folders.
function allowedRoots(agent: ToolAgent, write = false): string[] {
  const s = getSettings();
  // attached files (the Brain folder's uploads/) can be read even by an agent with its own workspace
  // (not when uploads/ is a link out of the Brain folder)
  const uploads = write ? null : safeUploadsRoot();
  return [
    workspaceOf(agent),
    dataPath('outputs'),
    ...(write ? [] : kb.knowledgeRoots(agent)),
    ...(uploads ? [uploads] : []),
    ...(s.allowedFolders || []),
  ];
}

// read_document: what read_file may read, for an agent that reads files (the Files tools, or an engine's own); for
// one that doesn't, only what it was handed: its knowledge, and the files attached to messages in its own chats
// (not everything attached anywhere in the project). A private conversation (a gateway's, a board task's) is handed
// only its own attachments, and ordinary chats none of theirs.
function documentRoots(agent: ToolAgent, conversationId: string | null): string[] {
  // (a stand-in, like a workflow, may carry no engine: its saved agent's counts)
  if (hasOwnFileTools(agent.engine ?? agentStore.get(agent.id)?.engine) || (agent.toolGroups || []).includes('files'))
    return allowedRoots(agent);
  return [...kb.knowledgeRoots(agent), ...handedFiles(agent, conversationId)];
}

// The files and folders attached to messages in an agent's chats of one conversation in this project, while they
// are still in uploads/.
function handedFiles(agent: ToolAgent, conversationId: string | null): string[] {
  const uploads = safeUploadsRoot();
  if (!uploads) return [];
  let all: string[];
  try {
    all = chats
      .all(agent.id)
      .filter((chat) => (chat.conversationId || null) === conversationId)
      .flatMap((chat) =>
        chat.items.flatMap((item) => ((item.type === 'user' || item.type === 'steer') && item.attachments) || []),
      );
  } catch {
    return [];
  }
  return [...new Set(all)].filter((p) => insideRoots(p, [uploads]));
}

// abs: the path as asked (for messages). real: where it really is, links followed; use it for the file
// operation. ok only when the real location is inside an allowed folder, so a link in the workspace
// can't reach the rest of the disk.
function resolveInside(
  agent: ToolAgent,
  p: string | undefined,
  { write = false } = {},
): { abs: string; real: string; ok: boolean } {
  const abs = path.resolve(workspaceOf(agent), String(p || '.'));
  const real = insideRoots(abs, allowedRoots(agent, write));
  return { abs, real: real || abs, ok: !!real };
}

// Programs that run whatever they are given: by name, whatever version or windowless variant it is
// (python3.12, pythonw.exe, node22, javaw, perl5.36).
const INTERPRETER_NAMES =
  /^(cmd|command|powershell|pwsh|wscript|cscript|mshta|rundll32|regsvr32|python|py|node|nodejs|bun|bunx|npx|deno|tsx|ts-node|ruby|perl|php|php-cgi|java|jshell|osascript|bash|sh|zsh|fish|ksh|dash|csh|tcsh|wsl|msiexec|reg|schtasks|certutil|bitsadmin|curl|wget|lua|luajit|rscript|julia|tclsh|wish|dotnet|electron|forfiles|wmic|msbuild|installutil|regasm|regsvcs|cmstp)$/;
const INTERPRETERS = {
  test(name: string): boolean {
    const bare = name
      .trim()
      .toLowerCase()
      .replace(/\.(exe|com|bat|cmd)$/, '');
    const plain = bare.replace(/[-_.]?\d+([._]\d+)*w?$/, (v) => (v.endsWith('w') ? 'w' : ''));
    return [bare, plain, plain.replace(/w$/, '')].some((n) => INTERPRETER_NAMES.test(n));
  },
};

// board_tags: deleting a tag deletes; renaming one changes how every task with it reads
const boardTagsRiskOf = (args: ToolArgs): Risk =>
  args.action === 'delete' ? 'high' : args.action === 'edit' ? 'low' : 'none';

/** The chat a tool call runs in (to tell which team it is for). */
const chatOf = async (ctx: ToolContext): Promise<string | null> =>
  (await import('./engines/index.ts')).runInfo(ctx.runId)?.chatId ?? null;
const str = (description: string): JSONSchema => ({ type: 'string', description });
// X bills each read: a model asking for "all of them" gets a page
const X_LIMIT: JSONSchema = { type: 'number', description: 'How many, 5-50 (default 10)' };
const xLimit = (n: unknown): number => Math.min(Math.max(Math.round(Number(n) || 10), 5), 50);
const obj = (properties: Record<string, JSONSchema>, required: string[] = []): JSONSchema => ({
  type: 'object',
  properties,
  required,
});

const TOOLS: ToolDef[] = [
  ...taskTools(),
  goalTool(),
  // ---------- skills (every agent; the list it has is in its instructions) ----------
  {
    name: 'read_skill',
    group: 'core',
    risk: 'none',
    description:
      'Open one of your skills (listed under "Your skills" in your instructions) and get its full instructions. Pass file to read one of the extra files that come with the skill (long ones in parts, with from), or find to search the skill\'s files (like grep). Any other name lists the library\'s skills matching its words.',
    parameters: obj(
      {
        name: str('The skill id as listed (or its name)'),
        file: str('Optional: a file that belongs to the skill, e.g. references/commands.md'),
        find: str(
          "Optional: search for lines that match (words or a regular expression, any case), in file or else in all the skill's files. Use it for long reference files instead of reading them whole.",
        ),
        from: {
          type: 'number',
          description: 'Optional: with file, the line to start reading from (for a file too long to read in one go)',
        },
      },
      ['name'],
    ),
    run: async ({ name, file, find, from }: { name: string; file?: string; find?: string; from?: number }) => {
      const s = skills.findSkill(name);
      if (!s) {
        // the words of an unknown name search the whole library: how an agent finds a skill it wasn't given
        // (not an error when some match: it is also how agents search the library)
        const like = skills.searchLibrary(String(name || ''), 12);
        const listed = like.map((x) => `- ${x.slug}: ${x.name}. ${x.description}`).join('\n');
        return {
          text: `There is no skill called "${name}".${like.length ? ` Skills in the library that match its words (open one with read_skill and its id):\n${listed}` : ' No skill in the library matches its words either.'}`,
          isError: !like.length,
        };
      }
      if (find) return { text: `# ${s.name}: lines matching "${find}"\n\n${skills.searchSkill(s.slug, find, file)}` };
      if (file) return { text: `# ${s.name} / ${file}\n\n${skills.readSkillFile(s.slug, file, from)}` };
      // Hermes skills name their folder ${HERMES_SKILL_DIR}, or write out where Hermes keeps it
      // (~/.hermes/skills/<category>/<id>): point both at this one, so agents with a shell can use the files directly
      const dir = skills.skillDir(s.slug).split(path.sep).join('/');
      const inHermes = new RegExp(
        `(?:~|\\$HOME|\\$\\{HOME\\})/\\.hermes/skills/(?:[\\w.-]+/)*?${s.slug.replaceAll('.', '\\.')}(?![\\w.-])`,
        'g',
      );
      const body = s.body.replaceAll('${HERMES_SKILL_DIR}', dir).replace(inHermes, dir);
      // (the folder is the library's, shared by every project: output written there would travel with every project
      // that uses the skill, and count as a change that stops the dashboard updating it)
      const files = s.files.length
        ? `\n\n---\nFiles with this skill, in its folder ${dir} (read with read_skill name="${s.slug}" file="...", or search them with find="..."; with a shell, run its scripts from that folder): ${s.files.map((f) => f.path).join(', ')}\nEvery project shares that folder, so keep what its scripts make (pages, pictures, builds, downloads) out of it: give them an output path in the project's folder, and don't run one there that can only write next to itself.`
        : '';
      return { text: `# Skill: ${s.name}\n${s.description}\n\n${body}${files}` };
    },
  },
  {
    name: 'save_skill',
    group: 'core',
    // a write the user can undo: the old version stays in the skill's History
    risk: 'low',
    description:
      'Save a skill to the library: new (then given to you) or an update (skill: its id). body is all of SKILL.md below the name and description, so read_skill it first. files adds or replaces text files in references/, scripts/ or templates/; remove deletes some. History keeps the old one.',
    parameters: obj(
      {
        skill: str('Optional: the id to update'),
        name: str('The kind of work, e.g. "Postgres replication"'),
        description: str('When to use it, then what it gives; 300 characters at most: agents open it by this alone'),
        body: str('Markdown'),
        files: {
          type: 'array',
          items: obj({ path: str('e.g. references/notes.md'), text: str('The whole file') }, ['path', 'text']),
        },
        remove: { type: 'array', items: { type: 'string' }, description: 'Optional: file paths to delete' },
      },
      ['name', 'description', 'body'],
    ),
    run: async (
      {
        skill,
        name,
        description,
        body,
        files,
        remove,
      }: {
        skill?: string;
        name: string;
        description: string;
        body: string;
        files?: { path: string; text: string }[];
        remove?: string[];
      },
      ctx,
    ) => {
      const saved = skills.saveSkillWithFiles(
        { slug: skill ? skills.findSkill(skill)?.slug || String(skill) : undefined, name, description, body },
        (files || []).map((f) => ({ path: String(f.path || ''), text: String(f.text ?? '') })),
        (remove || []).map(String),
        ctx.agent.name,
      );
      // the agent that learned it can use it from now on
      const mine = agentStore.get(ctx.agent.id);
      const given = !skill && mine && !(mine.skills || []).includes(saved.slug);
      if (given) agentStore.save({ ...mine, skills: [...(mine.skills || []), saved.slug] });
      log('skill', `${ctx.agent.name} ${skill ? 'updated' : 'saved'} the skill "${saved.name}"`, {
        agentId: ctx.agent.id,
      });
      const n = saved.files.length;
      return {
        text: `${skill ? 'Updated' : 'Saved'} the skill "${saved.name}" (id: ${saved.slug})${n ? ` with ${n} file${n === 1 ? '' : 's'}` : ''}.${given ? ' It is yours now; the user can give it to others on the Skills page.' : ''}`,
      };
    },
  },
  // ---------- chat history (every agent; what a compaction left out) ----------
  {
    name: 'search_conversations',
    group: 'core',
    risk: 'none',
    description:
      'Search saved original messages and tool results across your own past chats and the shared conversations of teams you belong to, in this project only. All search words must match the same entry, ignoring case. Returns message references and excerpts; use read_conversation for the original text. Cleared or deleted chats are not searched.',
    parameters: obj(
      {
        query: str('Words to find'),
        scope: {
          type: 'string',
          enum: ['own', 'team', 'all'],
          description: 'Default all: your own chats and teams you belong to',
        },
        teamId: str('Optional: limit team searches to this team id'),
        offset: { type: 'number', description: 'Next result offset from a previous page' },
        limit: { type: 'number', description: 'Results per page, up to 20; default 10' },
      },
      ['query'],
    ),
    run: async (args, ctx) => {
      const { searchConversations } = await import('./conversations.ts');
      const { runInfo } = await import('./engines/index.ts');
      const { activeProject, withProject } = await import('./store.ts');
      const run = runInfo(ctx.runId);
      if (ctx.runId && (!run || run.agentId !== ctx.agent.id))
        return { text: 'That run is not available to you.', isError: true };
      return withProject(run?.project || activeProject(), () => ({
        text: JSON.stringify(
          searchConversations(
            ctx.agent.id,
            args as unknown as import('../shared/types.ts').ConversationSearch,
            run?.conversationId,
          ),
        ),
      }));
    },
  },
  {
    name: 'read_conversation',
    group: 'core',
    risk: 'none',
    description:
      'Read an original message found by search_conversations, including text left out by compaction. Pass its source, conversationId and messageId. A long message has explicit character pages: keep reading with nextOffset until it is null. Only your own chats and teams you belong to in this project are available.',
    parameters: obj(
      {
        source: { type: 'string', enum: ['own', 'team'] },
        conversationId: str('Conversation id from a search hit'),
        messageId: str('Message id from a search hit, or a team message reference'),
        offset: { type: 'number', description: 'Character offset, default 0' },
        limit: { type: 'number', description: 'Characters to read, default 8000, maximum 16000' },
      },
      ['source', 'conversationId', 'messageId'],
    ),
    run: async (args, ctx) => {
      const { readConversation } = await import('./conversations.ts');
      const { runInfo } = await import('./engines/index.ts');
      const { activeProject, withProject } = await import('./store.ts');
      const run = runInfo(ctx.runId);
      if (ctx.runId && (!run || run.agentId !== ctx.agent.id))
        return { text: 'That run is not available to you.', isError: true };
      return withProject(run?.project || activeProject(), () => ({
        text: JSON.stringify(
          readConversation(
            ctx.agent.id,
            args as unknown as import('../shared/types.ts').ConversationRead,
            run?.conversationId,
          ),
        ),
      }));
    },
  },
  {
    name: 'save_artifact',
    group: 'core',
    risk: 'none',
    description:
      'Hand in a finished result that is not an outgoing post or email: a written answer, a file or a folder (a render, a report, a cut video). It appears on the Artifacts page with who made it, which team it was for and when. Give either path (full path of a file or folder inside the project) or text (the result, in Markdown). Posts and emails go to the Outbox instead.',
    parameters: obj(
      {
        title: str('Short name for the result'),
        path: str('Full path of the file or folder'),
        text: str('The result itself, when it is text'),
        note: str('One line: what it is or how to use it'),
      },
      ['title'],
    ),
    run: async (
      { title, path: target, text, note }: { title: string; path?: string; text?: string; note?: string },
      ctx,
    ) => {
      const { addArtifact } = await import('./artifacts.ts');
      const a = addArtifact({ title, path: target, text, note, agentId: ctx.agent.id, chatId: await chatOf(ctx) });
      return { text: `Saved to Artifacts${a.teamName ? ` (team ${a.teamName})` : ''}: ${a.title}.` };
    },
  },
  {
    name: 'prepare_gateway_files',
    group: 'core',
    risk: 'none',
    when: (s) => isGatewayConversation(s.conversationId),
    description:
      'Inspect specific finished files for this active gateway assignment. Returns paths, names, sizes and SHA-256 hashes without sending them. Only your own workspace and safe project uploads are eligible. Use send_gateway_files with the returned paths and hashes to request delivery; ordinary artifacts and tool images are not sent automatically.',
    parameters: obj(
      { paths: { type: 'array', items: str('Absolute path of a finished file'), minItems: 1, maxItems: 10 } },
      ['paths'],
    ),
    run: async (args, ctx) => {
      const { prepareGatewayFiles } = await import('./gateways/deliverables.ts');
      return { text: JSON.stringify(await prepareGatewayFiles(ctx.runId, ctx.agent.id, args)) };
    },
  },
  {
    name: 'send_gateway_files',
    group: 'core',
    risk: 'high',
    when: (s) => isGatewayConversation(s.conversationId),
    description:
      'Request delivery of explicitly chosen finished files to the sender of this active gateway assignment. Pass the paths and SHA-256 hashes returned by prepare_gateway_files. Uses the normal approval policy, refuses changed bytes, and queues files after the final answer. The destination cannot be changed. One immutable selection per assignment; the result confirms selection, not remote delivery. Never retry an uncertain delivery with another tool call; review it in Athena.',
    parameters: obj(
      {
        files: {
          type: 'array',
          minItems: 1,
          maxItems: 10,
          items: obj(
            {
              path: str('Absolute path returned by prepare_gateway_files'),
              sha256: str('SHA-256 returned by prepare_gateway_files'),
            },
            ['path', 'sha256'],
          ),
        },
      },
      ['files'],
    ),
    run: async (args, ctx) => {
      const { sendGatewayFiles } = await import('./gateways/deliverables.ts');
      const count = await sendGatewayFiles(ctx.runId, ctx.agent.id, args);
      return {
        text: `Selected ${count} file${count === 1 ? '' : 's'} for this gateway assignment. Delivery waits for the final answer; check its receipts in Athena.`,
      };
    },
  },
  // ---------- a Tasks board task (only in the task's own conversation) ----------
  // Risk none: nothing leaves the dashboard, and files pass the same checks as gateway files before they are copied.
  {
    name: 'board_task',
    group: 'core',
    risk: 'none',
    when: (s) => isBoardConversation(s.conversationId),
    description:
      'Only when you work on a Tasks board task: read it again, with its description, the latest comments and the names of its files.',
    parameters: obj({}),
    run: async (_args, ctx) => {
      const { readWorkerTask } = await import('./boardwork.ts');
      return { text: readWorkerTask(ctx.runId, ctx.agent.id) };
    },
  },
  {
    name: 'board_reply',
    group: 'core',
    risk: 'none',
    when: (s) => isBoardConversation(s.conversationId),
    description:
      "Only when you work on a Tasks board task: comment on it (Markdown), attach finished files by their full paths (your workspace or the project uploads), and move it to in_review when it is done or to blocked with a reason when you can't finish it. Never to done: the user does that.",
    parameters: obj({
      text: str('Your comment: what you did, found or made (Markdown)'),
      files: { type: 'array', items: str('Full path of a finished file') },
      status: {
        type: 'string',
        enum: ['in_review', 'blocked'],
        description: "in_review when the task is done; blocked when it can't be finished",
      },
      reason: str('Why it is blocked (with status blocked)'),
      addTags: { type: 'array', items: { type: 'string' }, description: 'Tags to put on it' },
      removeTags: { type: 'array', items: { type: 'string' }, description: 'Tags to take off' },
    }),
    run: async (args, ctx) => {
      const { workerReply } = await import('./boardwork.ts');
      return { text: await workerReply(ctx.runId, ctx.agent.id, args) };
    },
  },
  // ---------- tags on the Tasks board (every agent, its run's project; not in gateway conversations) ----------
  // Risk none to list, find, make tags and tag tasks (nothing leaves the dashboard, easy to undo); low to rename or
  // re-emoji a tag (every task with it changes); high to delete one (it comes off every task).
  {
    name: 'board_tags',
    group: 'core',
    risk: (args) => boardTagsRiskOf(args),
    when: (s) => !isGatewayConversation(s.conversationId),
    description:
      "Tags on the project's Tasks board (name + optional emoji, e.g. \"🐛 Bug\"; case and emoji don't matter when naming one). list: tags and counts. find: tasks with tags (match any|all, untagged, status open|all|one, limit). tag: set a task's tags (task #12; tags = whole list, or add/remove). create (name, emoji), edit (name, rename, emoji), delete (name). Reuse existing tags; new names in tag make one.",
    parameters: obj(
      {
        action: { type: 'string', enum: ['list', 'find', 'tag', 'create', 'edit', 'delete'] },
        name: str('A tag'),
        emoji: str('One emoji ("" for none)'),
        rename: str('New name'),
        task: str('#12, id or exact title'),
        tags: { type: 'array', items: { type: 'string' } },
        add: { type: 'array', items: { type: 'string' } },
        remove: { type: 'array', items: { type: 'string' } },
        match: { type: 'string', enum: ['any', 'all'] },
        untagged: { type: 'boolean' },
        status: { type: 'string' },
        limit: { type: 'number' },
      },
      ['action'],
    ),
    run: async (args, ctx) => {
      const { agentBoardTags } = await import('./boardtagtools.ts');
      return { text: agentBoardTags(ctx.runId, ctx.agent.id, args) };
    },
  },
  // ---------- asking the user (every agent) ----------
  {
    name: 'ask_user',
    group: 'core',
    risk: 'none',
    description:
      'Ask the user when you need them: a decision or a choice between options, something only they know or can do (a login, a key, a file, an OK), or when you are stuck. It goes to their Outbox with your choices as buttons and a box for an answer in their own words, and you get their answer back. Use this instead of asking in your reply (they may not be watching this chat). Give 2-6 short choices whenever there are options; leave choices out only for an open question. One question per call. If no answer comes in time, end your turn and say you are waiting: the answer comes to you later as a new message.',
    parameters: obj(
      {
        question: str('The question, short and plain, e.g. "Which style should the logo use?"'),
        choices: {
          type: 'array',
          items: { type: 'string' },
          description:
            'The answers the user can click, each a few words, e.g. ["Flat", "3D", "Hand-drawn"]. They can always write their own answer instead.',
        },
        detail: str(
          'Optional: what they need to know to decide (what you tried, what each choice means). Markdown, a few lines.',
        ),
      },
      ['question'],
    ),
    run: async ({ question, choices, detail }: { question: string; choices?: unknown; detail?: string }, ctx) => {
      const q = await import('./questions.ts');
      // Hermes gives up on an MCP call after 5 minutes: wait less there, and the answer comes as a message
      const hermes = agentStore.get(ctx.agent.id)?.engine === 'hermes';
      const waitMs = hermes ? HERMES_WAIT_S * 1000 : q.WAIT_MS;
      const asker = agentStore.get(ctx.agent.id) ? ctx.agent.id : null;
      const { question: asked, outcome } = await q.ask(
        { question, detail, choices, agentId: asker, chatId: await chatOf(ctx), runId: ctx.runId || null },
        { signal: ctx.signal, waitMs },
      );
      if (outcome.kind === 'answer') return { text: q.answerResult(outcome) };
      if (outcome.kind === 'dismissed')
        return {
          text: "The user dismissed the question without answering. Don't ask it again: carry on with what you can, or say in your reply what is blocking you.",
        };
      if (outcome.kind === 'stopped') return { text: 'Stopped.', isError: true };
      const where = asked.teamId ? 'in the team chat' : asked.chatId ? 'in this chat' : null;
      return {
        text: `No answer yet (waited ${Math.round(waitMs / 60_000)} minutes). The question stays in the user's Outbox${where ? `, and their answer will come to you as a new message ${where}` : ''}. End your turn now: say in one line that you are waiting for their answer, and don't guess it.`,
      };
    },
  },
  // ---------- asking for tools (every agent) ----------
  // Asking changes nothing by itself: the Brain or the user decides (see the approval inside), so no gate before it.
  {
    name: 'request_tool',
    group: 'core',
    risk: 'none',
    // (each set's long description goes to whoever decides, in the approval; the model only needs to pick one)
    description: `Ask for a set of tools you don't have yet, when your task needs them. The Brain (the project's overseer) checks the request and may pass it to the user. If it is given, you keep those tools and can use them right away. Say plainly what you need them for. For things that aren't tools (a login, a key, an account, a program to install), ask the user with ask_user instead. The sets: ${TOOL_GROUPS.map((g) => (g.label.toLowerCase() === g.id ? g.id : `${g.id} (${g.label})`)).join(', ')}.`,
    parameters: obj(
      {
        tools: { type: 'string', enum: TOOL_GROUPS.map((g) => g.id), description: 'Which set of tools, e.g. "files".' },
        why: str('What you need them for in your task, in a sentence or two.'),
      },
      ['tools', 'why'],
    ),
    run: async ({ tools, why }: { tools?: unknown; why?: unknown }, ctx) =>
      requestTools(ctx, String(tools ?? ''), String(why ?? '')),
  },
  // ---------- programs ----------
  {
    name: 'list_programs',
    group: 'programs',
    risk: 'none',
    description:
      'List the programs and local AI services found on this PC, whether each is running, and what it can do. Pass all=true to also list every Start Menu app.',
    parameters: obj({ all: { type: 'boolean', description: 'Include every Start Menu shortcut' } }),
    run: async ({ all }: { all?: boolean }) => {
      // what the hourly background scan found: an agent never waits for a scan
      const progs = knownPrograms();
      const lines = progs
        .filter((p) => p.installed)
        .map(
          (p) =>
            `- ${p.name} [${p.id}]${p.version ? ` v${p.version}` : ''}${p.running ? ' (running' + (p.serviceUrl ? ` at ${p.serviceUrl}` : '') + ')' : ''}`,
        );
      let text = `Installed programs:\n${lines.join('\n')}`;
      if (all)
        text += `\n\nStart Menu apps:\n${startMenuApps()
          .map((a) => `- ${a.name}`)
          .join('\n')}`;
      return { text };
    },
  },
  {
    name: 'launch_program',
    group: 'programs',
    // Plain launches are low risk; extra arguments, runnable files or shells need a yes.
    // Judged on the program it really starts: the same one launchProgram picks.
    risk: ({ program, file, args }: LaunchArgs) => {
      if ((args && args.length) || (file && runnable(file))) return 'high';
      const target = launchTarget(program, !!file);
      const exe = target ? target.exe || target.shortcut : '';
      return [asOpened(program), asOpened(exe)].some((p) => INTERPRETERS.test(path.basename(p))) ? 'high' : 'low';
    },
    description:
      'Start a program by name or id (e.g. "blender", "premiere", "comfyui", "LM Studio", any Start Menu app). Optionally open a file with it.',
    parameters: obj(
      {
        program: str('Program name or id'),
        file: str('Optional file to open with it'),
        args: { type: 'array', items: { type: 'string' } },
      },
      ['program'],
    ),
    run: async ({ program, file, args }: LaunchArgs) => ({ text: await launchProgram(program, { file, args }) }),
  },
  {
    name: 'open_path',
    group: 'programs',
    risk: ({ path: p }: { path: string }) => (runnable(p) ? 'high' : 'low'),
    description: 'Open a file or folder with its default program (Explorer for folders).',
    parameters: obj({ path: str('Absolute path') }, ['path']),
    run: async ({ path: p }: { path: string }) => {
      if (!exists(p)) throw new Error(`${p} does not exist.`);
      openWithShell(p);
      return { text: `Opened ${p}` };
    },
  },
  // ---------- browser ----------
  {
    name: 'open_url',
    group: 'browser',
    risk: 'low',
    description: 'Open a web page for the user in their browser (default browser, or chrome/edge/opera).',
    parameters: obj({ url: str('http(s) URL'), browser: str('Optional: chrome, edge or opera') }, ['url']),
    run: async ({ url, browser }: { url: string; browser?: string }) => {
      if (!/^https?:\/\//i.test(url)) throw new Error('Only http(s) links can be opened.');
      const exe = browser ? programExe(browser.toLowerCase()) : null;
      if (exe) launchDetached(exe, [url]);
      else openWithShell(url);
      return { text: `Opened ${url}${exe ? ` in ${browser}` : ''}.` };
    },
  },
  {
    name: 'fetch_url',
    group: 'browser',
    risk: 'none',
    description: `Download a web page or API response and return its readable text, as Markdown (scripts, menus and footers left out). Long pages come in parts: continue with offset (the page is kept for ten minutes, so that is quick). For interactive browsing add the Playwright MCP server.`,
    parameters: obj(
      {
        url: str('http(s) URL'),
        offset: { type: 'number', description: 'Character to start from, for the next part (default 0)' },
        max_chars: {
          type: 'number',
          description: `Characters per part (default ${PAGE_CHARS}, at most ${PAGE_MAX_CHARS})`,
        },
      },
      ['url'],
    ),
    run: async ({ url, offset, max_chars }: { url: string; offset?: number; max_chars?: number }, ctx) => {
      if (!/^https?:\/\//i.test(String(url))) throw new Error('Only http(s) URLs.');
      const page = await readPage(String(url), ctx.runId || `agent:${ctx.agent.id}`, ctx.signal);
      return { text: pagePart(page, offset, max_chars) };
    },
  },
  // ---------- ComfyUI ----------
  {
    name: 'comfyui_status',
    group: 'comfyui',
    risk: 'none',
    description: 'Is ComfyUI running, its queue and GPU memory.',
    parameters: obj({}),
    run: async () => ({ text: JSON.stringify(await comfy.queueStatus()) }),
  },
  {
    name: 'comfyui_start',
    group: 'comfyui',
    risk: 'low',
    description:
      'Start ComfyUI (its desktop app) and wait up to two minutes for it to take jobs. Says if it came up, or what the user must do if the app starts no ComfyUI by itself.',
    parameters: obj({}),
    run: async (_args, ctx) => ({
      text: await comfy.startComfy({
        waitSec: 120,
        signal: ctx.signal,
        onProgress: (s: number) => ctx.progress?.(`Waiting for ComfyUI… ${s}s`),
      }),
    }),
  },
  {
    name: 'comfyui_list_workflows',
    group: 'comfyui',
    risk: 'none',
    description: 'List the saved ComfyUI workflows that can be run.',
    parameters: obj({}),
    run: async () => ({
      text:
        comfy
          .listWorkflows()
          .map((w) => `- ${w.name}`)
          .join('\n') || 'No workflows found. Save one in ComfyUI first.',
    }),
  },
  {
    name: 'comfyui_describe_workflow',
    group: 'comfyui',
    risk: 'none',
    description:
      'Show a workflow\'s inputs (keyed "nodeId.input") and its prompt text nodes: the inputs prompt and negative replace (promptInputs, negativeInputs).',
    parameters: obj({ workflow: str('Workflow name') }, ['workflow']),
    run: async ({ workflow }: { workflow: string }) => ({
      text: JSON.stringify(await comfy.describeWorkflow(workflow)),
    }),
  },
  {
    name: 'comfyui_run',
    group: 'comfyui',
    // Sending pictures copies the user's files into ComfyUI: on this computer that is like writing a file; to a ComfyUI
    // on another computer (Settings › ComfyUI address) the files leave this one, so that needs a yes.
    risk: ({ images }: { images?: unknown }) =>
      Array.isArray(images) && images.length && !comfy.onThisComputer() ? 'high' : 'low',
    description:
      'Run a ComfyUI workflow and wait for its files (pictures, video, audio, 3D). prompt/negative replace the prompt text, inputs change anything else ({"3.steps": 30}), images sends input pictures to its Load Image nodes (image to image, inpainting, upscaling). Seeds are randomized unless set; the result lists them, to repeat a picture. Also lists nodes ComfyUI left out for failing its checks.',
    parameters: obj(
      {
        workflow: str('Workflow name'),
        prompt: str('Positive prompt (fills every text field of the prompt node, e.g. clip_l and t5xxl)'),
        negative: str('Negative prompt text'),
        inputs: { type: 'object', description: 'Other changes as {"nodeId.input": value}' },
        images: {
          type: 'array',
          description: 'Input pictures, each set on a Load Image node',
          items: obj(
            {
              file: str('Path in your workspace or a folder you may read'),
              node: str('Its Load Image (or Load Video/Audio) node, e.g. "10". Leave out if there is only one'),
              mask: str("Optional PNG mask, same size; becomes the picture's transparency (Load Image's MASK output)"),
              mask_kind: {
                type: 'string',
                enum: ['white', 'transparent'],
                description: 'white (default): white marks the area to repaint; transparent: transparent pixels do',
              },
            },
            ['file'],
          ),
        },
        randomize_seed: { type: 'boolean' },
      },
      ['workflow'],
    ),
    run: async ({ workflow, prompt, negative, inputs, images, randomize_seed = true }: ComfyRunArgs, ctx) => {
      // the pictures go through the same folder check as the file tools
      const readable = (p: unknown, what: string): string => {
        if (!p || typeof p !== 'string') throw new Error(`${what} needs its file's path.`);
        const { abs, real, ok } = resolveInside(ctx.agent, p);
        if (!ok) throw new Error(`${what} ${abs} is outside the folders this agent may use.`);
        if (!fs.statSync(real, { throwIfNoEntry: false })?.isFile()) throw new Error(`${what} ${abs} isn't a file.`);
        return real;
      };
      const pictures = (Array.isArray(images) ? images : []).map((im) => ({
        file: readable(im?.file, 'The picture'),
        node: im?.node != null ? String(im.node) : undefined,
        mask: im?.mask ? readable(im.mask, 'The mask') : undefined,
        maskKind: im?.mask_kind,
      }));
      const r = await comfy.runWorkflow({
        workflow,
        prompt,
        negative,
        inputs,
        images: pictures,
        randomizeSeed: randomize_seed,
        signal: ctx.signal,
        onProgress: (s: number) => ctx.progress?.(`ComfyUI working… ${s}s`),
      });
      const imgs = r.files.filter((f) => f.kind === 'images').map((f) => f.url);
      const sent = r.uploaded.map(
        (u) =>
          `- ${path.basename(u.file)}${u.mask ? ` with the mask ${path.basename(u.mask)}` : ''} as "${u.value}" into ${u.input}`,
      );
      const left = comfy.describeNodeErrors(r.nodeErrors).map((l) => `- ${l}`);
      const seeds = r.seeds.length
        ? `Seeds (to repeat: inputs ${JSON.stringify(Object.fromEntries(r.seeds.map((s) => [`${s.node}.${s.input}`, s.value])))}):\n${r.seeds.map((s) => `- ${s.node}.${s.input} = ${s.value} (${s.title})`).join('\n')}`
        : '';
      return {
        text: [
          `Done in ${r.seconds}s. Files:\n${r.files.map((f) => `- ${f.filename} (${f.kind}, ${f.type}${f.subfolder ? `/${f.subfolder}` : ''})`).join('\n') || '(none)'}`,
          seeds,
          sent.length ? `Sent to ComfyUI:\n${sent.join('\n')}` : '',
          left.length ? `Left out by ComfyUI (the rest ran):\n${left.join('\n')}` : '',
          r.warnings.length ? `Warnings:\n${r.warnings.join('\n')}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
        images: imgs,
      };
    },
  },
  // ---------- Blender ----------
  {
    name: 'blender_run_python',
    group: 'blender',
    risk: 'high', // Python can do anything; "Always allow" it for agents you trust with Blender

    description:
      'Run a Python script in Blender (bpy) without opening its window, optionally on a .blend file, and return what it prints. Use it to build scenes, render (bpy.ops.render.render(write_still=True)), import/export models. Save outputs to absolute paths.',
    parameters: obj(
      {
        code: str('Python code using bpy'),
        blend_file: str('Optional .blend to open first'),
        save_as: str('Optional path to save the .blend afterwards'),
      },
      ['code'],
    ),
    run: async ({ code, blend_file, save_as }: { code: string; blend_file?: string; save_as?: string }, ctx) => {
      const exe = programExe('blender');
      if (!exe) throw new Error('Blender was not found. Set its path in Settings.');
      const script = tmpFile('blender.py');
      const footer = save_as
        ? `\nimport bpy as __b\n__b.ops.wm.save_as_mainfile(filepath=${JSON.stringify(save_as)})\nprint("Saved", ${JSON.stringify(save_as)})\n`
        : '';
      fs.writeFileSync(script, `${code}\n${footer}`);
      const args = [
        '-b',
        ...(blend_file ? [blend_file] : ['--factory-startup']),
        '--python',
        script,
        '--python-exit-code',
        '1',
      ];
      const r = await run(exe, args, { timeout: 15 * 60_000, signal: ctx.signal });
      const out = (r.stdout + '\n' + r.stderr)
        .split(/\r?\n/)
        .filter(
          (l) => !/^(Blender \d|Read prefs|Warning: \(|Color management|found bundled python|Fra:\d+ Mem:)/.test(l),
        )
        .join('\n');
      return {
        text: `${r.code === 0 ? 'Finished' : `Failed (exit ${r.code})`}\n${truncate(out.trim(), 12000)}`,
        isError: r.code !== 0,
      };
    },
  },
  {
    name: 'blender_open',
    group: 'blender',
    risk: 'low',
    description: 'Open Blender with its window, optionally loading a .blend file.',
    parameters: obj({ file: str('Optional .blend file') }),
    run: async ({ file }: { file?: string }) => ({ text: await launchProgram('blender', { file }) }),
  },
  // ---------- Adobe ----------
  {
    name: 'photoshop_run_script',
    group: 'adobe',
    risk: 'high',
    description:
      'Run ExtendScript (JavaScript) in Photoshop, starting it if needed. Use log(value) to send text back; a returned value is sent back too. Example: app.documents.add(1920,1080); return app.activeDocument.name;',
    parameters: obj({ code: str('ExtendScript code (body of a function)') }, ['code']),
    run: async ({ code }: { code: string }) => runJsx('photoshop', code),
  },
  {
    name: 'aftereffects_run_script',
    group: 'adobe',
    risk: 'high',
    description:
      'Run ExtendScript in After Effects (starting it if needed). log(value) and return values come back. After Effects needs "Allow Scripts to Write Files and Access Network" turned on in Preferences > Scripting & Expressions.',
    parameters: obj({ code: str('ExtendScript code (body of a function)') }, ['code']),
    run: async ({ code }: { code: string }) => runJsx('aftereffects', code),
  },
  {
    name: 'premiere_open',
    group: 'adobe',
    risk: 'low',
    description:
      'Open Premiere Pro, optionally with a project (.prproj) or media file. For timeline editing use ffmpeg, or add a Premiere MCP server.',
    parameters: obj({ file: str('Optional .prproj or media file') }),
    run: async ({ file }: { file?: string }) => ({ text: await launchProgram('premiere', { file }) }),
  },
  // ---------- Maya ----------
  {
    name: 'maya_run_python',
    group: 'maya',
    risk: 'high', // Python can do anything
    description:
      'Run Python in Maya without opening its window (mayapy, maya.cmds is imported as cmds), optionally on a scene, and return what it prints. Use it to build and rig scenes, key animation, bake, render and export (FBX, Alembic, OBJ). Save outputs to absolute paths.',
    parameters: obj(
      {
        code: str('Python code using maya.cmds (as cmds)'),
        scene: str('Optional .ma/.mb scene to open first'),
        save_as: str('Optional .ma or .mb path to save the scene afterwards'),
      },
      ['code'],
    ),
    run: async ({ code, scene, save_as }: { code: string; scene?: string; save_as?: string }, ctx) => {
      const exe = programExe('maya');
      if (!exe) throw new Error('Maya was not found. Set its path in Settings.');
      return runPython(
        sibling(exe, IS_WIN ? 'mayapy.exe' : 'mayapy'),
        mayaScript({ code, scene, saveAs: save_as }),
        ctx,
      );
    },
  },
  {
    name: 'maya_open',
    group: 'maya',
    risk: 'low',
    description: 'Open Maya with its window, optionally loading a scene (.ma/.mb) or model file.',
    parameters: obj({ file: str('Optional scene or model file') }),
    run: async ({ file }: { file?: string }) => ({ text: await launchProgram('maya', { file }) }),
  },
  // ---------- Houdini ----------
  {
    name: 'houdini_run_python',
    group: 'houdini',
    risk: 'high', // Python can do anything
    description:
      'Run Python in Houdini without opening its window (hython, hou is imported), optionally on a .hip file, and return what it prints. Use it to build node networks, simulate, cook and render ROPs, and export geometry (bgeo, USD, Alembic, FBX). Save outputs to absolute paths.',
    parameters: obj(
      {
        code: str('Python code using hou'),
        hip: str('Optional .hip/.hipnc file to open first'),
        save_as: str('Optional .hip path to save afterwards'),
      },
      ['code'],
    ),
    run: async ({ code, hip, save_as }: { code: string; hip?: string; save_as?: string }, ctx) => {
      const exe = programExe('houdini');
      if (!exe) throw new Error('Houdini was not found. Set its path in Settings.');
      return runPython(
        sibling(exe, IS_WIN ? 'hython.exe' : 'hython'),
        houdiniScript({ code, hip, saveAs: save_as }),
        ctx,
      );
    },
  },
  {
    name: 'houdini_open',
    group: 'houdini',
    risk: 'low',
    description: 'Open Houdini with its window, optionally loading a .hip file.',
    parameters: obj({ file: str('Optional .hip file') }),
    run: async ({ file }: { file?: string }) => ({ text: await launchProgram('houdini', { file }) }),
  },
  // ---------- Substance 3D ----------
  {
    name: 'substance_render',
    group: 'substance',
    risk: 'low',
    description:
      'Render a Substance material (.sbsar) to texture maps (base color, normal, roughness and so on, one file per output) with sbsrender from Substance 3D Designer. Set the size (1024, 2048, 4096…) and any exposed parameters by name.',
    parameters: obj(
      {
        input: str('The .sbsar file'),
        output_dir: str('Folder for the texture files (relative = workspace)'),
        format: str('png (default), jpg, tga, tif, exr, hdr, bmp, psd or dds'),
        size: { type: 'number', description: 'Texture size in pixels, a power of two (e.g. 2048)' },
        graph: str('Optional graph inside the .sbsar, when it has several'),
        values: {
          type: 'object',
          description: 'Optional exposed parameters, name to value, e.g. {"$randomseed": 7, "roughness": 0.4}',
        },
      },
      ['input', 'output_dir'],
    ),
    run: async (
      {
        input,
        output_dir,
        format,
        size,
        graph,
        values,
      }: {
        input: string;
        output_dir: string;
        format?: string;
        size?: number;
        graph?: string;
        values?: Record<string, string | number>;
      },
      ctx,
    ) => {
      const designer = programExe('designer');
      const exe = (designer && [sibling(designer, 'sbsrender.exe')].find(exists)) || which('sbsrender');
      if (!exe)
        throw new Error(
          "sbsrender was not found. It comes with Substance 3D Designer; set Designer's path in Settings.",
        );
      const src = readablePath(ctx, input);
      const out = writableDir(ctx, output_dir);
      const r = await run(exe, sbsrenderArgs({ input: src, outputDir: out, format, size, graph, values }), {
        timeout: 30 * 60_000,
        signal: ctx.signal,
      });
      const made = fs.readdirSync(out).filter((f) => !f.startsWith('.'));
      return {
        text: `${r.code === 0 ? `Rendered into ${out}` : `sbsrender failed (exit ${r.code})`}\n${truncate((r.stdout + '\n' + r.stderr).trim(), 4000)}\nFiles there now: ${made.join(', ') || 'none'}`,
        isError: r.code !== 0,
      };
    },
  },
  {
    name: 'substance_open',
    group: 'substance',
    risk: 'low',
    description:
      'Open Substance 3D Painter, Designer or Sampler, optionally with a file. Painter starts with remote scripting on, so a Substance Painter MCP server can drive it.',
    parameters: obj(
      {
        app: { type: 'string', enum: ['painter', 'designer', 'sampler'], description: 'Which app' },
        file: str('Optional project or file to open'),
      },
      ['app'],
    ),
    run: async ({ app, file }: { app: string; file?: string }) => {
      if (!['painter', 'designer', 'sampler'].includes(app))
        throw new Error('app must be painter, designer or sampler.');
      return { text: await launchProgram(app, { file, args: app === 'painter' ? ['--enable-remote-scripting'] : [] }) };
    },
  },
  // ---------- CAD and 3D printing ----------
  {
    name: 'openscad_render',
    group: 'cad',
    risk: 'low',
    description:
      'Turn an OpenSCAD model (a .scad file, or OpenSCAD code you write) into an STL, 3MF, OBJ, DXF, SVG or PNG. Set model variables with defines, e.g. {"width": 40, "label": "A"}.',
    parameters: obj(
      {
        input: str('A .scad file (or use code)'),
        code: str('OpenSCAD code to render instead of a file'),
        output: str(
          'Output file; its extension picks the format (.stl, .3mf, .obj, .off, .amf, .dxf, .svg, .png, .pdf)',
        ),
        defines: { type: 'object', description: 'Optional variables to set, name to value' },
      },
      ['output'],
    ),
    run: async (
      {
        input,
        code,
        output,
        defines,
      }: { input?: string; code?: string; output: string; defines?: Record<string, string | number | boolean> },
      ctx,
    ) => {
      const main = programExe('openscad');
      if (!main) throw new Error('OpenSCAD was not found. Install it or set its path in Settings.');
      // on Windows openscad.com is the console version, so its messages come back
      const exe = [sibling(main, 'openscad.com')].find(exists) || main;
      if (!input && !code) throw new Error('Give a .scad file (input) or OpenSCAD code (code).');
      let src: string;
      if (code) {
        src = tmpFile('model.scad');
        fs.writeFileSync(src, code);
      } else src = readablePath(ctx, input);
      const out = writablePath(ctx, output);
      const r = await run(exe, openscadArgs({ input: src, output: out, defines }), {
        timeout: 15 * 60_000,
        signal: ctx.signal,
      });
      const ok = r.code === 0 && exists(out);
      return {
        text: `${ok ? `Saved ${out}` : `OpenSCAD failed (exit ${r.code})`}\n${truncate(r.stderr.trim(), 6000)}`,
        isError: !ok,
      };
    },
  },
  {
    name: 'slice_model',
    group: 'cad',
    risk: 'low',
    description:
      'Slice a 3D model (STL, 3MF, OBJ, STEP) into G-code for a 3D printer with PrusaSlicer. Load printer, filament and print profiles exported from PrusaSlicer (.ini), and change single settings such as {"layer-height": 0.2, "fill-density": "20%", "support-material": true}. It does not start a print.',
    parameters: obj(
      {
        input: str('The model file'),
        output: str('The .gcode (or .bgcode) file to write'),
        profiles: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional .ini profile files to load, in order',
        },
        settings: { type: 'object', description: 'Optional PrusaSlicer settings, name to value' },
      },
      ['input', 'output'],
    ),
    run: async (
      {
        input,
        output,
        profiles,
        settings,
      }: { input: string; output: string; profiles?: string[]; settings?: Record<string, string | number | boolean> },
      ctx,
    ) => {
      const main = programExe('prusaslicer');
      const exe =
        (main && [sibling(main, 'prusa-slicer-console.exe')].find(exists)) || which('prusa-slicer-console') || main;
      if (!exe) throw new Error('PrusaSlicer was not found. Install it or set its path in Settings.');
      const out = writablePath(ctx, output);
      const model = readablePath(ctx, input);
      const loads = (profiles || []).map((p) => readablePath(ctx, p));
      // post_process can't be set here, and can't come in through a profile or a project either: it runs programs
      const runs = [model, ...loads].find(runsAfterSlicing);
      if (runs)
        throw new Error(
          `${path.basename(runs)} runs a program after slicing (its post_process setting). Remove that from it, or slice it in PrusaSlicer yourself.`,
        );
      const args = prusaSlicerArgs({ input: model, output: out, profiles: loads, settings });
      const r = await run(exe, args, { timeout: 30 * 60_000, signal: ctx.signal });
      const ok = r.code === 0 && exists(out);
      return {
        text: `${ok ? `Saved ${out}` : `PrusaSlicer failed (exit ${r.code})`}\n${truncate((r.stdout + '\n' + r.stderr).trim().split(/\r?\n/).slice(-30).join('\n'), 6000)}`,
        isError: !ok,
      };
    },
  },
  // ---------- free asset libraries ----------
  {
    name: 'asset_search',
    group: 'assets',
    risk: 'none',
    description:
      'Search free CC0 asset libraries: Poly Haven (HDRIs, PBR textures, models) and ambientCG (PBR materials, HDRIs, models). Free for any use, no credit needed. Returns ids for asset_download.',
    parameters: obj(
      {
        source: { type: 'string', enum: ['polyhaven', 'ambientcg'], description: 'Which library' },
        kind: { type: 'string', enum: ['hdri', 'texture', 'model'], description: 'Optional: only this kind' },
        query: str('Words to look for, e.g. "worn brick" or "forest sunset"'),
        category: str('Optional Poly Haven category, e.g. "outdoor", "wood"'),
        limit: { type: 'number', description: 'How many (default 20)' },
      },
      ['source'],
    ),
    run: async ({
      source,
      kind,
      query,
      category,
      limit,
    }: {
      source: AssetSource;
      kind?: AssetKind;
      query?: string;
      category?: string;
      limit?: number;
    }) => {
      const hits =
        source === 'ambientcg'
          ? await assetLib.ambientcgSearch({ kind, query, limit })
          : await assetLib.polyhavenSearch({ kind, query, category, limit });
      if (!hits.length) return { text: 'Nothing found. Try fewer or other words.' };
      return {
        text:
          hits
            .map(
              (a) =>
                `${a.id}: ${a.name} (${a.kind}${a.categories.length ? `; ${a.categories.join(', ')}` : ''}${a.maxSize ? `; up to ${a.maxSize}` : ''})${a.tags.length ? ` tags: ${a.tags.join(', ')}` : ''}`,
            )
            .join('\n') + (source === 'ambientcg' ? '\nFrom ambientCG.' : '\nPowered by Poly Haven.'),
      };
    },
  },
  {
    name: 'asset_download',
    group: 'assets',
    risk: 'low',
    description:
      'Download a free asset from Poly Haven or ambientCG into a folder (relative = workspace). Textures come as one file per map (color, normal, roughness, AO, displacement…). Poly Haven: resolution 1k/2k/4k/8k, format jpg/png/exr for texture maps, hdr/exr for HDRIs, gltf/fbx/blend for models (with their textures). ambientCG: resolution 1K/2K/4K/8K, format JPG or PNG (EXR for HDRIs).',
    parameters: obj(
      {
        source: { type: 'string', enum: ['polyhaven', 'ambientcg'], description: 'Which library' },
        id: str('The asset id from asset_search'),
        folder: str('Folder to save into (a folder named after the asset is made inside)'),
        resolution: str('Size, e.g. 2k (default)'),
        format: str('File format, see above'),
      },
      ['source', 'id', 'folder'],
    ),
    run: async (
      {
        source,
        id,
        folder,
        resolution,
        format,
      }: { source: AssetSource; id: string; folder: string; resolution?: string; format?: string },
      ctx,
    ) => {
      if (source !== 'polyhaven' && source !== 'ambientcg') throw new Error('source must be polyhaven or ambientcg.');
      if (!/^[\w-]+$/.test(String(id))) throw new Error('That is not an asset id.');
      // (the asset's own folder too: one already there could be a link out of the allowed folders)
      const dir = writableDir(ctx, path.join(String(folder || '.'), id));
      ctx.progress?.(`Downloading ${id}…`);
      const files = await assetLib.downloadAsset(source, id, dir, { resolution, format, signal: ctx.signal });
      return {
        text: `Saved ${files.length} file${files.length === 1 ? '' : 's'} in ${dir}:\n${files.join('\n')}\nLicence: CC0 (free for any use, no credit needed). ${source === 'polyhaven' ? 'Powered by Poly Haven (polyhaven.com).' : 'From ambientCG (ambientcg.com).'}`,
      };
    },
  },
  // ---------- NVIDIA ----------
  {
    name: 'nvidia_gpu_status',
    group: 'nvidia',
    risk: 'none',
    description:
      'How busy the NVIDIA graphics cards are: name, driver, load, temperature, memory and power. Check it before a big render or AI job.',
    parameters: obj({}),
    run: async () => {
      const exe = which('nvidia-smi');
      if (!exe) throw new Error('nvidia-smi was not found. It comes with the NVIDIA graphics driver.');
      const r = await run(exe, [`--query-gpu=${GPU_FIELDS.join(',')}`, '--format=csv,noheader,nounits'], {
        timeout: 20000,
      });
      if (r.code !== 0)
        return { text: `nvidia-smi failed (exit ${r.code})\n${truncate(r.stderr || r.stdout, 2000)}`, isError: true };
      return { text: formatGpus(r.stdout) };
    },
  },
  {
    name: 'nvidia_texture_export',
    group: 'nvidia',
    risk: 'low',
    description:
      'Compress an image (PNG, TGA, JPG, EXR…) into a DDS or KTX texture for games with the NVIDIA Texture Tools Exporter. Formats: bc7 (default, color), bc1 (color, smallest), bc3 (color with alpha), bc4 (one channel, e.g. roughness), bc5 (normal maps), rgba8 (no compression).',
    parameters: obj(
      {
        input: str('The image file'),
        output: str('The .dds, .ktx or .ktx2 file to write'),
        format: str('Compression format, e.g. bc7, bc1, bc3, bc4, bc5, rgba8'),
        mips: { type: 'boolean', description: 'Make mipmaps (default true)' },
      },
      ['input', 'output'],
    ),
    run: async (
      { input, output, format, mips }: { input: string; output: string; format?: string; mips?: boolean },
      ctx,
    ) => {
      const exe = programExe('nvtt') || which('nvtt_export');
      if (!exe)
        throw new Error(
          'The NVIDIA Texture Tools Exporter was not found. Install it from developer.nvidia.com/texture-tools-exporter or set its path in Settings.',
        );
      const out = writablePath(ctx, output);
      const r = await run(
        exe,
        nvttArgs({ input: readablePath(ctx, input), output: out, format, mips: mips !== false }),
        { timeout: 15 * 60_000, signal: ctx.signal },
      );
      const ok = r.code === 0 && exists(out);
      return {
        text: `${ok ? `Saved ${out}` : `nvtt_export failed (exit ${r.code})`}\n${truncate((r.stdout + '\n' + r.stderr).trim(), 4000)}`,
        isError: !ok,
      };
    },
  },
  // ---------- media ----------
  {
    name: 'ffmpeg',
    group: 'media',
    risk: 'high', // it can overwrite any file; "Always allow" it for your video agents
    description:
      'Run ffmpeg with the given arguments (no shell). Pass -n (never overwrite); -y only on files you made in this task. Relative paths start in your workspace. Example args: ["-n","-i","C:/in.mp4","-ss","5","-t","10","C:/out.mp4"].',
    parameters: obj({ args: { type: 'array', items: { type: 'string' } } }, ['args']),
    run: async ({ args }: { args: string[] }, ctx) => {
      if (!which('ffmpeg')) throw new Error('ffmpeg is not installed.');
      // in the workspace, so relative paths and two-pass logs don't land in the app's own (read-only) folder
      const r = await run('ffmpeg', ['-hide_banner', ...args], {
        cwd: workspaceOf(ctx.agent),
        timeout: 60 * 60_000,
        signal: ctx.signal,
      });
      return {
        text: `${r.code === 0 ? 'Done' : `ffmpeg failed (exit ${r.code})`}\n${truncate(r.stderr.split(/\r?\n/).slice(-40).join('\n'), 6000)}`,
        isError: r.code !== 0,
      };
    },
  },
  {
    name: 'handbrake_encode',
    group: 'media',
    risk: 'low',
    description:
      'Convert or shrink a video with HandBrake (HandBrakeCLI) using one of its presets, e.g. "Fast 1080p30" (default), "Fast 720p30", "HQ 1080p30 Surround", "Fast 2160p60 4K HEVC". Optional quality (RF, lower is better, 18–28 is usual) and encoder (x264, x265, svt_av1, or nvenc_h264 / nvenc_h265 on NVIDIA cards). Set list_presets to see every preset.',
    parameters: obj({
      input: str('The video file'),
      output: str('The .mp4, .mkv or .webm file to write'),
      preset: str('HandBrake preset name'),
      quality: { type: 'number', description: 'Optional constant quality (RF)' },
      encoder: str('Optional video encoder'),
      list_presets: { type: 'boolean', description: 'Only list the presets' },
    }),
    run: async (
      {
        input,
        output,
        preset,
        quality,
        encoder,
        list_presets,
      }: {
        input?: string;
        output?: string;
        preset?: string;
        quality?: number;
        encoder?: string;
        list_presets?: boolean;
      },
      ctx,
    ) => {
      const exe = programExe('handbrakecli') || which('HandBrakeCLI');
      if (!exe)
        throw new Error(
          'HandBrakeCLI was not found. It is a separate free download from handbrake.fr/downloads2.php (the HandBrake window app is not enough); then set its path in Settings or put it on PATH.',
        );
      if (list_presets) {
        const r = await run(exe, ['--preset-list'], { cwd: workspaceOf(ctx.agent), timeout: 60000 });
        return { text: truncate((r.stdout + '\n' + r.stderr).trim(), 10000) };
      }
      if (!input || !output) throw new Error('Give input and output.');
      const out = writablePath(ctx, output);
      ctx.progress?.('HandBrake is encoding…');
      const r = await run(
        exe,
        handbrakeArgs({ input: readablePath(ctx, input), output: out, preset, quality, encoder }),
        { cwd: workspaceOf(ctx.agent), timeout: 4 * 60 * 60_000, signal: ctx.signal },
      );
      const ok = r.code === 0 && exists(out);
      return {
        text: `${ok ? `Saved ${out}` : `HandBrake failed (exit ${r.code})`}\n${truncate(
          r.stderr
            .split(/\r?\n/)
            .filter((l) => l.trim() && !/^Encoding: task/.test(l))
            .slice(-25)
            .join('\n'),
          5000,
        )}`,
        isError: !ok,
      };
    },
  },
  {
    name: 'imagemagick',
    group: 'media',
    risk: 'high', // it can read and overwrite any file; "Always allow" it for your image agents
    description:
      'Run ImageMagick (magick) with the given arguments (no shell) to resize, crop, convert, combine, add text or batch-edit images. Use absolute paths and write to new files. Example args: ["C:/in.png","-resize","50%","C:/out.webp"]. For many files use ["mogrify","-path","C:/out","-resize","1024x1024","C:/in/*.png"].',
    parameters: obj({ args: { type: 'array', items: { type: 'string' } } }, ['args']),
    run: async ({ args }: { args: string[] }, ctx) => {
      const exe = programExe('imagemagick');
      if (!exe)
        throw new Error(
          'ImageMagick is not installed (imagemagick.org/script/download.php), or set its path in Settings.',
        );
      if (!Array.isArray(args) || !args.length) throw new Error('Give the arguments as a list.');
      const r = await run(exe, args.map(String), {
        cwd: workspaceOf(ctx.agent),
        timeout: 30 * 60_000,
        signal: ctx.signal,
      });
      return {
        text: `${r.code === 0 ? 'Done' : `ImageMagick failed (exit ${r.code})`}\n${truncate((r.stdout + '\n' + r.stderr).trim(), 6000)}`,
        isError: r.code !== 0,
      };
    },
  },
  {
    name: 'ffprobe',
    group: 'media',
    risk: 'none',
    description: 'Show duration, streams and format of an audio or video file.',
    parameters: obj({ file: str('Absolute path') }, ['file']),
    run: async ({ file }: { file: string }, ctx) => {
      const r = await run('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file], {
        cwd: workspaceOf(ctx.agent),
        timeout: 60000,
      });
      return { text: truncate(r.stdout || r.stderr, 8000) };
    },
  },
  // ---------- social ----------
  {
    name: 'social_accounts',
    group: 'social',
    risk: 'none',
    description: 'List connected social accounts.',
    parameters: obj({}),
    run: async () => {
      const a = social.listAccounts();
      return {
        text: `X: ${a.x.map((x) => `@${x.username}${x.autopost ? ' (auto-post on)' : ' (approve first)'}`).join(', ') || 'none connected'}\nReddit: ${a.reddit.map((x) => `u/${x.username}`).join(', ') || 'none connected'}\nTelegram: ${a.telegram.configured ? 'ready' : 'not set up'}\nDiscord: ${a.discord.configured ? 'ready' : 'not set up'}`,
      };
    },
  },
  {
    name: 'x_draft_post',
    group: 'social',
    risk: 'none',
    description:
      "Write a post (or thread) for X. It waits in the Outbox for the user to approve, edit or reject, unless the account has auto-post on; a reply (reply_to) always waits. Each part max 280 characters as X counts them: emoji and Chinese, Japanese or Korean letters count 2, a link 23. Up to 4 images go on the first post; give each alt text. X only lets you reply where the author mentioned or quoted this account, and quote posts aren't possible.",
    parameters: obj({
      text: str('The post'),
      thread: {
        type: 'array',
        items: { type: 'string' },
        description: 'For a thread: every part in order (instead of text)',
      },
      images: {
        type: 'array',
        items: { type: 'string' },
        description: 'Full paths of up to 4 PNG, JPEG or WebP files in the project (5 MB each)',
      },
      image_alt: {
        type: 'array',
        items: { type: 'string' },
        description:
          "Each image's alt text (a short description for people who can't see it), in order; up to 1,000 characters",
      },
      account: str('Handle to post as (default: first connected)'),
      reply_to: str('ID of the post to reply to'),
      note: str('Why this post, for the reviewer'),
    }),
    run: async (
      {
        text,
        thread,
        images,
        image_alt,
        account,
        reply_to,
        note,
      }: {
        text?: string;
        thread?: string[];
        images?: string[];
        image_alt?: string[];
        account?: string;
        reply_to?: string;
        note?: string;
      },
      ctx,
    ) => {
      // images only from the folders this agent may read, not every agent's workspace
      const r = await social.draftPost({
        platform: 'x',
        text,
        thread,
        images,
        imageAlt: image_alt,
        imageRoots: allowedRoots(ctx.agent),
        account,
        replyTo: reply_to,
        note,
        agentId: ctx.agent.id,
        chatId: await chatOf(ctx),
        agentName: ctx.agent.name,
      });
      return {
        text:
          r.status === 'posted'
            ? `Posted: ${r.url}`
            : r.status === 'failed'
              ? `Auto-post failed: ${r.error}`
              : `Saved to the Outbox for approval (id ${r.id}).`,
      };
    },
  },
  {
    name: 'x_draft_dm',
    group: 'social',
    risk: 'none',
    description:
      'Write a direct message on X to someone. It always waits in the Outbox for the user to approve, edit or reject; it is never sent on its own.',
    parameters: obj(
      {
        to: str('Their X handle, e.g. @someone'),
        text: str('The message'),
        account: str('Which of your handles to send from (default: first connected)'),
        note: str('Why, for the reviewer'),
      },
      ['to', 'text'],
    ),
    run: async ({ to, text, account, note }: { to: string; text: string; account?: string; note?: string }, ctx) => {
      const r = await social.draftPost({
        platform: 'x_dm',
        to,
        text,
        account,
        note,
        agentId: ctx.agent.id,
        chatId: await chatOf(ctx),
        agentName: ctx.agent.name,
      });
      return { text: `Saved the DM to @${r.to} in the Outbox for approval (id ${r.id}).` };
    },
  },
  {
    name: 'x_recent_posts',
    group: 'social',
    risk: 'none',
    description:
      "Read a connected account's recent posts with likes, reposts and replies. (Each X read is billed by X.)",
    parameters: obj({ account: str('Handle'), limit: X_LIMIT }),
    run: async ({ account, limit }: { account?: string; limit?: number }) => ({
      text: JSON.stringify(await social.xRecentPosts(account, xLimit(limit))),
    }),
  },
  {
    name: 'x_mentions',
    group: 'social',
    risk: 'none',
    description:
      'Read recent mentions of a connected account: the posts it may reply to. (Each X read is billed by X.)',
    parameters: obj({ account: str('Handle'), limit: X_LIMIT }),
    run: async ({ account, limit }: { account?: string; limit?: number }) => ({
      text: JSON.stringify(await social.xMentions(account, xLimit(limit))),
    }),
  },
  {
    name: 'reddit_read',
    group: 'social',
    risk: 'none',
    description:
      'Read posts from a subreddit (hot, new, top this week, rising): titles, scores, comment counts, links.',
    parameters: obj(
      { subreddit: str('e.g. LocalLLaMA'), sort: str('hot, new, top or rising'), limit: { type: 'number' } },
      ['subreddit'],
    ),
    run: async ({ subreddit, sort = 'hot', limit = 10 }: { subreddit: string; sort?: string; limit?: number }) => ({
      text: JSON.stringify(await reddit.readSubreddit(subreddit, sort, limit)),
    }),
  },
  {
    name: 'reddit_search',
    group: 'social',
    risk: 'none',
    description: 'Search Reddit (optionally inside one subreddit) for posts from the last month.',
    parameters: obj(
      { query: str('What to look for'), subreddit: str('Optional subreddit'), limit: { type: 'number' } },
      ['query'],
    ),
    run: async ({ query, subreddit = '', limit = 10 }: { query: string; subreddit?: string; limit?: number }) => ({
      text: JSON.stringify(await reddit.searchReddit(query, subreddit, limit)),
    }),
  },
  {
    name: 'reddit_comments',
    group: 'social',
    risk: 'none',
    description: 'Read a Reddit post and its top comments (give the post URL or id).',
    parameters: obj({ post: str('Post URL or id') }, ['post']),
    run: async ({ post }: { post: string }) => ({ text: JSON.stringify(await reddit.postComments(post)) }),
  },
  {
    name: 'reddit_rules',
    group: 'social',
    risk: 'none',
    description: "Read a subreddit's rules and sidebar (what may be posted, posting guidelines) before drafting there.",
    parameters: obj({ subreddit: str('e.g. LocalLLaMA') }, ['subreddit']),
    run: async ({ subreddit }: { subreddit: string }) => ({
      text: JSON.stringify(await reddit.subredditRules(subreddit), null, 2),
    }),
  },
  {
    name: 'reddit_draft_post',
    group: 'social',
    risk: 'none',
    description:
      'Write a Reddit post. It waits in the Outbox for the user to approve or edit, unless that account has auto-post on (then it is published at once). Follow the subreddit rules (reddit_rules); no spam or self-promotion where not allowed. Give flair_id and/or flair_text if the subreddit wants a flair.',
    parameters: obj(
      {
        subreddit: str('Subreddit, e.g. LocalLLaMA'),
        title: str('Post title'),
        text: str('Post body (markdown)'),
        link: str('Or a link to share instead of text'),
        account: str('Which of your Reddit accounts'),
        flair_id: str("The flair's template id (up to 36 characters)"),
        flair_text: str('The flair text (up to 64 characters)'),
        note: str('Why this post, for the reviewer'),
      },
      ['subreddit', 'title'],
    ),
    run: async (
      {
        subreddit,
        title,
        text,
        link,
        account,
        note,
        flair_id,
        flair_text,
      }: {
        subreddit: string;
        title: string;
        text?: string;
        link?: string;
        account?: string;
        note?: string;
        flair_id?: string;
        flair_text?: string;
      },
      ctx,
    ) => {
      const r = await social.draftPost({
        platform: 'reddit',
        subreddit,
        title,
        text,
        link,
        account,
        note,
        flairId: flair_id,
        flairText: flair_text,
        agentId: ctx.agent.id,
        chatId: await chatOf(ctx),
        agentName: ctx.agent.name,
      });
      return {
        text:
          r.status === 'posted'
            ? `Posted: ${r.url}`
            : r.status === 'failed'
              ? `Auto-post failed: ${r.error}`
              : `Saved to the Outbox for approval (id ${r.id}).`,
      };
    },
  },
  {
    name: 'reddit_draft_comment',
    group: 'social',
    risk: 'none',
    description:
      'Write a Reddit comment replying to a post or comment (give its URL or id). It waits in the Outbox for the user to approve, unless that account has auto-post on, in which case it is published straight away.',
    parameters: obj(
      {
        reply_to: str('Post or comment URL, or id like t3_abc / t1_abc'),
        text: str('The comment (markdown)'),
        account: str('Which of your Reddit accounts'),
      },
      ['reply_to', 'text'],
    ),
    run: async ({ reply_to, text, account }: { reply_to: string; text: string; account?: string }, ctx) => {
      const r = await social.draftPost({
        platform: 'reddit',
        parent: reply_to,
        text,
        account,
        agentId: ctx.agent.id,
        chatId: await chatOf(ctx),
        agentName: ctx.agent.name,
      });
      return { text: r.status === 'posted' ? `Posted: ${r.url}` : `Saved to the Outbox for approval (id ${r.id}).` };
    },
  },
  {
    name: 'gateway_draft',
    group: 'social',
    risk: 'none',
    description:
      'Draft a Telegram or Discord message in the Outbox. The user picks the gateway conversation, checks the text and approves. Never sends, and cannot list gateway conversations.',
    parameters: obj(
      {
        platform: { type: 'string', enum: ['telegram', 'discord'] },
        text: str('Exact message text'),
        note: str('Context for the user'),
      },
      ['platform', 'text'],
    ),
    run: async ({ platform, text, note }: { platform: string; text: string; note?: string }, ctx) => {
      if (platform !== 'telegram' && platform !== 'discord') throw new Error('Choose Telegram or Discord.');
      const item = await social.draftPost({
        platform,
        text,
        note,
        agentId: ctx.agent.id,
        agentName: ctx.agent.name,
        chatId: await chatOf(ctx),
      });
      return {
        text: `Saved Outbox draft ${item.id}. The user must choose its gateway recipient and approve before it sends.`,
      };
    },
  },
  {
    name: 'telegram_send',
    group: 'social',
    risk: 'high',
    description:
      'Send a Telegram message through a gateway instance to a completed conversation, using IDs the user gave you (otherwise use gateway_draft). Queued is not delivered: receipts are in the Outbox.',
    parameters: obj(
      {
        text: str('Exact message'),
        instance_id: str('Telegram gateway instance ID'),
        event_id: str('Completed source event ID'),
      },
      ['text', 'instance_id', 'event_id'],
    ),
    run: async ({ text, instance_id, event_id }: { text: string; instance_id: string; event_id: string }, ctx) => ({
      text: await social.sendTelegram(
        text,
        { instanceId: instance_id, eventId: event_id },
        { agentId: ctx.agent.id, agentName: ctx.agent.name, chatId: await chatOf(ctx) },
        ctx.signal,
      ),
    }),
  },
  {
    name: 'discord_send',
    group: 'social',
    risk: 'high',
    description:
      'Send a Discord message through a gateway instance to a completed conversation, using IDs the user gave you (otherwise use gateway_draft). Queued is not delivered: receipts are in the Outbox.',
    parameters: obj(
      {
        text: str('Exact message'),
        instance_id: str('Discord gateway instance ID'),
        event_id: str('Completed source event ID'),
      },
      ['text', 'instance_id', 'event_id'],
    ),
    run: async ({ text, instance_id, event_id }: { text: string; instance_id: string; event_id: string }, ctx) => ({
      text: await social.sendDiscord(
        text,
        { instanceId: instance_id, eventId: event_id },
        { agentId: ctx.agent.id, agentName: ctx.agent.name, chatId: await chatOf(ctx) },
        ctx.signal,
      ),
    }),
  },
  // ---------- team ----------
  {
    name: 'list_agents',
    group: 'agents',
    risk: 'none',
    description: 'List the other agents on this dashboard and what each is good at.',
    parameters: obj({}),
    run: async (_a, ctx) => ({
      text:
        agentStore
          .list()
          .filter((a) => a.id !== ctx.agent.id)
          .map((a) => `- ${a.name} [${a.id}]: ${a.specialty || a.description || ''}`)
          .join('\n') || 'No other agents yet.',
    }),
  },
  {
    name: 'ask_agent',
    group: 'agents',
    risk: 'none',
    description:
      "Give a task to another agent. It starts at once and you get a handle back right away: keep working, then get the answer with await_agent. To run several tasks in parallel, send them all first, then await them together. For a quick question, set wait_seconds to get the answer in this same call. Say exactly what you need back. A task you hand off is theirs: don't also do it yourself.",
    parameters: obj(
      {
        agent: str('Agent name, id, or "Name [id]" as list_agents shows it'),
        message: str('The task or question'),
        wait_seconds: { type: 'number', description: 'Optional: wait this long for the answer now (up to 600)' },
      },
      ['agent', 'message'],
    ),
    run: async ({ agent, message, wait_seconds }: { agent: string; message: string; wait_seconds?: number }, ctx) => {
      if ((ctx.depth || 0) >= 3) throw new Error('Too many agents deep; answer this yourself.');
      const found = findAgent(agentStore.list(), agent);
      if ('error' in found) throw new Error(found.error);
      const target = found.agent;
      if (target.id === ctx.agent.id) throw new Error("That's you.");
      const h = await startHandoff(ctx.agent, target, String(message || ''), {
        depth: (ctx.depth || 0) + 1,
        parentRunId: ctx.runId,
        signal: ctx.signal,
      });
      const sent = `Sent to ${target.name} (handle ${h.id}).`;
      const wait = Math.min(
        Number(wait_seconds) || 0,
        600,
        agentStore.get(ctx.agent.id)?.engine === 'hermes' ? HERMES_WAIT_S : 600,
      );
      if (wait < 1)
        return { text: `${sent} They are working on it now. Get the answer with await_agent and handle "${h.id}".` };
      const r = await awaitHandoff(h.id, ctx.agent.id, wait, ctx.signal, h.conversationId || null);
      return { ...r, text: `${sent}\n${r.text}` };
    },
  },
  {
    name: 'await_agent',
    group: 'agents',
    risk: 'none',
    description: `Get the answer to a task you gave with ask_agent. Waits up to wait_seconds (default ${DEFAULT_WAIT_S}, at most ${MAX_WAIT_S}); if they are still working, call it again until they finish. With handles it waits for several at once: until the first is done, or every one with all. When their answer is a question, a blocker or something only the user can decide, that is the outcome: pass it on instead of waiting for more. Without a handle: lists your handoffs.`,
    parameters: obj({
      handle: str('The handle ask_agent gave you'),
      handles: { type: 'array', items: { type: 'string' }, description: 'Several handles, instead of handle' },
      all: { type: 'boolean', description: 'With handles: wait for every one, not just the first' },
      wait_seconds: { type: 'number', description: `How long to wait for the answer this time (1-${MAX_WAIT_S})` },
    }),
    run: async (
      {
        handle,
        handles,
        all,
        wait_seconds,
      }: { handle?: string; handles?: unknown; all?: boolean; wait_seconds?: number },
      ctx,
    ) => {
      const ids = Array.isArray(handles) && handles.length ? handles.map(String) : handle ? [handle] : [];
      // (a private conversation sees only what it handed out, and ordinary chats none of that)
      const conversationId = (await import('./engines/index.ts')).conversationOfRun(ctx.runId) || null;
      if (!ids.length) return { text: listHandoffs(ctx.agent.id, conversationId) };
      // Hermes gives up on an MCP call after 5 minutes: wait less, and it calls again
      const hermes = agentStore.get(ctx.agent.id)?.engine === 'hermes';
      const wait = hermes ? Math.min(HERMES_WAIT_S, Number(wait_seconds) || HERMES_WAIT_S) : wait_seconds;
      return ids.length === 1
        ? awaitHandoff(ids[0]!, ctx.agent.id, wait, ctx.signal, conversationId)
        : awaitHandoffs(ids, ctx.agent.id, { all: !!all, waitS: wait, signal: ctx.signal, conversationId });
    },
  },
  {
    name: 'hermes_ask',
    group: 'agents',
    risk: 'none',
    description: 'Ask one of your Hermes profiles (e.g. net-researcher) a question and get its answer.',
    parameters: obj(
      { profile: str('Hermes profile name (default profile when empty)'), message: str('Question or task') },
      ['message'],
    ),
    run: async ({ profile, message }: { profile?: string; message: string }, ctx) => {
      if (profile && !/^[\w.-]+$/.test(profile)) throw new Error('Invalid Hermes profile name.');
      const args = [...(profile ? ['-p', profile] : []), 'chat', '--query-file', '-', '--format', 'text', '-Q'];
      const r = await run('hermes', args, { input: message, timeout: 20 * 60_000, signal: ctx.signal });
      return {
        text: truncate((r.stdout || r.stderr).replace(/\n?session_id: \S+\s*$/, '').trim(), 20000),
        isError: r.code !== 0,
      };
    },
  },
  // ---------- knowledge (added automatically when an agent has knowledge) ----------
  {
    name: 'knowledge_search',
    group: 'knowledge',
    risk: 'none',
    description: 'Search your knowledge files. Returns the best matching passages with file and line.',
    parameters: obj({ query: str('What to look for') }, ['query']),
    run: async ({ query }: { query: string }, ctx) => {
      const hits = kb.searchKnowledge(ctx.agent, query);
      return {
        text: hits.length ? hits.map((h) => `### ${h.file}:${h.line}\n${h.text}`).join('\n\n') : 'Nothing matched.',
      };
    },
  },
  {
    name: 'knowledge_read',
    group: 'knowledge',
    risk: 'none',
    description: 'Read one of your knowledge files (400 lines at a time).',
    parameters: obj({ file: str('File name as listed'), from_line: { type: 'number' } }, ['file']),
    run: async ({ file, from_line = 1 }: { file: string; from_line?: number }, ctx) => {
      const r = kb.readKnowledge(ctx.agent, file, from_line);
      return { text: `${r.file} lines ${r.from}-${r.to} of ${r.total}\n\n${r.text}` };
    },
  },
  // ---------- memory (every agent of its own: its MEMORY.md, also in its instructions) ----------
  {
    name: 'memory_read',
    group: 'memory',
    risk: 'none',
    description: 'Read your whole MEMORY.md as it is now (your instructions have it as it was when this chat started).',
    parameters: obj({}),
    run: async (_args, ctx) => ({ text: memory.readMemory(ctx.agent.id).trim() || '(empty: nothing remembered yet)' }),
  },
  {
    name: 'memory_add',
    group: 'memory',
    // (it only adds to the agent's own notes, and every change can be undone in its History)
    risk: 'low',
    description:
      'Add one short note to your MEMORY.md, so you still know it in later chats: how the user likes things done, a decision, a fact about the project, a pitfall. Never secrets.',
    parameters: obj({ note: str('The note, one line') }, ['note']),
    run: async ({ note }: { note: string }, ctx) => {
      const m = withActor('agent', () => memory.addToMemory(ctx.agent.id, note));
      return { text: `Remembered. MEMORY.md is now ${m.text.length} characters.` };
    },
  },
  {
    name: 'memory_write',
    group: 'memory',
    risk: 'low',
    description:
      'Replace your whole MEMORY.md (markdown), to correct notes, drop outdated ones or tidy it up. Read it first with memory_read so nothing is lost. The earlier version is kept.',
    parameters: obj({ content: str('The whole new MEMORY.md') }, ['content']),
    run: async ({ content }: { content: string }, ctx) => {
      const m = withActor('agent', () => memory.writeMemory(ctx.agent.id, content));
      return { text: `Saved MEMORY.md (${m.text.length} characters).` };
    },
  },
  // ---------- the voxel world (server/voxel/tools.ts) ----------
  ...voxel.worldTools(gate, { readable: readablePath, writableDir }),
  // ---------- files ----------
  {
    name: 'list_files',
    group: 'files',
    risk: 'none',
    description:
      'List a folder: sub-folders, and files with their sizes (relative paths start in your workspace). depth lists folders inside it too.',
    parameters: obj({
      path: str('Folder (default: workspace)'),
      depth: { type: 'number', description: 'Folder levels to list, 1-5 (default 1)' },
    }),
    run: async ({ path: p = '.', depth }: { path?: string; depth?: number }, ctx) => {
      const { abs, real, ok } = resolveInside(ctx.agent, p);
      if (!ok)
        throw new Error(`${abs} is outside the folders this agent may use. Add it in Settings > Allowed folders.`);
      return { text: files.listFolder(real, abs, depth) };
    },
  },
  {
    name: 'read_file',
    group: 'files',
    risk: 'none',
    description: `Read a text file, or a PDF or Office file's text (workspace, knowledge, outputs or allowed folders). A long file comes in parts of up to ${files.READ_LINES} lines: continue with offset. paths reads up to 10 files in one call.`,
    parameters: obj({
      path: str('File path'),
      paths: {
        type: 'array',
        items: { type: 'string' },
        maxItems: 10,
        description: 'Several files at once, instead of path',
      },
      offset: { type: 'number', description: 'First line to read (default 1)' },
      limit: { type: 'number', description: `How many lines (default and most ${files.READ_LINES})` },
    }),
    run: async (
      { path: p, paths, offset, limit }: { path?: string; paths?: unknown; offset?: number; limit?: number },
      ctx,
    ) => {
      const list = Array.isArray(paths) && paths.length ? paths.slice(0, 10).map(String) : p ? [String(p)] : [];
      if (!list.length) throw new Error('Give path (or paths).');
      const read = async (file: string, chars?: number) => {
        const { abs, real, ok } = resolveInside(ctx.agent, file);
        if (!ok) throw new Error(`${abs} is outside the folders this agent may use.`);
        return (
          (await readDocumentPart(real, abs, { offset, limit, chars })) ??
          files.readText(real, abs, { offset, limit, chars })
        );
      };
      if (list.length === 1) return { text: await read(list[0]!) };
      // several: each gets its share, so one long file can't crowd out the rest (one at a time: a PDF gets a thread)
      const share = Math.floor(60_000 / list.length);
      const parts: string[] = [];
      for (const file of list) {
        let body: string;
        try {
          body = await read(file, share);
        } catch (e) {
          body = `Error: ${(e as Error).message}`;
        }
        parts.push(`===== ${file} =====\n${body}`);
      }
      return { text: parts.join('\n\n') };
    },
  },
  {
    // every engine gets it: Eve's read_file reads documents too, but the coding engines' own file tools don't
    name: 'read_document',
    group: 'core',
    risk: 'none',
    description:
      'Read the text of a PDF, Word, Excel or PowerPoint file (attached, or in your folders), in parts: continue with offset.',
    parameters: obj({ path: str('File path'), offset: { type: 'number', description: 'First line' } }, ['path']),
    run: async ({ path: p, offset }: { path: string; offset?: number }, ctx) => {
      const abs = path.resolve(workspaceOf(ctx.agent), String(p || '.'));
      const run = ctx.runId ? (await import('./engines/index.ts')).runInfo(ctx.runId) : null;
      const real = insideRoots(abs, documentRoots(ctx.agent, run?.conversationId || null));
      if (!real) throw new Error(`${abs} is outside the folders this agent may use.`);
      if (fs.statSync(real).isDirectory()) throw new Error(`${abs} is a folder, not a document.`);
      const text = await readDocumentPart(real, abs, { offset });
      if (text === null)
        throw new Error(
          `${abs} is not a PDF, Word, Excel or PowerPoint file.${hasOwnFileTools(ctx.agent.engine ?? agentStore.get(ctx.agent.id)?.engine) ? ' Open it with your own file tools.' : ''}`,
        );
      return { text };
    },
  },
  {
    name: 'view_image',
    group: 'files',
    risk: 'none',
    description: `See a picture file (a render, an FFmpeg or ImageMagick result, a video frame, a screenshot): PNG, JPEG, WebP or GIF up to ${MODEL_MAX_BYTES / 1024 / 1024} MB, in a folder you may read. Convert other formats to PNG and shrink bigger ones first.`,
    parameters: obj({ path: str('Image file path') }, ['path']),
    run: async ({ path: p }: { path: string }, ctx) => {
      const { abs, real, ok } = resolveInside(ctx.agent, p);
      if (!ok) throw new Error(`${abs} is outside the folders this agent may use.`);
      const stat = fs.statSync(real);
      if (!stat.isFile()) throw new Error(`${abs} is not a file.`);
      const mb = MODEL_MAX_BYTES / 1024 / 1024;
      if (stat.size > MODEL_MAX_BYTES)
        throw new Error(
          `${abs} is ${(stat.size / 1024 / 1024).toFixed(1)} MB; view_image takes pictures up to ${mb} MB. Save a smaller copy first (for example with ImageMagick: -resize 1600x1600).`,
        );
      const bytes = fs.readFileSync(real);
      const mime = imageType(bytes);
      if (!mime) throw new Error(`${abs} is not a PNG, JPEG, WebP or GIF picture. Convert it to PNG first.`);
      return {
        text: `${abs} (${mime}, ${Math.ceil(bytes.length / 1024)} KB)`,
        images: [`data:${mime};base64,${bytes.toString('base64')}`],
      };
    },
  },
  {
    name: 'write_file',
    group: 'files',
    risk: 'low',
    description:
      'Create or overwrite a text file in your workspace or an allowed folder. Returns the full path. To change part of a file, use edit_file.',
    parameters: obj({ path: str('File path (relative = workspace)'), content: str('File contents') }, [
      'path',
      'content',
    ]),
    run: async ({ path: p, content }: { path: string; content: string }, ctx) => {
      const { abs, real, ok } = resolveInside(ctx.agent, p, { write: true });
      if (!ok) throw new Error(`${abs} is outside the folders this agent may write to.`);
      ensureDir(path.dirname(real));
      fs.writeFileSync(real, content);
      return { text: `Wrote ${abs} (${Buffer.byteLength(content)} bytes)` };
    },
  },
  {
    name: 'edit_file',
    group: 'files',
    // like write_file: it changes a file in the folders the agent may write to
    risk: 'low',
    description:
      'Change part of a text file, without sending all of it again: each edit replaces old (the exact text, there exactly once; set all to replace every one) with new. Edits apply in order, and if one does not fit nothing is changed. Read the file first.',
    parameters: obj(
      {
        path: str('File path (relative = workspace)'),
        edits: {
          type: 'array',
          minItems: 1,
          items: obj(
            {
              old: str('The exact text to replace, with enough around it to be found only once'),
              new: str('The text to put there instead'),
              all: { type: 'boolean', description: 'Replace every match' },
            },
            ['old', 'new'],
          ),
        },
      },
      ['path', 'edits'],
    ),
    run: async ({ path: p, edits }: { path: string; edits: files.FileEdit[] }, ctx) => {
      const { abs, real, ok } = resolveInside(ctx.agent, p, { write: true });
      if (!ok) throw new Error(`${abs} is outside the folders this agent may write to.`);
      if (!exists(real)) throw new Error(`${abs} does not exist. Create it with write_file.`);
      const r = files.applyEdits(fs.readFileSync(real, 'utf8'), edits);
      fs.writeFileSync(real, r.text);
      return { text: `Edited ${abs}: ${r.replaced} replacement${r.replaced === 1 ? '' : 's'}.` };
    },
  },
  {
    name: 'find_files',
    group: 'files',
    risk: 'none',
    description:
      'Find files by name in your workspace or an allowed folder, newest first, e.g. pattern "*.md" (any folder), "notes/**/*.txt" or "report-*.{pdf,docx}".',
    parameters: obj(
      {
        pattern: str('Name pattern: * any characters, ** any folders, ? one character, {a,b} either'),
        path: str('Folder to look in (default: workspace)'),
      },
      ['pattern'],
    ),
    run: async ({ pattern, path: p = '.' }: { pattern: string; path?: string }, ctx) => {
      const { abs, real, ok } = resolveInside(ctx.agent, p);
      if (!ok) throw new Error(`${abs} is outside the folders this agent may use.`);
      return { text: files.findFiles(real, abs, String(pattern ?? '')) };
    },
  },
  {
    name: 'search_files',
    group: 'files',
    risk: 'none',
    description:
      'Search the text files in your workspace or an allowed folder (or one file) for lines that match words or a regular expression, any case. Returns file:line: text. Narrow it with glob, e.g. "*.md".',
    parameters: obj(
      {
        query: str('Words or a regular expression'),
        path: str('Folder or file to search (default: workspace)'),
        glob: str('Only files whose name matches, e.g. "*.ts" or "docs/**/*.md"'),
      },
      ['query'],
    ),
    run: async ({ query, path: p = '.', glob }: { query: string; path?: string; glob?: string }, ctx) => {
      const { abs, real, ok } = resolveInside(ctx.agent, p);
      if (!ok) throw new Error(`${abs} is outside the folders this agent may use.`);
      return { text: files.searchFiles(real, abs, String(query ?? ''), glob ? String(glob) : undefined) };
    },
  },
  // ---------- orca ----------
  {
    name: 'orca',
    group: 'orca',
    // Reading state is safe; anything else (spawning agents, terminals) needs a yes.
    risk: ({ args = [] }: { args?: string[] }) =>
      ['status', 'agent-context', 'search'].includes(args[0]) ||
      (args[0] === 'skills' && args[1] === 'list') ||
      (args[0] === 'reference' && ['list', 'find'].includes(args[1]))
        ? 'none'
        : 'high',
    description:
      'Run the Orca CLI with these arguments, e.g. ["status"], ["agent-context"] (prints every command), ["skills","list"].',
    parameters: obj({ args: { type: 'array', items: { type: 'string' } } }, ['args']),
    run: async ({ args }: { args: string[] }, ctx) => {
      const r = await run('orca', args, { timeout: 5 * 60_000, signal: ctx.signal });
      return {
        text: truncate((r.stdout + (r.stderr ? `\n${r.stderr}` : '')).trim() || `(exit ${r.code})`, 20000),
        isError: r.code !== 0,
      };
    },
  },
  // ---------- shell ----------
  {
    name: 'run_command',
    group: 'shell',
    risk: 'high',
    // the shell this computer has, looked up the first time the description is read
    get description() {
      return `Run a ${commandShell().name} command on this computer and return its exit code and output (the start and the end of long output). Starts in your workspace.`;
    },
    parameters: obj(
      {
        command: str("The command, in this computer's shell"),
        cwd: str('Working folder'),
        timeout_sec: { type: 'number', description: 'Up to 3600 (default 300)' },
      },
      ['command'],
    ),
    run: async ({ command, cwd, timeout_sec }: { command: string; cwd?: string; timeout_sec?: number }, ctx) => {
      const sh = commandShell();
      const timeout = Math.min(Math.max(Number(timeout_sec) || 300, 1), 3600) * 1000;
      // Python run from here prints UTF-8: the pipe is the Windows code page otherwise, and a name like "Łukasz" crashes it
      const env = { PYTHONUTF8: process.env.PYTHONUTF8 ?? '1' };
      const r = await run(sh.exe, sh.args(String(command ?? '')), {
        cwd: cwd || workspaceOf(ctx.agent),
        timeout,
        signal: ctx.signal,
        env,
      });
      return {
        text: `exit ${r.code}\n${truncateMiddle(r.stdout, 16000)}${r.stderr ? `\n[stderr]\n${truncateMiddle(r.stderr, 4000)}` : ''}`,
        isError: r.code !== 0,
      };
    },
  },
  // ---------- always on ----------
  {
    name: 'notify_user',
    group: 'core',
    risk: 'none',
    description:
      'Show the user a notification in the dashboard. For an external message, use gateway_draft or an explicitly approved gateway send.',
    parameters: obj({ text: str('Message') }, ['text']),
    run: async ({ text, telegram }: { text: string; telegram?: boolean }, ctx) => {
      if (telegram)
        throw new Error(
          'Telegram notifications now require a selected gateway recipient and approval. Use gateway_draft.',
        );
      emit('toast', { text: `${ctx.agent.name}: ${text}` });
      log('notify', `${ctx.agent.name}: ${text}`, { agentId: ctx.agent.id });
      return { text: 'The user has been notified.' };
    },
  },
];

const addGroup = (a: { toolGroups?: string[] }, id: string) => {
  a.toolGroups = [...new Set([...(a.toolGroups || []), id])];
};

// request_tool: the Brain looks first (see reviewApproval), and the user decides what it passes on.
// Given tools are kept on the agent and added to the run going now, so it can use them at once.
async function toolAccessRequest(
  ctx: ToolContext,
  id: string,
  why: string,
): Promise<{ result: ToolResult } | { group: ToolGroup; request: ApprovalRequest }> {
  const group = TOOL_GROUPS.find((g) => g.id === String(id || '').trim());
  if (!group)
    return {
      result: {
        text: `There is no "${id}" set of tools. The sets: ${TOOL_GROUPS.map((g) => g.id).join(', ')}.`,
        isError: true,
      },
    };
  const reason = String(why || '')
    .trim()
    .slice(0, 1000);
  if (!reason) return { result: { text: 'Say what you need these tools for (why).', isError: true } };
  // only the dashboard's own agents have tools to change (not workflows or outside MCP clients)
  if (!agentStore.get(ctx.agent.id))
    return {
      result: {
        text: "Only the dashboard's agents can ask for tools. Ask the user with ask_user instead.",
        isError: true,
      },
    };
  const { runInfo } = await import('./engines/index.ts');
  const run = ctx.runId ? runInfo(ctx.runId) : null;
  if (OWN_TOOL_GROUPS.has(group.id) && hasOwnFileTools(agentStore.get(ctx.agent.id)?.engine))
    return { result: { text: 'Your engine has its own tools for files and commands: use those.' } };
  if ([...(ctx.agent.toolGroups || []), ...(run?.agent.toolGroups || [])].includes(group.id))
    return { result: { text: `You already have the ${group.label} tools.` } };
  return {
    group,
    request: {
      kind: 'tools',
      title: `${ctx.agent.name} asks for the ${group.label} tools`,
      detail: `${reason}\n\n${group.label}: ${group.description}`,
      agentId: ctx.agent.id,
      agentName: ctx.agent.name,
      data: { group: group.id, args: { tools: group.id, why: reason }, runId: ctx.runId || null },
    },
  };
}

async function requestTools(ctx: ToolContext, id: string, why: string): Promise<ToolResult> {
  const check = await toolAccessRequest(ctx, id, why);
  if ('result' in check) return check.result;
  const { group, request } = check;
  const d = await (ctx.approvalDecision || requestApproval)(request);
  if (!d.approved)
    return {
      text: `Not given${d.message ? `: ${d.message}` : ''}. Don't ask for it again: do what you can without it, or ask the user with ask_user what to do instead.`,
      isError: true,
      denied: true,
    };
  const saved = agentStore.get(ctx.agent.id);
  if (saved) {
    addGroup(saved, group.id);
    agentStore.save(saved);
  }
  addGroup(ctx.agent, group.id);
  const { runInfo } = await import('./engines/index.ts');
  const run = ctx.runId ? runInfo(ctx.runId) : null;
  if (run) addGroup(run.agent, group.id);
  const names = TOOLS.filter((t) => t.group === group.id).map((t) => t.name);
  return {
    text: `Given: you now have the ${group.label} tools (${names.join(', ')}). Use them now. If you don't see them yet, they come with your next message.`,
  };
}

type LaunchArgs = { program: string; file?: string; args?: string[] };
type ComfyRunArgs = {
  workflow: string;
  prompt?: string;
  negative?: string;
  inputs?: Record<string, unknown>;
  images?: { file?: string; node?: string | number; mask?: string; mask_kind?: 'white' | 'transparent' }[];
  randomize_seed?: boolean;
};

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));
const ALIASES = new Map(
  TOOLS.flatMap((t) =>
    (t.aliases || []).map((a): [string, { tool: ToolDef; alias: ToolAlias }] => [a.name, { tool: t, alias: a }]),
  ),
);

/** A tool by its name or an earlier one, with the arguments in its current shape. */
function resolveTool(name: string, args: ToolArgs): { tool: ToolDef | undefined; args: ToolArgs } {
  const tool = BY_NAME.get(name);
  if (tool) return { tool, args };
  const old = ALIASES.get(name);
  return old ? { tool: old.tool, args: old.alias.args ? old.alias.args(args) : args } : { tool: undefined, args };
}

// The dashboard's file and shell tools do what these engines' own tools already do: listing both only makes
// the model choose. (Their own tools ask through the same approvals; Eve has none of its own.)
const OWN_TOOL_GROUPS = new Set(['files', 'shell']);
const hasOwnFileTools = (engine: string | undefined): boolean => !!engine && engine !== 'eve';

/** May this agent use the tool at all. Cheap: the knowledge folders are only looked at for knowledge tools. */
function mayUse(agent: ToolAgent, tool: ToolDef): boolean {
  if (tool.group === 'core' || (agent.toolGroups || []).includes(tool.group)) return true;
  // a memory of its own: real agents only (not stand-ins like workflows or outside MCP clients)
  if (tool.group === 'memory') return memory.hasMemory(agent);
  if (tool.group === 'knowledge') return kb.knowledgeFiles(agent).length > 0;
  return false;
}

export function toolsForAgent(agent: ToolAgent, scope: ToolScope = {}): ToolDef[] {
  const own = hasOwnFileTools(scope.engine);
  let knowledge: boolean | undefined;
  return TOOLS.filter((t) => {
    if (own && OWN_TOOL_GROUPS.has(t.group)) return false;
    if (t.when && !t.when(scope)) return false;
    if (t.group !== 'knowledge') return mayUse(agent, t);
    knowledge ??= mayUse(agent, t);
    return knowledge;
  });
}

export function toolDefs(agent: ToolAgent, scope: ToolScope = {}): ToolSpec[] {
  return toolsForAgent(agent, scope).map(({ name, description, parameters }) => ({ name, description, parameters }));
}

export const allTools = (): ToolListing[] =>
  TOOLS.map(({ name, group, risk, description }) => ({
    name,
    group,
    risk: typeof risk === 'function' ? 'varies' : risk,
    description,
  }));

export function needsApproval(agent: ToolAgent, risk: Risk, toolName: string): boolean {
  // "Always allow" never covers high-risk calls of tools whose risk depends on the arguments.
  if ((agent.alwaysAllow || []).includes(toolName)) return false;
  const mode = agent.autonomy || 'auto';
  if (mode === 'full') return false;
  if (mode === 'auto') return risk === 'high';
  return risk === 'low' || risk === 'high';
}

/** Asks in Needs you until the call is stopped or given up (an MCP client that cancelled it): then the question is
 *  taken back, so a yes given later runs nothing. */
async function askWhileWanted(request: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalDecision> {
  if (!signal) return requestApproval(request);
  if (signal.aborted) return { approved: false, message: 'Stopped.' };
  const ref = uid('call');
  const asked = requestApproval({ ...request, data: { ...request.data, callRef: ref } });
  const stop = () => withdrawApprovals((it) => it.data?.callRef === ref, 'The request was stopped.');
  signal.addEventListener('abort', stop, { once: true });
  try {
    return await asked;
  } finally {
    signal.removeEventListener('abort', stop);
  }
}

// Eve's policy and executor use the same request and original arguments.
export function toolApprovalRequest(
  agent: ToolAgent,
  name: string,
  args: ToolArgs,
  ctx: ToolRunInfo = {},
  detail?: string | null,
): ApprovalRequest {
  // an MCP tool of one account of several says which account: "… wants to use oomol-work__send on OOMOL: Work"
  const account = ctx.mcpServer ? accountOf(ctx.mcpServer) : '';
  return {
    kind: 'tool',
    title: `${agent.name} wants to use ${name}${account ? ` on ${account}` : ''}`,
    detail: detail ?? describeCall(name, args),
    agentId: agent.id,
    agentName: agent.name,
    data: {
      tool: name,
      args: ctx.approvalArgs || args,
      runId: ctx.runId,
      ...(ctx.approvalScope ? { scope: ctx.approvalScope } : {}),
    },
    operationId: ctx.operationId,
  };
}

// Ask when the agent's autonomy says so; null lets the tool go ahead.
export async function gate(
  agent: ToolAgent,
  name: string,
  risk: Risk,
  args: ToolArgs,
  ctx: ToolRunInfo = {},
  detail: string | null | undefined = null,
): Promise<ToolResult | null> {
  const grant = ctx.grantName || name;
  if (!needsApproval(agent, risk, grant)) return null;
  if (!ctx.approvalDecision) recordAsked(name);
  const d = await (ctx.approvalDecision ? ctx.approvalDecision : (r: ApprovalRequest) => askWhileWanted(r, ctx.signal))(
    toolApprovalRequest(agent, name, args, ctx, detail),
  );
  // (the call was stopped or given up while it waited: nothing runs, whatever the answer)
  if (ctx.signal?.aborted) return { text: 'Stopped.', isError: true, denied: true };
  if (!d.approved)
    return {
      text: `The user said no${d.message ? `: ${d.message}` : ''}. Don't retry the same thing; ask what they want instead.`,
      isError: true,
      denied: true,
    };
  if (d.always && agent.id && !agent.id.startsWith('_')) {
    // the run asking keeps going with this same agent: the yes counts for the rest of it too
    agent.alwaysAllow = [...new Set([...(agent.alwaysAllow || []), grant])];
    rememberAlwaysAllow(agent.id, [grant]);
  }
  return null;
}

/** How risky one call of a tool is (a tool given by name: unknown ones are high). */
export function riskOf(tool: ToolDef | string, args: ToolArgs = {}): Risk {
  const t = typeof tool === 'string' ? BY_NAME.get(tool) : tool;
  if (!t) return 'high';
  try {
    return typeof t.risk === 'function' ? t.risk(args) : t.risk;
  } catch {
    return 'high';
  }
}

export function toolApprovalName(name: string, args: ToolArgs): string {
  const tool = BY_NAME.get(name);
  return tool && typeof tool.risk === 'function' && riskOf(tool, args) === 'high' ? `${name}:high` : name;
}

/** Read every consent boundary before Eve opens its native approval checkpoint. */
export async function toolApprovalPlan(
  agent: ToolAgent,
  name: string,
  args: ToolArgs,
  ctx: ToolRunInfo,
): Promise<{ requests: ApprovalRequest[]; risk: Risk }> {
  let risk = riskOf(name, args);
  const requests: ApprovalRequest[] = [];
  const allowName = toolApprovalName(name, args);
  if (needsApproval(agent, risk, allowName)) requests.push(toolApprovalRequest(agent, allowName, args, ctx));
  if (name === 'request_tool') {
    const check = await toolAccessRequest({ ...ctx, agent }, String(args.tools || ''), String(args.why || ''));
    if ('request' in check) {
      requests.push(check.request);
      risk = 'high';
    }
  }
  for (const check of voxel.worldApprovalChecks(name, args, { ...ctx, agent })) {
    if (check.request) requests.push(check.request);
    if (check.risk === 'high') risk = 'high';
    if (check.name && needsApproval(agent, check.risk, check.name))
      requests.push(toolApprovalRequest(agent, check.name, args, { ...ctx, approvalScope: check.scope }, check.detail));
  }
  return { requests, risk };
}

// Run a tool for an agent, asking the user first when its settings say so.
export async function callTool(
  agent: ToolAgent,
  calledAs: string,
  rawArgs: ToolArgs = {},
  ctx: ToolRunInfo = {},
): Promise<ToolResult> {
  const resolved = resolveTool(calledAs, rawArgs && typeof rawArgs === 'object' ? rawArgs : {});
  const tool = resolved.tool;
  if (!tool) throw new Error(`Unknown tool ${calledAs}`);
  const name = tool.name;
  if (!mayUse(agent, tool))
    throw new Error(`${agent.name} isn't allowed to use ${name}. Turn on the "${tool.group}" tools for it.`);
  const args = resolved.args && typeof resolved.args === 'object' ? resolved.args : {};
  const risk = riskOf(tool, args);
  // For tools whose risk depends on arguments, "Always allow" only skips the low-risk form.
  const allowName = toolApprovalName(name, args);
  const refused = await gate(agent, allowName, risk, args, ctx, describeCall(name, args));
  if (refused) return refused;
  if (ctx.signal?.aborted) return { text: 'Stopped.', isError: true };
  const started = Date.now();
  let result: ToolResult;
  try {
    const r = await tool.run(args, { ...ctx, agent });
    result = {
      text: String(r?.text ?? ''),
      images: r?.images || [],
      isError: !!r?.isError,
      ...(r?.denied ? { denied: true } : {}),
    };
  } catch (e) {
    result = { text: `Error: ${(e as Error).message}`, isError: true };
  }
  recordToolCall(name, {
    ms: Date.now() - started,
    chars: result.text.length,
    isError: result.isError,
    denied: result.denied,
  });
  return result;
}

// Tools that read in parts already answer at a size the model chose (and task batches must stay whole).
const PAGED = new Set([
  'read_file',
  'read_document',
  'fetch_url',
  'read_conversation',
  'read_skill',
  'knowledge_read',
  'TaskCreate',
  'TaskUpdate',
]);
const SAVED_DAYS = 7;
let prunedAt = 0;

/** What the model gets back from a tool. A result over the limit (Settings › Context) keeps its start and its end;
 *  the whole text is saved in outputs/tool-results, where the agent can read the rest in parts. */
export function clipForModel(r: ToolResult, name: string, runId?: string | null): ToolResult {
  const most = Math.floor(Number(getSettings().toolResultChars) || 0);
  if (most <= 0 || r.text.length <= most || PAGED.has(name)) return r;
  const dir = ensureDir(dataPath('outputs', 'tool-results'));
  const file = path.join(
    dir,
    `${new Date().toISOString().replace(/[:.]/g, '-')}-${String(runId || 'call')
      .replace(/[^\w-]/g, '')
      .slice(0, 40)}-${name.replace(/[^\w-]/g, '_').slice(0, 60)}.txt`,
  );
  fs.writeFileSync(file, r.text);
  pruneSavedResults(dir);
  recordClipped(name);
  const head = Math.ceil(most * 0.7);
  const tail = most - head;
  return {
    ...r,
    text: `${r.text.slice(0, head)}\n\n…[${r.text.length - most} characters left out here. The whole result is saved in ${file}: read the rest there in parts if you need it.]…\n\n${r.text.slice(r.text.length - tail)}`,
  };
}

// (saved results older than a week go: the chat keeps its own copy)
function pruneSavedResults(dir: string): void {
  if (Date.now() - prunedAt < 24 * 60 * 60_000) return;
  prunedAt = Date.now();
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    try {
      const st = fs.lstatSync(p);
      if (st.isFile() && Date.now() - st.mtimeMs > SAVED_DAYS * 24 * 60 * 60_000) fs.rmSync(p, { force: true });
    } catch {
      /* gone */
    }
  }
}

function describeCall(name: string, args: ToolArgs): string | undefined {
  if (name === 'run_command') return args.command as string | undefined;
  if (name.endsWith('_run_script') || name.endsWith('_run_python')) return args.code as string | undefined;
  if (name === 'write_file') return `${args.path}\n\n${String(args.content || '').slice(0, 1500)}`;
  if (name === 'edit_file')
    return `${args.path}\n\n${(Array.isArray(args.edits) ? args.edits : [])
      .map((e: { old?: unknown; new?: unknown }) => `- ${String(e?.old ?? '')}\n+ ${String(e?.new ?? '')}`)
      .join('\n\n')
      .slice(0, 1500)}`;
  if (name === 'ffmpeg' || name === 'orca' || name === 'imagemagick')
    return `${name} ${((args.args as string[] | undefined) || []).join(' ')}`;
  return JSON.stringify(args, null, 2);
}

// ---------- helpers ----------
// Run a Python script with a program's own Python (mayapy, hython) and return what it printed.
async function runPython(exe: string, script: string, ctx: ToolContext): Promise<ToolResult> {
  if (!exists(exe)) throw new Error(`${path.basename(exe)} was not found next to the program.`);
  const file = tmpFile('script.py');
  fs.writeFileSync(file, script);
  const r = await run(exe, [file], { timeout: 30 * 60_000, signal: ctx.signal });
  return {
    text: `${r.code === 0 ? 'Finished' : `Failed (exit ${r.code})`}\n${truncate((r.stdout + '\n' + r.stderr).trim(), 12000)}`,
    isError: r.code !== 0,
  };
}

// A file an agent may read, as its real path.
function readablePath(ctx: ToolContext, p: string | undefined): string {
  const r = resolveInside(ctx.agent, p);
  if (!r.ok) throw new Error(`${r.abs} is outside the folders this agent may read.`);
  if (!exists(r.real)) throw new Error(`${r.abs} does not exist.`);
  return r.real;
}
// A file an agent may write (its folder is made), as its real path.
function writablePath(ctx: ToolContext, p: string | undefined): string {
  const r = resolveInside(ctx.agent, p, { write: true });
  if (!r.ok) throw new Error(`${r.abs} is outside the folders this agent may write to.`);
  ensureDir(path.dirname(r.real));
  return r.real;
}
function writableDir(ctx: ToolContext, p: string | undefined): string {
  const r = resolveInside(ctx.agent, p, { write: true });
  if (!r.ok) throw new Error(`${r.abs} is outside the folders this agent may write to.`);
  return ensureDir(r.real);
}

async function runJsx(appId: 'photoshop' | 'aftereffects', code: string): Promise<ToolResult> {
  const exe = programExe(appId);
  if (!exe)
    throw new Error(
      `${appId === 'photoshop' ? 'Photoshop' : 'After Effects'} was not found. Set its path in Settings.`,
    );
  const outFile = tmpFile('jsx-out.txt').replace(/\\/g, '/');
  const script = tmpFile('script.jsx');
  const wrapped = `#target ${appId === 'photoshop' ? 'photoshop' : 'aftereffects'}
(function(){
  var __f = new File(${JSON.stringify(outFile)});
  function log(v){ __f.encoding = "UTF-8"; __f.open("a"); __f.writeln(String(v)); __f.close(); }
  try {
    var __r = (function(){ ${code}
    })();
    if (__r !== undefined) log(__r);
  } catch (e) { log("ERROR: " + e + (e.line ? " (line " + e.line + ")" : "")); }
  log("__DONE__");
})();`;
  fs.writeFileSync(script, wrapped);
  if (appId === 'photoshop') launchDetached(exe, [script]);
  else launchDetached(exe, ['-r', script]);
  const started = Date.now();
  while (Date.now() - started < 5 * 60_000) {
    await new Promise((r) => setTimeout(r, 1000));
    if (exists(outFile)) {
      const t = fs.readFileSync(outFile, 'utf8');
      if (t.includes('__DONE__')) {
        const text = t.replace(/__DONE__\s*$/, '').trim();
        return { text: text || 'Script finished.', isError: /^ERROR:/m.test(text) };
      }
    }
  }
  return {
    text: 'The script was sent, but no answer came back within 5 minutes (the app may still be starting, or a dialog is open).',
    isError: true,
  };
}

export const TOOL_ROOT = ROOT;
export const HOME_DIR = HOME;
