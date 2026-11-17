// Plain-DOM pieces that hold more than their elements (an observer, a 3D model) say how to let it go, and whoever
// owns them lets go when they are done with them. Being out of the page isn't enough: a cached preview box is taken
// out and put back on every redraw.
const releases = new WeakMap<Element, () => void>();

/** fn runs when el, or something holding it, is released. */
export function onRelease(el: Element, fn: () => void): void {
  releases.set(el, fn);
  el.setAttribute('data-release', '');
}

/** Lets go of what root and everything in it hold (each only once). */
export function release(root: Node | null | undefined): void {
  if (!(root instanceof Element)) return;
  for (const el of [root, ...root.querySelectorAll('[data-release]')]) {
    const fn = releases.get(el);
    if (!fn) continue;
    releases.delete(el);
    el.removeAttribute('data-release');
    try {
      fn();
    } catch (e) {
      console.error(e);
    }
  }
}
