// The API runtimes share tool names and account routing.
import { toolDefs } from './tools.ts';
import type { ToolScope } from './tools.ts';
import * as mcp from './mcp.ts';
import type { Agent, RunEvent } from '../shared/types.ts';

export interface ToolDef {
  type: 'function';
  function: { name: string; description?: string; parameters: unknown };
}

export type ToolRoute =
  { kind: 'builtin'; name: string } | { kind: 'mcp'; server: string; name: string; risk: 'low' | 'high' };

const safeName = (s: string): string => s.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);

/** An MCP tool's name for the model: <server>__<tool>, at most 64 characters. Two names cut to the same 64
 *  ("…__send_email_with_a…" twice) would call the wrong tool: the second one gets a number. */
export function mcpToolName(server: string, tool: string, taken: { has(name: string): boolean }): string {
  const base = safeName(`${server}__${tool}`);
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base.slice(0, 63 - String(i).length)}_${i}`;
  return name;
}

export async function gatherTools(
  agent: Agent,
  onEvent: (ev: RunEvent) => void,
  scope: ToolScope = { engine: agent.engine },
): Promise<{ defs: ToolDef[]; route: Map<string, ToolRoute> }> {
  const defs: ToolDef[] = toolDefs(agent, scope).map((t): ToolDef => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
  const route = new Map<string, ToolRoute>(
    defs.map((d): [string, ToolRoute] => [d.function.name, { kind: 'builtin', name: d.function.name }]),
  );
  const servers = mcp.listServers();
  // (a server you turned off isn't started or offered)
  for (const server of (agent.mcpServers || []).filter((n) => mcp.isEnabled(n, servers))) {
    // a copy of a service (one account of several) is named by its label: "[OOMOL: Work] Send an email"
    const shown = mcp.accountOf(server, servers) || server;
    try {
      const tools = await mcp.listTools(server);
      for (const t of tools) {
        const name = mcpToolName(server, t.name, route);
        route.set(name, { kind: 'mcp', server, name: t.name, risk: mcp.mcpToolRisk(t) });
        defs.push({
          type: 'function',
          function: {
            name,
            description: `[${shown}] ${t.description || ''}`.slice(0, 1000),
            parameters: t.inputSchema || { type: 'object', properties: {} },
          },
        });
      }
    } catch (e) {
      onEvent({ kind: 'status', text: `MCP server ${server} unavailable: ${(e as Error).message}` });
    }
  }
  return { defs, route };
}
