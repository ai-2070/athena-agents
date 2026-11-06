// Files and the smaller things around them (shared/api/files.ts). What the page may see of a file is limited to the
// dashboard's folders (server/files.ts viewRoots).
import { implement } from '@orpc/server';
import { artifacts as artifactsContract, backups as backupsContract, files as filesContract, layout as layoutContract, memory as memoryContract, terminals as terminalsContract, uploads as uploadsContract } from '../../shared/api/files.ts';
import { agents, artifacts as artifactStore, emit, log, projectData } from '../store.ts';
import * as files from '../files.ts';
import * as uploads from '../uploads.ts';
import * as memory from '../memory.ts';
import * as backup from '../backup.ts';
import * as terms from '../terminals.ts';
import { removeArtifact } from '../artifacts.ts';
import { ensureDir, openWithShell, readJSON, writeJSON } from '../util.ts';
import { refuse } from './refuse.ts';
import type { StationLayout } from '../../shared/types.ts';

const f = implement(filesContract);
const u = implement(uploadsContract);
const m = implement(memoryContract);
const a = implement(artifactsContract);
const b = implement(backupsContract);
const l = implement(layoutContract);
const t = implement(terminalsContract);

export const filesRouter = f.router({
  info: f.info.handler(({ input }) => files.fileInfo(input.paths)),
  reveal: f.reveal.handler(({ input }) => (files.reveal(input.path), { ok: true as const })),
  open: f.open.handler(({ input }) => (files.open(input.path), { ok: true as const })),
});

export const uploadsRouter = u.router({
  newBatch: u.newBatch.handler(() => uploads.newBatch()),
  remove: u.remove.handler(({ input }) => ({ ok: uploads.removeUpload(input.query.path) })),
});

// an agent's MEMORY.md, or the Brain's
const memoryOwner = (owner: string): string => (owner === memory.BRAIN || agents.get(owner) ? owner : refuse('No agent by that id.', 404));

export const memoryRouter = m.router({
  get: m.get.handler(({ input }) => memory.memoryInfo(memoryOwner(input.owner))),
  save: m.save.handler(({ input }) => {
    const before = memory.memoryStamp(memoryOwner(input.owner));
    const saved = memory.writeMemory(input.owner, input.text);
    if (saved.updatedAt !== Math.round(before)) log('memory', `You edited ${memory.memoryTitle(input.owner)}`, input.owner === memory.BRAIN ? {} : { agentId: input.owner });
    return saved;
  }),
});

export const artifactsRouter = a.router({
  list: a.list.handler(() => artifactStore.list().sort((x, y) => (y.createdAt || 0) - (x.createdAt || 0))),
  remove: a.remove.handler(({ input }) => (removeArtifact(input.id), { ok: true as const })),
});

export const backupsRouter = b.router({
  list: b.list.handler(() => ({ dir: backup.backupsRoot(), backups: backup.listBackups() })),
  open: b.open.handler(() => (openWithShell(ensureDir(backup.backupsRoot())), { ok: true as const })),
});

const layoutFile = () => projectData('layout.json');
export const layoutRouter = l.router({
  get: l.get.handler(() => readJSON<StationLayout>(layoutFile(), {})),
  save: l.save.handler(({ input }) => {
    writeJSON(layoutFile(), { ...readJSON<StationLayout>(layoutFile(), {}), ...input });
    emit('layout');
    return { ok: true as const };
  }),
});

export const terminalsRouter = t.router({
  list: t.list.handler(() => terms.listTerminals()),
  create: t.create.handler(({ input: { agentId, ...options } }) => terms.createTerminal({ ...options, agent: agentId ? agents.get(agentId) || refuse('That agent is unavailable.', 404) : null })),
  close: t.close.handler(({ input }) => ({ ok: terms.closeTerminal(input.id) })),
});
