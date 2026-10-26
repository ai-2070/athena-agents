// A project's logo: its URL, a small logo-or-icon mark for lists and buttons, and picking a new one.
import { h, POST, DEL, attempt, refreshSoon, toast } from './core.ts';
import { icon } from './icons.ts';
import type { Project } from '../shared/types.ts';

type ProjectRef = Pick<Project, 'id'> & Partial<Pick<Project, 'logoAt' | 'repo' | 'name'>>;

/** The logo's URL (changes when the logo does, so the new one shows at once), or null. */
export function logoUrl(p: ProjectRef | null | undefined): string | null {
  return p?.id && p.logoAt ? `/api/projects/${encodeURIComponent(p.id)}/logo?v=${p.logoAt}` : null;
}

/** The logo, or the project's folder / GitHub icon when it has none. */
export function projectMark(p: ProjectRef | null | undefined, size = 16, fallback: string | null = null): HTMLElement | SVGSVGElement {
  const url = logoUrl(p);
  if (url) return h('img.proj-logo', { src: url, alt: '', width: size, height: size, style: { width: `${size}px`, height: `${size}px` } });
  return icon(fallback || (p?.repo ? 'git-branch' : 'folder'), size);
}

const MAX_SIDE = 512;

// Big photos are shrunk to 512 px (PNG keeps transparency); small images and GIFs go up as they are.
async function readImage(file: File): Promise<string> {
  const raw = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("Couldn't read that file."));
    r.readAsDataURL(file);
  });
  if (file.type === 'image/gif') return raw;
  const img = new Image();
  img.src = raw;
  await img.decode().catch(() => {
    throw new Error("That file isn't an image this browser can open.");
  });
  const side = Math.max(img.naturalWidth, img.naturalHeight);
  if (side <= MAX_SIDE && file.size < 600_000) return raw;
  const k = MAX_SIDE / side;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.naturalWidth * Math.min(1, k)));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * Math.min(1, k)));
  canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/png');
}

/** Ask for an image and make it the project's logo. Resolves to true when it was saved. */
export function pickLogo(p: Pick<Project, 'id' | 'name'>): Promise<boolean> {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif' });
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return resolve(false);
      if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) {
        toast('Pick a PNG, JPG, WebP or GIF image.', 'error');
        return resolve(false);
      }
      let data: string;
      try {
        data = await readImage(file);
      } catch (e) {
        toast((e as Error).message, 'error');
        return resolve(false);
      }
      const r = await attempt(() => POST<Project>(`/projects/${encodeURIComponent(p.id)}/logo`, { data }), `New logo for ${p.name}`);
      refreshSoon(0);
      resolve(!!r);
    });
    input.click();
  });
}

export async function removeLogo(p: Pick<Project, 'id' | 'name'>): Promise<boolean> {
  const r = await attempt(() => DEL<Project>(`/projects/${encodeURIComponent(p.id)}/logo`), 'Logo removed');
  refreshSoon(0);
  return !!r;
}
