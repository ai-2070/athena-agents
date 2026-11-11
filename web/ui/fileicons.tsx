// Pictures of things in a folder: a folder, a page marked by its kind of file (Phosphor Light, in the icon grey), and the
// official Visual Studio Code ribbon mark. (The pixel-art set these replaced is in git: e6b108a.)
import { serverUrl } from '../client/connection.ts';
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
import { useIconWeight } from './react.tsx';

const BY_EXT: Record<string, PhosphorIcon> = {
  md: FileMdIcon,
  markdown: FileMdIcon,
  txt: FileTxtIcon,
  pdf: FilePdfIcon,
  doc: FileDocIcon,
  docx: FileDocIcon,
  csv: FileCsvIcon,
  ini: FileIniIcon,
  json: FileCodeIcon,
  yaml: FileCodeIcon,
  yml: FileCodeIcon,
  toml: FileCodeIcon,
  xml: FileCodeIcon,
  sh: FileCodeIcon,
  ps1: FileCodeIcon,
  go: FileCodeIcon,
  ts: FileTsIcon,
  tsx: FileTsxIcon,
  js: FileJsIcon,
  mjs: FileJsIcon,
  jsx: FileJsxIcon,
  py: FilePyIcon,
  rs: FileRsIcon,
  html: FileHtmlIcon,
  css: FileCssIcon,
  png: FilePngIcon,
  jpg: FileJpgIcon,
  jpeg: FileJpgIcon,
  svg: FileSvgIcon,
  gif: FileImageIcon,
  webp: FileImageIcon,
  avif: FileImageIcon,
  bmp: FileImageIcon,
  mp4: FileVideoIcon,
  mov: FileVideoIcon,
  webm: FileVideoIcon,
  mp3: FileAudioIcon,
  wav: FileAudioIcon,
  zip: FileZipIcon,
};

/** A folder. */
export function FolderIcon({ size = 16 }: { size?: number }) {
  return <PhosphorFolder weight={useIconWeight()} size={size} className="flex-none text-icon" aria-hidden="true" />;
}

/** A page marked by the kind of file the name says it is (a plain page when it has no known ending). */
export function FileIcon({ name, size = 16 }: { name: string; size?: number }) {
  const Glyph = BY_EXT[(name.includes('.') ? name.split('.').pop()! : '').toLowerCase()] ?? PlainFileIcon;
  return <Glyph weight={useIconWeight()} size={size} className="flex-none text-icon" aria-hidden="true" />;
}

/** The same official ribbon used in the program list. */
export function VSCodeIcon({ size = 16 }: { size?: number }) {
  return (
    <img
      src={serverUrl('/brand/engines/vscode.png')}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      className="flex-none object-contain"
    />
  );
}
