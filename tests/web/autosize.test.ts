// Message boxes grow with their text where the browser has no field-sizing (Safari, so the macOS desktop app).
import { describe, expect, it } from 'vitest';
import { autosizeTextareas, fitTextarea } from '../../web/autosize.ts';
import { CATEGORY_COLORS } from '../../web/agentstats.ts';
import { lightDark } from '../../web/theme.ts';

describe('autosizeTextareas()', () => {
  it('does nothing where the browser sizes the boxes itself', () => {
    expect(autosizeTextareas(true)).toBe(false);
  });

  it('sizes a message box to its text as it is typed', () => {
    expect(autosizeTextareas(false)).toBe(true);
    const box = document.createElement('textarea');
    box.className = 'field-sizing-content';
    document.body.append(box);
    Object.defineProperty(box, 'scrollHeight', { configurable: true, get: () => 120 });
    box.value = 'one\ntwo\nthree';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    expect(box.style.height).toBe('120px');
    // other boxes are left alone
    const plain = document.createElement('textarea');
    document.body.append(plain);
    plain.dispatchEvent(new Event('input', { bubbles: true }));
    expect(plain.style.height).toBe('');
    box.remove();
    plain.remove();
  });

  it('counts the borders in', () => {
    const box = document.createElement('textarea');
    Object.defineProperty(box, 'scrollHeight', { get: () => 80 });
    Object.defineProperty(box, 'offsetHeight', { get: () => 82 });
    Object.defineProperty(box, 'clientHeight', { get: () => 80 });
    fitTextarea(box);
    expect(box.style.height).toBe('82px');
  });
});

describe('colours set from code', () => {
  it('use the stylesheet variables, not light-dark() (older Safari has none)', () => {
    expect(lightDark('#111', '#eee')).toBe('var(--lightningcss-light, #111) var(--lightningcss-dark, #eee)');
    expect(CATEGORY_COLORS.join(' ')).not.toContain('light-dark(');
  });
});
