// Previews of the files a chat mentions, each with Show in Explorer / Finder below it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  filePreviews,
  forgetFiles,
  mentionPreviews,
  previewFile,
  previewKind,
  previewTitle,
  revealLabel,
} from '../../web/filepreview.tsx';
import { state } from '../../web/core.ts';
import type { AppState } from '../../shared/types.ts';

const FILES: Record<string, { kind: string; size: number }> = {
  '/w/shot.png': { kind: 'image', size: 2048 },
  '/w/clip.mp4': { kind: 'video', size: 3_500_000 },
  '/w/song.mp3': { kind: 'audio', size: 100 },
  '/w/plan.pdf': { kind: 'file', size: 12 },
  '/w/notes.md': { kind: 'file', size: 9 },
  '/w/data.csv': { kind: 'file', size: 9 },
  '/w/renders': { kind: 'folder', size: 0 },
  '/w/ship.glb': { kind: 'model', size: 5_000 },
  '/w/huge.glb': { kind: 'model', size: 80 * 1024 * 1024 },
};
let calls: { url: string; body: { paths?: string[]; path?: string } }[] = [];

beforeEach(() => {
  calls = [];
  forgetFiles();
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init?.body || '{}'));
    calls.push({ url, body });
    if (url === '/api/file?path=%2Fw%2Fnotes.md') return new Response('# Notes\n\nHello');
    if (url === '/api/files/info')
      return new Response(
        JSON.stringify(
          body.paths.map((p: string) =>
            FILES[p]
              ? { path: p, ok: true, name: p.split('/').pop(), modified: 0, ...FILES[p] }
              : { path: p, ok: false },
          ),
        ),
      );
    return new Response(JSON.stringify({ ok: true }));
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

const settle = () => new Promise((r) => setTimeout(r, 60));

describe('filePreviews()', () => {
  it('shows each kind of file with Show in Explorer / Finder below it, in one lookup', async () => {
    const box = filePreviews([
      '/w/shot.png',
      '/w/clip.mp4',
      '/w/song.mp3',
      '/w/plan.pdf',
      '/w/renders',
      '/w/missing.png',
    ]);
    document.body.append(box);
    expect(box.classList.contains('hidden')).toBe(true);
    await expect.poll(() => box.querySelectorAll('.fp-card').length).toBe(5);
    expect(calls.filter((c) => c.url === '/api/files/info')).toHaveLength(1);
    expect(box.classList.contains('hidden')).toBe(false);
    const cards = [...box.querySelectorAll('.fp-card')];
    expect(cards.map((c) => c.className.split(' ').find((x) => x.startsWith('fp-kind-')))).toEqual([
      'fp-kind-image',
      'fp-kind-video',
      'fp-kind-audio',
      'fp-kind-file',
      'fp-kind-folder',
    ]);
    // (a card never shares a class with what is inside it: "fp-file" is the file link's)
    expect(cards.some((c) => c.classList.contains('fp-file'))).toBe(false);
    expect(box.querySelector('img')!.getAttribute('src')).toBe('/api/file?path=%2Fw%2Fshot.png');
    expect(box.querySelector('video')!.hasAttribute('controls')).toBe(true);
    expect(box.querySelector('audio')).not.toBeNull();
    // the button sits below the preview, in the card's bar
    for (const c of cards) {
      const bar = c.querySelector('.fp-bar')!;
      expect(c.lastElementChild).toBe(bar);
      expect(bar.querySelector('.fp-reveal')!.textContent).toBe(revealLabel());
    }
    expect(cards[1].querySelector('.fp-size')!.textContent).toBe('3.5 MB');
  });

  it('shows a 3D model in a viewer box, and only offers a download when it is too big', async () => {
    const box = filePreviews(['/w/ship.glb', '/w/huge.glb']);
    document.body.append(box);
    await expect.poll(() => box.querySelectorAll('.fp-card').length).toBe(2);
    const cards = [...box.querySelectorAll('.fp-card')];
    expect(cards.map((c) => c.className.split(' ').find((x) => x.startsWith('fp-kind-')))).toEqual([
      'fp-kind-model',
      'fp-kind-model',
    ]);
    expect(cards[0].querySelector('.fp-model')).not.toBeNull();
    expect(cards[0].querySelector('.fp-reveal')).not.toBeNull();
    // 80 MB: not loaded at all, said in words
    expect(cards[1].querySelector('.fp-model-note')!.textContent).toMatch(/80 MB, too big to show here/);
    // and it can be downloaded right there (BH-153)
    const link = cards[1].querySelector<HTMLAnchorElement>('.fp-model-download')!;
    expect(link.getAttribute('href')).toBe('/api/file?path=%2Fw%2Fhuge.glb');
    expect(link.getAttribute('download')).toBe('huge.glb');
    expect(cards[1].querySelector('canvas')).toBeNull();
  });

  it('Show in Explorer / Finder asks the server to reveal that file', async () => {
    const box = filePreviews(['/w/plan.pdf']);
    document.body.append(box);
    await expect.poll(() => box.querySelector('.fp-reveal')).not.toBeNull();
    (box.querySelector('.fp-reveal') as HTMLButtonElement).click();
    await settle();
    expect(calls.at(-1)).toEqual({ url: '/api/files/reveal', body: { path: '/w/plan.pdf' } });
  });

  it('stays hidden when none of the files may be shown', async () => {
    const box = filePreviews(['/w/nope.png']);
    await settle();
    expect(box.classList.contains('hidden')).toBe(true);
    expect(box.children).toHaveLength(0);
  });

  it('a file looked up once is not asked about again', async () => {
    filePreviews(['/w/shot.png']);
    await settle();
    filePreviews(['/w/shot.png']);
    await settle();
    expect(calls.filter((c) => c.url === '/api/files/info')).toHaveLength(1);
  });
});

