import { createHash } from 'node:crypto';
import { privateDataPath } from './private.ts';
import { readPlain, writeJSON } from './util.ts';
import type { SavedTeamWork, TeamRelayJournal } from '../shared/types.ts';

const file = (projectId: string, teamId: string) => privateDataPath('runtime', 'teams', `${createHash('sha256').update(JSON.stringify([projectId, teamId])).digest('hex')}.json`);

export function readTeamWork(projectId: string, teamId: string): SavedTeamWork | null {
  const work = readPlain<SavedTeamWork | null>(file(projectId, teamId), null);
  if (work && (work.projectId !== projectId || work.teamId !== teamId)) throw new Error('Team work cannot change ownership.');
  return work;
}

export function saveTeamWork(work: SavedTeamWork): void {
  writeJSON(file(work.projectId, work.teamId), work);
}

export const readRelayWork = (): TeamRelayJournal => readPlain(privateDataPath('runtime', 'team-relays.json'), { active: [], closed: [] });
export const saveRelayWork = (work: TeamRelayJournal): void => { writeJSON(privateDataPath('runtime', 'team-relays.json'), work); };
