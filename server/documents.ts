// The text of PDF, Word, Excel and PowerPoint files, for agents: read_file and read_document answer with it, and
// attached documents go along as text to models that can't open files. Each kind is read within limits that keep a
// hostile file from costing much:
// - PDF through pdf.js (unpdf's serverless build, which never runs code from a font), page by page, in a thread of
//   its own that is stopped when it runs too long (server/pdfworker.ts). A scanned PDF has no text to give.
// - Word, Excel and PowerPoint (2007 on) are ZIP packages of XML: only the parts that hold text are unpacked, each and
//   all of them capped, and their text is read with patterns (no XML parser, so no entities are expanded).
// - Older Office files (.doc, .xls, .ppt) can't be read.
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { unzipSync } from 'fflate';
import { ROOT } from './util.ts';
import { log } from './store.ts';
import { pageText, sizeText } from './filetools.ts';
import type { PageOptions } from './filetools.ts';

export type DocumentKind = 'pdf' | 'word' | 'excel' | 'powerpoint' | 'old-office';

/** The most a document may weigh to be read. */
export const DOCUMENT_MAX_BYTES = 50 * 1024 * 1024;
/** Pages of a PDF read at most. */
const PDF_MAX_PAGES = 300;
/** How long a PDF may take to read; its thread is stopped then. */
const PDF_TIMEOUT_MS = 30_000;
/** The memory a PDF's thread may use (Node keeps to it; Bun has no such limit). */
const PDF_MAX_HEAP_MB = 512;
/** The most one unpacked part of an Office file may weigh. */
const PART_MAX_BYTES = 20_000_000;
/** The most all the unpacked parts of one file may weigh together. */
export const UNPACKED_MAX_BYTES = 60_000_000;
/** Parts of one file unpacked at most (a workbook's sheets or a deck's slides, and a few more). */
export const PARTS_MAX = 260;
/** Rows of a sheet read at most. */
const SHEET_MAX_ROWS = 2_000;
/** Excel's last column, XFD, as a zero-based index. */
export const EXCEL_LAST_COLUMN = 16_383;
/** Characters of a workbook's text built at most, across its sheets. */
const WORKBOOK_TEXT_MAX = 5_000_000;

/** A document that can't be read, said plainly. lasting: reading it again won't change that (so it is remembered). */
export class DocumentError extends Error {
  readonly lasting: boolean;
  constructor(message: string, { lasting = true }: { lasting?: boolean } = {}) {
    super(message);
    this.lasting = lasting;
  }
}

export interface ReadOptions {
  /** Stops the read (a run's Stop button). */
  signal?: AbortSignal;
  /** How long a PDF may take, at most PDF_TIMEOUT_MS. */
  timeoutMs?: number;
}

export interface DocumentRead {
  kind: DocumentKind;
  text: string;
  /** Anything the reader should know: pages or rows left out, a scan with no text. */
  notes: string[];
  /** PDF: pages in it and pages read. */
  pages?: { total: number; read: number };
  /** Excel: its sheets. */
  sheets?: string[];
  /** PowerPoint: how many slides. */
  slides?: number;
}

// ---------- telling what a file is ----------

const DOCUMENT_NAME = /\.(pdf|docx|docm|xlsx|xlsm|pptx|pptm|doc|xls|ppt)$/i;
const OLD_OFFICE_NAME = /\.(doc|dot|xls|xlt|ppt|pot)$/i;
/** Whether a name says it is a document (for a label: what it is comes from its bytes). */
export const isDocumentName = (name: string): boolean => DOCUMENT_NAME.test(name);

const ascii = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0));
const PDF = ascii('%PDF-');
const ZIP = [0x50, 0x4b, 0x03, 0x04];
const COMPOUND = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

function startsWith(bytes: Uint8Array, values: ArrayLike<number>, at = 0): boolean {
  for (let i = 0; i < values.length; i++) if (bytes[at + i] !== values[i]) return false;
  return true;
}

