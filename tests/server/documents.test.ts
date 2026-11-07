// The text of PDF, Word, Excel and PowerPoint files: what each kind gives, the limits a hostile file meets, and reading
// a file in parts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { DocumentError, EXCEL_LAST_COLUMN, PARTS_MAX, UNPACKED_MAX_BYTES, documentKind, documentText, pdfText, readDocumentFile, readDocumentPart } from '../../server/documents.ts';
import { compound, declareSizes, docx, pdf, pptx, xlsx } from './fixtures/documents.ts';

const folder = () => fs.mkdtempSync(path.join(os.homedir(), 'docs-'));

describe('telling a document by its bytes', () => {
  it('knows PDFs and Office packages, and nothing else', () => {
    expect(documentKind(pdf('x'), 'whatever.bin')).toBe('pdf');
    expect(documentKind(docx(''), 'a.docx')).toBe('word');
    expect(documentKind(xlsx({ S: '' }), 'a.xlsx')).toBe('excel');
    expect(documentKind(pptx([['x']]), 'a.pptx')).toBe('powerpoint');
    // a plain ZIP, a text file and an empty file aren't
    expect(documentKind(zipSync({ 'a.txt': strToU8('hi') }), 'a.docx')).toBeNull();
    expect(documentKind(strToU8('# Notes'), 'a.pdf')).toBeNull();
    expect(documentKind(new Uint8Array(), 'a.pdf')).toBeNull();
  });

  it('takes a compound file for an older Office one only when its name agrees', () => {
    expect(documentKind(compound(), 'Budget.XLS')).toBe('old-office');
    // Outlook messages and installers are compound files too
    expect(documentKind(compound(), 'mail.msg')).toBeNull();
  });
});

describe('the text of each kind', () => {
  it("reads a Word document's paragraphs, tabs and tables, decoding only XML's own entities", async () => {
    const read = await documentText('word', docx(
      '<w:p><w:r><w:t>Refund &amp; credit</w:t></w:r><w:r><w:tab/><w:t xml:space="preserve"> agreed</w:t></w:r></w:p>'
      + '<w:p><w:r><w:t>&#8364;40 &unknown;</w:t></w:r></w:p>'
      + '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Plan</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Plus</w:t></w:r></w:p></w:tc></w:tr></w:tbl>',
    ));
    expect(read.text).toContain('Refund & credit\t agreed');
    expect(read.text).toContain('€40 &unknown;');
    expect(read.text).toMatch(/Plan\n? \| Plus/);
  });

  it('reads each sheet of a workbook, cells in their columns', async () => {
    const read = await documentText('excel', xlsx({
      Payments: '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row><row r="2"/><row r="3"><c r="A3" t="inlineStr"><is><t>Ana</t></is></c><c r="B3"><v>42.5</v></c><c r="C3" t="b"><v>1</v></c></row>',
      Notes: '<row r="1"><c r="B1" t="str"><v>a &lt; b</v></c></row>',
    }, ['Name', 'Paid']));
    expect(read.sheets).toEqual(['Payments', 'Notes']);
    expect(read.text).toBe('--- Sheet: Payments ---\nName\t\tPaid\nAna\t42.5\tTRUE\n\n--- Sheet: Notes ---\n\ta < b');
    expect(read.notes.join(' ')).toContain('serial number');
  });

  it("reads a deck's slides in the deck's order, not the files'", async () => {
    const read = await documentText('powerpoint', pptx([['Second'], ['First', 'Agenda &amp; goals']], [2, 1]));
    expect(read.slides).toBe(2);
    expect(read.text).toBe('--- Slide 1 ---\nFirst\nAgenda & goals\n\n--- Slide 2 ---\nSecond');
  });

  it('reads a PDF page by page, and says when one has no text', async () => {
    const read = await documentText('pdf', pdf('Contract signed 3 May', 'Page two'));
    expect(read.pages).toEqual({ total: 2, read: 2 });
    expect(read.text).toBe('--- Page 1 ---\nContract signed 3 May\n\n--- Page 2 ---\nPage two');
    expect(read.notes).toEqual([]);
    const scan = await documentText('pdf', pdf(''));
    expect(scan.notes.join(' ')).toContain('probably a scan');
  });

  it("stops a PDF's thread when it takes too long, and still reads the next", async () => {
    const file = pdf('Contract signed 3 May');
    await expect(pdfText(file, 1)).rejects.toThrow('took too long');
    expect((await pdfText(file)).text).toContain('Contract signed 3 May');
  });

  it('says when a PDF is password protected, or not a PDF at all', async () => {
    // pdf.js asks for a password when the trailer names an /Encrypt dictionary
    const plain = new TextDecoder().decode(pdf('secret'));
    const locked = plain.replace('<< /Size 6 /Root 1 0 R >>', '<< /Size 6 /Root 1 0 R /Encrypt << /Filter /Standard /V 1 /R 2 /O (0123456789abcdef0123456789abcdef) /U (0123456789abcdef0123456789abcdef) /P -4 >> /ID [<00112233445566778899aabbccddeeff> <00112233445566778899aabbccddeeff>] >>');
    expect(locked).not.toBe(plain);
    await expect(documentText('pdf', strToU8(locked))).rejects.toThrow('password protected');
    await expect(documentText('pdf', strToU8('%PDF-1.4 nothing else'))).rejects.toThrow(DocumentError);
  });

  it("refuses older Office files and packages that aren't what they say", async () => {
    await expect(documentText('old-office', compound())).rejects.toThrow('.doc, .xls, .ppt');
    await expect(documentText('word', strToU8('PK not a zip'))).rejects.toThrow("couldn't be unpacked");
    await expect(documentText('word', xlsx({ S: '' }))).rejects.toThrow('no document');
  });
});

