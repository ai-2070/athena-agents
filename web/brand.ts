// The Athena Agents mark: an owl (Athena's bird) looking out of a rounded tile. It is drawn in the page's accent,
// so it changes with Settings > Look. public/icon.svg is the same drawing in fixed colours, for the tab and the app.
const NS = 'http://www.w3.org/2000/svg';

/** The mark's shapes, for a 64 × 64 box. */
export const MARK_SHAPES =
  '<rect width="64" height="64" rx="15" style="fill:var(--color-accent)"/>' +
  '<path d="M10.5 19 22 23.5Q32 20.5 42 23.5L53.5 19Q55 28 54 36Q52 52 32 52 12 52 10 36 9 28 10.5 19Z" style="fill:var(--color-on-accent)"/>' +
  '<circle cx="22.5" cy="36" r="8.4" style="fill:var(--color-accent)"/>' +
  '<circle cx="41.5" cy="36" r="8.4" style="fill:var(--color-accent)"/>' +
  '<circle cx="22.5" cy="36" r="5.4" style="fill:var(--color-on-accent)"/>' +
  '<circle cx="41.5" cy="36" r="5.4" style="fill:var(--color-on-accent)"/>' +
  '<circle cx="23.2" cy="36.4" r="2.5" style="fill:var(--color-accent)"/>' +
  '<circle cx="40.8" cy="36.4" r="2.5" style="fill:var(--color-accent)"/>' +
  '<path d="M32 41 29.4 46.6 32 48.4 34.6 46.6Z" style="fill:var(--color-accent)"/>';

/** The mark as an SVG element of the given size (px). */
export function brandMark(size = 24, cls = ''): SVGSVGElement {
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('viewBox', '0 0 64 64');
  s.setAttribute('width', String(size));
  s.setAttribute('height', String(size));
  s.setAttribute('class', `brand-mark flex-none ${cls}`.trim());
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = MARK_SHAPES;
  return s;
}