/** Whether `needle` occurs in `bytes` (a part's name in a ZIP). */
function contains(bytes: Uint8Array, needle: Uint8Array): boolean {
  const first = needle[0]!;
  for (
    let at = bytes.indexOf(first);
    at !== -1 && at + needle.length <= bytes.length;
    at = bytes.indexOf(first, at + 1)
  ) {
    if (startsWith(bytes, needle, at)) return true;
  }
  return false;
}

// A PDF starts with its header. pdf.js also finds one after up to 1024 bytes of junk, but a text file that only
// mentions "%PDF-" is no PDF: that leeway is for files named .pdf.
const PDF_NAME = /\.pdf$/i;
const pdfHeader = (bytes: Uint8Array, name: string) => {
  if (startsWith(bytes, PDF)) return true;
  if (!PDF_NAME.test(name)) return false;
  const head = bytes.subarray(0, 1024);
  for (let at = head.indexOf(PDF[0]!); at !== -1; at = head.indexOf(PDF[0]!, at + 1))
    if (startsWith(head, PDF, at)) return true;
  return false;
};

/** The names of a ZIP package's parts, from its list (nothing is unpacked), or null when it can't be listed. */
function packageParts(bytes: Uint8Array): Set<string> | null {
  const names = new Set<string>();
  try {
    unzipSync(bytes, {
      filter: (file) => {
        names.add(file.name);
        return false;
      },
    });
  } catch {
    return null;
  }
  return names;
}

/**
 * What kind of document the bytes are, or null for anything else. Office files (2007 on) are ZIP packages, told
 * apart by the part each must hold; older ones are compound files, which other programs use too, so for those the
 * name has to agree.
 */
export function documentKind(bytes: Uint8Array, name: string): DocumentKind | null {
  if (!bytes.length) return null;
  if (pdfHeader(bytes, name)) return 'pdf';
  if (startsWith(bytes, ZIP)) {
    // by the package's own parts (its file list), not a name found anywhere in its bytes: a workbook with a Word
    // file inside it is still a workbook
    const names = packageParts(bytes);
    if (!names) {
      if (!contains(bytes, ascii('[Content_Types].xml'))) return null;
      if (contains(bytes, ascii('word/document.xml'))) return 'word';
      if (contains(bytes, ascii('xl/workbook.xml'))) return 'excel';
      if (contains(bytes, ascii('ppt/presentation.xml'))) return 'powerpoint';
      return null;
    }
    if (!names.has('[Content_Types].xml')) return null;
    if (names.has('word/document.xml')) return 'word';
    if (names.has('xl/workbook.xml')) return 'excel';
    if (names.has('ppt/presentation.xml')) return 'powerpoint';
    return null;
  }
  if (startsWith(bytes, COMPOUND) && OLD_OFFICE_NAME.test(name)) return 'old-office';
  return null;
}

