// Attaching files and folders: drop them on a chat (or the Brain on the map), or pick them with the
// paperclip. They upload straight away into the project's Brain folder (uploads/…), and the message
// then carries their paths. A tray shows each one as a chip with its progress.
import { h, mount, POST, DEL, toast } from './core.ts';
import { icon } from './icons.ts';
import type { UploadedFile } from '../shared/types.ts';

/** A file to upload. rel: its path inside a dropped folder ('docs/a.md'), or just its name. */
export interface PickedFile {
  file: File;
  rel: string;
}

/** One chip: a file, or a whole folder. */
interface Item {
  key: string;
  name: string;
  kind: 'file' | 'folder';
  picked: PickedFile[];
  bytes: number;
  sent: number;
  state: 'waiting' | 'uploading' | 'done' | 'error';
  error: string | null;
  /** Where it was saved (folders end with a separator), once uploaded. */
  path: string | null;
  preview: string | null;
  removed: boolean;
  xhrs: Set<XMLHttpRequest>;
  /** Settles once the item is uploaded, failed or taken back. */
  done: Promise<void>;
  settle: () => void;
}

export const MAX_FILES = 2000;
/** Files and folders one message can carry (the server takes no more). */
export const MAX_ATTACHMENTS = 50;
const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', '.next', '.cache']);
const SKIP_FILES = /^(\.DS_Store|Thumbs\.db|desktop\.ini)$/i;
const IMAGE = /\.(png|jpe?g|webp|gif)$/i;

export const hasFiles = (e: DragEvent): boolean => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
export const isFolderPath = (p: string): boolean => /[\\/]$/.test(p);
export const baseName = (p: string): string => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

// Everything in a drop, folders walked (minus .git, node_modules and OS clutter).
// The entries are taken before the first await: the browser empties the DataTransfer after the event.
export async function filesFromDrop(dt: DataTransfer): Promise<PickedFile[]> {
  const items = [...dt.items].filter((i) => i.kind === 'file');
  const entries = items.map((i) => (typeof i.webkitGetAsEntry === 'function' ? i.webkitGetAsEntry() : null));
  const loose = [...dt.files];
  const out: PickedFile[] = [];
  let capped = false;
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (out.length >= MAX_FILES) return void (capped = true);
    if (entry.isFile) {
      if (SKIP_FILES.test(entry.name)) return;
      const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej)).catch(() => null);
      if (file) out.push({ file, rel: prefix + entry.name });
    } else if (entry.isDirectory) {
      if (SKIP_DIRS.has(entry.name)) return;
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      // readEntries hands them out in chunks until it returns none
      for (;;) {
        const chunk = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej)).catch((): FileSystemEntry[] => []);
        if (!chunk.length) break;
        for (const e of chunk) await walk(e, `${prefix}${entry.name}/`);
      }
    }
  };
  if (!entries.some(Boolean)) return loose.filter((f) => !SKIP_FILES.test(f.name)).map((file) => ({ file, rel: file.name }));
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e) await walk(e, '');
    else if (loose[i]) out.push({ file: loose[i], rel: loose[i].name });
  }
  if (capped) toast(`Only the first ${MAX_FILES} files were taken.`, 'warn');
  return out;
}

// From an <input type=file> (a folder picker gives each file's path inside the folder).
export function filesFromInput(list: FileList | null): PickedFile[] {
  return [...(list || [])].filter((f) => !SKIP_FILES.test(f.name)).map((file) => ({ file, rel: file.webkitRelativePath || file.name }));
}

