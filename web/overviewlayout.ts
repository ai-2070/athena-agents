// The Overview's strip: which chats and terminals are open as panes (of any project), in which columns, how wide,
// which are pinned and which are stacked, and how many columns fit in one view. Plain data and functions (no DOM),
// saved in this browser.

/** What a pane shows: an agent's chat, a team's thread, a terminal, or the Brain (id 'brain'), of a project. */
export interface PaneRef {
  kind: 'agent' | 'team' | 'terminal' | 'brain';
  id: string;
  projectId: string;
}
/** A column of the strip: one pane, or up to three stacked. */
export interface StripColumn {
  panes: PaneRef[];
  /** in columns of the view: 1 is one view column wide */
  width: number;
  /** each stacked pane's share of the height (they add up to 1) */
  heights: number[];
  /** kept in view at the left while the rest slides */
  pinned: boolean;
}
export interface StripLayout {
  columns: StripColumn[];
  /** how many columns one view shows (1 to 8) */
  perView: number;
  /** the pane in use (its key) */
  focus: string | null;
}

export const STACK_MAX = 3;
export const PER_VIEW_MIN = 1;
export const PER_VIEW_MAX = 8;
const WIDTH_MIN = 0.5;
const WIDTH_MAX = 3;
const KEY = (name: string) => `dash-overview-strip:${name}`;

export const paneKey = (p: PaneRef): string => `${p.projectId}/${p.kind}:${p.id}`;
export const emptyLayout = (perView = 2): StripLayout => ({ columns: [], perView, focus: null });
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const even = (n: number) => Array.from({ length: n }, () => 1 / n);
const column = (panes: PaneRef[], width = 1): StripColumn => ({
  panes,
  width,
  heights: even(panes.length),
  pinned: false,
});
/** Pinned columns first (each keeps its order among them). */
const pinnedFirst = (cols: StripColumn[]) => [...cols.filter((c) => c.pinned), ...cols.filter((c) => !c.pinned)];
const where = (l: StripLayout, key: string): { col: number; row: number } | null => {
  for (let col = 0; col < l.columns.length; col++) {
    const row = l.columns[col].panes.findIndex((p) => paneKey(p) === key);
    if (row >= 0) return { col, row };
  }
  return null;
};

/** Every pane, left to right and top to bottom (the order Ctrl+Alt+1…9 counts in). */
export const panesInOrder = (l: StripLayout): PaneRef[] => l.columns.flatMap((c) => c.panes);

/** Opens a pane next to the one in use (or focuses it when it is open already). */
export function openPane(l: StripLayout, ref: PaneRef): StripLayout {
  const key = paneKey(ref);
  if (where(l, key)) return { ...l, focus: key };
  const at = l.focus ? where(l, l.focus) : null;
  const columns = [...l.columns];
  columns.splice(at ? at.col + 1 : columns.length, 0, column([ref]));
  return { ...l, columns: pinnedFirst(columns), focus: key };
}

/** Takes a pane away; its column goes when it was the only one there. The pane beside it gets the focus. */
export function closePane(l: StripLayout, key: string): StripLayout {
  const at = where(l, key);
  if (!at) return l;
  const order = panesInOrder(l).map(paneKey);
  const i = order.indexOf(key);
  const next = order[i + 1] ?? order[i - 1] ?? null;
  const columns = l.columns.flatMap((c, ci) => {
    if (ci !== at.col) return [c];
    const panes = c.panes.filter((p) => paneKey(p) !== key);
    return panes.length ? [{ ...c, panes, heights: even(panes.length) }] : [];
  });
  return { ...l, columns, focus: l.focus === key ? next : l.focus };
}

