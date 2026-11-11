// Files and folders you attach: dropped on a chat, the team builder, a new project or the Brain on
// the map, or picked with the paperclip. They are saved in the project's Brain folder
// (uploads/<batch>/…), so every agent can open them, and messages carry their paths.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type http from 'node:http';
import { ensureDir, exists, isInside, realTarget } from './util.ts';
import { ensureBrain } from './projects.ts';
import { DocumentError, documentAbout, documentHasText, isDocumentName, readDocumentFile } from './documents.ts';
import type { Project, UploadedFile } from '../shared/types.ts';

const MAX_ATTACHMENTS = 50;
const MAX_DEPTH = 16;
export const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;
const TEXT_EXT =
  /\.(md|markdown|txt|json|jsonl|ya?ml|csv|tsv|html?|xml|svg|js|mjs|cjs|ts|tsx|jsx|py|rb|rs|go|java|kt|swift|c|cc|cpp|h|hpp|cs|php|lua|css|scss|less|sql|sh|bash|zsh|ps1|bat|toml|ini|cfg|conf|env|log|srt|vtt|rtf|tex|gitignore|dockerfile)$/i;
// Windows can't have these as file names
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

class UploadError extends Error {
  status: number;
  constructor(status: number, msg: string) {
    super(msg);
    this.status = status;
  }
}

export const uploadsRoot = (p?: Project): string => path.join(ensureBrain(p), 'uploads');

// uploads/ only while it really is a folder in the Brain folder: a crafted project could make it a link
// to anywhere on the PC, and agents may read everything under it. Null when it points out.
export function safeUploadsRoot(p?: Project): string | null {
  const brain = ensureBrain(p);
  const root = path.join(brain, 'uploads');
  const r = realTarget(brain);
  const q = realTarget(root);
  return r && q && isInside(r, q) ? root : null;
}
const checkedRoot = (): string => {
  const root = safeUploadsRoot();
  if (!root)
    throw new UploadError(400, "The project's uploads folder is a link out of its Brain folder, so it isn't used.");
  return root;
};

