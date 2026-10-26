// Tools & MCP: built-in tools, MCP servers (presets, custom, imported), and sharing dashboard tools with Hermes / other apps.
import { h, mount, clear, GET, POST, DEL, attempt, field, seg, modal, toast, confirmBox, copy, refreshSoon } from '../core.ts';
import type { ToolGroup } from '../../shared/types.ts';

/** One saved MCP server (server/mcp.ts McpServerConfig). */
interface McpServerConfig {
  type: 'stdio' | 'http' | string;
  command: string;
  args: string[];
  env: Record<string, string>;
  url: string;
  headers: Record<string, string>;
  description?: string;
  enabled?: boolean;
}
/** A preset as GET /api/mcp lists it: whether its command is on this PC and whether it is added. */
type McpPresetListing = { name: string; title: string; description: string; ready: boolean; installed: boolean } & (
  | { type: 'stdio'; command: string; args: string[] }
  | { type: 'http'; url: string; headers: Record<string, string>; command?: undefined }
);
/** A server found in a Claude config that can be imported. */
interface ImportableServer {
  source: string;
  name: string;
  type: 'http' | 'stdio';
  command?: string;
  args: string[];
  env: Record<string, string>;
  url?: string;
  headers: Record<string, string>;
}
/** GET /api/mcp */
interface McpData {
  servers: Record<string, McpServerConfig>;
  presets: McpPresetListing[];
  importable: ImportableServer[];
  bridge: { command: string; args: string[]; env: Record<string, string> };
}
/** One built-in tool as GET /api/tools lists it. */
interface ToolListing {
  name: string;
  group: string;
  risk: 'none' | 'low' | 'high' | 'varies' | string;
  description: string;
}

let root: HTMLElement;
export const title = () => 'Tools & MCP';

export async function render(el: HTMLElement): Promise<void> {
  root = el;
  await draw();
}

async function draw(): Promise<void> {
  const [data, tools] = await Promise.all([GET<McpData>('/mcp'), GET<{ groups: ToolGroup[]; tools: ToolListing[] }>('/tools')]);
  const servers = Object.entries(data.servers);
  const bridgeJson = JSON.stringify({ mcpServers: { dashboard: data.bridge } }, null, 2);
  mount(
    root,
    h('p.lede', 'Tools are what agents can do. Built-in tools are turned on per agent in its Tools section. MCP servers add more: a real browser, GitHub, live Blender, and thousands of others.'),
    h(
      'div.panel',
      h('div.panel-head', h('h2', 'Your MCP servers'), h('div.actions', h('button.btn.small', { onclick: () => editServer() }, '+ Add server'))),
      servers.length
        ? h(
            'div.list',
            servers.map(([name, cfg]) => {
              const result = h('div');
              return h(
                'div',
                { style: { borderBottom: '1px solid var(--line)', padding: '10px 0' } },
                h(
                  'div.row',
                  h('div.grow', h('div.title', name), h('div.hint.mono', { style: { fontSize: '11.5px', overflowWrap: 'anywhere' } }, cfg.type === 'stdio' ? `${cfg.command} ${(cfg.args || []).join(' ')}` : cfg.url), cfg.description ? h('div.hint', cfg.description) : null),
                  h('button.btn.tiny.ghost', {
                    onclick: async (e) => {
                      (e.target as HTMLButtonElement).disabled = true;
                      mount(result, h('p.hint', 'Starting it and listing tools… (first run of npx/uvx servers can take a minute)'));
                      const r = await attempt(() => POST<{ tools: { name: string; description: string }[] }>(`/mcp/${encodeURIComponent(name)}/test`));
                      (e.target as HTMLButtonElement).disabled = false;
                      mount(result, r ? h('div.mt', h('span.pill.ok', `${r.tools.length} tools`), h('div.hint.mono', { style: { marginTop: '6px', fontSize: '11px' } }, r.tools.map((t) => t.name).join(' · '))) : h('p.red.hint', 'It did not start. Check the command, and that npx/uvx works in a terminal.'));
                    },
                  }, 'Test'),
                  h('button.btn.tiny.ghost', { onclick: () => editServer(name, cfg) }, 'Edit'),
                  h('button.btn.tiny.danger', { onclick: async () => (await confirmBox(`Remove ${name}?`, { ok: 'Remove', danger: true })) && attempt(() => DEL(`/mcp/${encodeURIComponent(name)}`)).then(draw) }, 'Remove'),
                ),
                result,
              );
            }),
          )
        : h('p.empty', 'None yet. Add a preset below.'),
      h('p.hint.mt', 'Give an agent a server in its Edit page > Tools > MCP servers. Claude Code agents also get the connectors on your Claude account (Gmail, Notion, Drive, Calendar, Higgsfield…) when they are signed in.'),
    ),
    h(
      'div.panel',
      h('div.panel-head', h('h2', 'Presets')),
      h(
        'div.cards',
        data.presets.map((p) =>
          h(
            'div.card',
            h('div.card-title', p.title),
            h('div.card-sub', p.description),
            h('div.hint.mono', { style: { fontSize: '11px' } }, p.type === 'stdio' ? `${p.command} ${p.args.join(' ')}` : p.url),
            h(
              'div.card-foot',
              p.installed
                ? h('span.pill.ok', 'added')
                : h('button.btn.small', { onclick: () => attempt(() => POST('/mcp-preset', { name: p.name }), `Added ${p.title}`).then(draw) }, 'Add'),
              !p.ready ? h('span.pill.warn', `needs ${p.command}`) : null,
            ),
          ),
        ),
      ),
    ),
    data.importable.length
      ? h(
          'div.panel',
          h('div.panel-head', h('h2', 'Found in your Claude configs')),
          h(
            'div.list',
            data.importable.map((s) =>
              h(
                'div.list-item',
                h('div.grow', h('div.title', s.name), h('div.hint', `${s.source} · ${s.type === 'stdio' ? `${s.command} ${s.args.join(' ')}` : s.url}`)),
                data.servers[s.name] ? h('span.pill.ok', 'added') : h('button.btn.tiny', { onclick: () => attempt(() => POST('/mcp-import', { name: s.name, source: s.source }), 'Imported').then(draw) }, 'Import'),
              ),
            ),
          ),
        )
      : null,
    h(
      'div.panel',
      h('div.panel-head', h('h2', 'Share the dashboard tools')),
      h('p', 'Claude Code and Codex agents here get the dashboard tools automatically. Hermes, pi, oh-my-pi and other MCP apps can have them too: ComfyUI, Blender, Adobe, programs, X drafts, your other agents.'),
      h(
        'div.row',
        h('button.btn.small', { onclick: () => attempt(() => POST('/hermes/add-bridge'), 'Hermes now has the dashboard tools (restart Hermes sessions to see them)') }, 'Give Hermes the dashboard tools'),
        h('button.btn.small', { onclick: () => attempt(() => POST<{ message: string }>('/pi/add-bridge'), (r) => r.message) }, 'Give pi and oh-my-pi the dashboard tools'),
        h('button.btn.ghost.small', { onclick: () => copy(bridgeJson) }, 'Copy MCP config for other apps'),
      ),
      h('details.mt', h('summary.label', { style: { cursor: 'pointer' } }, 'Show config'), h('pre', bridgeJson), h('p.hint', 'Paste into Claude Desktop, Cursor, or any MCP client. They act as "External MCP client": everything except shell, and they ask you first. The dashboard must be running.')),
      h('p.hint', 'pi and oh-my-pi keep it in their own mcp.json (pi needs version 0.99 or newer). Their agents here then use the dashboard tools as themselves; when you run pi on your own, it acts as "External MCP client".'),
    ),
    h(
      'div.panel',
      h('div.panel-head', h('h2', `Built-in tools (${tools.tools.length})`)),
      tools.groups.map((g) =>
        h(
          'div',
          { style: { marginBottom: '14px' } },
          h('div.row', h('b', g.label), h('span.hint', g.description)),
          h(
            'div.chips.mt',
            tools.tools
              .filter((t) => t.group === g.id)
              .map((t) => h('span.chip', { title: t.description, style: { cursor: 'help' } }, t.name, t.risk === 'high' ? h('span.amber', ' ●') : t.risk === 'low' ? h('span.faint', ' ●') : t.risk === 'varies' ? h('span.faint', ' ◐') : null)),
          ),
        ),
      ),
      h('p.hint', h('span.amber', '●'), ' asks you unless the agent is on Full · ', h('span.faint', '●'), ' asks only agents on "Ask first" · ', h('span.faint', '◐'), ' depends on what it is asked to do · none: never asks'),
    ),
  );
}

