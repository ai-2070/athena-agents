// Previews of the files a chat mentions: images and videos shown, audio playable, 3D models you can turn, other files and folders
// as a card, each with a "Show in Explorer / Finder" button below (and in the desktop app an Open button:
// the file in its own program). Only files the dashboard may show
// (inside the project's folders, see server/files.ts) get one; anything else is left as plain text.
// React now: the boxes are drawn with createRoot into the detached element the caller gets (as schedule.tsx does).
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createAppRoot } from './ui/root.tsx';
import { attempt, lightbox, toast, state } from './core.ts';
import { domButton } from './ui/dom.ts';
import { icon } from './icons.ts';
import { isMac } from './shortcuts.ts';
import { findFileMentions } from './mentions.ts';
import { modelViewer } from './modelviewer.ts';
import { fileUrl, pdfViewUrl, filesAt } from './client/connection.ts';
import { rpcAt } from './client/rpc.ts';
import { fetchFile } from './client/http.ts';
import { showMarkdownDialog } from './ui/bigmarkdown.tsx';
import { Plate } from './ui/surface.tsx';
import { DomNode, Icon } from './ui/react.tsx';

/** POST /api/files/info, one entry per path. */
export type { FileInfo } from '../shared/types.ts';
import type { FileInfo } from '../shared/types.ts';
type OkFile = Extract<FileInfo, { ok: true }>;

