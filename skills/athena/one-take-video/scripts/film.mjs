#!/usr/bin/env node
// film.mjs: the one-take-video skill's tool. It times a voiceover, shows a film page as sheets of stills, and renders
// the page frame by frame into an MP4. The page is drawn by Chrome, Edge or Chromium, driven over the DevTools
// protocol with Node's own WebSocket, so it needs no npm packages: Node.js 22 or newer, FFmpeg and a browser.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

const HELP = `film.mjs: time a voiceover, see a one-take video page as stills, and render it to an MP4.

Usage:
  node film.mjs voice <audio> [--noise=<dB>] [--min-pause <seconds>]
  node film.mjs sheet <page.html> -o <sheet.png> [--at <t,t,...> | --from <s> --to <s> --every <s>]
                [--cols <n>] [--tile <px>] [--browser <path>]
  node film.mjs render <page.html> -o <video.mp4> [--audio <voiceover>] [--scale <s>] [--from <s>] [--to <s>]
                [--crf <n>] [--browser <path>] [--timeout <minutes>]

voice   The voiceover's length and its pauses, as JSON: {"duration", "pauses", "phrases"}, in seconds. A phrase
        is the speech between two pauses. --noise: how quiet counts as a pause, in dB, written with = since it's
        negative (--noise=-40; default -35). --min-pause: the shortest pause that counts, in seconds (default 0.3).
sheet   Stills of the page side by side in one PNG, each labelled with its time. Without --at or --from/--to:
        one still from the middle of each of the page's beats. --from/--to/--every: a still every so many
        seconds, to see a camera move. --cols: stills per row (default 4). --tile: each still's width in pixels
        (default 640; 390 is a video's width on a phone held upright). At most 100 stills.
render  The page frame by frame into an H.264 MP4. --audio puts the voiceover under it, and then the page must
        last as long as the voiceover (to within a frame), unless --from/--to render only a part. --scale: draw
        smaller for a quick draft (0.5 is half the width and height; default 1). --crf: quality, lower is
        better (0 to 51, default 16). --timeout: give up after this many minutes (default 180).

The page sets window.film = { canvas, fps, duration, beats, ready, render(t) }: the skill's template does. It is
served from its own folder, so the photos, fonts and sound beside it load. The address gets ?capture=1 and
&scale=<s>. --browser: the Chrome, Edge or Chromium to use; without it the CHROME_PATH environment variable,
then the usual places.

Output: JSON on stdout. Exit codes: 0 done; 1 done, but the page reported problems, listed in "warnings" (a
photo that didn't load, an error it logged); 2 couldn't do it, with one line on stderr saying why.
Needs Node.js 22 or newer, FFmpeg (ffmpeg and ffprobe) and Chrome, Edge or Chromium.
`;

class Fail extends Error {}
const fail = (message) => {
  throw new Fail(message);
};

// ---------- options ----------

/** A number option, checked: undefined when not given. */
function num(opts, name, { min = -Infinity, max = Infinity, above, int = false, what }) {
  const raw = opts[name];
  if (raw === undefined) return undefined;
  const n = Number(raw);
  const ok =
    raw.trim() !== '' &&
    Number.isFinite(n) &&
    n >= min &&
    n <= max &&
    (above === undefined || n > above) &&
    (!int || Number.isInteger(n));
  if (!ok) fail(`--${name} must be ${what} (got "${raw}")`);
  return n;
}

function inputFile(p, what, exts) {
  if (!p) fail(`give the ${what}`);
  const abs = path.resolve(p);
  let st;
  try {
    st = fs.statSync(abs);
  } catch {
    fail(`there is no ${what} ${abs}`);
  }
  if (!st.isFile()) fail(`${abs} is not a file`);
  if (exts && !exts.includes(path.extname(abs).toLowerCase()))
    fail(`the ${what} must end in ${exts.join(' or ')}: ${abs}`);
  return abs;
}

