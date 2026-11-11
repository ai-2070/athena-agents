// What the model gets back stays within the limit (the whole result is saved), and each tool's use is counted.
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { callTool, clipForModel } from '../../server/tools.ts';
import { saveSettings } from '../../server/store.ts';
import { saveToolStats, toolStats } from '../../server/toolstats.ts';
import { dataPath } from '../../server/util.ts';

const long = `HEAD${'x'.repeat(100_000)}TAIL`;

describe('clipForModel', () => {
  it('keeps the start and the end of a long result, and saves the whole text', () => {
    const r = clipForModel({ text: long }, 'some_mcp__tool', 'run-1');
    expect(r.text.length).toBeLessThan(25_000);
    expect(r.text.startsWith('HEAD')).toBe(true);
    expect(r.text.endsWith('TAIL')).toBe(true);
    const file = /saved in (.+?): read the rest/.exec(r.text)![1]!;
    expect(fs.readFileSync(file, 'utf8')).toBe(long);
    expect(file.startsWith(dataPath('outputs', 'tool-results'))).toBe(true);
  });

  it('leaves short results, tools that read in parts, and task batches alone', () => {
    expect(clipForModel({ text: 'short' }, 'x', null).text).toBe('short');
    for (const name of ['read_file', 'fetch_url', 'TaskCreate', 'TaskUpdate'])
      expect(clipForModel({ text: long }, name, null).text).toBe(long);
  });

  it('follows the setting, and 0 means no limit', () => {
    saveSettings({ toolResultChars: 0 });
    try {
      expect(clipForModel({ text: long }, 'x', null).text).toBe(long);
      saveSettings({ toolResultChars: 1000 });
      expect(clipForModel({ text: long }, 'x', null).text.length).toBeLessThan(1300);
    } finally {
      saveSettings({ toolResultChars: 24_000 });
    }
  });
});

describe('tool stats', () => {
  it('counts calls, errors and time per tool, and saves them on this computer', async () => {
    const agent = { id: 'stats-agent', name: 'Stats', toolGroups: [] };
    await callTool(agent, 'notify_user', { text: 'one' });
    await callTool(agent, 'notify_user', { text: 'two' });
    await callTool(agent, 'read_skill', { name: 'no-such-skill' });
    const { tools } = toolStats();
    expect(tools.find((t) => t.name === 'notify_user')).toMatchObject({ calls: 2, errors: 0 });
    expect(tools.find((t) => t.name === 'read_skill')).toMatchObject({ calls: 1, errors: 1 });
    clipForModel({ text: long }, 'notify_user', null);
    expect(toolStats().tools.find((t) => t.name === 'notify_user')!.clipped).toBe(1);
    // a call that waited for a yes counts as asked
    const ask = { id: 'asker', name: 'Asker', toolGroups: ['shell'], autonomy: 'ask' as const };
    const pending = callTool(ask, 'run_command', { command: 'echo hi' });
    await new Promise((r) => setTimeout(r, 50));
    expect(toolStats().tools.find((t) => t.name === 'run_command')!.asked).toBe(1);
    const { listApprovals, decide } = await import('../../server/approvals.ts');
    for (const a of listApprovals()) decide(a.id, { approved: false });
    await pending;
    saveToolStats();
    expect(
      JSON.parse(fs.readFileSync(dataPath('tool-stats.json'), 'utf8')).tools.some(
        (t: { name: string }) => t.name === 'notify_user',
      ),
    ).toBe(true);
  });
});
