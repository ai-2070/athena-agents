// Pictures of things in a folder, drawn like the classic desktop icons: a 16 × 16 grid of hard pixels, a dark outline,
// a light edge on top and left, dithered shading and a one-pixel shadow. A folder, a page with a folded corner (its
// marks say what kind of file it is) and the Visual Studio Code mark. Only blacks, greys and whites, and each grey
// flips for dark pages, so they sit on glass in light and dark. Show them at 16 (or 32) px so the pixels stay sharp.
const N = 16;
type Grid = string[][];
const blank = (): Grid => Array.from({ length: N }, () => Array<string>(N).fill('.'));

// k outline · w highlight · l, m, d light to dark fill · s shadow · e print · a, b, c the Code mark (dark, grey, lit edge).
// On a dark page the icons stay light with a near-black outline, like the classic ones on a dark desktop.
const PALETTE: Record<string, string> = {
  k: 'light-dark(#2a2b32, #0b0b0e)',
  w: 'light-dark(#ffffff, #ffffff)',
  l: 'light-dark(#eceef2, #e4e6ec)',
  m: 'light-dark(#cbcdd6, #b8bac6)',
  d: 'light-dark(#a9abb7, #8e909d)',
  s: 'light-dark(#2a2b32, #000000)',
  e: 'light-dark(#5a5c68, #4a4c58)',
  a: 'light-dark(#2a2b32, #eceef3)',
  b: 'light-dark(#6a6c78, #b4b6c2)',
  c: 'light-dark(#9a9ca8, #ffffff)',
};

// 4 × 4 ordered dither: where a grey changes into the next one, the pixels alternate like a screen print
const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];
/** A fill grey for a pixel, by how far along the shading (0 light … 1 dark) it is. */
function shade(x: number, y: number, t: number, levels: string): string {
  const v = t + ((BAYER[y % 4]![x % 4]! / 16) - 0.5) * 0.5;
  const step = Math.min(levels.length - 1, Math.max(0, Math.floor(v * levels.length)));
  return levels[step]!;
}

type Inside = (x: number, y: number) => boolean;
const NEIGHBOURS = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
const isEdge = (inside: Inside, x: number, y: number): boolean => inside(x, y) && NEIGHBOURS.some(([dx, dy]) => !inside(x + dx!, y + dy!));

/** Outline, light edge and shadow for a region already filled with greys. skip: pixels something in front covers. */
function dress(g: Grid, inside: Inside, skip: Inside = () => false, shadow = true): void {
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      if (skip(x, y)) continue;
      if (isEdge(inside, x, y)) g[y]![x] = 'k';
      else if (inside(x, y) && (isEdge(inside, x, y - 1) || isEdge(inside, x - 1, y)) && !skip(x, y - 1) && !skip(x - 1, y)) g[y]![x] = 'w';
    }
  if (!shadow) return;
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const behind = inside(x - 1, y) || inside(x, y - 1) || inside(x - 1, y - 1);
      if (!inside(x, y) && behind && g[y]![x] === '.') g[y]![x] = 's';
    }
}

/** An open folder: a back sheet with a tab, and the front flap, slanted at the right, a little lower and to the left. */
function folder(): Grid {
  const g = blank();
  const back: Inside = (x, y) => (x >= 1 && x <= 6 && y >= 1 && y <= 3) || (x >= 1 && x <= 13 && y >= 3 && y <= 12);
  const right = (y: number) => Math.min(13, 10 + Math.floor((y - 5) / 2));
  const front: Inside = (x, y) => y >= 6 && y <= 14 && x >= 0 && x <= right(y);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      if (front(x, y)) g[y]![x] = shade(x, y, (x + y - 12) / 22, 'lmd');
      else if (back(x, y)) g[y]![x] = shade(x, y, (x + y - 2) / 30 + 0.2, 'lmd');
    }
  dress(g, back, front, false);
  dress(g, front);
  return g;
}

type Kind = 'image' | 'data' | 'code' | 'text';
const EXT: Record<string, Kind> = {
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image', avif: 'image', bmp: 'image',
  json: 'data', yaml: 'data', yml: 'data', toml: 'data', xml: 'data', csv: 'data', ini: 'data',
  ts: 'code', tsx: 'code', js: 'code', jsx: 'code', mjs: 'code', py: 'code', rs: 'code', go: 'code', sh: 'code', html: 'code', css: 'code', ps1: 'code',
};
const kindOf = (name: string): Kind => EXT[(name.split('.').pop() || '').toLowerCase()] || 'text';

