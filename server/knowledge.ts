// Each agent's knowledge: files you add (data/knowledge/<agent>/) plus folders you link.
// Small knowledge goes straight into the agent's instructions; big knowledge is searched on demand.
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, walk, exists } from './util.ts';
import { projectData } from './store.ts';

const TEXT_EXT =
  /\.(md|markdown|txt|json|ya?ml|csv|tsv|html?|xml|js|mjs|ts|tsx|jsx|py|rs|go|java|c|cpp|h|cs|css|scss|sql|sh|ps1|toml|ini|cfg|log|srt|vtt|rtf)$/i;
const INLINE_LIMIT = 24_000;

/** The part of an agent knowledge needs (an Agent fits; so do the stand-in agents workflows use). */
export interface KnowledgeAgent {
  id: string;
  knowledge?: { folders?: string[] };
}

export interface KnowledgeFile {
  path: string;
  /** Shown to the agent and used to open the file: relative to its own folder, or "<linked folder>/<file>". */
  label: string;
  /** true for files you added to the agent, false for files in linked folders */
  own: boolean;
  size: number;
}

export interface KnowledgeHit {
  file: string;
  line: number;
  score: number;
  text: string;
}

export interface KnowledgeRead {
  file: string;
  from: number;
  to: number;
  total: number;
  text: string;
}

/** An agent's own knowledge folder, made when it isn't there yet: for adding files to it. */
export const knowledgeDir = (agentId: string): string => ensureDir(projectData('knowledge', agentId));
// The same folder for reading: looking at an agent's knowledge never makes it.
const ownDir = (agentId: string): string => projectData('knowledge', agentId);

// Plain text files only: a link inside a knowledge folder (reference.md -> a file anywhere on the PC)
// would be read straight into the agent's instructions. (walk already skips linked folders.)
const plainText = (p: string): boolean => {
  if (!TEXT_EXT.test(p)) return false;
  try {
    return fs.lstatSync(p).isFile();
  } catch {
    return false;
  }
};

// A file as it was listed. `follow`: a linked file of its own (not a folder) is read through a link, as it
// always was; every other file only while it is a plain file.
type Listed = KnowledgeFile & { follow: boolean };

function walkKnowledge(own: string, folders: string[]): Listed[] {
  const files: Omit<Listed, 'size'>[] = [];
  for (const f of walk(own, { maxDepth: 4, filter: plainText }))
    files.push({ path: f, label: path.relative(own, f), own: true, follow: false });
  for (const folder of folders) {
    if (!exists(folder)) continue;
    const st = fs.statSync(folder);
    if (st.isFile()) files.push({ path: folder, label: path.basename(folder), own: false, follow: true });
    else
      for (const f of walk(folder, { maxDepth: 5, filter: plainText, limit: 2000 }))
        files.push({
          path: f,
          label: path.join(path.basename(folder), path.relative(folder, f)),
          own: false,
          follow: false,
        });
  }
  return files.map((f) => {
    let size = 0;
    try {
      size = fs.statSync(f.path).size;
    } catch {
      /* gone */
    }
    return { ...f, size };
  });
}

// ---------- kept between calls ----------
// Every prompt and tool list asks for the file list, so it is kept for a few seconds per agent and set of
// linked folders: the dashboard's own changes clear it at once, other changes show when it runs out.
// Texts are kept for searching while a file's time and size stay the same, up to a total size: the
// least recently used goes first.
export const knowledgeCache = {
  /** how long a file list is kept (ms) */
  listMs: 3000,
  /** the most text kept, in bytes (two per character, as strings hold them) */
  maxBytes: 32 * 1024 * 1024,
  /** the clock the list's window is measured with (tests move it on) */
  now: (): number => Date.now(),
};
const lists = new Map<string, { at: number; files: Listed[] }>();
const texts = new Map<string, { mtimeMs: number; size: number; text: string }>();
let textBytes = 0;
// File times are coarse on some disks (2 s on FAT), so a change made in the same tick as the read could
// keep the time and size the text was kept with: a file changed that recently is read again until it is older.
const SETTLED_MS = 2000;

/** Forget the kept file lists and texts (after files were put back from a backup or a project folder). */
export function clearKnowledgeCache(): void {
  lists.clear();
  texts.clear();
  textBytes = 0;
}

function listed(agent: KnowledgeAgent): Listed[] {
  const own = ownDir(agent.id);
  const folders = agent.knowledge?.folders || [];
  const key = JSON.stringify([own, folders]);
  const now = knowledgeCache.now();
  const was = lists.get(key);
  if (was && now - was.at < knowledgeCache.listMs) return was.files;
  for (const [k, v] of lists) if (now - v.at >= knowledgeCache.listMs) lists.delete(k);
  const files = walkKnowledge(own, folders);
  lists.set(key, { at: now, files });
  return files;
}

// A listed file, checked again just before it is read: a file swapped for a link while its list is kept
// is still never read through the link.
function statListed(f: Listed): fs.Stats | null {
  try {
    const st = f.follow ? fs.statSync(f.path) : fs.lstatSync(f.path);
    return st.isFile() ? st : null;
  } catch {
    return null;
  }
}

function dropText(p: string): void {
  const was = texts.get(p);
  if (!was) return;
  texts.delete(p);
  textBytes -= was.text.length * 2;
}

