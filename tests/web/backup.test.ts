import { describe, expect, it } from 'vitest';
import { cleanSummary, readBackupSummary, summaryLine } from '../../web/backup.ts';

const file = (head: string, rest = 'gzip bytes') => new Blob([head, rest]);

describe('reading what a backup holds', () => {
  it('reads the summary line of a backup file', async () => {
    const s = await readBackupSummary(file(`MY-DASHBOARD-BACKUP 1\n${JSON.stringify({ app: 'my-dashboard', name: 'Launch', agents: 3, teams: 1, skills: 2, agentList: [{ name: 'Writer', emoji: '✍️' }] })}\n`));
    expect(s).toMatchObject({ name: 'Launch', agents: 3, agentList: [{ name: 'Writer', emoji: '✍️' }], omitted: 0 });
    expect(summaryLine(s!)).toBe('3 agents · 1 team · 2 skills');
  });

  it('turns away files that are not backups', async () => {
    expect(await readBackupSummary(file('{"app":"my-dashboard"}\n{}\n'))).toBeNull();
    expect(await readBackupSummary(file('MY-DASHBOARD-BACKUP 1\nnot json\n'))).toBeNull();
    expect(await readBackupSummary(file(`MY-DASHBOARD-BACKUP 1\n${JSON.stringify({ app: 'other' })}\n`))).toBeNull();
  });

  it('fills in what a hand-made summary leaves out, so showing it never fails', async () => {
    // only "app": the page reads agentList.length and the counts
    const s = await readBackupSummary(file(`MY-DASHBOARD-BACKUP 1\n${JSON.stringify({ app: 'my-dashboard' })}\n`));
    expect(s).toMatchObject({ name: '', agents: 0, teams: 0, agentList: [] });
    expect(summaryLine(s!)).toBe('0 agents · 0 teams · 0 skills');
    // wrong types everywhere
    expect(cleanSummary({ app: 'my-dashboard', name: { x: 1 }, agents: '9', agentList: [null, 'x', { name: 7, emoji: null }, { name: 'Ok' }] })).toMatchObject({
      name: '',
      agents: 0,
      agentList: [
        { name: '', emoji: '🤖' },
        { name: 'Ok', emoji: '🤖' },
      ],
    });
    expect(cleanSummary(null)).toBeNull();
  });
});
