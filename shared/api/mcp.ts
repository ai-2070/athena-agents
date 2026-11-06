// MCP servers and the engines' own setup (server/api/mcp.ts): the servers agents can use, ready-made ones, importing
// one from a Claude config, testing one, the dashboard's own bridge, and setting up Codex, Hermes, pi and OpenClaw
// (installing, signing in, giving them the dashboard's tools, their profiles and agents).
import { oc, type } from '@orpc/contract';
import { z } from 'zod';
import type { BridgeServerConfig, CodexResetResult, EngineStatus, HermesProfile, McpOverview, McpServerConfig, OpenClawAgent } from '../types.ts';

const pairs = (field: string) => z.record(z.string(), z.string(), { error: `${field} must be names and values.` }).optional();
const notes = { label: z.string({ error: 'The label must be text.' }).optional(), useFor: z.string({ error: '"Use for" must be text.' }).optional() };
const message = type<{ message: string }>();

export const mcp = {
  list: oc.route({ method: 'GET', path: '/mcp' }).output(type<McpOverview>()),
  /** The bridge's config with its token, to copy into another MCP client. */
  bridge: oc.route({ method: 'POST', path: '/mcp-bridge' }).output(type<BridgeServerConfig>()),
  /** Adds or changes a server. args may be one string. */
  save: oc.route({ method: 'POST', path: '/mcp' })
    .input(z.object({
      name: z.string({ error: 'Give the server a name.' }),
      type: z.string().optional(),
      command: z.string({ error: 'The command must be text.' }).optional(),
      args: z.union([z.array(z.string()), z.string()], { error: 'The arguments must be text.' }).optional(),
      env: pairs('env'),
      url: z.string({ error: 'The address must be text.' }).optional(),
      headers: pairs('headers'),
      description: z.string().optional(),
      enabled: z.boolean({ error: 'enabled must be true or false.' }).optional(),
      kind: z.string().optional(),
      ...notes,
    }))
    .output(type<McpServerConfig>()),
  /** Removes it, and takes it off every agent and team that had it. */
  remove: oc.route({ method: 'DELETE', path: '/mcp/{name}' }).input(z.object({ name: z.string() })).output(type<{ ok: true }>()),
  /** Starts it and lists its tools. */
  test: oc.route({ method: 'POST', path: '/mcp/{name}/test' }).input(z.object({ name: z.string() })).output(type<{ tools: { name: string; description: string }[] }>()),
  /** A ready-made server; another copy of a service needs a label. others: the label and "use for" of the copies
   *  already there. */
  addPreset: oc.route({ method: 'POST', path: '/mcp-preset' })
    .input(z.object({ name: z.string({ error: 'Unknown preset' }), ...notes, others: z.record(z.string(), z.object(notes)).optional() }))
    .output(type<{ name: string; server: McpServerConfig }>()),
  /** One a Claude config has (name and source as GET /api/mcp lists it). */
  import: oc.route({ method: 'POST', path: '/mcp-import' })
    .input(z.object({ name: z.string(), source: z.string() }))
    .output(type<McpServerConfig>()),
};

export const engines = {
  hermesProfiles: oc.route({ method: 'GET', path: '/hermes/profiles' }).output(type<HermesProfile[]>()),
  /** Gives Hermes the dashboard's tools (hermes mcp add dashboard). */
  hermesBridge: oc.route({ method: 'POST', path: '/hermes/add-bridge' }).output(message),
  /** Gives pi and oh-my-pi (flavor: only one of them) the dashboard's tools, in their own mcp.json. */
  piBridge: oc.route({ method: 'POST', path: '/pi/add-bridge' })
    .input(z.object({ flavor: z.enum(['pi', 'omp']).optional() }))
    .output(type<{ message: string; files: string[] }>()),
  openclawAgents: oc.route({ method: 'GET', path: '/openclaw/agents' }).output(type<OpenClawAgent[]>()),
  /** Installs the Codex CLI (npm), then it needs signing in. */
  codexInstall: oc.route({ method: 'POST', path: '/codex/install' }).output(message),
  /** Looks again whether Codex is installed and signed in. */
  codexRefresh: oc.route({ method: 'POST', path: '/codex/refresh' }).output(type<EngineStatus['codex']>()),
  /** Uses one free Codex limit reset (the one that runs out first, unless one is named). */
  codexReset: oc.route({ method: 'POST', path: '/codex/reset' })
    .input(z.object({ creditId: z.string().nullable().optional() }))
    .output(type<CodexResetResult>()),
};