function outputFile(p, exts) {
  if (!p) fail('give the output file with -o');
  const abs = path.resolve(p);
  if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) fail(`${abs} is a folder: give a file name`);
  const dir = path.dirname(abs);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) fail(`there is no folder ${dir}`);
  if (!exts.includes(path.extname(abs).toLowerCase())) fail(`the output must end in ${exts.join(' or ')}: ${abs}`);
  return abs;
}

/** A temporary file beside the output, moved into place when it's whole. */
const tempBeside = (out) => path.join(path.dirname(out), `.${path.basename(out)}.${process.pid}.part`);

// ---------- programs ----------

const running = new Set();

/** Kill a program with everything it started. */
function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      timeout: 10_000,
      stdio: 'ignore',
    });
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
    }
  }
}

function start(cmd, args, stdio) {
  // its own process group on macOS and Linux, so killing it takes what it started too
  const child = spawn(cmd, args, { stdio, windowsHide: true, detached: process.platform !== 'win32' });
  running.add(child);
  child.on('exit', () => running.delete(child));
  // a program that can't start says so here, not as an unhandled event
  child.on('error', (e) => {
    child.failed = e;
    running.delete(child);
  });
  return child;
}

/** Run a program to the end and return its output; it's stopped after timeoutMs. */
function runSync(cmd, args, timeoutMs) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    windowsHide: true,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.error && r.error.code === 'ENOENT')
    fail(`${cmd} isn't installed (it's part of FFmpeg, and must be on the PATH)`);
  if (r.error && r.error.code === 'ETIMEDOUT') fail(`${cmd} took longer than ${Math.round(timeoutMs / 1000)} seconds`);
  if (r.error) fail(`couldn't run ${cmd}: ${r.error.message}`);
  return r;
}

const lastLine = (text) =>
  String(text || '')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .pop() || '';

/** An audio file's length in seconds, and whether it has sound at all. */
function audioLength(file) {
  const r = runSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      'a:0',
      '-show_entries',
      'stream=codec_type:format=duration',
      '-of',
      'json',
      file,
    ],
    60_000,
  );
  if (r.status !== 0) fail(`ffprobe couldn't read ${file}: ${lastLine(r.stderr) || 'not a sound file'}`);
  let info;
  try {
    info = JSON.parse(r.stdout);
  } catch {
    fail(`ffprobe couldn't read ${file}`);
  }
  if (!info.streams || !info.streams.length) fail(`${file} has no sound in it`);
  const d = Number(info.format && info.format.duration);
  if (!Number.isFinite(d) || d <= 0) fail(`ffprobe couldn't tell how long ${file} is`);
  return d;
}

const round3 = (x) => Math.round(x * 1000) / 1000;

// ---------- voice ----------

function voice(args) {
  const { values: opts, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { noise: { type: 'string' }, 'min-pause': { type: 'string' } },
  });
  if (positionals.length > 1) fail(`voice takes one audio file (got ${positionals.length})`);
  const file = inputFile(positionals[0], 'audio file');
  const noise = num(opts, 'noise', { min: -90, max: -1, what: 'a level in dB between -90 and -1' }) ?? -35;
  const minPause =
    num(opts, 'min-pause', { above: 0, max: 10, what: 'a number of seconds above 0 and at most 10' }) ?? 0.3;
  const duration = audioLength(file);
  const r = runSync(
    'ffmpeg',
    ['-hide_banner', '-nostats', '-i', file, '-af', `silencedetect=noise=${noise}dB:d=${minPause}`, '-f', 'null', '-'],
    600_000,
  );
  if (r.status !== 0) fail(`ffmpeg couldn't read ${file}: ${lastLine(r.stderr)}`);
  const pauses = [];
  let open = null;
  for (const line of r.stderr.split(/\r?\n/)) {
    const s = /silence_start: (-?[\d.]+)/.exec(line);
    if (s) open = Math.max(0, Number(s[1]));
    const e = /silence_end: (-?[\d.]+)/.exec(line);
    if (e && open !== null) {
      pauses.push({ start: open, end: Math.min(duration, Number(e[1])) });
      open = null;
    }
  }
  if (open !== null) pauses.push({ start: open, end: duration });
  const phrases = [];
  let at = 0;
  for (const p of pauses) {
    if (p.start - at > 0.05) phrases.push({ start: at, end: p.start });
    at = p.end;
  }
  if (duration - at > 0.05) phrases.push({ start: at, end: duration });
  const r3 = (list) => list.map((p) => ({ start: round3(p.start), end: round3(p.end) }));
  return {
    code: 0,
    result: { file, duration: round3(duration), pauses: r3(pauses), phrases: r3(phrases), noise, minPause },
  };
}

