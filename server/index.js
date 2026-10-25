// My Dashboard: a local, login-free command center for agents, tools, programs, MCP servers and social accounts.
// Listens on 127.0.0.1 only. Run: node server/index.js [--port 4800] [--no-open]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { ROOT, PORT as DEFAULT_PORT, setPort, dataPath, exists, openWithShell, run, ensureDir, HOME, readJSON, writeJSON } from './util.js';
import * as store from './store.js';
import { agents, chats, outbox, workflows, runs, bus, getSettings, saveSettings, setSecret, secretStatus, internalToken, activity, log } from './store.js';
import { listApprovals, decide, requestApproval } from './approvals.js';
import * as engines from './engines/index.js';
import { PROVIDERS, listModels } from './engines/openai.js';
import { CLAUDE_MODELS } from './engines/claude.js';
import { listProfiles } from './engines/hermes.js';
import * as tools from './tools.js';
import * as programs from './programs.js';
import * as comfy from './comfyui.js';
import * as mcp from './mcp.js';
import * as social from './social.js';
import * as library from './library.js';
import * as kb from './knowledge.js';
import * as wfs from './workflows.js';
import * as terms from './terminals.js';
import * as status from './status.js';
import * as brain from './brain.js';
import * as projects from './projects.js';

// If the dashboard was started from inside a Claude Code session, don't let agents inherit that session's markers.
for (const k of ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_CODE_SESSION_ID']) delete process.env[k];

const argv = process.argv.slice(2);
const PORT = (argv.includes('--port') && Number(argv[argv.indexOf('--port') + 1])) || DEFAULT_PORT;
setPort(PORT);
const OPEN = !argv.includes('--no-open') && !process.env.DASH_NO_OPEN;
const PUBLIC = path.join(ROOT, 'public');
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`]);

const VENDOR = {
  'xterm.js': 'node_modules/@xterm/xterm/lib/xterm.mjs',
  'xterm.css': 'node_modules/@xterm/xterm/css/xterm.css',
  'addon-fit.js': 'node_modules/@xterm/addon-fit/lib/addon-fit.mjs',
  'marked.js': 'node_modules/marked/lib/marked.esm.js',
  'purify.js': 'node_modules/dompurify/dist/purify.es.mjs',
  'three/three.module.js': 'node_modules/three/build/three.module.js',
  'three/three.core.js': 'node_modules/three/build/three.core.js',
};
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4', '.webm': 'video/webm', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.wav': 'audio/wav', '.mp3': 'audio/mpeg' };

// ---------- tiny router ----------
const routes = [];
const route = (method, pattern, handler) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
  routes.push({ method, re, keys, handler });
};
const get = (p, h) => route('GET', p, h);
const post = (p, h) => route('POST', p, h);
const put = (p, h) => route('PUT', p, h);
const del = (p, h) => route('DELETE', p, h);

class HttpError extends Error {
  constructor(status, msg) {
    super(msg);
    this.status = status;
  }
}
const need = (v, msg = 'Not found') => {
  if (!v) throw new HttpError(404, msg);
  return v;
};

// ---------- external agent for MCP clients that are not dashboard agents (e.g. Hermes, Claude Desktop) ----------
const EXTERNAL = { id: '_external', name: 'External MCP client', toolGroups: tools.TOOL_GROUPS.map((g) => g.id).filter((g) => g !== 'shell'), autonomy: 'ask', knowledge: { folders: [] } };
const agentFor = (id) => (id ? agents.get(id) : null) || EXTERNAL;

// ---------- state ----------
get('/api/state', async () => ({
  agents: agents.list().sort((a, b) => (b.pinned - a.pinned) || a.name.localeCompare(b.name)),
  mcpServers: Object.keys(mcp.listServers()),
  project: store.activeProject(),
  projects: store.listProjects(),
  approvals: listApprovals(),
  outboxPending: outbox.list().filter((p) => p.status === 'pending').length,
  runs: engines.activeRuns(),
  engines: engines.engineStatus(),
  engineList: engines.ENGINE_LIST,
  toolGroups: tools.TOOL_GROUPS,
  settings: getSettings(),
  secrets: secretStatus(),
  accounts: social.listAccounts(),
  terminals: terms.listTerminals(),
  port: PORT,
  home: HOME,
  dataDir: dataPath(),
}));

get('/api/activity', async () => activity(200));
// ---------- projects ----------
get('/api/projects', async () => ({ active: store.activeProject(), projects: store.listProjects(), root: projects.projectsRoot() }));
post('/api/projects', async (_p, body) => projects.createProject(body || {}));
post('/api/projects/:id/activate', async ({ id }) => {
  const p = store.setActiveProject(id);
  log('project', `Switched to project "${p.name}"`);
  return p;
});
put('/api/projects/:id', async ({ id }, body) => projects.updateProject(id, body || {}));
del('/api/projects/:id', async ({ id }) => projects.removeProject(id));
get('/api/brain', async () => projects.brainInfo());
// Where things sit on the Station map (per project), e.g. { bench: { x, z } }.
get('/api/layout', async () => readJSON(store.projectData('layout.json'), {}));
put('/api/layout', async (_p, body) => writeJSON(store.projectData('layout.json'), { ...readJSON(store.projectData('layout.json'), {}), ...(body || {}) }));
post('/api/brain/note', async (_p, body) => ({ file: projects.addNote(body.name, body.content) }));
post('/api/brain/pull', async () => ({ message: await projects.gitPull() }));
post('/api/brain/open', async (_p, body) => {
  const dir = projects.ensureBrain();
  if (body.app === 'vscode') {
    const msg = await programs.launchProgram('vscode', { file: dir });
    return { message: msg };
  }
  openWithShell(dir);
  return { ok: true };
});

// The Brain: pick who handles a message, design a new agent, build a branch.
post('/api/assist/route', async (_p, body) => brain.route(String(body.text || '')));
post('/api/assist/agent', async (_p, body) => brain.designAgent(String(body.text || '')));
post('/api/assist/branch', async (_p, body) => brain.designBranch(String(body.text || ''), { allowNew: body.allowNew !== false }));
get('/api/headbar', async () => {
  const [usage, connectors] = await Promise.all([status.claudeUsage(), status.claudeConnectors().catch(() => [])]);
  return { usage, connectors };
});

// ---------- agents ----------
get('/api/agents', async () => agents.list());
post('/api/agents', async (_p, body) => {
  const { id, ...fields } = body || {};
  return library.newAgent(fields);
});
get('/api/agents/:id', async ({ id }) => {
  const a = need(agents.get(id));
  return { ...a, knowledgeFiles: kb.knowledgeFiles(a).map(({ label, size, own }) => ({ label, size, own })), workspacePath: tools.workspaceOf(a), tools: tools.toolsForAgent(a).map((t) => t.name) };
});
put('/api/agents/:id', async ({ id }, body) => {
  const a = need(agents.get(id));
  const allowed = ['name', 'emoji', 'color', 'specialty', 'description', 'systemPrompt', 'engine', 'model', 'provider', 'claudeAuth', 'hermesProfile', 'autonomy', 'toolGroups', 'mcpServers', 'knowledge', 'workspace', 'temperature', 'pinned', 'alwaysAllow'];
  for (const k of allowed) if (k in body) a[k] = body[k];
  return agents.save(a);
});
del('/api/agents/:id', async ({ id }) => {
  need(agents.get(id));
  agents.remove(id);
  // and take it off every branch it was on
  for (const wf of workflows.list()) {
    const steps = wf.steps.filter((s) => !(s.type === 'agent' && s.agentId === id));
    if (steps.length !== wf.steps.length) workflows.save({ ...wf, steps });
  }
  return { ok: true };
});
post('/api/agents/:id/duplicate', async ({ id }) => {
  const a = need(agents.get(id));
  const { id: _i, createdAt, updatedAt, ...rest } = a;
  return library.newAgent({ ...rest, name: `${a.name} (copy)` });
});
post('/api/agents/:id/export-claude', async ({ id }) => ({ file: library.exportToClaude(need(agents.get(id))) }));
post('/api/agents/:id/open-workspace', async ({ id }) => {
  openWithShell(tools.workspaceOf(need(agents.get(id))));
  return { ok: true };
});

// knowledge
post('/api/agents/:id/knowledge', async ({ id }, body) => {
  need(agents.get(id));
  if (body.folder) {
    const a = agents.get(id);
    if (!exists(body.folder)) throw new HttpError(400, `${body.folder} does not exist.`);
    a.knowledge = { folders: [...new Set([...(a.knowledge?.folders || []), body.folder])] };
    agents.save(a);
    return { ok: true };
  }
  if (body.url) {
    const res = await fetch(body.url, { signal: AbortSignal.timeout(30000) });
    const text = await res.text();
    const name = body.name || new URL(body.url).hostname + new URL(body.url).pathname.replace(/\W+/g, '_') + '.md';
    return { file: kb.addKnowledgeFile(id, name, `Source: ${body.url}\n\n${/html/.test(res.headers.get('content-type') || '') ? text.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+\n/g, '\n').replace(/[ \t]+/g, ' ') : text}`) };
  }
  return { file: kb.addKnowledgeFile(id, body.name, body.content || '') };
});
del('/api/agents/:id/knowledge', async ({ id }, _b, q) => {
  const a = need(agents.get(id));
  if (q.folder) {
    a.knowledge = { folders: (a.knowledge?.folders || []).filter((f) => f !== q.folder) };
    agents.save(a);
  } else kb.removeKnowledgeFile(id, q.label);
  return { ok: true };
});

// chats
get('/api/agents/:id/chats', async ({ id }) => chats.list(id));
post('/api/agents/:id/chats', async ({ id }) => chats.create(need(agents.get(id)).id));
get('/api/agents/:id/chats/:cid', async ({ id, cid }) => need(chats.get(id, cid)));
del('/api/agents/:id/chats/:cid', async ({ id, cid }) => {
  engines.forgetChat(cid);
  chats.remove(id, cid);
  return { ok: true };
});
put('/api/agents/:id/chats/:cid', async ({ id, cid }, body) => {
  // While a run is going, change the copy it is writing so the edit sticks.
  const c = engines.liveChat(cid) || need(chats.get(id, cid));
  if (body.title) c.title = String(body.title).slice(0, 120);
  if (body.reset) {
    c.sessionId = null;
    c.llm = [];
    c.items.push({ type: 'meta', text: 'Memory cleared: the agent starts fresh from here.', ts: Date.now() });
  }
  return chats.save(c);
});
post('/api/agents/:id/chats/:cid/messages', async ({ id, cid }, body) => {
  const a = need(agents.get(id));
  const c = need(chats.get(id, cid));
  const text = String(body.text || '').trim();
  if (!text) throw new HttpError(400, 'Type a message first.');
  const { runId } = engines.startRun(a, c, text);
  return { runId };
});
post('/api/agents/:id/chats/:cid/stop', async ({ cid }) => {
  engines.stopChat(cid);
  return { ok: true };
});
get('/api/runs', async () => engines.activeRuns());
post('/api/runs/:id/stop', async ({ id }) => ({ ok: engines.stopRun(id) }));

// ---------- approvals ----------
get('/api/approvals', async () => listApprovals());
post('/api/approvals/:id', async ({ id }, body) => ({ ok: decide(id, body || {}) }));

// ---------- library ----------
get('/api/library', async () => ({ ...(await library.libraryIndex()), starters: library.STARTERS.map(({ name, emoji, specialty }) => ({ name, emoji, specialty })) }));
post('/api/library/install', async () => ({ message: await library.installAgency() }));
get('/api/library/agency/:slug', async ({ slug }) => {
  const a = need(library.agencyAgents().find((x) => x.slug === slug));
  return { ...a, body: fs.readFileSync(a.file, 'utf8') };
});
post('/api/library/hire', async (_p, body) => {
  const o = body.overrides || {};
  if (body.source === 'agency') return library.hireFromAgency(body.slug, o);
  if (body.source === 'hermes') return library.hireHermesProfile(body.profile, o);
  if (body.source === 'claude') return library.importClaudeSubagent(body.slug);
  if (body.source === 'starter') return library.createStarter(body.name, o);
  throw new HttpError(400, 'Unknown library source');
});

// ---------- models ----------
get('/api/models', async (_p, _b, q) => {
  if (q.engine === 'claude-code') return CLAUDE_MODELS;
  if (q.engine === 'hermes') return [];
  return listModels(q.provider || 'openrouter');
});
get('/api/providers', async () => Object.entries(PROVIDERS).map(([id, p]) => ({ id, label: p.label })));
get('/api/hermes/profiles', async () => listProfiles());

// ---------- tools & programs ----------
get('/api/tools', async () => ({ groups: tools.TOOL_GROUPS, tools: tools.allTools() }));
get('/api/programs', async (_p, _b, q) => programs.discoverPrograms(!!q.force));
get('/api/programs/all', async () => programs.startMenuApps(true));
post('/api/programs/launch', async (_p, body) => {
  const msg = await programs.launchProgram(body.program, { file: body.file });
  log('program', msg);
  return { message: msg };
});
post('/api/programs/open', async (_p, body) => {
  openWithShell(body.target);
  return { ok: true };
});

// ComfyUI
get('/api/comfyui', async () => ({ status: await comfy.queueStatus(), workflows: comfy.listWorkflows().map(({ name, dir }) => ({ name, dir })) }));
get('/api/comfyui/describe', async (_p, _b, q) => comfy.describeWorkflow(q.workflow));
post('/api/comfyui/run', async (_p, body) => comfy.runWorkflow({ workflow: body.workflow, prompt: body.prompt || undefined, negative: body.negative || undefined, inputs: body.inputs || {} }));
post('/api/comfyui/start', async () => ({ message: await comfy.startComfy() }));
post('/api/comfyui/workflows', async (_p, body) => ({ file: comfy.saveApiWorkflow(body.name, body.json) }));

// Files the browser may show: workspaces, outputs, knowledge, ComfyUI outputs, allowed folders.
get('/api/file', async (_p, _b, q, res) => {
  const p = path.resolve(String(q.path || ''));
  const roots = [projects.ensureBrain(), store.projectData('knowledge'), dataPath('outputs'), ...programs.comfyOutputDirs(), ...(getSettings().allowedFolders || [])].map((r) => path.resolve(r).toLowerCase());
  if (!roots.some((r) => p.toLowerCase().startsWith(r + path.sep))) throw new HttpError(403, 'That file is outside the dashboard folders.');
  let st;
  try {
    st = fs.statSync(p);
  } catch {
    throw new HttpError(404, 'File not found');
  }
  if (!st.isFile()) throw new HttpError(400, 'That is a folder, not a file.');
  sendFileSafely(res, p);
  return undefined;
});

// Agent-made files are shown, never run: only media display inline; everything else downloads, sandboxed.
function sendFileSafely(res, p, type = MIME[path.extname(p).toLowerCase()] || 'application/octet-stream') {
  const inline = /^(image\/(png|jpeg|webp|gif)|video\/|audio\/)/.test(type);
  res.writeHead(200, {
    'content-type': type,
    'x-content-type-options': 'nosniff',
    'content-security-policy': 'sandbox; default-src none',
    ...(inline ? {} : { 'content-disposition': `attachment; filename="${path.basename(p).replace(/[^\w.\- ]/g, '_')}"` }),
  });
  const stream = fs.createReadStream(p);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

// ---------- MCP ----------
get('/api/mcp', async () => ({ servers: mcp.listServers(), presets: mcp.presetAvailability(), importable: mcp.importableServers(), bridge: mcp.bridgeServerConfig('') }));
post('/api/mcp', async (_p, body) => mcp.saveServer(body.name, body));
del('/api/mcp/:name', async ({ name }) => {
  mcp.removeServer(name);
  return { ok: true };
});
post('/api/mcp/:name/test', async ({ name }) => ({ tools: await mcp.testServer(name) }));
post('/api/mcp-preset', async (_p, body) => {
  const pr = need(mcp.PRESETS.find((x) => x.name === body.name), 'Unknown preset');
  return mcp.saveServer(pr.name, { ...pr, description: pr.description });
});
post('/api/mcp-import', async (_p, body) => {
  const it = need(mcp.importableServers().find((x) => x.name === body.name && x.source === body.source), 'Not found');
  return mcp.saveServer(it.name, it);
});
post('/api/hermes/add-bridge', async () => {
  const cfg = mcp.bridgeServerConfig('');
  const r = await run('hermes', ['mcp', 'add', 'dashboard', '--command', cfg.command, '--env', `DASH_PORT=${PORT}`, `DASH_TOKEN=${internalToken()}`, '--args', ...cfg.args], { timeout: 120000, input: 'y\n' });
  if (r.code !== 0) throw new HttpError(500, (r.stderr || r.stdout).trim().slice(-800) || 'hermes mcp add failed');
  log('mcp', 'Gave Hermes the dashboard tools (hermes mcp add dashboard)');
  return { message: (r.stdout || 'Added.').trim().slice(-800) };
});

// ---------- settings ----------
get('/api/settings', async () => ({ settings: getSettings(), secrets: secretStatus() }));
put('/api/settings', async (_p, body) => saveSettings(body || {}));
post('/api/secrets', async (_p, body) => {
  const okKeys = ['openrouterKey', 'anthropicKey', 'customKey', 'xClientSecret', 'telegramBotToken', 'discordWebhook'];
  if (!okKeys.includes(body.key)) throw new HttpError(400, 'Unknown key');
  setSecret(body.key, String(body.value || '').trim());
  return secretStatus();
});
post('/api/settings/test-openrouter', async () => {
  const key = store.getSecrets().openrouterKey;
  if (!key) throw new HttpError(400, 'No OpenRouter key saved.');
  const r = await fetch('https://openrouter.ai/api/v1/key', { headers: { authorization: `Bearer ${key}` } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new HttpError(400, j.error?.message || `OpenRouter said ${r.status}`);
  return j.data || j;
});

// ---------- social ----------
get('/api/accounts', async () => social.listAccounts());
post('/api/accounts/x/:id', async ({ id }, body) => {
  if ('autopost' in body) social.setAutopost(id, body.autopost);
  return social.listAccounts();
});
del('/api/accounts/x/:id', async ({ id }) => {
  social.disconnectX(id);
  return social.listAccounts();
});
get('/api/accounts/x/:id/posts', async ({ id }) => social.xRecentPosts(id, 10));
post('/api/social/test', async (_p, body) => ({ message: body.platform === 'discord' ? await social.sendDiscord('Test from My Dashboard ✅') : await social.sendTelegram('Test from My Dashboard ✅') }));

get('/api/outbox', async () => outbox.list().sort((a, b) => b.createdAt - a.createdAt));
post('/api/outbox', async (_p, body) => social.draftPost({ platform: body.platform || 'x', account: body.account, text: body.text, thread: body.thread, to: body.to, agentName: 'You' }));
post('/api/outbox/:id/approve', async ({ id }, body) => social.approvePost(id, body));
post('/api/outbox/:id/reject', async ({ id }, body) => social.rejectPost(id, body.reason));
put('/api/outbox/:id', async ({ id }, body) => {
  const it = need(outbox.get(id));
  if (body.parts) it.parts = body.parts;
  return outbox.save(it);
});
del('/api/outbox/:id', async ({ id }) => {
  outbox.remove(id);
  return { ok: true };
});

// ---------- workflows ----------
get('/api/workflows', async () => workflows.list().sort((a, b) => a.name.localeCompare(b.name)));
post('/api/workflows', async (_p, body) => workflows.save({ name: 'New workflow', steps: [], schedule: { type: 'none' }, enabled: false, ...body, id: undefined }));
get('/api/workflows/:id', async ({ id }) => need(workflows.get(id)));
put('/api/workflows/:id', async ({ id }, body) => workflows.save({ ...need(workflows.get(id)), ...body, id }));
del('/api/workflows/:id', async ({ id }) => {
  workflows.remove(id);
  return { ok: true };
});
post('/api/workflows/:id/run', async ({ id }, body) => wfs.startWorkflow(id, body.input || ''));
get('/api/workflow-templates', async () => wfs.TEMPLATES.map(({ name, description, needs }) => ({ name, description, needs })));
get('/api/workflow-active', async () => runs.list().filter((r) => r.status === 'running').map(wfs.runSummary));
post('/api/workflow-templates', async (_p, body) => wfs.createFromTemplate(body.name));
get('/api/workflow-runs', async (_p, _b, q) =>
  runs
    .list()
    .filter((r) => !q.workflowId || r.workflowId === q.workflowId)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 50),
);
post('/api/workflow-runs/:id/stop', async ({ id }) => ({ ok: wfs.stopWorkflowRun(id) }));

// ---------- terminals ----------
get('/api/terminals', async () => terms.listTerminals());
post('/api/terminals', async (_p, body) => terms.createTerminal({ ...body, agent: body.agentId ? need(agents.get(body.agentId)) : null }));
del('/api/terminals/:id', async ({ id }) => ({ ok: terms.closeTerminal(id) }));

// ---------- internal: the MCP bridge calls these ----------
get('/api/internal/tools', async (_p, _b, q) => {
  const agent = agentFor(q.agent);
  const list = tools.toolDefs(agent);
  if (agent.engine === 'claude-code')
    list.push({
      name: 'permission_prompt',
      description: 'Internal: Claude Code uses this to ask the user for permission. Never call it yourself.',
      parameters: { type: 'object', properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } }, required: ['tool_name'] },
    });
  return { tools: list };
});
post('/api/internal/tools/call', async (_p, body) => {
  const agent = agentFor(body.agent);
  // The bridge says which run it belongs to; that gives the right approvals, Stop button and delegation depth.
  const run = engines.runInfo(body.run);
  const ctx = run ? { runId: run.id, depth: run.depth, signal: run.signal } : { runId: null, depth: 1 };
  if (body.name === 'permission_prompt') return { text: JSON.stringify(await claudePermission(agent, body.args || {}, ctx.runId)) };
  return tools.callTool(agent, body.name, body.args || {}, ctx);
});

async function claudePermission(agent, { tool_name, input = {} }, runId) {
  if ((agent.alwaysAllow || []).includes(tool_name)) return { behavior: 'allow', updatedInput: input };
  const detail = input.command || input.file_path || input.url || input.pattern || JSON.stringify(input, null, 2);
  const d = await requestApproval({ kind: 'claude', title: `${agent.name} wants to use ${tool_name}`, detail: String(detail).slice(0, 4000), agentId: agent.id, agentName: agent.name, data: { tool: tool_name, args: input, runId } });
  if (d.approved && d.always) {
    const fresh = agents.get(agent.id);
    if (fresh) {
      fresh.alwaysAllow = [...new Set([...(fresh.alwaysAllow || []), tool_name])];
      agents.save(fresh);
    }
  }
  return d.approved ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: d.message || 'The user declined this. Ask them how to proceed.' };
}

// ---------- OAuth (plain GET pages) ----------
async function handleOAuth(url, req, res) {
  if (url.pathname === '/oauth/x/start') {
    try {
      const target = social.xAuthStart(`http://${req.headers.host}`);
      res.writeHead(302, { location: target });
      res.end();
    } catch (e) {
      page(res, 400, 'Could not start X sign-in', e.message);
    }
    return true;
  }
  if (url.pathname === '/oauth/x/callback') {
    try {
      const acc = await social.xAuthCallback(Object.fromEntries(url.searchParams));
      page(res, 200, `Connected @${acc.username}`, 'You can close this tab and go back to the dashboard.', true);
    } catch (e) {
      page(res, 400, 'X sign-in failed', e.message);
    }
    return true;
  }
  return false;
}

