// Athena Agents: a local, login-free command center for agents, tools, programs, MCP servers and social accounts.
// Listens on 127.0.0.1 only. Run: node server/index.js [--port 4800] [--no-open]
import http from 'node:http';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import {
  ROOT,
  PORT as DEFAULT_PORT,
  setPort,
  dataPath,
  exists,
  openWithShell,
  ensureDir,
  insideRoots,
} from './util.ts';
import * as store from './store.ts';
import { agents, workflows, bus, getSettings, internalToken, log, rememberAlwaysAllow } from './store.ts';
import { requestApproval, setReviewer } from './approvals.ts';
import * as engines from './engines/index.ts';
import { eveRuntime } from './eve/runtime.ts';
import { EveOwnershipError } from './eve/ownership.ts';
import { eveCoordinator } from './eve/coordinator.ts';
import { gatewaySupervisor } from './gateways/live.ts';
import * as tools from './tools.ts';
import { inlineToolImagesNoted, withImageNote } from './toolimages.ts';
import * as programs from './programs.ts';
import * as comfy from './comfyui.ts';
import * as mcp from './mcp.ts';
import * as social from './social.ts';
import * as teamMarks from './teammark.ts';
import * as taskBoard from './taskboard.ts';
import * as boardWork from './boardwork.ts';
import { taskFilePath } from './boardfiles.ts';
import * as wfs from './workflows.ts';
import * as worldLook from './voxel/look.ts';
import * as terms from './terminals.ts';
import * as irc from './irc.ts';
import * as projects from './projects.ts';
import * as teams from './teams.ts';
import * as reddit from './reddit.ts';
import * as overseer from './overseer.ts';
import * as projectSync from './projectsync.ts';
import * as skills from './skills.ts';
import * as learning from './learning.ts';
import * as uploads from './uploads.ts';
import * as files from './files.ts';
import * as routinesMod from './routines.ts';
import * as backup from './backup.ts';
import { devPage, pageCsp, viteFromArgs } from './devpage.ts';
import { saveToolStats } from './toolstats.ts';
import { handleRpc, JSON_LIMIT } from './rpc.ts';
import { sceneResponse } from './scene/serve.ts';
import { startSceneWatch } from './scene/history.ts';
import type { Agent, Project } from '../shared/types.ts';
import { BRAIN_ID } from './brainmcp.ts';

// If the dashboard was started from inside a Claude Code session, don't let agents inherit that session's markers.
for (const k of [
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CODE_SESSION_ID',
])
  delete process.env[k];

