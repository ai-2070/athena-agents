// MCP tool lists are kept per connection: asked once, again after the server says they changed or after a new connection.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import * as mcp from '../../server/mcp.ts';

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-mcp-lists.mjs');
const asked = async (): Promise<number> => Number((await mcp.callTool('lists', 'asked')).text);
const until = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 100 && !(await check()); i++) await new Promise((r) => setTimeout(r, 20));
};

afterAll(async () => {
  await mcp.disconnect('lists');
  mcp.removeServer('lists');
});

describe('MCP tool lists', () => {
  it('asks the server once while nothing changes', async () => {
    mcp.saveServer('lists', { type: 'stdio', command: process.execPath, args: [fixture], enabled: true });
    const first = await mcp.listTools('lists');
    const again = await mcp.listTools('lists');
    expect(again.map((t) => t.name)).toEqual(first.map((t) => t.name));
    expect(await asked()).toBe(1);
  });

  it('asks again after the server says its list changed', async () => {
    await mcp.callTool('lists', 'grow');
    let names: string[] = [];
    await until(async () => (names = (await mcp.listTools('lists')).map((t) => t.name)).includes('extra2'));
    expect(names).toContain('extra2');
  });

  it('the Test button always asks', async () => {
    const before = await asked();
    await mcp.listTools('lists', { test: true });
    expect(await asked()).toBe(before + 1);
  });

  it('a saved change to the server starts a new connection with a fresh list', async () => {
    mcp.saveServer('lists', { type: 'stdio', command: process.execPath, args: [fixture], enabled: true, env: { CHANGED: '1' } });
    expect((await mcp.listTools('lists')).map((t) => t.name)).toEqual(['asked', 'grow']);
    expect(await asked()).toBe(1);
  });
});
