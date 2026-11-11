// Images a tool call returned (a picture an agent read, a screenshot): saved as files next to the chat,
// tool-images/<agent id>/<chat id>/<hash>.<ext>, so the chat keeps a short link instead of the whole
// image, and shown under the tool call. They go when the chat goes (chats.remove).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ensureDir } from './util.ts';
import { projectData } from './store.ts';

const EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};
/** Per image (decoded), and per tool call: what the chat shows. */
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_IMAGES = 24;
const SAFE_ID = /^[\w-]+$/;

export const toolImagesDir = (agentId: string, chatId: string): string => projectData('tool-images', agentId, chatId);

/** One image from a tool result: MCP's and pi's { type: 'image', data, mimeType }, or Claude's
 *  { type: 'image', source: { type: 'base64', media_type, data } }. As a data: URI, or null. */
export function imageUri(part: unknown): string | null {
  const p = part as {
    type?: string;
    data?: unknown;
    mimeType?: unknown;
    source?: { type?: string; data?: unknown; media_type?: unknown };
  } | null;
  if (!p || p.type !== 'image') return null;
  const [data, mime] = p.source
    ? p.source.type === 'base64'
      ? [p.source.data, p.source.media_type]
      : [null, null]
    : [p.data, p.mimeType];
  return typeof data === 'string' && data && typeof mime === 'string' && EXT[mime.toLowerCase()]
    ? `data:${mime.toLowerCase()};base64,${data}`
    : null;
}

/** A tool result's content parts: the text, with the images on their own. */
export function splitContent(content: unknown): { text: string; images: string[] } {
  if (!Array.isArray(content))
    return { text: typeof content === 'string' ? content : content == null ? '' : JSON.stringify(content), images: [] };
  const texts: string[] = [];
  const images: string[] = [];
  for (const c of content as { type?: string; text?: string }[]) {
    const img = imageUri(c);
    if (img) images.push(img);
    else if (c?.type === 'text') texts.push(c.text || '');
    else if (c?.type) texts.push(`[${c.type}]`);
  }
  return { text: texts.join('\n'), images };
}

/** What a model is sent of a tool result's images: at most this many, each at most MODEL_MAX_BYTES. */
export const MODEL_MAX_IMAGES = 6;
export const MODEL_MAX_BYTES = 5 * 1024 * 1024;

/** A tool result's images as data: URIs, for a model or an MCP client to see: the data: ones as they are,
 *  and the dashboard's ComfyUI result links read from ComfyUI. A few, each at most 5 MB; the note says
 *  how many were left out and why ('' when none were), for the tool result's text. */
export async function inlineToolImagesNoted(
  images: readonly string[] | undefined,
  max = MODEL_MAX_IMAGES,
): Promise<{ images: string[]; note: string }> {
  const out: string[] = [];
  const limit = MODEL_MAX_BYTES;
  let tooMany = 0;
  let tooBig = 0;
  let unreadable = 0;
  for (const src of images || []) {
    if (out.length >= max) {
      tooMany++;
      continue;
    }
    const m = /^data:([\w/+.-]+);base64,(.*)$/s.exec(src);
    if (m) {
      if (!EXT[m[1].toLowerCase()]) unreadable++;
      else if (m[2].length > (limit * 4) / 3 + 4) tooBig++;
      else out.push(src);
      continue;
    }
    if (!src.startsWith('/api/comfyui/view?')) {
      unreadable++;
      continue;
    }
    try {
      const { viewImage } = await import('./comfyui.ts');
      const img = await viewImage(src, limit);
      if (img) out.push(`data:${img.mime};base64,${img.bytes.toString('base64')}`);
      else unreadable++;
    } catch {
      /* ComfyUI went away: the picture stays a link in the chat */
      unreadable++;
    }
  }
  const left = tooMany + tooBig + unreadable;
  const mb = `${Math.round(limit / 1024 / 1024)} MB`;
  const why = [
    tooMany && `${tooMany} past the limit of ${max} per tool call`,
    tooBig && `${tooBig} over ${mb}`,
    unreadable && `${unreadable} that could not be read as a PNG, JPEG, WebP or GIF of at most ${mb}`,
  ].filter(Boolean);
  const note = left
    ? `${left} image${left === 1 ? ' was' : 's were'} left out of what you see: ${why.join(', ')}. Ask for fewer or smaller images if you need them.`
    : '';
  return { images: out, note };
}

/** inlineToolImagesNoted's images alone. */
export async function inlineToolImages(
  images: readonly string[] | undefined,
  max = MODEL_MAX_IMAGES,
): Promise<string[]> {
  return (await inlineToolImagesNoted(images, max)).images;
}

/** A picture's type from its first bytes (not its name): PNG, JPEG, GIF or WebP, else null. */
export function imageType(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  )
    return 'image/webp';
  return null;
}

/** A tool result's text with the note after it. */
export const withImageNote = (text: string, note: string): string =>
  note ? (text ? `${text}\n\n${note}` : note) : text;

/** Saves the data: images of a tool result next to the chat and gives their links instead (any other
 *  link stays as it is). Too big, not an image, or unsaveable: left out. */
export function keepToolImages(agentId: string, chatId: string, images: readonly string[] | undefined): string[] {
  if (!images?.length) return [];
  if (!SAFE_ID.test(agentId) || !SAFE_ID.test(chatId))
    return images.filter((i) => !i.startsWith('data:')).slice(0, MAX_IMAGES);
  const out: string[] = [];
  for (const src of images) {
    if (out.length >= MAX_IMAGES) break;
    const m = /^data:([\w/+.-]+);base64,(.*)$/s.exec(src);
    if (!m) {
      if (!src.startsWith('data:')) out.push(src);
      continue;
    }
    const ext = EXT[m[1].toLowerCase()];
    if (!ext || m[2].length > (MAX_BYTES * 4) / 3 + 4) continue;
    try {
      const bytes = Buffer.from(m[2], 'base64');
      if (!bytes.length) continue;
      // (the same picture read twice is one file)
      const file = path.join(
        ensureDir(toolImagesDir(agentId, chatId)),
        `${crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 24)}.${ext}`,
      );
      if (!fs.existsSync(file)) fs.writeFileSync(file, bytes);
      out.push(`/api/file?path=${encodeURIComponent(file)}`);
    } catch {
      /* a full disk or the like: the tool call shows without it */
    }
  }
  return out;
}
