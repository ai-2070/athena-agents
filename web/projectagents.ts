// The agents of projects that aren't open, for Overview panes that show their chats: the open project's are in the
// app state, these are fetched from /api/p/<project>/agents when a pane needs them, and kept current while it shows.
import { useEffect, useSyncExternalStore } from 'react';
import { GET, onEvent } from './core.ts';
import type { Agent } from '../shared/types.ts';

const byProject = new Map<string, Agent[]>();
const listeners = new Set<() => void>();
let version = 0;
const notify = () => ((version += 1), listeners.forEach((fn) => fn()));
const subscribe = (fn: () => void) => (listeners.add(fn), () => void listeners.delete(fn));

/** Fetches a project's agents (again). */
export async function loadProjectAgents(projectId: string): Promise<Agent[]> {
  const list = await GET<Agent[]>(`/p/${encodeURIComponent(projectId)}/agents`).catch((): Agent[] => byProject.get(projectId) || []);
  byProject.set(projectId, Array.isArray(list) ? list : []);
  notify();
  return byProject.get(projectId)!;
}

/** A project's agents as fetched (empty until they are). */
export const projectAgents = (projectId: string): Agent[] => byProject.get(projectId) || [];

/** An agent of a project that isn't open, by id (the first project that has it). */
export function foreignAgent(id: string): Agent | undefined {
  for (const list of byProject.values()) {
    const a = list.find((x) => x.id === id);
    if (a) return a;
  }
  return undefined;
}

/** A project's agents, fetched on first use and again when agents change; re-renders when they arrive. */
export function useProjectAgents(projectId: string | undefined): Agent[] {
  useSyncExternalStore(subscribe, () => version);
  useEffect(() => {
    if (!projectId) return;
    void loadProjectAgents(projectId);
    return onEvent((e) => void (e.type === 'agents' && loadProjectAgents(projectId)));
  }, [projectId]);
  return projectId ? projectAgents(projectId) : [];
}
