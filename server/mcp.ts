// MCP servers: the dashboard connects to them for API-model agents and hands them to Claude Code agents.
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { HOME, IS_WIN, BRIDGE_SCRIPT, PORT, dataPath, readJSON, writeJSON, which, exists } from './util.ts';
import { emit, log, internalToken, agents, workflows, listProjects, withProject } from './store.ts';

/** One saved MCP server (data/mcp.json). */
export interface McpServerConfig {
  type: 'stdio' | 'http' | string;
  command: string;
  args: string[];
  env: Record<string, string>;
  url: string;
  headers: Record<string, string>;
  description: string;
  enabled: boolean;
}
export type McpServers = Record<string, McpServerConfig>;

/** What saveServer() accepts: a form body, a preset or an importable server. args may be one string. */
export interface McpServerInput {
  type?: string;
  command?: string;
  args?: string[] | string;
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  description?: string;
  enabled?: boolean;
}

export type McpPreset = { name: string; title: string; description: string } & (
  | { type: 'stdio'; command: string; args: string[] }
  | { type: 'http'; url: string; headers: Record<string, string> }
);

export interface ImportableServer {
  source: string;
  name: string;
  type: 'http' | 'stdio';
  command?: string;
  args: string[];
  env: Record<string, string>;
  url?: string;
  headers: Record<string, string>;
}

export type McpTool = Tool;
export interface McpToolResult {
  text: string;
  images: string[];
}

/** How Claude Code is told to start one MCP server (--mcp-config). */
export type ClaudeMcpServer = { command: string; args: string[]; env: Record<string, string> } | { type: 'http'; url: string; headers: Record<string, string> };

/** A server entry in someone else's config (~/.claude.json, Claude Desktop): anything goes. */
interface ForeignServer {
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}
interface ClaudeJson {
  mcpServers?: Record<string, ForeignServer>;
  projects?: Record<string, { mcpServers?: Record<string, ForeignServer> }>;
}

const FILE = dataPath('mcp.json');

export const PRESETS: McpPreset[] = [
  {
    name: 'playwright',
    title: 'Browser control (Playwright)',
    description: 'Open pages, click, type, fill forms, read and screenshot sites in a real browser.',
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest'],
  },
  {
    name: 'chrome-devtools',
    title: 'Chrome DevTools',
    description: 'Drive Chrome through DevTools: navigate, inspect, network, performance traces.',
    type: 'stdio',
    command: 'npx',
    args: ['-y', 'chrome-devtools-mcp@latest'],
  },
  {
    name: 'filesystem',
    title: 'Files (Desktop)',
    description: 'Read and write files under your Desktop folder.',
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', path.join(HOME, 'Desktop')],
  },
  { name: 'fetch', title: 'Web fetch', description: 'Fetch any URL and convert it to markdown.', type: 'stdio', command: 'uvx', args: ['mcp-server-fetch'] },
  { name: 'memory', title: 'Memory graph', description: 'A persistent knowledge graph agents can write to and recall.', type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] },
  {
    name: 'sequential-thinking',
    title: 'Sequential thinking',
    description: 'Step-by-step reasoning scratchpad for hard problems.',
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
  },
  {
    name: 'blender',
    title: 'Blender (live)',
    description: 'Control a running Blender scene. Needs the blender-mcp add-on installed and connected inside Blender (github.com/ahujasid/blender-mcp).',
    type: 'stdio',
    command: 'uvx',
    args: ['blender-mcp'],
  },
  {
    name: 'hermes',
    title: 'Hermes conversations',
    description: 'Lets other agents read and talk to your Hermes conversations (hermes mcp serve).',
    type: 'stdio',
    command: 'hermes',
    args: ['mcp', 'serve'],
  },
  {
    name: 'github',
    title: 'GitHub (remote)',
    description: 'Issues, PRs, code search. Put a GitHub token in the Authorization header.',
    type: 'http',
    url: 'https://api.githubcopilot.com/mcp/',
    headers: { Authorization: 'Bearer YOUR_GITHUB_TOKEN' },
  },
];

export function listServers(): McpServers {
  return readJSON<{ servers?: McpServers }>(FILE, { servers: {} }).servers || {};
}

function saveAll(servers: McpServers) {
  writeJSON(FILE, { servers });
  emit('mcp');
}

/** A server's name as it is saved: letters, digits, _ and - only. */
export const serverName = (name: unknown): string => String(name ?? '').trim().replace(/[^\w-]/g, '-');

