// Attached files: safe names, only this project's uploads count, and how agents are told about them.
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import type http from 'node:http';
import { describe, expect, it } from 'vitest';
import { cleanAttachments, cleanName, describeAttachments, newBatch, receive, removeUpload, safeParts, uploadsRoot, withAttachments, attachmentNames } from '../../server/uploads.ts';
import { expandImages } from '../../server/engines/openai.ts';
import type { LlmMessage } from '../../server/engines/openai.ts';

// a request body as receive() reads it
const body = (data: string | Buffer, headers: Record<string, string> = {}) => Object.assign(Readable.from([Buffer.from(data)]), { headers }) as unknown as http.IncomingMessage;

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
  it('saves a file into its batch, and a folder file under its folder', async () => {
    const { batch, dir } = newBatch();
    expect(dir.startsWith(uploadsRoot() + path.sep)).toBe(true);
    const a = await receive(body('hello'), batch, 'notes.md');
    expect(a).toMatchObject({ kind: 'file', name: 'notes.md', size: 5, path: path.join(dir, 'notes.md'), top: path.join(dir, 'notes.md') });
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

  it('refuses a file that says it is too big', async () => {
    const { batch } = newBatch();
    await expect(receive(body('x', { 'content-length': String(600 * 1024 * 1024) }), batch, 'big.bin')).rejects.toThrow(/over 500 MB/);
  });
});

describe('which attachments count', () => {
  it('only uploads of this project that exist; folders end with a separator', async () => {
    const { batch, dir } = newBatch();
    const f = await receive(body('x'), batch, 'one.md');
    await receive(body('y'), batch, 'pack/two.md');
    const outside = path.join(path.dirname(uploadsRoot()), 'PROJECT.md');
    fs.writeFileSync(outside, '# hi');
    const list = cleanAttachments([f.path, path.join(dir, 'pack'), outside, path.join(dir, 'missing.md'), 42, null, `${uploadsRoot()}${path.sep}..${path.sep}PROJECT.md`]);
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

  it('adds the list to the message, and says to look when there is no text', async () => {
    const { batch } = newBatch();
    const f = await receive(body('x'), batch, 'a.csv');
    expect(withAttachments('Sum this', [f.path])).toMatch(/^Sum this\n\n\[Attached files/);
    expect(withAttachments('', [f.path])).toMatch(/^Have a look at what I attached\./);
    expect(withAttachments('Just text', [])).toBe('Just text');
  });
});

describe('images for API models', () => {
  it('reads attached images as data URLs, or sends a note when the model has no vision', async () => {
    const { batch } = newBatch();
    const img = await receive(body('PNGDATA'), batch, 'pic.png');
    const msgs: LlmMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'Look' }, { type: 'image_url', image_url: { url: `dash-file:${img.path}` } }] }];
    const seen = expandImages(msgs, true)[0];
    expect(seen.role === 'user' && Array.isArray(seen.content) && seen.content[1]).toEqual({ type: 'image_url', image_url: { url: `data:image/png;base64,${Buffer.from('PNGDATA').toString('base64')}` } });
    const blind = expandImages(msgs, false)[0];
    expect(blind.content).toBe("Look\n\n(image pic.png attached; this model can't see images)");
    // the stored history keeps the file reference, not the image data
    expect(JSON.stringify(msgs)).not.toContain('base64');
  });
});
