// Attached files: safe names, only this project's uploads count, and how agents are told about them.
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import type http from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  cleanAttachments,
  cleanName,
  describeAttachments,
  describeAttachmentsRead,
  readAttachments,
  newBatch,
  receive,
  receiveSource,
  cleanOwnedBatch,
  removeUpload,
  safeParts,
  uploadsRoot,
  withAttachments,
  attachmentNames,
} from '../../server/uploads.ts';
import { compound, docx, pdf, xlsx } from './fixtures/documents.ts';

// a request body as receive() reads it
const body = (data: string | Buffer, headers: Record<string, string> = {}) =>
  Object.assign(Readable.from([Buffer.from(data)]), { headers }) as unknown as http.IncomingMessage;

describe('safe names', () => {
  it('drops .. and empty parts, so a path never climbs out of its batch', () => {
    expect(safeParts('../../etc/passwd')).toEqual(['etc', 'passwd']);
    expect(safeParts('docs\\..\\..\\x.md')).toEqual(['docs', 'x.md']);
    expect(safeParts('/abs//a.md')).toEqual(['abs', 'a.md']);
  });

  it('makes names every OS accepts', () => {
    expect(cleanName('a<b>:c|d?.txt')).toBe('a_b__c_d_.txt');
    expect(cleanName('trailing. . ')).toBe('trailing');
    expect(cleanName('CON.txt')).toBe('_CON.txt');
    expect(cleanName('..')).toBe('');
    expect(cleanName('.env')).toBe('.env');
  });
});

