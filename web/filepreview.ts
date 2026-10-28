// Previews of the files a chat mentions: images and videos shown, audio playable, 3D models you can turn, other files and folders
// as a card, each with a "Show in Explorer / Finder" button below. Only files the dashboard may show
// (inside the project's folders, see server/files.ts) get one; anything else is left as plain text.
import { h, mount, POST, attempt, lightbox, toast } from './core.ts';
import { icon } from './icons.ts';
import { isMac } from './shortcuts.ts';
import { findFileMentions } from './mentions.ts';
import { modelViewer } from './modelviewer.ts';
import { fileUrl, pdfViewUrl } from './client/connection.ts';
import { fetchFile } from './client/http.ts';
import { showMarkdownDialog } from './ui/bigmarkdown.tsx';

/** POST /api/files/info, one entry per path. */
export type FileInfo = { path: string; ok: false } | { path: string; ok: true; kind: 'image' | 'video' | 'audio' | 'model' | 'file' | 'folder'; name: string; size: number; modified: number };

const isWindows = (): boolean => /win/i.test((navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform || navigator.platform || '');
/** What the button says on this computer. */
export const revealLabel = (): string => (isWindows() ? 'Show in Explorer' : isMac() ? 'Show in Finder' : 'Show in folder');
/** What this computer's file manager is called ("Open notes in Finder"). */
export const fileManager = (): string => (isWindows() ? 'Explorer' : isMac() ? 'Finder' : 'the file manager');

// ---------- looking files up: one request for everything asked for in the same moment ----------
const known = new Map<string, { at: number; info: Promise<FileInfo> }>();
let queue: { path: string; resolve: (i: FileInfo) => void }[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
// a file that isn't there may be written in a moment: ask again after a while
const MISSING_FOR = 15_000;

function flush(): void {
  timer = null;
  const batch = queue.splice(0, 50);
  if (queue.length) timer = setTimeout(flush, 0);
  POST<FileInfo[]>('/files/info', { paths: batch.map((q) => q.path) })
    .then((list) => batch.forEach((q, i) => q.resolve(list[i] ?? { path: q.path, ok: false })))
    .catch(() => batch.forEach((q) => q.resolve({ path: q.path, ok: false })));
}

export function lookupFiles(paths: readonly string[]): Promise<FileInfo[]> {
  return Promise.all(
    paths.map((path) => {
      const hit = known.get(path);
      if (hit) return hit.info.then((info) => (info.ok || Date.now() - hit.at < MISSING_FOR ? info : (known.delete(path), lookupFiles([path]).then((l) => l[0]))));
      const info = new Promise<FileInfo>((resolve) => {
        queue.push({ path, resolve });
        timer ??= setTimeout(flush, 20);
      });
      known.set(path, { at: Date.now(), info });
      return info;
    }),
  );
}

/** Forget what was looked up (tests; and after files changed). */
export const forgetFiles = (): void => known.clear();

// ---------- drawing ----------
const size = (n: number): string => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${Math.round(n / 1e3)} KB` : `${n} B`);

/** An image that opens big when clicked, or with Enter / Space (a button to the keyboard and screen readers). */
export function zoomable<E extends HTMLElement>(el: E, src: string, name: string): E {
  el.setAttribute('role', 'button');
  el.tabIndex = 0;
  el.setAttribute('aria-label', `Show ${name} bigger`);
  el.addEventListener('click', () => lightbox(src, name));
  el.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    lightbox(src, name);
  });
  return el;
}

// ---------- previews of attached files: pictures big, Markdown read in a dialog, PDFs in a new tab ----------
export type PreviewKind = 'image' | 'markdown' | 'pdf';
/** What a click on a file with this name can show, or null when it can only be downloaded. */
export function previewKind(name: string): PreviewKind | null {
  if (/\.(png|jpe?g|webp|gif)$/i.test(name)) return 'image';
  if (/\.(md|markdown)$/i.test(name)) return 'markdown';
  if (/\.pdf$/i.test(name)) return 'pdf';
  return null;
}

/** Markdown, read in a dialog (web/ui/bigmarkdown.tsx). */
export const showMarkdown = showMarkdownDialog;

/** Past this a Markdown file isn't read in the page: holding all of it would take more memory than a tab has. */
export const MAX_MARKDOWN_BYTES = 200 * 1024 * 1024;
/** Says so (and returns true) when a Markdown file is too big to read here. */
export function markdownTooBig(name: string, bytes: number): boolean {
  if (bytes <= MAX_MARKDOWN_BYTES) return false;
  toast(`${name} is too big to read here (${Math.round(bytes / 1024 / 1024)} MB). Open it in another app.`, 'error');
  return true;
}

/** A Markdown file the server has, read in a dialog. */
export async function previewMarkdown(path: string, name: string): Promise<void> {
  try {
    const res = await fetchFile(fileUrl(path));
    if (markdownTooBig(name, Number(res.headers.get('content-length') || 0))) return void res.body?.cancel();
    showMarkdown(name, await res.text());
  } catch {
    toast(`${name} couldn’t be opened.`, 'error');
  }
}

/** A PDF opened in a new browser tab (in the desktop app, the default browser). */
export const openPdf = (path: string): void => void window.open(pdfViewUrl(path), '_blank', 'noopener');

/** Show a file the server has the way previewKind says. */
export function previewFile(path: string, name: string): void {
  const kind = previewKind(name);
  if (kind === 'image') lightbox(fileUrl(path), name);
  else if (kind === 'markdown') void previewMarkdown(path, name);
  else if (kind === 'pdf') openPdf(path);
}

export function revealButton(path: string): HTMLButtonElement {
  return h('button.btn.tiny.ghost.fp-reveal', { class: 'flex-none gap-1.25', type: 'button', title: path, onclick: () => attempt(() => POST('/files/reveal', { path })) }, icon('folder-open', 13), revealLabel());
}

// compact: the floating window, the Station panel, team turns (full width, shorter)
function card(f: Extract<FileInfo, { ok: true }>, compact: boolean): HTMLElement {
  const url = fileUrl(f.path);
  const media = `block w-full bg-black object-contain ${compact ? 'max-h-50' : 'max-h-80'}`;
  const fileBox = `flex items-center gap-2.5 text-ink ${compact ? 'px-3 py-2.5' : 'px-3.5 py-4'}`;
  const preview =
    f.kind === 'image'
      ? zoomable(h('img', { class: `${media} cursor-zoom-in`, src: url, alt: f.name, loading: 'lazy' }), url, f.name)
      : f.kind === 'video'
        ? h('video', { class: media, src: url, controls: true, preload: 'metadata', playsinline: true })
        : f.kind === 'audio'
          ? h('audio', { class: 'mx-2.5 mt-3 mb-2 block w-[calc(100%-20px)]', src: url, controls: true, preload: 'metadata' })
          : f.kind === 'model'
            ? modelViewer(url, f.name, f.size)
            : fileCard(f, fileBox);
  // a card that opens bigger when clicked says so when the mouse is over it
  const opens = f.kind === 'image' || (f.kind === 'file' && previewKind(f.name) !== null);
  return h(
    `div.fp-card.fp-kind-${f.kind}`,
    { class: `${compact ? 'flex w-full flex-col overflow-hidden rounded-[10px] border border-line bg-panel-2 [&_.fp-model]:max-h-60' : 'flex w-[min(380px,100%)] flex-col overflow-hidden rounded-[10px] border border-line bg-panel-2'}${opens ? ' transition-colors hover:border-accent-dim' : ''}`, title: f.path },
    preview,
    h(
      'div.fp-bar',
      { class: 'flex min-w-0 items-center gap-2 border-t border-line py-1.5 pr-2 pl-3 font-mono text-[11.5px] leading-[normal] text-dim' },
      h('span.fp-name', { class: 'min-w-0 truncate' }, f.name),
      f.kind !== 'folder' && f.size ? h('span.fp-size', { class: 'whitespace-nowrap text-faint' }, size(f.size)) : null,
      h('span', { class: 'min-w-0 flex-1' }),
      revealButton(f.path),
    ),
  );
}

// A file without a picture of its own: Markdown opens to read, a PDF in a new tab, the rest download.
function fileCard(f: Extract<FileInfo, { ok: true }>, fileBox: string): HTMLElement {
  const label = h('span', { class: 'min-w-0 truncate text-[13.5px]' }, f.kind === 'folder' ? `${f.name}/` : f.name);
  if (f.kind === 'folder') return h('div.fp-file', { class: fileBox }, icon('folder', 22), label);
  const kind = previewKind(f.name);
  if (kind === 'markdown')
    return h('button.fp-file', { class: `${fileBox} w-full cursor-pointer border-0 bg-transparent text-left hover:bg-panel hover:text-accent`, type: 'button', title: `Read ${f.name}`, onclick: () => void previewMarkdown(f.path, f.name) }, icon('file-text', 22), label);
  if (kind === 'pdf')
    return h('a.fp-file', { class: `${fileBox} hover:bg-panel hover:text-accent`, href: pdfViewUrl(f.path), target: '_blank', rel: 'noopener', title: `Open ${f.name} in a new tab` }, icon('file-text', 22), label, h('span', { class: 'ml-auto flex-none text-faint' }, icon('external-link', 14)));
  return h('a.fp-file', { class: `${fileBox} hover:text-accent`, href: fileUrl(f.path), target: '_blank', rel: 'noopener', title: `Download ${f.name}` }, icon('file-text', 22), label);
}

/** Previews for these paths. Returns its box right away (empty and hidden until the files are looked
 *  up; it stays hidden when none of them may be shown). */
export function filePreviews(paths: readonly string[], { compact = false }: { compact?: boolean } = {}): HTMLDivElement {
  const box = h('div.hidden', { class: compact ? 'flex w-full max-w-[860px] flex-wrap gap-1.5' : 'flex w-full max-w-[860px] flex-wrap gap-2.5' });
  const list = [...new Set(paths)].filter(Boolean);
  if (!list.length) return box;
  lookupFiles(list).then((infos) => {
    const ok = infos.filter((i): i is Extract<FileInfo, { ok: true }> => i.ok);
    if (!ok.length) return;
    mount(box, ok.map((f) => card(f, compact)));
    box.classList.remove('hidden');
  });
  return box;
}

// Views that redraw on every streamed word get the same box back for the same message (by key), so
// its images and videos don't load again each time. A box that found nothing to show is looked up again
// after a while (the file may have been written since).
const boxes = new Map<string, { box: HTMLDivElement; at: number }>();

/** Previews for the files a message's text mentions (and the files sent with it). key: the message,
 *  scoped to its view ("team:<id>", "dock:<id>": a box can only be in one place), so a redraw gets the
 *  same box back. null when it mentions none. */
export function mentionPreviews(text: string | null | undefined, attachments: readonly string[] = [], { compact = false, key }: { compact?: boolean; key?: string } = {}): HTMLDivElement | null {
  const paths = [...new Set([...attachments, ...findFileMentions(text)])];
  if (!paths.length) return null;
  if (!key) return filePreviews(paths, { compact });
  const id = `${key}\n${compact}\n${paths.join('\n')}`;
  const hit = boxes.get(id);
  if (hit && !(hit.box.classList.contains('hidden') && Date.now() - hit.at > MISSING_FOR)) return hit.box;
  const box = filePreviews(paths, { compact });
  boxes.set(id, { box, at: Date.now() });
  // (the oldest go once there are many)
  if (boxes.size > 300) boxes.delete(boxes.keys().next().value!);
  return box;
}
