// Messages to the Brain go one at a time (the server saves each turn on top of the history), so a
// message can wait behind another. Each one belongs to the project and conversation it was typed
// in: if you switch projects or start a new conversation before it is sent, it isn't sent; if that
// happens while it is being answered, the answer is dropped.

export type BrainTurn<T> = { kind: 'answer'; answer: T } | { kind: 'error'; error: string } | { kind: 'stale' };

export interface BrainQueue<T> {
  /** Send text, typed in project (null when not known). currentProject says which project is open now. */
  ask(text: string, project: string | null, currentProject: () => string | null): Promise<BrainTurn<T>>;
  /** Forget every waiting and pending message (new conversation, other project). */
  reset(): void;
}

export function brainQueue<T>(post: (text: string, project: string | null) => Promise<T>): BrainQueue<T> {
  let turn: Promise<unknown> = Promise.resolve();
  let conversation = 0;
  return {
    ask(text, project, currentProject) {
      const mine = conversation;
      const stale = () => mine !== conversation || (project != null && currentProject() !== project);
      const next = turn.then(async (): Promise<BrainTurn<T>> => {
        if (stale()) return { kind: 'stale' };
        try {
          const answer = await post(text, project);
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
