// A very long Markdown file: cut between its blocks, and only the pieces near the screen are drawn.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { md, mdChunks } from '../../web/core.ts';
import { MAX_MARKDOWN_BYTES, markdownTooBig, previewMarkdown, showMarkdown } from '../../web/filepreview.ts';
import { BIG_MARKDOWN } from '../../web/ui/bigmarkdown.tsx';

// (the dialog draws outside act, as in the page)
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;

const section = (i: number) => `## Part ${i}\n\nSome words for part ${i}, with a [link][ref] and a table:\n\n| a | b |\n|---|---|\n| ${i} | x |\n\n${'More text to read. '.repeat(40)}\n`;
const longDoc = (n: number) => `# Big\n\n${Array.from({ length: n }, (_, i) => section(i)).join('\n')}\n[ref]: https://example.com/ref\n`;

describe('mdChunks()', () => {
  it('cuts a text between its blocks, and every piece reads as it would in the whole', () => {
    const text = longDoc(40);
    const chunks = mdChunks(text, 3000);
    expect(chunks.length).toBeGreaterThan(5);
    expect(chunks.reduce((n, c) => n + c.raw.length, 0)).toBe(text.length);
    const pieces = chunks.map((c) => c.render());
    expect(pieces.every((p) => p.classList.contains('md'))).toBe(true);
    // a [link][by name] finds its address even when the address is in another piece
    const links = pieces.flatMap((p) => [...p.querySelectorAll('a')]).filter((a) => a.textContent === 'link');
    expect(links).toHaveLength(40);
    expect(links.every((a) => a.getAttribute('href') === 'https://example.com/ref' && a.target === '_blank')).toBe(true);
    // (tables get the same sideways-scrolling box as md() gives them)
    expect(pieces.flatMap((p) => [...p.querySelectorAll('.md-table')])).toHaveLength(40);
    // (by text: happy-dom's sanitizer drops a first element, a heading that starts a piece)
    const read = pieces.map((p) => p.textContent).join('');
    expect(Array.from({ length: 40 }, (_, i) => `Part ${i}`).every((t) => read.includes(t))).toBe(true);
  });

  it('keeps a list or a code block in one piece, and sanitizes like md()', () => {
    const text = `${'- item\n'.repeat(500)}\n\`\`\`\n${'code\n'.repeat(500)}\`\`\`\n\n<img src=x onerror="alert(1)">\n`;
    const chunks = mdChunks(text, 100);
    const pieces = chunks.map((c) => c.render());
    // (counted by items and lines: happy-dom's sanitizer drops a first <ul> or <pre>)
    expect(pieces.map((p) => p.querySelectorAll('li').length).filter(Boolean)).toEqual([500]);
    expect(pieces.map((p) => p.querySelectorAll('code').length).filter(Boolean)).toEqual([1]);
    expect(pieces.map((p) => p.innerHTML).join('')).not.toContain('onerror');
    expect(md(text).querySelectorAll('li')).toHaveLength(500);
  });

  it('cuts a code block too long for one piece, and each piece still draws it as code', () => {
    const text = `Before\n\n\`\`\`ts\n${'const x = 1; // a line of code\n'.repeat(20_000)}\`\`\`\n\nAfter [link][ref]\n\n[ref]: https://example.com/ref\n`;
    const chunks = mdChunks(text, 100);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.reduce((n, c) => n + c.raw.length, 0)).toBe(text.length);
    const pieces = chunks.map((c) => c.render());
    // every piece with code lines has them inside a code block, none as plain text
    const withCode = pieces.filter((p) => p.textContent!.includes('const x'));
    expect(withCode.length).toBeGreaterThan(1);
    expect(withCode.every((p) => [...p.querySelectorAll('p')].every((n) => !n.textContent!.includes('const x')))).toBe(true);
    expect(withCode.every((p) => p.querySelector('code'))).toBe(true);
    // after the cut block the text reads as Markdown again
    expect(pieces.at(-1)!.querySelector('a')!.getAttribute('href')).toBe('https://example.com/ref');
  });

  it('cuts one huge line without line breaks at its spaces', () => {
    const text = 'word '.repeat(200_000);
    const chunks = mdChunks(text);
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.reduce((n, c) => n + c.raw.length, 0)).toBe(text.length);
    expect(chunks.every((c) => c.raw.endsWith(' '))).toBe(true);
  });
});

