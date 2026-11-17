// A Hermes agent's terminal starts with the agent's instructions (Hermes keeps its own system prompt, so they go in as
// the session's first message, as a run sends them), from a file the terminal removes when it closes (BH-091).
import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

const started = vi.hoisted(() => [] as { file: string; argv: string[] }[]);
vi.mock('@lydell/node-pty', () => {
  const spawn = (file: string, argv: string[]) => {
    started.push({ file, argv });
    return { pid: 1, onData: () => {}, onExit: () => {}, kill: () => {}, write: () => {}, resize: () => {} };
  };
  return { default: { spawn }, spawn };
});
vi.mock('../../server/util.ts', async (orig) => {
  const real = await orig<typeof import('../../server/util.ts')>();
  return { ...real, which: (cmd: string) => (cmd === 'hermes' ? 'hermes' : real.which(cmd)) };
});

const { createTerminal, closeTerminal } = await import('../../server/terminals.ts');
const { newAgent } = await import('../../server/library.ts');

describe("a Hermes agent's terminal", () => {
  it('starts with the agent’s instructions as its first message, and the file goes when it closes', () => {
    const agent = newAgent({ name: 'Haiku poet', engine: 'hermes', systemPrompt: 'Always answer in haiku.' });
    const t = createTerminal({ kind: 'agent', agent });
    const argv = started.at(-1)!.argv;
    const at = argv.indexOf('--query-file');
    expect(at).toBeGreaterThan(-1);
    const brief = argv[at + 1]!;
    expect(fs.readFileSync(brief, 'utf8')).toContain('Always answer in haiku.');
    closeTerminal(t.id);
    expect(fs.existsSync(brief)).toBe(false);
  });
});
