import { reducedMotion, slideOut } from './motion.ts';

/** Leave a plain-DOM popup on screen for its exit without accepting further input. */
export function dismissMenu(menu: HTMLElement): void {
  menu.style.pointerEvents = 'none';
  menu.setAttribute('aria-hidden', 'true');
  if (reducedMotion() || typeof menu.animate !== 'function') {
    menu.remove();
    return;
  }
  void slideOut(menu, { scale: 0.97, duration: 110 }).then(() => menu.remove());
  setTimeout(() => menu.remove(), 500);
}
