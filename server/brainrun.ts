// The Brain's turn as an agent run: the Brain is a built-in agent (id "brain", never stored with the others) on the
// engine its model setting picks, with its own tools (braintools.ts). Its conversation stays the Brain chat's
// (overseer.ts); the engine's session lives in an agent chat of its own (chats/brain/), one per conversation.
// Kept apart so tests can stand in for the run (a model that calls the tools as scripted).
import { askAgent } from './engines/index.ts';
import { bus } from './store.ts';
import { BRAIN_ENGINES, brainModel } from './brain.ts';
import { BRAIN_ID, brainAccess } from './braintools.ts';
import type { Agent, RunEvent, ServerEvent } from '../shared/types.ts';

/** The Brain as an agent, for one turn: its instructions, and the folder it works in (the project's). */
export function brainAgent(systemPrompt: string, workspace: string): Agent {
  const bm = brainModel();
  const access = brainAccess();
  return {
    id: BRAIN_ID,
    name: 'The Brain',
    emoji: '🧠',
    color: '',
    specialty: '',
    description: '',
    systemPrompt,
    engine: BRAIN_ENGINES[bm.provider] ?? 'claude-code',
    model: bm.model,
    provider: bm.provider === 'venice' ? 'venice' : 'openrouter',
    claudeAuth: 'login',
    hermesProfile: '',
    // Full runs everything; Ask first asks before anything high risk (every change); Read only isn't offered changes
    autonomy: access === 'full' ? 'full' : 'auto',
    toolGroups: [],
    mcpServers: [],
    knowledge: { folders: [] },
    workspace,
    temperature: '',
    effort: bm.effort,
    alwaysAllow: [],
    skills: [],
    source: { type: 'custom' },
    pinned: false,
  };
}

export interface BrainRun {
  agent: Agent;
  /** the engine's chat for this conversation */
  chatId: string;
  /** the message, as the Brain gets it (with the SNAPSHOT summary) */
  text: string;
  runId: string;
  signal: AbortSignal;
  from: string;
  /** what it does, as it happens */
  onEvent: (ev: RunEvent) => void;
}

/** Runs one turn of the Brain; resolves with its answer (throws RunStopped when it was stopped). */
export async function runBrain(run: BrainRun): Promise<string> {
  const listen = (ev: ServerEvent) => {
    if (ev.type === 'run' && ev.runId === run.runId && ev.event) run.onEvent(ev.event as RunEvent);
  };
  bus.on('event', listen);
  try {
    return await askAgent(run.agent, run.text, {
      chatId: run.chatId,
      reservedRunId: run.runId,
      signal: run.signal,
      depth: 0,
      from: run.from,
    });
  } finally {
    bus.off('event', listen);
  }
}
