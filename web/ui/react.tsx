// What a React page needs from the rest of the app: a place to mount, the live app state, and icons.
import { StrictMode, useMemo, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { onState, state } from '../core.ts';
import { icon } from '../icons.ts';
import type { AppState } from '../../shared/types.ts';

/** Draws a React page into the router's page element. unmount() when you leave the page. */
export function mountReact(el: HTMLElement, node: ReactNode): { unmount: () => void } {
  const root = createRoot(el);
  root.render(<StrictMode>{node}</StrictMode>);
  return { unmount: () => root.unmount() };
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
