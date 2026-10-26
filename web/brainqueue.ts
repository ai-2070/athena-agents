// Messages to the Brain go one at a time (the server saves each turn on top of the history), so a
// message can wait behind another. Each one belongs to the project and conversation it was typed
// in: if you switch projects or start a new conversation before it is sent, it isn't sent; if that
// happens while it is being answered, the answer is dropped.

export type BrainTurn<T> = { kind: 'answer'; answer: T } | { kind: 'error'; error: string } | { kind: 'stale' };

export interface BrainQueue<T, X = undefined> {
  /** Send text, typed in project. currentProject says which project is open now. A message typed before
   *  the project was known (null) goes stale as soon as one is: it was never meant for that project.
   *  extra: anything else the message carries (its attachments), handed to post as is. */
  ask(text: string, project: string | null, currentProject: () => string | null, extra?: X): Promise<BrainTurn<T>>;
  /** Forget every waiting and pending message (new conversation, other project). */
  reset(): void;
}

export function brainQueue<T, X = undefined>(post: (text: string, project: string | null, extra?: X) => Promise<T>): BrainQueue<T, X> {
  let turn: Promise<unknown> = Promise.resolve();
  let conversation = 0;
  return {
    ask(text, project, currentProject, extra) {
      const mine = conversation;
      const stale = () => mine !== conversation || currentProject() !== project;
      const next = turn.then(async (): Promise<BrainTurn<T>> => {
        if (stale()) return { kind: 'stale' };
        try {
          const answer = await post(text, project, extra);
          return stale() ? { kind: 'stale' } : { kind: 'answer', answer };
        } catch (e) {
          return stale() ? { kind: 'stale' } : { kind: 'error', error: (e as Error).message || String(e) };
        }
      });
      turn = next;
      return next;
    },
    reset() {
      conversation++;
    },
  };
}

// Of overlapping loads (e.g. the Brain chat history while you switch projects), only the newest may
// fill the view: start() gives each load a check that stays true until a newer load starts or reset().
export function latestLoad(): { start(): () => boolean; reset(): void } {
  let n = 0;
  return {
    start() {
      const mine = ++n;
      return () => mine === n;
    },
    reset() {
      n++;
    },
  };
}
