// The Brain (shared/api/brain.ts): its folder, asking it (its answer whole, or streamed), and the work its chat shows.
import { implement, streamToEventIterator } from '@orpc/server';
import { brain as contract } from '../../shared/api/brain.ts';
import * as projects from '../projects.ts';
import * as overseer from '../overseer.ts';
import * as commands from '../commands.ts';
import * as programs from '../programs.ts';
import { brainSkillSlugs, setBrainSkills } from '../skills.ts';
import { openWithShell } from '../util.ts';
import { streamBrain } from '../uistream.ts';
import { saidSomething } from './said.ts';
import { refusing } from './refuse.ts';

const os = implement(contract);

// what was asked (its first 20000 characters), never nothing
const question = (input: { text?: string; attachments?: string[] }) => saidSomething(input, { max: 20000 });

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
    const { text, attachments } = question(input);
    return overseer.ask(text, { project: input.project ?? null, attachments });
  }),
  stream: os.stream.handler(({ input }) => {
    const { text, attachments } = question(input);
    const project = input.project ?? null;
    // (refused before the stream starts, so it comes back as an error the chat can show)
    overseer.checkProject(project);
    return streamToEventIterator(
      streamBrain((onPart) => overseer.ask(text, { project, attachments, onPart, goal: input.goal === true })),
    );
  }),
  steer: os.steer.handler(() => (overseer.steerAsks(), { ok: true as const })),
  stop: os.stop.handler(({ input }) => commands.stopBrain(input)),
  resume: os.resume.handler(({ input }) => commands.resumeBrain(input)),
  history: os.history.handler(() => overseer.history()),
  clear: os.clear.handler(() => (overseer.clearHistory(), { ok: true as const })),
  threads: os.threads.handler(() => overseer.brainThreads()),
  newThread: os.newThread.handler(() => overseer.newBrainThread()),
  openThread: os.openThread.handler(({ input }) => refusing(() => overseer.openBrainThread(input.chatId), 404)),
  removeThread: os.removeThread.handler(
    ({ input }) => (refusing(() => overseer.removeBrainThread(input.chatId), 404), { ok: true as const }),
  ),
  snapshot: os.snapshot.handler(async () => ({ text: await overseer.snapshot() })),
  pulse: os.pulse.handler(() => overseer.pulse()),
  skills: os.skills.handler(() => ({ skills: brainSkillSlugs() })),
  setSkills: os.setSkills.handler(({ input }) => ({ skills: setBrainSkills(input.skills) })),
});