const argv = process.argv.slice(2);
const PORT = (argv.includes('--port') && Number(argv[argv.indexOf('--port') + 1])) || DEFAULT_PORT;
setPort(PORT);
const OPEN = !argv.includes('--no-open') && !process.env.DASH_NO_OPEN;
const PUBLIC = path.join(ROOT, 'public');
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`]);
// `bun run dev`: the page's code comes from the Vite dev server (hot reload) instead of public/dist
const VITE = viteFromArgs(argv);

// Only the terminal's stylesheet comes straight from node_modules; the scripts are bundled into public/dist.
const VENDOR: Record<string, string> = {
  'xterm.css': 'node_modules/@xterm/xterm/css/xterm.css',
};
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.woff2': 'font/woff2',
};

// ---------- tiny router ----------
/** :name parts of the path. */
type Params = Record<string, string>;
/** The query string (?a=1&b=2). */
type Query = Record<string, string>;
/** The JSON body as sent ({} for GET, DELETE and empty bodies). Each route says what it reads by typing B. */
type Body = Record<string, unknown>;
type Handler<B = Body> = (params: Params, body: B, query: Query, res: http.ServerResponse) => Promise<unknown>;
interface Route {
  method: string;
  re: RegExp;
  keys: string[];
  handler: Handler<unknown>;
  /** The body is a file, not JSON: it is streamed to a temporary file, and the handler gets its path. */
  raw?: boolean;
}

const routes: Route[] = [];
// B is the body shape the handler expects: the JSON is trusted to match it here (the HTTP boundary).
const route = <B>(method: string, pattern: string, handler: Handler<B>, raw = false) => {
  const keys: string[] = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k: string) => (keys.push(k), '([^/]+)')) + '$');
  routes.push({ method, re, keys, handler: handler as Handler<unknown>, raw });
};
const get = <B = Body>(p: string, h: Handler<B>) => route('GET', p, h);
const post = <B = Body>(p: string, h: Handler<B>) => route('POST', p, h);
/** A POST whose body is a file, e.g. a backup: the handler gets the path of a temporary copy (removed afterwards). */
const postFile = (p: string, h: Handler<string>) => route('POST', p, h, true);

// The routes an Overview pane uses for a project that isn't open (/api/p/<projectId>/…): an agent's chats and its
// details, a team's thread, a chat's tasks, the questions its agents ask, the Brain's chat, MEMORY.md and its
// versions, attached files, and showing that project's files.
// Everything else (projects, settings, keys, backups) stays global.
const SCOPED =
  /^\/(agents(\/[\w-]+(\/.*)?)?|teams\/[\w-]+\/.+|workflows|tasks(\/[\w-]+)?|questions(\/[\w-]+\/(answer|dismiss))?|brain\/(history|stream|steer)|memory\/[\w-]+|versions\/memory\/[^/]+(\/[^/]+(\/restore)?)?|uploads(\/[\w-]+)?|file|files\/(info|open|reveal))$/;
function scopedRoute(pathname: string): { project: Project; path: string } | null {
  const m = /^\/api\/p\/([^/]+)(\/.*)$/.exec(pathname);
  if (!m) return null;
  const project = store.projectById(decodeURIComponent(m[1]));
  if (!SCOPED.test(m[2])) throw new HttpError(404, `${m[2]} isn't available for another project.`);
  return { project, path: `/api${m[2]}` };
}

class HttpError extends Error {
  status: number;
  constructor(status: number, msg: string) {
    super(msg);
    this.status = status;
  }
}
const need = <T>(v: T, msg = 'Not found'): NonNullable<T> => {
  if (!v) throw new HttpError(404, msg);
  return v as NonNullable<T>;
};

// ---------- external agent for MCP clients that are not dashboard agents (e.g. Hermes, Claude Desktop) ----------
/** Not a saved agent: only the fields the tools look at. */
type ExternalAgent = Pick<Agent, 'id' | 'name' | 'toolGroups' | 'autonomy' | 'knowledge'> & Partial<Agent>;
const EXTERNAL: ExternalAgent = {
  id: '_external',
  name: 'External MCP client',
  toolGroups: tools.TOOL_GROUPS.map((g) => g.id).filter((g) => g !== 'shell'),
  autonomy: 'ask',
  knowledge: { folders: [] },
};
const agentFor = (id: string | null | undefined): Agent | ExternalAgent => (id ? agents.get(id) : null) || EXTERNAL;

// ---------- the page's state, the activity feed, the header and sidebar meters, About: server/api/status.ts ----------

// ---------- projects ----------
// server/api/projects.ts, except the project's pictures and model as files (below)
// The project's logo: shown on the start screen, in the project menu and inside the Brain.
get('/api/projects/:id/logo', async ({ id }, _b, _q, res) => {
  const p = need(store.listProjects().find((x) => x.id === id));
  const f = projects.logoFile(p);
  if (!f) throw new HttpError(404, 'No logo');
  sendFileSafely(res, f);
  return undefined;
});
// The picture behind the Station's map (classic and voxel look).
get('/api/projects/:id/background', async ({ id }, _b, _q, res) => {
  const p = need(store.listProjects().find((x) => x.id === id));
  const f = projects.backgroundFile(p);
  if (!f) throw new HttpError(404, 'No background');
  sendFileSafely(res, f);
  return undefined;
});
// The 3D model that replaces the logo inside the Brain's globe.
get('/api/projects/:id/model', async ({ id }, _b, _q, res) => {
  const p = need(store.listProjects().find((x) => x.id === id));
  const f = projects.modelFile(p);
  if (!f) throw new HttpError(404, 'No 3D model');
  sendFileSafely(res, f);
  return undefined;
});
// ---------- backups: a project with its agents, chats and knowledge, plus every skill and preset ----------
// (making one, and deleting a project with one: server/api/projects.ts)
// A new project from a backup: the file as the body, or ?file=<name> for one in the backups folder.
// One at a time, like copying a project (backup.oneAtATime).
postFile('/api/backups/restore', async (_p, upload, q) => {
  const r = await backup.oneAtATime('Another backup is being restored. Try again when it is done.', async () => {
    const bytes = q.file ? backup.readBackupFile(q.file) : fs.readFileSync(upload);
    if (!bytes.length) throw new Error('Drop a backup file first.');
    return backup.restoreBackup(bytes, { name: q.name, folder: q.folder, description: q.description });
  });
  projects.touch(r.project.id);
  projects.startScreenDone();
  return { ...projects.withLogo(skills.enableOrcaSkill(r.project.id) || r.project), restored: r.restored };
});

