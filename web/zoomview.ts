// A picture that fits its box and zooms: the scroll wheel, pinch (touch, trackpad), a click (in where you
// click, out again with the next one), the − / + buttons and the + − 0 keys. Zoomed in, drag to move around.
// Plain DOM without core.ts, so the lightbox in core.ts can use it.
import { icon } from './icons.ts';
import { buttonClass } from './ui/classes.ts';

const MAX = 8;
const STEP = 1.5;
/** Where a click zooms to. */
const CLICK_ZOOM = 2.5;
// how far a press may move and still count as a click (not a drag)
const SLOP = 4;

export interface ZoomView {
  el: HTMLDivElement;
  /** + − 0 from the dialog around it. */
  onKey: (e: KeyboardEvent) => void;
}

// Safari's pinch (it sends these rather than Ctrl + wheel)
interface GestureEvent extends UIEvent {
  scale: number;
  clientX: number;
  clientY: number;
}

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls: string,
  attrs: Record<string, string> = {},
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  node.className = cls;
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
};

export function zoomView(src: string, name: string): ZoomView {
  const box = el(
    'div',
    'zoom-box relative flex h-[calc(100vh-210px)] min-h-50 w-full touch-none items-center justify-center overflow-hidden rounded-ctl bg-panel-2 select-none',
    { tabindex: '0', 'aria-label': `${name}. Click, scroll or pinch to zoom.` },
  );
  const img = el('img', 'block max-h-full max-w-full cursor-zoom-in object-contain will-change-transform', {
    src,
    alt: name,
    draggable: 'false',
  });
  box.append(img);

  const btn = (label: string, child: Node | string, onClick: () => void) => {
    const b = el('button', buttonClass('ghost', 'small'), { type: 'button', title: label, 'aria-label': label });
    b.append(child);
    b.addEventListener('click', onClick);
    return b;
  };
  const level = el('button', buttonClass('ghost', 'small', 'min-w-16 tabular-nums'), {
    type: 'button',
    title: 'Fit to the window (0)',
  });
  const full = el('a', buttonClass('ghost', 'small', 'ml-auto gap-1.5 no-underline'), {
    href: src,
    target: '_blank',
    rel: 'noopener',
  });
  full.append(icon('external-link', 14), 'Open full size');
  const bar = el('div', 'mt-3 flex items-center gap-1.5');
  bar.append(
    btn('Zoom out (−)', icon('zoom-out', 15), () => zoomBy(1 / STEP)),
    level,
    btn('Zoom in (+)', icon('zoom-in', 15), () => zoomBy(STEP)),
    full,
  );
  const root = el('div', 'lightbox');
  root.append(box, bar);

  // scale 1 = the picture fitted in the box; x, y: how far its middle is moved from the box's middle
  let scale = 1;
  let x = 0;
  let y = 0;

  const draw = (smooth: boolean) => {
    // keep the picture over the box: it can't be dragged off past its edges
    const room = (size: number, view: number) => Math.max(0, (size * scale - view) / 2);
    const rx = room(img.offsetWidth, box.clientWidth);
    const ry = room(img.offsetHeight, box.clientHeight);
    x = Math.max(-rx, Math.min(rx, x));
    y = Math.max(-ry, Math.min(ry, y));
    img.style.transition = smooth ? 'transform 0.18s ease-out' : 'none';
    img.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    img.classList.toggle('cursor-zoom-in', scale === 1);
    img.classList.toggle('cursor-zoom-out', scale > 1 && !dragging);
    img.classList.toggle('cursor-grabbing', dragging);
    level.textContent = scale === 1 ? 'Fit' : `${Math.round(scale * 100)}%`;
  };

  /** Zoom to s, keeping the point under (cx, cy) on screen where it is. */
  const zoomTo = (s: number, cx?: number, cy?: number, smooth = false) => {
    // (scrolling in and back out can stop a hair above fitted: call that fitted)
    const next = s < 1.01 ? 1 : Math.min(MAX, s);
    const r = box.getBoundingClientRect();
    // the point, from the box's middle (its middle when none is given)
    const px = cx === undefined ? 0 : cx - (r.left + r.width / 2);
    const py = cy === undefined ? 0 : cy - (r.top + r.height / 2);
    x = px - ((px - x) * next) / scale;
    y = py - ((py - y) * next) / scale;
    scale = next;
    if (scale === 1) x = y = 0;
    draw(smooth);
  };
  const zoomBy = (f: number) => zoomTo(scale * f, undefined, undefined, true);
  const fit = () => zoomTo(1, undefined, undefined, true);
  level.addEventListener('click', fit);

  // ---------- mouse, touch and pen: drag to move, click to zoom, two fingers to pinch ----------
  const down = new Map<number, { x: number; y: number }>();
  let dragging = false;
  let start = { x: 0, y: 0, ox: 0, oy: 0, moved: false, onImg: false };
  let pinch: { dist: number; scale: number } | null = null;
  const spread = () => {
    const [a, b] = [...down.values()];
    return { dist: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
  };

  box.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    box.setPointerCapture?.(e.pointerId);
    down.set(e.pointerId, { x: e.clientX, y: e.clientY });
    // (with the pointer captured, the release is the box's: remember whether the press was on the picture)
    if (down.size === 1) start = { x: e.clientX, y: e.clientY, ox: x, oy: y, moved: false, onImg: e.target === img };
    if (down.size === 2) {
      pinch = { dist: spread().dist || 1, scale };
      start.moved = true;
    }
  });
  box.addEventListener('pointermove', (e) => {
    if (!down.has(e.pointerId)) return;
    down.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && down.size >= 2) {
      const s = spread();
      return zoomTo((pinch.scale * s.dist) / pinch.dist, s.mx, s.my);
    }
    if (!start.moved && Math.hypot(e.clientX - start.x, e.clientY - start.y) < SLOP) return;
    start.moved = true;
    if (scale === 1) return;
    dragging = true;
    x = start.ox + e.clientX - start.x;
    y = start.oy + e.clientY - start.y;
    draw(false);
  });
  const up = (e: PointerEvent) => {
    if (!down.delete(e.pointerId)) return;
    if (down.size < 2) pinch = null;
    if (down.size) {
      // one finger left after a pinch: it carries on as a drag from here
      const [p] = [...down.values()];
      start = { x: p.x, y: p.y, ox: x, oy: y, moved: true, onImg: false };
      return;
    }
    const click = e.type === 'pointerup' && !start.moved && start.onImg;
    dragging = false;
    if (click) zoomTo(scale === 1 ? CLICK_ZOOM : 1, e.clientX, e.clientY, true);
    else draw(false);
  };
  box.addEventListener('pointerup', up);
  box.addEventListener('pointercancel', up);

  // ---------- wheel: scrolling up or down zooms at the pointer (a trackpad pinch comes as Ctrl + wheel, the
  // same thing); scrolling sideways moves a zoomed picture ----------
  box.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? box.clientHeight : 1;
      const dy = e.deltaY * unit;
      const dx = e.deltaX * unit;
      if (dy && (e.ctrlKey || e.metaKey || Math.abs(dy) >= Math.abs(dx))) {
        // a mouse wheel's steps are big, a trackpad's small: both end up a gentle zoom
        return zoomTo(scale * Math.exp(-Math.max(-50, Math.min(50, dy)) * 0.01), e.clientX, e.clientY);
      }
      if (scale === 1) return;
      x -= dx;
      draw(false);
    },
    { passive: false },
  );

  // ---------- Safari ----------
  let gestureFrom = 1;
  box.addEventListener('gesturestart', (e) => {
    e.preventDefault();
    gestureFrom = scale;
  });
  box.addEventListener('gesturechange', (e) => {
    e.preventDefault();
    const g = e as GestureEvent;
    zoomTo(gestureFrom * g.scale, g.clientX, g.clientY);
  });
  box.addEventListener('gestureend', (e) => e.preventDefault());

  const onKey = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey || (e.target as HTMLElement | null)?.closest?.('input, textarea')) return;
    if (e.key === '+' || e.key === '=') zoomBy(STEP);
    else if (e.key === '-' || e.key === '_') zoomBy(1 / STEP);
    else if (e.key === '0') fit();
    else return;
    e.preventDefault();
  };

  img.addEventListener('load', () => draw(false));
  draw(false);
  return { el: root, onKey };
}