// Could the file be a document, from its first bytes (so a text file or a picture is never read whole for this)?
function mayBeDocument(real: string): boolean {
  const head = Buffer.alloc(1024);
  let fd: number | undefined;
  try {
    fd = fs.openSync(real, 'r');
    const n = fs.readSync(fd, head, 0, head.length, 0);
    const start = head.subarray(0, n);
    return pdfHeader(start, path.basename(real)) || startsWith(start, ZIP) || startsWith(start, COMPOUND);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// ---------- reading a file ----------

// The last few documents read, by path, size and time changed: reading a long one in parts reads it once.
const CACHE_CHARS = 20_000_000;
const cache = new Map<string, DocumentRead>();
// and the ones that couldn't be read, so a locked or hostile file doesn't cost its wait again on every message
const FAILED_MAX = 200;
const failed = new Map<string, string>();
function rememberFailure(key: string, message: string): void {
  failed.delete(key);
  failed.set(key, message);
  for (const k of failed.keys()) {
    if (failed.size <= FAILED_MAX) break;
    failed.delete(k);
  }
}
function remember(key: string, read: DocumentRead): void {
  cache.delete(key);
  cache.set(key, read);
  let chars = 0;
  for (const r of cache.values()) chars += r.text.length;
  for (const [k, r] of cache) {
    if (chars <= CACHE_CHARS || cache.size === 1) break;
    cache.delete(k);
    chars -= r.text.length;
  }
}

/** A document file's text, or null when the file isn't a document. Throws a DocumentError for one that can't be read. */
export async function readDocumentFile(real: string, opts: ReadOptions = {}): Promise<DocumentRead | null> {
  const st = fs.statSync(real);
  if (!st.isFile()) return null;
  const key = `${real}\u0000${st.size}\u0000${st.mtimeMs}`;
  const known = cache.get(key);
  if (known) {
    remember(key, known);
    return known;
  }
  const failure = failed.get(key);
  if (failure !== undefined) throw new DocumentError(failure);
  if (!mayBeDocument(real)) return null;
  if (st.size > DOCUMENT_MAX_BYTES) {
    if (!isDocumentName(real)) return null;
    throw new DocumentError(
      `It is ${sizeText(st.size)}: documents are read up to ${DOCUMENT_MAX_BYTES / 1024 / 1024} MB.`,
    );
  }
  const bytes = fs.readFileSync(real);
  const kind = documentKind(bytes, path.basename(real));
  if (!kind) return null;
  let read: DocumentRead;
  try {
    read = await documentText(kind, bytes, opts);
  } catch (e) {
    if (e instanceof DocumentError && e.lasting) rememberFailure(key, e.message);
    throw e;
  }
  remember(key, read);
  return read;
}

/** Whether a read document has any text (a scanned PDF has only its page marks). */
export const documentHasText = (read: DocumentRead): boolean =>
  !!(read.kind === 'pdf' ? read.text.replace(/--- Page \d+ ---/g, '') : read.text).trim();

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** "PDF, 12 pages", "Excel workbook, sheets: Q1, Q2": what a read document is, in a few words. */
export function documentAbout(read: DocumentRead): string {
  switch (read.kind) {
    case 'pdf':
      return `PDF, ${plural(read.pages?.total ?? 0, 'page')}`;
    case 'word':
      return 'Word document';
    case 'excel':
      return `Excel workbook, ${read.sheets?.length === 1 ? 'sheet' : 'sheets'}: ${(read.sheets || []).join(', ') || '(none)'}`;
    case 'powerpoint':
      return `PowerPoint, ${plural(read.slides ?? 0, 'slide')}`;
    case 'old-office':
      return 'older Office file';
  }
}

/**
 * What read_file and read_document answer for a document: what it is and anything to know, then its text from line
 * offset (the same parts a text file comes in). Null when the file isn't a document.
 */
export async function readDocumentPart(
  real: string,
  shown: string,
  opts: PageOptions & ReadOptions = {},
): Promise<string | null> {
  let read: DocumentRead | null;
  try {
    read = await readDocumentFile(real, opts);
  } catch (e) {
    if (e instanceof DocumentError) throw new Error(`${shown} can't be read: ${e.message}`);
    throw e;
  }
  if (!read) return null;
  const notes = read.notes.map((n) => `[${n}]`).join('\n');
  const body = read.text.trim() ? pageText(read.text, opts) : '(no text in it)';
  return `[${shown}: ${documentAbout(read)}]${notes ? `\n${notes}` : ''}\n\n${body}`;
}

// ---------- the text of each kind ----------

/** The text of a document's bytes, whole. */
export async function documentText(
  kind: DocumentKind,
  bytes: Uint8Array,
  opts: ReadOptions = {},
): Promise<DocumentRead> {
  switch (kind) {
    case 'pdf': {
      const read = await pdfText(bytes, opts);
      const notes: string[] = [];
      if (read.read < read.total) notes.push(`Only the first ${read.read} of ${read.total} pages were read.`);
      const done: DocumentRead = { kind, text: read.text, notes, pages: { total: read.total, read: read.read } };
      if (!documentHasText(done)) notes.push("No text in it: it's probably a scan or pictures of pages.");
      return done;
    }
    case 'word':
      return { kind, text: wordText(bytes), notes: [] };
    case 'excel': {
      const read = excelText(bytes);
      return { kind, text: read.text, notes: read.notes, sheets: read.sheets };
    }
    case 'powerpoint': {
      const read = powerpointText(bytes);
      return { kind, text: read.text, notes: [], slides: read.slides };
    }
    case 'old-office':
      throw new DocumentError(
        'older Office files (.doc, .xls, .ppt) have no text to give here. Save it as .docx, .xlsx, .pptx or PDF.',
      );
  }
}

// ---------- PDF ----------

// The desktop app runs the server bundled, and the worker as a file of its own next to it (scripts/build-desktop.ts).
const PDF_WORKER = ((js) => (fs.existsSync(js) ? js : path.join(ROOT, 'server', 'pdfworker.ts')))(
  path.join(ROOT, 'server', 'pdfworker.js'),
);

type PdfRead = { text: string; total: number; read: number };
type PdfAnswer = PdfRead | { error: 'password' | 'unreadable' };

// PDF threads going at once, across every run: each may hold a copy of its file and up to PDF_MAX_HEAP_MB.
const PDF_THREADS = 2;
let threads = 0;
const waiting = new Set<() => void>();

async function threadSlot(signal?: AbortSignal): Promise<() => void> {
  while (threads >= PDF_THREADS) {
    signal?.throwIfAborted();
    await new Promise<void>((resolve) => {
      const wake = () => {
        waiting.delete(wake);
        signal?.removeEventListener('abort', wake);
        resolve();
      };
      waiting.add(wake);
      signal?.addEventListener('abort', wake, { once: true });
    });
  }
  signal?.throwIfAborted();
  threads += 1;
  let freed = false;
  return () => {
    if (freed) return;
    freed = true;
    threads -= 1;
    // every waiter looks again (one that was stopped meanwhile just leaves)
    for (const wake of [...waiting]) wake();
  };
}

// The thread failing (it couldn't start, or crashed) is the reader's fault, not the file's: said so, and logged.
function readerFailed(cause: unknown): DocumentError {
  if (cause && typeof cause === 'object' && 'code' in cause && cause.code === 'ERR_WORKER_OUT_OF_MEMORY')
    return new DocumentError('it needs too much memory to read.');
  log(
    'error',
    `The PDF reader stopped working (${PDF_WORKER}): ${cause instanceof Error ? cause.message : String(cause)}`,
  );
  return new DocumentError(
    "the PDF reader didn't work, so it couldn't be read. Try again; if it keeps happening, restart the dashboard.",
    { lasting: false },
  );
}

/** A PDF's text page by page, read in a thread that is stopped after timeoutMs, or when signal is. */
export async function pdfText(
  bytes: Uint8Array,
  { timeoutMs = PDF_TIMEOUT_MS, signal }: ReadOptions = {},
): Promise<PdfRead> {
  // the time waiting for a thread counts too: a caller's budget is for the whole read
  const started = Date.now();
  const budget = Math.min(timeoutMs, PDF_TIMEOUT_MS);
  const queued = AbortSignal.timeout(budget);
  const free = await threadSlot(signal ? AbortSignal.any([signal, queued]) : queued).catch((e: unknown) => {
    if (!signal?.aborted && queued.aborted) throw new DocumentError('it took too long to read.', { lasting: false });
    throw e;
  });
  let worker: Worker;
  try {
    worker = new Worker(PDF_WORKER, {
      // (handing it over copies it once: the caller keeps its own)
      workerData: { bytes, maxPages: PDF_MAX_PAGES },
      // a decompression bomb runs the thread out of memory, not the server
      resourceLimits: { maxOldGenerationSizeMb: PDF_MAX_HEAP_MB },
    });
  } catch (e) {
    free();
    throw readerFailed(e);
  }
  const limit = Math.max(1, budget - (Date.now() - started));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const answer = await new Promise<PdfAnswer>((resolve, reject) => {
      // only the first outcome counts: stopping the thread afterwards makes it exit, which is no failure
      let settled = false;
      const end = (settle: () => void) => {
        if (settled) return;
        settled = true;
        settle();
      };
      // (cut short by a caller's budget, it may read in full another time)
      timer = setTimeout(
        () => end(() => reject(new DocumentError('it took too long to read.', { lasting: limit >= PDF_TIMEOUT_MS }))),
        limit,
      );
      onAbort = () => end(() => reject(signal?.reason ?? new Error('Stopped.')));
      if (signal?.aborted) onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });
      worker.once('message', (message: PdfAnswer) => end(() => resolve(message)));
      worker.once('error', (error) => end(() => reject(readerFailed(error))));
      worker.once('exit', (code) =>
        end(() => reject(readerFailed(new Error(`it ended (code ${code}) without an answer`)))),
      );
    });
    if ('error' in answer)
      throw new DocumentError(
        answer.error === 'password' ? 'it is password protected.' : "it isn't a PDF that can be read.",
      );
    return answer;
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
    // whatever happened, the thread is done with: stop it if it still runs
    void worker.terminate().finally(free);
  }
}