export function saveServer(name: string, cfg: McpServerInput): McpServerConfig {
  const clean = serverName(name);
  if (!clean) throw new Error('Give the server a name.');
  if (clean === 'dashboard') throw new Error('"dashboard" is reserved for the built-in tools.');
  const servers = listServers();
  servers[clean] = {
    type: cfg.type || (cfg.url ? 'http' : 'stdio'),
    command: cfg.command || '',
    args: Array.isArray(cfg.args) ? cfg.args : String(cfg.args || '').split(/\s+/).filter(Boolean),
    env: cfg.env || {},
    url: cfg.url || '',
    headers: cfg.headers || {},
    description: cfg.description || '',
    enabled: cfg.enabled !== false,
  };
  saveAll(servers);
  disconnect(clean);
  log('mcp', `Saved MCP server "${clean}"`);
  return servers[clean];
}

export function removeServer(name: string) {
  const servers = listServers();
  delete servers[name];
  saveAll(servers);
  disconnect(name);
}

// Agents and teams name their servers, so a removed or renamed server changes on all of them, in every project.
function renameOnEveryone(from: string, to: string | null) {
  const swap = (list: string[] | undefined): string[] | null => (list || []).includes(from) ? [...new Set((list || []).map((x) => (x === from ? to : x)).filter((x): x is string => Boolean(x)))] : null;
  for (const p of listProjects()) {
    withProject(p, () => {
      for (const a of agents.list()) {
        const next = swap(a.mcpServers);
        if (next) agents.save({ ...a, mcpServers: next });
      }
      for (const w of workflows.list()) {
        const next = swap(w.access?.mcpServers);
        if (next) workflows.save({ ...w, access: { toolGroups: w.access?.toolGroups || [], mcpServers: next } });
      }
    });
  }
}

/** Remove a server and take it off every agent and team that had it. */
export function removeServerEverywhere(name: string) {
  removeServer(name);
  renameOnEveryone(name, null);
  log('mcp', `Removed MCP server "${name}"`);
}

/** Give a server a new name, on every agent and team that has it too. Returns the name it got. */
export function renameServer(from: string, to: string): string {
  const servers = listServers();
  const cfg = servers[from];
  if (!cfg) throw new Error(`No MCP server named "${from}".`);
  const clean = serverName(to);
  if (clean === from) return from;
  if (servers[clean]) throw new Error(`There already is an MCP server named "${clean}".`);
  saveServer(clean, cfg);
  removeServer(from);
  renameOnEveryone(from, clean);
  log('mcp', `Renamed MCP server "${from}" to "${clean}"`);
  return clean;
}

// Windows can't spawn npx/uvx .cmd shims directly; resolve or wrap them.
function resolveCommand(command: string, args: string[]): { command: string; args: string[] } {
  if (!IS_WIN) return { command, args };
  const found = which(command);
  if (found && /\.exe$/i.test(found)) return { command: found, args };
  return { command: process.env.ComSpec || 'cmd.exe', args: ['/c', command, ...args] };
}

// ---------- live connections ----------
const clients = new Map<string, Promise<Client>>();

async function connect(name: string): Promise<Client> {
  if (clients.has(name)) return clients.get(name)!;
  const cfg = name === 'dashboard' ? null : listServers()[name];
  if (!cfg) throw new Error(`No MCP server named "${name}".`);
  const job = (async () => {
    const client = new Client({ name: 'my-dashboard', version: '0.1.0' });
    if (cfg.type === 'stdio') {
      const { command, args } = resolveCommand(cfg.command, cfg.args || []);
      // stderr ignored: an unread pipe fills up and freezes the server process.
      const transport = new StdioClientTransport({ command, args, env: { ...process.env, ...(cfg.env || {}) } as Record<string, string>, stderr: 'ignore' });
      await client.connect(transport);
    } else {
      const url = new URL(cfg.url);
      const requestInit = { headers: cfg.headers || {} };
      try {
        await client.connect(new StreamableHTTPClientTransport(url, { requestInit }));
      } catch (e) {
        // Older servers only speak SSE.
        const c2 = new Client({ name: 'my-dashboard', version: '0.1.0' });
        await c2.connect(new SSEClientTransport(url, { requestInit }));
        c2.onclose = () => clients.delete(name);
        return c2;
      }
    }
    // A server that crashed is started fresh next time.
    client.onclose = () => clients.delete(name);
    return client;
  })();
  clients.set(name, job);
  try {
    return await job;
  } catch (e) {
    clients.delete(name);
    throw new Error(`Couldn't start MCP server "${name}": ${(e as Error).message}`);
  }
}

