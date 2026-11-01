import type { EngineCapabilities, EngineId } from '../../shared/types.ts';

const native: EngineCapabilities = { nativeSession: true, directTools: false, inlineAttachmentText: false, durableSession: false };
const capabilities: Record<EngineId | 'eve', EngineCapabilities> = {
  'claude-code': native,
  codex: native,
  hermes: native,
  pi: native,
  omp: native,
  openclaw: native,
  openai: { nativeSession: false, directTools: true, inlineAttachmentText: true, durableSession: false },
  eve: { nativeSession: true, directTools: true, inlineAttachmentText: true, durableSession: true },
};

export function engineCapabilities(engine: EngineId | 'eve'): Readonly<EngineCapabilities> {
  return capabilities[engine];
}