function page(res, status, title, text, close = false) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(
    `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title><body style="background:#0b0c0b;color:#e6e8e0;font:16px system-ui;display:grid;place-items:center;height:100vh;margin:0"><div style="max-width:520px;padding:24px"><h2 style="color:#c4ff3d">${esc(title)}</h2><p>${esc(text)}</p><p><a style="color:#c4ff3d" href="/#/settings?tab=connections">Back to the dashboard</a></p></div>${close ? '<script>setTimeout(()=>{location.href="/#/settings?tab=connections"},1500)</script>' : ''}`,
  );
}

// ---------- server ----------
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 25 * 1024 * 1024) {
        reject(new HttpError(413, 'Too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'Body must be JSON'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(url, res) {
  let rel = decodeURIComponent(url.pathname);
  if (rel.startsWith('/vendor/')) {
    const v = VENDOR[rel.slice(8)];
    if (!v) return false;
    const file = path.join(ROOT, v);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'text/javascript', 'cache-control': 'max-age=86400' });
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
    return true;
  }
  if (rel === '/' || !path.extname(rel)) rel = '/index.html';
  const file = path.resolve(PUBLIC, '.' + rel);
  if (!file.startsWith(PUBLIC + path.sep) || !exists(file) || !fs.statSync(file).isFile()) return false;
  const headers = { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' };
  // Agent output is shown as markdown: no outside scripts, and images only from here (nothing leaks out).
  if (file.endsWith('.html'))
    headers['content-security-policy'] = [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      'font-src https://fonts.gstatic.com',
      "img-src 'self' data: blob: https://pbs.twimg.com https://abs.twimg.com",
      `connect-src 'self' ws://localhost:${PORT} ws://127.0.0.1:${PORT}`,
      "frame-ancestors 'none'",
    ].join('; ');
  res.writeHead(200, headers);
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  return true;
}

const server = http.createServer(async (req, res) => {
  // Only answer requests addressed to this machine (stops DNS-rebinding tricks).
  if (!ALLOWED_HOSTS.has(String(req.headers.host || '').toLowerCase())) {
    res.writeHead(421);
    return res.end('Wrong host');
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  // Browsers label requests from other websites (an <img> or link pointing here). Only the X callback may arrive that way.
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none' && url.pathname !== '/oauth/x/callback' && (url.pathname.startsWith('/api/') || url.pathname.startsWith('/oauth/'))) {
    res.writeHead(403, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Requests from other websites are not allowed.' }));
  }
  try {
    if (url.pathname.startsWith('/oauth/') && (await handleOAuth(url, req, res))) return;
    if (url.pathname.startsWith('/api/')) {
      const internal = url.pathname.startsWith('/api/internal/');
      if (internal) {
        if (req.headers['x-dash-internal'] !== internalToken()) throw new HttpError(403, 'Bad internal token');
      } else if (req.method !== 'GET' && req.headers['x-dash'] !== '1') {
        // Other websites can't add this header without a CORS preflight, which we never allow.
        throw new HttpError(403, 'Missing x-dash header');
      }
      if (url.pathname === '/api/comfyui/view') return await comfy.proxyView(Object.fromEntries(url.searchParams), res);
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(url.pathname);
        if (!m) continue;
        const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readBody(req);
        const out = await r.handler(params, body, Object.fromEntries(url.searchParams), res);
        if (out === undefined && res.headersSent) return;
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(JSON.stringify(out ?? null));
      }
      throw new HttpError(404, `No API route ${req.method} ${url.pathname}`);
    }
    if (req.method === 'GET' && serveStatic(url, res)) return;
    res.writeHead(404);
    res.end('Not found');
  } catch (e) {
    const status = e.status && e.status >= 400 && e.status < 600 ? e.status : 500;
    if (status === 500) console.error(e);
    if (!res.headersSent) {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: e.message || String(e) }));
    } else res.end();
  }
});

