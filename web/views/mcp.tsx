// Tools & MCP: built-in tools, MCP servers (presets, custom, imported), and sharing dashboard tools with Hermes / other apps.
import { useCallback, useEffect, useState } from 'react';
import { GET, POST, DEL, attempt, confirmBox, copy, refreshSoon } from '../core.ts';
import { Field, Segmented } from '../ui/controls.tsx';
import { openModal } from '../ui/overlays.tsx';
import { reactPage } from '../ui/react.tsx';
import type { McpSuggestion, ToolGroup } from '../../shared/types.ts';

// why a server is suggested ("on this PC" gets the accent and a dot); mcp-why stays for the tests
const WHY = 'mcp-why font-mono text-[11px] leading-[1.4] font-medium';

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
  | { type: 'stdio'; command: string; args: string[]; env?: Record<string, string> }
  | { type: 'http'; url: string; headers: Record<string, string>; command?: undefined }
);
/** A preset that ships a placeholder (YOUR_...) for a key you have to fill in. */
const needsKey = (p: McpPresetListing) => [...Object.values(p.type === 'stdio' ? p.env || {} : p.headers)].some((v) => /YOUR_/.test(v));
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
  /** ready-made ones that fit this PC and aren't added (a program they drive is installed, or a basic one) */
  suggested?: McpSuggestion[];
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
type Tools = { groups: ToolGroup[]; tools: ToolListing[] };

/** KEY=value lines (environment). */
export const parseKv = (t: string): Record<string, string> => Object.fromEntries(t.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
/** Name: value lines (HTTP headers). */
export const parseHeaders = (t: string): Record<string, string> => Object.fromEntries(t.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.includes(':')).map((l) => [l.slice(0, l.indexOf(':')).trim(), l.slice(l.indexOf(':') + 1).trim()]));