// ---------- the Brain: its folder, asking it, its history and its skills are server/api/brain.ts ----------
// (who a message goes to, and its drafts of an agent, a team or a skill: server/api/assist.ts)
// The Brain answers agents' and teams' permission requests (Settings > The Brain approves).
setReviewer(overseer.reviewApproval);
// (asking it, its answer whole or streamed: server/api/brain.ts)

// ---------- agents ----------
// server/api/agents.ts, with their chats and their run streams

// a chat's tasks: server/api/tasks.ts. The Tasks board: server/api/taskboard.ts, except a task's files (below)
// A file on a task or one of its comments (?path= as the task lists it), from the task's own project.
get('/api/task-board-file/:projectId/:id', async ({ projectId, id }, _b, q, res) => {
  const p = store.projectById(projectId);
  const t = need(taskBoard.savedBoardTask(projectId, id));
  const listed = [...(t.files || []), ...(t.comments || []).flatMap((c) => c.files || [])].some(
    (f) => f.path === q.path,
  );
  const file = listed ? taskFilePath(p, q.path) : null;
  if (!file) throw new HttpError(404, 'That file is missing.');
  sendFileSafely(res, file);
  return undefined;
});

// (skills: server/api/skills.ts; MEMORY.md: server/api/files.ts)

// ---------- the voxel world: server/api/world.ts ----------

// (versions, presets and the library: server/api/versions.ts, library.ts; models: status.ts; programs and ComfyUI:
// programs.ts)

// ---------- files ----------
// (what a chat's files are, attached files, artifacts, the backups folder, the map's layout and terminals:
// server/api/files.ts. An attached file's bytes go to POST /api/uploads/<batch>?path=…, handled below the router.)

// Files the browser may show: workspaces, outputs, knowledge, ComfyUI outputs, allowed folders.
get('/api/file', async (_p, _b, q, res) => {
  // links are followed before checking, so a link in a workspace can't serve files from elsewhere
  const p = insideRoots(path.resolve(String(q.path || '')), files.viewRoots());
  if (!p) throw new HttpError(403, 'That file is outside the dashboard folders.');
  let st: fs.Stats;
  try {
    st = fs.statSync(p);
  } catch {
    throw new HttpError(404, 'File not found');
  }
  if (!st.isFile()) throw new HttpError(400, 'That is a folder, not a file.');
  // ?view=1 on a PDF: read it in a browser tab instead of downloading it
  if (q.view === '1' && path.extname(p).toLowerCase() === '.pdf') sendPdf(res, p);
  else sendFileSafely(res, p);
  return undefined;
});