const read = (p: string, max = 200_000): string => {
  try {
    return fs.readFileSync(p, 'utf8').slice(0, max);
  } catch {
    return '';
  }
};

const SEARCHED = 2_000_000;
// A listed file's text, as much as a search looks at, from what is kept when the file hasn't changed.
function textOf(f: Listed): string {
  const st = statListed(f);
  if (!st) {
    dropText(f.path);
    return '';
  }
  const was = texts.get(f.path);
  if (was && was.mtimeMs === st.mtimeMs && was.size === st.size) {
    // (now the most recently used)
    texts.delete(f.path);
    texts.set(f.path, was);
    return was.text;
  }
  dropText(f.path);
  const text = read(f.path, SEARCHED);
  const bytes = text.length * 2;
  if (Date.now() - st.mtimeMs > SETTLED_MS && bytes <= knowledgeCache.maxBytes) {
    texts.set(f.path, { mtimeMs: st.mtimeMs, size: st.size, text });
    textBytes += bytes;
    for (const [k, v] of texts) {
      if (textBytes <= knowledgeCache.maxBytes) break;
      texts.delete(k);
      textBytes -= v.text.length * 2;
    }
  }
  return text;
}

export function knowledgeFiles(agent: KnowledgeAgent): KnowledgeFile[] {
  // (copies, so a caller can't change the kept list)
  return listed(agent).map((f) => ({ path: f.path, label: f.label, own: f.own, size: f.size }));
}

export function addKnowledgeFile(agentId: string, name: unknown, content: string): string {
  const safe = path.basename(String(name || 'note.md')).replace(/[^\w.\- ]+/g, '_');
  const file = path.join(knowledgeDir(agentId), TEXT_EXT.test(safe) ? safe : `${safe}.md`);
  fs.writeFileSync(file, content);
  lists.clear();
  dropText(file);
  return file;
}

export function removeKnowledgeFile(agentId: string, label: string) {
  const own = knowledgeDir(agentId);
  const file = path.resolve(own, label);
  // inside this agent's own folder (with the separator, so knowledge/agent1 can't reach knowledge/agent10)
  if (!file.startsWith(path.resolve(own) + path.sep)) throw new Error('Not an agent knowledge file.');
  fs.unlinkSync(file);
  lists.clear();
  dropText(file);
}

// The text placed in the agent's instructions.
export function knowledgeContext(agent: KnowledgeAgent): string {
  const files = listed(agent);
  if (!files.length) return '';
  const total = files.reduce((n, f) => n + f.size, 0);
  if (total <= INLINE_LIMIT) {
    return (
      '\n\n# Your knowledge\nThese files are your reference material. Rely on them and cite the file name when you use them.\n' +
      files.map((f) => `\n## ${f.label}\n${textOf(f).slice(0, 200_000)}`).join('\n')
    );
  }
  const list = files
    .slice(0, 200)
    .map((f) => `- ${f.label} (${Math.round(f.size / 1024)} KB)`)
    .join('\n');
  return `\n\n# Your knowledge\nYou have ${files.length} reference files (${Math.round(total / 1024)} KB). Search them with knowledge_search before answering anything they might cover, and open one with knowledge_read.\n${list}${files.length > 200 ? `\n…and ${files.length - 200} more` : ''}`;
}

export function searchKnowledge(agent: KnowledgeAgent, query: unknown, limit = 6): KnowledgeHit[] {
  const terms = String(query || '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1);
  if (!terms.length) return [];
  const hits: KnowledgeHit[] = [];
  for (const f of listed(agent)) {
    const text = textOf(f);
    const lines = text.split(/\r?\n/);
    const size = 40;
    for (let i = 0; i < lines.length; i += size / 2) {
      const chunk = lines.slice(i, i + size).join('\n');
      const low = chunk.toLowerCase();
      let score = 0;
      for (const t of terms) {
        let idx = low.indexOf(t);
        let n = 0;
        while (idx !== -1 && n < 20) {
          n++;
          idx = low.indexOf(t, idx + t.length);
        }
        if (n) score += 1 + Math.log(n);
      }
      if (score > 0)
        hits.push({
          file: f.label,
          line: i + 1,
          score: score + (low.includes(String(query).toLowerCase()) ? 3 : 0),
          text: chunk.slice(0, 1600),
        });
    }
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

export function readKnowledge(
  agent: KnowledgeAgent,
  label: string,
  offsetLine: number | null | undefined = 1,
  lines = 400,
): KnowledgeRead {
  const files = listed(agent);
  const f =
    files.find((x) => x.label === label) ||
    files.find((x) => x.label.toLowerCase().includes(String(label).toLowerCase()));
  if (!f) throw new Error(`No knowledge file "${label}".`);
  const all = (statListed(f) ? read(f.path, 5_000_000) : '').split(/\r?\n/);
  const start = Math.max(0, (offsetLine || 1) - 1);
  return {
    file: f.label,
    from: start + 1,
    to: Math.min(all.length, start + lines),
    total: all.length,
    text: all.slice(start, start + lines).join('\n'),
  };
}

/** The folders an agent may read its knowledge from (its own folder only once it has one). */
export function knowledgeRoots(agent: KnowledgeAgent): string[] {
  const own = ownDir(agent.id);
  return [...(exists(own) ? [own] : []), ...(agent.knowledge?.folders || []).filter(exists)];
}
