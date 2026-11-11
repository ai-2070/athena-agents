// The app's tooltip (Base UI's): drawn by the page, since the desktop app's web view doesn't show title attributes.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Tooltip } from '../../web/ui/tooltip.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const settle = (ms = 30) => act(() => new Promise((r) => setTimeout(r, ms)));

let root: Root;
beforeEach(() => {
  document.body.innerHTML = '<div id="host"></div>';
  // (no animations in happy-dom)
  Element.prototype.getAnimations ??= () => [];
  root = createRoot(document.getElementById('host')!);
});
afterEach(() => act(() => root.unmount()));

describe('the tooltip', () => {
  it('shows its label while the pointer is over what it belongs to, and goes when it leaves', async () => {
    await act(async () =>
      root.render(
        <Tooltip label="Writer · working">
          <button type="button" aria-label="Go to Writer">
            W
          </button>
        </Tooltip>,
      ),
    );
    const button = document.querySelector<HTMLButtonElement>('button')!;
    expect(document.querySelector('.tooltip')).toBeNull();
    await act(async () => {
      button.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true, pointerType: 'mouse' }));
      button.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      button.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    });
    await settle(250);
    expect(document.querySelector('.tooltip')?.textContent).toBe('Writer · working');
    await act(async () => {
      button.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true, pointerType: 'mouse' }));
      button.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
    });
    await settle(250);
    expect(document.querySelector('.tooltip')).toBeNull();
  });
});
