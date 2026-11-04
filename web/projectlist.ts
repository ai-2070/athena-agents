// A list of a project that isn't open (its agents, its questions), for Overview panes: fetched from
// /api/p/<project>/… when a pane first needs it and again when it changes. However many panes show it, a project has
// one listener and one request at a time (a change while one is on its way asks once more after it), and only the
// panes of that project draw again.
import { useCallback, useSyncExternalStore } from 'react';
import { GET, onEvent } from './core.ts';
import { projectAt } from './client/connection.ts';

export interface ProjectList<T> {
  /** Fetches a project's list (again). */
  load: (projectId: string) => Promise<T[]>;
  /** A project's list as fetched (empty until it is). */
  get: (projectId: string) => T[];
  /** A project's list, kept current while a component shows it; undefined: none (an empty list). */
  use: (projectId: string | undefined) => T[];
}

const NONE: never[] = [];

/** path: the route after /api/p/<project> ('/agents'); events: the event types that change it. */
export function projectList<T>(path: string, events: readonly string[]): ProjectList<T> {
  const lists = new Map<string, T[]>();
  const loading = new Map<string, Promise<T[]>>();
  const again = new Set<string>();
  const listeners = new Map<string, Set<() => void>>();
  const offs = new Map<string, () => void>();

  function load(id: string): Promise<T[]> {
    const busy = loading.get(id);
    if (busy) return (again.add(id), busy);
    const request = GET<T[]>(`${projectAt(id)}${path}`)
      .catch((): T[] => lists.get(id) || [])
      .then((list) => {
        lists.set(id, Array.isArray(list) ? list : []);
        loading.delete(id);
        listeners.get(id)?.forEach((fn) => fn());
        if (again.delete(id)) void load(id);
        return lists.get(id)!;
      });
    loading.set(id, request);
    return request;
  }
  const get = (id: string): T[] => lists.get(id) || NONE;

  function subscribe(id: string, fn: () => void): () => void {
    let set = listeners.get(id);
    if (!set) {
      set = new Set();
      listeners.set(id, set);
      offs.set(id, onEvent((e) => void (events.includes(e.type) && load(id))));
      void load(id);
    }
    set.add(fn);
    const mine = set;
    return () => {
      mine.delete(fn);
      if (mine.size || listeners.get(id) !== mine) return;
      listeners.delete(id);
      offs.get(id)?.();
      offs.delete(id);
    };
  }

  function use(id: string | undefined): T[] {
    const sub = useCallback((fn: () => void) => (id ? subscribe(id, fn) : () => {}), [id]);
    return useSyncExternalStore(sub, () => (id ? get(id) : NONE));
  }

  return { load, get, use };
}
