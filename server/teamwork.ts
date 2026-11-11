import { createHash } from 'node:crypto';
import { privateDataPath } from './private.ts';
import { readPlain, writeJSON } from './util.ts';
import type { ExecutionRun, SavedTeamAssignment, SavedTeamWork, TeamRelayJournal } from '../shared/types.ts';

const file = (projectId: string, teamId: string) =>
  privateDataPath(
    'runtime',
    'teams',
    `${createHash('sha256')
      .update(JSON.stringify([projectId, teamId]))
      .digest('hex')}.json`,
  );

export function readTeamWork(projectId: string, teamId: string): SavedTeamWork | null {
  const work = readPlain<SavedTeamWork | null>(file(projectId, teamId), null);
  if (work && (work.projectId !== projectId || work.teamId !== teamId))
    throw new Error('Team work cannot change ownership.');
  return work;
}

export function saveTeamWork(work: SavedTeamWork): void {
  writeJSON(file(work.projectId, work.teamId), work);
}

/** Only a saved current assignment owns an already-started native turn. */
export function activeTeamAssignment(run: ExecutionRun, teamId: string): SavedTeamAssignment | null {
  if (
    run.parentRunId !== `team:${run.projectId}/${teamId}` ||
    run.depth !== 1 ||
    run.ownerAgentId !== run.agentId ||
    run.ownerChatId !== run.chatId ||
    run.status !== 'running' ||
    run.stopRequested ||
    run.steered
  )
    return null;
  const work = readTeamWork(run.projectId, teamId);
  if (!work || work.stopped) return null;
  return (
    work.current.find(
      (item) =>
        item.agentId === run.agentId &&
        !item.steered &&
        item.delivery?.runId === run.id &&
        item.delivery.chatId === run.chatId,
    ) || null
  );
}

export const readRelayWork = (): TeamRelayJournal =>
  readPlain(privateDataPath('runtime', 'team-relays.json'), { active: [], closed: [] });
export const saveRelayWork = (work: TeamRelayJournal): void => {
  writeJSON(privateDataPath('runtime', 'team-relays.json'), work);
};
