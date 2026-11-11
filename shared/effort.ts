// Effort: how hard a model thinks before it answers. Each engine knows its own levels;
// '' means the model's own default (nothing is sent).
import type { EngineId } from './types.ts';

export type Effort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Every level, least effort first. */
export const EFFORTS: readonly Effort[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export const EFFORT_NAMES: Record<Effort, string> = { minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };

export const isEffort = (x: unknown): x is Effort => typeof x === 'string' && (EFFORTS as readonly string[]).includes(x);

/** The levels an engine takes (always a run of EFFORTS, in order).
 *  provider: for API models, OpenRouter or a server on this PC. */
export function effortLevels(engine: EngineId, provider?: string, modelLevels?: readonly Effort[]): Effort[] {
  if (engine === 'eve' && provider === 'venice') return EFFORTS.filter((e) => modelLevels?.includes(e));
  const from = (a: Effort, b: Effort) => EFFORTS.slice(EFFORTS.indexOf(a), EFFORTS.indexOf(b) + 1);
  if (engine === 'claude-code') return from('low', 'max'); // claude --effort
  if (engine === 'codex') return from('minimal', 'xhigh'); // model_reasoning_effort
  if (engine === 'hermes') return from('minimal', 'max'); // hermes chat --reasoning
  if (engine === 'pi' || engine === 'omp' || engine === 'openclaw') return from('minimal', 'max'); // --thinking
  if (engine === 'opencode') return from('minimal', 'max'); // the model's variant nearest to it
  // OpenRouter's reasoning.effort; OpenAI-compatible servers take reasoning_effort low/medium/high
  return (provider || 'openrouter') === 'openrouter' ? from('minimal', 'xhigh') : from('low', 'high');
}

/** The level to send for an engine: the one asked for, or the nearest one the engine has. '' = the default. */
export function effortFor(engine: EngineId, effort: unknown, provider?: string, modelLevels?: readonly Effort[]): Effort | '' {
  if (!isEffort(effort)) return '';
  const levels = effortLevels(engine, provider, modelLevels);
  if (!levels.length) return '';
  return nearestEffort(effort, levels);
}

/** The level of these nearest to the one wanted (the lower one on a tie). '' when there are none. */
export function nearestEffort(want: Effort, levels: readonly Effort[]): Effort | '' {
  if (!levels.length) return '';
  if (levels.includes(want)) return want;
  const at = EFFORTS.indexOf(want);
  return levels.reduce((nearest, level) => (Math.abs(EFFORTS.indexOf(level) - at) < Math.abs(EFFORTS.indexOf(nearest) - at) ? level : nearest));
}
