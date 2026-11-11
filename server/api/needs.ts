// What waits for you (shared/api/needs.ts): questions agents asked, and permission requests.
import { implement } from '@orpc/server';
import { approvals as approvalsContract, questions as questionsContract } from '../../shared/api/needs.ts';
import { questions as questionStore } from '../store.ts';
import * as questions from '../questions.ts';
import { decide, listApprovals } from '../approvals.ts';

const q = implement(questionsContract);
const a = implement(approvalsContract);

export const questionsRouter = q.router({
  list: q.list.handler(() =>
    questionStore
      .list()
      .sort((x, y) => (y.createdAt || 0) - (x.createdAt || 0))
      .slice(0, 100),
  ),
  answer: q.answer.handler(({ input }) =>
    questions.answerQuestion(input.id, { choice: input.choice, text: input.text }),
  ),
  dismiss: q.dismiss.handler(({ input }) => questions.dismissQuestion(input.id)),
  remove: q.remove.handler(({ input }) => (questions.removeQuestion(input.id), { ok: true as const })),
});

export const approvalsRouter = a.router({
  list: a.list.handler(() => listApprovals()),
  decide: a.decide.handler(({ input: { id, ...choice } }) => ({ ok: decide(id, choice) })),
});
