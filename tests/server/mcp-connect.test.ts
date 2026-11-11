// Connecting to MCP servers: what a local one printed goes with its errors, progress reports keep a slow
// request alive (up to a limit), and a link that wants a key says so instead of trying the older way.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as mcp from '../../server/mcp.ts';

// A tiny stdio MCP server: "crash" prints and quits, "progress" reports progress while it works, "quiet" doesn't.
const FAKE = `
const mode = process.argv[2];
if (mode === 'crash') {
  process.stderr.write('starting up\\nError: the key sk-secret-123 was refused\\n');
  process.exit(1);
}
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } });
  else if (m.method === 'tools/list' || m.method === 'tools/call') {
    const token = m.params && m.params._meta && m.params._meta.progressToken;
    let n = 0;
    const tick = setInterval(() => mode === 'progress' && token !== undefined && send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: ++n } }), 80);
    setTimeout(() => {
      clearInterval(tick);
      send({ jsonrpc: '2.0', id: m.id, result: m.method === 'tools/list' ? { tools: [{ name: 'slow', inputSchema: { type: 'object' } }] } : { content: [{ type: 'text', text: 'done' }] } });
    }, 700);
  }
});
`;

let dir = '';
let script = '';
const was = { ...mcp.TIMEOUTS };
const local = (name: string, mode: string, env: Record<string, string> = {}) =>
  mcp.saveServer(name, { type: 'stdio', command: process.execPath, args: [script, mode], env });

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-fake-'));
  script = path.join(dir, 'fake.cjs');
  fs.writeFileSync(script, FAKE);
});
afterEach(async () => {
  Object.assign(mcp.TIMEOUTS, was);
  for (const n of Object.keys(mcp.listServers())) {
    await mcp.disconnect(n);
    mcp.removeServer(n);
  }
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('a local server that fails', () => {
  it('says what it printed, with its key hidden', async () => {
    local('broken', 'crash', { API_KEY: 'sk-secret-123' });
    const err = await mcp.testServer('broken').then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err?.message).toContain('Couldn\'t start MCP server "broken"');
    expect(err?.message).toContain(`${mcp.OUTPUT_MARK}starting up\nError: the key ${mcp.HIDDEN} was refused`);
    expect(err?.message).not.toContain('sk-secret-123');
    expect(mcp.serverOutput('broken')).toContain('was refused');
  });
});

describe('slow requests', () => {
  it('keep going while the server reports progress', async () => {
    Object.assign(mcp.TIMEOUTS, { list: 300, listMax: 5000, call: 300, callMax: 5000 });
    local('slow', 'progress');
    expect((await mcp.listTools('slow')).map((t) => t.name)).toEqual(['slow']);
    expect((await mcp.callTool('slow', 'slow')).text).toBe('done');
  });

  it('give up when the server goes quiet', async () => {
    Object.assign(mcp.TIMEOUTS, { list: 300, listMax: 5000 });
    local('quiet', 'quiet');
    await expect(mcp.listTools('quiet')).rejects.toThrow(/quiet listing its tools took too long: no word from it/);
  });

  it('give up at the overall limit, progress or not', async () => {
    Object.assign(mcp.TIMEOUTS, { call: 300, callMax: 250 });
    local('slow', 'progress');
    await expect(mcp.callTool('slow', 'slow')).rejects.toThrow(
      /slow\.slow took too long: it went on for over .* in all/,
    );
  });
});

describe('a server at a link', () => {
  let server: http.Server;
  let base = '';
  const seen: { method: string; path: string }[] = [];
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      seen.push({ method: req.method || '', path: req.url || '' });
      req.resume();
      if (req.url?.startsWith('/locked')) res.writeHead(401, { 'content-type': 'text/plain' }).end('no key');
      else if (req.url?.startsWith('/forbidden')) res.writeHead(403, { 'content-type': 'text/plain' }).end('not yours');
      else res.writeHead(404, { 'content-type': 'text/plain' }).end('nothing here');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('that wants a key says so, and does not try the older way', async () => {
    seen.length = 0;
    mcp.saveServer('locked', { type: 'http', url: `${base}/locked`, headers: { Authorization: 'Bearer old' } });
    await expect(mcp.testServer('locked')).rejects.toThrow(/needs a sign-in or a key \(it answered 401 Unauthorized\)/);
    // (the older SSE way opens with a GET)
    expect(seen.filter((r) => r.method === 'GET')).toEqual([]);
    mcp.saveServer('forbidden', { type: 'http', url: `${base}/forbidden`, headers: {} });
    await expect(mcp.testServer('forbidden')).rejects.toThrow(/it answered 403 Forbidden/);
  });

  it('that answers neither way shows both errors', async () => {
    mcp.saveServer('gone', { type: 'http', url: `${base}/gone`, headers: {} });
    const err = await mcp.testServer('gone').then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err?.message).toMatch(/Streamable HTTP: .*404/);
    expect(err?.message).toMatch(/SSE: .*404/);
  });
});