describe('receiving files', () => {
  it('shares streaming limits and removes temporary files after overflow or cancellation', async () => {
    const { batch, dir } = newBatch();
    await expect(
      receiveSource(Readable.from([Buffer.from('too long')]), batch, 'large.txt', { maxBytes: 4 }),
    ).rejects.toThrow('over');
    expect(fs.readdirSync(dir)).toEqual([]);
    const abort = new AbortController();
    abort.abort();
    await expect(
      receiveSource(Readable.from([Buffer.from('x')]), batch, 'aborted.txt', { signal: abort.signal }),
    ).rejects.toThrow();
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('cleans only unrecorded files of an owned batch and refuses a batch replaced by a link', async () => {
    const owner = newBatch();
    const retained = await receiveSource(Readable.from([Buffer.from('keep')]), owner.batch, 'keep.txt');
    const orphan = await receiveSource(Readable.from([Buffer.from('orphan')]), owner.batch, 'orphan.txt');
    cleanOwnedBatch(owner.batch, [retained.path]);
    expect(fs.existsSync(retained.path)).toBe(true);
    expect(fs.existsSync(orphan.path)).toBe(false);
    const other = newBatch();
    const victim = await receiveSource(Readable.from([Buffer.from('safe')]), other.batch, 'victim.txt');
    fs.rmSync(owner.dir, { recursive: true });
    fs.symlinkSync(other.dir, owner.dir, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => cleanOwnedBatch(owner.batch, [])).toThrow('Bad upload path');
    await expect(receiveSource(Readable.from([Buffer.from('no')]), owner.batch, 'new.txt')).rejects.toThrow(
      'batch is gone',
    );
    expect(fs.readFileSync(victim.path, 'utf8')).toBe('safe');
  });
  it('saves a file into its batch, and a folder file under its folder', async () => {
    const { batch, dir } = newBatch();
    expect(dir.startsWith(uploadsRoot() + path.sep)).toBe(true);
    const a = await receive(body('hello'), batch, 'notes.md');
    expect(a).toMatchObject({
      kind: 'file',
      name: 'notes.md',
      size: 5,
      path: path.join(dir, 'notes.md'),
      top: path.join(dir, 'notes.md'),
    });
    const b = await receive(body('x'), batch, 'docs/sub/b.txt');
    expect(b.kind).toBe('folder');
    expect(b.top).toBe(path.join(dir, 'docs') + path.sep);
    expect(fs.readFileSync(b.path, 'utf8')).toBe('x');
  });

  it('keeps both when two files have the same name', async () => {
    const { batch, dir } = newBatch();
    await receive(body('1'), batch, 'a.png');
    const second = await receive(body('2'), batch, 'a.png');
    expect(second.path).toBe(path.join(dir, 'a (2).png'));
  });

  it('refuses a batch that does not exist or has a bad id', async () => {
    await expect(receive(body('x'), 'nope-123', 'a.md')).rejects.toThrow(/gone/);
    await expect(receive(body('x'), '../x', 'a.md')).rejects.toThrow(/Bad upload batch/);
  });

  it("takes a file of any size, and keeps a limit a caller passes (a gateway's)", async () => {
    const { batch } = newBatch();
    const big = await receive(body('x', { 'content-length': String(600 * 1024 * 1024) }), batch, 'big.bin');
    expect(fs.readFileSync(big.path, 'utf8')).toBe('x');
    await expect(
      receiveSource(body('x'), batch, 'capped.bin', { declaredBytes: 2 * 1024 * 1024, maxBytes: 1024 * 1024 }),
    ).rejects.toThrow(/over 1 MB/);
  });
});

describe('which attachments count', () => {
  it('only uploads of this project that exist; folders end with a separator', async () => {
    const { batch, dir } = newBatch();
    const f = await receive(body('x'), batch, 'one.md');
    await receive(body('y'), batch, 'pack/two.md');
    const outside = path.join(path.dirname(uploadsRoot()), 'PROJECT.md');
    fs.writeFileSync(outside, '# hi');
    const list = cleanAttachments([
      f.path,
      path.join(dir, 'pack'),
      outside,
      path.join(dir, 'missing.md'),
      42,
      null,
      `${uploadsRoot()}${path.sep}..${path.sep}PROJECT.md`,
    ]);
    expect(list).toEqual([f.path, path.join(dir, 'pack') + path.sep]);
    expect(cleanAttachments('nope')).toEqual([]);
  });

  it('removes only inside uploads/, and the batch folder once it is empty', async () => {
    const { batch, dir } = newBatch();
    const f = await receive(body('x'), batch, 'gone.md');
    expect(removeUpload(f.path)).toBe(true);
    expect(fs.existsSync(dir)).toBe(false);
    expect(() => removeUpload(path.join(uploadsRoot(), '..', 'BRAIN.md'))).toThrow(/Only uploaded files/);
  });
});

describe('telling the agent', () => {
  it('lists where each file and folder is, and can include small text files', async () => {
    const { batch } = newBatch();
    const doc = await receive(body('# Brief\nShip it.'), batch, 'brief.md');
    const img = await receive(body('PNG'), batch, 'shot.png');
    const folder = await receive(body('a'), batch, 'assets/logo.svg');
    const note = describeAttachments([doc.path, img.path, folder.top], { inline: 1000 });
    expect(note).toContain(`- ${doc.path} (text, 16 B)`);
    expect(note).toContain(`- ${img.path} (image, 3 B)`);
    expect(note).toContain('(folder, 1 file, 1 B)');
    expect(note).toContain('    - assets/logo.svg (1 B)');
    expect(note).toContain('--- brief.md ---\n# Brief\nShip it.');
    // without inline, just the list
    expect(describeAttachments([doc.path])).not.toContain('Ship it.');
    expect(attachmentNames([doc.path, folder.top])).toBe('brief.md, assets/');
  });

  it("can include the text of attached documents, or say why one can't be read", async () => {
    const { batch } = newBatch();
    const contract = await receive(body(Buffer.from(pdf('Signed on 3 May'))), batch, 'contract.pdf');
    const brief = await receive(
      body(Buffer.from(docx('<w:p><w:r><w:t>Ship by Friday</w:t></w:r></w:p>'))),
      batch,
      'docs/brief.docx',
    );
    const old = await receive(body(Buffer.from(compound())), batch, 'old.xls');
    const paths = [contract.path, brief.top, old.path];
    const note = await describeAttachmentsRead(paths, { inline: 5000 });
    expect(note).toContain(`- ${contract.path} (PDF, `);
    expect(note).toContain('--- contract.pdf ---\n(PDF, 1 page)\n--- Page 1 ---\nSigned on 3 May');
    // documents in an attached folder too
    expect(note).toContain('--- docs/brief.docx ---\n(Word document)\nShip by Friday');
    expect(note).toContain("--- old.xls ---\n(can't be read: older Office files");
    // the same list as without the text
    expect(note.startsWith(describeAttachments(paths))).toBe(true);
    // without inline, nothing is read
    expect(await describeAttachmentsRead(paths)).toBe(describeAttachments(paths));
  });

  it("keeps documents' text within inline, after the text files before them", async () => {
    const { batch } = newBatch();
    const notes = await receive(body('n'.repeat(900)), batch, 'notes.md');
    const rows = Array.from(
      { length: 200 },
      (_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>${1000 + i}</v></c></row>`,
    ).join('');
    const sheet = await receive(body(Buffer.from(xlsx({ Totals: rows }))), batch, 'totals.xlsx');
    const note = await describeAttachmentsRead([notes.path, sheet.path], { inline: 1500 });
    expect(note).toContain('--- totals.xlsx (start) ---\n(Excel workbook, sheet: Totals)');
    const inlined = note.slice(note.indexOf('--- notes.md'));
    expect(inlined.length).toBeLessThan(1500 + 200);
  });

  it('says which documents went along whole, and where to read the rest of the others', async () => {
    const { batch } = newBatch();
    const short = await receive(
      body(Buffer.from(docx('<w:p><w:r><w:t>Ship by Friday</w:t></w:r></w:p>'))),
      batch,
      'short.docx',
    );
    const long = await receive(
      body(Buffer.from(docx(`<w:p><w:r><w:t>${'word '.repeat(800)}</w:t></w:r></w:p>`))),
      batch,
      'long.docx',
    );
    const scan = await receive(body(Buffer.from(pdf(''))), batch, 'scan.pdf');
    const read = await readAttachments([short.path, scan.path, long.path], { inline: 2000, rest: 'read_document' });
    expect([...read.whole]).toEqual([short.path]);
    expect(read.text).toContain('--- long.docx (start) ---');
    expect(read.text).toContain('read it with read_document');
    // all there: nothing to point to
    const all = await readAttachments([short.path], { inline: 2000, rest: 'read_document' });
    expect(all.text).not.toContain('read_document');
  });

  it('stops reading documents when told to', async () => {
    const { batch } = newBatch();
    const contract = await receive(body(Buffer.from(pdf('Signed on 3 May, again'))), batch, 'contract-2.pdf');
    const stop = new AbortController();
    stop.abort(new Error('Stopped.'));
    await expect(describeAttachmentsRead([contract.path], { inline: 5000, signal: stop.signal })).rejects.toThrow(
      'Stopped.',
    );
  });

  it('adds the list to the message, and says to look when there is no text', async () => {
    const { batch } = newBatch();
    const f = await receive(body('x'), batch, 'a.csv');
    expect(withAttachments('Sum this', [f.path])).toMatch(/^Sum this\n\n\[Attached files/);
    expect(withAttachments('', [f.path])).toMatch(/^Have a look at what I attached\./);
    expect(withAttachments('Just text', [])).toBe('Just text');
  });
});
