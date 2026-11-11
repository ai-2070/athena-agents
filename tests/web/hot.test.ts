// Hot reload's rules on the page's side: React may swap a page in web/views/ in place, leaving the router's hooks
// out of its check (they keep their first version until the next reload), and a page that breaks right after an
// update reloads.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BROKE_WITHIN_MS,
  VIEW_EXPORTS,
  ignoredExports,
  installHotRules,
  markView,
  watchUpdates,
} from '../../web/dev/hot.ts';
import type { HotEvents } from '../../web/dev/hot.ts';

describe('ignoredExports', () => {
  it("leaves a page's router hooks out of React's check, once the page has said it is one", () => {
    expect(ignoredExports('/Users/me/athena/web/views/home.tsx')).toEqual([]);
    markView('/Users/me/athena/web/views/home.tsx');
    markView('C:\\Users\\me\\athena\\web\\views\\tasks.tsx');
    expect(ignoredExports('/Users/me/athena/web/views/home.tsx')).toEqual([...VIEW_EXPORTS]);
    expect(ignoredExports('C:\\Users\\me\\athena\\web\\views\\tasks.tsx')).toEqual([...VIEW_EXPORTS]);
    expect(ignoredExports('/Users/me/athena/web/views/home.tsx?t=123')).toEqual([...VIEW_EXPORTS]);
  });

  it('checks every other file in full, wherever it is', () => {
    for (const id of [
      '/Users/me/athena/web/app.ts',
      '/Users/me/athena/web/views/station.ts',
      '/Users/me/athena/web/views/stationpanel.tsx',
      '/Users/me/athena/web/ui/button.tsx',
    ])
      expect(ignoredExports(id), id).toEqual([]);
  });

  it("is what React's refresh runtime asks once installed, and what the pages call", () => {
    installHotRules(window, undefined);
    window.__dashHotView?.('/a/web/views/library.tsx');
    expect(window.__getReactRefreshIgnoredExports?.({ id: '/a/web/views/library.tsx' })).toEqual([...VIEW_EXPORTS]);
    expect(window.__getReactRefreshIgnoredExports?.({ id: '/a/web/core.ts' })).toEqual([]);
  });
});

describe('watchUpdates: a page that breaks right after a hot update reloads', () => {
  // Vite's import.meta.hot, with a way to fire its events
  const fakeHot = () => {
    const on = new Map<string, ((p: unknown) => void)[]>();
    const hot: HotEvents = { on: (event, cb) => void on.set(event, [...(on.get(event) || []), cb]) };
    return { hot, fire: (event: string) => on.get(event)?.forEach((cb) => cb(undefined)) };
  };
  let stop = () => {};
  let clock = 1_000_000;
  const setup = () => {
    const { hot, fire } = fakeHot();
    const reload = vi.fn();
    stop = watchUpdates(hot, { win: window, reload, now: () => clock });
    return { fire, reload };
  };
  const uncaught = () => window.dispatchEvent(new ErrorEvent('error', { error: new Error('broke'), message: 'broke' }));
  const unhandled = () => window.dispatchEvent(new Event('unhandledrejection'));
  let quiet: ReturnType<typeof vi.spyOn>;
  afterEach(() => {
    stop();
    quiet?.mockRestore();
  });

  it('reloads on an uncaught error just after an update, once', () => {
    quiet = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { fire, reload } = setup();
    fire('vite:afterUpdate');
    clock += 500;
    uncaught();
    uncaught();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('reloads on a promise nobody handled just after an update', () => {
    quiet = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { fire, reload } = setup();
    fire('vite:afterUpdate');
    unhandled();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('leaves errors alone with no update, or long after one', () => {
    const { fire, reload } = setup();
    uncaught();
    fire('vite:afterUpdate');
    clock += BROKE_WITHIN_MS + 1;
    uncaught();
    unhandled();
    expect(reload).not.toHaveBeenCalled();
  });

  it("leaves harmless errors alone: the browser's ResizeObserver note, a request called off", () => {
    const { fire, reload } = setup();
    fire('vite:afterUpdate');
    window.dispatchEvent(
      new ErrorEvent('error', { message: 'ResizeObserver loop completed with undelivered notifications.' }),
    );
    const aborted = new Event('unhandledrejection') as Event & { reason?: unknown };
    aborted.reason = new DOMException('The operation was aborted.', 'AbortError');
    window.dispatchEvent(aborted);
    expect(reload).not.toHaveBeenCalled();
  });

  it('stops watching when asked', () => {
    const { fire, reload } = setup();
    stop();
    fire('vite:afterUpdate');
    uncaught();
    expect(reload).not.toHaveBeenCalled();
  });
});
