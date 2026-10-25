// Top-bar status: your Claude plan usage and the connectors on your Claude account.
import fs from 'node:fs';
import path from 'node:path';
import { HOME, run, which } from './util.js';

// Usage of your Claude plan (5-hour session and weekly), as Claude Code shows it.
// Reads the Claude Code login token on this PC and sends it only to Anthropic.
let usageCache = { at: 0, value: null, next: 0 };
export async function claudeUsage() {
  if (Date.now() < usageCache.next) return usageCache.value;
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
        value = { session: pick(j.five_hour), week: pick(j.seven_day) };
      } else wait = r.status === 429 ? 5 * 60_000 : 30_000; // rate-limited (other apps read it too): back off
    }
  } catch {
    wait = 30_000;
  }
  // On a failed read keep showing the last numbers we had.
  usageCache = { at: Date.now(), value: value || usageCache.value, next: Date.now() + wait };
  return usageCache.value;
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