// One file to POST /api/uploads/<batch>, raw, with progress (fetch can't report upload progress).
function sendFile(batch: string, p: PickedFile, onProgress: (sent: number) => void, track: Set<XMLHttpRequest>): Promise<UploadedFile> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    track.add(xhr);
    xhr.open('POST', `/api/uploads/${encodeURIComponent(batch)}?path=${encodeURIComponent(p.rel)}`);
    xhr.setRequestHeader('x-dash', '1');
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      track.delete(xhr);
      let data: (UploadedFile & { error?: string }) | null = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* not JSON */
      }
      if (xhr.status >= 200 && xhr.status < 300 && data) resolve(data);
      else reject(new Error(data?.error || `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => (track.delete(xhr), reject(new Error('Upload failed: the dashboard could not be reached.')));
    xhr.onabort = () => (track.delete(xhr), reject(new Error('Cancelled')));
    xhr.send(p.file);
  });
}

// At most a few uploads at once, across every chip and tray on the page.
const MAX_PARALLEL = 4;
let active = 0;
const queue: (() => void)[] = [];
async function limited<T>(job: () => Promise<T>): Promise<T> {
  if (active >= MAX_PARALLEL) await new Promise<void>((go) => queue.push(go));
  active++;
  try {
    return await job();
  } finally {
    active--;
    queue.shift()?.();
  }
}

// What was dropped, as chips: loose files one each, a folder as one chip.
function group(picked: PickedFile[]): Item[] {
  const byTop = new Map<string, PickedFile[]>();
  for (const p of picked) {
    const parts = p.rel.split('/');
    const key = parts.length > 1 ? `${parts[0]}/` : p.rel;
    byTop.set(key, [...(byTop.get(key) || []), p]);
  }
  return [...byTop].map(([key, files]) => {
    const folder = key.endsWith('/');
    return withDone({
      key: `${key}:${Math.random().toString(36).slice(2)}`,
      name: folder ? key.slice(0, -1) : key,
      kind: folder ? 'folder' : 'file',
      picked: files,
      bytes: files.reduce((n, f) => n + f.file.size, 0),
      sent: 0,
      state: 'waiting',
      error: null,
      path: null,
      preview: !folder && IMAGE.test(key) && files[0].file.size < 20_000_000 ? URL.createObjectURL(files[0].file) : null,
      removed: false,
      xhrs: new Set(),
    });
  });
}

// A fresh 'done' promise for an item (new, or tried again).
function withDone<T extends Omit<Item, 'done' | 'settle'>>(it: T): Item {
  let settle!: () => void;
  const done = new Promise<void>((r) => (settle = r));
  return Object.assign(it, { done, settle });
}

// One chip's files into the batch. The first failure stops the rest, and nothing is reported
// until every request already going has finished.
async function uploadItem(it: Item, batch: string, redraw: () => void): Promise<void> {
  const sentBy = new Map<PickedFile, number>();
  let failure: Error | null = null;
  await Promise.all(
    it.picked.map((p) =>
      limited(async () => {
        if (it.removed || failure) return;
        try {
          const saved = await sendFile(batch, p, (n) => {
            sentBy.set(p, n);
            it.sent = [...sentBy.values()].reduce((a, b) => a + b, 0);
            redraw();
          }, it.xhrs);
          sentBy.set(p, p.file.size);
          it.path ||= saved.top;
        } catch (e) {
          failure ||= e as Error;
        }
      }),
    ),
  );
  if (failure) throw failure;
}

// Upload items into one new batch folder; each item ends 'done' (with its path) or 'error'.
// They are marked 'uploading' straight away, so a second call never picks them up again.
async function uploadItems(items: Item[], redraw: () => void): Promise<void> {
  if (!items.length) return;
  for (const it of items) it.state = 'uploading';
  redraw();
  let batch: string;
  try {
    batch = (await POST<{ batch: string }>('/uploads')).batch;
  } catch (e) {
    for (const it of items) Object.assign(it, { state: 'error', error: (e as Error).message });
    items.forEach((it) => it.settle());
    return redraw();
  }
  await Promise.all(
    items.map(async (it) => {
      try {
        await uploadItem(it, batch, redraw);
        if (!it.removed) it.state = 'done';
      } catch (e) {
        if (!it.removed) Object.assign(it, { state: 'error', error: (e as Error).message });
      }
      // taken back while it was uploading: remove what did arrive
      if (it.removed && it.path) DEL(`/uploads?path=${encodeURIComponent(it.path)}`).catch(() => {});
      it.settle();
      redraw();
    }),
  );
}

export interface AttachTray {
  /** The chips (hidden while empty). */
  el: HTMLDivElement;
  /** The paperclip, with a small Files / Folder menu. */
  picker: HTMLSpanElement;
  add: (picked: PickedFile[]) => void;
  /** Make an element take dropped files; returns a function that stops it. */
  dropZone: (el: HTMLElement, label?: string) => () => void;
  count: () => number;
  busy: () => boolean;
  /** Paths once every upload is done, including files added meanwhile; null (with a message) if one failed.
   *  Failed ones are tried again on each call. Deferred trays upload now. */
  ready: () => Promise<string[] | null>;
  /** Take the uploaded chips out (after sending); put() brings them back if sending failed. */
  take: () => Item[];
  put: (items: Item[]) => void;
  clear: () => void;
  /** Throw everything away, uploaded files included (a dialog closed without saving). */
  discard: () => void;
}

// deferred: hold the files and upload only when ready() is called (a new project: its folder doesn't exist yet).
export function attachTray({ deferred = false, onChange }: { deferred?: boolean; onChange?: () => void } = {}): AttachTray {
  let items: Item[] = [];
  const el = h('div.att-tray.hidden');
  const fileIn = h('input', { type: 'file', multiple: true, hidden: true });
  const dirIn = h('input', { type: 'file', multiple: true, hidden: true, webkitdirectory: true });
  const menu = h('div.att-menu.hidden');
  const closeMenu = () => {
    menu.classList.add('hidden');
    document.removeEventListener('pointerdown', outside, true);
  };
  const outside = (e: PointerEvent) => !picker.contains(e.target as Node) && closeMenu();
  const btn = h('button.btn.ghost.small.att-btn', {
    type: 'button',
    title: 'Attach files or a folder (or drop them here)',
    'aria-label': 'Attach files',
    onclick: () => {
      const open = menu.classList.toggle('hidden') === false;
      if (open) document.addEventListener('pointerdown', outside, true);
      else closeMenu();
    },
  }, icon('paperclip', 15));
  mount(
    menu,
    h('button.att-menu-item', { type: 'button', onclick: () => (closeMenu(), fileIn.click()) }, icon('file', 14), 'Files…'),
    h('button.att-menu-item', { type: 'button', onclick: () => (closeMenu(), dirIn.click()) }, icon('folder-up', 14), 'A folder…'),
  );
  const picker = h('span.att-picker', btn, menu, fileIn, dirIn);
  fileIn.addEventListener('change', () => (add(filesFromInput(fileIn.files)), (fileIn.value = '')));
  dirIn.addEventListener('change', () => (add(filesFromInput(dirIn.files)), (dirIn.value = '')));

  let frame = false;
  const draw = () => {
    if (frame) return;
    frame = true;
    requestAnimationFrame(() => {
      frame = false;
      el.classList.toggle('hidden', !items.length);
      mount(el, items.map(chip));
    });
    onChange?.();
  };
  const chip = (it: Item) => {
    const pct = it.bytes ? Math.min(100, Math.round((it.sent / it.bytes) * 100)) : 100;
    const meta = it.state === 'error' ? it.error : it.state === 'uploading' ? `${pct}%` : it.kind === 'folder' ? `${it.picked.length} file${it.picked.length === 1 ? '' : 's'} · ${size(it.bytes)}` : size(it.bytes);
    return h(
      `div.att-chip.${it.state}`,
      { title: it.state === 'error' ? it.error || '' : it.path || it.name },
      it.preview ? h('img.att-thumb', { src: it.preview, alt: '' }) : h('span.att-ico', icon(it.kind === 'folder' ? 'folder' : 'file', 14)),
      h('span.att-name', it.name),
      h('span.att-meta', meta),
      it.state === 'uploading' ? h('span.att-bar', { style: { '--p': `${pct}%` } }) : null,
      h('button.att-x', { type: 'button', title: 'Remove', 'aria-label': `Remove ${it.name}`, onclick: () => remove(it) }, icon('x', 12)),
    );
  };
  const forget = (p: string) => DEL(`/uploads?path=${encodeURIComponent(p)}`).catch(() => {});
  const remove = (it: Item) => {
    it.removed = true;
    for (const x of it.xhrs) x.abort();
    // what arrived (a folder that failed halfway too); one still uploading cleans up when it stops
    if (it.state !== 'uploading' && it.path) forget(it.path);
    if (it.preview) URL.revokeObjectURL(it.preview);
    items = items.filter((x) => x !== it);
    draw();
  };
  const add = (picked: PickedFile[]) => {
    if (!picked.length) return;
    let fresh = group(picked);
    const room = MAX_ATTACHMENTS - items.length;
    if (fresh.length > room) {
      toast(`A message can carry ${MAX_ATTACHMENTS} files or folders. ${room > 0 ? `Only the first ${room} were added; put` : 'Put'} the rest in a folder and attach that instead.`, 'warn', 7000);
      for (const it of fresh.slice(Math.max(0, room))) if (it.preview) URL.revokeObjectURL(it.preview);
      fresh = fresh.slice(0, Math.max(0, room));
      if (!fresh.length) return;
    }
    items = [...items, ...fresh];
    draw();
    if (!deferred) void uploadItems(fresh, draw);
  };
  // a failed chip gets another go: its partial upload goes, it starts over in a new batch
  const retry = (it: Item) => {
    if (it.path) forget(it.path);
    withDone(Object.assign(it, { state: 'waiting', error: null, path: null, sent: 0 }));
  };
  const ready = async (): Promise<string[] | null> => {
    items.filter((it) => it.state === 'error').forEach(retry);
    // until nothing is left to upload: files added while waiting are included too
    for (;;) {
      void uploadItems(items.filter((it) => it.state === 'waiting'), draw);
      const pending = items.filter((it) => it.state === 'uploading');
      if (!pending.length) break;
      await Promise.all(pending.map((it) => it.done));
    }
    const failed = items.filter((it) => it.state === 'error');
    if (failed.length) {
      toast(`${failed.map((f) => f.name).join(', ')} didn't upload: ${failed[0].error}. Remove ${failed.length === 1 ? 'it' : 'them'} or attach again.`, 'error', 7000);
      return null;
    }
    return items.map((it) => it.path).filter((p): p is string => !!p);
  };

  const dropZone = (zone: HTMLElement, label = 'Drop files or folders to attach') => {
    let overlay: HTMLDivElement | null = null;
    // the overlay needs a positioned zone; put back what was there once it goes
    let oldPosition: string | null = null;
    const show = (on: boolean) => {
      zone.classList.toggle('att-over', on);
      if (on && !overlay) {
        if (getComputedStyle(zone).position === 'static') {
          oldPosition = zone.style.position;
          zone.style.position = 'relative';
        }
        overlay = h('div.att-drop', icon('upload', 22), h('span', label));
        zone.append(overlay);
      } else if (!on && overlay) {
        overlay.remove();
        overlay = null;
        if (oldPosition !== null) zone.style.position = oldPosition;
        oldPosition = null;
      }
    };
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer!.dropEffect = 'copy';
      show(true);
    };
    const leave = (e: DragEvent) => {
      if (!zone.contains(e.relatedTarget as Node | null)) show(false);
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      show(false);
      void filesFromDrop(e.dataTransfer!).then(add);
    };
    zone.addEventListener('dragenter', over);
    zone.addEventListener('dragover', over);
    zone.addEventListener('dragleave', leave);
    zone.addEventListener('drop', drop);
    return () => {
      show(false);
      zone.removeEventListener('dragenter', over);
      zone.removeEventListener('dragover', over);
      zone.removeEventListener('dragleave', leave);
      zone.removeEventListener('drop', drop);
    };
  };

  return {
    el,
    picker,
    add,
    dropZone,
    count: () => items.length,
    busy: () => items.some((it) => it.state === 'uploading' || (!deferred && it.state === 'waiting')),
    ready,
    take: () => {
      const out = items.filter((it) => it.state === 'done');
      items = items.filter((it) => it.state !== 'done');
      draw();
      return out;
    },
    put: (back) => {
      items = [...back, ...items];
      draw();
    },
    clear: () => {
      for (const it of items) if (it.preview) URL.revokeObjectURL(it.preview);
      items = [];
      draw();
    },
    discard: () => [...items].forEach(remove),
  };
}

