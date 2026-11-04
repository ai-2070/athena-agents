import { inlineToolImagesNoted, withImageNote } from '../toolimages.ts';
import { inflateSync } from 'node:zlib';
import type { ToolResult } from '../tools.ts';
import type { EveToolResult } from '../../shared/types.ts';

/** Bound the pinned runtime's page-based estimate, including compressed PDF object streams. */
export function fileTokens(mediaType: string, encoded: string): number {
  if (mediaType.startsWith('image/')) return 4784;
  const bytes = Buffer.from(encoded, 'base64');
  if (mediaType !== 'application/pdf') return Math.ceil(bytes.length / 3);
  const source = bytes.toString('latin1');
  const pagesIn = (text: string) => text.match(/\/Type\s*\/Page(?![A-Za-z])/g)?.length || 0;
  let pages = pagesIn(source);
  let remaining = 16 * 1024 * 1024;
  let streams = 0;
  for (const match of source.matchAll(/\/Type\s*\/ObjStm(?![A-Za-z])/g)) {
    if (++streams > 10000) throw new Error('This PDF is too complex to budget safely. Use a smaller document or the file tools.');
    const stream = source.indexOf('stream', match.index);
    const end = source.indexOf('endstream', stream);
    if (stream < 0 || end < 0 || remaining <= 0) throw new Error('This PDF cannot be budgeted safely. Use the file tools.');
    const start = stream + (source.startsWith('stream\r\n', stream) ? 8 : 7);
    try {
      const expanded = inflateSync(bytes.subarray(start, end), { maxOutputLength: remaining });
      remaining -= expanded.length;
      pages += pagesIn(expanded.toString('latin1'));
    } catch { throw new Error('This PDF cannot be budgeted safely. Use a smaller document or the file tools.'); }
  }
  for (const count of source.matchAll(/\/Count\s+(\d+)/g)) pages = Math.max(pages, Number(count[1]));
  return Math.max(Math.ceil(bytes.length / 3), pages ? pages * 3000 : 8192);
}

/** Capture model bytes inside the operation receipt, so replay cannot reread a changed image. */
export async function captureToolImages(result: ToolResult): Promise<EveToolResult> {
  if (!result.images?.length) return result;
  const { images: modelImages, note } = await inlineToolImagesNoted(result.images);
  return { ...result, modelImages, text: withImageNote(result.text, note) };
}
