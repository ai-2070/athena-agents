// The Overview's strip as data: opening, closing, moving, stacking, pinning and dropping panes (of any project),
// columns per view and widths, leaving out gone panes, and what is saved in this browser.
import { beforeEach, describe, expect, it } from 'vitest';
import {
  closePane,
  dropPane,
  emptyLayout,
  evenOut,
  loadLayout,
  movePane,
  openPane,
  paneKey,
  panesInOrder,
  prune,
  resizeColumn,
  resizeStack,
  saveLayout,
  setPerView,
  stackPane,
  togglePin,
  unstackPane,
} from '../../web/overviewlayout.ts';
import type { PaneRef, StripLayout } from '../../web/overviewlayout.ts';

const a: PaneRef = { kind: 'agent', id: 'a', projectId: 'p1' };
const b: PaneRef = { kind: 'agent', id: 'b', projectId: 'p1' };
const t: PaneRef = { kind: 'team', id: 't', projectId: 'p2' };
const term: PaneRef = { kind: 'terminal', id: 'x', projectId: 'p1' };
// short names in the expectations: "agent:a" for p1's agent a
const short = (p: PaneRef) => `${p.kind}:${p.id}`;
const keys = (l: StripLayout) => l.columns.map((c) => c.panes.map(short).join('+'));
const k = { a: paneKey(a), b: paneKey(b), t: paneKey(t), term: paneKey(term) };
const three = () => [a, b, t].reduce(openPane, emptyLayout());

beforeEach(() => localStorage.clear());

describe('the strip', () => {
  it("opens a pane next to the one in use (any project's), and only focuses one already open", () => {
    let l = three();
    expect(keys(l)).toEqual(['agent:a', 'agent:b', 'team:t']);
    expect(k.t).toBe('p2/team:t');
    l = openPane({ ...l, focus: k.a }, term);
    expect(keys(l)).toEqual(['agent:a', 'terminal:x', 'agent:b', 'team:t']);
    expect(l.focus).toBe(k.term);
    const again = openPane(l, b);
    expect(keys(again)).toEqual(keys(l));
    expect(again.focus).toBe(k.b);
    // the same id in another project is another pane
    expect(keys(openPane(l, { ...b, projectId: 'p2' }))).toHaveLength(5);
  });

  it('closes a pane and gives the focus to the one beside it', () => {
    const l = closePane({ ...three(), focus: k.b }, k.b);
    expect(keys(l)).toEqual(['agent:a', 'team:t']);
    expect(l.focus).toBe(k.t);
    expect(closePane(l, 'nothing/here:x')).toBe(l);
  });

  it('moves a pane left and right, stacks it under the one before (three at most), and takes it out again', () => {
    let l = movePane(three(), k.t, -1);
    expect(keys(l)).toEqual(['agent:a', 'team:t', 'agent:b']);
    l = stackPane(l, k.t);
    expect(keys(l)).toEqual(['agent:a+team:t', 'agent:b']);
    expect(l.columns[0].heights).toEqual([0.5, 0.5]);
    l = stackPane(l, k.b);
    expect(keys(l)).toEqual(['agent:a+team:t+agent:b']);
    // a fourth doesn't fit
    l = openPane(l, term);
    expect(keys(l)).toEqual(['agent:a+team:t+agent:b', 'terminal:x']);
    expect(stackPane(l, k.term)).toEqual(l);
    l = unstackPane(l, k.t);
    expect(keys(l)).toEqual(['agent:a+agent:b', 'team:t', 'terminal:x']);
    // moving a stacked pane takes it out of the stack first
    expect(keys(movePane(l, k.b, 1))).toEqual(['agent:a', 'team:t', 'agent:b', 'terminal:x']);
  });

  it('drops a pane before, after or stacked on another', () => {
    const l = three();
    expect(keys(dropPane(l, k.t, k.a, 'before')!)).toEqual(['team:t', 'agent:a', 'agent:b']);
    expect(keys(dropPane(l, k.a, k.b, 'after')!)).toEqual(['agent:b', 'agent:a', 'team:t']);
    expect(keys(dropPane(l, k.t, k.a, 'stack')!)).toEqual(['agent:a+team:t', 'agent:b']);
    expect(dropPane(l, k.a, k.a, 'stack')).toBeNull();
  });

  it('keeps pinned columns first, and a pinned column stays among the pinned ones when moved', () => {
    let l = togglePin(three(), k.t);
    expect(keys(l)).toEqual(['team:t', 'agent:a', 'agent:b']);
    expect(l.columns[0].pinned).toBe(true);
    expect(keys(movePane(l, k.a, -1))).toEqual(['team:t', 'agent:a', 'agent:b']);
    l = togglePin(l, k.t);
    expect(l.columns.some((c) => c.pinned)).toBe(false);
  });

  it('shows 1 to 8 columns, and widths and stack heights stay within their bounds', () => {
    expect(setPerView(emptyLayout(), 0).perView).toBe(1);
    expect(setPerView(emptyLayout(), 12).perView).toBe(8);
    // a new count puts every column back to one view column wide
    const wide = resizeColumn(resizeColumn(three(), 0, 2), 2, 0.5);
    expect(setPerView(wide, 3).columns.map((c) => c.width)).toEqual([1, 1, 1]);
    let l = resizeColumn(three(), 0, 9);
    expect(l.columns[0].width).toBe(3);
    l = resizeColumn(l, 1, 0.1);
    expect(l.columns[1].width).toBe(0.5);
    expect(evenOut(l).columns.map((c) => c.width)).toEqual([1, 1, 1]);
    l = resizeStack(stackPane(three(), k.b), 0, 0, 0.99);
    expect(l.columns[0].heights[0]).toBeCloseTo(0.85);
    expect(l.columns[0].heights[0] + l.columns[0].heights[1]).toBeCloseTo(1);
  });

  it('leaves out panes whose agent, team or terminal is gone, and keeps the same layout when none is', () => {
    const l = { ...three(), focus: k.b };
    expect(prune(l, () => true)).toBe(l);
    const pruned = prune(l, (r) => r.id !== 'b');
    expect(keys(pruned)).toEqual(['agent:a', 'team:t']);
    expect(pruned.focus).toBeNull();
  });

  it('is saved, a broken saved one starts afresh, and panes saved before they said their project get one', () => {
    const l = togglePin(setPerView(three(), 3), k.b);
    saveLayout('all', l);
    expect(loadLayout('all')).toEqual(l);
    expect(loadLayout('other').columns).toEqual([]);
    localStorage.setItem('dash-overview-strip:broken', '{broken');
    expect(loadLayout('broken')).toEqual(emptyLayout());
    localStorage.setItem(
      'dash-overview-strip:p4',
      JSON.stringify({
        columns: [
          {
            panes: [
              { kind: 'nope', id: 1 },
              { kind: 'agent', id: 'a' },
            ],
            width: 99,
          },
        ],
        perView: 40,
        focus: 'agent:a',
      }),
    );
    expect(loadLayout('p4').columns).toEqual([]);
    const fixed = loadLayout('p4', 'p4');
    expect(panesInOrder(fixed)).toEqual([{ kind: 'agent', id: 'a', projectId: 'p4' }]);
    expect(fixed.columns[0].width).toBe(3);
    expect(fixed.perView).toBe(8);
    // (a focus that names no pane is dropped)
    expect(fixed.focus).toBeNull();
  });
});
