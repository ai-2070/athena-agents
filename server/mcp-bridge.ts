#!/usr/bin/env node
// MCP server (stdio) that exposes the dashboard's tools to Claude Code, Hermes or any MCP client.
// It forwards every call to the running dashboard, which applies the agent's permissions and approvals.
//   DASH_PORT   dashboard port (default 4800)
//   DASH_TOKEN  internal token from data/.internal-token (read automatically when unset)
//   DASH_AGENT  which agent is calling (its tool groups and autonomy apply)
//   DASH_RUN    the run it belongs to; DASH_PROJECT the project an agent's terminal was opened in
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

/** What the dashboard's /api/internal endpoints answer. */
interface BridgeTool {
  name: string;
  description?: string;
  parameters: Tool['inputSchema'];
}
interface BridgeCallResult {
  text?: string;
  images?: string[];
  isError?: boolean;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const port = process.env.DASH_PORT || '4800';
let token = process.env.DASH_TOKEN;
if (!token) {
  try {
    token = fs
      .readFileSync(path.join(process.env.DASH_DATA || path.join(here, '..', 'data'), '.internal-token'), 'utf8')
      .trim();
  } catch {
    token = '';
  }
}
const agent = process.env.DASH_AGENT || '';
const runId = process.env.DASH_RUN || '';
const projectId = process.env.DASH_PROJECT || '';
const base = `http://127.0.0.1:${port}/api/internal`;

// Plain http (no timeout): a call can wait a long time while you decide on an approval.
function call<T>(pathname: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      `${base}${pathname}`,
      {
        // (the client cancelled the call: the request goes, and the dashboard stops what it waited on)
        ...(signal ? { signal } : {}),
        method: body ? 'POST' : 'GET',
        headers: {
          'x-dash-internal': token,
          'content-type': 'application/json',
          host: `localhost:${port}`,
          ...(data ? { 'content-length': Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (text += c));
        res.on('end', () => {
          let json: { error?: string } = {};
          try {
            json = JSON.parse(text) as { error?: string };
          } catch {
            /* not json */
          }
          if ((res.statusCode ?? 0) >= 400) reject(new Error(json.error || `Dashboard returned ${res.statusCode}`));
          else resolve(json as T);
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const server = new Server({ name: 'dashboard', version: '1.0.0' }, { capabilities: { tools: { listChanged: true } } });

server.setRequestHandler(ListToolsRequestSchema, async () => {
  try {
    const { tools } = await call<{ tools: BridgeTool[] }>(
      `/tools?agent=${encodeURIComponent(agent)}&run=${encodeURIComponent(runId)}&project=${encodeURIComponent(projectId)}`,
    );
    return { tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters })) };
  } catch (e) {
    process.stderr.write(
      `dashboard bridge: could not list tools (${(e as Error).message}). Is the dashboard running on port ${port}?\n`,
    );
    return { tools: [] };
  }
});

server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
  try {
    const r = await call<BridgeCallResult>(
      '/tools/call',
      {
        agent,
        run: runId,
        project: projectId,
        name: req.params.name,
        args: req.params.arguments || {},
      },
      extra.signal,
    );
    const content: CallToolResult['content'] = [{ type: 'text', text: r.text || '(no output)' }];
    for (const img of r.images || []) {
      const m = /^data:([^;]+);base64,(.*)$/.exec(img);
      if (m) content.push({ type: 'image', mimeType: m[1], data: m[2] });
    }
    // tools given by request_tool: tell the client to fetch the list again, so it can use them at once
    if (req.params.name === 'request_tool' && !r.isError) void server.sendToolListChanged().catch(() => {});
    return { content, isError: !!r.isError };
  } catch (e) {
    return {
      content: [
        { type: 'text', text: `Dashboard error: ${(e as Error).message}. Is the dashboard running on port ${port}?` },
      ],
      isError: true,
    };
  }
});

await server.connect(new StdioServerTransport());