describe('limits', () => {
  it("doesn't unpack a part that would be over the limit", async () => {
    const bomb = zipSync({ '[Content_Types].xml': strToU8('<Types/>'), 'word/document.xml': new Uint8Array(25_000_000) }, { level: 9 });
    expect(bomb.length).toBeLessThan(100_000);
    await expect(documentText('word', bomb)).rejects.toThrow('too large');
  });

  it('caps what a package unpacks in all, and how many parts', async () => {
    // each sheet's header says it is under the per-part limit; together they're over the total (only declared, so
    // nothing large is built here)
    const heavy = declareSizes(xlsx({ S0: '', S1: '', S2: '', S3: '' }), /^xl\/worksheets\//, UNPACKED_MAX_BYTES / 4 + 1);
    await expect(documentText('excel', heavy)).rejects.toThrow('too large');
    const many = xlsx(Object.fromEntries(Array.from({ length: PARTS_MAX }, (_, i) => [`S${i}`, ''])));
    await expect(documentText('excel', many)).rejects.toThrow('too many parts');
  });

  it("refuses a cell past Excel's last column without counting up to it", async () => {
    const at = (ref: string) => xlsx({ Sheet: `<row r="1"><c r="${ref}1"><v>7</v></c></row>` });
    expect((await documentText('excel', at('XFD'))).text.split('\t')).toHaveLength(EXCEL_LAST_COLUMN + 1);
    await expect(documentText('excel', at('XFE'))).rejects.toThrow('last column');
    const started = Date.now();
    await expect(documentText('excel', at('ZZZZZZZZZZZZ'))).rejects.toThrow('last column');
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('reading a file', () => {
  it("answers null for a file that isn't a document, without reading a text file whole", async () => {
    const dir = folder();
    fs.writeFileSync(path.join(dir, 'notes.md'), '# Notes');
    fs.writeFileSync(path.join(dir, 'fake.pdf'), 'not really');
    fs.writeFileSync(path.join(dir, 'archive.zip'), zipSync({ 'a.txt': strToU8('hi') }));
    for (const name of ['notes.md', 'fake.pdf', 'archive.zip']) expect(await readDocumentFile(path.join(dir, name))).toBeNull();
    expect(await readDocumentFile(dir)).toBeNull();
  });

  it('reads a document once while it stays the same, again once it changes', async () => {
    const file = path.join(folder(), 'brief.docx');
    fs.writeFileSync(file, docx('<w:p><w:r><w:t>First draft</w:t></w:r></w:p>'));
    const first = await readDocumentFile(file);
    expect(first?.text).toBe('First draft');
    expect(await readDocumentFile(file)).toBe(first);
    fs.writeFileSync(file, docx('<w:p><w:r><w:t>Second draft, longer</w:t></w:r></w:p>'));
    expect((await readDocumentFile(file))?.text).toBe('Second draft, longer');
  });

  it('gives what it is, what to know, and its text in parts by line', async () => {
    const file = path.join(folder(), 'sheet.xlsx');
    const rows = Array.from({ length: 30 }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>${i + 1}</v></c></row>`).join('');
    fs.writeFileSync(file, xlsx({ Totals: rows }));
    const whole = await readDocumentPart(file, '/shown/sheet.xlsx');
    expect(whole).toMatch(/^\[\/shown\/sheet\.xlsx: Excel workbook, sheet: Totals\]\n\[Cells hold what Excel stored/);
    expect(whole).toContain('--- Sheet: Totals ---\n1\n2\n');
    const part = await readDocumentPart(file, 'sheet.xlsx', { offset: 11, limit: 5 });
    expect(part).toContain('\n\n10\n11\n12\n13\n14\n\n[Lines 11-15 of 31. Continue with offset 16.]');
  });

  it("says why a document can't be read", async () => {
    const dir = folder();
    fs.writeFileSync(path.join(dir, 'old.doc'), compound());
    await expect(readDocumentPart(path.join(dir, 'old.doc'), 'old.doc')).rejects.toThrow("old.doc can't be read: older Office files");
  });
});
