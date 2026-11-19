// Autonomy, from the most careful to the least: "ask" asks about low and high risk, "auto" about high, "full" never.
import type { Autonomy } from './types.ts';

const ORDER: readonly Autonomy[] = ['ask', 'auto', 'full'];

/** The tools the agent's "Always allow" covers in this run: none while a cap holds it back (a webhook's "ask first"
 *  asks before risky steps, whatever was always allowed before). */
export const alwaysAllowed = (agent: { alwaysAllow?: string[]; _autonomyCap?: Autonomy }): string[] =>
  agent._autonomyCap ? [] : agent.alwaysAllow || [];

/** The more careful of the two (a missing cap leaves the autonomy as it is). */
export function stricterAutonomy(autonomy: Autonomy | undefined, cap: Autonomy | undefined): Autonomy {
  const own = autonomy || 'auto';
  if (!cap) return own;
  return ORDER.indexOf(cap) < ORDER.indexOf(own) ? cap : own;
}
