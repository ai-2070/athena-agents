// Upstream program marks bundled locally for React and plain-DOM surfaces.
import { serverUrl } from './client/connection.ts';
import { isDark, onThemeChange } from './theme.ts';

const IMAGES: Record<string, string> = {
  hermes: 'hermes.svg',
  pi: 'pi.svg',
  omp: 'omp.svg',
  openclaw: 'openclaw.svg',
  opencode: 'opencode.svg',
  venice: 'venice.svg',
  painter: 'painter.svg',
  designer: 'designer.svg',
  handbrake: 'handbrakecli.png',
  handbrakecli: 'handbrakecli.png',
  imagemagick: 'imagemagick.png',
  prusaslicer: 'prusaslicer.svg',
  orcaslicer: 'orcaslicer.png',
  vscode: 'vscode.png',
  'vs code': 'vscode.png',
  orca: 'orca.png',
  ffmpeg: 'ffmpeg.png',
};

// Marks with a separate copy for a dark page. An SVG's own prefers-color-scheme follows the computer, not the
// app's Colour scheme, so the page picks the file instead.
const DARK_IMAGES: Record<string, string> = { pi: 'pi-dark.svg', venice: 'venice-dark.svg' };

/** The address of a program's mark for the page's current light or dark look. */
export function brandSrc(id: string): string | null {
  const file = (isDark() && DARK_IMAGES[id]) || IMAGES[id];
  return file ? serverUrl(`/brand/engines/${file}`) : null;
}

// One watcher swaps every mark with a dark copy that is already on the page when the look changes.
let watching = false;
function watchTheme(): void {
  if (watching) return;
  watching = true;
  onThemeChange(() => {
    for (const image of document.querySelectorAll<HTMLImageElement>('img[data-brand]')) {
      const src = brandSrc(image.dataset.brand || '');
      if (src && image.getAttribute('src') !== src) image.src = src;
    }
  });
}

/** Marks the image so it follows light and dark, when its program has a dark copy. */
export function followTheme(image: HTMLImageElement, id: string): void {
  if (!DARK_IMAGES[id]) return;
  image.dataset.brand = id;
  watchTheme();
}

export function brandImage(id: string, size: number): HTMLImageElement | null {
  const src = brandSrc(id);
  if (!src) return null;
  const image = document.createElement('img');
  image.src = src;
  image.width = size;
  image.height = size;
  image.alt = '';
  image.setAttribute('aria-hidden', 'true');
  image.className = 'app-icon object-contain';
  followTheme(image, id);
  return image;
}