// Agent-made files are shown, never run: only media display inline; everything else downloads, sandboxed.
function sendFileSafely(
  res: http.ServerResponse,
  p: string,
  type = MIME[path.extname(p).toLowerCase()] || 'application/octet-stream',
) {
  const inline = /^(image\/(png|jpeg|webp|gif)|video\/|audio\/)/.test(type);
  // the size up front: the page can tell a file too big to show before it downloads it
  let length: Record<string, string> = {};
  try {
    length = { 'content-length': String(fs.statSync(p).size) };
  } catch {
    /* sent without it */
  }
  res.writeHead(200, {
    ...length,
    'content-type': type,
    'x-content-type-options': 'nosniff',
    'content-security-policy': 'sandbox; default-src none',
    ...(inline
      ? {}
      : { 'content-disposition': `attachment; filename="${path.basename(p).replace(/[^\w.\- ]/g, '_')}"` }),
  });
  const stream = fs.createReadStream(p);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

// A PDF shown by the browser's own viewer, which keeps a PDF's scripts away from the page. It can't
// have the sandbox above (the viewer won't open a sandboxed PDF), so it is only for .pdf files and always
// sent as a PDF, never guessed as anything else. (Other websites can't load it: see Sec-Fetch-Site below.)
function sendPdf(res: http.ServerResponse, p: string) {
  res.writeHead(200, {
    'content-type': 'application/pdf',
    'x-content-type-options': 'nosniff',
    'content-disposition': `inline; filename="${path.basename(p).replace(/[^\w.\- ]/g, '_')}"`,
  });
  const stream = fs.createReadStream(p);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

// ---------- MCP servers, and setting up Codex, Hermes, pi and OpenClaw: server/api/mcp.ts ----------
// ---------- gateways and the Outbox: server/api/gateways.ts, outbox.ts ----------

// ---------- teams: server/api/workflows.ts (making, changing, running) and server/api/teams.ts (their chats) ----------
// the picture or 3D model in the middle of a team's pod, instead of its emoji
get('/api/workflows/:id/mark', async ({ id }, _b, _q, res) => {
  const f = teamMarks.markFile(need(workflows.get(id)));
  if (!f) throw new HttpError(404, 'No picture or model');
  sendFileSafely(res, f);
  return undefined;
});

// ---------- internal: the MCP bridge calls these ----------
// A bridge that belongs to a run works in the run's project (its agent, workspace and data), even
// after you open another one. An agent's terminal has no run, but its bridge names the project it was opened in.
// Without either (an outside MCP client) it's the project open now.
const inRunProject = <T>(
  run: engines.RunInfo | null,
  projectId: string | null | undefined,
  fn: () => T,
  runId?: string | null,
): T => {
  if (run) return store.withProject(run.project, fn);
  // a bridge of a run that has ended (a late call, or one its CLI left running) works nowhere: never in the open project
  if (runId) throw new HttpError(410, 'The run this belongs to has ended. Nothing was done.');
  if (!projectId) return fn();
  const project = store.listProjects().find((p) => p.id === projectId);
  if (!project) throw new HttpError(410, 'The project this terminal was opened in is gone.');
  return store.withProject(project, fn);
};
// The agent as its run has it: what a team gave it for this work (tools, MCP servers, skills) counts too.
// Its saved settings (autonomy, "always allow") are read fresh.
const bridgeAgent = (run: engines.RunInfo | null, id: string | null | undefined): Agent | ExternalAgent => {
  // the Brain isn't a saved agent: its run carries it (its access level and instructions for this turn)
  if (run && id === BRAIN_ID && run.agentId === BRAIN_ID) return run.agent;
  const agent = agentFor(id);
  if (!run || !id || run.agentId !== id || agent === EXTERNAL) return agent;
  return {
    ...agent,
    toolGroups: run.agent.toolGroups,
    mcpServers: run.agent.mcpServers,
    _teamSkills: run.agent._teamSkills,
  };
};
get('/api/internal/tools', async (_p, _b, q) => {
  const run = engines.runInfo(q.run);
  return inRunProject(
    run,
    q.project,
    () => {
      const agent = bridgeAgent(run, q.agent);
      const list = tools.toolDefs(agent, { conversationId: run?.conversationId, engine: agent.engine });
      if (agent.engine === 'claude-code')
        list.push({
          name: 'permission_prompt',
          description: 'Internal: Claude Code uses this to ask the user for permission. Never call it yourself.',
          parameters: {
            type: 'object',
            properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } },
            required: ['tool_name'],
          },
        });
      return { tools: list };
    },
    q.run,
  );
});
post<{ agent?: string; run?: string; project?: string; name: string; args?: Record<string, unknown> }>(
  '/api/internal/tools/call',
  async (_p, body, _q, res) => {
    // The bridge says which run it belongs to; that gives the right project, approvals, Stop button and delegation depth.
    const run = engines.runInfo(body.run);
    // the MCP client gave up on the call (it cancelled it): what it waits on is taken back, and nothing runs after
    const given = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) given.abort();
    });
    return inRunProject(
      run,
      body.project,
      async () => {
        const agent = bridgeAgent(run, body.agent);
        const ctx = run
          ? { runId: run.id, depth: run.depth, signal: AbortSignal.any([run.signal, given.signal]) }
          : { runId: null, depth: 1, signal: given.signal };
        if (body.name === 'permission_prompt')
          return {
            text: JSON.stringify(
              await claudePermission(agent, (body.args || {}) as unknown as PermissionRequest, ctx.runId),
            ),
          };
        const r = tools.clipForModel(
          await tools.callTool(agent, body.name, body.args || {}, ctx),
          body.name,
          ctx.runId,
        );
        // MCP takes pictures as data only: ComfyUI's result links are read here, so the agent sees them too
        if (!r.images?.length) return r;
        const { images, note } = await inlineToolImagesNoted(r.images);
        return { ...r, images, text: withImageNote(r.text, note) };
      },
      body.run,
    );
  },
);