// ---------- Word, Excel and PowerPoint ----------

/**
 * The parts of a package `wanted` picks, each within PART_MAX_BYTES unpacked, all within UNPACKED_MAX_BYTES and
 * PARTS_MAX. fflate unpacks a deflated part into a buffer of its header's size, but copies a stored one whole, whatever
 * its header says: so a part counts as the larger of the two, and the parts it gave back are counted again.
 */
function unpack(bytes: Uint8Array, wanted: (name: string) => boolean): Map<string, string> {
  let files: Record<string, Uint8Array>;
  let total = 0;
  let count = 0;
  const tooLarge = () => new DocumentError('it is too large inside to read.');
  try {
    files = unzipSync(bytes, {
      filter: (file) => {
        if (!wanted(file.name)) return false;
        const size = Math.max(file.originalSize, file.size);
        total += size;
        count += 1;
        if (size > PART_MAX_BYTES || total > UNPACKED_MAX_BYTES) throw tooLarge();
        if (count > PARTS_MAX) throw new DocumentError('it has too many parts to read.');
        return true;
      },
    });
  } catch (e) {
    if (e instanceof DocumentError) throw e;
    throw new DocumentError("it couldn't be unpacked.");
  }
  const decoder = new TextDecoder();
  const parts = new Map<string, string>();
  let unpacked = 0;
  for (const [name, data] of Object.entries(files)) {
    // a header can understate the size; the unpacked bytes can't
    unpacked += data.length;
    if (data.length > PART_MAX_BYTES || unpacked > UNPACKED_MAX_BYTES) throw tooLarge();
    parts.set(name, decoder.decode(data));
  }
  return parts;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

const safeChar = (code: number, fallback: string) =>
  Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : fallback;

/** XML text with its five entities and character references decoded; nothing else is. */
export function xmlText(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (whole, name: string) => {
    if (name.startsWith('#x')) return safeChar(parseInt(name.slice(2), 16), whole);
    if (name.startsWith('#')) return safeChar(parseInt(name.slice(1), 10), whole);
    return ENTITIES[name] ?? whole;
  });
}

