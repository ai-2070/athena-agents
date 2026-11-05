// Which tools a model is shown: by conversation (board tasks, gateways) and by engine (own file tools).
import fs from 'node:fs';
import { describe, it, expect } from 'vitest';
import { callTool, riskOf, toolDefs, toolsForAgent } from '../../server/tools.ts';
import { projectData } from '../../server/store.ts';

const names = (list: { name: string }[]) => list.map((t) => t.name);
const agent = { id: 'scope-agent', name: 'Scoped', toolGroups: ['files', 'shell', 'browser'] };

describe('tools by conversation', () => {
  it('lists the board tools only in a board task conversation', () => {
    expect(names(toolDefs(agent))).not.toContain('board_task');
    expect(names(toolDefs(agent, { conversationId: 'board-t1' }))).toEqual(expect.arrayContaining(['board_task', 'board_reply']));
    expect(names(toolDefs(agent, { conversationId: 'board-t1' }))).not.toContain('send_gateway_files');
  });

  it('lists the board tag tools everywhere but in a gateway conversation, asking first before a tag is deleted', () => {
    for (const conversationId of [undefined, 'board-t1']) expect(names(toolDefs(agent, { conversationId }))).toContain('board_tags');
    expect(names(toolDefs(agent, { conversationId: 'a'.repeat(64) }))).not.toContain('board_tags');
    expect(['list', 'find', 'create', 'tag', 'edit', 'delete'].map((action) => riskOf('board_tags', { action }))).toEqual(['none', 'none', 'none', 'none', 'low', 'high']);
  });

  it('lists the gateway file tools only in a gateway conversation', () => {
    expect(names(toolDefs(agent))).not.toContain('prepare_gateway_files');
    expect(names(toolDefs(agent, { conversationId: 'a'.repeat(64) }))).toEqual(expect.arrayContaining(['prepare_gateway_files', 'send_gateway_files']));
    expect(names(toolDefs(agent, { conversationId: 'a'.repeat(64) }))).not.toContain('board_task');
  });

  it('still lets a hidden tool answer for itself when it is called', async () => {
    const r = await callTool(agent, 'board_task', {});
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/isn't working on a Tasks board task/);
  });
});

describe('tools by engine', () => {
  it("doesn't list the dashboard's file and shell tools for engines that have their own", () => {
    for (const engine of ['claude-code', 'codex', 'pi', 'omp', 'hermes', 'openclaw']) {
      const list = names(toolDefs(agent, { engine }));
      expect(list).not.toContain('read_file');
      expect(list).not.toContain('run_command');
      expect(list).toContain('fetch_url');
    }
  });

  it('keeps them for Eve and for outside MCP clients', () => {
    expect(names(toolDefs(agent, { engine: 'eve' }))).toEqual(expect.arrayContaining(['read_file', 'write_file', 'run_command']));
    expect(names(toolDefs(agent))).toEqual(expect.arrayContaining(['read_file', 'write_file', 'run_command']));
  });
});

describe('the permission check', () => {
  it("doesn't look at knowledge folders for an ordinary call", async () => {
    const stand = { id: '_scope_standin', name: 'Stand-in', toolGroups: [] };
    const dir = projectData('knowledge', stand.id);
    expect(fs.existsSync(dir)).toBe(false);
    const r = await callTool(stand, 'notify_user', { text: 'hello' });
    expect(r.isError).toBe(false);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('refuses a tool from a group the agent does not have', async () => {
    await expect(callTool({ id: 'x', name: 'X', toolGroups: [] }, 'read_file', { path: 'a.txt' })).rejects.toThrow(/isn't allowed to use read_file/);
  });

  it('gives knowledge tools only to agents with knowledge files', () => {
    expect(names(toolsForAgent({ id: 'nokb', name: 'No knowledge', toolGroups: [] }))).not.toContain('knowledge_search');
  });
});