/** What Claude Code sends to permission_prompt. */
interface PermissionRequest {
  tool_name: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
}

async function claudePermission(
  agent: Agent | ExternalAgent,
  { tool_name, input = {} }: PermissionRequest,
  runId: string | null,
) {
  if ((agent.alwaysAllow || []).includes(tool_name)) return { behavior: 'allow', updatedInput: input };
  const detail = input.command || input.file_path || input.url || input.pattern || JSON.stringify(input, null, 2);
  const account = mcp.accountOfTool(tool_name);
  const d = await requestApproval({
    kind: 'claude',
    title: `${agent.name} wants to use ${tool_name}${account ? ` on ${account}` : ''}`,
    detail: String(detail).slice(0, 4000),
    agentId: agent.id,
    agentName: agent.name,
    data: { tool: tool_name, args: input, runId },
  });
  if (d.approved && d.always) rememberAlwaysAllow(agent.id, [tool_name]);
  return d.approved
    ? { behavior: 'allow', updatedInput: input }
    : { behavior: 'deny', message: d.message || 'The user declined this. Ask them how to proceed.' };
}

// ---------- OAuth (plain GET pages) ----------
async function handleOAuth(url: URL, req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
  if (url.pathname === '/oauth/x/start') {
    try {
      const target = social.xAuthStart(`http://${req.headers.host}`);
      res.writeHead(302, { location: target });
      res.end();
    } catch (e) {
      page(res, 400, 'Could not start X sign-in', (e as Error).message);
    }
    return true;
  }
  if (url.pathname === '/oauth/reddit/start') {
    try {
      res.writeHead(302, { location: reddit.redditAuthStart(`http://${req.headers.host}`) });
      res.end();
    } catch (e) {
      page(res, 400, 'Could not start Reddit sign-in', (e as Error).message);
    }
    return true;
  }
  if (url.pathname === '/oauth/reddit/callback') {
    try {
      const acc = await reddit.redditAuthCallback(Object.fromEntries(url.searchParams));
      page(res, 200, `Connected u/${acc.username}`, 'You can close this tab and go back to the dashboard.', true);
    } catch (e) {
      page(res, 400, 'Reddit sign-in failed', (e as Error).message);
    }
    return true;
  }
  if (url.pathname === '/oauth/x/callback') {
    try {
      const acc = await social.xAuthCallback(Object.fromEntries(url.searchParams));
      page(res, 200, `Connected @${acc.username}`, 'You can close this tab and go back to the dashboard.', true);
    } catch (e) {
      page(res, 400, 'X sign-in failed', (e as Error).message);
    }
    return true;
  }
  return false;
}

