// MCP servers: the dashboard connects to them for API-model agents and hands them to Claude Code agents.
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { HOME, IS_WIN, ROOT, PORT, dataPath, readJSON, writeJSON, which, exists } from './util.js';
import { emit, log, internalToken } from './store.js';

const FILE = dataPath('mcp.json');

export const PRESETS = [
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

export function listServers() {
  return readJSON(FILE, { servers: {} }).servers || {};
}

function saveAll(servers) {
  writeJSON(FILE, { servers });
  emit('mcp');
}

export function saveServer(name, cfg) {
  const clean = String(name).trim().replace(/[^\w-]/g, '-');
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

export function removeServer(name) {
  const servers = listServers();
  delete servers[name];
  saveAll(servers);
  disconnect(name);
}

// Windows can't spawn npx/uvx .cmd shims directly; resolve or wrap them.
function resolveCommand(command, args) {
  if (!IS_WIN) return { command, args };
  const found = which(command);
  if (found && /\.exe$/i.test(found)) return { command: found, args };
  return { command: process.env.ComSpec || 'cmd.exe', args: ['/c', command, ...args] };
}

// ---------- live connections ----------
const clients = new Map();

async function connect(name) {
  if (clients.has(name)) return clients.get(name);
  const cfg = name === 'dashboard' ? null : listServers()[name];
  if (!cfg) throw new Error(`No MCP server named "${name}".`);
  const job = (async () => {
    const client = new Client({ name: 'my-dashboard', version: '0.1.0' });
    if (cfg.type === 'stdio') {
      const { command, args } = resolveCommand(cfg.command, cfg.args || []);
      // stderr ignored: an unread pipe fills up and freezes the server process.
      const transport = new StdioClientTransport({ command, args, env: { ...process.env, ...(cfg.env || {}) }, stderr: 'ignore' });
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
    throw new Error(`Couldn't start MCP server "${name}": ${e.message}`);
  }
}

export async function disconnect(name) {
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

export async function listTools(name) {
  const client = await connect(name);
  const r = await withTimeout(client.listTools(), 60000, `${name} took too long to list its tools`);
  return r.tools || [];
}

export async function callTool(server, tool, args) {
  const client = await connect(server);
  const r = await withTimeout(client.callTool({ name: tool, arguments: args || {} }, undefined, { timeout: 10 * 60_000, resetTimeoutOnProgress: true }), 10 * 60_000, `${server}.${tool} took over 10 minutes`);
  const texts = [];
  const images = [];
  for (const c of r.content || []) {
    if (c.type === 'text') texts.push(c.text);
    else if (c.type === 'image') images.push(`data:${c.mimeType};base64,${c.data}`);
    else if (c.type === 'resource') texts.push(c.resource?.text || `[resource ${c.resource?.uri}]`);
    else texts.push(JSON.stringify(c).slice(0, 2000));
  }
  if (r.structuredContent && !texts.length) texts.push(JSON.stringify(r.structuredContent, null, 2));
  return { text: (r.isError ? 'ERROR: ' : '') + texts.join('\n'), images };
}

function withTimeout(p, ms, msg) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);
}

export async function testServer(name) {
  const tools = await listTools(name);
  return tools.map((t) => ({ name: t.name, description: (t.description || '').slice(0, 300) }));
}

// ---------- import from Claude configs ----------
export function importableServers() {
  const found = [];
  const add = (source, servers) => {
    for (const [name, cfg] of Object.entries(servers || {})) {
      found.push({ source, name, type: cfg.type === 'http' || cfg.type === 'sse' || cfg.url ? 'http' : 'stdio', command: cfg.command, args: cfg.args || [], env: cfg.env || {}, url: cfg.url, headers: cfg.headers || {} });
    }
  };
  const claudeJson = readJSON(path.join(HOME, '.claude.json'), null);
  if (claudeJson) {
    add('Claude Code (user)', claudeJson.mcpServers);
    for (const [proj, p] of Object.entries(claudeJson.projects || {})) add(`Claude Code (${path.basename(proj)})`, p.mcpServers);
  }
  const desktop = readJSON(path.join(process.env.APPDATA || '', 'Claude', 'claude_desktop_config.json'), null);
  if (desktop) add('Claude Desktop', desktop.mcpServers);
  return found;
}

// ---------- config handed to Claude Code agents ----------
export function bridgeServerConfig(agentId, runId = '') {
  return {
    command: process.execPath,
    args: [path.join(ROOT, 'server', 'mcp-bridge.js')],
    env: { DASH_PORT: String(PORT), DASH_TOKEN: internalToken(), DASH_AGENT: agentId || '', ...(runId ? { DASH_RUN: runId } : {}) },
  };
}

export function claudeMcpConfig(agentId, serverNames = [], runId = '') {
  const all = listServers();
  const mcpServers = { dashboard: bridgeServerConfig(agentId, runId) };
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

export const hasBridge = () => exists(path.join(ROOT, 'server', 'mcp-bridge.js'));
