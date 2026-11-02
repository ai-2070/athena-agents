// Native context changes are read-only; the engine owns its summary.
import { h } from './core.ts';
import type { CompactionItem } from '../shared/types.ts';
export interface MarkOptions { compact?: boolean }
export function compactionMark(_item: CompactionItem, options: MarkOptions): HTMLElement {
  return h(`details.compaction.engine${options.compact ? '.small' : ''}`,
    h('summary', 'Compacted by the engine'),
    h('p.hint', 'The engine shortened its active memory here. Original messages remain saved and searchable.'));
}
