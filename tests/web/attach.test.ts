import { describe, expect, it } from 'vitest';
import { attachmentChips, baseName, filesFromDrop, filesFromInput, isFolderPath } from '../../web/attach.ts';

// A stand-in for the browser's FileSystemEntry tree (happy-dom has no drag and drop).
type Fake = { name: string; children?: Fake[] };
function entry(f: Fake): FileSystemEntry {
  if (!f.children)
    return { name: f.name, isFile: true, isDirectory: false, file: (ok: (file: File) => void) => ok(new File([f.name], f.name)) } as unknown as FileSystemEntry;
  const kids = f.children.map(entry);
  return {
    name: f.name,
    isFile: false,
    isDirectory: true,
    // like the real thing: a few at a time, then an empty list
    createReader: () => {
      let at = 0;
      return { readEntries: (ok: (list: FileSystemEntry[]) => void) => ok(kids.slice(at, (at += 2))) };
    },
  } as unknown as FileSystemEntry;
}
const drop = (...tops: Fake[]) => {
  const entries = tops.map(entry);
  return { items: entries.map((e) => ({ kind: 'file', webkitGetAsEntry: () => e })), files: [] } as unknown as DataTransfer;
};

describe('filesFromDrop()', () => {
  it('walks dropped folders, keeping each file’s path inside the folder', async () => {
    const picked = await filesFromDrop(
      drop(
        { name: 'brief.md' },
        { name: 'site', children: [{ name: 'index.html' }, { name: 'img', children: [{ name: 'a.png' }, { name: 'b.png' }, { name: 'c.png' }] }, { name: '.DS_Store' }, { name: 'node_modules', children: [{ name: 'x.js' }] }, { name: '.git', children: [{ name: 'HEAD' }] }] },
      ),
    );
    expect(picked.map((p) => p.rel)).toEqual(['brief.md', 'site/index.html', 'site/img/a.png', 'site/img/b.png', 'site/img/c.png']);
    expect(picked[0].file.name).toBe('brief.md');
  });

  it('uses the plain file list when the browser gives no entries', async () => {
    const files = [new File(['a'], 'a.txt'), new File(['b'], 'Thumbs.db')];
    const picked = await filesFromDrop({ items: [], files } as unknown as DataTransfer);
    expect(picked.map((p) => p.rel)).toEqual(['a.txt']);
  });
});

describe('filesFromInput()', () => {
  it('keeps a picked folder’s paths', () => {
    const f = new File(['x'], 'a.md');
    Object.defineProperty(f, 'webkitRelativePath', { value: 'notes/a.md' });
    expect(filesFromInput([f, new File(['y'], 'b.md')] as unknown as FileList).map((p) => p.rel)).toEqual(['notes/a.md', 'b.md']);
    expect(filesFromInput(null)).toEqual([]);
  });
});

describe('attachment chips on a message', () => {
  it('shows images as thumbnails, files as links and folders as names', () => {
    const el = attachmentChips(['/p/uploads/b/shot.png', '/p/uploads/b/brief.pdf', 'C:\\p\\uploads\\b\\assets\\'])!;
    expect(el.querySelector('a.att-img img')!.getAttribute('src')).toBe(`/api/file?path=${encodeURIComponent('/p/uploads/b/shot.png')}`);
    expect([...el.querySelectorAll('.att-name')].map((n) => n.textContent)).toEqual(['brief.pdf', 'assets/']);
    expect(el.querySelector('span.att-chip')!.tagName).toBe('SPAN');
    expect(attachmentChips([])).toBeNull();
  });

  it('tells folders from files by the trailing separator', () => {
    expect(isFolderPath('/a/docs/')).toBe(true);
    expect(isFolderPath('C:\\a\\docs\\')).toBe(true);
    expect(isFolderPath('/a/Makefile')).toBe(false);
    expect(baseName('C:\\a\\docs\\')).toBe('docs');
  });
});