export async function disconnect(name: string) {
  const job = clients.get(name);
  clients.delete(name);
  if (job) {
    try {
      (await job).close();
    } catch {
      /* already closed */
    }
  }
}

export async function listTools(name: string): Promise<McpTool[]> {
  const client = await connect(name);
  const r = await withTimeout(client.listTools(), 60000, `${name} took too long to list its tools`);
  return r.tools || [];
}

export async function callTool(server: string, tool: string, args?: Record<string, unknown> | null): Promise<McpToolResult> {
  const client = await connect(server);
  // The SDK's return type also covers the old { toolResult } shape; servers today send CallToolResult.
  const r = (await withTimeout(client.callTool({ name: tool, arguments: args || {} }, undefined, { timeout: 10 * 60_000, resetTimeoutOnProgress: true }), 10 * 60_000, `${server}.${tool} took over 10 minutes`)) as CallToolResult;
  const texts: string[] = [];
  const images: string[] = [];
  for (const c of r.content || []) {
    if (c.type === 'text') texts.push(c.text);
    else if (c.type === 'image') images.push(`data:${c.mimeType};base64,${c.data}`);
    else if (c.type === 'resource') {
      const res = c.resource as { text?: string; uri?: string } | undefined;
      texts.push(res?.text || `[resource ${res?.uri}]`);
    }
    else texts.push(JSON.stringify(c).slice(0, 2000));
  }
  if (r.structuredContent && !texts.length) texts.push(JSON.stringify(r.structuredContent, null, 2));
  return { text: (r.isError ? 'ERROR: ' : '') + texts.join('\n'), images };
}

function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);
}

export async function testServer(name: string): Promise<{ name: string; description: string }[]> {
  const tools = await listTools(name);
  return tools.map((t) => ({ name: t.name, description: (t.description || '').slice(0, 300) }));
}

// ---------- import from Claude configs ----------
export function importableServers(): ImportableServer[] {
  const found: ImportableServer[] = [];
  const add = (source: string, servers: Record<string, ForeignServer> | undefined) => {
    for (const [name, cfg] of Object.entries(servers || {})) {
      found.push({ source, name, type: cfg.type === 'http' || cfg.type === 'sse' || cfg.url ? 'http' : 'stdio', command: cfg.command, args: cfg.args || [], env: cfg.env || {}, url: cfg.url, headers: cfg.headers || {} });
    }
  };
  const claudeJson = readJSON<ClaudeJson>(path.join(HOME, '.claude.json'), null);
  if (claudeJson) {
    add('Claude Code (user)', claudeJson.mcpServers);
    for (const [proj, p] of Object.entries(claudeJson.projects || {})) add(`Claude Code (${path.basename(proj)})`, p.mcpServers);
  }
  const desktop = readJSON<ClaudeJson>(path.join(process.env.APPDATA || '', 'Claude', 'claude_desktop_config.json'), null);
  if (desktop) add('Claude Desktop', desktop.mcpServers);
  return found;
}

// ---------- config handed to Claude Code agents ----------
export interface BridgeServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}
export function bridgeServerConfig(agentId: string | null | undefined, runId = ''): BridgeServerConfig {
  return {
    command: process.execPath,
    args: [BRIDGE_SCRIPT],
    env: { DASH_PORT: String(PORT), DASH_TOKEN: internalToken(), DASH_AGENT: agentId || '', ...(runId ? { DASH_RUN: runId } : {}) },
  };
}

export function claudeMcpConfig(agentId: string | null | undefined, serverNames: string[] = [], runId = ''): { mcpServers: Record<string, ClaudeMcpServer> } {
  const all = listServers();
  const mcpServers: Record<string, ClaudeMcpServer> = { dashboard: bridgeServerConfig(agentId, runId) };
  for (const n of serverNames) {
    const cfg = all[n];
    if (!cfg || cfg.enabled === false) continue;
    if (cfg.type === 'stdio') {
      const { command, args } = resolveCommand(cfg.command, cfg.args || []);
      mcpServers[n] = { command, args, env: cfg.env || {} };
    } else mcpServers[n] = { type: 'http', url: cfg.url, headers: cfg.headers || {} };
  }
  return { mcpServers };
}

export function presetAvailability() {
  return PRESETS.map((p) => ({ ...p, ready: p.type === 'http' || !!which(p.command), installed: !!listServers()[p.name] }));
}

export const hasBridge = () => exists(BRIDGE_SCRIPT);