/**
 * Word or PowerPoint XML as text: paragraphs as lines, a table's row on one line with its cells split by " | ". `ns`
 * is w (Word) or a (slides). A cell's own paragraphs (every cell ends with one) are joined by spaces.
 */
function runsAsLines(xml: string, ns: 'w' | 'a'): string {
  const token = new RegExp(
    `<${ns}:t(?:\\s[^>]*)?>([^<]*)</${ns}:t>|<${ns}:tab/>|<${ns}:br(?:\\s[^>]*)?/>|<${ns}:tc(?:\\s[^>]*)?>|</${ns}:p>|</${ns}:tc>|</${ns}:tr>`,
    'g',
  );
  // the text outside any cell, then one entry per cell open around this point (a table can sit in a cell)
  const open: string[] = [''];
  const add = (text: string) => {
    open[open.length - 1] += text;
  };
  for (const [tag, text] of xml.matchAll(token)) {
    const inCell = open.length > 1;
    if (text !== undefined) add(xmlText(text));
    else if (tag.startsWith(`<${ns}:tab`)) add(inCell ? ' ' : '\t');
    else if (tag.startsWith(`<${ns}:br`) || tag === `</${ns}:p>`) add(inCell ? ' ' : '\n');
    else if (tag === `</${ns}:tr>`) add(inCell ? ' ' : '\n');
    else if (tag === `</${ns}:tc>`) {
      if (!inCell) continue;
      const cell = open
        .pop()!
        .replace(/\s+/g, ' ')
        .replace(/(?: \|)+$/, '')
        .trim();
      add(`${cell} | `);
    } else open.push('');
  }
  // (cells never closed: their text still counts)
  while (open.length > 1) {
    const cell = open.pop()!;
    add(cell);
  }
  return open[0]!
    .replace(/ \| \n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** A Word document's text: paragraphs as lines, table cells split by " | ". */
export function wordText(bytes: Uint8Array): string {
  const xml = unpack(bytes, (name) => name === 'word/document.xml').get('word/document.xml');
  if (xml === undefined) throw new DocumentError('it has no document in it.');
  return runsAsLines(xml, 'w');
}

/** Where each relationship of a part points: id → part name, from the folder the part is in. */
function relationTargets(rels: string, folder: string): Map<string, string> {
  const targets = new Map<string, string>();
  for (const [rel] of rels.matchAll(/<(?:\w+:)?Relationship\b[^>]*>/g)) {
    const id = /\bId="([^"]+)"/.exec(rel)?.[1];
    const raw = /\bTarget="([^"]+)"/.exec(rel)?.[1];
    if (!id || !raw) continue;
    // a part's address, as a package names it: %-encoded, and relative (./, ../) to the folder, or from the root (/)
    let target = raw;
    try {
      target = decodeURIComponent(raw);
    } catch {
      /* not encoded */
    }
    const from = target.startsWith('/')
      ? target.slice(1)
      : target.startsWith(`${folder}/`)
        ? target
        : `${folder}/${target}`;
    targets.set(id, path.posix.normalize(from).replace(/^(\.\.\/)+/, ''));
  }
  return targets;
}