// A message that didn't go: put its text back without losing what was typed since.
export function restoreDraft(input: HTMLTextAreaElement, text: string): void {
  if (!text) return;
  const now = input.value.trim();
  input.value = !now ? text : now.startsWith(text) ? input.value : `${text}\n${input.value}`;
}

// The files a sent message carries, as chips (images as thumbnails). Files open in a new tab.
export function attachmentChips(paths: readonly string[] | undefined | null): HTMLDivElement | null {
  if (!paths?.length) return null;
  return h(
    'div.att-sent',
    paths.map((p) => {
      const name = baseName(p);
      const url = `/api/file?path=${encodeURIComponent(p)}`;
      if (isFolderPath(p)) return h('span.att-chip.sent', { title: p }, h('span.att-ico', icon('folder', 13)), h('span.att-name', `${name}/`));
      if (IMAGE.test(p)) return h('a.att-img', { href: url, target: '_blank', rel: 'noopener', title: p }, h('img', { src: url, alt: name, loading: 'lazy' }));
      return h('a.att-chip.sent', { href: url, target: '_blank', rel: 'noopener', title: p }, h('span.att-ico', icon('file', 13)), h('span.att-name', name));
    }),
  );
}

// Dropping files anywhere that doesn't take them must not open them in the tab (and lose the dashboard).
export function guardPageDrops(): void {
  document.addEventListener('dragover', (e) => {
    if (!hasFiles(e) || e.defaultPrevented) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'none';
  });
  document.addEventListener('drop', (e) => {
    if (hasFiles(e) && !e.defaultPrevented) e.preventDefault();
  });
}
