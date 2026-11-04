// MCP servers: built-in tools, MCP servers (presets, custom, imported), and sharing dashboard tools with Hermes / other apps.
import { Button } from '../ui/button.tsx';
import { CHIPS_CLASS, chipClass } from '../ui/classes.ts';
import { Pill } from '../ui/marks.tsx';
import { Plate } from '../ui/surface.tsx';
import { useCallback, useEffect, useState } from 'react';
import { GET, POST, DEL, attempt, confirmBox, copy, refreshSoon } from '../core.ts';
import { Field, PanelNote, Row, SearchBox, Section, Segmented } from '../ui/controls.tsx';
import { openModal } from '../ui/overlays.tsx';
import { presetIcon } from '../preseticons.ts';
import { onThemeChange } from '../theme.ts';
import { DomNode, reactPage } from '../ui/react.tsx';
import { SelectControl } from '../ui/select.tsx';
import type { McpServerInfo, McpSuggestion, ToolGroup } from '../../shared/types.ts';

function PresetTitle({ name, title }: { name: string; title: string }) {
  const [theme, setTheme] = useState(0);
  useEffect(() => onThemeChange(() => setTheme((n) => n + 1)), []);
  return <div className="card-title flex items-center gap-2.5">
    <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-ctl bg-panel-2 text-ink">
      <DomNode as="span" className="flex" make={() => presetIcon(name)} deps={[name, theme]} />
    </span>
    <span>{title}</span>
  </div>;
}

// why a server is suggested ("on this PC" gets the accent and a dot); mcp-why stays for the tests
// marks where the server's own output starts in an error (server/mcp.ts OUTPUT_MARK)
const OUTPUT_MARK = '\n\nWhat it printed:\n';

