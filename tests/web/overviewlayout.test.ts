// The Overview's strip as data: opening, closing, moving, stacking, pinning and dropping panes, columns per view and
// widths, leaving out gone panes, and what is saved in this browser.
import { beforeEach, describe, expect, it } from 'vitest';
import { closePane, dropPane, emptyLayout, evenOut, loadLayout, movePane, openPane, paneKey, panesInOrder, prune, resizeColumn, resizeStack, saveLayout, setPerView, stackPane, togglePin, unstackPane } from '../../web/overviewlayout.ts';
import type { PaneRef, StripLayout } from '../../web/overviewlayout.ts';

const a: PaneRef = { kind: 'agent', id: 'a' };
const b: PaneRef = { kind: 'agent', id: 'b' };
const t: PaneRef = { kind: 'team', id: 't' };
const term: PaneRef = { kind: 'terminal', id: 'x' };
const keys = (l: StripLayout) => l.columns.map((c) => c.panes.map(paneKey).join('+'));
const three = () => [a, b, t].reduce(openPane, emptyLayout());

beforeEach(() => localStorage.clear());

describe('the strip', () => {
  it('opens a pane next to the one in use, and only focuses one already open', () => {
    let l = three();
    expect(keys(l)).toEqual(['agent:a', 'agent:b', 'team:t']);
    l = openPane({ ...l, focus: 'agent:a' }, term);
    expect(keys(l)).toEqual(['agent:a', 'terminal:x', 'agent:b', 'team:t']);
    expect(l.focus).toBe('terminal:x');
    const again = openPane(l, b);
    expect(keys(again)).toEqual(keys(l));
    expect(again.focus).toBe('agent:b');
  });

  it('closes a pane and gives the focus to the one beside it', () => {
    const l = closePane({ ...three(), focus: 'agent:b' }, 'agent:b');
    expect(keys(l)).toEqual(['agent:a', 'team:t']);
    expect(l.focus).toBe('team:t');
    expect(closePane(l, 'nothing:here')).toBe(l);
  });

  it('moves a pane left and right, stacks it under the one before (three at most), and takes it out again', () => {
    let l = movePane(three(), 'team:t', -1);
    expect(keys(l)).toEqual(['agent:a', 'team:t', 'agent:b']);
    l = stackPane(l, 'team:t');
    expect(keys(l)).toEqual(['agent:a+team:t', 'agent:b']);
    expect(l.columns[0].heights).toEqual([0.5, 0.5]);
    l = stackPane(l, 'agent:b');
    expect(keys(l)).toEqual(['agent:a+team:t+agent:b']);
    // a fourth doesn't fit
    l = openPane(l, term);
    expect(keys(l)).toEqual(['agent:a+team:t+agent:b', 'terminal:x']);
    expect(stackPane(l, 'terminal:x')).toEqual(l);
    l = unstackPane(l, 'team:t');
    expect(keys(l)).toEqual(['agent:a+agent:b', 'team:t', 'terminal:x']);
    // moving a stacked pane takes it out of the stack first
    expect(keys(movePane(l, 'agent:b', 1))).toEqual(['agent:a', 'team:t', 'agent:b', 'terminal:x']);
  });

  it('drops a pane before, after or stacked on another', () => {
    const l = three();
    expect(keys(dropPane(l, 'team:t', 'agent:a', 'before')!)).toEqual(['team:t', 'agent:a', 'agent:b']);
    expect(keys(dropPane(l, 'agent:a', 'agent:b', 'after')!)).toEqual(['agent:b', 'agent:a', 'team:t']);
    expect(keys(dropPane(l, 'team:t', 'agent:a', 'stack')!)).toEqual(['agent:a+team:t', 'agent:b']);
    expect(dropPane(l, 'agent:a', 'agent:a', 'stack')).toBeNull();
  });

  it('keeps pinned columns first, and a pinned column stays among the pinned ones when moved', () => {
    let l = togglePin(three(), 'team:t');
    expect(keys(l)).toEqual(['team:t', 'agent:a', 'agent:b']);
    expect(l.columns[0].pinned).toBe(true);
    expect(keys(movePane(l, 'agent:a', -1))).toEqual(['team:t', 'agent:a', 'agent:b']);
    l = togglePin(l, 'team:t');
    expect(l.columns.some((c) => c.pinned)).toBe(false);
  });

  it('shows 1 to 8 columns, and widths and stack heights stay within their bounds', () => {
    expect(setPerView(emptyLayout(), 0).perView).toBe(1);
    expect(setPerView(emptyLayout(), 12).perView).toBe(8);
    let l = resizeColumn(three(), 0, 9);
    expect(l.columns[0].width).toBe(3);
    l = resizeColumn(l, 1, 0.1);
    expect(l.columns[1].width).toBe(0.5);
    expect(evenOut(l).columns.map((c) => c.width)).toEqual([1, 1, 1]);
    l = resizeStack(stackPane(three(), 'agent:b'), 0, 0, 0.99);
    expect(l.columns[0].heights[0]).toBeCloseTo(0.85);
    expect(l.columns[0].heights[0] + l.columns[0].heights[1]).toBeCloseTo(1);
  });

  it('leaves out panes whose agent, team or terminal is gone, and keeps the same layout when none is', () => {
    const l = { ...three(), focus: 'agent:b' };
    expect(prune(l, () => true)).toBe(l);
    const pruned = prune(l, (r) => r.id !== 'b');
    expect(keys(pruned)).toEqual(['agent:a', 'team:t']);
    expect(pruned.focus).toBeNull();
  });

  it('is saved for each project, and a broken saved one starts afresh', () => {
    const l = togglePin(setPerView(three(), 3), 'agent:b');
    saveLayout('p1', l);
    expect(loadLayout('p1')).toEqual(l);
    expect(loadLayout('p2').columns).toEqual([]);
    localStorage.setItem('dash-overview-strip:p3', '{broken');
    expect(loadLayout('p3')).toEqual(emptyLayout());
    localStorage.setItem('dash-overview-strip:p4', JSON.stringify({ columns: [{ panes: [{ kind: 'nope', id: 1 }, a], width: 99 }], perView: 40 }));
    const fixed = loadLayout('p4');
    expect(panesInOrder(fixed)).toEqual([a]);
    expect(fixed.columns[0].width).toBe(3);
    expect(fixed.perView).toBe(8);
  });
});