// ---------- the page, in a browser ----------

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

/** Serve the page's folder on this computer only, so the page can use its photos without tainting the canvas. */
function serve(root) {
  const real = fs.realpathSync(root);
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    let rel;
    try {
      rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (rel === 'favicon.ico') {
      res.writeHead(204).end();
      return;
    }
    let file;
    try {
      file = fs.realpathSync(path.join(real, rel));
    } catch {
      res.writeHead(404).end();
      return;
    }
    // nothing outside the page's folder, even through a link
    if ((file !== real && !file.startsWith(real + path.sep)) || !fs.statSync(file).isFile()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    if (req.method === 'HEAD') res.end();
    else
      fs.createReadStream(file)
        .on('error', () => res.destroy())
        .pipe(res);
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function findBrowser(given) {
  const pick = given || process.env.CHROME_PATH;
  if (pick) {
    const abs = path.resolve(pick);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) fail(`there is no browser at ${abs}`);
    return abs;
  }
  const places = [];
  if (process.platform === 'win32') {
    for (const base of [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(
      Boolean,
    )) {
      places.push(path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    }
    for (const base of [process.env['PROGRAMFILES(X86)'], process.env.PROGRAMFILES].filter(Boolean)) {
      places.push(path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    }
    if (process.env.LOCALAPPDATA)
      places.push(path.join(process.env.LOCALAPPDATA, 'Chromium', 'Application', 'chrome.exe'));
  } else if (process.platform === 'darwin') {
    for (const base of ['/Applications', path.join(os.homedir(), 'Applications')]) {
      places.push(
        `${base}/Google Chrome.app/Contents/MacOS/Google Chrome`,
        `${base}/Microsoft Edge.app/Contents/MacOS/Microsoft Edge`,
        `${base}/Chromium.app/Contents/MacOS/Chromium`,
      );
    }
  } else {
    for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
      for (const name of [
        'google-chrome',
        'google-chrome-stable',
        'chromium',
        'chromium-browser',
        'microsoft-edge',
        'microsoft-edge-stable',
      ])
        places.push(path.join(dir, name));
    }
  }
  const found = places.find((p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  });
  if (!found) fail('found no Chrome, Edge or Chromium: install one, or give its path with --browser');
  return found;
}

/** The DevTools protocol over Node's WebSocket: commands, their answers and the events in between. */
class Devtools {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.next = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.closed = null;
    this.ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'));
      } catch {
        return;
      }
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Fail(`the browser refused ${p.method}: ${msg.error.message}`));
        else p.resolve(msg.result);
      } else {
        for (const fn of this.listeners) fn(msg.method, msg.params || {}, msg.sessionId);
      }
    };
    this.ws.onclose = () => this.shut('the browser closed');
    this.ws.onerror = () => this.shut('lost the connection to the browser');
  }

  shut(why) {
    if (this.closed) return;
    this.closed = why;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Fail(why));
    }
    this.pending.clear();
  }

  open(timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Fail('the browser took too long to answer')), timeoutMs);
      this.ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
      this.ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Fail("couldn't connect to the browser"));
      });
    });
  }

  send(method, params = {}, sessionId, timeoutMs = 60_000) {
    if (this.closed) return Promise.reject(new Fail(this.closed));
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Fail(`the browser took longer than ${Math.round(timeoutMs / 1000)} seconds on ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  waitFor(method, sessionId, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(fn);
        reject(new Fail(`the page took longer than ${Math.round(timeoutMs / 1000)} seconds to load`));
      }, timeoutMs);
      const fn = (m, params, sid) => {
        if (m === method && sid === sessionId) {
          clearTimeout(timer);
          this.listeners.delete(fn);
          resolve(params);
        }
      };
      this.listeners.add(fn);
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // already closed
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Where a page error happened, as a file in the page's folder and a line: the first place in the page's own files. */
function where(details, origin) {
  const frames = (details.stackTrace && details.stackTrace.callFrames) || [];
  const mine =
    frames.find((f) => f.url && f.url.startsWith(origin)) ||
    (details.url && details.url.startsWith(origin) ? details : null);
  if (!mine) return '';
  const file = decodeURIComponent(mine.url.slice(origin.length + 1).split('?')[0]);
  return ` (${file}${mine.lineNumber !== undefined ? `:${mine.lineNumber + 1}` : ''})`;
}

function errorText(details) {
  const ex = details.exception;
  const text = (ex && (ex.description || ex.value)) || details.text || 'an error';
  return String(text).split('\n')[0];
}

/** Start a browser of its own, serving the page's folder. load(scale) then opens the page at that scale. */
async function launch(page, { browser }) {
  const exe = findBrowser(browser);
  const server = await serve(path.dirname(page));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'film-browser-'));
  const args = [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--mute-audio',
    '--hide-scrollbars',
    '--force-color-profile=srgb',
    'about:blank',
  ];
  const child = start(exe, args, ['ignore', 'ignore', 'pipe']);
  let err = '';
  child.stderr.on('data', (d) => {
    err = (err + d.toString()).slice(-4000);
  });
  const session = { page, origin, devtools: null, sessionId: null, warnings: [], errors: [], info: null };
  session.close = async () => {
    if (session.devtools) {
      await session.devtools.send('Browser.close', {}, undefined, 5000).catch(() => {});
      session.devtools.close();
    }
    for (let i = 0; i < 50 && child.exitCode === null && child.signalCode === null; i++) await sleep(100);
    killTree(child);
    server.close();
    server.closeAllConnections?.();
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  };
  session.load = (scale) => load(session, scale);
  try {
    // the browser writes the port it chose into its profile
    const portFile = path.join(profile, 'DevToolsActivePort');
    let lines = null;
    for (let i = 0; i < 300 && !lines; i++) {
      if (child.failed) fail(`couldn't start the browser (${exe}): ${child.failed.message}`);
      if (child.exitCode !== null)
        fail(`the browser (${exe}) stopped at once: ${lastLine(err) || `exit code ${child.exitCode}`}`);
      try {
        const text = fs.readFileSync(portFile, 'utf8').split(/\r?\n/);
        if (text[0] && text[1]) lines = text;
      } catch {
        // not written yet
      }
      if (!lines) await sleep(100);
    }
    if (!lines) fail(`the browser (${exe}) didn't start within 30 seconds`);
    const devtools = new Devtools(`ws://127.0.0.1:${lines[0].trim()}${lines[1].trim()}`);
    session.devtools = devtools;
    await devtools.open(15_000);
    const { targetId } = await devtools.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await devtools.send('Target.attachToTarget', { targetId, flatten: true });
    session.sessionId = sessionId;
    const note = (list, text) => {
      if (list.length < 20 && !list.includes(text)) list.push(text);
    };
    devtools.listeners.add((method, params, sid) => {
      if (sid !== sessionId) return;
      if (method === 'Runtime.exceptionThrown')
        note(session.errors, `${errorText(params.exceptionDetails)}${where(params.exceptionDetails, origin)}`);
      else if (method === 'Runtime.consoleAPICalled' && (params.type === 'error' || params.type === 'warning')) {
        const text = params.args.map((a) => (a.value !== undefined ? String(a.value) : a.description || '')).join(' ');
        note(session.warnings, `${params.type}: ${text}`);
      } else if (
        method === 'Log.entryAdded' &&
        (params.entry.source === 'network' || params.entry.source === 'security')
      ) {
        const url =
          params.entry.url && params.entry.url.startsWith(origin)
            ? decodeURIComponent(params.entry.url.slice(origin.length + 1).split('?')[0])
            : params.entry.url;
        note(session.warnings, `${params.entry.text}${url ? `: ${url}` : ''}`);
      } else if (method === 'Inspector.targetCrashed')
        devtools.shut('the page crashed in the browser (out of memory?)');
    });
    await Promise.all(
      ['Runtime.enable', 'Log.enable', 'Page.enable', 'Inspector.enable'].map((m) => devtools.send(m, {}, sessionId)),
    );
    return session;
  } catch (e) {
    await session.close();
    throw e;
  }
}