/** Moves a pane's column one place left or right (a stacked pane comes out into a column of its own first). */
export function movePane(l: StripLayout, key: string, dir: -1 | 1): StripLayout {
  let layout = l;
  let at = where(layout, key);
  if (!at) return l;
  if (layout.columns[at.col].panes.length > 1) {
    layout = unstackPane(layout, key);
    at = where(layout, key)!;
  }
  const to = at.col + dir;
  const cols = layout.columns;
  // (a column stays among its kind: pinned ones before the others)
  if (to < 0 || to >= cols.length || cols[to].pinned !== cols[at.col].pinned) return { ...layout, focus: key };
  const columns = [...cols];
  [columns[at.col], columns[to]] = [columns[to], columns[at.col]];
  return { ...layout, columns, focus: key };
}

/** Stacks a pane under the panes of the column before it (at most three in one column). */
export function stackPane(l: StripLayout, key: string): StripLayout {
  const at = where(l, key);
  if (!at || at.col === 0) return l;
  const target = l.columns[at.col - 1];
  if (target.panes.length >= STACK_MAX) return l;
  const ref = l.columns[at.col].panes[at.row];
  return dropPane(l, key, paneKey(target.panes[target.panes.length - 1]), 'stack') ?? { ...l, focus: paneKey(ref) };
}

/** Takes a stacked pane out into a column of its own, right after. */
export function unstackPane(l: StripLayout, key: string): StripLayout {
  const at = where(l, key);
  if (!at || l.columns[at.col].panes.length < 2) return l;
  const from = l.columns[at.col];
  const ref = from.panes[at.row];
  const rest = from.panes.filter((_, i) => i !== at.row);
  const columns = [...l.columns];
  columns.splice(
    at.col,
    1,
    { ...from, panes: rest, heights: even(rest.length) },
    { ...column([ref], from.width), pinned: from.pinned },
  );
  return { ...l, columns, focus: key };
}

/** A pane dropped on another: before or after its column, or stacked below it. null when it can't go there. */
export function dropPane(
  l: StripLayout,
  key: string,
  onto: string,
  how: 'before' | 'after' | 'stack',
): StripLayout | null {
  if (key === onto) return null;
  const from = where(l, key);
  const to = where(l, onto);
  if (!from || !to) return null;
  if (how === 'stack' && l.columns[to.col].panes.length >= STACK_MAX && from.col !== to.col) return null;
  const ref = l.columns[from.col].panes[from.row];
  // take it out (its column goes when it was alone), then find the target again
  const columns = l.columns.flatMap((c, ci) => {
    if (ci !== from.col) return [c];
    const panes = c.panes.filter((_, i) => i !== from.row);
    return panes.length ? [{ ...c, panes, heights: even(panes.length) }] : [];
  });
  const target = columns.findIndex((c) => c.panes.some((p) => paneKey(p) === onto));
  if (how === 'stack') {
    const c = columns[target];
    const row = c.panes.findIndex((p) => paneKey(p) === onto);
    const panes = [...c.panes.slice(0, row + 1), ref, ...c.panes.slice(row + 1)];
    columns[target] = { ...c, panes, heights: even(panes.length) };
  } else {
    columns.splice(how === 'before' ? target : target + 1, 0, { ...column([ref]), pinned: columns[target].pinned });
  }
  return { ...l, columns: pinnedFirst(columns), focus: key };
}

/** Pins a pane's column (kept in view at the left), or lets it go back among the others. */
export function togglePin(l: StripLayout, key: string): StripLayout {
  const at = where(l, key);
  if (!at) return l;
  const columns = l.columns.map((c, i) => (i === at.col ? { ...c, pinned: !c.pinned } : c));
  return { ...l, columns: pinnedFirst(columns), focus: key };
}

/** How many columns one view shows; every column goes back to one view column wide (widths set for the old count
 *  would no longer fit). */
