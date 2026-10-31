// Ctrl+F (⌘F) in a Markdown preview and in a long chat: a search box, the number of matches, and Enter for the next.
import { useRef } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { searchText } from '../../web/chat/messages.ts';
import { showMarkdown } from '../../web/filepreview.tsx';
import { countIn, textRanges, useFind } from '../../web/ui/find.tsx';

// (the dialog draws outside act, as in the page)
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;

const rest = (ms = 250) => new Promise((r) => setTimeout(r, ms));
const key = (k: string, init: KeyboardEventInit = {}, on: EventTarget = document) => on.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));
const box = () => document.querySelector<HTMLInputElement>('[role="search"] input');
const count = () => document.querySelector('[role="search"] [aria-live]')!.textContent;
const type = async (text: string) => {
  const input = box()!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await rest();
};

beforeEach(() => {
  document.body.innerHTML = '<div id="modal-root"></div><div id="toasts"></div>';
});
afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('finding text', () => {
  it('countIn() and textRanges() ignore case, and skip what is not text to read', () => {
    expect(countIn('Foo foo FOO', 'foo')).toBe(3);
    expect(countIn('anything', '')).toBe(0);
    const div = document.createElement('div');
    div.innerHTML = '<p>Apple pie, apple tart</p><textarea>apple</textarea><div data-find-skip>apple</div>';
    expect(textRanges(div, 'APPLE')).toHaveLength(2);
  });
});

describe('Ctrl+F in a Markdown preview', () => {
  const open = async () => {
    showMarkdown('notes.md', '# Notes\n\nThe cat sat. The cat ran.\n\nA dog barked at the Cat.');
    await rest();
  };

  it('opens a search box, counts the matches and moves between them', async () => {
    await open();
    expect(box()).toBeNull();
    key('f', { ctrlKey: true });
    await rest(50);
    expect(box()).not.toBeNull();
    await type('cat');
    expect(count()).toBe('1 / 3');
    key('Enter', {}, box()!);
    await rest(50);
    expect(count()).toBe('2 / 3');
    key('Enter', { shiftKey: true }, box()!);
    key('Enter', { shiftKey: true }, box()!);
    await rest(50);
    expect(count()).toBe('3 / 3');
    await type('zebra');
    expect(count()).toBe('None');
  });

  it('⌘F does the same, and Esc closes the box without closing the dialog', async () => {
    await open();
    key('f', { metaKey: true });
    await rest(50);
    expect(box()).not.toBeNull();
    key('Escape', {}, box()!);
    await rest(50);
    expect(box()).toBeNull();
    expect(document.querySelector('.modal-body')).not.toBeNull();
  });

  it('leaves Ctrl+F to the browser when there is nothing to search', () => {
    const e = new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true });
    document.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
  });
});

describe('Ctrl+F in a huge Markdown file', () => {
  const VIEW = 400;
  const PIECE = 300;
  const tops = new WeakMap<Element, number>();
  const isBody = (el: Element) => el.classList.contains('modal-body');
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return isBody(this) ? VIEW : this.hasAttribute('data-index') ? PIECE : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return isBody(this) ? 800 : 0;
    });
    // (the virtualizer reads the scroller's client size for the window it can see)
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return isBody(this) ? VIEW : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
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
      const was = tops.get(this) ?? 0;
      tops.set(this, v);
      // (a real scroll fires 'scroll'; the virtualizer only hears the new offset from it)
      if (v !== was) this.dispatchEvent(new Event('scroll'));
    });
    vi.spyOn(Element.prototype, 'scrollTo').mockImplementation(function (this: Element, a?: ScrollToOptions | number) {
      if (typeof a === 'object' && a.top != null) {
        tops.set(this, a.top);
        this.dispatchEvent(new Event('scroll'));
      }
    });
  });

  it('finds a word that is far from the screen, and scrolls to draw it', async () => {
    const filler = (i: number) => `## Part ${i}\n\n${'Ordinary words to read here. '.repeat(30)}\n`;
    const text = `${Array.from({ length: 600 }, (_, i) => filler(i)).join('\n')}\n\nThe needle is here.\n\n${Array.from({ length: 50 }, (_, i) => filler(1000 + i)).join('\n')}`;
    showMarkdown('big.md', text);
    await rest();
    const drawn = () => document.querySelector('.md-window')!.textContent!;
    expect(drawn()).not.toContain('needle');
    key('f', { ctrlKey: true });
    await rest(50);
    await type('needle');
    await rest(300);
    expect(count()).toBe('1 / 1');
    expect(drawn()).toContain('needle');
  });
});

