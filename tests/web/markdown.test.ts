// @vitest-environment jsdom
// DOMPurify (the sanitizer) officially supports jsdom, so the real sanitizing path runs here.
import { describe, expect, it } from 'vitest';
import { md } from '../../web/core.ts';

describe('md() on agent output', () => {
  it('renders markdown', () => {
    const el = md('**bold** and `code`');
    expect(el.querySelector('strong')?.textContent).toBe('bold');
    expect(el.querySelector('code')?.textContent).toBe('code');
  });

  it('removes scripts and inline event handlers', () => {
    const el = md('hello <script>alert(1)</script><img src="x" onerror="alert(2)">');
    expect(el.querySelector('script')).toBeNull();
    expect(el.innerHTML).not.toContain('onerror');
    expect(el.textContent).toContain('hello');
  });

  it('opens links in a new tab without giving the page access to the dashboard', () => {
    const a = md('[site](https://example.com)').querySelector('a')!;
    expect(a.target).toBe('_blank');
    expect(a.rel).toBe('noopener');
  });

  it('drops javascript: links', () => {
    const a = md('[x](javascript:alert(1))').querySelector('a');
    expect(a?.getAttribute('href') ?? '').not.toMatch(/javascript:/i);
  });

  it('keeps a short file name or code word on one line, but lets longer text wrap', () => {
    const el = md('See [mention-text.tsx](https://x/a) and `frame-ancestors`, [intercepts Tab](https://x/b), `' + 'a'.repeat(50) + '`\n\n```\nsome-code\n```');
    const [file, phrase] = [...el.querySelectorAll('a')];
    const [word, long, block] = [...el.querySelectorAll('code')];
    expect(file.classList.contains('whitespace-nowrap')).toBe(true);
    expect(word.classList.contains('whitespace-nowrap')).toBe(true);
    expect(phrase.classList.contains('whitespace-nowrap')).toBe(false);
    expect(long.classList.contains('whitespace-nowrap')).toBe(false);
    expect(block.classList.contains('whitespace-nowrap')).toBe(false);
  });
});
