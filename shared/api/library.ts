// The Agent library and your presets (server/api/library.ts): Athena's agents, this PC's Hermes profiles and Claude
// Code subagents to hire, and agents and teams you kept as templates to make again in any project.
import { oc, type } from '@orpc/contract';
import { z } from 'zod';
import { agentPatch } from './agents.ts';
import type {
  Agent,
  AgentPreset,
  LibraryAgentListing,
  LibraryIndex,
  PresetListing,
  Team,
  TeamPreset,
} from '../types.ts';

const named = z.object({ id: z.string(), name: z.string({ error: 'Name the preset.' }).optional() });

export const library = {
  list: oc.route({ method: 'GET', path: '/library' }).output(type<LibraryIndex>()),
  /** One of Athena's agents with its whole text. */
  agent: oc
    .route({ method: 'GET', path: '/library/agent/{slug}' })
    .input(z.object({ slug: z.string() }))
    .output(type<LibraryAgentListing & { body: string }>()),
  /** A new agent from the library (slug, with overrides such as its engine and model), a Hermes profile (profile)
   *  or a Claude Code subagent (slug). */
  hire: oc
    .route({ method: 'POST', path: '/library/hire' })
    .input(
      z.object({
        source: z.enum(['library', 'hermes', 'claude'], { error: 'Unknown library source' }),
        slug: z.string().optional(),
        profile: z.string().optional(),
        overrides: agentPatch.optional(),
      }),
    )
    .output(type<Agent>()),
};

export const presets = {
  list: oc.route({ method: 'GET', path: '/presets' }).output(type<PresetListing[]>()),
  /** Keeps an agent, or a team with its agents, as a template (name: the preset's, else the agent's or team's). */
  saveAgent: oc.route({ method: 'POST', path: '/presets/agent/{id}' }).input(named).output(type<AgentPreset>()),
  saveTeam: oc.route({ method: 'POST', path: '/presets/team/{id}' }).input(named).output(type<TeamPreset>()),
  /** Makes it again in the open project. */
  use: oc
    .route({ method: 'POST', path: '/presets/{id}/use' })
    .input(z.object({ id: z.string() }))
    .output(type<{ agent: Agent } | { team: Team; agents: Agent[] }>()),
  remove: oc
    .route({ method: 'DELETE', path: '/presets/{id}' })
    .input(z.object({ id: z.string() }))
    .output(type<{ ok: true }>()),
};