// A new folder for one drop: uploads/2026-10-26_143012-ab12
export function newBatch(): { batch: string; dir: string } {
  const d = new Date();
  const two = (n: number) => String(n).padStart(2, '0');
  const root = checkedRoot();
  ensureDir(root);
  let batch: string;
  let dir: string;
  for (;;) {
    batch = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}_${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}-${crypto.randomBytes(6).toString('hex')}`;
    dir = path.join(root, batch);
    try {
      fs.mkdirSync(dir);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  // a Git project: keep dropped files out of commits (an agent's `git add -A` would take them all)
  const ignore = path.join(root, '.gitignore');
  if (exists(path.join(ensureBrain(), '.git')) && !exists(ignore))
    fs.writeFileSync(ignore, '# Files attached in the dashboard. Move a file out of uploads/ to commit it.\n*\n');
  return { batch, dir };
}

// One part of a path, made safe for every OS: no separators, control or reserved characters, no "..".
export function cleanName(s: string): string {
  let n = String(s || '')
    .normalize('NFC')
    .replace(/[\u0000-\u001f<>:"|?*\\/]/g, '_')
    .trim()
    .replace(/[. ]+$/, '');
  if (!n) return '';
  if (RESERVED.test(n)) n = `_${n}`;
  return n.slice(0, 150);
}

// "docs/sub/a.md" (as the browser sends it) → ['docs', 'sub', 'a.md']; '..' and empty parts are dropped.
export function safeParts(rel: string): string[] {
  return String(rel || '')
    .split(/[\\/]+/)
    .map(cleanName)
    .filter(Boolean);
}

// Claim a free name (a.png, else a (2).png…) by creating it, so two uploads of the same name at once can't both get it.
export function reserveName(file: string): string {
  const ext = path.extname(file);
  const base = file.slice(0, file.length - ext.length);
  for (let i = 1; ; i++) {
    const name = i === 1 ? file : `${base} (${i})${ext}`;
    try {
      fs.closeSync(fs.openSync(name, 'wx'));
      return name;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  }
}

// Save one file of a batch from the raw request body (streamed, never held in memory).
export async function receive(req: http.IncomingMessage, batch: string, rel: string): Promise<UploadedFile> {
  return receiveSource(req, batch, rel, { declaredBytes: Number(req.headers['content-length'] || 0) });
}

/** Browser requests and private platform streams use the same bounded, safe upload path. */
export async function receiveSource(
  source: AsyncIterable<Uint8Array>,
  batch: string,
  rel: string,
  {
    declaredBytes = 0,
    maxBytes = Infinity,
    signal,
    reserved,
  }: {
    declaredBytes?: number;
    maxBytes?: number;
    signal?: AbortSignal;
    reserved?: (target: string, temporary: string) => void;
  } = {},
): Promise<UploadedFile> {
  // No size limit of its own; a caller with one (a gateway's file limits) passes it.
  if (maxBytes !== Infinity && (!Number.isSafeInteger(maxBytes) || maxBytes < 1))
    throw new UploadError(400, 'Bad upload limit.');
  const limitError = () => new UploadError(413, `${path.basename(rel)} is over ${maxBytes / 1024 / 1024} MB.`);
  if (declaredBytes > maxBytes) throw limitError();
  signal?.throwIfAborted();
  if (!/^[\w-]{1,64}$/.test(batch)) throw new UploadError(400, 'Bad upload batch.');
  const root = checkedRoot();
  const dir = path.join(root, batch);
  if (!exists(dir) || !fs.lstatSync(dir).isDirectory() || !inside(root, dir))
    throw new UploadError(400, 'That upload batch is gone. Attach the files again.');
  const parts = safeParts(rel);
  if (!parts.length) throw new UploadError(400, 'The file needs a name.');
  if (parts.length > MAX_DEPTH) throw new UploadError(400, 'That folder is nested too deep.');
  ensureDir(path.dirname(path.join(dir, ...parts)));
  // a folder in the path that is a link out of uploads/
  if (!inside(root, path.dirname(path.join(dir, ...parts)))) throw new UploadError(400, 'Bad upload path.');
  const target = reserveName(path.join(dir, ...parts));
  const tmp = `${target}.${crypto.randomBytes(3).toString('hex')}.part`;
  let size = 0;
  const count = new Transform({
    transform(chunk: Buffer, _enc, done) {
      size += chunk.length;
      if (size > maxBytes) done(limitError());
      else done(null, chunk);
    },
  });
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(tmp, 'wx');
    reserved?.(target, tmp);
    const stream = fs.createWriteStream(tmp, { fd: descriptor, autoClose: true });
    descriptor = undefined;
    await pipeline(source, count, stream, { signal });
    if (!inside(root, target) || !inside(root, tmp)) throw new UploadError(400, 'Bad upload path.');
    fs.renameSync(tmp, target);
  } catch (e) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(tmp, { force: true });
    fs.rmSync(target, { force: true });
    throw e;
  }
  const folder = parts.length > 1;
  // a folder ends with a separator, so it can be told from a file anywhere it is shown
  return {
    path: target,
    top: folder ? path.join(dir, parts[0]) + path.sep : target,
    kind: folder ? 'folder' : 'file',
    name: path.basename(target),
    size,
  };
}

/** Only a gateway's recorded batch is passed here, while its exclusive worker owns the inbox. */
export function cleanOwnedBatch(batch: string, keep: string[]): void {
  if (!/^[\w-]{1,64}$/.test(batch)) throw new UploadError(400, 'Bad upload batch.');
  const root = checkedRoot();
  const dir = path.join(root, batch);
  if (!inside(root, dir)) throw new UploadError(400, 'Bad upload path.');
  if (!exists(dir)) return;
  if (!fs.lstatSync(dir).isDirectory()) throw new UploadError(400, 'Bad upload path.');
  const retained = new Set(keep.map((file) => path.resolve(file)));
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if ((entry.isFile() || entry.isSymbolicLink()) && !retained.has(path.resolve(file))) fs.unlinkSync(file);
  }
}

// Strictly inside root once links are followed (case only ignored on Windows). A link that can't be
// followed safely counts as outside.
const inside = (root: string, p: string) => {
  const r = realTarget(root);
  const q = realTarget(p);
  return !!r && !!q && isInside(r, q);
};

// The attachments a request names, keeping only uploads of this project that still exist.
// Folders end with a separator.
export function cleanAttachments(list: unknown, max = MAX_ATTACHMENTS): string[] {
  const root = safeUploadsRoot();
  if (!Array.isArray(list) || !root) return [];
  const out = new Set<string>();
  for (const x of list) {
    if (typeof x !== 'string' || !x) continue;
    const p = path.resolve(x);
    if (inside(root, p) && exists(p)) out.add(isDir(p) ? p + path.sep : p);
    if (out.size >= max) break;
  }
  return [...out];
}

// Take back something you attached (✕ on its chip): only inside uploads/.
export function removeUpload(p: string): boolean {
  const root = checkedRoot();
  const abs = path.resolve(String(p || ''));
  if (!inside(root, abs)) throw new UploadError(403, 'Only uploaded files can be removed.');
  if (!exists(abs)) return false;
  fs.rmSync(abs, { recursive: true, force: true });
  // and its batch folder once it is empty
  const batch = path.join(root, path.relative(root, abs).split(path.sep)[0]);
  try {
    if (batch !== abs && !fs.readdirSync(batch).length) fs.rmdirSync(batch);
  } catch {
    /* already gone */
  }
  return true;
}

// ---------- telling agents about them ----------
const kb = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

interface FolderFile {
  rel: string;
  abs: string;
  size: number;
}
function folderFiles(dir: string, limit = 2000): FolderFile[] {
  const out: FolderFile[] = [];
  const walk = (d: string) => {
    let list: fs.Dirent[] = [];
    try {
      list = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    list.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of list) {
      if (out.length >= limit) return;
      const abs = path.join(d, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.isFile()) {
        let size = 0;
        try {
          size = fs.statSync(abs).size;
        } catch {
          /* gone */
        }
        out.push({ rel: path.relative(path.dirname(dir), abs).split(path.sep).join('/'), abs, size });
      }
    }
  };
  walk(dir);
  return out;
}

const isDir = (p: string) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

const kindOf = (name: string) =>
  IMAGE_EXT.test(name) ? 'image' : TEXT_EXT.test(name) ? 'text' : isDocumentName(name) ? 'document' : 'file';

/** The images among the attachments (top-level files only): what vision models get to see. */
export const attachedImages = (paths: string[]): string[] => paths.filter((p) => IMAGE_EXT.test(p) && !isDir(p));

// "photo.png, docs/" — for short mentions (history, logs).
export function attachmentNames(paths: string[] | undefined): string {
  return (paths || []).map((p) => `${path.basename(p)}${isDir(p) ? '/' : ''}`).join(', ');
}

interface Readable {
  label: string;
  abs: string;
  size: number;
  kind: 'text' | 'document';
}
interface Listed {
  lines: string[];
  readable: Readable[];
}

// Each attachment's line (folders with their first files), and the files whose text could go along, in order.
function listAttachments(paths: string[]): Listed {
  const lines: string[] = [];
  const readable: Readable[] = [];
  for (const p of paths) {
    if (isDir(p)) {
      const files = folderFiles(p);
      const total = files.reduce((n, f) => n + f.size, 0);
      lines.push(
        `- ${p.replace(/[\\/]+$/, '')}${path.sep} (folder, ${files.length}${files.length >= 2000 ? '+' : ''} file${files.length === 1 ? '' : 's'}, ${kb(total)})`,
      );
      for (const f of files.slice(0, 40)) lines.push(`    - ${f.rel} (${kb(f.size)})`);
      if (files.length > 40) lines.push(`    - …and ${files.length - 40} more`);
      for (const f of files) {
        const k = kindOf(f.rel);
        if (k === 'text' || k === 'document') readable.push({ label: f.rel, abs: f.abs, size: f.size, kind: k });
      }
    } else {
      let size = 0;
      try {
        size = fs.statSync(p).size;
      } catch {
        continue;
      }
      const k = kindOf(p);
      lines.push(
        `- ${p} (${k === 'file' || k === 'document' ? path.extname(p).slice(1).toUpperCase() || 'file' : k}, ${kb(size)})`,
      );
      if (k === 'text' || k === 'document') readable.push({ label: path.basename(p), abs: p, size, kind: k });
    }
  }
  return { lines, readable };
}

/** Documents read at most for one message (each can take a while). */
const DOCUMENTS_READ = 10;
/** How long reading one message's documents may take in all; the ones after are listed only. */
const DOCUMENTS_TIME_MS = 60_000;

interface DocumentBody {
  body: string;
  /** Nothing more is in the file than this text (or why it can't be read): a scan's pages are. */
  complete: boolean;
}

export interface AttachmentOptions {
  inline?: number;
  heading?: string;
  /** The tool that reads a document whose text is cut short or left out (the message says to use it). */
  rest?: string;
  /** Stops reading the documents (a run's Stop button). */
  signal?: AbortSignal;
}

// The text of the attached documents that fit in inline characters (after the text files before them): what it is,
// then its text, or why it can't be read. By path.
async function readDocuments(
  readable: Readable[],
  inline: number,
  signal?: AbortSignal,
): Promise<Map<string, DocumentBody>> {
  const out = new Map<string, DocumentBody>();
  const until = Date.now() + DOCUMENTS_TIME_MS;
  let left = inline;
  for (const r of readable) {
    signal?.throwIfAborted();
    if (left < 300 || out.size >= DOCUMENTS_READ || Date.now() > until - 1000) break;
    // (a text file goes along as renderAttachments sends it: under 2 MB, as much as is left)
    if (r.kind === 'text') {
      if (r.size <= 2_000_000) left -= Math.min(r.size, left);
      continue;
    }
    let entry: DocumentBody;
    try {
      const read = await readDocumentFile(r.abs, { signal, timeoutMs: until - Date.now() });
      if (!read) continue;
      const notes = read.notes.map((n) => `[${n}]`).join('\n');
      entry = {
        body: `(${documentAbout(read)})${notes ? `\n${notes}` : ''}\n${read.text.trim() || '(no text in it)'}`,
        complete: documentHasText(read),
      };
    } catch (e) {
      signal?.throwIfAborted();
      if (!(e instanceof DocumentError)) continue;
      entry = { body: `(can't be read: ${e.message})`, complete: e.lasting };
    }
    out.set(r.abs, entry);
    left -= Math.min(entry.body.length, left);
  }
  return out;
}

