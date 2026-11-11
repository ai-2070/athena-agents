// The model picker and Station strip show engines that have been set up.
import type { AppState } from '../shared/types.ts';

export function engineConfigured(
  id: string,
  data: AppState | null,
  installedPrograms: ReadonlySet<string> = new Set(),
): boolean {
  if (!data) return false;
  const engines = data.engines;
  if (id === 'eve' || id === 'openrouter') return !!data.secrets?.openrouterKey?.set;
  if (id === 'venice') return !!data.secrets?.veniceKey?.set;
  if (id === 'claude' || id === 'claude-code')
    return (
      !!engines?.['claude-code']?.installed &&
      !!(engines['claude-code'].loggedIn || data.secrets?.anthropicKey?.set || data.secrets?.openrouterKey?.set)
    );
  if (id === 'codex') return !!(engines?.codex?.installed && engines.codex.loggedIn);
  if (id === 'hermes' || id === 'pi' || id === 'omp' || id === 'openclaw') return !!engines?.[id]?.installed;
  if (id === 'opencode') return !!engines?.opencode?.installed && !engines.opencode.tooOld;
  if (id === 'lmstudio' || id === 'ollama') return installedPrograms.has(id);
  if (id === 'custom') return !!data.settings?.providers?.custom?.baseUrl?.trim();
  return false;
}
