// Small real documents for the document reader's tests: Word, Excel and PowerPoint packages, and a one-page PDF.
import { strToU8, zipSync } from 'fflate';

const TYPES = { '[Content_Types].xml': strToU8('<Types/>') };

export function docx(body: string): Uint8Array {
  return zipSync({ ...TYPES, 'word/document.xml': strToU8(`<?xml version="1.0"?><w:document xmlns:w="w"><w:body>${body}</w:body></w:document>`) });
}

export function xlsx(sheets: Record<string, string>, shared: string[] = []): Uint8Array {
  const names = Object.keys(sheets);
  return zipSync({
    ...TYPES,
    'xl/workbook.xml': strToU8(`<workbook><sheets>${names.map((name, i) => `<sheet name="${name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8(`<Relationships>${names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`),
    'xl/sharedStrings.xml': strToU8(`<sst>${shared.map((text) => `<si><t>${text}</t></si>`).join('')}</sst>`),
    ...Object.fromEntries(names.map((name, i) => [`xl/worksheets/sheet${i + 1}.xml`, strToU8(`<worksheet><sheetData>${sheets[name]}</sheetData></worksheet>`)])),
  });
}

/** A deck whose slides are listed in `order` (file numbers), each slide's paragraphs given. */
export function pptx(slides: string[][], order = slides.map((_, i) => i + 1)): Uint8Array {
  const slide = (paragraphs: string[]) => strToU8(`<p:sld><p:cSld><p:spTree><p:sp><p:txBody>${paragraphs.map((p) => `<a:p><a:r><a:t>${p}</a:t></a:r></a:p>`).join('')}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`);
  return zipSync({
    ...TYPES,
    'ppt/presentation.xml': strToU8(`<p:presentation><p:sldIdLst>${order.map((n) => `<p:sldId id="${255 + n}" r:id="rId${n}"/>`).join('')}</p:sldIdLst></p:presentation>`),
    'ppt/_rels/presentation.xml.rels': strToU8(`<Relationships>${slides.map((_, i) => `<Relationship Id="rId${i + 1}" Type="slide" Target="slides/slide${i + 1}.xml"/>`).join('')}</Relationships>`),
    ...Object.fromEntries(slides.map((paragraphs, i) => [`ppt/slides/slide${i + 1}.xml`, slide(paragraphs)])),
  });
}

/** A ZIP whose central directory says the parts `names` matches unpack to `size` bytes, as a hostile file's could. */
export function declareSizes(zip: Uint8Array, names: RegExp, size: number): Uint8Array {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const decoder = new TextDecoder();
  for (let at = 0; at + 46 <= zip.length; at++) {
    if (view.getUint32(at, true) !== 0x02014b50) continue;
    const length = view.getUint16(at + 28, true);
    if (names.test(decoder.decode(zip.subarray(at + 46, at + 46 + length)))) view.setUint32(at + 24, size, true);
  }
  return zip;
}

/** A PDF with one page per text, in Helvetica, with a correct cross-reference table. No text: a page with nothing on it. */
export function pdf(...pages: string[]): Uint8Array {
  const kids = pages.map((_, i) => `${3 + i * 2} 0 R`).join(' ');
  const font = 3 + pages.length * 2;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`];
  for (const [i, text] of pages.entries()) {
    const stream = text ? `BT /F1 12 Tf 72 720 Td (${text}) Tj ET` : '';
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + i * 2} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return strToU8(out);
}

/** The start of a compound file (what older Office files are), padded to a sector. */
export const compound = (): Uint8Array => Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, ...new Array(504).fill(0)]);
