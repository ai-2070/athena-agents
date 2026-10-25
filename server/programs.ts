// Finds the programs on this PC (a known catalog plus everything in the Start Menu),
// checks which local services are up, and launches things.
import fs from 'node:fs';
import path from 'node:path';
import { HOME, IS_WIN, exists, listDirs, walk, which, run, ping, launchDetached, openWithShell, readJSON } from './util.ts';
import { getSettings, emit } from './store.ts';

/** A Start Menu shortcut. folder is relative to the Start Menu's Programs folder. */
export interface StartMenuApp {
  name: string;
  shortcut: string;
  folder: string;
}

/** What a catalog entry's detect() finds. */
interface Detected {
  exe?: string | null;
  cli?: string | null;
  shortcut?: string | null;
  version?: string;
  all?: string[];
  optional?: boolean;
}

interface CatalogEntry {
  id: string;
  name: string;
  category: string;
  icon: string;
  detect: () => Detected;
  /** Resolves to the URL of the program's local server when it is up. */
  service?: () => Promise<string | null>;
  cli?: boolean;
  actions: string[];
}

/** A known program as discoverPrograms() reports it. */
export interface Program {
  id: string;
  name: string;
  category: string;
  icon: string;
  installed: boolean;
  optional: boolean;
  exe: string | null;
  shortcut: string | null;
  version: string | null;
  versions: string[] | null;
  cli: boolean;
  running: boolean;
  serviceUrl: string | null;
  actions: string[];
}

interface ComfyConfig {
  basePath?: string;
}

const PF = process.env.ProgramFiles || 'C:\\Program Files';
const PF86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
const LOCAL = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
const ROAMING = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
const PROGDATA = process.env.ProgramData || 'C:\\ProgramData';

const natural = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

// Newest "<prefix><version>" folder under base that contains exeRel.
function newestVersioned(base: string, prefix: string, exeRel: string): { exe: string; version: string; all: string[] } | null {
  const dirs = listDirs(base)
    .filter((d) => d.toLowerCase().startsWith(prefix.toLowerCase()))
    .sort(natural)
    .reverse();
  for (const d of dirs) {
    const exe = path.join(base, d, exeRel);
    if (exists(exe)) return { exe, version: d.slice(prefix.length).trim() || d, all: dirs.filter((x) => exists(path.join(base, x, exeRel))) };
  }
  return null;
}

const first = (...paths: (string | null | undefined)[]): string | null => paths.find((p) => p && exists(p)) || null;
const localProgram = (dir: string, exe: string): string | null => first(path.join(LOCAL, 'Programs', dir, exe));

