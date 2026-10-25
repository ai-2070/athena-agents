// All dashboard state lives in ./data as plain JSON files you can read, back up or edit.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { DATA, HOME, dataPath, ensureDir, readJSON, writeJSON, uid, listFiles, exists } from './util.js';

ensureDir(DATA);

// Everything that happens is broadcast to open browser tabs through this bus.
export const bus = new EventEmitter();
bus.setMaxListeners(100);
export const emit = (type, payload = {}) => bus.emit('event', { type, ...payload, ts: Date.now() });

// ---------- settings (safe to show) and secrets (never sent to the browser) ----------
const SETTINGS_FILE = dataPath('settings.json');
const SECRETS_FILE = dataPath('secrets.json');

const DEFAULT_SETTINGS = {
  defaults: {
    engine: 'claude-code',
    claudeModel: 'sonnet',
    openrouterModel: 'anthropic/claude-sonnet-5.5',
    hermesProfile: '',
    autonomy: 'auto',
  },
  providers: {
    lmstudio: { baseUrl: 'http://127.0.0.1:1234/v1' },
    ollama: { baseUrl: 'http://127.0.0.1:11434/v1' },
    custom: { baseUrl: '', label: 'Custom (OpenAI-compatible)' },
  },
  comfyui: { url: '', workflowDirs: [] },
  paths: { blender: '', photoshop: '', aftereffects: '', premiere: '', comfyui: '' },
  allowedFolders: [],
  x: { clientId: '' },
  reddit: { clientId: '', username: '' },
  brain: { provider: 'claude', model: 'haiku' },
  look: { scale: 100, accent: 'lime', motion: 'full' },
  telegram: { chatId: '' },
  maxToolSteps: 16,
  costLimitUsdPerRun: 2,
};

function merge(base, over) {
  if (Array.isArray(base) || typeof base !== 'object' || base == null) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) out[k] = k in base ? merge(base[k], v) : v;
  return out;
}

export function getSettings() {
  return merge(DEFAULT_SETTINGS, readJSON(SETTINGS_FILE, {}));
}

export function saveSettings(patch) {
  const next = merge(getSettings(), patch);
  writeJSON(SETTINGS_FILE, next);
  emit('settings');
  return next;
}

export function getSecrets() {
  return readJSON(SECRETS_FILE, {});
}

export function setSecret(key, value) {
  const s = getSecrets();
  if (value == null || value === '') delete s[key];
  else s[key] = value;
  writeJSON(SECRETS_FILE, s);
  emit('settings');
}

export function secretStatus() {
  const s = getSecrets();
  const out = {};
  for (const k of ['openrouterKey', 'anthropicKey', 'customKey', 'xClientSecret', 'telegramBotToken', 'discordWebhook', 'redditClientSecret']) {
    const v = s[k];
    out[k] = v ? { set: true, hint: `…${String(v).slice(-4)}` } : { set: false };
  }
  return out;
}

// A token the local MCP bridge uses to call back into the dashboard.
export function internalToken() {
  const file = dataPath('.internal-token');
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    const t = crypto.randomBytes(24).toString('hex');
    fs.writeFileSync(file, t);
    return t;
  }
}

// ---------- projects ----------
// A project has its own agents, branches, runs and chats (data/projects/<id>/) and a Brain:
// a real folder with the project's files, notes and (optionally) its GitHub repo.
const PROJECTS_FILE = dataPath('projects.json');
const DEFAULT_PROJECT = () => ({ id: 'default', name: 'My workspace', brainPath: path.join(HOME, 'Documents', 'My Dashboard', 'My workspace'), repo: '', createdAt: Date.now() });

export function listProjects() {
  const list = readJSON(PROJECTS_FILE, null);
  if (Array.isArray(list) && list.length) return list;
  const first = [DEFAULT_PROJECT()];
  writeJSON(PROJECTS_FILE, first);
  return first;
}

export function saveProjects(list) {
  writeJSON(PROJECTS_FILE, list);
  emit('projects');
}

export function activeProject() {
  const list = listProjects();
  const id = readJSON(SETTINGS_FILE, {}).activeProject;
  return list.find((p) => p.id === id) || list[0];
}

export function setActiveProject(id) {
  const p = listProjects().find((x) => x.id === id);
  if (!p) throw new Error('No such project.');
  const cur = readJSON(SETTINGS_FILE, {});
  writeJSON(SETTINGS_FILE, { ...cur, activeProject: id });
  emit('project', { id });
  return p;
}