function page(res: http.ServerResponse, status: number, title: string, text: string, close = false) {
  const esc = (s: unknown) =>
    String(s).replace(
      /[&<>"]/g,
      (c) => (({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }) as Record<string, string>)[c],
    );
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>${esc(title)}</title><link rel="stylesheet" href="/dist/app.css"><style>body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px}main{width:min(520px,100%);padding:24px;border:1px solid var(--color-line);border-radius:12px;background:var(--color-panel);box-shadow:inset 0 1px 0 var(--glass-spec)}h2{margin:0 0 8px;font-size:18px;font-weight:600}p{margin:0 0 12px;color:var(--color-dim)}p:last-child{margin-bottom:0}a:hover{text-decoration:underline}</style><body><main><h2>${esc(title)}</h2><p>${esc(text)}</p><p><a href="/#/settings?tab=connections">Back to the dashboard</a></p></main>${close ? '<script>setTimeout(()=>{location.href="/#/settings?tab=connections"},1500)</script>' : ''}`,
  );
}

// ---------- server ----------
function readRaw(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'Too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const buf = await readRaw(req, JSON_LIMIT);
  if (!buf.length) return {};
  let v: unknown;
  try {
    v = JSON.parse(buf.toString('utf8'));
  } catch {
    throw new HttpError(400, 'Body must be JSON');
  }
  // routes read fields from the body: null or a bare number/string would crash them
  if (v === null || typeof v !== 'object') throw new HttpError(400, 'Body must be a JSON object');
  return v;
}
// A file sent as the body (a backup), streamed to disk: never more than a backup may be
const FILE_LIMIT = backup.BACKUP_MAX;
const RECEIVED = () => ensureDir(dataPath('tmp', 'received'));

function receiveFile(req: http.IncomingMessage, limit: number): Promise<string> {
  const file = path.join(RECEIVED(), `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}.part`);
  return new Promise<string>((resolve, reject) => {
    const out = fs.createWriteStream(file, { flags: 'wx' });
    let size = 0;
    let failed = false;
    const fail = (e: Error) => {
      if (failed) return;
      failed = true;
      req.unpipe(out);
      out.destroy();
      fs.rm(file, { force: true }, () => reject(e));
    };
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        fail(new HttpError(413, 'That file is too big for a backup.'));
        req.destroy();
      }
    });
    req.on('error', fail);
    req.on('aborted', () => fail(new HttpError(400, 'The upload was cut off.')));
    out.on('error', fail);
    out.on('finish', () => !failed && resolve(file));
    req.pipe(out);
  });
}

function serveStatic(url: URL, res: http.ServerResponse): boolean {
  let rel = decodeURIComponent(url.pathname);
  if (rel.startsWith('/vendor/')) {
    const v = VENDOR[rel.slice(8)];
    if (!v) return false;
    const file = path.join(ROOT, v);
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'text/javascript',
      'cache-control': 'max-age=86400',
    });
    fs.createReadStream(file)
      .on('error', () => res.destroy())
      .pipe(res);
    return true;
  }
  if (rel === '/' || !path.extname(rel)) rel = '/index.html';
  const file = path.resolve(PUBLIC, '.' + rel);
  if (!file.startsWith(PUBLIC + path.sep) || !exists(file) || !fs.statSync(file).isFile()) return false;
  const headers: Record<string, string> = {
    'content-type': MIME[path.extname(file)] || 'application/octet-stream',
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
  };
  // Agent output is shown as markdown: no outside scripts, and images only from here (nothing leaks out).
  if (file.endsWith('.html')) {
    headers['content-security-policy'] = pageCsp(PORT, VITE);
    // The page opens in the scheme picked in Settings > Appearance, before anything is drawn: the saved theme goes onto
    // <html> ("system" leaves it off, for the stylesheet to follow the computer). The page does the same on a change.
    const theme = getSettings().look.theme;
    const page = fs.readFileSync(file, 'utf8');
    const html = VITE && rel === '/index.html' ? devPage(page, VITE) : page;
    res.writeHead(200, headers);
    res.end(
      theme === 'light' || theme === 'dark'
        ? html.replace('<html lang="en"', `<html lang="en" data-theme="${theme}"`)
        : html,
    );
    return true;
  }
  res.writeHead(200, headers);
  fs.createReadStream(file)
    .on('error', () => res.destroy())
    .pipe(res);
  return true;
}

const server = http.createServer(async (req, res) => {
  // Only answer requests addressed to this machine (stops DNS-rebinding tricks).
  if (!ALLOWED_HOSTS.has(String(req.headers.host || '').toLowerCase())) {
    res.writeHead(421);
    return res.end('Wrong host');
  }
  const url = new URL(req.url!, `http://${req.headers.host}`);
  // Browsers label requests from other websites (an <img> or link pointing here). Only the X callback may arrive that way.
  const site = req.headers['sec-fetch-site'];
  if (
    site &&
    site !== 'same-origin' &&
    site !== 'none' &&
    !['/oauth/x/callback', '/oauth/reddit/callback'].includes(url.pathname) &&
    (url.pathname.startsWith('/api/') || url.pathname.startsWith('/oauth/'))
  ) {
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
      // /api/p/<projectId>/…: a route run inside that project (an Overview pane of a project that isn't open).
      // It names its project, so the open-project guard below doesn't apply; only the routes a pane uses take it.
      const scope = scopedRoute(url.pathname);
      const pathname = scope ? scope.path : url.pathname;
      const inScope = <T>(fn: () => T): T => (scope ? store.withProject(scope.project, fn) : fn());
      // A change made for the project the page shows, after another one was opened (in this tab or another):
      // refused, so it can't land in the wrong project. Project routes name their project themselves.
      const pageProject = req.headers['x-dash-project'];
      if (
        !scope &&
        !internal &&
        req.method !== 'GET' &&
        typeof pageProject === 'string' &&
        pageProject &&
        !url.pathname.startsWith('/api/projects') &&
        pageProject !== store.activeProject().id
      ) {
        throw new HttpError(409, 'Another project was opened meanwhile. Nothing was changed; try again.');
      }
      if (pathname === '/api/comfyui/view') return await comfy.proxyView(Object.fromEntries(url.searchParams), res);
      // an attached file: the raw bytes, streamed to disk (the router only reads JSON bodies)
      const upload = req.method === 'POST' && /^\/api\/uploads\/([\w-]+)$/.exec(pathname);
      if (upload) {
        const saved = await inScope(() => uploads.receive(req, upload[1], url.searchParams.get('path') || ''));
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(JSON.stringify(saved));
      }
      // the routes that moved to oRPC (server/rpc.ts); anything else is left for the routes below, its body unread
      // (run in another project: /api/p/<project> as the address wrote it)
      const prefix: `/api${string}` = `/api${scope ? url.pathname.slice('/api'.length, url.pathname.length - (scope.path.length - '/api'.length)) : ''}`;
      if (await inScope(() => handleRpc(req, res, prefix))) return;
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(pathname);
        if (!m) continue;
        const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        let out: unknown;
        if (r.raw) {
          const file = await receiveFile(req, FILE_LIMIT);
          try {
            out = await inScope(() => r.handler(params, file, Object.fromEntries(url.searchParams), res));
          } finally {
            fs.rmSync(file, { force: true });
          }
        } else {
          const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readBody(req);
          out = await inScope(() => r.handler(params, body, Object.fromEntries(url.searchParams), res));
        }
        if (out === undefined && res.headersSent) return;
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(JSON.stringify(out ?? null));
      }
      throw new HttpError(404, `No API route ${req.method} ${pathname}`);
    }
    // a project's scene and the scene library: sandboxed, apart from the page (server/scene/serve.ts)
    const scene = req.method === 'GET' ? sceneResponse(url.pathname, String(req.headers.host || '')) : null;
    if (scene) {
      res.writeHead(scene.status, scene.headers);
      return res.end(scene.body);
    }
    if (req.method === 'GET' && serveStatic(url, res)) return;
    res.writeHead(404);
    res.end('Not found');
  } catch (e) {
    const err = e as { status?: number; message?: string };
    const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
    if (status === 500) console.error(e);
    if (!res.headersSent) {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: err.message || String(e) }));
    } else res.end();
  }
});