const WHY = 'mcp-why text-[12px] leading-[1.4] font-medium';

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
  /** a copy's own name ("Work"), when a service is added more than once */
  label?: string;
  /** the service it is another account of */
  kind?: string;
  /** when to pick this copy over the service's other ones */
  useFor?: string;
}
/** A preset as GET /api/mcp lists it: whether its command is on this PC and whether it is added (and as which servers). */
type McpPresetListing = { name: string; title: string; description: string; ready: boolean; installed: boolean; copies?: string[]; /** the service for people: "OOMOL" */ service?: string } & (
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
  /** each server's label, service and "use for" (an older server leaves it out) */
  info?: Record<string, McpServerInfo>;
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
/** A command's arguments as one line: one with a space (a path like C:/MCP Servers/x.js) or a quote in
 *  it goes in double quotes, with a quote inside as \". splitArgs() reads it back the same. */
export const joinArgs = (args: readonly string[]): string => args.map((a) => (a && !/[\s"]/.test(a) ? a : `"${a.replace(/"/g, '\\"')}"`)).join(' ');
/** The arguments typed in one line: split at spaces, except inside "double quotes" (\" is a quote there). */
export function splitArgs(t: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  // (a "" is an empty argument: a word has started once a quote opens)
  let started = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (quoted && ch === '\\' && t[i + 1] === '"') {
      cur += '"';
      i++;
    } else if (ch === '"') {
      quoted = !quoted;
      started = true;
    } else if (!quoted && /\s/.test(ch)) {
      if (cur || started) out.push(cur);
      cur = '';
      started = false;
    } else cur += ch;
  }
  if (cur || started) out.push(cur);
  return out;
}
/** Name: value lines (HTTP headers). */
export const parseHeaders = (t: string): Record<string, string> => Object.fromEntries(t.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.includes(':')).map((l) => [l.slice(0, l.indexOf(':')).trim(), l.slice(l.indexOf(':') + 1).trim()]));

export function McpTab() {
  const [data, setData] = useState<McpData | null>(null);
  const [tools, setTools] = useState<Tools | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [find, setFind] = useState('');
  const reload = useCallback(
    () =>
      Promise.all([GET<McpData>('/mcp'), GET<Tools>('/tools')])
        .then(([d, t]) => (setData(d), setTools(t)))
        .catch((e: unknown) => setFailed(e instanceof Error ? e.message : String(e))),
    [],
  );
  useEffect(() => void reload(), [reload]);
  if (failed) return <Plate className="rounded-box p-6"><p className="text-red">Something went wrong: {failed}</p></Plate>;
  if (!data || !tools) return null;

  const servers = Object.entries(data.servers);
  // (an older server sends no suggestions)
  const suggested = data.suggested || [];
  const bridgeJson = JSON.stringify({ mcpServers: { dashboard: data.bridge } }, null, 2);
  const info = data.info || {};
  // the services a server can be another account of: the ready-made ones and the ones added by hand
  const services = [...new Map([...data.presets.map((p) => [p.name, serviceOf(p)] as const), ...Object.values(info).map((i) => [i.kind, i.service] as const)]).entries()];
  const edit = (name?: string, cfg?: McpServerConfig) =>
    openModal(name ? `Edit ${info[name]?.title || name}` : 'Add MCP server', (close) => <ServerForm name={name} cfg={cfg} kind={name ? info[name]?.kind : undefined} services={services} close={close} saved={() => (void reload(), refreshSoon())} />);
  const words = find.trim().toLowerCase();
  const shown = words ? data.presets.filter((p) => `${p.name} ${p.title} ${p.description}`.toLowerCase().includes(words)) : data.presets;
  const addAnother = (p: McpPresetListing) =>
    openModal(`Add another ${serviceOf(p)} account`, (close) => <CopyForm preset={p} servers={data.servers} close={close} saved={() => (void reload(), refreshSoon())} />);

  return (
    <div className="flex flex-col gap-10">
      <p className="lede mb-0">Tools are what agents can do. Built-in tools are turned on per agent in its Tools section. MCP servers add more: a real browser, GitHub, live Blender, and thousands of others.</p>
      <Section title="Your MCP servers" description="The servers your agents can use." action={<Button size="small" onClick={() => edit()}>+ Add server</Button>}>
        {servers.length ? (
          servers.map(([name, cfg]) => <ServerRow key={name} name={name} cfg={cfg} info={info[name]} onEdit={() => edit(name, cfg)} reload={reload} />)
        ) : (
          <p className="empty m-0 px-5">None yet. Add a preset below.</p>
        )}
        <PanelNote>Give an agent a server in its Edit page &gt; Tools &gt; MCP servers. Claude Code agents also get the connectors on your Claude account (Gmail, Notion, Drive, Calendar, Higgsfield…) when they are signed in.</PanelNote>
      </Section>

      {suggested.length ? (
        <Section title="Suggested for this PC" description="Ready-made servers for programs found on this PC, and a few that help most agents.">
          {suggested.map((sg) => (
            <div key={sg.name} className="list-row mcp-suggest gap-4 px-5 py-4">
              <div className="min-w-0 flex-1">
                <div className="title flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                  {sg.title} <span className={sg.program ? `${WHY} on text-accent before:mr-1.5 before:inline-block before:size-1.5 before:rounded-full before:bg-current before:align-[1px] before:content-['']` : `${WHY} text-dim`}>{sg.reason}</span>
                </div>
                <div className="hint mt-0.5">{sg.description}</div>
                {sg.needs ? <div className="hint mt-0.5 text-amber">{sg.needs.replace(/^needs /, 'Needs ').replace(/; setup: /, '. Then: ').replace(/^setup: /, 'First: ')}</div> : null}
              </div>
              <Button size="small" onClick={() => void attempt(() => POST('/mcp-preset', { name: sg.name }), `Added ${sg.title}${sg.needs ? '. See what it needs below it.' : ''}`).then(reload)}>
                Add
              </Button>
            </div>
          ))}
          <PanelNote>Nothing is added until you click Add: each one runs a program from its maker.</PanelNote>
        </Section>
      ) : null}

      <Section bare title="Presets" description="Ready-made MCP servers. Add one with a click." action={<SearchBox className="w-full" placeholder="Search presets" label="Search presets" value={find} onChange={setFind} />}>
        {!shown.length ? <p className="empty m-0">{`No preset matches "${find.trim()}".`}</p> : null}
        <div className="cards">
          {shown.map((p) => (
            <Plate key={p.name} className="flex min-w-0 flex-col gap-2.5 rounded-box p-5">
              <PresetTitle name={p.name} title={p.title} />
              <div className="card-sub">{p.description}</div>
              <div className="hint font-mono text-[11.5px] wrap-anywhere">{p.type === 'stdio' ? `${p.command} ${p.args.join(' ')}` : p.url}</div>
              <div className="card-foot">
                {p.installed ? (
                  <>
                    <Pill tone="ok">{(p.copies?.length || 1) > 1 ? `${p.copies!.length} added` : 'added'}</Pill>
                    <Button variant="ghost" size="small" title="Another account of the same service, with its own label and keys" onClick={() => addAnother(p)}>Add another</Button>
                  </>
                ) : (
                  <Button size="small" onClick={() => void attempt(() => POST('/mcp-preset', { name: p.name }), `Added ${p.title}`).then(reload)}>Add</Button>
                )}
                {!p.ready ? <Pill tone="warn">{`needs ${p.command}`}</Pill> : null}
                {!p.installed && needsKey(p) ? <Pill tone="info" title="After adding, put your key in the settings of the added server below">needs your key</Pill> : null}
              </div>
            </Plate>
          ))}
        </div>
      </Section>

      {data.importable.length ? (
        <Section title="Found in your Claude configs" description="Servers already set up for Claude on this PC. Import the ones you want here.">
          {data.importable.map((s) => (
            <div key={`${s.source}:${s.name}`} className="list-row gap-4 px-5 py-4">
              <div className="min-w-0 flex-1">
                <div className="title">{s.name}</div>
                <div className="hint wrap-anywhere">{`${s.source} · ${s.type === 'stdio' ? `${s.command} ${s.args.join(' ')}` : s.url}`}</div>
              </div>
              {data.servers[s.name] ? <Pill tone="ok">added</Pill> : <Button size="tiny" onClick={() => void attempt(() => POST('/mcp-import', { name: s.name, source: s.source }), 'Imported').then(reload)}>Import</Button>}
            </div>
          ))}
        </Section>
      ) : null}

      <Section title="Share the dashboard tools" description="Let other apps use the tools in this dashboard.">
        <Row title="Claude Code and Codex" description="Agents here get the dashboard tools automatically. Hermes, pi, oh-my-pi and other MCP apps can have them too: ComfyUI, Blender, Adobe, programs, X drafts, your other agents." stack>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="small" onClick={() => void attempt(() => POST('/hermes/add-bridge'), 'Hermes now has the dashboard tools (restart Hermes sessions to see them)')}>Give Hermes the dashboard tools</Button>
            <Button size="small" onClick={() => void attempt(() => POST<{ message: string }>('/pi/add-bridge'), (r) => r.message)}>Give pi and oh-my-pi the dashboard tools</Button>
            {/* (the page is shown the config without its token: the copy gets the real one) */}
            <Button variant="ghost" size="small" onClick={() => void attempt(() => POST<McpData['bridge']>('/mcp-bridge')).then((b) => b && copy(JSON.stringify({ mcpServers: { dashboard: b } }, null, 2)))}>Copy MCP config for other apps</Button>
          </div>
        </Row>
        <div className="px-5 py-4">
          <details>
            <summary className="label cursor-pointer">Show config</summary>
            <pre>{bridgeJson}</pre>
            <p className="hint">The token is hidden here; Copy puts the real one in. Paste into Claude Desktop, Cursor, or any MCP client. They act as "External MCP client": everything except shell, and they ask you first. The dashboard must be running.</p>
          </details>
        </div>
        <PanelNote>pi and oh-my-pi keep it in their own mcp.json (pi needs version 0.99 or newer); an agent's first run on either adds it there. Their agents here then use the dashboard tools as themselves; when you run pi on your own, it acts as "External MCP client".</PanelNote>
      </Section>

      <Section title={`Built-in tools (${tools.tools.length})`} description="What agents can do without an MCP server.">
        {tools.groups.map((g) => (
          <div key={g.id} className="px-5 py-4">
            <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
              <b>{g.label}</b>
              <span className="hint">{g.description}</span>
            </div>
            <div className={`${CHIPS_CLASS} mt-3`}>
              {tools.tools
                .filter((t) => t.group === g.id)
                .map((t) => (
                  <span key={t.name} className={chipClass(false, 'mcp-tool cursor-help')} title={t.description}>
                    {t.name}
                    {t.risk === 'high' ? <span className="text-amber"> ●</span> : t.risk === 'low' ? <span className="text-faint"> ●</span> : t.risk === 'varies' ? <span className="text-faint"> ◐</span> : null}
                  </span>
                ))}
            </div>
          </div>
        ))}
        <PanelNote>
          <span className="text-amber">●</span> asks you unless the agent is on Full · <span className="text-faint">●</span> asks only agents on "Ask first" · <span className="text-faint">◐</span> depends on what it is asked to do · none: never asks
        </PanelNote>
      </Section>
    </div>
  );
}

/** A ready-made server's service for people ("OOMOL"), as the server names it (an older one doesn't: its title). */
const serviceOf = (p: McpPresetListing) => p.service || p.title;

function ServerRow({ name, cfg, info, onEdit, reload }: { name: string; cfg: McpServerConfig; info?: McpServerInfo; onEdit: () => void; reload: () => Promise<unknown> }) {
  // the last test: running, its tools, or why it did not start
  const [test, setTest] = useState<'running' | { failed: string } | string[] | null>(null);
  const run = async () => {
    setTest('running');
    try {
      const r = await POST<{ tools: { name: string; description: string }[] }>(`/mcp/${encodeURIComponent(name)}/test`);
      setTest(r.tools.map((t) => t.name));
    } catch (e) {
      setTest({ failed: e instanceof Error ? e.message : String(e) });
    }
  };
  // the error, and apart from it what the server printed (server/mcp.ts OUTPUT_MARK)
  const failed = test && !Array.isArray(test) && typeof test === 'object' ? test.failed.split(OUTPUT_MARK) : null;
  const remove = async () => {
    if (await confirmBox(`Remove ${info?.title || name}?`, { ok: 'Remove', danger: true })) await attempt(() => DEL(`/mcp/${encodeURIComponent(name)}`)).then(reload);
  };
  const copies = (info?.copies || 1) > 1;
  return (
    <div className="mcp-server px-5 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="title flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
            {info?.title || name}
            {info && info.title !== name ? <span className="hint font-mono text-[11px]">{name}</span> : null}
            {copies ? <Pill tone="info" title={`${info!.service} is added ${info!.copies} times, one per account`}>{`${info!.service} account`}</Pill> : null}
          </div>
          <div className="hint font-mono text-[11.5px] wrap-anywhere">{cfg.type === 'stdio' ? `${cfg.command} ${(cfg.args || []).join(' ')}` : cfg.url}</div>
          {cfg.useFor ? <div className="hint mcp-use-for">{`Use for: ${cfg.useFor}`}</div> : copies ? <div className="hint mcp-use-for text-amber">{`No "use for" yet: an agent with several ${info!.service} accounts can't tell this one apart. Edit it to say what it is for.`}</div> : null}
          {cfg.description && !copies ? <div className="hint">{cfg.description}</div> : null}
        </div>
        <Button variant="ghost" size="tiny" disabled={test === 'running'} onClick={() => void run()}>Test</Button>
        <Button variant="ghost" size="tiny" onClick={onEdit}>Edit</Button>
        <Button variant="danger" size="tiny" onClick={() => void remove()}>Remove</Button>
      </div>
      <div aria-live="polite">
        {test === 'running' ? <p className="hint">Starting it and listing tools… (first run of npx/uvx servers can take a minute)</p> : null}
        {failed ? (
          <div className="mcp-test-failed mt-2">
            <p className="hint m-0 text-red wrap-anywhere">{failed[0]}</p>
            {failed[1] ? (
              <>
                <div className="hint mt-2">What it printed:</div>
                <pre className="mcp-output mt-1 max-h-60 overflow-auto font-mono text-[11px] whitespace-pre-wrap wrap-anywhere">{failed.slice(1).join(OUTPUT_MARK)}</pre>
              </>
            ) : null}
            {cfg.type === 'stdio' ? <p className="hint mt-2">Check the command, and that it runs in a terminal (for npx or uvx, that npx or uvx works there).</p> : null}
          </div>
        ) : null}
        {Array.isArray(test) ? (
          <div className="mt-3.5">
            <Pill tone="ok">{`${test.length} tools`}</Pill>
            <div className="hint mcp-tools mt-1.5 font-mono text-[11px]">{test.join(' · ')}</div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

const BLANK: McpServerConfig = { type: 'stdio', command: 'npx', args: [], env: {}, url: '', headers: {} };

function ServerForm({ name = '', cfg = BLANK, kind, services = [], close, saved }: { name?: string; cfg?: McpServerConfig; kind?: string; services?: (readonly [string, string])[]; close: () => void; saved: () => void }) {
  const [newName, setNewName] = useState(name);
  // the service it is, as the server worked it out ('' = its own)
  const [c, setC] = useState<McpServerConfig>(() => {
    const k = cfg.kind || kind;
    return { ...structuredClone(cfg), kind: k && k !== name ? k : '' };
  });
  // "Its own service" picked: saved as its own name, so a server that looks like a ready-made one stays apart.
  // A new server left alone has its service worked out.
  const [ownPicked, setOwnPicked] = useState(!!name);
  // the text boxes as typed (turned into lists and maps when saved)
  const [args, setArgs] = useState(() => joinArgs(cfg.args || []));
  const [env, setEnv] = useState(Object.entries(cfg.env || {}).map(([k, v]) => `${k}=${v}`).join('\n'));
  const [headers, setHeaders] = useState(Object.entries(cfg.headers || {}).map(([k, v]) => `${k}: ${v}`).join('\n'));
  const save = async () => {
    const body = { name: newName, ...c, kind: c.kind || (ownPicked ? newName : ''), args: args === joinArgs(cfg.args || []) ? cfg.args || [] : splitArgs(args), env: parseKv(env), headers: parseHeaders(headers) };
    if (await attempt(() => POST('/mcp', body), 'Saved')) {
      close();
      saved();
    }
  };
  return (
    <>
      <div className="modal-body">
        <div className="flex flex-col gap-5">
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
          <div className="flex flex-col gap-5">
            {c.type === 'stdio' ? (
              <>
                <Field label="Command">
                  <input className="code" value={c.command} placeholder="npx, uvx, node, python, or a full path" onChange={(e) => setC({ ...c, command: e.target.value })} />
                </Field>
                <Field label="Arguments" hint='Separated by spaces. Put one with a space in "double quotes".'>
                  <input className="code" value={args} placeholder="-y @playwright/mcp@latest" onChange={(e) => setArgs(e.target.value)} />
                </Field>
                <Field label="Environment" hint="One KEY=value per line. Saved keys show as dots; leave them to keep them.">
                  <textarea className="code" rows={3} value={env} placeholder="API_KEY=…" onChange={(e) => setEnv(e.target.value)} />
                </Field>
              </>
            ) : (
              <>
                <Field label="URL">
                  <input className="code" value={c.url} placeholder="https://…/mcp" onChange={(e) => setC({ ...c, url: e.target.value })} />
                </Field>
                <Field label="Headers" hint="Saved values show as dots; leave them to keep them.">
                  <textarea className="code" rows={3} value={headers} placeholder="Authorization: Bearer …" onChange={(e) => setHeaders(e.target.value)} />
                </Field>
              </>
            )}
            <Field label="Description">
              <input value={c.description || ''} onChange={(e) => setC({ ...c, description: e.target.value })} />
            </Field>
            <Field label="Same service as" hint="Pick one when this is another account of a service you already have (a second OOMOL or Gmail), so agents and the Brain treat them as accounts of one service.">
              <SelectControl aria-label="Same service as" value={c.kind || ''} onChange={(value) => (setOwnPicked(true), setC({ ...c, kind: value }))} options={[{ value: '', label: 'Its own service' }, ...services.filter(([k]) => k !== (name || newName)).map(([value, label]) => ({ value, label }))]} />
            </Field>
            <CopyFields label={c.label || ''} useFor={c.useFor || ''} onChange={(v) => setC({ ...c, ...v })} />
          </div>
        </div>
      </div>
      <div className="modal-foot">
        <Button variant="ghost" onClick={close}>Cancel</Button>
        <Button onClick={() => void save()}>Save</Button>
      </div>
    </>
  );
}

/** A copy's label and when to use it: how agents and the Brain tell the accounts of one service apart. */
function CopyFields({ label, useFor, onChange }: { label: string; useFor: string; onChange: (v: { label?: string; useFor?: string }) => void }) {
  return (
    <>
      <Field label="Label">
        <input value={label} placeholder="e.g. Work, Personal, Client A" onChange={(e) => onChange({ label: e.target.value })} />
      </Field>
      <Field label="Use this one for" hint="Agents and the Brain pick between accounts of one service by this line.">
        <textarea rows={2} value={useFor} placeholder="e.g. Work email and calendar for acme.com: clients, sales, anything sent as the company" onChange={(e) => onChange({ useFor: e.target.value })} />
      </Field>
    </>
  );
}

/** Another account of a ready-made server: its label and "use for", and those of the ones already added. */
function CopyForm({ preset, servers, close, saved }: { preset: McpPresetListing; servers: Record<string, McpServerConfig>; close: () => void; saved: () => void }) {
  const copies = (preset.copies || []).filter((n) => servers[n]);
  const [mine, setMine] = useState({ label: '', useFor: '' });
  const [others, setOthers] = useState<Record<string, { label: string; useFor: string }>>(() => Object.fromEntries(copies.map((n) => [n, { label: servers[n].label || '', useFor: servers[n].useFor || '' }])));
  const save = async () => {
    // only the ones whose label or "use for" changed
    const changed = Object.fromEntries(Object.entries(others).filter(([n, v]) => v.label !== (servers[n].label || '') || v.useFor !== (servers[n].useFor || '')));
    const r = await attempt(() => POST<{ name: string }>('/mcp-preset', { name: preset.name, ...mine, others: changed }), (r) => `Added ${r.name}${needsKey(preset) ? '. Put its own key in it: Edit it above.' : ''}`);
    if (r) {
      close();
      saved();
    }
  };
  return (
    <>
      <div className="modal-body">
        <div className="flex flex-col gap-5">
          <p className="hint">{`A second ${serviceOf(preset)} with its own keys, for another account. Give each one a label and say what it is for: an agent or team can have one account or several, and picks by these lines.`}</p>
          <div className="label">The new one</div>
          <CopyFields label={mine.label} useFor={mine.useFor} onChange={(v) => setMine({ ...mine, ...v })} />
          {copies.map((n) => (
            <div key={n} className="flex flex-col gap-5">
              <div className="label mt-3.5">{`The one you have: ${n}`}</div>
              <CopyFields label={others[n].label} useFor={others[n].useFor} onChange={(v) => setOthers({ ...others, [n]: { ...others[n], ...v } })} />
            </div>
          ))}
        </div>
      </div>
      <div className="modal-foot">
        <Button variant="ghost" onClick={close}>Cancel</Button>
        <Button disabled={!mine.label.trim()} onClick={() => void save()}>Add</Button>
      </div>
    </>
  );
}

export const title = () => 'MCP servers';
export const { render, unmount } = reactPage(() => <McpTab />);