export const setPerView = (l: StripLayout, n: number): StripLayout => ({
  ...l,
  perView: clamp(Math.round(n), PER_VIEW_MIN, PER_VIEW_MAX),
  columns: l.columns.map((c) => (c.width === 1 ? c : { ...c, width: 1 })),
});
export const resizeColumn = (l: StripLayout, col: number, width: number): StripLayout => ({
  ...l,
  columns: l.columns.map((c, i) => (i === col ? { ...c, width: clamp(width, WIDTH_MIN, WIDTH_MAX) } : c)),
});
/** Every column back to one view column wide, and stacks to even heights. */
export const evenOut = (l: StripLayout): StripLayout => ({
  ...l,
  columns: l.columns.map((c) => ({ ...c, width: 1, heights: even(c.panes.length) })),
});
/** Moves the line between stacked panes row and row + 1 (share: the upper one's new share of the two). */
export function resizeStack(l: StripLayout, col: number, row: number, share: number): StripLayout {
  return {
    ...l,
    columns: l.columns.map((c, i) => {
      if (i !== col || row + 1 >= c.panes.length) return c;
      const both = c.heights[row] + c.heights[row + 1];
      const upper = clamp(share, 0.15, 0.85) * both;
      const heights = [...c.heights];
      heights[row] = upper;
      heights[row + 1] = both - upper;
      return { ...c, heights };
    }),
  };
}

/** Leaves out panes whose agent, team or terminal is gone. */
export function prune(l: StripLayout, exists: (ref: PaneRef) => boolean): StripLayout {
  const columns = l.columns.flatMap((c) => {
    const panes = c.panes.filter(exists);
    if (panes.length === c.panes.length) return [c];
    return panes.length ? [{ ...c, panes, heights: even(panes.length) }] : [];
  });
  if (columns.length === l.columns.length && columns.every((c, i) => c === l.columns[i])) return l;
  const focus = l.focus && columns.some((c) => c.panes.some((p) => paneKey(p) === l.focus)) ? l.focus : null;
  return { ...l, columns, focus };
}

/** A saved strip (a broken one starts afresh). project: the project of panes saved before panes said theirs. */
export function loadLayout(name: string, project?: string, perView = 2): StripLayout {
  try {
    const v = JSON.parse(localStorage.getItem(KEY(name)) || 'null') as Partial<StripLayout> | null;
    if (!v || !Array.isArray(v.columns)) return emptyLayout(perView);
    const ref = (p: unknown): PaneRef[] => {
      const x = p as Partial<PaneRef> | null;
      if (
        !x ||
        typeof x !== 'object' ||
        !['agent', 'team', 'terminal', 'brain'].includes(String(x.kind)) ||
        typeof x.id !== 'string'
      )
        return [];
      const projectId = typeof x.projectId === 'string' && x.projectId ? x.projectId : project;
      return projectId ? [{ kind: x.kind as PaneRef['kind'], id: x.id, projectId }] : [];
    };
    const columns = v.columns.flatMap((c): StripColumn[] => {
      const panes = Array.isArray(c?.panes) ? c.panes.flatMap(ref).slice(0, STACK_MAX) : [];
      if (!panes.length) return [];
      const heights =
        Array.isArray(c.heights) &&
        c.heights.length === panes.length &&
        c.heights.every((h) => typeof h === 'number' && h > 0)
          ? c.heights
          : even(panes.length);
      return [
        {
          panes,
          width: clamp(typeof c.width === 'number' ? c.width : 1, WIDTH_MIN, WIDTH_MAX),
          heights,
          pinned: !!c.pinned,
        },
      ];
    });
    const keys = new Set(columns.flatMap((c) => c.panes.map(paneKey)));
    return {
      columns: pinnedFirst(columns),
      perView: clamp(typeof v.perView === 'number' ? v.perView : perView, PER_VIEW_MIN, PER_VIEW_MAX),
      focus: typeof v.focus === 'string' && keys.has(v.focus) ? v.focus : null,
    };
  } catch {
    return emptyLayout(perView);
  }
}

export function saveLayout(name: string, l: StripLayout): void {
  try {
    localStorage.setItem(KEY(name), JSON.stringify(l));
  } catch {
    /* full storage: the layout just isn't remembered */
  }
}
