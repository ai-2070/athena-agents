import { eveCounts } from './counts.ts';
import type { Agent, Chat, EveModelSelection } from '../../shared/types.ts';

/**
 * What a run keeps in memory between bridge calls. The instructions are built once, so the start of
 * every request stays the same and the provider's prompt cache holds for the whole run: a change to
 * MEMORY.md, WORLD.md or a skill shows in the next turn. Dropped when the run settles; after a restart
 * the first call builds it again.
 */
interface RunSnapshot {
  instructions?: Promise<string>;
  selection?: Promise<EveModelSelection>;
}
const snapshots = new Map<string, RunSnapshot>();

function remember<K extends keyof RunSnapshot>(
  runId: string,
  key: K,
  make: () => NonNullable<RunSnapshot[K]>,
): NonNullable<RunSnapshot[K]> {
  let snapshot = snapshots.get(runId);
  if (!snapshot) snapshots.set(runId, (snapshot = {}));
  const kept = snapshot[key];
  if (kept) return kept as NonNullable<RunSnapshot[K]>;
  const made = make();
  snapshot[key] = made;
  // A failed build is tried again on the next call.
  made.catch(() => {
    if (snapshots.get(runId)?.[key] === made) delete snapshots.get(runId)![key];
  });
  return made;
}

/** The system prompt as a run starts: the agent's instructions plus the rich-answers section. */
export async function buildInstructions(agent: Agent, chat: Pick<Chat, 'teamId'>, depth: number): Promise<string> {
  eveCounts.promptBuilds++;
  const [{ buildSystemPrompt }, { richSection }] = await Promise.all([
    import('../engines/index.ts'),
    import('../richanswers.ts'),
  ]);
  const prompt = buildSystemPrompt(agent);
  return prompt + (await richSection(agent, chat, depth));
}

export const runInstructions = (runId: string, build: () => Promise<string>): Promise<string> =>
  remember(runId, 'instructions', build);

/** Admission already built and measured these instructions; the run sends exactly them. */
export function keepInstructions(runId: string, instructions: string): void {
  remember(runId, 'instructions', () => Promise.resolve(instructions));
}

export const runSelection = (runId: string, select: () => Promise<EveModelSelection>): Promise<EveModelSelection> =>
  remember(runId, 'selection', select);

export function forgetRunSnapshot(runId: string): void {
  snapshots.delete(runId);
}

/** How many runs keep a snapshot (for tests). */
export const keptSnapshots = (): number => snapshots.size;