const isWindows = (): boolean => /win/i.test((navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform || navigator.platform || '');
/** What the button says on this computer. */
export const revealLabel = (): string => (isWindows() ? 'Show in Explorer' : isMac() ? 'Show in Finder' : 'Show in folder');
/** What this computer's file manager is called ("Open notes in Finder"). */
export const fileManager = (): string => (isWindows() ? 'Explorer' : isMac() ? 'Finder' : 'the file manager');

/** The desktop app: files open with their own programs instead of downloading or opening a browser tab. */
export const onDesktop = (): boolean => !!state.data?.desktop;

/** Opens the file with its default program (desktop app). Programs and scripts are refused by the server.
 *  project: whose chat shows it, when that project may not be open (see filesAt). */
export const openFile = (path: string, project?: string): void => void attempt(() => rpcAt(filesAt(path, project)).files.open({ path }));

// ---------- looking files up: one request for everything asked for in the same moment ----------
const known = new Map<string, { at: number; info: Promise<FileInfo> }>();
let queue: { path: string; at: string; resolve: (i: FileInfo) => void }[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
// a file that isn't there may be written in a moment: ask again after a while
const MISSING_FOR = 15_000;

function flush(): void {
  timer = null;
  const batch = queue.splice(0, 50);
  if (queue.length) timer = setTimeout(flush, 0);
  // (each project's files are looked up in that project)
  const byProject = new Map<string, typeof batch>();
  for (const q of batch) byProject.set(q.at, [...(byProject.get(q.at) || []), q]);
  for (const [at, part] of byProject)
    rpcAt(at).files.info({ paths: part.map((q) => q.path) })
      .then((list) => part.forEach((q, i) => q.resolve(list[i] ?? { path: q.path, ok: false })))
      .catch(() => part.forEach((q) => q.resolve({ path: q.path, ok: false })));
}

/** project: whose chat mentions them, when that project may not be open (see filesAt). */
export function lookupFiles(paths: readonly string[], project?: string): Promise<FileInfo[]> {
  return Promise.all(
    paths.map((path) => {
      const at = filesAt(path, project);
      const id = `${at}\n${path}`;
      const hit = known.get(id);
      if (hit) return hit.info.then((info) => (info.ok || Date.now() - hit.at < MISSING_FOR ? info : (known.delete(id), lookupFiles([path], project).then((l) => l[0]))));
      const info = new Promise<FileInfo>((resolve) => {
        queue.push({ path, at, resolve });
        timer ??= setTimeout(flush, 20);
      });
      known.set(id, { at: Date.now(), info });
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
export async function previewMarkdown(path: string, name: string, project?: string): Promise<void> {
  try {
    const res = await fetchFile(fileUrl(path, project));
    if (markdownTooBig(name, Number(res.headers.get('content-length') || 0))) return void res.body?.cancel();
    showMarkdown(name, await res.text());
  } catch {
    toast(`${name} couldn’t be opened.`, 'error');
  }
}

/** A PDF opened in a new browser tab (in the desktop app, the default browser). */
export const openPdf = (path: string, project?: string): void => void window.open(pdfViewUrl(path, project), '_blank', 'noopener');

/** Show a file the server has the way previewKind says. In the desktop app a PDF, or a file the page
 *  can't show, opens in its own program. */
export function previewFile(path: string, name: string, project?: string): void {
  const kind = previewKind(name);
  if (kind === 'image') lightbox(fileUrl(path, project), name);
  else if (kind === 'markdown') void previewMarkdown(path, name, project);
  else if (onDesktop()) openFile(path, project);
  else if (kind === 'pdf') openPdf(path, project);
}

/** What a click on this file does, for its title. null: nothing (a file the browser can only download). */
export function previewTitle(name: string): string | null {
  const kind = previewKind(name);
  return kind === 'image' ? `Show ${name} bigger` : kind === 'markdown' ? `Read ${name}` : onDesktop() ? `Open ${name}` : kind === 'pdf' ? `Open ${name} in a new tab` : null;
}

/** Open, in the desktop app: the file in its own program. */
export function openButton(path: string, name: string, project?: string): HTMLButtonElement {
  return domButton({ variant: 'ghost', size: 'tiny', class: 'fp-open flex-none gap-1.25', type: 'button', title: `Open ${name}`, onclick: () => openFile(path, project) }, icon('external-link', 13), 'Open');
}

export function revealButton(path: string, project?: string): HTMLButtonElement {
  return domButton({ variant: 'ghost', size: 'tiny', class: 'fp-reveal flex-none gap-1.25', type: 'button', title: path, onclick: () => attempt(() => rpcAt(filesAt(path, project)).files.reveal({ path })) }, icon('folder-open', 13), revealLabel());
}

/** An image the box owns that opens big (zoomable adds the button role, focus and keys to it). */
function ZoomImage({ src, name, className }: { src: string; name: string; className: string }) {
  const ref = useRef<HTMLImageElement>(null);
  useLayoutEffect(() => {
    if (ref.current) zoomable(ref.current, src, name);
  }, [src, name]);
  return <img ref={ref} className={className} src={src} alt={name} loading="lazy" />;
}

// compact: the floating window, the Station panel, team turns (full width, shorter)
function Card({ f, compact, project }: { f: OkFile; compact: boolean; project?: string }) {
  const url = fileUrl(f.path, project);
  const media = `block w-full bg-panel-2 object-contain ${compact ? 'max-h-50' : 'max-h-80'}`;
  const fileBox = `flex items-center gap-2.5 text-ink ${compact ? 'px-3 py-2.5' : 'px-3.5 py-4'}`;
  const preview =
    f.kind === 'image' ? (
      <ZoomImage src={url} name={f.name} className={`${media} cursor-zoom-in`} />
    ) : f.kind === 'video' ? (
      <video className={media} src={url} controls preload="metadata" playsInline />
    ) : f.kind === 'audio' ? (
      <audio className="mx-2.5 mt-3 mb-2 block w-[calc(100%-20px)]" src={url} controls preload="metadata" />
    ) : f.kind === 'model' ? (
      <DomNode make={() => modelViewer(url, f.name, f.size)} deps={[url]} />
    ) : (
      <FileCard f={f} fileBox={fileBox} project={project} />
    );
  // a card that opens bigger when clicked says so when the mouse is over it
  const opens = f.kind === 'image' || (f.kind === 'file' && (onDesktop() || previewKind(f.name) !== null));
  return (
    <Plate
      className={`fp-card fp-kind-${f.kind} ${compact ? 'flex w-full flex-col overflow-hidden rounded-box [&_.fp-model]:max-h-60' : 'flex w-[min(380px,100%)] flex-col overflow-hidden rounded-box'}${opens ? ' transition-colors hover:border-line-2' : ''}`}
      title={f.path}
    >
      {preview}
      <div className="fp-bar flex min-w-0 items-center gap-2 border-t border-line py-1.5 pr-2 pl-3 font-mono text-[11.5px] leading-[normal] text-dim">
        <span className="fp-name min-w-0 truncate">{f.name}</span>
        {f.kind !== 'folder' && f.size ? <span className="fp-size whitespace-nowrap text-faint">{size(f.size)}</span> : null}
        <span className="min-w-0 flex-1" />
        {onDesktop() && f.kind !== 'folder' ? <DomNode as="span" className="contents" make={() => openButton(f.path, f.name, project)} deps={[f.path, project]} /> : null}
        <DomNode as="span" className="contents" make={() => revealButton(f.path, project)} deps={[f.path, project]} />
      </div>
    </Plate>
  );
}

// A file without a picture of its own: Markdown opens to read, a PDF in a new tab, the rest download.
// In the desktop app a PDF and the rest open in their own programs.
function FileCard({ f, fileBox, project }: { f: OkFile; fileBox: string; project?: string }) {
  const label = <span className="min-w-0 truncate text-[13.5px]">{f.kind === 'folder' ? `${f.name}/` : f.name}</span>;
  if (f.kind === 'folder')
    return (
      <div className={`fp-file ${fileBox}`}>
        <Icon name="folder" size={22} />
        {label}
      </div>
    );
  const kind = previewKind(f.name);
  if (kind === 'markdown')
    return (
      <button type="button" className={`fp-file ${fileBox} w-full cursor-pointer border-0 bg-transparent text-left hover:bg-panel hover:text-accent`} title={`Read ${f.name}`} onClick={() => void previewMarkdown(f.path, f.name, project)}>
        <Icon name="file-text" size={22} />
        {label}
      </button>
    );
  if (onDesktop())
    return (
      <button type="button" className={`fp-file ${fileBox} w-full cursor-pointer border-0 bg-transparent text-left hover:bg-panel hover:text-accent`} title={`Open ${f.name}`} onClick={() => openFile(f.path, project)}>
        <Icon name="file-text" size={22} />
        {label}
        <span className="ml-auto flex-none text-faint">
          <Icon name="external-link" size={14} />
        </span>
      </button>
    );
  if (kind === 'pdf')
    return (
      <a className={`fp-file ${fileBox} hover:bg-panel hover:text-accent`} href={pdfViewUrl(f.path, project)} target="_blank" rel="noopener" title={`Open ${f.name} in a new tab`}>
        <Icon name="file-text" size={22} />
        {label}
        <span className="ml-auto flex-none text-faint">
          <Icon name="external-link" size={14} />
        </span>
      </a>
    );
  return (
    <a className={`fp-file ${fileBox} hover:text-accent`} href={fileUrl(f.path, project)} target="_blank" rel="noopener" title={`Download ${f.name}`}>
      <Icon name="file-text" size={22} />
      {label}
    </a>
  );
}

// Looks the files up and draws a card for each one the dashboard may show (nothing until then).
function Previews({ paths, compact, project, onReady }: { paths: readonly string[]; compact: boolean; project?: string; onReady: () => void }) {
  const [files, setFiles] = useState<OkFile[]>([]);
  useEffect(() => {
    let live = true;
    lookupFiles(paths, project).then((infos) => {
      if (!live) return;
      const ok = infos.filter((i): i is OkFile => i.ok);
      if (!ok.length) return;
      setFiles(ok);
      onReady();
    });
    return () => {
      live = false;
    };
    // paths is fixed for this box and onReady only shows it, so neither needs a dependency
  }, [paths, compact, project]);
  return (
    <>
      {files.map((f) => (
        <Card key={f.path} f={f} compact={compact} project={project} />
      ))}
    </>
  );
}

/** Previews for these paths. Returns its box right away (empty and hidden until the files are looked
 *  up; it stays hidden when none of them may be shown). project: whose chat mentions them (see filesAt). */
export function filePreviews(paths: readonly string[], { compact = false, project }: { compact?: boolean; project?: string } = {}): HTMLDivElement {
  const box = document.createElement('div');
  box.className = `hidden ${compact ? 'flex w-full max-w-[860px] flex-wrap gap-1.5' : 'flex w-full max-w-[860px] flex-wrap gap-2.5'}`;
  const list = [...new Set(paths)].filter(Boolean);
  if (!list.length) return box;
  createAppRoot(box).render(<Previews paths={list} compact={compact} project={project} onReady={() => box.classList.remove('hidden')} />);
  return box;
}

// Views that redraw on every streamed word get the same box back for the same message (by key), so
// its images and videos don't load again each time. A box that found nothing to show is looked up again
// after a while (the file may have been written since).
const boxes = new Map<string, { box: HTMLDivElement; at: number }>();

/** Previews for the files a message's text mentions (and the files sent with it). key: the message,
 *  scoped to its view ("team:<id>", "dock:<id>": a box can only be in one place), so a redraw gets the
 *  same box back. null when it mentions none. */
export function mentionPreviews(text: string | null | undefined, attachments: readonly string[] = [], { compact = false, key, project }: { compact?: boolean; key?: string; project?: string } = {}): HTMLDivElement | null {
  const paths = [...new Set([...attachments, ...findFileMentions(text)])];
  if (!paths.length) return null;
  if (!key) return filePreviews(paths, { compact, project });
  const id = `${key}\n${compact}\n${project || ''}\n${paths.join('\n')}`;
  const hit = boxes.get(id);
  if (hit && !(hit.box.classList.contains('hidden') && Date.now() - hit.at > MISSING_FOR)) return hit.box;
  const box = filePreviews(paths, { compact, project });
  boxes.set(id, { box, at: Date.now() });
  // (the oldest go once there are many)
  if (boxes.size > 300) boxes.delete(boxes.keys().next().value!);
  return box;
}
