// The storytold Craft apps' own icons (public/craft-icons, see its README), for MCP servers and
// connectors named after them ("photocraft", "storytold-vectorcraft"…).
// Each color is the icon's background, so the tile's border matches it (SolidCraft's has none: its blue).
const CRAFT: Record<string, string> = {
  cadcraft: '#14a5ca',
  'craft-anything': '#4e7bfb',
  deckcraft: '#f07d22',
  designcraft: '#86b633',
  effectcraft: '#d74791',
  figcraft: '#1db584',
  filmcraft: '#825bdb',
  gridcraft: '#1f9d55',
  lightcraft: '#e3a229',
  materialcraft: '#178a9c',
  pdfcraft: '#2faa92',
  photocraft: '#3160ac',
  solidcraft: '#47a2fb',
  soundcraft: '#309fb2',
  texturecraft: '#c2672b',
  vectorcraft: '#e0644e',
  wordcraft: '#3b5bdb',
};

// The Craft app a name refers to ("PhotoCraft", "mcp-photocraft"), or null.
export function craftApp(name: string | null | undefined): string | null {
  const n = String(name || '').toLowerCase();
  // the one app not named "<something>craft": "craft-anything", "craft_anything", "CraftAnything"
  if (/craft[-_ ]?anything/.test(n)) return 'craft-anything';
  for (const m of n.matchAll(/([a-z]+)craft/g)) {
    // "storytoldphotocraft" or "my_photocraft": the app is the longest known ending
    const app = Object.keys(CRAFT).find((k) => `${m[1]}craft`.endsWith(k));
    if (app) return app;
  }
  return null;
}

export const craftColor = (name: string | null | undefined): string | null => {
  const app = craftApp(name);
  return app ? CRAFT[app] : null;
};

// Where the app's icon is, or null when the name isn't a Craft app.
export const craftIconSrc = (name: string | null | undefined): string | null => {
  const app = craftApp(name);
  return app ? `/craft-icons/${app}.png` : null;
};

// The app's icon as an <img>, or null when the name isn't a Craft app.
export function craftIcon(name: string | null | undefined, size = 16): HTMLImageElement | null {
  const src = craftIconSrc(name);
  if (!src) return null;
  const img = document.createElement('img');
  img.src = src;
  img.width = size;
  img.height = size;
  img.alt = '';
  img.className = 'craft-icon';
  img.draggable = false;
  return img;
}
