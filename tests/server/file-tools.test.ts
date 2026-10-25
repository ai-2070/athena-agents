// The file tools only reach allowed folders, even through links placed inside the workspace.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { callTool } from '../../server/tools.ts';
import { insideRoots, realTarget } from '../../server/util.ts';
import { listApprovals } from '../../server/approvals.ts';
import type { ToolAgent } from '../../server/tools.ts';

const linksWork = process.platform !== 'win32'; // links need admin rights on Windows

// a workspace, a folder outside it with a private file, and an agent that may only use the workspace
function setup() {
  const base = fs.mkdtempSync(path.join(os.homedir(), 'files-'));
  const workspace = path.join(base, 'workspace');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(workspace);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'private-sentinel');
  fs.writeFileSync(path.join(workspace, 'notes.txt'), 'hello');
  const agent: ToolAgent = { id: 'files-agent', name: 'Files', toolGroups: ['files'], autonomy: 'auto', workspace, knowledge: { folders: [] } };
  return { base, workspace, outside, agent };
}

describe('file tools', () => {
  it('read, write and list inside the workspace', async () => {
    const { workspace, agent } = setup();
    expect((await callTool(agent, 'read_file', { path: 'notes.txt' })).text).toBe('hello');
    const w = await callTool(agent, 'write_file', { path: 'sub/new.txt', content: 'made' });
    expect(w.isError).toBe(false);
    expect(fs.readFileSync(path.join(workspace, 'sub', 'new.txt'), 'utf8')).toBe('made');
    expect((await callTool(agent, 'list_files', {})).text).toContain('notes.txt');
  });

  it('refuse a direct path outside the allowed folders', async () => {
    const { outside, agent } = setup();
    const r = await callTool(agent, 'read_file', { path: path.join(outside, 'secret.txt') });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/outside the folders/);
  });

  it.runIf(linksWork)('refuse to read, write or list through a folder link that points outside', async () => {
    const { workspace, outside, agent } = setup();
    fs.symlinkSync(outside, path.join(workspace, 'escape'), 'dir');
    const read = await callTool(agent, 'read_file', { path: 'escape/secret.txt' });
    expect(read.isError).toBe(true);
    expect(read.text).not.toContain('private-sentinel');
    const write = await callTool(agent, 'write_file', { path: 'escape/secret.txt', content: 'modified-without-approval' });
    expect(write.isError).toBe(true);
    const created = await callTool(agent, 'write_file', { path: 'escape/new.txt', content: 'x' });
    expect(created.isError).toBe(true);
    expect((await callTool(agent, 'list_files', { path: 'escape' })).isError).toBe(true);
    expect(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8')).toBe('private-sentinel');
    expect(fs.existsSync(path.join(outside, 'new.txt'))).toBe(false);
    expect(listApprovals()).toEqual([]);
  });

  it.runIf(linksWork)('refuse a file link that points outside, and a link that points nowhere yet', async () => {
    const { workspace, outside, agent } = setup();
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(workspace, 'secret-link.txt'));
    expect((await callTool(agent, 'read_file', { path: 'secret-link.txt' })).isError).toBe(true);
    expect((await callTool(agent, 'write_file', { path: 'secret-link.txt', content: 'x' })).isError).toBe(true);
    // a dangling link: writing to it would create the file outside
    fs.symlinkSync(path.join(outside, 'planted.txt'), path.join(workspace, 'dangling.txt'));
    expect((await callTool(agent, 'write_file', { path: 'dangling.txt', content: 'x' })).isError).toBe(true);
    expect(fs.existsSync(path.join(outside, 'planted.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8')).toBe('private-sentinel');
  });

  it.runIf(linksWork)('allow a link that stays inside the workspace', async () => {
    const { workspace, agent } = setup();
    fs.mkdirSync(path.join(workspace, 'real'));
    fs.writeFileSync(path.join(workspace, 'real', 'a.txt'), 'inside');
    fs.symlinkSync(path.join(workspace, 'real'), path.join(workspace, 'alias'), 'dir');
    expect((await callTool(agent, 'read_file', { path: 'alias/a.txt' })).text).toBe('inside');
  });
});

describe('realTarget() / insideRoots()', () => {
  it('place a new file under its nearest real folder', () => {
    const { workspace } = setup();
    expect(realTarget(path.join(workspace, 'a', 'b.txt'))).toBe(path.join(fs.realpathSync.native(workspace), 'a', 'b.txt'));
    expect(insideRoots(path.join(workspace, 'a', 'b.txt'), [workspace])).not.toBeNull();
  });

  it('do not treat a folder whose name only starts the same as inside', () => {
    const { base, workspace } = setup();
    fs.mkdirSync(path.join(base, 'workspace-2'));
    expect(insideRoots(path.join(base, 'workspace-2', 'x.txt'), [workspace])).toBeNull();
  });
});
