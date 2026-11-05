// A tiny MCP server that counts how often it is asked for its tools. "grow" adds a tool and says the list changed.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const tools = [
  { name: 'asked', description: 'How often the tool list was asked for', inputSchema: { type: 'object', properties: {} } },
  { name: 'grow', description: 'Adds a tool', inputSchema: { type: 'object', properties: {} } },
];
let asked = 0;
const server = new Server({ name: 'lists', version: '1.0.0' }, { capabilities: { tools: { listChanged: true } } });
server.setRequestHandler(ListToolsRequestSchema, async () => {
  asked++;
  return { tools };
});
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === 'grow') {
    tools.push({ name: `extra${tools.length}`, description: 'An added tool', inputSchema: { type: 'object', properties: {} } });
    await server.sendToolListChanged();
    return { content: [{ type: 'text', text: 'grown' }] };
  }
  return { content: [{ type: 'text', text: String(asked) }] };
});
await server.connect(new StdioServerTransport());