/** Open (or reopen) the page at a scale and wait until it's ready: its size, frame rate, length and beats. */
async function load(session, scale) {
  const { devtools, sessionId, origin } = session;
  session.warnings.length = 0;
  session.errors.length = 0;
  const loaded = devtools.waitFor('Page.loadEventFired', sessionId, 60_000);
  const url = `${origin}/${encodeURIComponent(path.basename(session.page))}?capture=1&scale=${scale}`;
  const nav = await devtools.send('Page.navigate', { url }, sessionId);
  if (nav.errorText) fail(`the browser couldn't open the page: ${nav.errorText}`);
  await loaded;
  const info = await evaluate(
    session,
    `(async () => {
    await new Promise((r) => setTimeout(r, 0)); // errors from the page's own scripts get reported first
    const f = window.film;
    if (!f || typeof f !== 'object') throw new Error('the page sets no window.film');
    if (!(f.canvas instanceof HTMLCanvasElement)) throw new Error('window.film.canvas is not a canvas');
    if (typeof f.render !== 'function') throw new Error('window.film.render is not a function');
    await f.ready;
    return { width: f.canvas.width, height: f.canvas.height, fps: Number(f.fps), duration: Number(f.duration),
      beats: Array.isArray(f.beats) ? f.beats.map((b) => ({ t: Number(b.t), label: String(b.label ?? '') })) : [] };
  })()`,
    120_000,
    'getting ready',
  ).catch((e) => {
    // a script that threw is the cause, whatever the check above then found
    if (session.errors.length) fail(`the page threw an error: ${session.errors[0]}`);
    throw e;
  });
  if (session.errors.length) fail(`the page threw an error: ${session.errors[0]}`);
  if (!(info.width >= 16 && info.height >= 16))
    fail(`the page's canvas is ${info.width}x${info.height}: too small to film`);
  if (!(info.fps > 0 && info.fps <= 240))
    fail(`window.film.fps must be a number of frames per second above 0 (got ${info.fps})`);
  if (!(info.duration > 0)) fail(`window.film.duration must be a number of seconds above 0 (got ${info.duration})`);
  info.beats = info.beats
    .filter((b) => Number.isFinite(b.t) && b.t >= 0 && b.t < info.duration)
    .sort((a, b) => a.t - b.t);
  session.info = info;
  return info;
}