// ---------- websockets: live events + terminals ----------
const wss = new WebSocketServer({ noServer: true });
const eventClients = new Set();
server.on('upgrade', (req, socket, head) => {
  const origin = req.headers.origin || '';
  const okOrigin = [...ALLOWED_HOSTS].some((h) => origin === `http://${h}`);
  if (!ALLOWED_HOSTS.has(String(req.headers.host || '').toLowerCase()) || !okOrigin) {
    socket.destroy();
    return;
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  wss.handleUpgrade(req, socket, head, (ws) => {
    if (url.pathname === '/ws/term') return terms.attachTerminal(url.searchParams.get('id'), ws);
    if (url.pathname !== '/ws') return ws.close();
    eventClients.add(ws);
    ws.on('close', () => eventClients.delete(ws));
  });
});
bus.on('event', (ev) => {
  const msg = JSON.stringify(ev);
  for (const ws of eventClients) if (ws.readyState === 1) ws.send(msg);
});

// ---------- start ----------
ensureDir(dataPath('outputs'));
internalToken();
store.migrateLayout();
wfs.markInterruptedRuns();
wfs.startScheduler();

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log(`My Dashboard is already running at http://localhost:${PORT}`);
    if (OPEN) openWithShell(`http://localhost:${PORT}`);
    process.exit(0);
  }
  throw e;
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\n  My Dashboard is running at ${url}\n  Data folder: ${dataPath()}\n  Press Ctrl+C to stop.\n`);
  log('system', 'Dashboard started');
  if (OPEN) openWithShell(url);
});

const shutdown = () => {
  terms.closeAll();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('unhandledRejection', (e) => console.error('Unhandled:', e));