describe('mentionPreviews()', () => {
  it('previews the files a message mentions and the ones sent with it', async () => {
    const box = mentionPreviews('Saved to /w/clip.mp4', ['/w/shot.png'])!;
    await expect.poll(() => box.querySelectorAll('.fp-name').length).toBe(2);
    expect([...box.querySelectorAll('.fp-name')].map((n) => n.textContent)).toEqual(['shot.png', 'clip.mp4']);
  });

  it('nothing to preview: null; the same message gets the same box back', () => {
    expect(mentionPreviews('no files here')).toBeNull();
    const a = mentionPreviews('see /w/shot.png', [], { key: 'm1' });
    expect(mentionPreviews('see /w/shot.png', [], { key: 'm1' })).toBe(a);
    expect(mentionPreviews('see /w/shot.png', [], { key: 'm2' })).not.toBe(a);
  });
});

describe('keyboard and later files', () => {
  it('a previewed image opens big with Enter or Space, and says so to screen readers', async () => {
    // (the page's dialog layer, as in public/index.html)
    document.body.append(Object.assign(document.createElement('div'), { id: 'modal-root' }));
    const box = filePreviews(['/w/shot.png']);
    document.body.append(box);
    await expect.poll(() => box.querySelector('img')).not.toBeNull();
    const img = box.querySelector('img')!;
    expect(img.getAttribute('role')).toBe('button');
    expect(img.tabIndex).toBe(0);
    expect(img.getAttribute('aria-label')).toBe('Show shot.png bigger');
    img.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(document.querySelector('.lightbox, .lb, [class*="light"]')).not.toBeNull();
  });

  it('a message whose file was not there yet looks again later (the file may have been written since)', async () => {
    const t0 = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(t0);
    const first = mentionPreviews('see /w/later.png', [], { key: 'dock:m9' })!;
    await settle();
    expect(first.classList.contains('hidden')).toBe(true);
    // now it exists
    FILES['/w/later.png'] = { kind: 'image', size: 1 };
    now.mockReturnValue(t0 + 16_000);
    const again = mentionPreviews('see /w/later.png', [], { key: 'dock:m9' })!;
    expect(again).not.toBe(first);
    await expect.poll(() => again.classList.contains('hidden')).toBe(false);
    expect(again.classList.contains('hidden')).toBe(false);
    now.mockRestore();
    delete FILES['/w/later.png'];
  });

  it('a message with one of its two files there looks again later for the other (BH-152)', async () => {
    const t0 = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(t0);
    const text = 'Saved /w/shot.png and /w/second.png';
    const first = mentionPreviews(text, [], { key: 'dock:m10' })!;
    await expect.poll(() => first.classList.contains('hidden')).toBe(false);
    expect(first.querySelectorAll('.fp-kind-image')).toHaveLength(1);
    // the second is written a moment later
    FILES['/w/second.png'] = { kind: 'image', size: 1 };
    now.mockReturnValue(t0 + 5_000);
    expect(mentionPreviews(text, [], { key: 'dock:m10' })).toBe(first);
    now.mockReturnValue(t0 + 16_000);
    const again = mentionPreviews(text, [], { key: 'dock:m10' })!;
    expect(again).not.toBe(first);
    await expect.poll(() => again.querySelectorAll('.fp-kind-image').length).toBe(2);
    // all found: kept from now on
    now.mockReturnValue(t0 + 60_000);
    expect(mentionPreviews(text, [], { key: 'dock:m10' })).toBe(again);
    now.mockRestore();
    delete FILES['/w/second.png'];
  });
});

