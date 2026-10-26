// Images a tool call returned (a picture an agent read, a screenshot): saved as files next to the chat,
// tool-images/<agent id>/<chat id>/<hash>.<ext>, so the chat keeps a short link instead of the whole
// image, and shown under the tool call. They go when the chat goes (chats.remove).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ensureDir } from './util.ts';
import { projectData } from './store.ts';

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
/** Per image (decoded), and per tool call: what the chat shows. */
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_IMAGES = 24;
const SAFE_ID = /^[\w-]+$/;

export const toolImagesDir = (agentId: string, chatId: string): string => projectData('tool-images', agentId, chatId);

/** One image from a tool result: MCP's and pi's { type: 'image', data, mimeType }, or Claude's
 *  { type: 'image', source: { type: 'base64', media_type, data } }. As a data: URI, or null. */
export function imageUri(part: unknown): string | null {
  const p = part as { type?: string; data?: unknown; mimeType?: unknown; source?: { type?: string; data?: unknown; media_type?: unknown } } | null;
  if (!p || p.type !== 'image') return null;
  const [data, mime] = p.source ? (p.source.type === 'base64' ? [p.source.data, p.source.media_type] : [null, null]) : [p.data, p.mimeType];
  return typeof data === 'string' && data && typeof mime === 'string' && EXT[mime.toLowerCase()] ? `data:${mime.toLowerCase()};base64,${data}` : null;
}

/** A tool result's content parts: the text, with the images on their own. */
export function splitContent(content: unknown): { text: string; images: string[] } {
  if (!Array.isArray(content)) return { text: typeof content === 'string' ? content : content == null ? '' : JSON.stringify(content), images: [] };
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

/** Saves the data: images of a tool result next to the chat and gives their links instead (any other
 *  link stays as it is). Too big, not an image, or unsaveable: left out. */
export function keepToolImages(agentId: string, chatId: string, images: readonly string[] | undefined): string[] {
  if (!images?.length) return [];
  if (!SAFE_ID.test(agentId) || !SAFE_ID.test(chatId)) return images.filter((i) => !i.startsWith('data:')).slice(0, MAX_IMAGES);
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
      const file = path.join(ensureDir(toolImagesDir(agentId, chatId)), `${crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 24)}.${ext}`);
      if (!fs.existsSync(file)) fs.writeFileSync(file, bytes);
      out.push(`/api/file?path=${encodeURIComponent(file)}`);
    } catch {
      /* a full disk or the like: the tool call shows without it */
    }
  }
  return out;
}
