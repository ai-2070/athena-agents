// Folders from the app's old names (Blacksite, and My Dashboard before it) keep working.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { backupsRoot, listBackups } from '../../server/backup.ts';
import { overview, projectsRoot } from '../../server/projects.ts';
import { listProjects } from '../../server/store.ts';

const home = os.homedir();

describe('folders from before the rename', () => {
  it('moves the newest old backups folder to Athena Agents Backups, once, with its backups', () => {
    const blacksite = path.join(home, 'Blacksite Backups');
    const myDashboard = path.join(home, 'My Dashboard Backups');
    fs.mkdirSync(blacksite, { recursive: true });
    fs.writeFileSync(
      path.join(blacksite, 'Launch.dashbackup'),
      'MY-DASHBOARD-BACKUP 1\n{"app":"my-dashboard","name":"Launch"}\n',
    );
    fs.mkdirSync(myDashboard, { recursive: true });
    fs.writeFileSync(
      path.join(myDashboard, 'Older.dashbackup'),
      'MY-DASHBOARD-BACKUP 1\n{"app":"my-dashboard","name":"Older"}\n',
    );

    expect(backupsRoot()).toBe(path.join(home, 'Athena Agents Backups'));
    expect(fs.existsSync(blacksite)).toBe(false);
    expect(fs.existsSync(myDashboard)).toBe(true);
    expect(listBackups().map((b) => b.name)).toEqual(['Launch.dashbackup']);

    // a later folder with an old name is left alone
    fs.mkdirSync(blacksite);
    backupsRoot();
    expect(fs.existsSync(blacksite)).toBe(true);
  });

  it('puts new projects in Documents/Athena Agents and still finds project folders in the old ones', () => {
    expect(projectsRoot()).toBe(path.join(home, 'Documents', 'Athena Agents'));
    expect(listProjects()[0]?.brainPath).toBe(path.join(home, 'Documents', 'Athena Agents', 'My workspace'));
    const old = [
      path.join(home, 'Documents', 'Blacksite', 'Old work'),
      path.join(home, 'Documents', 'My Dashboard', 'Older work'),
    ];
    for (const dir of old) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'PROJECT.md'), `# ${path.basename(dir)}\n`);
    }

    expect(overview().found.map((f) => f.folder)).toEqual(expect.arrayContaining(old));
  });
});
