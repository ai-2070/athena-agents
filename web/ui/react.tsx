// What a React page needs from the rest of the app: a place to mount, the live app state, and icons.
import { StrictMode, useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { DependencyList, ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { h, mount, onEvent, onState, state } from '../core.ts';
import { icon } from '../icons.ts';
import type { AppState, ServerEvent } from '../../shared/types.ts';

/** Draws a React page into the router's page element. unmount() when you leave the page. */
export function mountReact(el: HTMLElement, node: ReactNode): { unmount: () => void } {
  const root = createRoot(el);
  root.render(<StrictMode>{node}</StrictMode>);
  return { unmount: () => root.unmount() };
}

/** A page module's render() and unmount() for a page drawn by React:
 *  export const { render, unmount } = reactPage((params) => <MyPage params={params} />); */
export function reactPage(page: (params: string[]) => ReactNode): { render: (el: HTMLElement, params?: string[]) => void; unmount: () => void } {
  let mounted: { unmount: () => void } | null = null;
  return {
    render(el, params = []) {
      mounted?.unmount();
      mounted = mountReact(el, page(params));
    },
    unmount() {
      mounted?.unmount();
      mounted = null;
    },
  };
}

/** Runs fn for live events from the server (only the latest fn, so it can read fresh state). */
export function useServerEvents(fn: (ev: ServerEvent) => void): void {
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(() => onEvent((ev) => latest.current(ev)), []);
}

/** A plain-DOM piece (a file preview, markdown, the 3D viewer) inside a React page. make() runs again
 *  only when deps change, so the piece keeps its own state between redraws. */
export function DomNode({ make, deps, className, as = 'div' }: { make: () => Node | null; deps: DependencyList; className?: string; as?: 'div' | 'span' }) {
  const node = useMemo(make, deps);
  const ref = useCallback((el: HTMLElement | null) => void (el && el.replaceChildren(...(node ? [node] : []))), [node]);
  return as === 'span' ? <span ref={ref} className={className} /> : <div ref={ref} className={className} />;
}

/** A page module that still draws plain DOM (render/unmount/onEvent, as in app.ts). */
export interface PlainView {
  render(el: HTMLElement, params?: string[]): unknown;
  unmount?(): unknown;
  onEvent?(ev: ServerEvent): unknown;
}

/** Runs a plain-DOM page inside a React page (a Settings tab), with live events, until React moves on.
 *  Each mount gets a fresh element, so a slow render from a page you left lands out of sight. */
export function ViewHost({ view, params = [], hostRef }: { view: PlainView; params?: string[]; hostRef?: (el: HTMLDivElement | null) => void }) {
  const box = useRef<HTMLDivElement | null>(null);
  const key = params.join('/');
  useEffect(() => {
    const el = document.createElement('div');
    box.current!.append(el);
    let live = true;
    Promise.resolve(view.render(el, key ? key.split('/') : [])).catch((e: unknown) => {
      if (live) mount(el, h('div.panel', h('p.red', `Something went wrong: ${e instanceof Error ? e.message : String(e)}`)));
    });
    return () => {
      live = false;
      view.unmount?.();
      el.remove();
    };
  }, [view, key]);
  useServerEvents((ev) => view.onEvent?.(ev));
  return <div ref={(el) => ((box.current = el), hostRef?.(el))} />;
}

const subscribe = (fn: () => void) => onState(fn);
const read = () => state.data;

/** The app's state (GET /api/state), redrawn whenever it refreshes. Null until the first load. */
export const useAppState = (): AppState | null => useSyncExternalStore(subscribe, read);

/** One of the app's icons (web/icons.ts). */
export function Icon({ name, size = 16, className = '' }: { name: string; size?: number; className?: string }) {
  const markup = useMemo(() => ({ __html: icon(name).innerHTML }), [name]);
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`ico-svg ${className}`.trim()}
      aria-hidden="true"
      dangerouslySetInnerHTML={markup}
    />
  );
}
