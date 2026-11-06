// The agents of projects that aren't open, for Overview panes that show their chats: the open project's are in the
// app state, these are fetched from /api/p/<project>/agents when a pane needs them, and kept current while it shows
// (projectlist.ts: one request at a time per project, however many panes).
import { projectList } from './projectlist.ts';
import { rpcAt } from './client/rpc.ts';
import type { Agent } from '../shared/types.ts';

const list = projectList<Agent>((at) => rpcAt(at).agents.list(), ['agents']);

/** Fetches a project's agents (again). */
export const loadProjectAgents = list.load;

/** A project's agents as fetched (empty until they are). */
export const projectAgents = list.get;

/** A project's agents, fetched on first use and again when agents change; re-renders when they arrive. */
export const useProjectAgents = list.use;
