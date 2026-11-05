// What the page shows about the dashboard and this PC (server/api/status.ts): the app state every page starts from,
// the activity feed, the header's usage meters, the sidebar's plan limits, the Overview, the built-in tools and
// how they have been used, the models an engine can use, and the About page.
import { oc, type } from '@orpc/contract';
import { z } from 'zod';
import type { AboutInfo, ActivityEntry, AppState, HeadbarInfo, ModelListing, OverviewData, ToolGroup, ToolListing, ToolStats, UsageLimits } from '../types.ts';

export const status = {
  /** Everything a page starts from: agents, projects, what waits for you, runs, engines, settings… */
  state: oc.route({ method: 'GET', path: '/state' }).output(type<AppState>()),
  /** The latest 200 things that happened. */
  activity: oc.route({ method: 'GET', path: '/activity' }).output(type<ActivityEntry[]>()),
  headbar: oc.route({ method: 'GET', path: '/headbar' }).output(type<HeadbarInfo>()),
  /** Your Claude and Codex plan limits, and Codex's free limit resets. */
  usageLimits: oc.route({ method: 'GET', path: '/usage-limits' }).output(type<UsageLimits>()),
  /** Every project's agents, teams, the Brain and tasks being worked on, at a glance. */
  overview: oc.route({ method: 'GET', path: '/overview' }).output(type<OverviewData>()),
  tools: oc.route({ method: 'GET', path: '/tools' }).output(type<{ groups: ToolGroup[]; tools: ToolListing[] }>()),
  /** Counted on this computer only. */
  toolStats: oc.route({ method: 'GET', path: '/tool-stats' }).output(type<ToolStats>()),
  /** The models an engine can use; for API models (engine eve), those of a provider (openrouter unless given). */
  models: oc.route({ method: 'GET', path: '/models' })
    .input(z.object({ engine: z.string().optional(), provider: z.string().optional() }))
    .output(type<ModelListing[]>()),
  providers: oc.route({ method: 'GET', path: '/providers' }).output(type<{ id: string; label: string }[]>()),
  /** The version, and (stars=1) how many stars the GitHub repo has. */
  about: oc.route({ method: 'GET', path: '/about' }).input(z.object({ stars: z.string().optional() })).output(type<AboutInfo>()),
};
