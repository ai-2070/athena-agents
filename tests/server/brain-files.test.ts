// What the Brain is told about attached files: their place and the text of small ones, in the turn they come with
// (its engine's session keeps them after that).
import type http from 'node:http';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { saveSettings, setSecret } from '../../server/store.ts';
import { designAgent } from '../../server/brain.ts';
import { ask } from '../../server/overseer.ts';
import { newBatch, receive } from '../../server/uploads.ts';
import type { BrainRun } from '../../server/brainrun.ts';

const runs: BrainRun[] = [];
vi.mock('../../server/brainrun.ts', async (orig) => ({
  ...(await orig<typeof import('../../server/brainrun.ts')>()),
  runBrain: async (run: BrainRun) => {
    runs.push(run);
    return 'Got the report.';
  },
}));

const prompts: string[] = [];
let reply = 'Noted.';
const realFetch = globalThis.fetch;
beforeAll(() => {
  saveSettings({ brain: { provider: 'openrouter', model: 'mock' } });
  setSecret('openrouterKey', 'sk-or-test');
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (!String(url).includes('openrouter.ai/api/v1/chat/completions')) return realFetch(url, init);
    const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
    prompts.push(body.messages.at(-1)!.content);
    return new Response(JSON.stringify({ choices: [{ message: { content: reply } }] }), { status: 200 });
  });
});
afterAll(() => vi.restoreAllMocks());

const upload = async (rel: string, text: string) => {
  const { batch } = newBatch();
  return (
    await receive(
      Object.assign(Readable.from([Buffer.from(text)]), { headers: {} }) as unknown as http.IncomingMessage,
      batch,
      rel,
    )
  ).path;
};

describe('the Brain and attached files', () => {
  it('designs an agent from files alone', async () => {
    const brief = await upload('role.md', 'ROLE: writes release notes');
    reply = '{"name":"Notes","emoji":"📝","specialty":"release notes","systemPrompt":"x","toolGroups":[]}';
    prompts.length = 0;
    await designAgent('', { attachments: [brief] });
    expect(prompts[0]).toMatch(/^Design the agent from the attached files/);
    expect(prompts[0]).toContain('ROLE: writes release notes');
  });

  it('gets the text of a small attached file with its message, and its session keeps it after that', async () => {
    const report = await upload('report.md', 'REPORT-BODY: revenue up 12%');
    runs.length = 0;
    await ask('Here is the report', { attachments: [report] });
    expect(runs[0].text).toContain('REPORT-BODY: revenue up 12%');
    await ask('Summarize that report');
    // (the same engine session: it already has the file)
    expect(runs[1].chatId).toBe(runs[0].chatId);
    expect(runs[1].text).not.toContain('REPORT-BODY');
  });
});
