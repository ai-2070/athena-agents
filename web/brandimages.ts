// Upstream program marks bundled locally for React and plain-DOM surfaces.
import { serverUrl } from './client/connection.ts';

const IMAGES: Record<string, string> = {
  hermes: 'hermes.svg', pi: 'pi.svg', omp: 'omp.svg', openclaw: 'openclaw.svg', venice: 'venice.svg',
  painter: 'painter.svg', designer: 'designer.svg', handbrake: 'handbrakecli.png', handbrakecli: 'handbrakecli.png',
  imagemagick: 'imagemagick.png', prusaslicer: 'prusaslicer.svg', orcaslicer: 'orcaslicer.png',
  vscode: 'vscode.png', 'vs code': 'vscode.png', orca: 'orca.png', ffmpeg: 'ffmpeg.png',
};

export function brandImage(id: string, size: number): HTMLImageElement | null {
  const file = IMAGES[id];
  if (!file) return null;
  const image = document.createElement('img');
  image.src = serverUrl(`/brand/engines/${file}`);
  image.width = size;
  image.height = size;
  image.alt = '';
  image.setAttribute('aria-hidden', 'true');
  image.className = 'object-contain';
  return image;
}

