// Small shared helpers: paths, ids, JSON files, process helpers.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA = process.env.DASH_DATA ? path.resolve(process.env.DASH_DATA) : path.join(ROOT, 'data');
export const HOME = os.homedir();
export const IS_WIN = process.platform === 'win32';
export let PORT = Number(process.env.DASH_PORT || 4800);
export function setPort(p) {
  PORT = Number(p) || PORT;
}

export const dataPath = (...p) => path.join(DATA, ...p);

export function uid(prefix = '') {
  return prefix + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
}

export function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'item';
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function readJSON(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// Write to a temp file first, then rename, so a crash never leaves half a file.
export function writeJSON(file, value) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  // Antivirus or an editor can hold the file for a moment on Windows: retry briefly.
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, file);
      break;
    } catch (e) {
      if (i >= 8 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) {
        try {
          fs.unlinkSync(tmp);
        } catch {
          /* ignore */
        }
        throw e;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (i + 1));
    }
  }
  return value;
}

export function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

export function listDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
}

export function listFiles(dir, filter = () => true) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile() && filter(d.name)).map((d) => d.name);
  } catch {
    return [];
  }
}

export function walk(dir, { maxDepth = 6, filter = () => true, limit = 5000 } = {}) {
  const out = [];
  const visit = (d, depth) => {
    if (depth > maxDepth || out.length >= limit) return;
    let entries = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name.startsWith('.git')) continue;
        visit(p, depth + 1);
      } else if (filter(p)) out.push(p);
      if (out.length >= limit) return;
    }
  };
  visit(dir, 0);
  return out;
}

// Find an executable on PATH (respects PATHEXT on Windows).
const whichCache = new Map();
export function which(cmd) {
  if (whichCache.has(cmd)) return whichCache.get(cmd);
  let found = null;
  if (path.isAbsolute(cmd)) found = exists(cmd) ? cmd : null;
  else {
    const exts = IS_WIN ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').map((e) => e.toLowerCase()) : [''];
    const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
    // Common user-level install spots that are not always on PATH.
    dirs.push(path.join(HOME, '.local', 'bin'), path.join(HOME, 'AppData', 'Local', 'hermes', 'bin'));
    outer: for (const d of dirs) {
      for (const ext of IS_WIN ? ['.exe', '.cmd', '.bat', ...exts] : ['']) {
        const p = path.join(d, cmd + ext);
        if (exists(p)) {
          found = p;
          break outer;
        }
      }
    }
  }
  whichCache.set(cmd, found);
  return found;
}
export function clearWhichCache() {
  whichCache.clear();
}

// Build a spawn() call that works for .cmd/.bat shims on Windows too.
export function spawnCommand(cmd, args = [], opts = {}) {
  const exe = which(cmd) || cmd;
  if (IS_WIN && /\.(cmd|bat)$/i.test(exe)) {
    // These go through cmd.exe, which would interpret these characters: refuse rather than risk injection.
    const bad = args.find((a) => /["%!^&|<>\r\n]/.test(String(a)));
    if (bad !== undefined) throw new Error(`This argument has characters that can't be passed safely to ${path.basename(exe)}: ${String(bad).slice(0, 80)}`);
    const quoted = [exe, ...args].map(winQuote).join(' ');
    return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${quoted}"`], {
      ...opts,
      windowsVerbatimArguments: true,
      windowsHide: true,
    });
  }
  return spawn(exe, args, { windowsHide: true, ...opts });
}

export function winQuote(a) {
  a = String(a);
  if (a && !/[\s"&|<>^%()]/.test(a)) return a;
  return `"${a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

// Run a command and collect its output.
export function run(cmd, args = [], { timeout = 60000, input, cwd, env, maxBytes = 2_000_000, signal } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let done = false;
    let child;
    try {
      child = spawnCommand(cmd, args, { cwd, env: env ? { ...process.env, ...env } : process.env });
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: String(e.message || e) });
      return;
    }
    const timer = setTimeout(() => {
      if (!done) {
        err += `\n[timed out after ${Math.round(timeout / 1000)}s]`;
        killTree(child);
      }
    }, timeout);
    const onAbort = () => {
      err += '\n[stopped]';
      killTree(child);
    };
    if (signal?.aborted) onAbort();
    signal?.addEventListener('abort', onAbort);
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d) => {
      if (out.length < maxBytes) out += d;
    });
    child.stderr?.on('data', (d) => {
      if (err.length < maxBytes) err += d;
    });
    child.stdin?.on('error', () => {});
    child.on('error', (e) => {
      err += String(e.message || e);
    });
    child.on('close', (code) => {
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ code, stdout: out, stderr: err });
    });
    if (input != null) child.stdin?.end(input);
    else child.stdin?.end();
  });
}

export function killTree(child) {
  if (!child || child.exitCode != null) return;
  try {
    if (IS_WIN && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
    else child.kill('SIGTERM');
  } catch {
    /* already gone */
  }
}

// Start a GUI program and forget about it.
export function launchDetached(exe, args = [], opts = {}) {
  const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false, ...opts });
  child.on('error', () => {});
  child.unref();
  return child.pid;
}

// Open a file, folder, URL or .lnk with its default handler.
// No cmd.exe here: URLs go to the URL handler, files and folders to Explorer.
export function openWithShell(target) {
  target = String(target);
  if (/[\r\n]/.test(target)) throw new Error('Invalid path or link.');
  if (IS_WIN) {
    const isUrl = /^https?:\/\//i.test(target);
    const [exe, args] = isUrl ? ['rundll32.exe', ['url.dll,FileProtocolHandler', target]] : ['explorer.exe', [path.resolve(target)]];
    const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false });
    child.on('error', () => {});
    child.unref();
  } else {
    const child = spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [target], { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  }
}

export async function fetchJSON(url, opts = {}) {
  const { timeout = 15000, ...rest } = opts;
  const res = await fetch(url, { ...rest, signal: rest.signal || AbortSignal.timeout(timeout) });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const msg = typeof body === 'object' && body ? body.error?.message || body.detail || body.title || JSON.stringify(body) : text;
    const e = new Error(`${res.status} ${String(msg).slice(0, 500)}`);
    e.status = res.status;
    e.body = body;
    throw e;
  }
  return body;
}

export async function ping(url, timeout = 1500) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeout) });
    return res.ok || res.status < 500;
  } catch {
    return false;
  }
}

export function truncate(s, n = 20000) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n) + `\n…[${s.length - n} more characters cut]` : s;
}

// Fill {{name}} placeholders from a values object (dot paths allowed).
export function renderTemplate(tpl, values) {
  return String(tpl ?? '').replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (m, key) => {
    const v = key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), values);
    if (v == null) return m;
    return typeof v === 'string' ? v : JSON.stringify(v, null, 2);
  });
}

export function tmpFile(name) {
  const dir = ensureDir(dataPath('tmp'));
  return path.join(dir, `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}-${name}`);
}

export async function readText(file, max = 400_000) {
  const buf = await fsp.readFile(file);
  return buf.subarray(0, max).toString('utf8');
}

export function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim();
  }
  return { meta, body: text.slice(m[0].length) };
}
