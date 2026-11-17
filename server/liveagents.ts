// Agents that exist only while they work: the Brain is made for each turn (brainrun.ts) and never saved with the
// others, yet an engine that looks its agent up by id (Eve, which keeps its runs on disk) must find it. Kept here
// for its project while its turn runs.
import { activeProject, agents } from './store.ts';
import type { Agent } from '../shared/types.ts';

const live = new Map<string, Agent>();
const key = (projectId: string, id: string) => `${projectId}\n${id}`;

/** Makes `agent` findable by id in its project until the returned function is called. */
export function holdLiveAgent(projectId: string, agent: Agent): () => void {
  const k = key(projectId, agent.id);
  live.set(k, agent);
  return () => {
    if (live.get(k) === agent) live.delete(k);
  };
}

/** An agent by id in the open project (or the one a run is pinned to): a saved one, else one working now. */
export function findAgent(id: string): Agent | null {
  return agents.get(id) || live.get(key(activeProject().id, id)) || null;
}