interface Rendered {
  text: string;
  /** The documents whose text went along whole, or why they can't be read: their bytes would add nothing. */
  whole: Set<string>;
}

function renderAttachments(
  { lines, readable }: Listed,
  { inline = 0, heading = 'Attached files', rest }: AttachmentOptions,
  documents?: ReadonlyMap<string, DocumentBody>,
): Rendered {
  const whole = new Set<string>();
  if (!lines.length) return { text: '', whole };
  let out = `[${heading}: saved in the project's Brain folder. Open them with your file tools when you need them.]\n${lines.join('\n')}`;
  let left = inline;
  // a document with text to read that isn't all here (cut short, or never read)
  let more = false;
  for (const t of readable) {
    const doc = t.kind === 'document' ? documents?.get(t.abs) : undefined;
    if (left < 300) {
      if (t.kind === 'document' && (!doc || doc.complete)) more = true;
      continue;
    }
    let body = '';
    if (t.kind === 'document') {
      if (!doc) {
        more = true;
        continue;
      }
      body = doc.body;
    } else {
      if (t.size > 2_000_000) continue;
      try {
        body = fs.readFileSync(t.abs, 'utf8');
      } catch {
        continue;
      }
      // binary that only looks like text
      if (body.includes('\u0000')) continue;
    }
    const part = body.slice(0, left);
    out += `\n\n--- ${t.label}${part.length < body.length ? ' (start)' : ''} ---\n${part}`;
    left -= part.length;
    if (doc && part.length === body.length && doc.complete) whole.add(t.abs);
    else if (doc && doc.complete) more = true;
  }
  if (more && rest && documents)
    out += `\n\n[A document's text that is cut short or not shown here: read it with ${rest} (its path is in the list above).]`;
  return { text: out, whole };
}

