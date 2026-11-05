// The Agent library and your presets (shared/api/library.ts).
import fs from 'node:fs';
import { implement } from '@orpc/server';
import { library as libraryContract, presets as presetsContract } from '../../shared/api/library.ts';
import * as library from '../library.ts';
import * as presets from '../presets.ts';
import { refuse, refusing } from './refuse.ts';

const l = implement(libraryContract);
const p = implement(presetsContract);

export const libraryRouter = l.router({
  list: l.list.handler(() => library.libraryIndex()),
  agent: l.agent.handler(({ input }) => {
    const { file, ...a } = library.libraryAgents().find((x) => x.slug === input.slug) || refuse('That agent is not in the library.', 404);
    return { ...a, body: fs.readFileSync(file, 'utf8') };
  }),
  hire: l.hire.handler(({ input }) =>
    // (each says when what it names isn't there)
    refusing(() => {
      const o = input.overrides || {};
      if (input.source === 'library') return library.hireFromLibrary(input.slug ?? '', o);
      if (input.source === 'hermes') return library.hireHermesProfile(input.profile ?? '', o);
      return library.importClaudeSubagent(input.slug ?? '');
    }, 404),
  ),
});

export const presetsRouter = p.router({
  list: p.list.handler(() => presets.listPresets()),
  saveAgent: p.saveAgent.handler(({ input: { id, ...o } }) => refusing(() => presets.saveAgentPreset(id, o), 404)),
  saveTeam: p.saveTeam.handler(({ input: { id, ...o } }) => refusing(() => presets.saveTeamPreset(id, o), 404)),
  use: p.use.handler(({ input }) => refusing(() => presets.usePreset(input.id), 404)),
  remove: p.remove.handler(({ input }) => (refusing(() => presets.deletePreset(input.id), 404), { ok: true as const })),
});
