// MCP servers: the dashboard connects to them for API-model agents and hands them to Claude Code agents.
import fs from 'node:fs';
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

export type McpPreset = { name: string; title: string; description: string; /** What to do outside the dashboard before it works (an editor plugin, a program), for the Brain to pass on. */ setup?: string } & (
  | { type: 'stdio'; command: string; args: string[]; env?: Record<string, string> }
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
    description: 'Control a running Blender scene. Its Blender add-on can also bring in Poly Haven, Sketchfab and Poly Pizza assets and make models with Tripo, Meshy, Hyper3D Rodin or Hunyuan3D: tick them in the add-on\'s panel (N key > MCP for Blender). Needs the add-on from github.com/ahujasid/mcp-for-blender installed and connected inside Blender.',
    type: 'stdio',
    command: 'uvx',
    args: ['mcp-for-blender'],
    env: { DISABLE_TELEMETRY: 'true' },
    setup: 'install the add-on from github.com/ahujasid/mcp-for-blender in Blender, then click Connect in its panel (N key > MCP for Blender)',
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
  // Docs and web search
  {
    name: 'context7',
    title: 'Library docs (Context7)',
    description: 'Up-to-date documentation and code examples for the libraries and frameworks you use, so agents stop guessing at old APIs. No key needed.',
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@upstash/context7-mcp'],
  },
  {
    name: 'brave-search',
    title: 'Web search (Brave)',
    description: 'Search the web, news, images and videos. Needs a free Brave Search API key: add it as BRAVE_API_KEY after adding.',
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@brave/brave-search-mcp-server'],
    env: { BRAVE_API_KEY: 'YOUR_API_KEY' },
  },
  {
    name: 'firecrawl',
    title: 'Web scraping (Firecrawl)',
    description: 'Turn whole sites and pages into clean text, and crawl or search them. Needs a Firecrawl key: add it as FIRECRAWL_API_KEY after adding.',
    type: 'stdio',
    command: 'npx',
    args: ['-y', 'firecrawl-mcp'],
    env: { FIRECRAWL_API_KEY: 'YOUR_API_KEY' },
  },
  // Work tools
  {
    name: 'notion',
    title: 'Notion',
    description: 'Read and write your Notion pages and databases. Needs an integration token (notion.so/profile/integrations): add it as NOTION_TOKEN after adding, and share the pages with the integration.',
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@notionhq/notion-mcp-server'],
    env: { NOTION_TOKEN: 'YOUR_NOTION_TOKEN' },
  },
  {
    name: 'linear',
    title: 'Linear (remote)',
    description: 'Issues, projects and comments in Linear. Put a Linear API key in the Authorization header after adding.',
    type: 'http',
    url: 'https://mcp.linear.app/mcp',
    headers: { Authorization: 'Bearer YOUR_LINEAR_API_KEY' },
  },
  // Games and audio
  {
    name: 'unity',
    title: 'Unity (live editor)',
    description: 'Control a running Unity editor: scenes, objects, assets, scripts. Needs the "MCP for Unity" package installed in your Unity project (Window > MCP for Unity) and its bridge started there.',
    type: 'stdio',
    command: 'uvx',
    args: ['--from', 'mcpforunityserver', 'mcp-for-unity', '--transport', 'stdio'],
    setup: 'install the "MCP for Unity" package in the Unity project (Window > MCP for Unity) and start its bridge there',
  },
  {
    name: 'unreal',
    title: 'Unreal Engine (live editor)',
    description: 'Control a running Unreal Engine 5 editor (third-party, no plugin to compile). In Unreal turn on the Python Editor Script Plugin and Remote Execution, then restart the editor. Unreal 5.8 also has an experimental official MCP plugin.',
    type: 'stdio',
    command: 'uvx',
    args: ['uemcp'],
    setup: 'in Unreal Engine 5 turn on the Python Editor Script Plugin and Remote Execution, then restart the editor',
  },
  {
    name: 'godot',
    title: 'Godot',
    description: 'Launch the Godot editor, run projects, read debug output and edit scenes. If Godot is not found on its own, add GODOT_PATH (the full path to the Godot program) after adding.',
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@coding-solo/godot-mcp'],
    setup: 'Godot has to be installed; if it is not found on its own, set GODOT_PATH to the full path of the Godot program',
  },
  {
    name: 'elevenlabs',
    title: 'ElevenLabs voices and sound',
    description: 'Text to speech, voice cloning, sound effects and audio transcription. Needs an ElevenLabs API key: add it as ELEVENLABS_API_KEY after adding. Generating audio uses your ElevenLabs credits.',
    type: 'stdio',
    command: 'uvx',
    args: ['elevenlabs-mcp'],
    env: { ELEVENLABS_API_KEY: 'YOUR_API_KEY' },
  },
  // 3D, textures and animation
  {
    name: 'maya',
    title: 'Maya (live)',
    description: 'Control a running Maya: scenes, objects, selection, animation keys, cameras, renders (third-party, github.com/GimbalGoats/GG_MayaMCP). In Maya open a command port first. Running your own scripts through it stays off unless you add MAYA_MCP_ENABLE_RAW_EXECUTION=true.',
    type: 'stdio',
    command: 'uvx',
    args: ['maya-mcp'],
    setup: "in Maya's Script Editor (Python) run cmds.commandPort(name=':7001', sourceType='python') each session",
  },
  {
    name: 'houdini',
    title: 'Houdini (live)',
    description: 'Control a running Houdini: nodes and networks, parameters, simulations, renders, USD and Solaris (third-party, github.com/healkeiser/fxhoudinimcp). Install its Houdini side once, then restart Houdini; it listens on port 8100.',
    type: 'stdio',
    command: 'uvx',
    args: ['fxhoudinimcp'],
    setup: 'install the Houdini side once (pip install fxhoudinimcp, then python -m fxhoudinimcp install) and restart Houdini',
  },
  {
    name: 'substance-painter',
    title: 'Substance 3D Painter (live)',
    description: 'Control a running Substance 3D Painter: texture sets, layers, fill and paint, bake maps, export textures (third-party, github.com/elliezu/SubstancePainterMCP). Painter has to be started with remote scripting on (the substance_open tool does that).',
    type: 'stdio',
    command: 'uvx',
    args: ['--from', 'git+https://github.com/elliezu/SubstancePainterMCP', 'substance-painter-mcp'],
    setup: 'start Painter with --enable-remote-scripting (the dashboard does this when an agent opens it with substance_open)',
  },
  {
    name: 'tripo',
    title: 'Tripo 3D (AI models)',
    description: 'Turn a prompt or an image into a 3D model (GLB, FBX…), then texture, rig, animate or convert it (Tripo\'s own command-line tool, tripo-cli). Needs a Tripo API key (developers.tripo3d.ai): add it as TRIPO_API_KEY after adding. Uses your Tripo credits.',
    type: 'stdio',
    command: 'npx',
    args: ['-y', 'tripo-cli', 'mcp'],
    env: { TRIPO_API_KEY: 'YOUR_API_KEY', TRIPO_ANALYTICS_ENABLED: '0' },
  },
  {
    name: 'meshy',
    title: 'Meshy (AI models and textures)',
    description: 'Make 3D models from text or images, retexture, remesh and rig them (Meshy\'s own server). Needs a Meshy API key from a Pro plan or above (meshy.ai/developers/keys): add it as MESHY_API_KEY after adding. Uses your Meshy credits.',
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@meshy-ai/meshy-mcp-server'],
    env: { MESHY_API_KEY: 'YOUR_API_KEY' },
  },
  {
    name: 'sketchfab',
    title: 'Sketchfab models',
    description: 'Search Sketchfab for 3D models, see their details and licences, and download the downloadable ones (third-party, github.com/gregkop/sketchfab-mcp-server). Needs your Sketchfab API token (sketchfab.com/settings/password, free account): add it as SKETCHFAB_API_KEY after adding. Check each model\'s licence before using it.',
    type: 'stdio',
    command: 'npx',
    args: ['-y', 'sketchfab-mcp-server'],
    env: { SKETCHFAB_API_KEY: 'YOUR_API_TOKEN' },
  },
  // CAD and 3D printing
  {
    name: 'freecad',
    title: 'FreeCAD (live)',
    description: 'Build and change parts in a running FreeCAD: sketches, solids, documents, screenshots of the view (third-party, github.com/neka-nat/freecad-mcp). Needs its FreeCAD add-on and Python 3.12 or newer.',
    type: 'stdio',
    command: 'uvx',
    args: ['freecad-mcp'],
    setup: 'copy the addon/FreeCADMCP folder from github.com/neka-nat/freecad-mcp into FreeCAD\'s Mod folder, then in FreeCAD pick the "MCP Addon" workbench and click Start RPC Server',
  },
  {
    name: 'rhino',
    title: 'Rhino and Grasshopper (live)',
    description: 'Create and change objects, layers and Grasshopper definitions in a running Rhino (third-party, github.com/jingcheng-chen/rhinomcp).',
    type: 'stdio',
    command: 'uvx',
    args: ['rhinomcp'],
    setup: 'in Rhino install "rhinomcp" from the Package Manager, then type the mcpstart command',
  },
  {
    name: 'openscad',
    title: 'OpenSCAD',
    description: 'Write OpenSCAD models, render them to STL and preview images (third-party, github.com/robertcoop/openscad-mcp). If OpenSCAD is not found on its own, add OPENSCAD_PATH (the full path to openscad) after adding.',
    type: 'stdio',
    command: 'uvx',
    args: ['openscad-mcp'],
    setup: 'OpenSCAD has to be installed',
  },
  {
    name: '3d-printer',
    title: '3D printer (OctoPrint, Klipper, Bambu, Prusa…)',
    description: 'Check a 3D printer, upload files, start and cancel prints, set temperatures (third-party, github.com/DMontgomery40/mcp-3D-printer-server). Add PRINTER_TYPE (octoprint, klipper, bambu, prusa, duet, repetier or creality), PRINTER_HOST (its address) and API_KEY after adding; Bambu printers use BAMBU_SERIAL, BAMBU_TOKEN (the LAN access code) and BAMBU_MODEL instead of API_KEY. It asks before it prints.',
    type: 'stdio',
    command: 'npx',
    args: ['-y', 'mcp-3d-printer-server'],
    env: { PRINTER_TYPE: 'YOUR_PRINTER_TYPE', PRINTER_HOST: 'YOUR_PRINTER_ADDRESS', API_KEY: 'YOUR_API_KEY' },
  },
  // Stock images, design and fonts
  {
    name: 'unsplash',
    title: 'Unsplash photos',
    description: 'Search free Unsplash photos and get their links, credits and download counts (third-party, github.com/hanoak/unsplash-mcp-server). Needs a free Unsplash access key (unsplash.com/developers): add it as UNSPLASH_ACCESS_KEY after adding. Unsplash asks you to credit the photographer.',
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@hanoak/unsplash-mcp-server'],
    env: { UNSPLASH_ACCESS_KEY: 'YOUR_ACCESS_KEY' },
  },
  {
    name: 'pixabay',
    title: 'Pixabay photos and videos',
    description: 'Search free Pixabay images, illustrations, vectors and videos (third-party, github.com/hanoak/pixabay-mcp-server). Needs a free Pixabay key (pixabay.com/api/docs, shown after you log in): add it as PIXABAY_API_KEY after adding.',
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@hanoak/pixabay-mcp-server'],
    env: { PIXABAY_API_KEY: 'YOUR_API_KEY' },
  },
  {
    name: 'pexels',
    title: 'Pexels photos and videos',
    description: 'Search free Pexels photos, videos and collections (third-party, github.com/hanoak/pexels-mcp-server). Needs a free Pexels key (pexels.com/api): add it as PEXELS_API_KEY after adding.',
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@hanoak/pexels-mcp-server'],
    env: { PEXELS_API_KEY: 'YOUR_API_KEY' },
  },
  {
    name: 'canva',
    title: 'Canva',
    description: 'Search, create and edit your Canva designs, export them, use your brand kits (Canva\'s own server). The first time it runs, a browser window opens to sign in to Canva.',
    type: 'stdio',
    command: 'npx',
    args: ['-y', 'mcp-remote', 'https://mcp.canva.com/mcp'],
    setup: 'sign in to Canva in the browser window that opens the first time it runs',
  },
  {
    name: 'freepik',
    title: 'Freepik / Magnific',
    description: 'Search and download Freepik stock photos, vectors and icons, and make AI images and videos (Freepik\'s own server; Freepik is now called Magnific). The first time it runs, a browser window opens to sign in. Downloads and AI use your account\'s credits.',
    type: 'stdio',
    command: 'npx',
    args: ['-y', 'mcp-remote', 'https://mcp.magnific.com'],
    setup: 'sign in to Magnific (Freepik) in the browser window that opens the first time it runs',
  },
  {
    name: 'google-design',
    title: 'Google Fonts and Material icons',
    description: 'Find Google Fonts, describe a font, search Material Symbols icons and make colour schemes (Google\'s own server). No key needed.',
    type: 'http',
    url: 'https://design.googleapis.com/mcp',
    headers: {},
  },
  // Free creative programs, live
  {
    name: 'gimp',
    title: 'GIMP (live)',
    description: 'Edit images in a running GIMP 3: layers, selections, filters, export (third-party, github.com/maorcc/gimp-mcp). Needs its GIMP plug-in, started from Tools > MCP > Start MCP Server.',
    type: 'stdio',
    command: 'uvx',
    args: ['--from', 'git+https://github.com/maorcc/gimp-mcp', 'gimp-mcp-server'],
    setup: 'copy gimp-mcp-plugin.py from github.com/maorcc/gimp-mcp into %APPDATA%\\GIMP\\<version, e.g. 3.2>\\plug-ins\\gimp-mcp-plugin\\, restart GIMP, then Tools > MCP > Start MCP Server',
  },
  {
    name: 'krita',
    title: 'Krita (live)',
    description: 'Paint and edit in a running Krita: documents, layers, filters, export (third-party, github.com/dcc-mcp/dcc-mcp-krita; new and little used so far). Needs its Krita plug-in.',
    type: 'stdio',
    command: 'uvx',
    args: ['--from', 'dcc-mcp-krita', 'dcc-mcp-krita'],
    setup: 'run uvx --from dcc-mcp-krita dcc-mcp-krita install --dcc-path "<your Krita folder>" --yes once, restart Krita and turn on "DCC MCP Krita" under Settings > Configure Krita > Python Plugin Manager',
  },
  {
    name: 'inkscape',
    title: 'Inkscape (vector graphics)',
    description: 'Make and edit SVG drawings with Inkscape, convert and export them to PNG or PDF (third-party, github.com/aravindev/inkscape_mcp). Works without opening Inkscape. If Inkscape is not found on its own, add INKSCAPE_BIN (the full path to inkscape.exe) after adding.',
    type: 'stdio',
    command: 'uvx',
    args: ['inkscape-mcp'],
    setup: 'Inkscape has to be installed',
  },
  {
    name: 'audacity',
    title: 'Audacity (live)',
    description: 'Record, cut, apply effects to and export audio in a running Audacity (third-party, github.com/xDarkzx/Audacity-MCP). Works with Audacity 3 only: Audacity 4 has no scripting yet.',
    type: 'stdio',
    command: 'uvx',
    args: ['--from', 'audacity-mcp-server', 'audacity-mcp'],
    setup: 'use Audacity 3: in Preferences > Modules set mod-script-pipe to Enabled, then restart Audacity',
  },
  {
    name: 'reaper',
    title: 'REAPER (live)',
    description: 'Make music in a running REAPER: tracks, items, FX, MIDI, mixing and rendering (third-party, github.com/TwelveTake-Studios/reaper-mcp).',
    type: 'stdio',
    command: 'uvx',
    args: ['twelvetake-reaper-mcp'],
    setup: 'run uvx twelvetake-reaper-mcp --install-bridge once, then in REAPER load and run reaper_mcp_bridge.lua (Actions > Show action list > New action > Load ReaScript)',
  },
  {
    name: 'musescore',
    title: 'MuseScore (live)',
    description: 'Write and change sheet music in a running MuseScore 4.4 or newer (third-party, github.com/tskovlund/mcp-score).',
    type: 'stdio',
    command: 'uvx',
    args: ['--from', 'mcp-score-server', 'mcp-score', 'serve'],
    setup: 'run uvx --from mcp-score-server mcp-score install-plugin once, then in MuseScore enable MCP Score Bridge (Plugins > Manage plugins) and open it from the Plugins menu, keeping its window open',
  },
  {
    name: 'obs',
    title: 'OBS Studio (live)',
    description: 'Control OBS: scenes, sources, recording and streaming (third-party, github.com/royshil/obs-mcp). In OBS turn on Tools > WebSocket Server Settings, then add its password as OBS_WEBSOCKET_PASSWORD after adding.',
    type: 'stdio',
    command: 'npx',
    args: ['-y', 'obs-mcp'],
    env: { OBS_WEBSOCKET_PASSWORD: 'YOUR_PASSWORD' },
    setup: 'in OBS turn on Tools > WebSocket Server Settings (port 4455)',
  },
  {
    name: 'topaz',
    title: 'Topaz (AI upscale, Gigapixel)',
    description: 'Upscale, sharpen and clean up images with Topaz\'s cloud service, the same AI as Gigapixel (Topaz\'s own server). It does not use the Gigapixel app on your PC. Needs a paid Topaz API key: add it as TOPAZ_API_KEY after adding.',
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@topazlabs/mcp'],
    env: { TOPAZ_API_KEY: 'YOUR_API_KEY' },
  },
];