/** "B" → 1: a column's index from its letters; past XFD, refused. */
function columnIndex(letters: string): number {
  let index = 0;
  for (const char of letters) {
    index = index * 26 + (char.charCodeAt(0) - 64);
    // checked as it grows, so a long run of letters never makes a huge number
    if (index - 1 > EXCEL_LAST_COLUMN) throw new DocumentError("it has a cell past Excel's last column.");
  }
  return index - 1;
}

// SpreadsheetML's elements may carry a prefix (<x:row>, <x:c>), as files written with the Open XML SDK have them.
/** Every <t>'s text in a fragment, run after run (a rich-text string's pieces). */
const runsText = (fragment: string) =>
  [...fragment.matchAll(/<(?:\w+:)?t(?:\s[^>]*)?>([^<]*)<\/(?:\w+:)?t>/g)].map((m) => xmlText(m[1]!)).join('');

/**
 * An Excel workbook's text: each sheet under its name, a row per line, cells split by tabs. Values are what Excel
 * stored: a formula's last result, a date as its serial number.
 */
export function excelText(bytes: Uint8Array): { text: string; sheets: string[]; notes: string[] } {
  const parts = unpack(
    bytes,
    (name) =>
      name === 'xl/workbook.xml' ||
      name === 'xl/_rels/workbook.xml.rels' ||
      name === 'xl/sharedStrings.xml' ||
      /^xl\/worksheets\/[^/]+\.xml$/.test(name),
  );
  const workbook = parts.get('xl/workbook.xml');
  if (workbook === undefined) throw new DocumentError('it has no workbook in it.');
  const targets = relationTargets(parts.get('xl/_rels/workbook.xml.rels') ?? '', 'xl');
  const shared = [...(parts.get('xl/sharedStrings.xml') ?? '').matchAll(/<(?:\w+:)?si>([\s\S]*?)<\/(?:\w+:)?si>/g)].map(
    (m) => runsText(m[1]!),
  );
  const sheets: string[] = [];
  const notes: string[] = [];
  const out: string[] = [];
  let length = 0;
  let cut = false;
  for (const [sheet] of workbook.matchAll(/<(?:\w+:)?sheet\b[^>]*>/g)) {
    const name = xmlText(/\bname="([^"]*)"/.exec(sheet)?.[1] ?? 'Sheet');
    // (the relationships' prefix is usually r, but any will do)
    const relId = /\s\w+:id="([^"]+)"/.exec(sheet)?.[1];
    const xml = relId ? parts.get(targets.get(relId) ?? '') : undefined;
    sheets.push(name);
    if (xml === undefined || cut) continue;
    const rows: string[] = [];
    // rows with something in them: what the limit counts, and what the note says were left out
    let total = 0;
    // an empty row closes itself; matched first, so it can't swallow the next
    for (const row of xml.matchAll(/<(?:\w+:)?row\b[^>]*\/>|<(?:\w+:)?row\b[^>]*>([\s\S]*?)<\/(?:\w+:)?row>/g)) {
      if (cut) break;
      const cells: string[] = [];
      for (const cell of (row[1] ?? '').matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
        const attributes = cell[1]!;
        const body = cell[2] ?? '';
        const ref = /\br="([A-Z]+)\d+"/.exec(attributes)?.[1];
        const type = /\bt="([^"]+)"/.exec(attributes)?.[1];
        const raw = /<(?:\w+:)?v>([^<]*)<\/(?:\w+:)?v>/.exec(body)?.[1];
        let value = '';
        if (type === 's') value = shared[Number(raw)] ?? '';
        else if (type === 'inlineStr') value = runsText(body);
        else if (type === 'b') value = raw === '1' ? 'TRUE' : raw === '0' ? 'FALSE' : '';
        else if (raw !== undefined) value = xmlText(raw);
        const at = ref ? columnIndex(ref) : cells.length;
        while (cells.length < at) cells.push('');
        cells[at] = value.replace(/[\t\n\r]+/g, ' ');
      }
      while (cells.length && !cells.at(-1)) cells.pop();
      if (!cells.length) continue;
      total += 1;
      if (rows.length >= SHEET_MAX_ROWS) continue;
      const line = cells.join('\t');
      length += line.length + 1;
      if (length > WORKBOOK_TEXT_MAX) {
        cut = true;
        notes.push(`The workbook's text stops in sheet “${name}”, after ${WORKBOOK_TEXT_MAX} characters.`);
        break;
      }
      rows.push(line);
    }
    if (total > SHEET_MAX_ROWS)
      notes.push(
        `Sheet “${name}”: only the first ${SHEET_MAX_ROWS} of ${total} rows with something in them were read.`,
      );
    out.push(`--- Sheet: ${name} ---\n${rows.join('\n')}`);
  }
  notes.push("Cells hold what Excel stored: a formula's last result, and a date as a serial number.");
  return { text: out.join('\n\n'), sheets, notes };
}

