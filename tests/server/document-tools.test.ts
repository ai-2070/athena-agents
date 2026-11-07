// Agents read documents: read_file gives a document's text, read_document does for every engine, and an agent without
// the Files tools reads only what it was handed (its knowledge, and what was attached in its own chats).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { callTool, toolDefs } from '../../server/tools.ts';
import { newBatch } from '../../server/uploads.ts';
import { chats } from '../../server/store.ts';
import type { ToolAgent } from '../../server/tools.ts';
import { docx, pdf, pptx } from './fixtures/documents.ts';

function setup(agent: Partial<ToolAgent> = {}) {
  const workspace = fs.mkdtempSync(path.join(os.homedir(), 'doc-tools-'));
  fs.writeFileSync(path.join(workspace, 'contract.pdf'), pdf('Signed on 3 May', 'Terms follow'));
  fs.writeFileSync(path.join(workspace, 'brief.docx'), docx('<w:p><w:r><w:t>Ship by Friday</w:t></w:r></w:p>'));
  fs.writeFileSync(path.join(workspace, 'notes.txt'), 'plain notes');
  const me: ToolAgent = { id: 'doc-agent', name: 'Reader', toolGroups: [], autonomy: 'auto', workspace, knowledge: { folders: [] }, ...agent };
  return { workspace, agent: me };
}

describe('read_file', () => {
  it('gives the text of a document, and of several files at once', async () => {
    const { agent } = setup({ engine: 'eve', toolGroups: ['files'] });
    const one = await callTool(agent, 'read_file', { path: 'contract.pdf' });
    expect(one.isError).toBe(false);
    expect(one.text).toMatch(/: PDF, 2 pages\]\n\n--- Page 1 ---\nSigned on 3 May/);
    const both = await callTool(agent, 'read_file', { paths: ['brief.docx', 'notes.txt'] });
    expect(both.text).toContain('===== brief.docx =====\n[');
    expect(both.text).toContain('Ship by Friday');
    expect(both.text).toContain('===== notes.txt =====\nplain notes');
  });
});

describe('read_document', () => {
  it('is there for every engine, and reads in parts', async () => {
    const { agent } = setup({ engine: 'claude-code' });
    // (the coding engines don't get the dashboard's file tools, but this one they do)
    const names = toolDefs(agent, { engine: 'claude-code' }).map((t) => t.name);
    expect(names).toContain('read_document');
    expect(names).not.toContain('read_file');
    expect(toolDefs({ ...agent, engine: 'eve' }, { engine: 'eve' }).map((t) => t.name)).toContain('read_document');
    const part = await callTool(agent, 'read_document', { path: 'contract.pdf', offset: 4 });
    expect(part.text).toContain(']\n\n--- Page 2 ---\nTerms follow\n\n[Lines 4-5 of 5.]');
  });

  it("says when a file isn't a document", async () => {
    const { agent, workspace } = setup({ engine: 'codex' });
    const text = await callTool(agent, 'read_document', { path: 'notes.txt' });
    expect(text.isError).toBe(true);
    expect(text.text).toContain('is not a PDF, Word, Excel or PowerPoint file. Open it with your own file tools.');
    expect((await callTool(agent, 'read_document', { path: workspace })).text).toContain('is a folder');
  });

  it('reads only what it was handed for an agent without the Files tools', async () => {
    const { agent, workspace } = setup({ id: 'handed-agent', engine: 'eve' });
    const { dir } = newBatch();
    const deck = path.join(dir, 'deck.pptx');
    fs.writeFileSync(deck, pptx([['Launch plan']]));
    // attached in another agent's chat, in the same project: not this agent's to read
    const other = path.join(dir, 'salaries.docx');
    fs.writeFileSync(other, docx('<w:p><w:r><w:t>Pay review</w:t></w:r></w:p>'));
    const theirs = chats.create('someone-else');
    theirs.items.push({ type: 'user', text: 'Look', attachments: [other] });
    chats.save(theirs);
    expect((await callTool(agent, 'read_document', { path: other })).text).toContain('outside the folders');
    const mine = chats.create(agent.id);
    mine.items.push({ type: 'user', text: 'The deck', attachments: [deck] });
    chats.save(mine);
    const attached = await callTool(agent, 'read_document', { path: deck });
    expect(attached.text).toContain('PowerPoint, 1 slide');
    expect(attached.text).toContain('Launch plan');
    // (a folder attached: the files in it too)
    const folder = newBatch().dir;
    fs.writeFileSync(path.join(folder, 'notes.pdf'), pdf('In the folder'));
    mine.items.push({ type: 'steer', steerId: 's1', text: 'and these', attachments: [folder + path.sep] });
    chats.save(mine);
    expect((await callTool(agent, 'read_document', { path: path.join(folder, 'notes.pdf') })).text).toContain('In the folder');
    const own = await callTool(agent, 'read_document', { path: path.join(workspace, 'contract.pdf') });
    expect(own.isError).toBe(true);
    expect(own.text).toContain('outside the folders');
    // with the Files tools, its workspace too
    expect((await callTool({ ...agent, toolGroups: ['files'] }, 'read_document', { path: 'contract.pdf' })).text).toContain('Signed on 3 May');
  });
});