function editServer(name = '', cfg: McpServerConfig = { type: 'stdio', command: 'npx', args: [], env: {}, url: '', headers: {} }): void {
  const c = structuredClone(cfg);
  const nameIn = h('input', { value: name, placeholder: 'e.g. playwright', disabled: !!name });
  const fields = h('div.col');
  const draw = () =>
    mount(
      fields,
      c.type === 'stdio'
        ? [
            field('Command', h('input.code', { value: c.command, placeholder: 'npx, uvx, node, python, or a full path', oninput: (e) => (c.command = e.target.value) })),
            field('Arguments', h('input.code', { value: (c.args || []).join(' '), placeholder: '-y @playwright/mcp@latest', oninput: (e) => (c.args = e.target.value.split(/\s+/).filter(Boolean)) }), 'Separated by spaces.'),
            field('Environment', h('textarea.code', { rows: 3, value: Object.entries(c.env || {}).map(([k, v]) => `${k}=${v}`).join('\n'), placeholder: 'API_KEY=…', oninput: (e) => (c.env = parseKv(e.target.value)) }), 'One KEY=value per line.'),
          ]
        : [
            field('URL', h('input.code', { value: c.url, placeholder: 'https://…/mcp', oninput: (e) => (c.url = e.target.value) })),
            field('Headers', h('textarea.code', { rows: 3, value: Object.entries(c.headers || {}).map(([k, v]) => `${k}: ${v}`).join('\n'), placeholder: 'Authorization: Bearer …', oninput: (e) => (c.headers = parseHeaders(e.target.value)) })),
          ],
      field('Description', h('input', { value: c.description || '', oninput: (e) => (c.description = e.target.value) })),
    );
  const m = modal({
    title: name ? `Edit ${name}` : 'Add MCP server',
    body: h('div.col', field('Name', nameIn), seg([{ value: 'stdio', label: 'Local command' }, { value: 'http', label: 'Remote URL' }], c.type, (v) => ((c.type = v), draw())), fields),
    foot: [
      h('button.btn.ghost', { onclick: () => m.close() }, 'Cancel'),
      h('button.btn', {
        onclick: async () => {
          const r = await attempt(() => POST('/mcp', { name: nameIn.value, ...c }), 'Saved');
          if (r) {
            m.close();
            render(root);
            refreshSoon();
          }
        },
      }, 'Save'),
    ],
  });
  draw();
}

const parseKv = (t: string): Record<string, string> => Object.fromEntries(t.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
const parseHeaders = (t: string): Record<string, string> => Object.fromEntries(t.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.includes(':')).map((l) => [l.slice(0, l.indexOf(':')).trim(), l.slice(l.indexOf(':') + 1).trim()]));