async function evaluate(session, expression, timeoutMs, doing) {
  const r = await session.devtools.send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true },
    session.sessionId,
    timeoutMs,
  );
  if (r.exceptionDetails)
    fail(`the page failed ${doing}: ${errorText(r.exceptionDetails)}${where(r.exceptionDetails, session.origin)}`);
  return r.result.value;
}

const PNG = 'data:image/png;base64,';
function pngData(dataUrl, doing) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith(PNG)) fail(`the page gave no picture ${doing}`);
  return Buffer.from(dataUrl.slice(PNG.length), 'base64');
}

const fmt = (t) => (Math.round(t * 100) / 100).toFixed(2);

// ---------- sheet ----------

async function sheet(args) {
  const { values: opts, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      out: { type: 'string', short: 'o' },
      at: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      every: { type: 'string' },
      cols: { type: 'string' },
      tile: { type: 'string' },
      browser: { type: 'string' },
    },
  });
  if (positionals.length > 1) fail(`sheet takes one page (got ${positionals.length})`);
  const page = inputFile(positionals[0], 'page', ['.html', '.htm']);
  const out = outputFile(opts.out, ['.png']);
  const cols = num(opts, 'cols', { min: 1, max: 12, int: true, what: 'a whole number from 1 to 12' }) ?? 4;
  const tile =
    num(opts, 'tile', { min: 120, max: 1920, int: true, what: 'a whole number of pixels from 120 to 1920' }) ?? 640;
  const from = num(opts, 'from', { min: 0, what: 'a number of seconds, 0 or more' });
  const to = num(opts, 'to', { min: 0, what: 'a number of seconds, 0 or more' });
  const every = num(opts, 'every', { above: 0, what: 'a number of seconds above 0' });
  let at = null;
  if (opts.at !== undefined) {
    at = opts.at
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)
      .map((x) => {
        const n = Number(x);
        if (!Number.isFinite(n) || n < 0)
          fail(`--at takes times in seconds, 0 or more, separated by commas (got "${x}")`);
        return n;
      });
    if (!at.length) fail('--at needs at least one time');
    if (from !== undefined || to !== undefined || every !== undefined)
      fail('give either --at or --from/--to/--every, not both');
  }
  const range = from !== undefined || to !== undefined || every !== undefined;
  if (range && (from === undefined || to === undefined || every === undefined))
    fail('--from, --to and --every go together');
  if (range && to <= from) fail(`--to (${to}) must be after --from (${from})`);
  if (range && Math.floor((to - from) / every + 1e-9) + 1 > 100)
    fail(
      `that's ${Math.floor((to - from) / every + 1e-9) + 1} stills; at most 100 in one sheet: narrow --from/--to or raise --every`,
    );
  if (at && at.length > 100) fail(`that's ${at.length} stills; at most 100 in one sheet`);
  const session = await launch(page, { browser: opts.browser });
  try {
    const full = await session.load(1);
    // drawn at about twice each still's width: sharp enough to judge, and quicker than full size
    const scale = Math.min(1, (2 * tile) / full.width);
    const { width, height, duration, beats } = scale < 1 ? await session.load(round3(scale)) : full;
    let shots;
    if (at) shots = at.map((t) => ({ t, label: '' }));
    else if (range) {
      shots = [];
      for (let i = 0; from + i * every <= to + 1e-9; i++) shots.push({ t: round3(from + i * every), label: '' });
    } else if (beats.length) {
      shots = beats.map((b, i) => ({
        t: round3((b.t + (i + 1 < beats.length ? beats[i + 1].t : duration)) / 2),
        label: b.label,
      }));
      if (shots.length > 100) shots = shots.slice(0, 100);
    } else fail('the page lists no beats (window.film.beats): give --at or --from/--to/--every');
    const late = shots.filter((s) => s.t > duration);
    if (late.length) fail(`the page lasts ${fmt(duration)} s; ${fmt(late[0].t)} s is past its end`);
    const labels = shots.map((s) => `${fmt(s.t)} s${s.label ? `  ${s.label}` : ''}`);
    const data = await evaluate(
      session,
      `((times, labels, cols, tileW) => {
      const f = window.film, W = f.canvas.width, H = f.canvas.height;
      const tileH = Math.round(tileW * H / W), band = Math.max(20, Math.round(tileW * 0.055)), gap = Math.max(6, Math.round(tileW * 0.02));
      const n = times.length, c = Math.min(cols, n), rows = Math.ceil(n / c);
      const sheet = document.createElement('canvas');
      sheet.width = c * tileW + (c + 1) * gap;
      sheet.height = rows * (tileH + band) + (rows + 1) * gap;
      const x = sheet.getContext('2d');
      x.fillStyle = '#16171a';
      x.fillRect(0, 0, sheet.width, sheet.height);
      x.imageSmoothingEnabled = true;
      x.imageSmoothingQuality = 'high';
      times.forEach((t, i) => {
        f.render(t);
        const cx = gap + (i % c) * (tileW + gap), cy = gap + Math.floor(i / c) * (tileH + band + gap);
        x.drawImage(f.canvas, cx, cy, tileW, tileH);
        x.fillStyle = '#e8e8ea';
        x.font = Math.round(band * 0.6) + 'px system-ui, -apple-system, "Segoe UI", sans-serif';
        x.textBaseline = 'middle';
        x.fillText(labels[i], cx + 2, cy + tileH + band / 2, tileW - 4);
      });
      return sheet.toDataURL('image/png');
    })(${JSON.stringify(shots.map((s) => s.t))}, ${JSON.stringify(labels)}, ${cols}, ${tile})`,
      600_000,
      'drawing the stills',
    );
    const buf = pngData(data, 'for the sheet');
    const tmp = tempBeside(out);
    try {
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, out);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      fail(`couldn't write ${out}: ${e.message}`);
    }
    const warnings = [...session.warnings, ...session.errors];
    return {
      code: warnings.length ? 1 : 0,
      result: { sheet: out, stills: labels, page: { width: full.width, height: full.height, duration }, warnings },
    };
  } finally {
    await session.close();
  }
}