// what is printed on the page, as pixels (x, y)
const MARKS: Record<Kind, [number, number][]> = {
  text: [4, 5, 6, 7, 8, 9, 10].flatMap((x) => [[x, 7], [x, 9]] as [number, number][]).concat([4, 5, 6, 7, 8].map((x) => [x, 11] as [number, number])),
  image: [[9, 7], [10, 7], [9, 8], [10, 8], [7, 9], [6, 10], [7, 10], [8, 10], [5, 11], [6, 11], [7, 11], [8, 11], [9, 11], [4, 12], [5, 12], [6, 12], [7, 12], [8, 12], [9, 12], [10, 12]],
  data: [[5, 7], [6, 7], [5, 8], [4, 9], [5, 10], [5, 11], [6, 11], [8, 7], [9, 7], [9, 8], [10, 9], [9, 10], [8, 11], [9, 11]],
  code: [[6, 7], [5, 8], [4, 9], [5, 10], [6, 11], [8, 7], [9, 8], [10, 9], [9, 10], [8, 11]],
};

/** A page: light paper, a snipped corner that folds over, and the marks of its kind. */
function page(kind: Kind): Grid {
  const g = blank();
  const inside: Inside = (x, y) => x >= 2 && x <= 12 && y >= 1 && y <= 14 && x - y < 8;
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) if (inside(x, y)) g[y]![x] = shade(x, y, (x + y - 8) / 30, 'lm');
  dress(g, inside);
  for (let y = 2; y < N; y++) for (let x = 8; x < N; x++) if (inside(x, y) && g[y]![x] !== 'k' && x - y >= 5) g[y]![x] = x - y === 5 ? 'm' : 'd';
  for (const [x, y] of MARKS[kind]) g[y]![x] = 'e';
  return g;
}

// the Visual Studio Code mark, taken from its outline at 16 px
const VSCODE_MASK = [
  '...........##...',
  '..........#####.',
  '.........#######',
  '........########',
  '.##...##########',
  '####.######.####',
  '.########...####',
  '..######....####',
  '..######....####',
  '.########...####',
  '####.######.####',
  '.##...##########',
  '........########',
  '.........#######',
  '..........#####.',
  '...........##...',
];
function vscode(): Grid {
  const g = blank();
  const inside: Inside = (x, y) => VSCODE_MASK[y]?.[x] === '#';
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (inside(x, y)) g[y]![x] = shade(x, y, (x + y) / 34 + 0.3, 'ba');
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) if (inside(x, y) && (!inside(x, y - 1) || !inside(x - 1, y))) g[y]![x] = 'c';
  return g;
}

const cache = new Map<string, Grid>();
const built = (key: string, make: () => Grid): Grid => cache.get(key) ?? (cache.set(key, make()), cache.get(key)!);

/** The grid as runs of same-coloured pixels. */
function Pixels({ grid, size }: { grid: Grid; size: number }) {
  const runs: { x: number; y: number; w: number; c: string }[] = [];
  grid.forEach((row, y) => {
    let x = 0;
    while (x < N) {
      const c = row[x]!;
      let w = 1;
      while (x + w < N && row[x + w] === c) w++;
      if (c !== '.') runs.push({ x, y, w, c });
      x += w;
    }
  });
  return (
    <svg viewBox={`0 0 ${N} ${N}`} width={size} height={size} aria-hidden="true" className="flex-none" shapeRendering="crispEdges">
      {runs.map((r) => (
        <rect key={`${r.x},${r.y}`} x={r.x} y={r.y} width={r.w} height="1" style={{ fill: PALETTE[r.c] }} />
      ))}
    </svg>
  );
}

/** A classical open folder. */
export const FolderIcon = ({ size = 16 }: { size?: number }) => <Pixels grid={built('folder', folder)} size={size} />;

/** A page with a folded corner, marked by what is in it: lines for text, a hill for a picture, braces for data, chevrons for code. */
export function FileIcon({ name, size = 16 }: { name: string; size?: number }) {
  const kind = kindOf(name);
  return <Pixels grid={built(`page:${kind}`, () => page(kind))} size={size} />;
}

/** The Visual Studio Code mark, in greys. */
export const VSCodeIcon = ({ size = 16 }: { size?: number }) => <Pixels grid={built('vscode', vscode)} size={size} />;
