// Move the selected plate from the previous choice without moving the button or its text.
import { reducedMotion } from './motion.ts';

export function slideSegment(from: HTMLButtonElement | null, to: HTMLButtonElement | null): void {
  if (!from || !to || from === to || reducedMotion()) return;
  const width = to.offsetWidth;
  const height = to.offsetHeight;
  if (!width || !height) return;
  const animation = to.animate(
    [
      { transform: `translate(${from.offsetLeft - to.offsetLeft}px, ${from.offsetTop - to.offsetTop}px) scale(${from.offsetWidth / width}, ${from.offsetHeight / height})` },
      { transform: 'none' },
    ],
    { pseudoElement: '::before', duration: 240, easing: 'cubic-bezier(.2,.8,.2,1)' },
  );
  // A new choice or an unmount may interrupt the animation.
  void animation.finished.catch(() => {});
}