// The block added to a message: where each attached file or folder is, and (with inline > 0)
// the text of small text files, for models that can't open files themselves.
export function describeAttachments(paths: string[] | undefined, opts: AttachmentOptions = {}): string {
  if (!paths?.length) return '';
  return renderAttachments(listAttachments(paths), opts).text;
}

/** The same block, with the text of attached PDF, Word, Excel and PowerPoint files going along too (within inline). */
export async function describeAttachmentsRead(
  paths: string[] | undefined,
  opts: AttachmentOptions = {},
): Promise<string> {
  return (await readAttachments(paths, opts)).text;
}

/** The block with the documents' text, and which documents went along whole. */
export async function readAttachments(paths: string[] | undefined, opts: AttachmentOptions = {}): Promise<Rendered> {
  if (!paths?.length) return { text: '', whole: new Set() };
  const listed = listAttachments(paths);
  const documents = opts.inline ? await readDocuments(listed.readable, opts.inline, opts.signal) : undefined;
  return renderAttachments(listed, opts, documents);
}

// The text an agent gets: what you wrote plus where the attachments are.
export function withAttachments(text: string, paths: string[] | undefined, opts: { inline?: number } = {}): string {
  return joinNote(text, describeAttachments(paths, opts));
}

/** The same, with the attached documents' text going along (describeAttachmentsRead). */
export async function withAttachmentsRead(
  text: string,
  paths: string[] | undefined,
  opts: AttachmentOptions = {},
): Promise<string> {
  return joinNote(text, await describeAttachmentsRead(paths, opts));
}

/** The message and which documents went along whole (readAttachments). */
export async function withAttachmentsReadWhole(
  text: string,
  paths: string[] | undefined,
  opts: AttachmentOptions = {},
): Promise<Rendered> {
  const read = await readAttachments(paths, opts);
  return { text: joinNote(text, read.text), whole: read.whole };
}

const joinNote = (text: string, note: string) =>
  !note ? text : text.trim() ? `${text}\n\n${note}` : `Have a look at what I attached.\n\n${note}`;