// ---------- render ----------

async function render(args) {
  const { values: opts, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      out: { type: 'string', short: 'o' },
      audio: { type: 'string' },
      scale: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      crf: { type: 'string' },
      browser: { type: 'string' },
      timeout: { type: 'string' },
    },
  });
  if (positionals.length > 1) fail(`render takes one page (got ${positionals.length})`);
  const page = inputFile(positionals[0], 'page', ['.html', '.htm']);
  const out = outputFile(opts.out, ['.mp4']);
  const audio = opts.audio !== undefined ? inputFile(opts.audio, 'voiceover') : null;
  if (audio && audio === out) fail('the output would replace the voiceover');
  const scale = num(opts, 'scale', { above: 0, max: 1, what: 'a number above 0 and at most 1' }) ?? 1;
  const crf = num(opts, 'crf', { min: 0, max: 51, int: true, what: 'a whole number from 0 to 51' }) ?? 16;
  const minutes = num(opts, 'timeout', { above: 0, max: 24 * 60, what: 'a number of minutes above 0' }) ?? 180;
  let from = num(opts, 'from', { min: 0, what: 'a number of seconds, 0 or more' });
  let to = num(opts, 'to', { above: 0, what: 'a number of seconds above 0' });
  const voiceLength = audio ? audioLength(audio) : null;
  const begun = Date.now();
  let timedOut = false;
  let ffmpeg = null;
  let session = null;
  const timer = setTimeout(() => {
    timedOut = true;
    for (const c of running) killTree(c);
    session?.devtools?.shut('the render took longer than --timeout');
  }, minutes * 60_000);
  try {
    session = await launch(page, { browser: opts.browser });
    const { width, height, fps, duration } = await session.load(scale);
    if (width % 2 || height % 2) fail(`the page draws ${width}x${height}; an MP4 needs an even width and height`);
    const part = from !== undefined || to !== undefined;
    from = from ?? 0;
    to = to ?? duration;
    if (to <= from) fail(`--to (${to}) must be after --from (${from})`);
    if (to > duration + 0.5 / fps) fail(`the page lasts ${fmt(duration)} s; --to ${to} is past its end`);
    if (audio && !part && Math.abs(voiceLength - duration) > 1 / fps) {
      fail(
        `the page lasts ${round3(duration)} s but the voiceover lasts ${round3(voiceLength)} s: set the page's duration to the voiceover's`,
      );
    }
    const frames = Math.max(1, Math.round((to - from) * fps));
    const length = frames / fps;
    const tmp = tempBeside(out);
    const ff = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'image2pipe',
      '-c:v',
      'png',
      '-framerate',
      String(fps),
      '-i',
      'pipe:0',
    ];
    if (audio) ff.push(...(from > 0 ? ['-ss', String(from)] : []), '-i', audio);
    ff.push(
      '-map',
      '0:v:0',
      ...(audio ? ['-map', '1:a:0'] : []),
      '-vf',
      'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p',
      '-c:v',
      'libx264',
      '-preset',
      'slow',
      '-crf',
      String(crf),
      '-r',
      String(fps),
      '-colorspace',
      'bt709',
      '-color_primaries',
      'bt709',
      '-color_trc',
      'bt709',
      '-color_range',
      'tv',
    );
    // the sound is cut or padded with silence to the picture's exact length
    if (audio) ff.push('-af', 'apad', '-c:a', 'aac', '-b:a', '256k');
    ff.push('-t', String(length), '-movflags', '+faststart', '-f', 'mp4', tmp);
    ffmpeg = start('ffmpeg', ff, ['pipe', 'ignore', 'pipe']);
    let ffErr = '';
    ffmpeg.stderr.on('data', (d) => {
      ffErr = (ffErr + d.toString()).slice(-4000);
    });
    const ended = new Promise((resolve) => {
      ffmpeg.on('error', (e) => resolve({ code: -1, error: e }));
      ffmpeg.on('close', (code) => resolve({ code }));
    });
    ffmpeg.stdin.on('error', () => {});
    try {
      for (let i = 0; i < frames; i++) {
        const t = from + i / fps;
        const data = await evaluate(
          session,
          `(window.film.render(${t}), window.film.canvas.toDataURL('image/png'))`,
          120_000,
          `drawing ${fmt(t)} s`,
        );
        const buf = pngData(data, `at ${fmt(t)} s`);
        if (!ffmpeg.stdin.write(buf)) {
          const r = await Promise.race([new Promise((r2) => ffmpeg.stdin.once('drain', () => r2(null))), ended]);
          if (r) break;
        }
      }
      ffmpeg.stdin.end();
      const r = await ended;
      if (r.error && r.error.code === 'ENOENT')
        fail("ffmpeg isn't installed (it's part of FFmpeg, and must be on the PATH)");
      if (timedOut) fail(`the render took longer than ${minutes} minutes (--timeout)`);
      if (r.code !== 0) fail(`ffmpeg couldn't make the video: ${lastLine(ffErr) || `exit code ${r.code}`}`);
      try {
        fs.renameSync(tmp, out);
      } catch (e) {
        fail(`couldn't write ${out} (is it open in a player?): ${e.message}`);
      }
    } catch (e) {
      killTree(ffmpeg);
      await ended;
      fs.rmSync(tmp, { force: true });
      if (timedOut) fail(`the render took longer than ${minutes} minutes (--timeout)`);
      throw e;
    }
    const warnings = [...session.warnings, ...session.errors];
    return {
      code: warnings.length ? 1 : 0,
      result: {
        video: out,
        width,
        height,
        fps,
        frames,
        duration: round3(length),
        from: round3(from),
        audio,
        ...(audio ? { voiceover: round3(voiceLength) } : {}),
        seconds: Math.round((Date.now() - begun) / 1000),
        warnings,
      },
    };
  } finally {
    clearTimeout(timer);
    await session?.close();
  }
}

