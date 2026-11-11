import fs from 'node:fs';
import { readJSON, writeJSON } from '../util.ts';

interface Stamp {
  mtimeMs: number;
  size: number;
  ino: number;
}
interface Entry<S> {
  stamp: Stamp;
  summary: S;
}

export interface RecordFilesOptions<T, S> {
  /** The small part every listing needs; kept for every file seen. */
  summarize(value: T): S;
  /** Throws when a record read from disk must not be used. It is then not kept. */
  check?(value: T, file: string): void;
  /** Whole records are kept up to about this many bytes of file, least recently used first out. */
  maxBytes: number;
  /** Told when a file's summary appears, changes or goes away, to keep an index. */
  changed?(file: string, summary: S | null): void;
  /** Told each time a file is read from disk. */
  readFromDisk?(): void;
}

const statOf = (file: string): fs.Stats | null => {
  try {
    const stat = fs.lstatSync(file);
    return stat.isFile() ? stat : null;
  } catch {
    return null;
  }
};
const same = (stamp: Stamp, stat: fs.Stats) =>
  stamp.mtimeMs === stat.mtimeMs && stamp.size === stat.size && stamp.ino === stat.ino;

function freeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value)) freeze(item);
  return value;
}

/**
 * Parsed private records, checked against each file's stat (mtime, size, inode) before use, so a change
 * made outside this module is read again. Writes made here update the cache directly. Records handed out
 * are frozen: a caller can't change what the next caller gets.
 */
export class RecordFiles<T extends object, S> {
  private readonly entries = new Map<string, Entry<S>>();
  /** Whole records in least-recently-used order, with the file size each one counts for. */
  private readonly values = new Map<string, { value: T; size: number }>();
  private bytes = 0;
  private readonly options: RecordFilesOptions<T, S>;

  constructor(options: RecordFilesOptions<T, S>) {
    this.options = options;
  }

  read(file: string): T | null {
    const stat = statOf(file);
    if (!stat) {
      this.forget(file);
      return null;
    }
    const entry = this.entries.get(file);
    const kept = this.values.get(file);
    if (entry && kept && same(entry.stamp, stat)) {
      this.values.delete(file);
      this.values.set(file, kept);
      return kept.value;
    }
    this.options.readFromDisk?.();
    const value = readJSON<T>(file, null);
    if (value === null || typeof value !== 'object') {
      this.forget(file);
      return null;
    }
    try {
      this.options.check?.(value, file);
    } catch (error) {
      this.forget(file);
      throw error;
    }
    return this.keep(file, stat, freeze(value));
  }

  /** The summary of a file, read from disk only when the file changed or was never seen. */
  summary(file: string): S | null {
    const stat = statOf(file);
    const entry = this.entries.get(file);
    if (stat && entry && same(entry.stamp, stat)) return entry.summary;
    return this.read(file) ? (this.entries.get(file)?.summary ?? null) : null;
  }

  write(file: string, value: T): T {
    writeJSON(file, value);
    const stat = statOf(file);
    // The copy is what a fresh read would give, so a caller keeps its own object to change.
    if (stat) this.keep(file, stat, freeze(JSON.parse(JSON.stringify(value)) as T));
    else this.forget(file);
    return value;
  }

  remove(file: string): void {
    try {
      fs.rmSync(file, { force: true });
    } finally {
      this.forget(file);
    }
  }

  forget(file: string): void {
    this.drop(file);
    if (this.entries.delete(file)) this.options.changed?.(file, null);
  }

  private keep(file: string, stat: fs.Stats, value: T): T {
    this.drop(file);
    const summary = freeze(this.options.summarize(value));
    this.entries.set(file, { stamp: { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino }, summary });
    if (stat.size <= this.options.maxBytes) {
      this.values.set(file, { value, size: stat.size });
      this.bytes += stat.size;
      for (const [other, kept] of this.values) {
        if (this.bytes <= this.options.maxBytes) break;
        if (other === file) continue;
        this.values.delete(other);
        this.bytes -= kept.size;
      }
    }
    this.options.changed?.(file, summary);
    return value;
  }

  private drop(file: string): void {
    const kept = this.values.get(file);
    if (!kept) return;
    this.values.delete(file);
    this.bytes -= kept.size;
  }
}
