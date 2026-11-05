// Athena Agents: a local, login-free command center for agents, tools, programs, MCP servers and social accounts.
// Listens on 127.0.0.1 only. Run: node server/index.js [--port 4800] [--no-open]
import http from 'node:http';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import { ROOT, PORT as DEFAULT_PORT, setPort, dataPath, exists, openWithShell, run, ensureDir, readJSON, writeJSON, insideRoots } from './util.ts';
import * as store from './store.ts';
import { agents, chats, outbox, artifacts as artifactStore, workflows, bus, getSettings, internalToken, log } from './store.ts';
import { requestApproval, setReviewer } from './approvals.ts';
import * as engines from './engines/index.ts';
import { eveRuntime } from './eve/runtime.ts';
import { EveOwnershipError } from './eve/ownership.ts';
import { eveCoordinator } from './eve/coordinator.ts';
import * as gateways from './gateways/instances.ts';
import { discordRecovery } from './gateways/discord-recovery.ts';
import { whatsAppSetup } from './gateways/whatsapp-setup.ts';
import { gatewaySupervisor } from './gateways/live.ts';
import { gatewayDeliveryReview, gatewayInboxHistory, gatewayRetiredInboxHistory, gatewayRetiredFinishReview, gatewayRequestReview, gatewayWhatsAppRecovery, gatewayWhatsAppReplacement, gatewayWhatsAppSenders, gatewayWorkReview } from './gateways/inbox.ts';
import { gatewayRetirement, listGatewayRetirements } from './gateways/retirement.ts';
import { telegramSetup } from './gateways/telegram-setup.ts';
import { gatewayOutboxDestinations } from './gateways/outbox-owner.ts';
import { readGatewayPostDelivery } from './gateways/outbox-posts.ts';
import { listProfiles } from './engines/hermes.ts';
import * as codexEngine from './engines/codex.ts';
import * as piEngine from './engines/pi.ts';
import * as openclawEngine from './engines/openclaw.ts';
import { clearWhichCache, which } from './util.ts';
import * as tools from './tools.ts';
import { inlineToolImagesNoted, withImageNote } from './toolimages.ts';
import * as programs from './programs.ts';
import * as comfy from './comfyui.ts';
import * as mcp from './mcp.ts';
import * as social from './social.ts';
import { addArtifact, removeArtifact } from './artifacts.ts';
import * as teamMarks from './teammark.ts';
import * as taskBoard from './taskboard.ts';
import * as boardWork from './boardwork.ts';
import { taskFilePath } from './boardfiles.ts';
import * as memory from './memory.ts';
import * as wfs from './workflows.ts';
import * as worldLink from './voxel/link.ts';
import * as worldBuild from './voxel/build.ts';
import * as worldStore from './voxel/store.ts';
import * as worldMd from './voxel/worldmd.ts';
import * as worldScene from './voxel/scene.ts';
import * as worldLook from './voxel/look.ts';
import * as worldExchange from './voxel/exchange.ts';
import * as worldPrefabs from './voxel/prefabs.ts';
import * as worldCharacters from './voxel/characters.ts';
import { listVersions, getVersion, withActor } from './versions.ts';
import * as terms from './terminals.ts';
import * as codexLimits from './codexlimits.ts';
import * as brain from './brain.ts';
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
import * as uistream from './uistream.ts';
import * as routinesMod from './routines.ts';
import * as backup from './backup.ts';
import { saveToolStats } from './toolstats.ts';
import { handleRpc, JSON_LIMIT } from './rpc.ts';
import { usageLimits } from './api/status.ts';
import type { Agent, Project, WorldBuilder } from '../shared/types.ts';

