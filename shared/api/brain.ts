// The Brain (server/api/brain.ts): its folder (a look inside, a note, git pull, opening it), asking it something,
// steering, stopping and resuming the work it shows, its chat history, the project at a glance and its skills.
// history and steer are also answered under /api/p/<project> for a project that isn't open (an Overview pane's).
// stream is answered there too, as the Brain of that project.
import { oc, type } from '@orpc/contract';
import { z } from 'zod';
import { message } from './message.ts';
import type { BrainAnswer, BrainChatMessage, BrainInfo, BrainPulse, UIStream } from '../types.ts';

/** The agent chats and teams the Brain chat shows working. A list of the wrong kind is none: /stop always stops. */
const work = z.object({
  chats: z.array(z.object({ agentId: z.string(), chatId: z.string() })).catch([]).optional(),
  teams: z.array(z.string()).catch([]).optional(),
});

/** What you ask it, and from which project (none: the open one). */
const question = z.object({
  ...message,
  project: z.string({ error: 'project must be the id of a project.' }).nullable().optional(),
});

export const brain = {
  /** A look inside the Brain folder: top files and folders, size, Git status and what the project is about. */
  info: oc.route({ method: 'GET', path: '/brain' }).output(type<BrainInfo>()),
  /** A note saved in its notes/ folder; file: where. */
  note: oc.route({ method: 'POST', path: '/brain/note' })
    .input(z.object({ name: z.string({ error: 'Name the note.' }).optional(), content: z.string({ error: 'A note is text.' }).optional() }))
    .output(type<{ file: string }>()),
  /** git pull in the Brain folder; message: what git said. */
  pull: oc.route({ method: 'POST', path: '/brain/pull' }).output(type<{ message: string }>()),
  /** Opens a folder inside the Brain (path; none for the Brain folder) in VS Code (app: 'vscode', which says how it
   *  went) or the file manager. */
  open: oc.route({ method: 'POST', path: '/brain/open' })
    .input(z.object({ app: z.string().optional(), path: z.string({ error: 'path must be a folder.' }).optional() }))
    .output(type<{ message?: string; ok?: true }>()),
  /** Ask it anything about the project (project: the one you asked from); it answers or hands the work on. */
  ask: oc.route({ method: 'POST', path: '/brain/ask' }).input(question).output(type<BrainAnswer>()),
  /** The same, its answer streamed (the Brain chat, with the AI SDK): the text as it is written, the files it
   *  reads, then the whole answer (data-answer). goal: your /goal, which it then follows up. */
  stream: oc.route({ method: 'POST', path: '/brain/stream' })
    .input(question.extend({ goal: z.boolean({ error: 'goal must be true or false.' }).optional() }))
    .output(type<UIStream>()),
  /** A new message while it answers: that answer changes nothing. */
  steer: oc.route({ method: 'POST', path: '/brain/steer' }).output(type<{ ok: true }>()),
  /** /stop and /resume in the Brain chat, with the agent chats and teams it shows working. */
  stop: oc.route({ method: 'POST', path: '/brain/stop' }).input(work).output(type<{ stopped: string[] }>()),
  resume: oc.route({ method: 'POST', path: '/brain/resume' }).input(work).output(type<{ resumed: string[]; chats: string[]; teams: string[] }>()),
  history: oc.route({ method: 'GET', path: '/brain/history' }).output(type<BrainChatMessage[]>()),
  clear: oc.route({ method: 'POST', path: '/brain/clear' }).output(type<{ ok: true }>()),
  /** What it is told about the project before it answers. */
  snapshot: oc.route({ method: 'GET', path: '/brain/snapshot' }).output(type<{ text: string }>()),
  /** The project at a glance: agents and teams, how many work, and what waits for you. */
  pulse: oc.route({ method: 'GET', path: '/brain/pulse' }).output(type<BrainPulse>()),
  /** The skills it uses (slugs; at most 30). */
  skills: oc.route({ method: 'GET', path: '/brain/skills' }).output(type<{ skills: string[] }>()),
  setSkills: oc.route({ method: 'PUT', path: '/brain/skills' })
    .input(z.object({ skills: z.array(z.string(), { error: 'skills must be a list.' }).optional() }))
    .output(type<{ skills: string[] }>()),
};
