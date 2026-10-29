// Pictures of things in a folder: a folder, a page marked by its kind of file (Phosphor Light, in the icon grey), and the
// Visual Studio Code mark drawn as a line, to sit with them. (The pixel-art set these replaced is in git: e6b108a.)
import { FileAudioIcon } from '@phosphor-icons/react/dist/csr/FileAudio';
import { FileCodeIcon } from '@phosphor-icons/react/dist/csr/FileCode';
import { FileCssIcon } from '@phosphor-icons/react/dist/csr/FileCss';
import { FileCsvIcon } from '@phosphor-icons/react/dist/csr/FileCsv';
import { FileDocIcon } from '@phosphor-icons/react/dist/csr/FileDoc';
import { FileHtmlIcon } from '@phosphor-icons/react/dist/csr/FileHtml';
import { FileIcon as PlainFileIcon } from '@phosphor-icons/react/dist/csr/File';
import { FileImageIcon } from '@phosphor-icons/react/dist/csr/FileImage';
import { FileIniIcon } from '@phosphor-icons/react/dist/csr/FileIni';
import { FileJpgIcon } from '@phosphor-icons/react/dist/csr/FileJpg';
import { FileJsIcon } from '@phosphor-icons/react/dist/csr/FileJs';
import { FileJsxIcon } from '@phosphor-icons/react/dist/csr/FileJsx';
import { FileMdIcon } from '@phosphor-icons/react/dist/csr/FileMd';
import { FilePdfIcon } from '@phosphor-icons/react/dist/csr/FilePdf';
import { FilePngIcon } from '@phosphor-icons/react/dist/csr/FilePng';
import { FilePyIcon } from '@phosphor-icons/react/dist/csr/FilePy';
import { FileRsIcon } from '@phosphor-icons/react/dist/csr/FileRs';
import { FileSvgIcon } from '@phosphor-icons/react/dist/csr/FileSvg';
import { FileTsIcon } from '@phosphor-icons/react/dist/csr/FileTs';
import { FileTsxIcon } from '@phosphor-icons/react/dist/csr/FileTsx';
import { FileTxtIcon } from '@phosphor-icons/react/dist/csr/FileTxt';
import { FileVideoIcon } from '@phosphor-icons/react/dist/csr/FileVideo';
import { FileZipIcon } from '@phosphor-icons/react/dist/csr/FileZip';
import { FolderIcon as PhosphorFolder } from '@phosphor-icons/react/dist/csr/Folder';
import type { Icon as PhosphorIcon } from '@phosphor-icons/react';

const BY_EXT: Record<string, PhosphorIcon> = {
  md: FileMdIcon, markdown: FileMdIcon, txt: FileTxtIcon, pdf: FilePdfIcon, doc: FileDocIcon, docx: FileDocIcon, csv: FileCsvIcon, ini: FileIniIcon,
  json: FileCodeIcon, yaml: FileCodeIcon, yml: FileCodeIcon, toml: FileCodeIcon, xml: FileCodeIcon, sh: FileCodeIcon, ps1: FileCodeIcon, go: FileCodeIcon,
  ts: FileTsIcon, tsx: FileTsxIcon, js: FileJsIcon, mjs: FileJsIcon, jsx: FileJsxIcon, py: FilePyIcon, rs: FileRsIcon, html: FileHtmlIcon, css: FileCssIcon,
  png: FilePngIcon, jpg: FileJpgIcon, jpeg: FileJpgIcon, svg: FileSvgIcon, gif: FileImageIcon, webp: FileImageIcon, avif: FileImageIcon, bmp: FileImageIcon,
  mp4: FileVideoIcon, mov: FileVideoIcon, webm: FileVideoIcon, mp3: FileAudioIcon, wav: FileAudioIcon, zip: FileZipIcon,
};

/** A folder. */
export function FolderIcon({ size = 16 }: { size?: number }) {
  return <PhosphorFolder weight="light" size={size} className="flex-none text-icon" aria-hidden="true" />;
}

/** A page marked by the kind of file the name says it is (a plain page when it has no known ending). */
export function FileIcon({ name, size = 16 }: { name: string; size?: number }) {
  const Glyph = BY_EXT[(name.includes('.') ? name.split('.').pop()! : '').toLowerCase()] ?? PlainFileIcon;
  return <Glyph weight="light" size={size} className="flex-none text-icon" aria-hidden="true" />;
}

/** The Visual Studio Code mark, outlined: its shape, drawn as a thin line like the icons around it. */
export function VSCodeIcon({ size = 16 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" aria-hidden="true" className="flex-none">
      <path d="M23.15 2.587L18.21.21a1.494 1.494 0 0 0-1.705.29l-9.46 8.63-4.12-3.128a.999.999 0 0 0-1.276.057L.327 7.261A1 1 0 0 0 .326 8.74L3.899 12 .326 15.26a1 1 0 0 0 .001 1.479L1.65 17.94a.999.999 0 0 0 1.276.057l4.12-3.128 9.46 8.63a1.492 1.492 0 0 0 1.704.29l4.942-2.377A1.5 1.5 0 0 0 24 20.06V3.939a1.5 1.5 0 0 0-.85-1.352zm-5.146 14.861L10.826 12l7.178-5.448v10.896z" />
    </svg>
  );
}