// ---------- websockets: live events + terminals ----------
const wss = new WebSocketServer({ noServer: true });
const eventClients = new Set<WebSocket>();
// world_look answers in words at once when no page is open to draw a picture
worldLook.setOpenPages(() => [...eventClients].filter((ws) => ws.readyState === 1).length);
server.on('upgrade', (req, socket, head) => {
  const origin = req.headers.origin || '';
  const okOrigin = [...ALLOWED_HOSTS].some((h) => origin === `http://${h}`);
  if (!ALLOWED_HOSTS.has(String(req.headers.host || '').toLowerCase()) || !okOrigin) {
    socket.destroy();
    return;
  }
  const url = new URL(req.url!, `http://${req.headers.host}`);
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

// ---------- routines ----------

// ---------- start ----------
// The page is bundled into public/dist. Started without `bun run start` on a fresh checkout: build it now.
const pageReady = exists(path.join(PUBLIC, 'dist', 'app.js'))
  ? Promise.resolve()
  : new Promise<void>((done) => {
      console.log('  Building the page (public/dist)…');
      const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'build-web.ts')], {
        cwd: ROOT,
        stdio: 'inherit',
      });
      child.on('exit', (code) => {
        if (code) console.error('  Could not build the page. Run: bun run build');
        done();
      });
      child.on('error', () => done());
    });
