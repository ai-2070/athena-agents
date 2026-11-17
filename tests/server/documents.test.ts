// The text of PDF, Word, Excel and PowerPoint files: what each kind gives, the limits a hostile file meets, and reading
// a file in parts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  DocumentError,
  EXCEL_LAST_COLUMN,
  PARTS_MAX,
  UNPACKED_MAX_BYTES,
  documentKind,
  documentText,
  pdfText,
  readDocumentFile,
  readDocumentPart,
} from '../../server/documents.ts';
import { compound, declareSizes, docx, pdf, pptx, pptxRaw, prefixedXlsx, xlsx } from './fixtures/documents.ts';

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

  it('takes a PDF header after some junk only in a file named .pdf', () => {
    const late = strToU8(`junk\n${new TextDecoder().decode(pdf('x'))}`);
    expect(documentKind(late, 'scan.PDF')).toBe('pdf');
    // a note or source file that mentions the header is still text
    expect(documentKind(strToU8('# How PDFs start\nEvery one begins with %PDF-1.4'), 'notes.md')).toBeNull();
    expect(documentKind(late, 'notes.md')).toBeNull();
  });

  it('takes a compound file for an older Office one only when its name agrees', () => {
    expect(documentKind(compound(), 'Budget.XLS')).toBe('old-office');
    // Outlook messages and installers are compound files too
    expect(documentKind(compound(), 'mail.msg')).toBeNull();
  });
});

