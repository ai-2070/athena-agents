// The supplied Athena helmet keeps its Aegean blue in every theme.
import { serverUrl } from './client/connection.ts';

export const BRAND_IMAGE = '/icon.png';

/** The app mark, for plain-DOM surfaces such as the Station. */
export function brandMark(size = 24, cls = ''): HTMLImageElement {
  const image = document.createElement('img');
  image.src = serverUrl(BRAND_IMAGE);
  image.width = size;
  image.height = size;
  image.className = `brand-mark flex-none ${cls}`.trim();
  image.alt = '';
  image.setAttribute('aria-hidden', 'true');
  return image;
}
