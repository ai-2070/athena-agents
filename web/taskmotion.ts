// The Tasks board's drag: the card under the pointer while it is dragged. Browsers draw their own drag image
// see-through, and a page can't change that, so the board hides it and moves a copy of the card instead: nearly
// opaque, lifted and slightly tilted, held where it was grabbed. The copy is the card's markup, cloned without
// ids or the card's data-task-id, outside the board, so nothing counts it as a card.
import { useEffect } from 'react';
import type { RefObject } from 'react';

/** A 1px see-through GIF: what the browser drags instead of its own copy. */
const BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/** The card's markup without anything that would make it count as the card (its id, its data-task-id, focus). */
export function cardCopy(card: HTMLElement): HTMLElement {
  const copy = document.createElement('div');
  // the card is dimmed while it is dragged; its copies aren't
  copy.className = card.className.replace(/\bopacity-40\b/g, '');
  for (const child of card.childNodes) copy.append(child.cloneNode(true));
  for (const el of copy.querySelectorAll('[id]')) el.removeAttribute('id');
  for (const el of copy.querySelectorAll('[data-task-id]')) el.removeAttribute('data-task-id');
  copy.setAttribute('aria-hidden', 'true');
  return copy;
}

/** Where the pointer held the card it is dragging (for the card's glide from where it is dropped). */
export const grab = { x: 0, y: 0 };

export function useDragPreview(board: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const root = board.current;
    if (!root) return;
    const blank = new Image();
    blank.src = BLANK;
    let preview: HTMLElement | null = null;
    const place = (x: number, y: number) => {
      if (preview) preview.style.transform = `translate3d(${x - grab.x}px, ${y - grab.y}px, 0) rotate(1.5deg)`;
    };
    const clear = () => {
      preview?.remove();
      preview = null;
    };
    const onDragStart = (e: DragEvent) => {
      const card = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-task-id]');
      if (!card || !e.dataTransfer) return;
      clear();
      const box = card.getBoundingClientRect();
      grab.x = e.clientX - box.left;
      grab.y = e.clientY - box.top;
      if (typeof e.dataTransfer.setDragImage === 'function') e.dataTransfer.setDragImage(blank, 0, 0);
      const copy = cardCopy(card);
      Object.assign(copy.style, {
        position: 'fixed', left: '0', top: '0', width: `${box.width}px`, margin: '0', zIndex: '60', pointerEvents: 'none',
        opacity: '0.95', boxShadow: 'var(--shadow-pop)', transition: 'none',
      });
      document.body.append(copy);
      preview = copy;
      place(e.clientX, e.clientY);
    };
    // (dragover carries the pointer in every browser; drag doesn't in Firefox)
    const onDragOver = (e: DragEvent) => place(e.clientX, e.clientY);
    root.addEventListener('dragstart', onDragStart, true);
    root.addEventListener('dragend', clear, true);
    document.addEventListener('dragover', onDragOver);
    document.addEventListener('drop', clear, true);
    // (no press can happen during a drag: one after a drag whose end never came takes the copy away)
    document.addEventListener('pointerdown', clear, true);
    return () => {
      clear();
      root.removeEventListener('dragstart', onDragStart, true);
      root.removeEventListener('dragend', clear, true);
      document.removeEventListener('dragover', onDragOver);
      document.removeEventListener('drop', clear, true);
      document.removeEventListener('pointerdown', clear, true);
    };
  }, [board]);
}