ensureDir(dataPath('outputs'));
fs.rmSync(dataPath('tmp', 'received'), { recursive: true, force: true }); // uploads cut off by a crash
internalToken();
store.migrateLayout();
try {
  await eveRuntime.recover();
} catch (error) {
  if (error instanceof EveOwnershipError) throw error;
  log('error', 'Eve could not restore saved work. It will try again before accepting new Eve work.');
}
eveCoordinator.restore();
engines.recoverExecution();
teams.recoverTeamWork();
wfs.markInterruptedRuns();
wfs.startScheduler();
skills.ensureBuiltinSkills();
learning.startLearning();
irc.startIrc();
eveCoordinator.start();
await gatewaySupervisor.start();
boardWork.boardWork.start();
void irc
  .recoverWork()
  .catch((e: unknown) =>
    store.log('error', `Couldn't resume saved work: ${e instanceof Error ? e.message : String(e)}`),
  );
routinesMod.markInterruptedRoutines();
routinesMod.startRoutineScheduler();
projectSync.startAutoSave();
startSceneWatch();
programs.startProgramScan();
programs.startRunningWatch();

server.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EADDRINUSE') {
    console.log(`Athena Agents is already running at http://localhost:${PORT}`);
    if (OPEN) openWithShell(`http://localhost:${PORT}`);
    process.exit(0);
  }
  throw e;
});

store.migrateGlobalOutbox();
server.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}`;
  console.log(
    `\n  Athena Agents is running at ${url}\n  Data folder: ${dataPath()}${VITE ? `\n  Hot reload: the page's code comes from ${VITE}` : ''}\n  Press Ctrl+C to stop.\n`,
  );
  log('system', 'Dashboard started');
  if (OPEN) void pageReady.then(() => openWithShell(url));
});

let stopping = false;
const shutdown = () => {
  if (stopping) return;
  stopping = true;
  terms.closeAll();
  // agents' CLIs are stopped too: they would go on writing into the project with no dashboard to see it
  void Promise.allSettled([gatewaySupervisor.stop(), engines.stopAllRuns()])
    .finally(() => Promise.allSettled([eveCoordinator.close(), eveRuntime.close()]))
    .finally(() => {
      try {
        saveToolStats();
      } catch {
        /* the numbers are only a help */
      }
      process.exit(0);
    });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
// The desktop app holds our stdin open. It closes when the app quits or crashes: stop with it.
if (process.env.DASH_DESKTOP) {
  process.stdin.on('end', shutdown);
  process.stdin.on('error', shutdown);
  process.stdin.resume();
}
process.on('unhandledRejection', (e) => console.error('Unhandled:', e));