// ---------- Start Menu ----------
let startMenuCache: { at: number; items: StartMenuApp[] } = { at: 0, items: [] };
export function startMenuApps(force = false): StartMenuApp[] {
  if (!IS_WIN) return [];
  if (!force && Date.now() - startMenuCache.at < 5 * 60_000) return startMenuCache.items;
  const roots = [path.join(ROAMING, 'Microsoft', 'Windows', 'Start Menu', 'Programs'), path.join(PROGDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs')];
  const seen = new Map<string, StartMenuApp>();
  for (const root of roots) {
    for (const file of walk(root, { maxDepth: 4, filter: (p) => /\.(lnk|url)$/i.test(p) })) {
      const name = path.basename(file).replace(/\.(lnk|url)$/i, '');
      if (/uninstall|readme|release notes|help|website|documentation|license|manual/i.test(name)) continue;
      const key = name.toLowerCase();
      if (!seen.has(key)) seen.set(key, { name, shortcut: file, folder: path.relative(root, path.dirname(file)) || '' });
    }
  }
  const items = [...seen.values()].sort((a, b) => natural(a.name, b.name));
  startMenuCache = { at: Date.now(), items };
  return items;
}

const startMenuFind = (re: RegExp): StartMenuApp | null => startMenuApps().find((a) => re.test(a.name)) || null;

// ---------- known programs ----------
function comfyWorkflowDirs(): string[] {
  const s = getSettings();
  const dirs = [...(s.comfyui.workflowDirs || [])];
  const cfg = readJSON<ComfyConfig>(path.join(ROAMING, 'ComfyUI', 'config.json'), null);
  if (cfg?.basePath) dirs.push(path.join(cfg.basePath, 'user', 'default', 'workflows'));
  dirs.push(path.join(HOME, 'ComfyUI-Installs', 'ComfyUI', 'ComfyUI', 'user', 'default', 'workflows'));
  dirs.push(path.join(HOME, 'ComfyUI', 'user', 'default', 'workflows'));
  return [...new Set(dirs)].filter(exists);
}
export function comfyOutputDirs(): string[] {
  const cfg = readJSON<ComfyConfig>(path.join(ROAMING, 'ComfyUI', 'config.json'), null);
  return [cfg?.basePath && path.join(cfg.basePath, 'output'), path.join(HOME, 'ComfyUI-Shared', 'output'), path.join(HOME, 'ComfyUI-Installs', 'ComfyUI', 'ComfyUI', 'output')].filter(
    (p): p is string => !!p && exists(p),
  );
}
export { comfyWorkflowDirs };

const CATALOG: CatalogEntry[] = [
  // AI tools
  { id: 'claude', name: 'Claude Code', category: 'ai', icon: '✳️', detect: () => ({ exe: which('claude') }), cli: true, actions: ['terminal'] },
  { id: 'hermes', name: 'Hermes Agent', category: 'ai', icon: '☤', detect: () => ({ exe: which('hermes') }), cli: true, actions: ['terminal'] },
  {
    id: 'orca',
    name: 'Orca',
    category: 'ai',
    icon: '🐋',
    detect: () => ({ exe: localProgram('orca', 'Orca.exe'), cli: which('orca') }),
    actions: ['launch', 'terminal'],
  },
  {
    id: 'comfyui',
    name: 'ComfyUI',
    category: 'ai',
    icon: '🧩',
    detect: () => {
      const s = getSettings();
      const lnk = startMenuFind(/^comfy/i);
      return { exe: s.paths.comfyui || null, shortcut: lnk?.shortcut || null };
    },
    service: async () => {
      const s = getSettings();
      for (const url of [s.comfyui.url, 'http://127.0.0.1:8188', 'http://127.0.0.1:8000'].filter(Boolean)) {
        if (await ping(`${url.replace(/\/$/, '')}/system_stats`, 1200)) return url.replace(/\/$/, '');
      }
      return null;
    },
    actions: ['launch', 'open-ui'],
  },
  {
    id: 'lmstudio',
    name: 'LM Studio',
    category: 'ai',
    icon: '🧠',
    detect: () => ({ exe: localProgram('LM Studio', 'LM Studio.exe') }),
    service: async () => ((await ping('http://127.0.0.1:1234/v1/models')) ? 'http://127.0.0.1:1234' : null),
    actions: ['launch'],
  },
  {
    id: 'ollama',
    name: 'Ollama',
    category: 'ai',
    icon: '🦙',
    detect: () => ({ exe: which('ollama') || localProgram('Ollama', 'ollama app.exe') }),
    service: async () => ((await ping('http://127.0.0.1:11434/api/tags')) ? 'http://127.0.0.1:11434' : null),
    actions: ['launch'],
  },
  {
    id: 'netdesk',
    name: 'Net Desk',
    category: 'ai',
    icon: '🛰️',
    detect: () => ({ exe: null, optional: true }),
    service: async () => ((await ping('http://localhost:8770', 1000)) ? 'http://localhost:8770' : null),
    actions: ['open-ui'],
  },
  { id: 'opendesign', name: 'Open Design', category: 'ai', icon: '📐', detect: () => ({ exe: localProgram('Open Design', 'Open Design.exe') }), actions: ['launch'] },
  // Creative
  {
    id: 'blender',
    name: 'Blender',
    category: 'creative',
    icon: '🟠',
    detect: () => {
      const s = getSettings();
      if (s.paths.blender && exists(s.paths.blender)) return { exe: s.paths.blender };
      return newestVersioned(path.join(PF, 'Blender Foundation'), 'Blender ', 'blender.exe') || { exe: which('blender') };
    },
    actions: ['launch', 'open', 'python'],
  },
  {
    id: 'premiere',
    name: 'Premiere Pro',
    category: 'creative',
    icon: '🎬',
    detect: () => adobe('premiere', 'Adobe Premiere Pro ', 'Adobe Premiere Pro.exe'),
    actions: ['launch', 'open'],
  },
  { id: 'photoshop', name: 'Photoshop', category: 'creative', icon: '🖼️', detect: () => adobe('photoshop', 'Adobe Photoshop ', 'Photoshop.exe'), actions: ['launch', 'open', 'jsx'] },
  {
    id: 'aftereffects',
    name: 'After Effects',
    category: 'creative',
    icon: '✨',
    detect: () => adobe('aftereffects', 'Adobe After Effects ', path.join('Support Files', 'AfterFX.exe')),
    actions: ['launch', 'open', 'jsx'],
  },
  {
    id: 'illustrator',
    name: 'Illustrator',
    category: 'creative',
    icon: '✒️',
    detect: () => adobe(null, 'Adobe Illustrator ', path.join('Support Files', 'Contents', 'Windows', 'Illustrator.exe')),
    actions: ['launch', 'open'],
  },
  { id: 'audition', name: 'Audition', category: 'creative', icon: '🎧', detect: () => adobe(null, 'Adobe Audition ', 'Adobe Audition.exe'), actions: ['launch', 'open'] },
  {
    id: 'mediaencoder',
    name: 'Media Encoder',
    category: 'creative',
    icon: '📼',
    detect: () => adobe(null, 'Adobe Media Encoder ', 'Adobe Media Encoder.exe'),
    actions: ['launch', 'open'],
  },
  {
    id: 'gimp',
    name: 'GIMP',
    category: 'creative',
    icon: '🦊',
    detect: () => {
      const lnk = startMenuFind(/^gimp/i);
      return { exe: first(path.join(LOCAL, 'Programs', 'GIMP 3', 'bin', 'gimp-3.exe'), path.join(PF, 'GIMP 3', 'bin', 'gimp-3.exe')), shortcut: lnk?.shortcut };
    },
    actions: ['launch', 'open'],
  },
  { id: 'ffmpeg', name: 'FFmpeg', category: 'creative', icon: '🎞️', detect: () => ({ exe: which('ffmpeg') }), cli: true, actions: [] },
  // Browsers
  {
    id: 'chrome',
    name: 'Chrome',
    category: 'browser',
    icon: '🌐',
    detect: () => ({ exe: first(path.join(PF, 'Google', 'Chrome', 'Application', 'chrome.exe'), path.join(LOCAL, 'Google', 'Chrome', 'Application', 'chrome.exe')) }),
    actions: ['launch', 'url'],
  },
  {
    id: 'edge',
    name: 'Edge',
    category: 'browser',
    icon: '🌊',
    detect: () => ({ exe: first(path.join(PF86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), path.join(PF, 'Microsoft', 'Edge', 'Application', 'msedge.exe')) }),
    actions: ['launch', 'url'],
  },
  {
    id: 'opera',
    name: 'Opera',
    category: 'browser',
    icon: '⭕',
    detect: () => ({ exe: first(path.join(LOCAL, 'Programs', 'Opera', 'opera.exe'), path.join(LOCAL, 'Programs', 'Opera GX', 'opera.exe')) }),
    actions: ['launch', 'url'],
  },
  // Dev
  { id: 'vscode', name: 'VS Code', category: 'dev', icon: '🧑‍💻', detect: () => ({ exe: localProgram('Microsoft VS Code', 'Code.exe') || which('code') }), actions: ['launch', 'open'] },
  { id: 'zed', name: 'Zed', category: 'dev', icon: '⚡', detect: () => ({ exe: localProgram('Zed', 'Zed.exe') }), actions: ['launch', 'open'] },
  { id: 'gh', name: 'GitHub CLI', category: 'dev', icon: '🐙', detect: () => ({ exe: which('gh') }), cli: true, actions: ['terminal'] },
  { id: 'git', name: 'Git', category: 'dev', icon: '🌿', detect: () => ({ exe: which('git') }), cli: true, actions: [] },
  { id: 'python', name: 'Python', category: 'dev', icon: '🐍', detect: () => ({ exe: which('python') || which('python3') }), cli: true, actions: ['terminal'] },
  { id: 'uv', name: 'uv / uvx', category: 'dev', icon: '📦', detect: () => ({ exe: which('uvx') || which('uv') }), cli: true, actions: [] },
  { id: 'docker', name: 'Docker', category: 'dev', icon: '🐳', detect: () => ({ exe: which('docker') }), cli: true, actions: [] },
  // Other
  { id: 'notion', name: 'Notion', category: 'office', icon: '📓', detect: () => ({ exe: localProgram('Notion', 'Notion.exe') }), actions: ['launch'] },
];

function adobe(key: string | null, prefix: string, exeRel: string): Detected {
  const s = getSettings();
  if (key && s.paths[key] && exists(s.paths[key])) return { exe: s.paths[key] };
  return newestVersioned(path.join(PF, 'Adobe'), prefix, exeRel) || { exe: null };
}

async function runningExes(): Promise<Set<string>> {
  if (!IS_WIN) return new Set();
  const r = await run('tasklist', ['/fo', 'csv', '/nh'], { timeout: 8000 });
  const set = new Set<string>();
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = /^"([^"]+)"/.exec(line);
    if (m) set.add(m[1].toLowerCase());
  }
  return set;
}