describe('a Markdown file too big to read', () => {
  beforeEach(() => (document.body.innerHTML = '<div id="modal-root"></div><div id="toasts"></div>'));
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('says so instead of loading it', async () => {
    const text = vi.fn(async () => '# never read');
    const cancel = vi.fn(async () => undefined);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, headers: new Headers({ 'content-length': String(MAX_MARKDOWN_BYTES + 1) }), text, body: { cancel } })));
    await previewMarkdown('/x/huge.md', 'huge.md');
    expect(text).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalled();
    expect(document.querySelector('.modal-body')).toBeNull();
    expect(markdownTooBig('huge.md', 10)).toBe(false);
  });
});

describe('a Markdown file preview', () => {
  // happy-dom draws nothing, so give it a layout: a 400px dialog body, each piece 300px tall
  const VIEW = 400;
  const PIECE = 300;
  const tops = new WeakMap<Element, number>();
  const isBody = (el: Element) => el.classList.contains('modal-body');
  const total = (el: Element) => parseFloat(el.querySelector<HTMLElement>('.md-window')?.style.height || '0');
  beforeEach(() => {
    document.body.innerHTML = '<div id="modal-root"></div><div id="toasts"></div>';
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return isBody(this) ? VIEW : this.hasAttribute('data-index') ? PIECE : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return isBody(this) ? 800 : 0;
    });
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const height = isBody(this) ? VIEW : this.hasAttribute('data-index') ? PIECE : 0;
      return { width: isBody(this) ? 800 : 0, height, top: 0, left: 0, right: 0, bottom: height, x: 0, y: 0, toJSON: () => ({}) };
    });
    vi.spyOn(Element.prototype, 'scrollTop', 'get').mockImplementation(function (this: Element) {
      return tops.get(this) ?? 0;
    });
    vi.spyOn(Element.prototype, 'scrollTop', 'set').mockImplementation(function (this: Element, v: number) {
      tops.set(this, v);
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });
  const rest = () => new Promise((r) => setTimeout(r, 200));
  const parts = () => [...document.querySelectorAll('.md-window .md')].flatMap((p) => [...(p.textContent || '').matchAll(/Part \d+/g)].map((m) => m[0]));

  it('a short file is drawn whole, as before', async () => {
    showMarkdown('notes.md', '# Notes\n\nHello');
    await rest();
    expect(document.querySelector('.modal-body .md.md-doc')!.textContent).toContain('Hello');
    expect(document.querySelector('.md-window')).toBeNull();
  });

  it('a huge file draws only the pieces near the screen; scrolling draws the others', async () => {
    const text = longDoc(1200);
    expect(text.length).toBeGreaterThan(BIG_MARKDOWN * 5);
    showMarkdown('big.md', text);
    await rest();
    expect(document.querySelector('.modal-back.doc')).not.toBeNull();
    // (the window is sized for the whole file, so the scrollbar is right)
    expect(total(document.body)).toBeGreaterThan(100_000);
    const first = parts();
    expect(first.length).toBeGreaterThan(0);
    expect(first.length).toBeLessThan(100);
    expect(first).not.toContain('Part 1199');
    const body = document.querySelector<HTMLElement>('.modal-body')!;
    body.scrollTop = total(document.body) - VIEW;
    body.dispatchEvent(new Event('scroll'));
    await rest();
    expect(parts()).toContain('Part 1199');
    expect(parts()).not.toContain('Part 0');
  });
});
