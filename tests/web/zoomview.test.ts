// The lightbox: a picture fitted to the window that zooms with the buttons, the keys and a click.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lightbox } from '../../web/core.ts';

beforeEach(() => {
  document.body.innerHTML = '';
  document.body.append(Object.assign(document.createElement('div'), { id: 'modal-root' }));
});
afterEach(() => (document.body.innerHTML = ''));

const tick = () => new Promise((r) => setTimeout(r, 0));
const level = () => document.querySelector('.lightbox button[title^="Fit"]')!.textContent;
const img = () => document.querySelector<HTMLImageElement>('.lightbox img')!;

describe('lightbox()', () => {
  it('opens wide, named after the picture, fitted to the window', async () => {
    lightbox('/api/file?path=%2Fa.png', 'a.png');
    await tick();
    expect(document.querySelector('.modal-head h2')!.textContent).toBe('a.png');
    expect(document.querySelector('.modal-back')!.classList.contains('wide')).toBe(true);
    expect(img().className).toContain('max-w-full');
    expect(img().className).toContain('max-h-full');
    expect(level()).toBe('Fit');
    expect(img().classList.contains('cursor-zoom-in')).toBe(true);
  });

  it('zooms in and out with the buttons and the + − 0 keys', async () => {
    lightbox('/x.png', 'x.png');
    await tick();
    document.querySelector<HTMLButtonElement>('.lightbox button[aria-label^="Zoom in"]')!.click();
    expect(level()).toBe('150%');
    expect(img().style.transform).toContain('scale(1.5)');
    img().dispatchEvent(new KeyboardEvent('keydown', { key: '+', bubbles: true }));
    expect(level()).toBe('225%');
    img().dispatchEvent(new KeyboardEvent('keydown', { key: '-', bubbles: true }));
    expect(level()).toBe('150%');
    img().dispatchEvent(new KeyboardEvent('keydown', { key: '0', bubbles: true }));
    expect(level()).toBe('Fit');
    // never smaller than fitted
    document.querySelector<HTMLButtonElement>('.lightbox button[aria-label^="Zoom out"]')!.click();
    expect(level()).toBe('Fit');
  });

  it('a click zooms in, the next one back out; Ctrl + scroll (a pinch) zooms too', async () => {
    lightbox('/x.png', 'x.png');
    await tick();
    const box = document.querySelector<HTMLElement>('.zoom-box')!;
    const press = (type: string) => img().dispatchEvent(new PointerEvent(type, { pointerId: 1, button: 0, clientX: 10, clientY: 10, bubbles: true }));
    press('pointerdown');
    press('pointerup');
    expect(level()).toBe('250%');
    expect(img().classList.contains('cursor-zoom-out')).toBe(true);
    press('pointerdown');
    press('pointerup');
    expect(level()).toBe('Fit');
    const wheel = new WheelEvent('wheel', { deltaY: -50, bubbles: true, cancelable: true });
    // (the test page's WheelEvent drops ctrlKey)
    Object.defineProperty(wheel, 'ctrlKey', { value: true });
    box.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(true);
    expect(level()).not.toBe('Fit');
  });

  it('the scroll wheel zooms in and out without Ctrl; sideways scrolling does not zoom', async () => {
    lightbox('/x.png', 'x.png');
    await tick();
    const box = document.querySelector<HTMLElement>('.zoom-box')!;
    const scroll = (deltaX: number, deltaY: number) => {
      const wheel = new WheelEvent('wheel', { deltaX, deltaY, bubbles: true, cancelable: true });
      box.dispatchEvent(wheel);
      return wheel;
    };
    expect(scroll(0, -100).defaultPrevented).toBe(true);
    expect(level()).toBe('165%');
    scroll(0, -100);
    expect(level()).toBe('272%');
    scroll(0, 100);
    expect(level()).toBe('165%');
    scroll(80, 0);
    expect(level()).toBe('165%');
    scroll(0, 100);
    expect(level()).toBe('Fit');
  });
});
