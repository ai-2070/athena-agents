// Team helpers the server and the page share.
import type { Team, TeamStep } from './types.ts';

// An old step list with tools, approvals, posts or notices runs as a workflow, not as a team chat.
export function isStepList(team: Pick<Team, 'steps'> | null | undefined): boolean {
  return (team?.steps || []).some((s) => s.type !== 'agent');
}

// The steps a team keeps when its members change: one per member, or, for a step list,
// its own steps minus agents that left, with new members added after the last agent step.
export function teamSteps(team: Pick<Team, 'steps' | 'members'>): TeamStep[] {
  const bare = (agentId: string): TeamStep => ({ type: 'agent', agentId });
  if (!isStepList(team)) return team.members.map(bare);
  const kept = team.steps.filter((s) => s.type !== 'agent' || team.members.includes(s.agentId as string));
  const have = new Set(kept.map((s) => s.agentId));
  const added = team.members.filter((id) => !have.has(id)).map(bare);
  const at = kept.findLastIndex((s) => s.type === 'agent') + 1;
  return [...kept.slice(0, at), ...added, ...kept.slice(at)];
}
