// The work behind the Files tools: reading in parts, exact edits, finding and searching files.
// tools.ts checks every path against the agent's folders first; this module never follows links.
import fs from 'node:fs';
import path from 'node:path';
import { walk } from './util.ts';

export const READ_LINES = 2000;
export const READ_CHARS = 40_000;
const READ_MAX_BYTES = 20 * 1024 * 1024;
const FOUND_SHOWN = 500;
const MATCHES_SHOWN = 200;
const SEARCH_FILE_BYTES = 2 * 1024 * 1024;
const SEARCH_TOTAL_BYTES = 100 * 1024 * 1024;
const SEARCH_MS = 8000;
const WALK = { maxDepth: 12, limit: 20_000 };

export const sizeText = (n: number): string => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`);
const looksBinary = (b: Buffer): boolean => b.subarray(0, 8000).includes(0);
const isPlainFile = (p: string): boolean => {
  try {
    return fs.lstatSync(p).isFile();
  } catch {
    return false;
  }
};
const slashed = (p: string): string => p.split(path.sep).join('/');

/** Part of a text file, from line offset. A file read whole comes back exactly as it is. */
export function readText(real: string, shown: string, opts: PageOptions = {}): string {
  const st = fs.statSync(real);
  if (st.isDirectory()) throw new Error(`${shown} is a folder: list it with list_files.`);
  if (st.size > READ_MAX_BYTES) throw new Error(`${shown} is ${sizeText(st.size)}, too big to read here. Look for what you need with search_files.`);
  const bytes = fs.readFileSync(real);
  if (looksBinary(bytes)) return `${shown} is not a text file (${sizeText(st.size)}).`;
  return pageText(bytes.toString('utf8'), opts);
}

export interface PageOptions {
  offset?: number;
  limit?: number;
  chars?: number;
}

/** Part of a text, from line offset (a document's text pages the same way as a file's). Whole, it is as it was. */
export function pageText(text: string, { offset = 1, limit = READ_LINES, chars = READ_CHARS }: PageOptions = {}): string {
  const lines = text.split('\n');
  // (a final newline doesn't count as a line of its own)
  const total = lines.length - (lines.at(-1) === '' ? 1 : 0);
  const start = Math.min(Math.max(1, Math.floor(Number(offset) || 1)), Math.max(total, 1));
  const most = Math.min(Math.max(1, Math.floor(Number(limit) || READ_LINES)), READ_LINES);
  let end = start - 1;
  let size = 0;
  while (end < total && end - start + 1 < most && size + lines[end]!.length + 1 <= chars) size += lines[end++]!.length + 1;
  if (end < start && total) {
    const line = lines[start - 1]!;
    return `${line.slice(0, chars)}\n\n[Line ${start} of ${total} is ${line.length} characters long: only its first ${chars} are shown.${start < total ? ` Continue with offset ${start + 1}.` : ''}]`;
  }
  if (start === 1 && end >= total) return text;
  return `${lines.slice(start - 1, end).join('\n')}\n\n[Lines ${start}-${end} of ${total}.${end < total ? ` Continue with offset ${end + 1}.` : ''}]`;
}

export interface FileEdit {
  old: string;
  new: string;
  all?: boolean;
}

/** Each edit replaces exact text that is there once (or every time, with all). One that doesn't fit changes nothing. */
export function applyEdits(text: string, edits: FileEdit[]): { text: string; replaced: number } {
  if (!Array.isArray(edits) || !edits.length) throw new Error('Give at least one edit: { old, new }.');
  // a file with Windows line ends: the model writes \n, the file has \r\n
  const crlf = text.includes('\r\n');
  let out = text;
  let replaced = 0;
  edits.forEach((e, i) => {
    const which = edits.length > 1 ? ` (edit ${i + 1})` : '';
    let old = typeof e?.old === 'string' ? e.old : '';
    let next = typeof e?.new === 'string' ? e.new : '';
    if (!old) throw new Error(`old is empty${which}: give the exact text to replace.`);
    if (crlf && !old.includes('\r')) {
      old = old.replace(/\n/g, '\r\n');
      next = next.replace(/\r?\n/g, '\r\n');
    }
    const count = out.split(old).length - 1;
    if (!count) throw new Error(`The text to replace isn't in the file${which}. Read the file again and copy the text exactly, spaces included.`);
    if (count > 1 && !e.all) throw new Error(`The text to replace is there ${count} times${which}: include more of the text around it, or set all to replace every one.`);
    out = e.all ? out.split(old).join(next) : out.replace(old, () => next);
    replaced += e.all ? count : 1;
  });
  return { text: out, replaced };
}

