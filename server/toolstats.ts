// How the tools are used: calls, errors, refusals, time and result size per tool. Kept on this computer only
// (data/tool-stats.json), to see which tools are slow, fail or overflow, and which are never used.
import { dataPath, readJSON, writeJSON } from './util.ts';
import type { ToolStat, ToolStats } from '../shared/types.ts';

type Saved = ToolStats;
interface Live extends ToolStat {
  /** The latest call times, for p50/p95. */
  times: number[];
}

const SAVE_MS = 5 * 60_000;
const TIMES_KEPT = 200;
const file = () => dataPath('tool-stats.json');
let live: Map<string, Live> | null = null;
let since = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

function load(): Map<string, Live> {
  if (live) return live;
  const saved = readJSON<Saved | null>(file(), null);
  since = saved?.since || Date.now();
  live = new Map((saved?.tools || []).map((t) => [t.name, { ...blank(t.name), ...t, times: [] }]));
  return live;
}

const blank = (name: string): Live => ({
  name,
  calls: 0,
  errors: 0,
  denied: 0,
  clipped: 0,
  asked: 0,
  totalMs: 0,
  p50Ms: 0,
  p95Ms: 0,
  totalChars: 0,
  maxChars: 0,
  lastAt: 0,
  times: [],
});
const at = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;

/** One finished call. */
export function recordToolCall(
  name: string,
  r: { ms: number; chars: number; isError?: boolean; denied?: boolean },
): void {
  const stats = load();
  const s = stats.get(name) || blank(name);
  s.calls++;
  if (r.denied) s.denied++;
  else if (r.isError) s.errors++;
  s.totalMs += Math.max(0, Math.round(r.ms));
  s.totalChars += r.chars;
  s.maxChars = Math.max(s.maxChars, r.chars);
  s.lastAt = Date.now();
  s.times.push(r.ms);
  if (s.times.length > TIMES_KEPT) s.times.shift();
  stats.set(name, s);
  saveSoon();
}

const count = (name: string, field: 'clipped' | 'asked') => {
  const stats = load();
  const s = stats.get(name) || blank(name);
  s[field] = (s[field] || 0) + 1;
  stats.set(name, s);
  saveSoon();
};
export const recordClipped = (name: string): void => count(name, 'clipped');
/** A call that waited for a yes: these show where approvals slow agents down. */
export const recordAsked = (name: string): void => count(name.replace(/:high$/, ''), 'asked');

/** Every tool's numbers, most used first. */
export function toolStats(): Saved {
  const tools = [...load().values()].map(({ times, ...s }) => {
    if (!times.length) return s;
    const sorted = [...times].sort((a, b) => a - b);
    return { ...s, p50Ms: Math.round(at(sorted, 0.5)), p95Ms: Math.round(at(sorted, 0.95)) };
  });
  return { since, tools: tools.sort((a, b) => b.calls - a.calls) };
}

function saveSoon(): void {
  if (timer) return;
  timer = setTimeout(saveToolStats, SAVE_MS);
  timer.unref?.();
}

export function saveToolStats(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  if (live) writeJSON(file(), toolStats());
}
