// The Brain (shared/api/brain.ts): its folder, asking it, and the work its chat shows. Its streamed answer is in
// server/index.ts (POST /api/brain/stream).
import { implement } from '@orpc/server';
import { brain as contract } from '../../shared/api/brain.ts';
import * as projects from '../projects.ts';
import * as overseer from '../overseer.ts';
import * as commands from '../commands.ts';
import * as programs from '../programs.ts';
import { brainSkillSlugs, setBrainSkills } from '../skills.ts';
import { cleanAttachments } from '../uploads.ts';
import { openWithShell } from '../util.ts';
import { refuse } from './refuse.ts';

const os = implement(contract);

export const brainRouter = os.router({
  info: os.info.handler(() => projects.brainInfo()),
  note: os.note.handler(({ input }) => ({ file: projects.addNote(input.name, input.content) })),
  pull: os.pull.handler(async () => ({ message: await projects.gitPull() })),
  open: os.open.handler(async ({ input }) => {
    const dir = projects.brainFolder(input.path);
    if (input.app === 'vscode') return { message: await programs.launchProgram('vscode', { file: dir }) };
    openWithShell(dir);
    return { ok: true as const };
  }),
  ask: os.ask.handler(({ input }) => {
    const attachments = cleanAttachments(input.attachments);
    const text = (input.text ?? '').trim().slice(0, 20000);
    if (!text && !attachments.length) return refuse('Type a message first.');
    return overseer.ask(text, { project: input.project ?? null, attachments });
  }),
  steer: os.steer.handler(() => (overseer.steerAsks(), { ok: true as const })),
  stop: os.stop.handler(({ input }) => commands.stopBrain(input)),
  resume: os.resume.handler(({ input }) => commands.resumeBrain(input)),
  history: os.history.handler(() => overseer.history()),
  clear: os.clear.handler(() => (overseer.clearHistory(), { ok: true as const })),
  snapshot: os.snapshot.handler(async () => ({ text: await overseer.snapshot() })),
  pulse: os.pulse.handler(() => overseer.pulse()),
  skills: os.skills.handler(() => ({ skills: brainSkillSlugs() })),
  setSkills: os.setSkills.handler(({ input }) => ({ skills: setBrainSkills(input.skills) })),
});