describe('revealLabel()', () => {
  it('names the file manager of this computer', () => {
    const platform = vi.spyOn(navigator, 'platform', 'get');
    platform.mockReturnValue('Win32');
    expect(revealLabel()).toBe('Show in Explorer');
    platform.mockReturnValue('MacIntel');
    expect(revealLabel()).toBe('Show in Finder');
    platform.mockReturnValue('Linux x86_64');
    expect(revealLabel()).toBe('Show in folder');
    platform.mockRestore();
  });
});

describe('opening attached files', () => {
  beforeEach(() => document.body.append(Object.assign(document.createElement('div'), { id: 'modal-root' })));

  it('Markdown opens to read, a PDF in a new tab, anything else downloads; only the ones that open light up', async () => {
    const box = filePreviews(['/w/notes.md', '/w/plan.pdf', '/w/data.csv']);
    document.body.append(box);
    await expect.poll(() => box.querySelectorAll('.fp-card').length).toBe(3);
    const [md, pdf, csv] = [...box.querySelectorAll<HTMLElement>('.fp-card')];
    expect(md.className).toContain('hover:border-line-2');
    expect(pdf.className).toContain('hover:border-line-2');
    expect(csv.className).not.toContain('hover:border-line-2');
    const link = pdf.querySelector('a.fp-file')!;
    expect(link.getAttribute('href')).toBe('/api/file?path=%2Fw%2Fplan.pdf&view=1');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(csv.querySelector('a.fp-file')!.getAttribute('href')).toBe('/api/file?path=%2Fw%2Fdata.csv');
    const read = md.querySelector<HTMLButtonElement>('button.fp-file')!;
    expect(read.className).toContain('cursor-pointer');
    read.click();
    await expect.poll(() => document.querySelector('.modal-body .md.md-doc')?.textContent).toContain('Hello');
    expect(document.querySelector('.modal-head h2')!.textContent).toBe('notes.md');
    expect(document.querySelector('.modal-body .md.md-doc')!.textContent).toContain('Hello');
  });

  it('opens no file in another program outside the desktop app', async () => {
    const box = filePreviews(['/w/data.csv', '/w/shot.png']);
    document.body.append(box);
    await expect.poll(() => box.querySelectorAll('.fp-card').length).toBe(2);
    expect(box.querySelector('.fp-open')).toBeNull();
    expect(previewTitle('data.csv')).toBeNull();
  });

  it('knows which files can be looked at', () => {
    expect(['a.PNG', 'b.md', 'c.markdown', 'd.pdf', 'e.txt', 'f'].map(previewKind)).toEqual([
      'image',
      'markdown',
      'markdown',
      'pdf',
      null,
      null,
    ]);
  });
});

describe('in the desktop app', () => {
  beforeEach(() => (state.data = { desktop: true } as AppState));
  afterEach(() => (state.data = null));
  const opened = () => calls.filter((c) => c.url === '/api/files/open').map((c) => c.body.path);

  it('a PDF or any other file opens in its own program instead of a tab or a download', async () => {
    const box = filePreviews(['/w/plan.pdf', '/w/data.csv']);
    document.body.append(box);
    await expect.poll(() => box.querySelectorAll('.fp-card').length).toBe(2);
    const [pdf, csv] = [...box.querySelectorAll<HTMLElement>('.fp-card')];
    expect(box.querySelector('a.fp-file')).toBeNull();
    expect(csv.className).toContain('hover:border-line-2');
    pdf.querySelector<HTMLButtonElement>('button.fp-file')!.click();
    csv.querySelector<HTMLButtonElement>('button.fp-file')!.click();
    await settle();
    expect(opened()).toEqual(['/w/plan.pdf', '/w/data.csv']);
  });

  it('every file gets an Open button next to Show in Explorer / Finder; folders do not', async () => {
    const box = filePreviews(['/w/shot.png', '/w/clip.mp4', '/w/renders']);
    document.body.append(box);
    await expect.poll(() => box.querySelectorAll('.fp-card').length).toBe(3);
    const [img, vid, dir] = [...box.querySelectorAll<HTMLElement>('.fp-card')];
    expect(dir.querySelector('.fp-open')).toBeNull();
    img.querySelector<HTMLButtonElement>('.fp-open')!.click();
    vid.querySelector<HTMLButtonElement>('.fp-open')!.click();
    await settle();
    expect(opened()).toEqual(['/w/shot.png', '/w/clip.mp4']);
  });

  it('previewFile opens what the page cannot show; pictures still open big here', async () => {
    previewFile('/w/data.csv', 'data.csv');
    previewFile('/w/plan.pdf', 'plan.pdf');
    await settle();
    expect(opened()).toEqual(['/w/data.csv', '/w/plan.pdf']);
    expect(['a.png', 'b.md', 'c.pdf', 'd.zip'].map(previewTitle)).toEqual([
      'Show a.png bigger',
      'Read b.md',
      'Open c.pdf',
      'Open d.zip',
    ]);
  });
});
