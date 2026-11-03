// "Draft with the Brain" on the Tasks board: the Brain's model writes a task's title and description, or a comment,
// from what is there already and what the user asks for. Nothing is saved here: the draft goes back into the box,
// where the user can change it, keep it or take it back.
import { listProjects } from './store.ts';
import { parseJSON, think } from './brain.ts';
import { boardTask } from './taskboard.ts';
import type { BoardDraft, BoardDraftInput } from '../shared/types.ts';

const fail = (message: string, status = 400): never => { throw Object.assign(new Error(message), { status }); };
const clip = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');

const STYLE = `Write in plain, friendly words, the way a capable teammate would. Use Markdown where it helps (short paragraphs, a checklist "- [ ]" for steps, bold for what matters), never headings above ###. Never invent facts, names, dates or numbers: when something isn't known, leave a short placeholder like [date] or say it needs deciding.`;

export async function draftBoardText(input: BoardDraftInput): Promise<BoardDraft> {
  const p = listProjects().find((x) => x.id === input?.projectId) || fail('That project is unavailable.', 404);
  const kind = input.kind === 'comment' ? 'comment' : 'task';
  const task = input.taskId ? boardTask(p.id, input.taskId) : null;
  const instruction = clip(input.instruction, 2000).trim();
  const about = `Project: ${p.name}${p.description ? ` (${p.description.slice(0, 600)})` : ''}`;
  if (kind === 'comment') {
    if (!task) return fail('Say which task the comment is for.');
    const thread = (task.comments || []).slice(-12).map((c) => `${c.byName}: ${c.text.slice(0, 1500)}`).join('\n\n');
    const system = `You draft a comment on a task on the user's task board, written as the user. ${STYLE} Keep it short: a few sentences or a short list. Answer with JSON only: {"text":"the comment"}`;
    const user = `${about}\nTask #${task.number}: ${task.title} [${task.status}, ${task.priority} priority, assigned to ${task.assigneeName}]${task.blockedReason ? `\nBlocked: ${task.blockedReason}` : ''}\nDescription:\n${task.description.slice(0, 4000) || '(none)'}\n\nComments so far:\n${thread || '(none)'}\n\nThe comment written so far:\n${clip(input.text, 8000) || '(nothing yet)'}\n\nWhat the user wants it to say: ${instruction || '(not said: write the most useful next comment, e.g. a status update or a question that moves it on)'}`;
    const j = parseJSON<{ text?: unknown }>(await think(system, user, { maxTokens: 1500 }));
    const text = clip(j.text, 8000).trim();
    return text ? { kind: 'comment', text } : fail("The Brain didn't write a comment. Try again, or say what it should say.", 502);
  }
  const system = `You draft one task for the user's task board: a short title (under 80 characters, starting with a verb) and a description that says what needs to happen and how to tell it's done. ${STYLE} Answer with JSON only: {"title":"…","description":"…"}`;
  const user = `${about}\nThe task so far:\nTitle: ${clip(input.title, 200) || task?.title || '(none)'}\nDescription:\n${clip(input.description, 8000) || task?.description || '(none)'}\n\nWhat the user wants: ${instruction || '(not said: make the title clear and write a useful description from what is there)'}`;
  const j = parseJSON<{ title?: unknown; description?: unknown }>(await think(system, user, { maxTokens: 2000 }));
  const title = clip(j.title, 200).trim();
  const description = clip(j.description, 8000).trim();
  return title || description ? { kind: 'task', title: title || clip(input.title, 200), description } : fail("The Brain didn't write a draft. Try again, or say what you want.", 502);
}
