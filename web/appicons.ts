// Logos for programs that Simple Icons doesn't have and that aren't Craft apps (public/app-icons,
// see its README). appLogo in views/stationdata.ts falls back to them.
// tile: a mark too light to read on a white page (ComfyUI's yellow) sits on a dark rounded square, as in the
// program's own icon; on a near-black page the square disappears into it.
const APP_ICONS: Record<string, { src: string; tile?: string }> = {
  irfanview: { src: '/app-icons/irfanview.ico' },
  comfyui: { src: '/app-icons/comfyui.png', tile: '#17181c' },
  lmstudio: { src: '/app-icons/lmstudio.png' },
};

const find = (name: string | null | undefined): { src: string; tile?: string } | null => {
  const n = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  const key = Object.keys(APP_ICONS).find((k) => n.includes(k));
  return key ? APP_ICONS[key] : null;
};

// The icon for a program, MCP server or connector name ("comfyui", "ComfyUI", "comfyui-mcp"), or null.
export const appIconUrl = (name: string | null | undefined): string | null => find(name)?.src ?? null;

/** The inline style an icon of this size needs to be seen on any page (its dark tile), or undefined when it needs none. */
export function appIconStyle(
  name: string | null | undefined,
  size = 20,
): { background: string; padding: string; borderRadius: string; boxSizing: 'border-box' } | undefined {
  const tile = find(name)?.tile;
  return tile
    ? {
        background: tile,
        padding: `${Math.max(1, Math.round(size * 0.18))}px`,
        borderRadius: `${Math.max(3, Math.round(size * 0.24))}px`,
        boxSizing: 'border-box',
      }
    : undefined;
}

// The icon as an <img>, or null when there isn't one.
export function appIcon(name: string | null | undefined, size = 16): HTMLImageElement | null {
  const src = appIconUrl(name);
  if (!src) return null;
  const img = document.createElement('img');
  img.src = src;
  img.width = size;
  img.height = size;
  img.alt = '';
  img.className = 'app-icon';
  img.draggable = false;
  const tile = appIconStyle(name, size);
  if (tile) Object.assign(img.style, tile);
  return img;
}

// The same icon as a loaded image for drawing on a canvas (the Station's desk monitors). Null until it
// has loaded; `onLoad` runs once when it arrives, so the caller can draw again.
const loaded = new Map<string, HTMLImageElement>();
export function appIconImage(name: string | null | undefined, onLoad?: () => void): HTMLImageElement | null {
  const src = appIconUrl(name);
  if (!src) return null;
  let img = loaded.get(src);
  if (!img) {
    img = new Image();
    img.src = src;
    loaded.set(src, img);
  }
  if (img.complete && img.naturalWidth) return img;
  if (onLoad) img.addEventListener('load', onLoad, { once: true });
  return null;
}