let cache: { at: number; list: Program[] } = { at: 0, list: [] };
export async function discoverPrograms(force = false): Promise<Program[]> {
  if (!force && Date.now() - cache.at < 20_000) return cache.list;
  const procs = await runningExes();
  const list = await Promise.all(
    CATALOG.map(async (p): Promise<Program> => {
      let d: Detected = {};
      try {
        d = p.detect() || {};
      } catch {
        d = {};
      }
      const serviceUrl = p.service ? await p.service().catch(() => null) : null;
      const exe = d.exe || d.cli || null;
      const installed = !!(exe || d.shortcut || serviceUrl);
      return {
        id: p.id,
        name: p.name,
        category: p.category,
        icon: p.icon,
        installed,
        optional: !!d.optional,
        exe,
        shortcut: d.shortcut || null,
        version: d.version || null,
        versions: d.all || null,
        cli: !!p.cli,
        running: !!(serviceUrl || (exe && procs.has(path.basename(exe).toLowerCase()))),
        serviceUrl,
        actions: p.actions,
      };
    }),
  );
  cache = { at: Date.now(), list: list.filter((p) => p.installed || !p.optional) };
  return cache.list;
}

// Which known programs are open right now. Checked every few seconds; when that changes the
// page is told ('programs' event), so "running" shows up (and goes away) without a rescan.
let lastRunning: string | null = null;
const isRunning = (p: Program, procs: Set<string>): boolean => !!(p.serviceUrl || (p.exe && procs.has(path.basename(p.exe).toLowerCase())));
export async function refreshRunning() {
  if (!cache.list.length) await discoverPrograms();
  const procs = await runningExes();
  // services (ComfyUI, LM Studio, Ollama...) are asked again, so starting or stopping one shows up
  await Promise.all(
    cache.list.map(async (p) => {
      const service = CATALOG.find((c) => c.id === p.id)?.service;
      if (service) p.serviceUrl = await service().catch(() => null);
    }),
  );
  for (const p of cache.list) p.running = isRunning(p, procs);
  const now = cache.list.filter((p) => p.running).map((p) => p.id).join(',');
  if (lastRunning !== null && now !== lastRunning) emit('programs', { running: now ? now.split(',') : [] });
  lastRunning = now;
}
export function startRunningWatch() {
  if (!IS_WIN) return;
  refreshRunning().catch(() => {});
  setInterval(() => refreshRunning().catch(() => {}), 5000).unref?.();
}
// Right after a start, look a few times so it shows up quickly.
function checkSoon() {
  for (const ms of [1500, 4000, 8000, 15000]) setTimeout(() => refreshRunning().catch(() => {}), ms);
}