/** What a ready-made server needs from the user before it works, in a few words ('' when nothing). */
export function presetNeeds(p: McpPreset): string {
  const keys = Object.entries(p.type === 'stdio' ? p.env || {} : p.headers).filter(([, v]) => /YOUR_/.test(v));
  const need = keys.map(([k]) => (p.type === 'stdio' ? k : `a key in the ${k} header`));
  return [need.length ? `needs ${need.join(' and ')}` : '', p.setup ? `setup: ${p.setup}` : ''].filter(Boolean).join('; ');
}

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

// An always-allowed tool of a server, after the server is renamed (or null when it is removed). Claude Code
// names a server's tools mcp__<server>__<tool>; API-model agents name them <server>__<tool>.
export function renamedGrant(grant: string, from: string, to: string | null, engine: string): string {
  const forms: [string, string][] = [[`mcp__${from}__`, `mcp__${to}__`]];
  if (engine === 'openai') forms.push([`${from}__`, `${to}__`]);
  if (grant === `mcp__${from}`) return to ? `mcp__${to}` : '';
  for (const [was, now] of forms) if (grant.startsWith(was)) return to ? now + grant.slice(was.length) : '';
  return grant;
}

// Agents and teams name their servers, so a removed or renamed server changes on all of them, in every
// project. Always-allowed tools go too: a new server with the old name mustn't inherit them.
function renameOnEveryone(from: string, to: string | null) {
  const swap = (list: string[] | undefined): string[] | null => (list || []).includes(from) ? [...new Set((list || []).map((x) => (x === from ? to : x)).filter((x): x is string => Boolean(x)))] : null;
  for (const p of listProjects()) {
    withProject(p, () => {
      for (const a of agents.list()) {
        const servers = swap(a.mcpServers);
        const had = a.alwaysAllow || [];
        const grants = had.map((g) => renamedGrant(g, from, to, a.engine));
        const grantsChanged = grants.some((g, i) => g !== had[i]);
        if (servers || grantsChanged) agents.save({ ...a, ...(servers ? { mcpServers: servers } : {}), ...(grantsChanged ? { alwaysAllow: [...new Set(grants.filter(Boolean))] } : {}) });
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

/** Give a server a new name, on every agent and team that has it too, and optionally new settings in the
 *  same step (so a refused name changes nothing). Returns the name it got. */
export function renameServer(from: string, to: string, cfg?: McpServerInput): string {
  const servers = listServers();
  const was = servers[from];
  if (!was) throw new Error(`No MCP server named "${from}".`);
  const clean = serverName(to);
  if (clean === from) {
    if (cfg) saveServer(from, cfg);
    return from;
  }
  if (servers[clean]) throw new Error(`There already is an MCP server named "${clean}".`);
  saveServer(clean, cfg || was);
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
    const client = new Client({ name: 'blacksite', version: '0.1.0' });
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
        const c2 = new Client({ name: 'blacksite', version: '0.1.0' });
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
// ~/.claude.json can be many MB and the Brain looks every turn: read the configs again only when they change.
const CLAUDE_JSON = () => path.join(HOME, '.claude.json');
const DESKTOP_JSON = () => path.join(process.env.APPDATA || '', 'Claude', 'claude_desktop_config.json');
let importCache: { key: string; found: ImportableServer[] } | null = null;
const fileKey = (file: string): string => {
  try {
    const st = fs.statSync(file);
    return `${file}:${st.size}:${st.mtimeMs}`;
  } catch {
    return `${file}:-`;
  }
};

export function importableServers(): ImportableServer[] {
  const key = [CLAUDE_JSON(), DESKTOP_JSON()].map(fileKey).join('|');
  if (importCache?.key !== key) importCache = { key, found: readImportable() };
  return importCache.found.map((x) => ({ ...x, args: [...x.args], env: { ...x.env }, headers: { ...x.headers } }));
}

function readImportable(): ImportableServer[] {
  const found: ImportableServer[] = [];
  const add = (source: string, servers: Record<string, ForeignServer> | undefined) => {
    for (const [name, cfg] of Object.entries(servers || {})) {
      found.push({ source, name, type: cfg.type === 'http' || cfg.type === 'sse' || cfg.url ? 'http' : 'stdio', command: cfg.command, args: cfg.args || [], env: cfg.env || {}, url: cfg.url, headers: cfg.headers || {} });
    }
  };
  const claudeJson = readJSON<ClaudeJson>(CLAUDE_JSON(), null);
  if (claudeJson) {
    add('Claude Code (user)', claudeJson.mcpServers);
    for (const [proj, p] of Object.entries(claudeJson.projects || {})) add(`Claude Code (${path.basename(proj)})`, p.mcpServers);
  }
  const desktop = readJSON<ClaudeJson>(DESKTOP_JSON(), null);
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