// Where the active project keeps its dashboard data.
export const projectData = (...p) => dataPath('projects', activeProject().id, ...p);

// Older installs kept agents etc. at the top of data/: move them into the first project once.
export function migrateLayout() {
  const target = dataPath('projects', listProjects()[0].id);
  for (const name of ['agents', 'workflows', 'runs', 'chats', 'knowledge', 'workspaces']) {
    const from = dataPath(name);
    const to = path.join(target, name);
    if (exists(from) && !exists(to)) {
      ensureDir(target);
      fs.renameSync(from, to);
    }
  }
}

// ---------- simple JSON collections: one file per item ----------
export function collection(name, { global = false } = {}) {
  const dirOf = () => ensureDir(global ? dataPath(name) : projectData(name));
  const file = (id) => path.join(dirOf(), `${id}.json`);
  return {
    get dir() {
      return dirOf();
    },
    list() {
      const dir = dirOf();
      return listFiles(dir, (n) => n.endsWith('.json'))
        .map((n) => readJSON(path.join(dir, n)))
        .filter(Boolean);
    },
    get(id) {
      if (!id || /[\\/]/.test(id)) return null;
      return readJSON(file(id));
    },
    save(item) {
      if (!item.id) item.id = uid();
      item.updatedAt = Date.now();
      item.createdAt ??= item.updatedAt;
      writeJSON(file(item.id), item);
      emit(`${name}`, { id: item.id });
      return item;
    },
    remove(id) {
      try {
        fs.unlinkSync(file(id));
      } catch {
        /* gone */
      }
      emit(`${name}`, { id, removed: true });
    },
  };
}

export const agents = collection('agents');
export const workflows = collection('workflows');
export const runs = collection('runs');
export const outbox = collection('outbox', { global: true }); // one Outbox for every project

// Chats are stored per agent: data/chats/<agentId>/<chatId>.json
const SAFE_ID = /^[\w-]+$/;
export const chats = {
  dir(agentId) {
    if (!SAFE_ID.test(String(agentId))) throw Object.assign(new Error('Invalid agent id'), { status: 400 });
    return ensureDir(projectData('chats', agentId));
  },
  list(agentId) {
    const dir = this.dir(agentId);
    return listFiles(dir, (n) => n.endsWith('.json'))
      .map((n) => readJSON(path.join(dir, n)))
      .filter(Boolean)
      .map(({ id, title, updatedAt, createdAt, items }) => ({ id, title, updatedAt, createdAt, count: items?.length || 0 }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  },
  get(agentId, chatId) {
    if (!chatId || !SAFE_ID.test(chatId)) return null;
    return readJSON(path.join(this.dir(agentId), `${chatId}.json`));
  },
  create(agentId, title = 'New chat') {
    const chat = { id: uid('c'), agentId, title, items: [], llm: [], sessionId: null, createdAt: Date.now(), updatedAt: Date.now() };
    return this.save(chat);
  },
  save(chat) {
    chat.updatedAt = Date.now();
    writeJSON(path.join(this.dir(chat.agentId), `${chat.id}.json`), chat);
    return chat;
  },
  remove(agentId, chatId) {
    if (!SAFE_ID.test(String(chatId))) return;
    try {
      fs.unlinkSync(path.join(this.dir(agentId), `${chatId}.json`));
    } catch {
      /* gone */
    }
  },
};

// ---------- activity log ----------
const ACTIVITY_FILE = dataPath('activity.jsonl');
const recent = [];
try {
  const lines = fs.readFileSync(ACTIVITY_FILE, 'utf8').trim().split('\n').slice(-300);
  for (const l of lines) {
    try {
      recent.push(JSON.parse(l));
    } catch {
      /* skip */
    }
  }
} catch {
  /* first run */
}

export function log(kind, text, extra = {}) {
  const entry = { id: uid('a'), kind, text: String(text).slice(0, 1000), ...extra, ts: Date.now() };
  recent.push(entry);
  if (recent.length > 500) recent.splice(0, recent.length - 500);
  try {
    fs.appendFileSync(ACTIVITY_FILE, JSON.stringify(entry) + '\n');
  } catch {
    /* disk full or locked: keep going */
  }
  emit('activity', { entry });
  return entry;
}

export function activity(limit = 100) {
  return recent.slice(-limit).reverse();
}
