import type { TeamMessage } from '../shared/types.ts';
import { attachmentNames } from './uploads.ts';

/** Keep the original text and a stable reference. Context limits belong to the engine's memory manager. */
export function teamMessage(m: TeamMessage, name: (m: TeamMessage) => string): string {
  return `[team message ${m.id}]\n${name(m)}: ${m.text}${m.attachments?.length ? ` [attached: ${attachmentNames(m.attachments)}]` : ''}`;
}
