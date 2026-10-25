// Top-bar status: your Claude plan usage and the connectors on your Claude account.
import fs from 'node:fs';
import path from 'node:path';
import { HOME, run, which, dataPath, readJSON, writeJSON } from './util.js';

// Usage of your Claude plan (5-hour session and weekly), as Claude Code shows it.
// Reads the Claude Code login token on this PC and sends it only to Anthropic.
// The last numbers are kept on disk, so a restart (or Anthropic rate-limiting us) doesn't blank the meters.
const USAGE_FILE = path.join(dataPath('runtime'), 'claude-usage.json');
const fresh = (v) => {
  if (!v) return null;
  // a window that has already reset no longer tells us anything
  const ok = (x) => (x && (!x.resetsAt || x.resetsAt > Date.now()) ? x : null);
  const out = { session: ok(v.session), week: ok(v.week), at: v.at };
  return out.session || out.week ? out : null;
};
let usageCache = { at: 0, value: fresh(readJSON(USAGE_FILE, null)), next: 0 };
export async function claudeUsage() {
  if (Date.now() < usageCache.next) return fresh(usageCache.value);
  let value = null;
  let wait = 120_000;
  try {
    const token = JSON.parse(fs.readFileSync(path.join(HOME, '.claude', '.credentials.json'), 'utf8')).claudeAiOauth?.accessToken;
    if (token) {
      const r = await fetch('https://api.anthropic.com/api/oauth/usage', {
        headers: { authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', accept: 'application/json' },
        signal: AbortSignal.timeout(10000),
      });
      if (r.ok) {
        const j = await r.json();
        const pick = (x) => (x && typeof x.utilization === 'number' ? { percent: Math.max(0, Math.min(100, Math.round(x.utilization))), resetsAt: x.resets_at ? Date.parse(x.resets_at) || null : null } : null);
        value = { session: pick(j.five_hour), week: pick(j.seven_day), at: Date.now() };
        writeJSON(USAGE_FILE, value);
      } else wait = r.status === 429 ? 90_000 : 30_000; // rate-limited (other apps read it too): try again soon
    }
  } catch {
    wait = 30_000;
  }
  // On a failed read keep showing the last numbers we had.
  usageCache = { at: Date.now(), value: value || usageCache.value, next: Date.now() + wait };
  return fresh(usageCache.value);
}

// The MCP connectors Claude Code agents get from your Claude account and config (`claude mcp list`).
let connCache = { at: 0, value: [], running: null };
export async function claudeConnectors() {
  if (Date.now() - connCache.at < 5 * 60_000) return connCache.value;
  if (connCache.running) return connCache.running;
  connCache.running = (async () => {
    if (!which('claude')) return [];
    const r = await run('claude', ['mcp', 'list'], { timeout: 90_000 });
    const out = [];
    for (const line of r.stdout.split(/\r?\n/)) {
      const m = /^(.+?):\s+(.*?)\s+-\s+(.+)$/.exec(line.trim());
      if (!m) continue;
      const raw = m[1].trim();
      const st = m[3];
      const status = /connected/i.test(st) ? 'connected' : /auth/i.test(st) ? 'needs-auth' : /not configured/i.test(st) ? 'off' : 'failed';
      const name = raw.replace(/^claude\.ai\s+/i, '').replace(/^plugin:[^:]+:/i, '').trim();
      out.push({ id: raw, name, status, detail: st.replace(/^[^\w]+/, '') });
    }
    // One entry per service: the best status wins (e.g. Gmail connected via claude.ai beats a failed plugin copy).
    const rank = { connected: 3, 'needs-auth': 2, failed: 1, off: 0 };
    const best = new Map();
    for (const c of out) {
      const k = c.name.toLowerCase();
      if (!best.has(k) || rank[c.status] > rank[best.get(k).status]) best.set(k, c);
    }
    connCache = { at: Date.now(), value: [...best.values()], running: null };
    return connCache.value;
  })();
  try {
    return await connCache.running;
  } finally {
    connCache.running = null;
  }
}

// OpenRouter: credits left and what you spent today (your key, sent only to OpenRouter).
let orCache = { at: 0, value: null };
export async function openrouterUsage(key) {
  if (!key) return null;
  if (Date.now() - orCache.at < 60_000) return orCache.value;
  let value = orCache.value;
  try {
    const H = { authorization: `Bearer ${key}` };
    const [credits, k] = await Promise.all([
      fetch('https://openrouter.ai/api/v1/credits', { headers: H, signal: AbortSignal.timeout(8000) }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch('https://openrouter.ai/api/v1/key', { headers: H, signal: AbortSignal.timeout(8000) }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    const total = credits?.data?.total_credits;
    const used = credits?.data?.total_usage;
    const today = k?.data?.usage_daily;
    const limit = k?.data?.limit;
    if (typeof total === 'number' || typeof today === 'number') {
      value = {
        left: typeof total === 'number' ? Math.max(0, total - (used || 0)) : null,
        percent: typeof total === 'number' && total > 0 ? Math.min(100, Math.round(((used || 0) / total) * 100)) : limit ? Math.min(100, Math.round(((k.data.usage || 0) / limit) * 100)) : null,
        today: typeof today === 'number' ? today : null,
        week: typeof k?.data?.usage_weekly === 'number' ? k.data.usage_weekly : null,
      };
    }
  } catch {
    /* keep the last numbers */
  }
  orCache = { at: Date.now(), value };
  return value;
}

// Codex: the 5-hour and weekly limits, from the newest session log Codex writes on this PC.
let cxCache = { at: 0, value: null };
export function codexUsage() {
  if (Date.now() - cxCache.at < 60_000) return cxCache.value;
  let value = null;
  try {
    const root = path.join(HOME, '.codex', 'sessions');
    let newest = null;
    const walk = (dir, depth) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory() && depth < 4) walk(full, depth + 1);
        else if (e.isFile() && e.name.endsWith('.jsonl')) {
          const t = fs.statSync(full).mtimeMs;
          if (!newest || t > newest.t) newest = { full, t };
        }
      }
    };
    if (fs.existsSync(root)) walk(root, 0);
    if (newest) {
      const lines = fs.readFileSync(newest.full, 'utf8').trim().split('\n').reverse();
      for (const l of lines.slice(0, 400)) {
        if (!l.includes('rate_limits')) continue;
        const j = JSON.parse(l);
        const rl = j.payload?.rate_limits || j.rate_limits || j.msg?.rate_limits;
        if (!rl) continue;
        const pick = (x) => (x && typeof x.used_percent === 'number' ? { percent: Math.round(x.used_percent), resetsAt: x.resets_at ? (x.resets_at > 1e12 ? x.resets_at : x.resets_at * 1000) : x.resets_in_seconds ? newest.t + x.resets_in_seconds * 1000 : null } : null);
        value = { session: pick(rl.primary), week: pick(rl.secondary) };
        break;
      }
    }
  } catch {
    /* no logs */
  }
  cxCache = { at: Date.now(), value };
  return value;
}