/** A PowerPoint deck's text, slide by slide in the deck's order. */
export function powerpointText(bytes: Uint8Array): { text: string; slides: number } {
  const parts = unpack(
    bytes,
    (name) =>
      name === 'ppt/presentation.xml' ||
      name === 'ppt/_rels/presentation.xml.rels' ||
      /^ppt\/slides\/[^/]+\.xml$/.test(name),
  );
  const deck = parts.get('ppt/presentation.xml');
  if (deck === undefined) throw new DocumentError('it has no presentation in it.');
  const targets = relationTargets(parts.get('ppt/_rels/presentation.xml.rels') ?? '', 'ppt');
  const order = [...deck.matchAll(/<p:sldId\b[^>]*\br:id="([^"]+)"/g)]
    .map((m) => targets.get(m[1]!))
    .filter((name): name is string => !!name && parts.has(name));
  // (a deck whose list can't be followed: its slides by number)
  const names = order.length
    ? order
    : [...parts.keys()]
        .filter((n) => n.startsWith('ppt/slides/'))
        .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)?.[1] ?? 0) - Number(/(\d+)\.xml$/.exec(b)?.[1] ?? 0));
  const text = names.map((name, i) => `--- Slide ${i + 1} ---\n${runsAsLines(parts.get(name)!, 'a')}`).join('\n\n');
  return { text, slides: names.length };
}