export function McpTab() {
  const [data, setData] = useState<McpData | null>(null);
  const [tools, setTools] = useState<Tools | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const reload = useCallback(
    () =>
      Promise.all([GET<McpData>('/mcp'), GET<Tools>('/tools')])
        .then(([d, t]) => (setData(d), setTools(t)))
        .catch((e: unknown) => setFailed(e instanceof Error ? e.message : String(e))),
    [],
  );
  useEffect(() => void reload(), [reload]);
  if (failed) return <div className="panel"><p className="text-red">Something went wrong: {failed}</p></div>;
  if (!data || !tools) return null;

  const servers = Object.entries(data.servers);
  // (an older server sends no suggestions)
  const suggested = data.suggested || [];
  const bridgeJson = JSON.stringify({ mcpServers: { dashboard: data.bridge } }, null, 2);
  const edit = (name?: string, cfg?: McpServerConfig) =>
    openModal(name ? `Edit ${name}` : 'Add MCP server', (close) => <ServerForm name={name} cfg={cfg} close={close} saved={() => (void reload(), refreshSoon())} />);

  return (
    <>
      <p className="lede">Tools are what agents can do. Built-in tools are turned on per agent in its Tools section. MCP servers add more: a real browser, GitHub, live Blender, and thousands of others.</p>
      <div className="panel">
        <div className="panel-head">
          <h2>Your MCP servers</h2>
          <div className="actions">
            <button className="btn small" onClick={() => edit()}>+ Add server</button>
          </div>
        </div>
        {servers.length ? (
          <div className="list">
            {servers.map(([name, cfg]) => (
              <ServerRow key={name} name={name} cfg={cfg} onEdit={() => edit(name, cfg)} reload={reload} />
            ))}
          </div>
        ) : (
          <p className="empty">None yet. Add a preset below.</p>
        )}
        <p className="hint mt-3.5">Give an agent a server in its Edit page &gt; Tools &gt; MCP servers. Claude Code agents also get the connectors on your Claude account (Gmail, Notion, Drive, Calendar, Higgsfield…) when they are signed in.</p>
      </div>

      {suggested.length ? (
        <div className="panel">
          <div className="panel-head">
            <h2>Suggested for this PC</h2>
          </div>
          <p className="hint">Ready-made servers for programs found on this PC, and a few that help most agents. Nothing is added until you click Add: each one runs a program from its maker.</p>
          <div className="list mt-3.5">
            {suggested.map((sg) => (
              <div key={sg.name} className="list-row mcp-suggest">
                <div className="min-w-0 flex-1">
                  <div className="title flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                    {sg.title} <span className={sg.program ? `${WHY} on text-accent before:mr-1.5 before:inline-block before:size-1.5 before:rounded-full before:bg-current before:align-[1px] before:content-['']` : `${WHY} text-dim`}>{sg.reason}</span>
                  </div>
                  <div className="hint mt-0.5">{sg.description}</div>
                  {sg.needs ? <div className="hint mt-0.5 text-amber">{sg.needs.replace(/^needs /, 'Needs ').replace(/; setup: /, '. Then: ').replace(/^setup: /, 'First: ')}</div> : null}
                </div>
                <button className="btn small" onClick={() => void attempt(() => POST('/mcp-preset', { name: sg.name }), `Added ${sg.title}${sg.needs ? '. See what it needs below it.' : ''}`).then(reload)}>
                  Add
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="panel">
        <div className="panel-head">
          <h2>Presets</h2>
        </div>
        <div className="cards">
          {data.presets.map((p) => (
            <div key={p.name} className="card">
              <div className="card-title">{p.title}</div>
              <div className="card-sub">{p.description}</div>
              <div className="hint font-mono text-[11.5px] wrap-anywhere">{p.type === 'stdio' ? `${p.command} ${p.args.join(' ')}` : p.url}</div>
              <div className="card-foot">
                {p.installed ? <span className="pill ok">added</span> : <button className="btn small" onClick={() => void attempt(() => POST('/mcp-preset', { name: p.name }), `Added ${p.title}`).then(reload)}>Add</button>}
                {!p.ready ? <span className="pill warn">{`needs ${p.command}`}</span> : null}
                {!p.installed && needsKey(p) ? <span className="pill info" title="After adding, put your key in the settings of the added server below">needs your key</span> : null}
              </div>
            </div>
          ))}
        </div>
      </div>

      {data.importable.length ? (
        <div className="panel">
          <div className="panel-head">
            <h2>Found in your Claude configs</h2>
          </div>
          <div className="list">
            {data.importable.map((s) => (
              <div key={`${s.source}:${s.name}`} className="list-row">
                <div className="min-w-0 flex-1">
                  <div className="title">{s.name}</div>
                  <div className="hint">{`${s.source} · ${s.type === 'stdio' ? `${s.command} ${s.args.join(' ')}` : s.url}`}</div>
                </div>
                {data.servers[s.name] ? <span className="pill ok">added</span> : <button className="btn tiny" onClick={() => void attempt(() => POST('/mcp-import', { name: s.name, source: s.source }), 'Imported').then(reload)}>Import</button>}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="panel">
        <div className="panel-head">
          <h2>Share the dashboard tools</h2>
        </div>
        <p>Claude Code and Codex agents here get the dashboard tools automatically. Hermes, pi, oh-my-pi and other MCP apps can have them too: ComfyUI, Blender, Adobe, programs, X drafts, your other agents.</p>
        <div className="flex flex-wrap items-center gap-2.5">
          <button className="btn small" onClick={() => void attempt(() => POST('/hermes/add-bridge'), 'Hermes now has the dashboard tools (restart Hermes sessions to see them)')}>Give Hermes the dashboard tools</button>
          <button className="btn small" onClick={() => void attempt(() => POST<{ message: string }>('/pi/add-bridge'), (r) => r.message)}>Give pi and oh-my-pi the dashboard tools</button>
          <button className="btn ghost small" onClick={() => copy(bridgeJson)}>Copy MCP config for other apps</button>
        </div>
        <details className="mt-3.5">
          <summary className="label cursor-pointer">Show config</summary>
          <pre>{bridgeJson}</pre>
          <p className="hint">Paste into Claude Desktop, Cursor, or any MCP client. They act as "External MCP client": everything except shell, and they ask you first. The dashboard must be running.</p>
        </details>
        <p className="hint">pi and oh-my-pi keep it in their own mcp.json (pi needs version 0.99 or newer). Their agents here then use the dashboard tools as themselves; when you run pi on your own, it acts as "External MCP client".</p>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>{`Built-in tools (${tools.tools.length})`}</h2>
        </div>
        {tools.groups.map((g) => (
          <div key={g.id} className="mb-3.5">
            <div className="flex flex-wrap items-center gap-2.5">
              <b>{g.label}</b>
              <span className="hint">{g.description}</span>
            </div>
            <div className="chips mt-3.5">
              {tools.tools
                .filter((t) => t.group === g.id)
                .map((t) => (
                  <span key={t.name} className="chip mcp-tool cursor-help" title={t.description}>
                    {t.name}
                    {t.risk === 'high' ? <span className="text-amber"> ●</span> : t.risk === 'low' ? <span className="text-faint"> ●</span> : t.risk === 'varies' ? <span className="text-faint"> ◐</span> : null}
                  </span>
                ))}
            </div>
          </div>
        ))}
        <p className="hint">
          <span className="text-amber">●</span> asks you unless the agent is on Full · <span className="text-faint">●</span> asks only agents on "Ask first" · <span className="text-faint">◐</span> depends on what it is asked to do · none: never asks
        </p>
      </div>
    </>
  );
}

function ServerRow({ name, cfg, onEdit, reload }: { name: string; cfg: McpServerConfig; onEdit: () => void; reload: () => Promise<unknown> }) {
  // the last test: running, its tools, or that it did not start
  const [test, setTest] = useState<'running' | 'failed' | string[] | null>(null);
  const run = async () => {
    setTest('running');
    const r = await attempt(() => POST<{ tools: { name: string; description: string }[] }>(`/mcp/${encodeURIComponent(name)}/test`));
    setTest(r ? r.tools.map((t) => t.name) : 'failed');
  };
  const remove = async () => {
    if (await confirmBox(`Remove ${name}?`, { ok: 'Remove', danger: true })) await attempt(() => DEL(`/mcp/${encodeURIComponent(name)}`)).then(reload);
  };
  return (
    <div className="mcp-server border-b border-line py-2.5">
      <div className="flex flex-wrap items-center gap-2.5">
        <div className="min-w-0 flex-1">
          <div className="title">{name}</div>
          <div className="hint font-mono text-[11.5px] wrap-anywhere">{cfg.type === 'stdio' ? `${cfg.command} ${(cfg.args || []).join(' ')}` : cfg.url}</div>
          {cfg.description ? <div className="hint">{cfg.description}</div> : null}
        </div>
        <button className="btn tiny ghost" disabled={test === 'running'} onClick={() => void run()}>Test</button>
        <button className="btn tiny ghost" onClick={onEdit}>Edit</button>
        <button className="btn tiny danger" onClick={() => void remove()}>Remove</button>
      </div>
      <div aria-live="polite">
        {test === 'running' ? <p className="hint">Starting it and listing tools… (first run of npx/uvx servers can take a minute)</p> : null}
        {test === 'failed' ? <p className="hint">It did not start. Check the command, and that npx/uvx works in a terminal.</p> : null}
        {Array.isArray(test) ? (
          <div className="mt-3.5">
            <span className="pill ok">{`${test.length} tools`}</span>
            <div className="hint mcp-tools mt-1.5 font-mono text-[11px]">{test.join(' · ')}</div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

const BLANK: McpServerConfig = { type: 'stdio', command: 'npx', args: [], env: {}, url: '', headers: {} };

function ServerForm({ name = '', cfg = BLANK, close, saved }: { name?: string; cfg?: McpServerConfig; close: () => void; saved: () => void }) {
  const [newName, setNewName] = useState(name);
  const [c, setC] = useState<McpServerConfig>(() => structuredClone(cfg));
  // the text boxes as typed (turned into lists and maps when saved)
  const [args, setArgs] = useState((cfg.args || []).join(' '));
  const [env, setEnv] = useState(Object.entries(cfg.env || {}).map(([k, v]) => `${k}=${v}`).join('\n'));
  const [headers, setHeaders] = useState(Object.entries(cfg.headers || {}).map(([k, v]) => `${k}: ${v}`).join('\n'));
  const save = async () => {
    const body = { name: newName, ...c, args: args.split(/\s+/).filter(Boolean), env: parseKv(env), headers: parseHeaders(headers) };
    if (await attempt(() => POST('/mcp', body), 'Saved')) {
      close();
      saved();
    }
  };
  return (
    <>
      <div className="modal-body">
        <div className="flex flex-col gap-2.5">
          <Field label="Name">
            <input value={newName} placeholder="e.g. playwright" disabled={!!name} onChange={(e) => setNewName(e.target.value)} />
          </Field>
          <Segmented
            label="Kind of server"
            options={[
              { value: 'stdio', label: 'Local command' },
              { value: 'http', label: 'Remote URL' },
            ]}
            value={c.type === 'http' ? 'http' : 'stdio'}
            onChange={(v) => setC({ ...c, type: v })}
          />
          <div className="flex flex-col gap-2.5">
            {c.type === 'stdio' ? (
              <>
                <Field label="Command">
                  <input className="code" value={c.command} placeholder="npx, uvx, node, python, or a full path" onChange={(e) => setC({ ...c, command: e.target.value })} />
                </Field>
                <Field label="Arguments" hint="Separated by spaces.">
                  <input className="code" value={args} placeholder="-y @playwright/mcp@latest" onChange={(e) => setArgs(e.target.value)} />
                </Field>
                <Field label="Environment" hint="One KEY=value per line.">
                  <textarea className="code" rows={3} value={env} placeholder="API_KEY=…" onChange={(e) => setEnv(e.target.value)} />
                </Field>
              </>
            ) : (
              <>
                <Field label="URL">
                  <input className="code" value={c.url} placeholder="https://…/mcp" onChange={(e) => setC({ ...c, url: e.target.value })} />
                </Field>
                <Field label="Headers">
                  <textarea className="code" rows={3} value={headers} placeholder="Authorization: Bearer …" onChange={(e) => setHeaders(e.target.value)} />
                </Field>
              </>
            )}
            <Field label="Description">
              <input value={c.description || ''} onChange={(e) => setC({ ...c, description: e.target.value })} />
            </Field>
          </div>
        </div>
      </div>
      <div className="modal-foot">
        <button className="btn ghost" onClick={close}>Cancel</button>
        <button className="btn" onClick={() => void save()}>Save</button>
      </div>
    </>
  );
}

export const title = () => 'Tools & MCP';
export const { render, unmount } = reactPage(() => <McpTab />);