export async function getProgram(id: string): Promise<Program | null> {
  return (await discoverPrograms()).find((p) => p.id === id) || null;
}

// Launch a known program, a Start Menu entry, or anything on PATH. Optionally open a file/URL with it.
// nameOrId and args can come straight from a tool call or request body, so they are checked here.
export async function launchProgram(nameOrId: unknown, { file = null, args = [] }: { file?: string | null; args?: unknown } = {}): Promise<string> {
  const key = String(nameOrId || '').trim();
  if (!key) throw new Error('Which program? Give its name.');
  const progs = await discoverPrograms();
  const lower = key.toLowerCase();
  const known = progs.find((p) => p.id === lower || p.name.toLowerCase() === lower) || progs.find((p) => p.name.toLowerCase().includes(lower));
  const extra: string[] = [...(file ? [file] : []), ...(Array.isArray(args) ? (args as string[]) : [])];
  if (known?.exe && !known.cli) {
    launchDetached(known.exe, extra);
    checkSoon();
    return `Started ${known.name}${file ? ` with ${file}` : ''}.`;
  }
  if (known?.shortcut && !extra.length) {
    openWithShell(known.shortcut);
    checkSoon();
    return `Started ${known.name}.`;
  }
  const lnk = startMenuApps().find((a) => a.name.toLowerCase() === lower) || startMenuApps().find((a) => a.name.toLowerCase().includes(lower));
  if (lnk) {
    openWithShell(lnk.shortcut);
    return `Started ${lnk.name} (from the Start Menu).`;
  }
  const exe = which(key);
  if (exe) {
    launchDetached(exe, extra);
    return `Started ${path.basename(exe)}.`;
  }
  throw new Error(`Couldn't find a program called "${key}". Use list_programs to see what's installed.`);
}

export function programExe(id: string): string | null {
  const p = CATALOG.find((c) => c.id === id);
  if (!p) return null;
  try {
    return p.detect()?.exe || null;
  } catch {
    return null;
  }
}

export function fileExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