// ---------- lists on a page of their own ----------
function Lists({ a, b }: { a: string; b?: string }) {
  const one = useRef<HTMLDivElement>(null);
  const two = useRef<HTMLDivElement>(null);
  const findOne = useFind(one);
  const findTwo = useFind(two);
  return (
    <>
      <section id="one">
        {findOne}
        <div ref={one} dangerouslySetInnerHTML={{ __html: a }} />
        <input id="in-one" />
      </section>
      {b !== undefined ? (
        <section id="two">
          {findTwo}
          <div ref={two} dangerouslySetInnerHTML={{ __html: b }} />
          <input id="in-two" />
        </section>
      ) : null}
    </>
  );
}
let root: Root | null = null;
const draw = async (a: string, b?: string) => {
  const host = document.getElementById('app') ?? document.body.appendChild(Object.assign(document.createElement('div'), { id: 'app' }));
  root ??= createRoot(host);
  root.render(<Lists a={a} b={b} />);
  await rest(50);
};
const barIn = (id: string) => document.querySelector(`#${id} [role="search"]`);
afterEach(() => {
  root?.unmount();
  root = null;
});

describe('which list Ctrl+F searches', () => {
  it('the one you are typing in, else the one under the pointer, else the last drawn', async () => {
    await draw('<p>cat</p>', '<p>cat</p>');
    document.querySelector<HTMLInputElement>('#in-one')!.focus();
    key('f', { ctrlKey: true });
    await rest(50);
    expect(barIn('one')).not.toBeNull();
    expect(barIn('two')).toBeNull();
    key('Escape', {}, box()!);
    await rest(50);
    // nothing focused in either: where the pointer is
    (document.activeElement as HTMLElement).blur();
    document.querySelector('#two p')!.dispatchEvent(new Event('pointerover', { bubbles: true }));
    key('f', { ctrlKey: true });
    await rest(50);
    expect(barIn('two')).not.toBeNull();
    expect(barIn('one')).toBeNull();
    key('Escape', {}, box()!);
    await rest(50);
    document.querySelector('#two p')!.dispatchEvent(new Event('pointerover', { bubbles: true }));
    document.body.dispatchEvent(new Event('pointerover', { bubbles: true }));
    key('f', { ctrlKey: true });
    await rest(50);
    expect(barIn('two')).not.toBeNull();
  });

  it('a list that is gone is not searched', async () => {
    await draw('<p>cat</p>', '<p>cat</p>');
    await draw('<p>cat</p>');
    key('f', { ctrlKey: true });
    await rest(50);
    expect(barIn('one')).not.toBeNull();
  });
});

describe('the search box on a list', () => {
  it('opens the closed tool card a match is in', async () => {
    await draw('<p>intro</p><details><summary>read_file</summary><p>the hidden needle</p></details>');
    key('f', { ctrlKey: true });
    await rest(50);
    expect(document.querySelector('details')!.open).toBe(false);
    await type('needle');
    expect(count()).toBe('1 / 1');
    expect(document.querySelector('details')!.open).toBe(true);
  });

  it('follows the list as it changes: new text is counted while the box is open', async () => {
    await draw('<p>one cat</p>');
    key('f', { ctrlKey: true });
    await rest(50);
    await type('cat');
    expect(count()).toBe('1 / 1');
    await draw('<p>one cat</p><p>two cats, three cat</p>');
    await rest(300);
    expect(count()).toBe('1 / 3');
  });

  it('lights up the matches, the current one brighter, and clears them on close', async () => {
    const lit = new Map<string, { ranges: Range[] }>();
    vi.stubGlobal('CSS', { highlights: lit });
    vi.stubGlobal('Highlight', class { ranges: Range[]; constructor(...r: Range[]) { this.ranges = r; } });
    try {
      await draw('<p>cat and cat and cat</p>');
      key('f', { ctrlKey: true });
      await rest(50);
      await type('cat');
      // (their look is added to the page, since the CSS build does not know ::highlight())
      expect(document.head.textContent).toContain('::highlight(find-current)');
      expect(lit.get('find')!.ranges).toHaveLength(3);
      expect(lit.get('find-current')!.ranges).toHaveLength(1);
      key('Enter', {}, box()!);
      await rest(50);
      expect(lit.get('find-current')!.ranges[0]).toBe(lit.get('find')!.ranges[1]);
      key('Escape', {}, box()!);
      await rest(50);
      expect(lit.has('find')).toBe(false);
      expect(lit.has('find-current')).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('gives its place back when it closes', async () => {
    await draw('<p>cat</p>');
    const host = document.getElementById('one')!;
    host.style.position = 'static';
    key('f', { ctrlKey: true });
    await rest(50);
    expect(host.style.position).toBe('relative');
    key('Escape', {}, box()!);
    await rest(50);
    expect(host.style.position).toBe('static');
  });
});

describe('searchText()', () => {
  it('is what a message says: its text, its reasoning and the names of its tools', () => {
    const parts = [
      { type: 'text', text: 'Plan the week' },
      { type: 'reasoning', text: 'thinking about Monday' },
      { type: 'dynamic-tool', toolName: 'read_file', toolCallId: 't', state: 'output-available', input: {}, output: {} },
      { type: 'step-start' },
    ] as Parameters<typeof searchText>[0]['parts'];
    const text = searchText({ parts });
    expect(countIn(text, 'monday')).toBe(1);
    expect(countIn(text, 'read_file')).toBe(1);
    expect(countIn(text, 'step-start')).toBe(0);
  });
});