// ---------- main ----------

async function main(argv) {
  const major = Number(process.versions.node.split('.')[0]);
  if (!argv.length || ['--help', '-h', 'help'].includes(argv[0])) {
    process.stdout.write(HELP);
    return 0;
  }
  if (major < 22 || typeof WebSocket !== 'function')
    fail(`this needs Node.js 22 or newer (this is ${process.versions.node})`);
  const [cmd, ...rest] = argv;
  if (rest.includes('--help') || rest.includes('-h')) {
    process.stdout.write(HELP);
    return 0;
  }
  const run = { voice, sheet, render }[cmd];
  if (!run) fail(`unknown command "${cmd}": use voice, sheet or render (--help says more)`);
  const { code, result } = await run(rest);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return code;
}

const cleanup = () => {
  for (const c of running) killTree(c);
};
process.on('SIGINT', () => {
  cleanup();
  process.exit(2);
});
process.on('SIGTERM', () => {
  cleanup();
  process.exit(2);
});

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    cleanup();
    let message;
    if (e instanceof Fail) message = e.message;
    else if (e && /ambiguous/.test(e.message || ''))
      message = `${e.message.split('.')[0]}: write a value that starts with a dash with =, like --noise=-40`;
    else if (e && String(e.code || '').startsWith('ERR_PARSE_ARGS')) message = e.message.split('.')[0];
    else message = `unexpected error: ${e && e.message ? e.message : String(e)}`;
    process.stderr.write(`error: ${message.split('\n')[0]}\n`);
    process.exitCode = 2;
  },
);
