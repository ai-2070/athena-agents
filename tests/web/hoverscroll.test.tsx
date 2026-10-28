// HoverScroll: a cut-off line scrolls to its end while the card around it is hovered, and goes back after.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HoverScroll } from '../../web/ui/react.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
beforeEach(() => {
  document.body.innerHTML = '<div id="host"></div>';
  root = createRoot(document.getElementById('host')!);
});
afterEach(() => act(() => root.unmount()));

// (happy-dom has no layout: say how wide the line and its box are)
const sizes = (text: number, box: number) => {
  const inner = document.querySelector<HTMLElement>('.card span span')!;
  const outer = inner.parentElement!;
  Object.defineProperty(inner, 'scrollWidth', { value: text, configurable: true });
  Object.defineProperty(outer, 'clientWidth', { value: box, configurable: true });
  return inner;
};
const show = () =>
  act(() =>
    root.render(
      <div className="card">
        <HoverScroll host=".card">Reviews code like a mentor, not a gatekeeper</HoverScroll>
      </div>,
    ),
  );
const hover = (type: 'mouseenter' | 'mouseleave') => act(() => void document.querySelector('.card')!.dispatchEvent(new MouseEvent(type)));

describe('HoverScroll', () => {
  it('scrolls a cut-off line by exactly how much is hidden while the card is hovered, then eases back', () => {
    show();
    const inner = sizes(300, 200);
    hover('mouseenter');
    expect(inner.style.transform).toBe('translateX(-100px)');
    hover('mouseleave');
    expect(inner.style.transform).toBe('');
  });

  it('leaves a line that fits alone', () => {
    show();
    const inner = sizes(150, 200);
    hover('mouseenter');
    expect(inner.style.transform).toBe('');
  });
});