describe('the text of each kind', () => {
  it("reads a Word document's paragraphs, tabs and tables, decoding only XML's own entities", async () => {
    const read = await documentText(
      'word',
      docx(
        '<w:p><w:r><w:t>Refund &amp; credit</w:t></w:r><w:r><w:tab/><w:t xml:space="preserve"> agreed</w:t></w:r></w:p>' +
          '<w:p><w:r><w:t>&#8364;40 &unknown;</w:t></w:r></w:p>' +
          '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Plan</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Plus</w:t></w:r></w:p></w:tc></w:tr></w:tbl>',
      ),
    );
    expect(read.text).toContain('Refund & credit\t agreed');
    expect(read.text).toContain('€40 &unknown;');
    expect(read.text).toContain('\nPlan | Plus');
  });

  it("keeps a table's row on one line, its cells' own paragraphs joined", async () => {
    const cell = (...paragraphs: string[]) =>
      `<w:tc><w:tcPr><w:tcW w:w="1"/></w:tcPr>${paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join('')}</w:tc>`;
    const read = await documentText(
      'word',
      docx(
        `<w:p><w:r><w:t>Before</w:t></w:r></w:p><w:tbl><w:tr>${cell('Name')}${cell('Age')}</w:tr><w:tr>${cell('Ana', 'Lopez')}${cell('42')}</w:tr></w:tbl><w:p><w:r><w:t>After</w:t></w:r></w:p>`,
      ),
    );
    expect(read.text).toBe('Before\nName | Age\nAna Lopez | 42\nAfter');
    // a deck's tables too
    const slide = `<a:tbl><a:tr><a:tc><a:txBody><a:p><a:r><a:t>Q1</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>Q2</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl>`;
    expect((await documentText('powerpoint', pptxRaw(slide))).text).toBe('--- Slide 1 ---\nQ1 | Q2');
  });

  it('reads Word text whatever prefix the file gives its namespace, or none', async () => {
    const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
    const doc = (xml: string) =>
      zipSync({ '[Content_Types].xml': strToU8('<Types/>'), 'word/document.xml': strToU8(xml) });
    const own = doc(
      `<x:document xmlns:x="${W}"><x:body><x:p><x:r><x:t>Own prefix</x:t></x:r></x:p></x:body></x:document>`,
    );
    expect((await documentText('word', own)).text).toBe('Own prefix');
    const none = doc(`<document xmlns="${W}"><body><p><r><t>No prefix</t></r></p></body></document>`);
    expect((await documentText('word', none)).text).toBe('No prefix');
  });

  it("knows a workbook by its own parts, not a Word file's name inside it", () => {
    const parts = unzipSync(xlsx({ S: '' }));
    parts['xl/embeddings/word/document.xml'] = strToU8('<w:document/>');
    expect(documentKind(zipSync(parts), 'a.xlsx')).toBe('excel');
  });

  it('follows sheet addresses written ./ or %-encoded', async () => {
    const parts = unzipSync(
      xlsx({
        First: '<row r="1"><c r="A1" t="str"><v>one</v></c></row>',
        Second: '<row r="1"><c r="A1" t="str"><v>two</v></c></row>',
      }),
    );
    const rels = strFromU8(parts['xl/_rels/workbook.xml.rels']!)
      .replace('Target="worksheets/sheet1.xml"', 'Target="./worksheets/sheet1.xml"')
      .replace('Target="worksheets/sheet2.xml"', 'Target="worksheets/%73heet2.xml"');
    parts['xl/_rels/workbook.xml.rels'] = strToU8(rels);
    const read = await documentText('excel', zipSync(parts));
    expect(read.sheets).toEqual(['First', 'Second']);
    expect(read.text).toContain('one');
    expect(read.text).toContain('two');
  });

  it('reads each sheet of a workbook, cells in their columns', async () => {
    const read = await documentText(
      'excel',
      xlsx(
        {
          Payments:
            '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row><row r="2"/><row r="3"><c r="A3" t="inlineStr"><is><t>Ana</t></is></c><c r="B3"><v>42.5</v></c><c r="C3" t="b"><v>1</v></c></row>',
          Notes: '<row r="1"><c r="B1" t="str"><v>a &lt; b</v></c></row>',
        },
        ['Name', 'Paid'],
      ),
    );
    expect(read.sheets).toEqual(['Payments', 'Notes']);
    expect(read.text).toBe('--- Sheet: Payments ---\nName\t\tPaid\nAna\t42.5\tTRUE\n\n--- Sheet: Notes ---\n\ta < b');
    expect(read.notes.join(' ')).toContain('serial number');
  });

  it('reads a workbook whose elements carry a prefix', async () => {
    const read = await documentText('excel', prefixedXlsx());
    expect(read.sheets).toEqual(['Report']);
    expect(read.text).toBe('--- Sheet: Report ---\nRegion\tTotal\nNorth\t12');
  });

  it('counts only rows with something in them toward the limit', async () => {
    const filled = Array.from(
      { length: 1500 },
      (_, i) =>
        `<row r="${i * 2 + 1}"><c r="A${i * 2 + 1}"><v>${i}</v></c></row><row r="${i * 2 + 2}" s="1"><c r="A${i * 2 + 2}" s="1"/></row>`,
    ).join('');
    const read = await documentText('excel', xlsx({ Data: filled }));
    expect(read.text.split('\n')).toHaveLength(1501);
    expect(read.notes.join(' ')).not.toContain('only the first');
    const more = Array.from(
      { length: 2500 },
      (_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>${i}</v></c></row>`,
    ).join('');
    expect((await documentText('excel', xlsx({ Data: more }))).notes.join(' ')).toContain(
      'only the first 2000 of 2500 rows',
    );
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
    await expect(pdfText(file, { timeoutMs: 1 })).rejects.toThrow('took too long');
    expect((await pdfText(file)).text).toContain('Contract signed 3 May');
  });

  it('counts the time waiting for a free thread in the time a read may take', async () => {
    const file = pdf('Contract signed 3 May');
    const t0 = Date.now();
    // both threads busy: the third waits for one
    const busy = Promise.all([pdfText(file), pdfText(file)]).then(() => Date.now() - t0);
    const third = pdfText(file, { timeoutMs: 30 }).then(
      () => ({ error: '', at: Date.now() - t0 }),
      (e: unknown) => ({ error: (e as Error).message, at: Date.now() - t0 }),
    );
    const freeAt = await busy;
    const r = await third;
    expect(r.error).toContain('took too long');
    expect(r.at).toBeLessThan(freeAt);
  });

  it("stops reading a PDF when it's told to, and reads it in full next time", async () => {
    const file = path.join(folder(), 'long.pdf');
    fs.writeFileSync(file, pdf('Contract signed 3 May'));
    const stop = new AbortController();
    stop.abort(new Error('Stopped.'));
    await expect(readDocumentFile(file, { signal: stop.signal })).rejects.toThrow('Stopped.');
    const reading = new AbortController();
    const read = readDocumentFile(file, { signal: reading.signal });
    reading.abort(new Error('Stopped.'));
    await expect(read).rejects.toThrow('Stopped.');
    // (cut short by a caller's budget, it isn't remembered as too slow either)
    await expect(readDocumentFile(file, { timeoutMs: 1 })).rejects.toThrow('took too long');
    expect((await readDocumentFile(file))?.text).toContain('Contract signed 3 May');
  });

  it('says when a PDF is password protected, or not a PDF at all', async () => {
    // pdf.js asks for a password when the trailer names an /Encrypt dictionary
    const plain = new TextDecoder().decode(pdf('secret'));
    const locked = plain.replace(
      '<< /Size 6 /Root 1 0 R >>',
      '<< /Size 6 /Root 1 0 R /Encrypt << /Filter /Standard /V 1 /R 2 /O (0123456789abcdef0123456789abcdef) /U (0123456789abcdef0123456789abcdef) /P -4 >> /ID [<00112233445566778899aabbccddeeff> <00112233445566778899aabbccddeeff>] >>',
    );
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
    const bomb = zipSync(
      { '[Content_Types].xml': strToU8('<Types/>'), 'word/document.xml': new Uint8Array(25_000_000) },
      { level: 9 },
    );
    expect(bomb.length).toBeLessThan(100_000);
    await expect(documentText('word', bomb)).rejects.toThrow('too large');
  });

  it('counts a stored part by its body, not by the size its header claims', async () => {
    // four stored sheets, each under the per-part limit but over the total together, each claiming 10 bytes
    const parts = unzipSync(xlsx({ S0: '', S1: '', S2: '', S3: '' }));
    for (const name of Object.keys(parts))
      if (/^xl\/worksheets\//.test(name)) parts[name] = new Uint8Array(UNPACKED_MAX_BYTES / 4 + 1_000_000);
    const stored = declareSizes(zipSync(parts, { level: 0 }), /^xl\/worksheets\//, 10);
    await expect(documentText('excel', stored)).rejects.toThrow('too large');
  });

  it('caps what a package unpacks in all, and how many parts', async () => {
    // each sheet's header says it is under the per-part limit; together they're over the total (only declared, so
    // nothing large is built here)
    const heavy = declareSizes(
      xlsx({ S0: '', S1: '', S2: '', S3: '' }),
      /^xl\/worksheets\//,
      UNPACKED_MAX_BYTES / 4 + 1,
    );
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
    for (const name of ['notes.md', 'fake.pdf', 'archive.zip'])
      expect(await readDocumentFile(path.join(dir, name))).toBeNull();
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
    const rows = Array.from(
      { length: 30 },
      (_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>${i + 1}</v></c></row>`,
    ).join('');
    fs.writeFileSync(file, xlsx({ Totals: rows }));
    const whole = await readDocumentPart(file, '/shown/sheet.xlsx');
    expect(whole).toMatch(/^\[\/shown\/sheet\.xlsx: Excel workbook, sheet: Totals\]\n\[Cells hold what Excel stored/);
    expect(whole).toContain('--- Sheet: Totals ---\n1\n2\n');
    const part = await readDocumentPart(file, 'sheet.xlsx', { offset: 11, limit: 5 });
    expect(part).toContain('\n\n10\n11\n12\n13\n14\n\n[Lines 11-15 of 31. Continue with offset 16.]');
  });

  it("remembers a document that can't be read while it stays the same", async () => {
    const file = path.join(folder(), 'locked.pdf');
    const plain = new TextDecoder().decode(pdf('secret'));
    const locked = plain.replace(
      '<< /Size 6 /Root 1 0 R >>',
      '<< /Size 6 /Root 1 0 R /Encrypt << /Filter /Standard /V 1 /R 2 /O (0123456789abcdef0123456789abcdef) /U (0123456789abcdef0123456789abcdef) /P -4 >> /ID [<00112233445566778899aabbccddeeff> <00112233445566778899aabbccddeeff>] >>',
    );
    // (a whole second: a file system keeps it exactly)
    const when = 1_700_000_000;
    fs.writeFileSync(file, locked);
    fs.utimesSync(file, when, when);
    await expect(readDocumentFile(file)).rejects.toThrow('password protected');
    // the same size and time, other bytes: what was found the first time stands, with no new read
    fs.writeFileSync(file, plain.padEnd(locked.length, '\n'));
    fs.utimesSync(file, when, when);
    await expect(readDocumentFile(file)).rejects.toThrow('password protected');
    // changed, it is read again
    fs.writeFileSync(file, plain);
    expect((await readDocumentFile(file))?.text).toContain('secret');
  });

  it("says why a document can't be read", async () => {
    const dir = folder();
    fs.writeFileSync(path.join(dir, 'old.doc'), compound());
    await expect(readDocumentPart(path.join(dir, 'old.doc'), 'old.doc')).rejects.toThrow(
      "old.doc can't be read: older Office files",
    );
  });
});