// If the dashboard was started from inside a Claude Code session, don't let agents inherit that session's markers.
for (const k of ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_CODE_SESSION_ID']) delete process.env[k];

const argv = process.argv.slice(2);
const PORT = (argv.includes('--port') && Number(argv[argv.indexOf('--port') + 1])) || DEFAULT_PORT;
setPort(PORT);
const OPEN = !argv.includes('--no-open') && !process.env.DASH_NO_OPEN;
const PUBLIC = path.join(ROOT, 'public');
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`]);

// Only the terminal's stylesheet comes straight from node_modules; the scripts are bundled into public/dist.
const VENDOR: Record<string, string> = {
  'xterm.css': 'node_modules/@xterm/xterm/css/xterm.css',
};
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.m4a': 'audio/mp4', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.woff2': 'font/woff2' };

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
const put = <B = Body>(p: string, h: Handler<B>) => route('PUT', p, h);
const del = <B = Body>(p: string, h: Handler<B>) => route('DELETE', p, h);

// The routes an Overview pane uses for a project that isn't open (/api/p/<projectId>/…): an agent's chats and its
// details, a team's thread, a chat's tasks, the questions its agents ask, the Brain's chat, MEMORY.md and its
// versions, attached files, and showing that project's files.
// Everything else (projects, settings, keys, backups) stays global.
const SCOPED = /^\/(agents(\/[\w-]+(\/.*)?)?|teams\/[\w-]+\/.+|workflows|tasks(\/[\w-]+)?|questions(\/[\w-]+\/(answer|dismiss))?|brain\/(history|stream|steer)|memory\/[\w-]+|versions\/memory\/[^/]+(\/[^/]+(\/restore)?)?|uploads(\/[\w-]+)?|file|files\/(info|open|reveal))$/;
function scopedRoute(pathname: string): { project: Project; path: string } | null {
  const m = /^\/api\/p\/([^/]+)(\/.*)$/.exec(pathname);
  if (!m) return null;
  const project = store.listProjects().find((p) => p.id === decodeURIComponent(m[1]));
  if (!project) throw new HttpError(404, 'That project is unavailable.');
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
const EXTERNAL: ExternalAgent = { id: '_external', name: 'External MCP client', toolGroups: tools.TOOL_GROUPS.map((g) => g.id).filter((g) => g !== 'shell'), autonomy: 'ask', knowledge: { folders: [] } };
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
get('/api/backups', async () => ({ dir: backup.backupsRoot(), backups: backup.listBackups() }));
post('/api/backups/open', async () => {
  openWithShell(ensureDir(backup.backupsRoot()));
  return { ok: true };
});
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
// Where things sit on the Station map (per project), e.g. { bench: { x, z } }.
get('/api/layout', async () => readJSON<Record<string, unknown>>(store.projectData('layout.json'), {}));
put<Body | null>('/api/layout', async (_p, body) => {
  writeJSON(store.projectData('layout.json'), { ...readJSON<Record<string, unknown>>(store.projectData('layout.json'), {}), ...(body || {}) });
  store.emit('layout');
  return { ok: true };
});

// ---------- the Brain: its folder, asking it, its history and its skills are server/api/brain.ts ----------
// Pick who handles a message, design a new agent, build a branch.
post<{ text?: unknown }>('/api/assist/route', async (_p, body) => brain.route(String(body.text || '')));
get('/api/assist/model', async () => brain.brainModel());
// The Brain answers agents' and teams' permission requests (Settings > The Brain approves).
setReviewer(overseer.reviewApproval);
// Asking it anything about the project, streamed (Vercel AI SDK UI message stream): the answer as it is written, the files the
// Brain reads, then the whole answer (data-answer). The Brain chat reads it with the AI SDK.
post<{ text?: unknown; project?: unknown; attachments?: unknown; goal?: unknown }>('/api/brain/stream', async (_p, body, _q, res) => {
  const attachments = uploads.cleanAttachments(body.attachments);
  const text = String(body.text || '').trim().slice(0, 20000);
  if (!text && !attachments.length) throw new HttpError(400, 'Type a message first.');
  const project = typeof body.project === 'string' ? body.project : null;
  // (refused before the stream starts, so it comes back as an error the chat can show)
  overseer.checkProject(project);
  await uistream.streamBrain(res, (onPart) => overseer.ask(text, { project, attachments, onPart, goal: body.goal === true }));
  return undefined;
});
post<{ text?: unknown; attachments?: unknown }>('/api/assist/agent', async (_p, body) => brain.designAgent(String(body.text || ''), { attachments: uploads.cleanAttachments(body.attachments) }));
post<{ text?: unknown; allowNew?: unknown; attachments?: unknown }>('/api/assist/branch', async (_p, body) => brain.designBranch(String(body.text || ''), { allowNew: body.allowNew !== false, attachments: uploads.cleanAttachments(body.attachments) }));
// Uses one free Codex limit reset (the one that runs out first unless one is named). You click for it.
post<{ creditId?: unknown }>('/api/codex/reset', async (_p, body) => {
  const r = await codexLimits.useCodexReset(typeof body.creditId === 'string' ? body.creditId : null);
  log('codex', r.outcome === 'reset' ? 'Used a free Codex limit reset' : `Codex limit reset not used (${r.outcome})`);
  return { outcome: r.outcome, limits: await usageLimits(r.limits) };
});

// ---------- agents ----------
// server/api/agents.ts, with their chats; a chat's run streams are below

// a chat's tasks: server/api/tasks.ts. The Tasks board: server/api/taskboard.ts, except a task's files (below)
const boardProject = (id: string) => need(store.listProjects().find((p) => p.id === id));
// A file on a task or one of its comments (?path= as the task lists it), from the task's own project.
get('/api/task-board-file/:projectId/:id', async ({ projectId, id }, _b, q, res) => {
  const p = boardProject(projectId);
  const t = need(taskBoard.savedBoardTask(projectId, id));
  const listed = [...(t.files || []), ...(t.comments || []).flatMap((c) => c.files || [])].some((f) => f.path === q.path);
  const file = listed ? taskFilePath(p, q.path) : null;
  if (!file) throw new HttpError(404, 'That file is missing.');
  sendFileSafely(res, file);
  return undefined;
});
// The chat views (Vercel AI SDK useChat): send a message and stream its run as a UI message stream,
// or pick up the run going in a chat (the turn so far, then the rest; 204 when nothing runs).
// steer: sent while it works, it stops the run going now and goes next (its /queue messages still wait).
post<{ text?: unknown; attachments?: unknown; steer?: unknown }>('/api/agents/:id/chats/:cid/stream', async ({ id, cid }, body, _q, res) => {
  const a = need(agents.get(id));
  const c = need(chats.get(id, cid));
  const text = String(body.text || '').trim();
  const attachments = uploads.cleanAttachments(body.attachments);
  if (!text && !attachments.length) throw new HttpError(400, 'Type a message first.');
  const { runId, steerId } = body.steer === true ? await engines.steerChat(a, c, text, { attachments }) : { ...engines.startRun(a, c, text, { attachments }), steerId: undefined };
  await uistream.streamRun(res, { chatId: c.id, runId, waiting: `Waiting for ${a.name} to stop…`, ...(steerId ? { ownSteer: steerId } : {}), live: engines.runActive });
  return undefined;
});
get('/api/agents/:id/chats/:cid/stream', async ({ id, cid }, _b, _q, res) => {
  const runId = engines.chatRunId(id, cid);
  if (!runId) {
    res.writeHead(204, { 'cache-control': 'no-store' });
    res.end();
    return undefined;
  }
  await uistream.streamRun(res, { chatId: cid, runId, items: engines.liveChat(cid)?.items || [] });
  return undefined;
});


// ---------- skills: server/api/skills.ts ----------
// A skill written or changed from plain words: a draft for the editor, saved only when you press Save.
// slug: the skill being edited (for its files); current: what the editor holds now (unsaved changes too).
post<{ text?: unknown; slug?: unknown; current?: unknown; attachments?: unknown }>('/api/assist/skill', async (_p, body) => {
  const text = String(body.text || '').trim().slice(0, 8000);
  const attachments = uploads.cleanAttachments(body.attachments);
  if (!text && !attachments.length) throw new HttpError(400, 'Say what the skill should do, or what to change.');
  const c = (body.current && typeof body.current === 'object' ? body.current : null) as Record<string, unknown> | null;
  const saved = typeof body.slug === 'string' ? skills.getSkill(body.slug) : null;
  const field = (k: 'name' | 'description' | 'body', max: number) => (typeof c?.[k] === 'string' ? (c[k] as string) : saved?.[k] || '').slice(0, max);
  const now = { name: field('name', 80), description: field('description', 1000), body: field('body', 60000) };
  // nothing written yet (a new skill's empty editor): a new skill, not an edit of an empty one
  const current = now.name.trim() || now.description.trim() || now.body.trim() ? now : null;
  return brain.draftSkill(text, {
    current,
    files: saved?.files.map((f) => f.path) || [],
    others: skills.listSkills().filter((s) => s.slug !== saved?.slug),
    attachments,
  });
});

// ---------- MEMORY.md: each agent's and the Brain's ("brain") ----------
const memoryOwner = (owner: string): string => {
  if (owner !== memory.BRAIN && !agents.get(owner)) throw new HttpError(404, 'No agent by that id.');
  return owner;
};
get('/api/memory/:owner', async ({ owner }) => memory.memoryInfo(memoryOwner(owner)));
put<{ text?: unknown } | null>('/api/memory/:owner', async ({ owner }, body) => {
  if (typeof body?.text !== 'string') throw new HttpError(400, 'Send the whole MEMORY.md as text.');
  const before = memory.memoryStamp(memoryOwner(owner));
  const m = memory.writeMemory(owner, body.text);
  if (m.updatedAt !== Math.round(before)) log('memory', `You edited ${memory.memoryTitle(owner)}`, owner === memory.BRAIN ? {} : { agentId: owner });
  return m;
});

// ---------- the voxel world (server/voxel, docs/internal/plans/VOXEL_WORLD_PLAN.md) ----------
const you: WorldBuilder = { kind: 'user', name: 'You' };
const projectName = (id?: string) => (id ? store.listProjects().find((p) => p.id === id)?.name : undefined);
get('/api/world', async () => {
  const s = worldLink.shownWorld();
  return { ...s, fromProjectName: projectName(s.fromProject) };
});
get('/api/worlds/:wid/objects/:oid', async ({ wid, oid }) => {
  const data = worldStore.readObject(wid, oid);
  if (!data) throw new HttpError(404, 'No such object.');
  return data;
});
get('/api/worlds/:wid/prefabs/:pid', async ({ wid, pid }) => {
  const data = worldStore.readPrefab(wid, pid);
  if (!data) throw new HttpError(404, 'No such prefab.');
  return data;
});
put<Record<string, unknown> | null>('/api/world/objects/:oid', async ({ oid }, body) => worldBuild.changeObject({ ...(body || {}), delete: false, duplicate: false, object: oid, by: you }).object);
del('/api/world/objects/:oid', async ({ oid }) => (worldBuild.changeObject({ object: oid, delete: true, by: you }), { ok: true }));
post<{ anyone?: unknown } | null>('/api/world/undo', async (_p, body) => worldBuild.undo(you, { anyone: body?.anyone !== false }));
get('/api/world/md', async () => {
  const w = worldLink.shownWorld().world;
  if (!w) throw new HttpError(404, 'No world yet.');
  return worldMd.worldMdInfo(w.id);
});
put<{ text?: unknown } | null>('/api/world/md', async (_p, body) => {
  if (typeof body?.text !== 'string') throw new HttpError(400, 'Send the whole WORLD.md as text.');
  // (a carried-over world becomes this project's own first: you are changing it)
  const w = worldLink.worldForBuild();
  const m = worldMd.writeWorldMd(w.id, body.text);
  log('world', 'You edited WORLD.md');
  return m;
});
put<Record<string, unknown> | null>('/api/world/environment', async (_p, body) => worldScene.setEnvironment({ by: you, fields: body || {} }).world);
// a picture an open Station made for world_look
post<{ image?: unknown; error?: unknown } | null>('/api/world/snapshot/:request', async ({ request }, body) => ({ ok: worldLook.deliverLook(request, body || {}) }));
// WORLD.md's earlier versions
const shownWorldId = () => {
  const w = worldLink.shownWorld().world;
  if (!w) throw new HttpError(404, 'No world yet.');
  return w.id;
};
get('/api/world/md/versions', async () => listVersions<{ text: string }>(worldMd.worldMdVersionsDir(shownWorldId())).map((v) => ({ id: v.id, at: v.at, by: v.by, note: v.note, chars: v.item.text.length })));
get('/api/world/md/versions/:vid', async ({ vid }) => {
  const v = getVersion<{ text: string }>(worldMd.worldMdVersionsDir(shownWorldId()), vid);
  if (!v) throw new HttpError(404, 'No such version.');
  return v;
});
post('/api/world/md/versions/:vid/restore', async ({ vid }) => {
  const v = getVersion<{ text: string }>(worldMd.worldMdVersionsDir(shownWorldId()), vid);
  if (!v) throw new HttpError(404, 'No such version.');
  const m = withActor('you', () => worldMd.writeWorldMd(worldLink.worldForBuild().id, v.item.text), { note: `restored the version from ${new Date(v.at).toLocaleString()}`, force: true });
  log('world', 'You restored an earlier WORLD.md');
  return m;
});
get('/api/world/changes', async () => worldBuild.recentChanges(shownWorldId(), 50));
get('/api/world/prefabs', async () => {
  const w = worldLink.shownWorld().world;
  if (!w) return [];
  const uses = worldPrefabs.prefabUses(w);
  return w.prefabs.map((p) => ({ ...p, uses: uses.get(p.id) || null }));
});
put<Record<string, unknown> | null>('/api/world/prefabs/:pid', async ({ pid }, body) => worldPrefabs.changePrefab({ by: you, prefab: pid, name: body?.name, description: body?.description, tags: body?.tags }).prefab);
del('/api/world/prefabs/:pid', async ({ pid }) => ({ text: worldPrefabs.deletePrefab({ by: you, prefab: pid }) }));
put<Record<string, unknown> | null>('/api/world/lights/:lid', async ({ lid }, body) => worldScene.setLight({ by: you, action: 'change', light: lid, fields: body || {} }).light);
del('/api/world/lights/:lid', async ({ lid }) => (worldScene.setLight({ by: you, action: 'remove', light: lid }), { ok: true }));
put<Record<string, unknown> | null>('/api/world/effects/:eid', async ({ eid }, body) => worldScene.setEffect({ by: you, action: 'change', effect: eid, fields: body || {} }).effect);
del('/api/world/effects/:eid', async ({ eid }) => (worldScene.setEffect({ by: you, action: 'remove', effect: eid }), { ok: true }));
// files out of the world (to Artifacts and the project folder's exports/), and pictures from the page
const exportsDir = () => path.join(projects.ensureBrain(), 'exports');
post<{ what?: unknown; id?: unknown; format?: unknown } | null>('/api/world/export', async (_p, body) => {
  const w = worldLink.shownWorld().world;
  if (!w) throw new HttpError(404, 'No world yet.');
  const what = String(body?.what || '');
  if (what !== 'object' && what !== 'prefab' && what !== 'world') throw new HttpError(400, 'what is object, prefab or world.');
  const out = worldExchange.exportFiles(w, what, typeof body?.id === 'string' ? body.id : undefined, body?.format === 'vox' ? 'vox' : 'glb');
  const paths = worldExchange.writeFiles(exportsDir(), out.files);
  const made = paths.map((p) => addArtifact({ title: out.files.length > 1 ? `${out.title}: ${path.basename(p)}` : out.title, path: p, note: out.note || 'Made from the voxel world', by: 'You' }));
  return { paths, artifacts: made.map((a) => a.id), note: out.note };
});
post<{ image?: unknown; name?: unknown } | null>('/api/world/picture', async (_p, body) => {
  const w = worldLink.shownWorld().world;
  const file = worldExchange.writePicture(exportsDir(), String(body?.name || w?.name || 'world'), String(body?.image || ''));
  const a = addArtifact({ title: `${w?.name || 'The world'}: a picture`, path: file, note: 'A picture of the voxel world', by: 'You' });
  return { path: file, artifact: a.id };
});
get('/api/prefab-library', async (_p, _b, q) => worldPrefabs.libraryItems(String(q.q || '')));
post<{ name?: unknown; as?: unknown } | null>('/api/world/prefabs/import', async (_p, body) => worldPrefabs.importPrefab({ by: you, name: String(body?.name || ''), as: body?.as }).prefab);
post('/api/world/prefabs/:pid/publish', async ({ pid }) => ({ text: worldPrefabs.publishPrefab({ by: you, prefab: pid }) }));
// how the Brain, a team or an agent looks (e.g. put a hidden agent back on the map)
put<{ to?: unknown; id?: unknown; fields?: unknown } | null>('/api/world/skins', async (_p, body) => {
  const to = String(body?.to || '');
  if (to !== 'agent' && to !== 'team' && to !== 'brain') throw new HttpError(400, 'to is agent, team or brain.');
  return worldCharacters.setSkin({ by: you, to, id: typeof body?.id === 'string' ? body.id : undefined, fields: body?.fields && typeof body.fields === 'object' ? (body.fields as Record<string, unknown>) : {} }).world.skins;
});
get('/api/worlds', async () => worldLink.listWorldsFor());
put<{ worldId?: unknown; mode?: unknown } | null>('/api/project-world', async (_p, body) => {
  const mode = String(body?.mode || '');
  if (!['share', 'copy', 'new', 'auto'].includes(mode)) throw new HttpError(400, 'mode is share, copy, new or auto.');
  return worldLink.chooseWorld(store.activeProject().id, mode as worldLink.WorldChoice, typeof body?.worldId === 'string' ? body.worldId : null);
});
put<{ worldId?: unknown } | null>('/api/worlds/default', async (_p, body) => (worldLink.setDefaultWorld(typeof body?.worldId === 'string' && body.worldId ? body.worldId : null), { ok: true }));
put<{ name?: unknown } | null>('/api/worlds/:wid', async ({ wid }, body) => worldLink.renameWorld(wid, body?.name));
del('/api/worlds/:wid', async ({ wid }) => (worldLink.deleteUnusedWorld(wid), { ok: true }));

// (versions, presets and the library: server/api/versions.ts, library.ts)

// ---------- models: server/api/status.ts ----------
get('/api/hermes/profiles', async () => listProfiles());
get('/api/openclaw/agents', async () => openclawEngine.listAgents().catch(() => []));
// OpenAI Codex: install the CLI (npm) and check its sign-in.
post('/api/codex/install', async () => {
  const r = await run('npm', ['install', '-g', '@openai/codex'], { timeout: 10 * 60_000 });
  clearWhichCache();
  codexEngine.refreshStatus();
  if (r.code !== 0) throw new HttpError(500, (r.stderr || r.stdout).trim().slice(-600) || 'npm install failed');
  log('system', 'Installed OpenAI Codex CLI');
  return { message: 'Codex installed. Now sign in.' };
});
post('/api/codex/refresh', async () => {
  clearWhichCache();
  codexEngine.refreshStatus();
  codexEngine.status();
  await new Promise((r) => setTimeout(r, 3500));
  return codexEngine.status();
});

// ---------- tools & programs ----------
get('/api/programs', async (_p, _b, q) => programs.discoverPrograms(!!q.force));
get('/api/programs/all', async () => programs.startMenuApps(true));
post<{ program: string; file?: string }>('/api/programs/launch', async (_p, body) => {
  const msg = await programs.launchProgram(body.program, { file: body.file });
  log('program', msg);
  return { message: msg };
});
post<{ target: string }>('/api/programs/open', async (_p, body) => {
  openWithShell(body.target);
  return { ok: true };
});

// ComfyUI
get('/api/comfyui', async () => ({ status: await comfy.queueStatus(), workflows: comfy.listWorkflows().map(({ name, dir }) => ({ name, dir })) }));
get('/api/comfyui/describe', async (_p, _b, q) => comfy.describeWorkflow(q.workflow));
post<{ workflow: string; prompt?: string; negative?: string; inputs?: Record<string, unknown> }>('/api/comfyui/run', async (_p, body) => comfy.runWorkflow({ workflow: body.workflow, prompt: body.prompt || undefined, negative: body.negative || undefined, inputs: body.inputs || {} }));
post('/api/comfyui/start', async () => ({ message: await comfy.startComfy() }));
post<{ name: string; json: unknown }>('/api/comfyui/workflows', async (_p, body) => ({ file: comfy.saveApiWorkflow(body.name, body.json) }));

// ---------- attached files (saved in the Brain folder's uploads/) ----------
// One folder per drop; then each file is sent raw to POST /api/uploads/<batch>?path=<relative path> (handled below the router).
post('/api/uploads', async () => uploads.newBatch());
del('/api/uploads', async (_p, _b, q) => ({ ok: uploads.removeUpload(q.path) }));

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

// Files a chat mentions: whether each is there and what it is (for its preview), Show in Explorer / Finder,
// and Open (the desktop app: with the file's own program).
post<{ paths?: unknown }>('/api/files/info', async (_p, body) => files.fileInfo(body.paths));
post<{ path?: unknown }>('/api/files/reveal', async (_p, body) => {
  files.reveal(body.path);
  return { ok: true };
});
post<{ path?: unknown }>('/api/files/open', async (_p, body) => {
  files.open(body.path);
  return { ok: true };
});

// Agent-made files are shown, never run: only media display inline; everything else downloads, sandboxed.
function sendFileSafely(res: http.ServerResponse, p: string, type = MIME[path.extname(p).toLowerCase()] || 'application/octet-stream') {
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
    ...(inline ? {} : { 'content-disposition': `attachment; filename="${path.basename(p).replace(/[^\w.\- ]/g, '_')}"` }),
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

// ---------- MCP ----------
get('/api/mcp', async () => {
  const servers = mcp.listServers();
  // (keys, logins and the bridge's token stay hidden here: POST /api/mcp-bridge gives the bridge config to copy)
  const bridge = mcp.bridgeServerConfig('');
  return {
    servers: mcp.hiddenServers(servers),
    info: mcp.serverInfo(servers),
    presets: mcp.presetAvailability(servers),
    suggested: mcp.suggestPresets(await programs.discoverPrograms(), servers),
    importable: mcp.importableServers().map((s) => mcp.hideSecrets(s)),
    bridge: { ...bridge, env: { ...bridge.env, DASH_TOKEN: mcp.HIDDEN } },
  };
});
post('/api/mcp-bridge', async () => mcp.bridgeServerConfig(''));
post<Parameters<typeof mcp.saveServer>[1] & { name: string }>('/api/mcp', async (_p, body) => mcp.saveServer(body.name, body));
del('/api/mcp/:name', async ({ name }) => {
  // (and off every agent and team that had it)
  mcp.removeServerEverywhere(name);
  return { ok: true };
});
post('/api/mcp/:name/test', async ({ name }) => ({ tools: await mcp.testServer(name) }));
// another copy of a service needs a label; "others" sets the label and "use for" of the copies already there
post<{ name?: string; label?: string; useFor?: string; others?: Record<string, { label?: string; useFor?: string }> }>('/api/mcp-preset', async (_p, body) => {
  const pr = need(mcp.PRESETS.find((x) => x.name === body.name), 'Unknown preset');
  const made = mcp.addPreset(pr.name, { label: body.label, useFor: body.useFor });
  // (only label and "use for" change: the copies' connections stay open, and an unchanged one isn't saved)
  const servers = mcp.listServers();
  for (const [name, notes] of Object.entries(body.others || {})) if (name !== made.name && servers[name]) mcp.describeCopy(name, { label: notes?.label, useFor: notes?.useFor });
  return made;
});
post<{ name?: string; source?: string }>('/api/mcp-import', async (_p, body) => {
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
// pi and oh-my-pi: the bridge goes in their own mcp.json (neither takes MCP servers per run)
post<{ flavor?: string }>('/api/pi/add-bridge', async (_p, body) => {
  const flavors: piEngine.PiFlavor[] = body.flavor === 'pi' || body.flavor === 'omp' ? [body.flavor] : (['pi', 'omp'] as const).filter((f) => which(f));
  if (!flavors.length) throw new HttpError(400, 'Neither pi nor oh-my-pi is installed on this PC.');
  const files: string[] = [];
  for (const f of flavors) {
    try {
      files.push(piEngine.addBridge(f));
    } catch (e) {
      throw new HttpError(500, (e as Error).message);
    }
  }
  log('mcp', `Gave ${flavors.map((f) => (f === 'pi' ? 'pi' : 'oh-my-pi')).join(' and ')} the dashboard tools (${files.join(', ')})`);
  return { message: `Added to ${files.join(' and ')}. New ${flavors.includes('pi') ? 'pi' : 'oh-my-pi'} sessions have the dashboard tools.`, files };
});

// ---------- settings ----------
get('/api/gateways', async () => ({
  instances: gateways.listGatewayInstances().map((instance) => ({ ...instance, targetName: gateways.gatewayTargetName(instance), credentials: gateways.gatewayCredentialStatus(instance.id) })),
  health: gatewaySupervisor.health(),
}));
post<unknown>('/api/gateways', async (_p, body) => gateways.saveGatewayInstance(body));
get('/api/gateways/retired', async () => ({ instances: listGatewayRetirements() }));
get('/api/gateways/retired/:id/inbox', async ({ id }) => ({ events: gatewayRetiredInboxHistory(id) }));
get('/api/gateways/retired/:id/inbox/:eventId/local-finish', async ({ id, eventId }) => gatewayRetiredFinishReview(id, eventId));
post<unknown>('/api/gateways/retired/:id/inbox/:eventId/local-finish/prepare', async ({ id, eventId }, body) => gatewaySupervisor.prepareRetiredFinish(id, eventId, body));
post<unknown>('/api/gateways/retired/:id/inbox/:eventId/local-finish', async ({ id, eventId }, body) => gatewaySupervisor.finishRetired(id, eventId, body));
get('/api/gateways/targets/:projectId', async ({ projectId }) => gateways.gatewayTargets(projectId));
get('/api/gateways/:id/inbox', async ({ id }) => ({ events: gatewayInboxHistory(id) }));
get('/api/gateways/:id/inbox/:eventId/review', async ({ id, eventId }) => gatewayRequestReview(id, eventId));
get('/api/gateways/:id/inbox/:eventId/work-review', async ({ id, eventId }) => gatewayWorkReview(id, eventId));
post('/api/gateways/:id/inbox/:eventId/work-review/prepare', async ({ id, eventId }) => gatewaySupervisor.prepareWorkReview(id, eventId));
post<unknown>('/api/gateways/:id/inbox/:eventId/work-review/keep', async ({ id, eventId }, body) => gatewaySupervisor.keepWork(id, eventId, body));
get('/api/gateways/:id/inbox/:eventId/delivery-review', async ({ id, eventId }) => gatewayDeliveryReview(id, eventId));
post('/api/gateways/:id/inbox/:eventId/delivery-review/prepare', async ({ id, eventId }) => gatewaySupervisor.prepareDeliveryReview(id, eventId));
post<unknown>('/api/gateways/:id/inbox/:eventId/delivery-review', async ({ id, eventId }, body) => gatewaySupervisor.reviewDelivery(id, eventId, body));
post<unknown>('/api/gateways/:id/inbox/:eventId/dismiss', async ({ id, eventId }, body) => {
  await gatewaySupervisor.dismissRequest(id, eventId, body); return { ok: true };
});
get('/api/gateways/:id/discord-recovery', async ({ id }) => discordRecovery(id));
get('/api/gateways/:id/telegram-setup', async ({ id }) => telegramSetup(id));
post('/api/gateways/:id/telegram-setup/check', async ({ id }) => gatewaySupervisor.checkTelegramSetup(id));
post<unknown>('/api/gateways/:id/telegram-setup/switch', async ({ id }, body) => gatewaySupervisor.switchTelegramToPolling(id, body));
get('/api/gateways/:id/whatsapp-setup', async ({ id }) => whatsAppSetup(id));
post('/api/gateways/:id/whatsapp-setup/check', async ({ id }) => gatewaySupervisor.checkWhatsAppSetup(id));
get('/api/gateways/:id/whatsapp-recovery', async ({ id }) => gatewayWhatsAppRecovery(id));
get('/api/gateways/:id/whatsapp-replacement', async ({ id }) => gatewayWhatsAppReplacement(id));
get('/api/gateways/:id/whatsapp-senders', async ({ id }) => gatewayWhatsAppSenders(id));
post<unknown>('/api/gateways/:id/whatsapp-senders/review', async ({ id }, body) => gatewaySupervisor.reviewWhatsAppSender(id, body));
post('/api/gateways/:id/whatsapp-recovery/inspect', async ({ id }) => gatewaySupervisor.inspectWhatsAppRecovery(id));
post<unknown>('/api/gateways/:id/whatsapp-recovery', async ({ id }, body) => gatewaySupervisor.reviewWhatsAppRecovery(id, body));
post<unknown>('/api/gateways/:id/whatsapp-recovery/restore', async ({ id }, body) => gatewaySupervisor.restoreWhatsAppRecovery(id, body));
post<unknown>('/api/gateways/:id/whatsapp-pairing', async ({ id }, body) => gatewaySupervisor.pairWhatsApp(id, body));
post<unknown>('/api/gateways/:id/whatsapp-pairing/replace', async ({ id }, body) => gatewaySupervisor.replaceWhatsAppPairing(id, body));
post<unknown>('/api/gateways/:id/whatsapp-pairing/finish', async ({ id }, body) => gatewaySupervisor.finishWhatsAppPairing(id, body));
post<unknown>('/api/gateways/:id/whatsapp-pairing/review', async ({ id }, body) => gatewaySupervisor.reviewWhatsAppPairing(id, body));
post<unknown>('/api/gateways/:id/discord-recovery', async ({ id }, body) => {
  await gatewaySupervisor.reviewDiscordRecovery(id, body);
  return { gap: null };
});
post<unknown>('/api/gateways/:id/inbox/cleanup', async ({ id }, body) => gatewaySupervisor.cleanup(id, body));
put<unknown>('/api/gateways/:id', async ({ id }, body) => gateways.saveGatewayInstance(body, id));
put<unknown>('/api/gateways/:id/credentials', async ({ id }, body) => {
  gateways.saveGatewayCredentials(id, body);
  return gateways.gatewayCredentialStatus(id);
});
post<unknown>('/api/gateways/:id/credentials', async ({ id }, body) => {
  gateways.updateGatewayCredentials(id, body);
  return gateways.gatewayCredentialStatus(id);
});
post('/api/gateways/:id/reconnect', async ({ id }) => {
  gateways.getGatewayInstance(id);
  await gatewaySupervisor.reconnect(id);
  return { ok: true };
});
post('/api/gateways/:id/inbox/:eventId/retry-files', async ({ id, eventId }) => {
  gatewaySupervisor.retryFiles(id, eventId);
  return { ok: true };
});
post('/api/gateways/:id/inbox/:eventId/retry-reply', async ({ id, eventId }) => {
  gatewaySupervisor.retryReply(id, eventId);
  return { ok: true };
});
post('/api/gateways/:id/inbox/:eventId/reconcile', async ({ id, eventId }) => gatewaySupervisor.reconcile(id, eventId));
post<unknown>('/api/gateways/:id/inbox/:eventId/group-album', async ({ id, eventId }, body) => gatewaySupervisor.groupAlbum(id, eventId, body));
post<unknown>('/api/gateways/:id/inbox/:eventId/files', async ({ id, eventId }, body) => {
  await gatewaySupervisor.selectDocuments(id, eventId, body);
  return { ok: true };
});
post('/api/gateways/:id/inbox/:eventId/files/:index/retry', async ({ id, eventId, index }) => {
  gatewaySupervisor.changeDocument(id, eventId, /^\d+$/.test(index) ? Number(index) : -1, 'retry');
  return { ok: true };
});
post('/api/gateways/:id/inbox/:eventId/files/:index/skip', async ({ id, eventId, index }) => {
  gatewaySupervisor.changeDocument(id, eventId, /^\d+$/.test(index) ? Number(index) : -1, 'skip');
  return { ok: true };
});
del('/api/gateways/:id', async ({ id }) => {
  await gatewaySupervisor.removeInstance(id);
  return { ok: true };
});
// ---------- settings, keys and accounts: server/api/settings.ts ----------
post('/api/social/test', async () => { throw new HttpError(400, 'Choose a gateway instance and known conversation in the Outbox, review the test text, then approve it. Old global tokens and webhooks are no longer used.'); });

get('/api/artifacts', async () => artifactStore.list().sort((a, b) => b.createdAt! - a.createdAt!));
del('/api/artifacts/:id', async ({ id }) => {
  removeArtifact(id);
  return { ok: true };
});
get('/api/outbox', async () => social.listPosts());
get('/api/outbox/gateway-destinations', async () => gatewayOutboxDestinations(store.activeProject().id));
post<Parameters<typeof social.draftPost>[0]>('/api/outbox', async (_p, body) => social.draftPost({ platform: body.platform || 'x', account: body.account, text: body.text, thread: body.thread, images: body.images, to: body.to, gateway: body.gateway, agentName: 'You' }));
post<unknown>('/api/outbox/:id/gateway-review', async ({ id }, body) => social.prepareGatewayPost(id, body));
get('/api/outbox/:id/gateway-delivery', async ({ id }) => readGatewayPostDelivery(id));
post<unknown>('/api/outbox/:id/gateway-delivery/prepare', async ({ id }, body) => {
  return store.withProject(store.activeProject(), async () => {
    const item = need(outbox.get(id)); if (!item.gateway || !['telegram', 'discord'].includes(item.platform)) throw new HttpError(400, 'Choose a saved gateway Outbox delivery.');
    if (gatewayRetirement(item.gateway.instanceId)) await gatewaySupervisor.prepareRetiredOutbox(item.gateway.instanceId, store.activeProject().id, item.id, body);
    else await gatewaySupervisor.prepareOutboxReview(item.gateway.instanceId, store.activeProject().id, item.id);
    return readGatewayPostDelivery(id);
  });
});
post<unknown>('/api/outbox/:id/gateway-delivery', async ({ id }, body) => {
  return store.withProject(store.activeProject(), async () => {
    const item = need(outbox.get(id)); if (!item.gateway || !['telegram', 'discord'].includes(item.platform)) throw new HttpError(400, 'Choose a saved gateway Outbox delivery.');
    await gatewaySupervisor.reviewOutbox(item.gateway.instanceId, store.activeProject().id, item.id, body); return readGatewayPostDelivery(id);
  });
});
post<unknown>('/api/outbox/:id/gateway-finish', async ({ id }, body) => {
  const project = store.activeProject();
  return store.withProject(project, async () => {
    const item = need(outbox.get(id)); if (!item.gateway || !['telegram', 'discord'].includes(item.platform)) throw new HttpError(400, 'Choose a saved gateway Outbox delivery.');
    if (gatewayRetirement(item.gateway.instanceId)) await gatewaySupervisor.finishRetiredOutbox(item.gateway.instanceId, project.id, item.id, body);
    else await gatewaySupervisor.finishOutbox(item.gateway.instanceId, project.id, item.id, body);
    return social.listPosts().find((post) => post.id === id);
  });
});
post<Parameters<typeof social.approvePost>[1]>('/api/outbox/:id/approve', async ({ id }, body) => social.approvePost(id, body));
post<{ text?: string }>('/api/outbox/:id/discuss', async ({ id }, body) => social.returnPost(id, String(body.text || ''), (teamId, text) => teams.postUserMessage(teamId, text, { route: brain.pickMember })));
post<{ reason?: string }>('/api/outbox/:id/reject', async ({ id }, body) => social.rejectPost(id, body.reason));
put<Parameters<typeof social.editPost>[1]>('/api/outbox/:id', async ({ id }, body) => social.editPost(id, body));
del('/api/outbox/:id', async ({ id }) => {
  social.removePost(id);
  return { ok: true };
});

// ---------- teams: server/api/workflows.ts (making, changing, running) and server/api/teams.ts (their chats) ----------
// the picture or 3D model in the middle of a team's pod, instead of its emoji
get('/api/workflows/:id/mark', async ({ id }, _b, _q, res) => {
  const f = teamMarks.markFile(need(workflows.get(id)));
  if (!f) throw new HttpError(404, 'No picture or model');
  sendFileSafely(res, f);
  return undefined;
});

// ---------- terminals ----------
get('/api/terminals', async () => terms.listTerminals());
post<Omit<Parameters<typeof terms.createTerminal>[0], 'agent'> & { agentId?: string }>('/api/terminals', async (_p, body) => terms.createTerminal({ ...body, agent: body.agentId ? need(agents.get(body.agentId)) : null }));
del('/api/terminals/:id', async ({ id }) => ({ ok: terms.closeTerminal(id) }));

// ---------- internal: the MCP bridge calls these ----------
// A bridge that belongs to a run works in the run's project (its agent, workspace and data), even
// after you open another one. Without a run (an outside MCP client) it's the project open now.
const inRunProject = <T>(run: engines.RunInfo | null, fn: () => T): T => (run ? store.withProject(run.project, fn) : fn());
// The agent as its run has it: what a team gave it for this work (tools, MCP servers, skills) counts too.
// Its saved settings (autonomy, "always allow") are read fresh.
const bridgeAgent = (run: engines.RunInfo | null, id: string | null | undefined): Agent | ExternalAgent => {
  const agent = agentFor(id);
  if (!run || !id || run.agentId !== id || agent === EXTERNAL) return agent;
  return { ...agent, toolGroups: run.agent.toolGroups, mcpServers: run.agent.mcpServers, _teamSkills: run.agent._teamSkills };
};
get('/api/internal/tools', async (_p, _b, q) => {
  const run = engines.runInfo(q.run);
  return inRunProject(run, () => {
    const agent = bridgeAgent(run, q.agent);
    const list = tools.toolDefs(agent, { conversationId: run?.conversationId, engine: agent.engine });
    if (agent.engine === 'claude-code')
      list.push({
        name: 'permission_prompt',
        description: 'Internal: Claude Code uses this to ask the user for permission. Never call it yourself.',
        parameters: { type: 'object', properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } }, required: ['tool_name'] },
      });
    return { tools: list };
  });
});
post<{ agent?: string; run?: string; name: string; args?: Record<string, unknown> }>('/api/internal/tools/call', async (_p, body) => {
  // The bridge says which run it belongs to; that gives the right project, approvals, Stop button and delegation depth.
  const run = engines.runInfo(body.run);
  return inRunProject(run, async () => {
    const agent = bridgeAgent(run, body.agent);
    const ctx = run ? { runId: run.id, depth: run.depth, signal: run.signal } : { runId: null, depth: 1 };
    if (body.name === 'permission_prompt') return { text: JSON.stringify(await claudePermission(agent, (body.args || {}) as unknown as PermissionRequest, ctx.runId)) };
    const r = tools.clipForModel(await tools.callTool(agent, body.name, body.args || {}, ctx), body.name, ctx.runId);
    // MCP takes pictures as data only: ComfyUI's result links are read here, so the agent sees them too
    if (!r.images?.length) return r;
    const { images, note } = await inlineToolImagesNoted(r.images);
    return { ...r, images, text: withImageNote(r.text, note) };
  });
});

/** What Claude Code sends to permission_prompt. */
interface PermissionRequest {
  tool_name: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
}

async function claudePermission(agent: Agent | ExternalAgent, { tool_name, input = {} }: PermissionRequest, runId: string | null) {
  if ((agent.alwaysAllow || []).includes(tool_name)) return { behavior: 'allow', updatedInput: input };
  const detail = input.command || input.file_path || input.url || input.pattern || JSON.stringify(input, null, 2);
  const account = mcp.accountOfTool(tool_name);
  const d = await requestApproval({ kind: 'claude', title: `${agent.name} wants to use ${tool_name}${account ? ` on ${account}` : ''}`, detail: String(detail).slice(0, 4000), agentId: agent.id, agentName: agent.name, data: { tool: tool_name, args: input, runId } });
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
  const esc = (s: unknown) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as Record<string, string>)[c]);
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
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'text/javascript', 'cache-control': 'max-age=86400' });
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
    return true;
  }
  if (rel === '/' || !path.extname(rel)) rel = '/index.html';
  const file = path.resolve(PUBLIC, '.' + rel);
  if (!file.startsWith(PUBLIC + path.sep) || !exists(file) || !fs.statSync(file).isFile()) return false;
  const headers: Record<string, string> = { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' };
  // Agent output is shown as markdown: no outside scripts, and images only from here (nothing leaks out).
  if (file.endsWith('.html')) {
    headers['content-security-policy'] = [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "font-src 'self'",
      "img-src 'self' data: blob: https://pbs.twimg.com https://abs.twimg.com",
      `connect-src 'self' ws://localhost:${PORT} ws://127.0.0.1:${PORT}`,
      "frame-ancestors 'none'",
    ].join('; ');
    // The page opens in the scheme picked in Settings > Appearance, before anything is drawn: the saved theme goes onto
    // <html> ("system" leaves it off, for the stylesheet to follow the computer). The page does the same on a change.
    const theme = getSettings().look.theme;
    const html = fs.readFileSync(file, 'utf8');
    res.writeHead(200, headers);
    res.end(theme === 'light' || theme === 'dark' ? html.replace('<html lang="en"', `<html lang="en" data-theme="${theme}"`) : html);
    return true;
  }
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
  const url = new URL(req.url!, `http://${req.headers.host}`);
  // Browsers label requests from other websites (an <img> or link pointing here). Only the X callback may arrive that way.
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none' && !['/oauth/x/callback', '/oauth/reddit/callback'].includes(url.pathname) && (url.pathname.startsWith('/api/') || url.pathname.startsWith('/oauth/'))) {
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
      if (!scope && !internal && req.method !== 'GET' && typeof pageProject === 'string' && pageProject && !url.pathname.startsWith('/api/projects') && pageProject !== store.activeProject().id) {
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
      const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'build-web.ts')], { cwd: ROOT, stdio: 'inherit' });
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
try { await eveRuntime.recover(); }
catch (error) {
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
void irc.recoverWork().catch((e: unknown) => store.log('error', `Couldn't resume saved work: ${e instanceof Error ? e.message : String(e)}`));
routinesMod.markInterruptedRoutines();
routinesMod.startRoutineScheduler();
projectSync.startAutoSave();
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
  console.log(`\n  Athena Agents is running at ${url}\n  Data folder: ${dataPath()}\n  Press Ctrl+C to stop.\n`);
  log('system', 'Dashboard started');
  if (OPEN) void pageReady.then(() => openWithShell(url));
});

let stopping = false;
const shutdown = () => {
  if (stopping) return;
  stopping = true;
  terms.closeAll();
  // agents' CLIs are stopped too: they would go on writing into the project with no dashboard to see it
  void Promise.allSettled([gatewaySupervisor.stop(), engines.stopAllRuns()]).finally(() => Promise.allSettled([eveCoordinator.close(), eveRuntime.close()])).finally(() => {
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