/** A glob as a regular expression: * within a folder, ** across folders, ? one character, {a,b} either. */
export function globRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*' && glob[i + 1] === '*') {
      const folders = glob[i + 2] === '/';
      re += folders ? '(?:.*/)?' : '.*';
      i += folders ? 2 : 1;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '{' && glob.indexOf('}', i) > i) {
      const close = glob.indexOf('}', i);
      re += `(?:${glob.slice(i + 1, close).split(',').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`;
      i = close;
    } else re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

/** Does a path (relative, with /) match: a pattern without / matches the file's name in any folder. */
function matcher(glob: string): (rel: string) => boolean {
  const g = glob.replace(/\\/g, '/').replace(/^\.\//, '');
  const re = globRegExp(g);
  return g.includes('/') ? (rel) => re.test(rel) : (rel) => re.test(rel.slice(rel.lastIndexOf('/') + 1));
}

/** Files under a folder whose path matches, newest first. */
export function findFiles(root: string, shown: string, pattern: string): string {
  if (!String(pattern || '').trim()) throw new Error('Give a pattern, e.g. "**/*.md".');
  const match = matcher(String(pattern));
  const found = walk(root, { ...WALK, filter: (p) => isPlainFile(p) && match(slashed(path.relative(root, p))) });
  const dated = found.map((p) => ({ rel: slashed(path.relative(root, p)), at: fs.statSync(p).mtimeMs })).sort((a, b) => b.at - a.at);
  if (!dated.length) return `No file under ${shown} matches "${pattern}".`;
  const more = dated.length > FOUND_SHOWN ? `\n[${dated.length - FOUND_SHOWN} more: use a narrower pattern.]` : '';
  return `${shown}\n${dated.slice(0, FOUND_SHOWN).map((f) => f.rel).join('\n')}${more}`;
}

// Nested quantifiers like (a+)+ can take forever on one line: those are searched for as plain text.
const RISKY = /\([^)]*[+*}][^)]*\)\s*[+*{]/;

/** Lines that match in the text files under a folder (or in one file), as file:line: text. */
export function searchFiles(root: string, shown: string, query: string, glob?: string): string {
  const q = String(query || '');
  if (!q.trim()) throw new Error('Give words or a regular expression to search for.');
  let re: RegExp;
  try {
    if (RISKY.test(q)) throw new Error('risky');
    re = new RegExp(q, 'i');
  } catch {
    re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  }
  const single = fs.statSync(root).isFile();
  const match = glob ? matcher(glob) : () => true;
  const files = single ? [root] : walk(root, { ...WALK, filter: (p) => isPlainFile(p) && match(slashed(path.relative(root, p))) });
  const started = Date.now();
  const hits: string[] = [];
  let total = 0;
  let bytes = 0;
  let stopped = '';
  for (const file of files) {
    if (Date.now() - started > SEARCH_MS || bytes > SEARCH_TOTAL_BYTES) {
      stopped = ' The search stopped early (too many files): narrow it with path or glob.';
      break;
    }
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      continue;
    }
    if (size > SEARCH_FILE_BYTES) continue;
    const buf = fs.readFileSync(file);
    bytes += size;
    if (looksBinary(buf)) continue;
    const rel = single ? path.basename(file) : slashed(path.relative(root, file));
    buf.toString('utf8').split('\n').forEach((line, i) => {
      if (!re.test(line)) return;
      if (++total <= MATCHES_SHOWN) hits.push(`${rel}:${i + 1}: ${(line.length > 300 ? `${line.slice(0, 300)}…` : line).trimEnd()}`);
    });
  }
  if (!total) return `No line under ${shown} matches "${q}".${stopped}`;
  const more = total > MATCHES_SHOWN ? `\n[First ${MATCHES_SHOWN} of ${total} matching lines: search for something narrower.]` : '';
  return `${single ? shown : `In ${shown}:`}\n${hits.join('\n')}${more}${stopped ? `\n[${stopped.trim()}]` : ''}`;
}

/** A folder's entries (depth levels down), files with their sizes. Links are shown, never followed. */
export function listFolder(real: string, shown: string, depth = 1, most = FOUND_SHOWN): string {
  const levels = Math.min(Math.max(1, Math.floor(Number(depth) || 1)), 5);
  const lines: string[] = [];
  let more = 0;
  const visit = (dir: string, level: number) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      const rel = slashed(path.relative(real, p));
      if (lines.length >= most) {
        more++;
        continue;
      }
      if (e.isSymbolicLink()) lines.push(`[link] ${rel}`);
      else if (e.isDirectory()) {
        lines.push(`[dir] ${rel}`);
        if (level < levels && e.name !== 'node_modules' && !e.name.startsWith('.git')) visit(p, level + 1);
      } else {
        let size = '';
        try {
          size = `  ${sizeText(fs.statSync(p).size)}`;
        } catch {
          /* gone */
        }
        lines.push(`${rel}${size}`);
      }
    }
  };
  visit(real, 1);
  return `${shown}\n${lines.join('\n')}${more ? `\n[${more} more not shown: list a folder inside it.]` : ''}`;
}
