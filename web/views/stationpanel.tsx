// The Station's side panel: what you clicked on the map (the Brain, a team, an agent, the Bench or a
// connection), with what you can do there. React; the map (station.ts) owns the panel's element, slides
// it in and out, and tells it to draw again (update()) when what it shows may have changed.
import { StrictMode, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { GET, POST, PUT, DEL, attempt, navigate, approvalCard, ago, toast, promptBox, confirmBox, refreshSoon } from '../core.ts';
import { openTerminal } from './agents.tsx';
import { openBranchBuilder } from '../builder.ts';
import { openDock } from '../dock.tsx';
import { openChat } from '../chatwin.tsx';
import { skillPicker } from '../skillpick.ts';
import { historyButton } from '../history.ts';
import { projectMark, pickLogo, removeLogo, pickModel, removeModel } from '../projectlogo.ts';
import { pickTeamMark, EMOJI_CHOICES, DEFAULT_TEAM_MARK } from '../teammark.ts';
import { icon, logo } from '../icons.ts';
import { modelChip, modelInfo } from '../models.ts';
import { Avatar, DomNode, Icon, useAppState } from '../ui/react.tsx';
import { ChipSet, Segmented, Tabs } from '../ui/controls.tsx';
import { wfColor, appLogo, mark, intInfo, availableIntegrations, agentLinks, connectorLook } from './stationdata.ts';
import type { AvailableIntegration, Connector, MapPick, Program, TeamView } from './stationdata.ts';
import type { Agent, AppState, Project, Team, TeamAccess, TeamState } from '../../shared/types.ts';

/** What the panel needs from the map. */
export interface StationPanelApi {
  selected(): MapPick | null;
  teams(): TeamView[];
  teamState(id: string): TeamState;
  /** a team's old-style workflow run is going */
  teamBusy(id: string): boolean;
  /** how many of those are going */
  busyTeams(): number;
  programs(): Program[];
  /** the connections a team's desks reach on the map */
  teamLinks(id: string): Set<string>;
  /** what an agent is doing right now, in words ("Blender · rendering the scene") */
  now(agentId: string, wfId?: string): { st: 'needs' | 'idle' | 'working'; text: string };
  /** the connectors on your Claude account */
  connectors(): Connector[];
  choose(p: MapPick | null): void;
  saveTeam(wf: TeamView): Promise<Team | undefined>;
  reloadTeams(): Promise<void>;
  /** turn a team 45° on the map and keep it there */
  spinTeam(id: string): Promise<void>;
  zoomToTeam(id: string): void;
  /** the team builder, for a new team */
  newTeam(): void;
}

/** GET /api/brain: a look inside the Brain folder. */
interface BrainInfo {
  project: Project;
  entries: { name: string; dir: boolean; path: string }[];
  files: number;
  sizeMB: number;
  git: { branch: string; remote: string; url: string; last: string; changes: number } | null;
  /** the description, or the first paragraph of PROJECT.md / README.md */
  summary?: { text: string; from: 'description' | 'PROJECT.md' | 'README.md' | null };
}

/** Draws the panel into el (the map's panel element). update() draws it again. */
export function mountStationPanel(el: HTMLElement, api: StationPanelApi): { update: () => void; unmount: () => void } {
  let version = 0;
  const listeners = new Set<() => void>();
  const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));
  const root = createRoot(el);
  root.render(
    <StrictMode>
      <Panel api={api} subscribe={subscribe} version={() => version} />
    </StrictMode>,
  );
  return {
    update: () => {
      version++;
      for (const l of listeners) l();
    },
    unmount: () => root.unmount(),
  };
}

function Panel({ api, subscribe, version }: { api: StationPanelApi; subscribe: (l: () => void) => () => void; version: () => number }) {
  useSyncExternalStore(subscribe, version);
  const d = useAppState();
  const p = api.selected();
  if (!p || !d) return null;
  if (p.type === 'agent') return <AgentPanel key={`a:${p.id}`} api={api} d={d} id={p.id} wfId={p.wf} />;
  if (p.type === 'branch') return <TeamPanel key={`t:${p.id}`} api={api} d={d} id={p.id} />;
  if (p.type === 'bench') return <BenchPanel api={api} d={d} />;
  if (p.type === 'brain') return <BrainPanel key={d.project?.id || ''} api={api} d={d} />;
  if (p.type === 'int') return <ConnectionPanel key={`c:${p.id}`} api={api} d={d} id={p.id} />;
  return null;
}

function PanelHead({ api, children }: { api: StationPanelApi; children: ReactNode }) {
  return (
    <div className="st-panel-head">
      {children}
      <button className="icon-btn" onClick={() => api.choose(null)} aria-label="Close">
        ✕
      </button>
    </div>
  );
}

/** A connection's logo, or its glyph. */
function Mark({ id, size }: { id: string; size: number }) {
  return <DomNode as="span" className="dom-contents" make={() => toNode(mark(id, size))} deps={[id, size]} />;
}
const toNode = (x: Node | string): Node => (typeof x === 'string' ? document.createTextNode(x) : x);
const badgeStyle = (color: string) => ({ '--c': color }) as CSSProperties;

/** The connections in ids, each with whether it is set up and running. */
function ConnectionList({ api, d, ids }: { api: StationPanelApi; d: AppState; ids: Set<string> }) {
  if (!ids.size) return <p className="hint">No outside connections. It works from its instructions and knowledge.</p>;
  const avail = new Map(availableIntegrations(d, api.programs()).map((i) => [i.id, i]));
  return (
    <div className="st-conns">
      {[...ids].map((id) => {
        const info = intInfo(id);
        if (!info) return null;
        const a = avail.get(id);
        return (
          <button key={id} className={`st-conn ${!a ? 'missing' : a.live ? 'ok' : 'off'}`} onClick={() => api.choose({ type: 'int', id })}>
            <span className="st-badge" style={badgeStyle(info.color)}>
              <Mark id={id} size={12} />
            </span>
            <span className="grow">{info.label}</span>
            <span className="st-conn-st">{!a ? 'not set up' : a.live ? 'ready' : 'not running'}</span>
          </button>
        );
      })}
    </div>
  );
}

/** A list row you can click (an agent or a team). */
function Pick({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <div
      className="list-item"
      style={{ cursor: 'pointer' }}
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onClick())}
    >
      {children}
    </div>
  );
}

function Approvals({ list }: { list: AppState['approvals'] }) {
  return (
    <>
      {list.map((x) => (
        <DomNode key={x.id} className="mt" make={() => approvalCard(x)} deps={[JSON.stringify(x)]} />
      ))}
    </>
  );
}

/** Runs fn when the field's value is committed (left, or Enter in a one-line field), like the 'change' event. */
function committed<T extends HTMLInputElement | HTMLTextAreaElement>(fn: (el: T) => void) {
  return (el: T | null) => {
    if (!el) return;
    const on = () => fn(el);
    el.addEventListener('change', on);
    return () => el.removeEventListener('change', on);
  };
}

// ---------- the Bench ----------
function BenchPanel({ api, d }: { api: StationPanelApi; d: AppState }) {
  const used = new Set(api.teams().flatMap((w) => w.members || []));
  const bench = d.agents.filter((a) => !used.has(a.id));
  const newAgent = async () => {
    const a = await attempt(() => POST<Agent>('/agents', { name: 'New agent' }));
    if (a) navigate(`#/agents/${a.id}/edit`);
  };
  return (
    <>
      <PanelHead api={api}>
        <div className="grow">
          <div className="label">Bench</div>
          <div className="st-panel-title">{`${bench.length} agents not on a team`}</div>
        </div>
      </PanelHead>
      <div className="st-panel-body">
        <p className="hint">Agents not in a team yet. Drag one onto a team on the map, or open it and add it to a team.</p>
        <div className="list">
          {bench.map((a) => (
            <Pick key={a.id} onClick={() => api.choose({ type: 'agent', id: a.id })}>
              <Avatar agent={a} />
              <div className="grow">
                <div className="title">{a.name}</div>
                <div className="hint">{a.specialty || ''}</div>
              </div>
            </Pick>
          ))}
        </div>
        <div className="row mt">
          <a className="btn ghost small" href="#/library">
            Hire more
          </a>
          <button className="btn ghost small" onClick={() => void newAgent()}>
            + New agent
          </button>
        </div>
      </div>
    </>
  );
}

// ---------- the Brain ----------
function BrainPanel({ api, d }: { api: StationPanelApi; d: AppState }) {
  const proj: Partial<Project> = d.project || {};
  const [info, setInfo] = useState<BrainInfo | null>(null);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let alive = true;
    GET<BrainInfo>('/brain')
      .then((bi) => alive && (setInfo(bi), setError('')))
      .catch((e: Error) => alive && setError(e.message));
    return () => void (alive = false);
  }, [reload]);
  const teams = api.teams();
  const addNote = async () => {
    const name = await promptBox('New note in the Brain', { value: 'note.md' });
    if (!name) return;
    const content = await promptBox(name, { multiline: true, placeholder: 'Anything the agents should know about this project.' });
    if (content == null) return;
    await attempt(() => POST('/brain/note', { name, content }), 'Saved to notes/');
    setReload((n) => n + 1);
  };
  return (
    <>
      <PanelHead api={api}>
        {proj.logoAt ? (
          <DomNode as="span" className="st-proj-logo" make={() => projectMark(proj as Project, 34)} deps={[proj.id, proj.logoAt]} />
        ) : (
          <span className="st-badge lg" style={badgeStyle('#c4ff3d')}>
            <Icon name="brain" size={18} />
          </span>
        )}
        <div className="grow">
          <div className="label">Project Brain</div>
          <div className="st-panel-title">{proj.name || 'Project'}</div>
        </div>
      </PanelHead>
      <div className="st-panel-body">
        <About proj={proj} summary={proj.description ? { text: proj.description, from: 'description' } : info?.summary?.text ? info.summary : null} />
        <div className="st-mini-stats">
          <div>
            <b>{d.agents.length}</b>agents
          </div>
          <div>
            <b>{teams.length}</b>teams
          </div>
          <div>
            <b>{d.runs.length + api.busyTeams()}</b>working
          </div>
        </div>
        <button className="btn small st-ask-brain" onClick={() => openDock()}>
          <Icon name="sparkles" size={14} />
          Ask the Brain
        </button>
        <div className="label mt-lg">Brain folder</div>
        <div className="hint mono" style={{ overflowWrap: 'anywhere', marginTop: '6px' }}>
          {proj.brainPath || ''}
        </div>
        <div className="row mt" style={{ gap: '6px' }}>
          <button className="btn ghost small" onClick={() => void attempt(() => POST('/brain/open', {}))}>
            <Icon name="folder" size={14} />
            Open folder
          </button>
          <button className="btn ghost small" onClick={() => void attempt(() => POST('/brain/open', { app: 'vscode' }))}>
            <Icon name="external-link" size={14} />
            VS Code
          </button>
          <button className="btn ghost small" onClick={() => void addNote()}>
            <Icon name="pen-line" size={14} />
            Add note
          </button>
        </div>
        <div>
          {error ? (
            <p className="red hint">{error}</p>
          ) : !info ? (
            <p className="hint">Reading the Brain folder…</p>
          ) : (
            <>
              {info.git ? (
                <div className="st-conn ok mt">
                  <DomNode as="span" className="dom-contents" make={() => logo('github', 16) || icon('git-branch', 16)} deps={[]} />
                  <div className="grow">
                    <div>
                      {info.git.url ? (
                        <a href={info.git.url} target="_blank" rel="noreferrer">
                          {info.git.url.replace('https://github.com/', '')}
                        </a>
                      ) : (
                        'Local git repo'
                      )}
                    </div>
                    <div className="hint">{`${info.git.branch} · ${info.git.last}${info.git.changes ? ` · ${info.git.changes} changed` : ''}`}</div>
                  </div>
                  <button className="btn tiny ghost" onClick={() => void attempt(() => POST<{ message: string }>('/brain/pull'), (r) => r.message)}>
                    Pull
                  </button>
                </div>
              ) : null}
              <div className="hint mt">{`${info.files} files · ${info.sizeMB} MB`}</div>
              <div className="st-files">
                {info.entries.map((e) => (
                  <div key={e.path || e.name} className="st-file">
                    <Icon name={e.dir ? 'folder' : 'pen-line'} size={13} />
                    {e.name}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
        <div className="label mt-lg">Teams</div>
        <div className="list">
          {teams.map((wf, i) => (
            <Pick key={wf.id} onClick={() => api.choose({ type: 'branch', id: wf.id })}>
              <span className="st-dot" style={badgeStyle(wfColor(wf, i))} />
              <div className="grow">
                <div className="title">{wf.name}</div>
                <div className="hint">{wf.description || `${(wf.members || []).length} members`}</div>
              </div>
              {api.teamBusy(wf.id) ? <span className="dot busy" /> : null}
            </Pick>
          ))}
          {!teams.length ? <p className="empty">No teams yet.</p> : null}
        </div>
        {d.approvals.length ? (
          <>
            <div className="label mt-lg">Needs you</div>
            <div className="col">
              {d.approvals.map((x) => (
                <DomNode key={x.id} make={() => approvalCard(x)} deps={[JSON.stringify(x)]} />
              ))}
            </div>
          </>
        ) : null}
        <div className="row mt-lg">
          <button className="btn ghost small" onClick={api.newTeam}>
            <Icon name="git-branch" size={14} />
            New team
          </button>
        </div>
      </div>
    </>
  );
}

// What the project is about, and its logo (shown here, on the start screen, in the project menu and in the globe).
function About({ proj, summary }: { proj: Partial<Project>; summary: { text: string; from: string | null } | null }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const text = summary?.text || '';
  const ref = proj.id ? { id: proj.id, name: proj.name || '' } : null;
  const edit = () => {
    setDraft(proj.description || text);
    setEditing(true);
  };
  const save = async () => {
    if (!proj.id) return;
    if (await attempt(() => PUT<Project>(`/projects/${proj.id}`, { description: draft }), 'Saved')) {
      refreshSoon(0);
      setEditing(false);
    }
  };
  const rename = async () => {
    const name = (await promptBox('Rename project', { value: proj.name || '' }))?.trim();
    if (!name || name === proj.name || !proj.id) return;
    if (await attempt(() => PUT(`/projects/${encodeURIComponent(proj.id!)}`, { name }), `Renamed to ${name}`)) refreshSoon(0);
  };
  return (
    <div className="st-about">
      <div className="st-about-top">
        <button type="button" className="st-about-logo" title={proj.logoAt ? 'Change the logo' : 'Add a logo'} onClick={() => ref && void pickLogo(ref)}>
          {proj.logoAt ? (
            <DomNode as="span" className="dom-contents" make={() => projectMark(proj as Project, 64)} deps={[proj.id, proj.logoAt]} />
          ) : (
            <span className="st-about-add">
              <Icon name="image" size={20} />
              Logo
            </span>
          )}
        </button>
        <div className="grow">
          {editing ? (
            <div className="col">
              <textarea rows={4} autoFocus aria-label="What this project is about" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="What is this project? Who is it for, what should come out of it?" />
              <div className="row" style={{ gap: '6px' }}>
                <button className="btn small" onClick={() => void save()}>
                  Save
                </button>
                <button className="btn ghost small" onClick={() => setEditing(false)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : text ? (
            <>
              <p className="st-about-text">{text}</p>
              {summary?.from && summary.from !== 'description' ? <div className="hint">{`from ${summary.from}`}</div> : null}
            </>
          ) : (
            <p className="hint">No description yet. Say what the project is about, or ask the Brain to write PROJECT.md.</p>
          )}
        </div>
      </div>
      {editing ? null : (
        <div className="row st-about-actions">
          <button className="btn ghost tiny" onClick={edit}>
            <Icon name="pencil" size={12} />
            {text ? 'Edit description' : 'Add a description'}
          </button>
          <button className="btn ghost tiny" title="Change the name of this project (its folder keeps its name)" onClick={() => void rename()}>
            <Icon name="pencil" size={12} />
            Rename
          </button>
          <button className="btn ghost tiny" onClick={() => ref && void pickLogo(ref)}>
            <Icon name="image" size={12} />
            {proj.logoAt ? 'Change logo' : 'Add logo'}
          </button>
          {proj.logoAt ? (
            <button className="btn ghost tiny" onClick={() => ref && void removeLogo(ref)}>
              Remove logo
            </button>
          ) : null}
          <button className="btn ghost tiny" title="A 3D model (.glb, .obj, .stl, .ply, .fbx) that replaces the logo inside the Brain" onClick={() => ref && void pickModel(ref)}>
            <Icon name="box" size={12} />
            {proj.modelAt ? 'Change 3D model' : 'Add 3D model'}
          </button>
          {proj.modelAt ? (
            <button className="btn ghost tiny" onClick={() => ref && void removeModel(ref)}>
              Remove 3D model
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}

// ---------- a connection (a service, a program, an MCP server) ----------
function ConnectionPanel({ api, d, id }: { api: StationPanelApi; d: AppState; id: string }) {
  const teams = api.teams();
  const it = availableIntegrations(d, api.programs()).find((x) => x.id === id) || ({ ...intInfo(id), live: false, missing: true } as AvailableIntegration);
  // (gone: a removed MCP server, say)
  useEffect(() => {
    if (!it?.label) api.choose(null);
  });
  if (!it?.label) return null;
  // A team's own access reaches every member, so count those agents too (same rule as stepLinks).
  const viaTeam = new Set(teams.filter((w) => w.access && agentLinks({ toolGroups: w.access.toolGroups, mcpServers: w.access.mcpServers }).has(it.id)).flatMap((w) => w.members));
  const agentsUsing = d.agents.filter((a) => agentLinks(a).has(it.id) || viaTeam.has(a.id));
  const teamsUsing = teams.filter((w) => api.teamLinks(w.id).has(it.id));
  const prog = it.program;
  const status = it.missing ? 'not set up' : it.live ? (prog?.serviceUrl ? `running · ${prog.serviceUrl}` : prog && !prog.cli ? 'running' : 'ready') : 'installed, not running';
  return (
    <>
      <PanelHead api={api}>
        <span className="st-badge lg" style={badgeStyle(it.color)}>
          <Mark id={it.id} size={18} />
        </span>
        <div className="grow">
          <div className="label">{it.mcp ? 'MCP server' : prog ? 'Program' : 'Service'}</div>
          <div className="st-panel-title">{it.label}</div>
        </div>
      </PanelHead>
      <div className="st-panel-body">
        <p>
          <span className={`pill ${it.live ? 'ok' : it.missing ? 'bad' : ''}`}>{status}</span>
          {prog?.version ? <span className="hint">{` v${prog.version}`}</span> : null}
        </p>
        <div className="label mt">{`Teams using it (${teamsUsing.length})`}</div>
        <div className="list">
          {teamsUsing.map((w) => (
            <Pick key={w.id} onClick={() => api.choose({ type: 'branch', id: w.id })}>
              <div className="grow">{w.name}</div>
            </Pick>
          ))}
        </div>
        <div className="label mt">{`Agents with access (${agentsUsing.length})`}</div>
        <div className="list">
          {agentsUsing.map((a) => (
            <Pick key={a.id} onClick={() => api.choose({ type: 'agent', id: a.id })}>
              <Avatar agent={a} />
              <div className="grow">{a.name}</div>
            </Pick>
          ))}
        </div>
        <div className="row mt">
          {prog && !prog.cli && (prog.exe || prog.shortcut) ? (
            <button className="btn small" onClick={() => void attempt(() => POST<{ message: string }>('/programs/launch', { program: prog.id }), (r) => r.message)}>
              Start
            </button>
          ) : null}
          {prog?.serviceUrl ? (
            <a className="btn ghost small" href={prog.serviceUrl} target="_blank" rel="noreferrer">
              Open
            </a>
          ) : null}
          {['x', 'telegram', 'discord'].includes(it.id) ? (
            <a className="btn ghost small" href="#/settings?tab=connections">
              Connections
            </a>
          ) : null}
          {it.mcp ? (
            <a className="btn ghost small" href="#/settings?tab=mcp">
              Tools &amp; MCP
            </a>
          ) : null}
          {['openrouter', 'lmstudio', 'ollama'].includes(it.id) ? (
            <a className="btn ghost small" href="#/settings">
              Settings
            </a>
          ) : null}
        </div>
      </div>
    </>
  );
}

// ---------- a team ----------
// Team panel: the goal, members and lead, what it can reach, its routine, and the team chat.
const withMembers = (wf: TeamView, members: string[]): TeamView => ({
  ...wf,
  members,
  steps: members.map((id) => ({ type: 'agent' as const, agentId: id })),
  lead: wf.lead && !members.includes(wf.lead) ? null : wf.lead,
});
const presetAgent = (a: Agent) => attempt(() => POST(`/presets/agent/${a.id}`), `Saved ${a.name} as a preset (Library › Your presets)`);
const presetTeam = (w: TeamView) => attempt(() => POST(`/presets/team/${w.id}`), `Saved ${w.name} and its agents as a preset (Library › Your presets)`);

// (the tab you were on stays open when you pick another team)
type TeamTab = 'members' | 'setup';
let lastTab: TeamTab = 'members';

function TeamPanel({ api, d, id }: { api: StationPanelApi; d: AppState; id: string }) {
  const [tab, setTabState] = useState<TeamTab>(lastTab);
  const setTab = (t: TeamTab) => setTabState((lastTab = t));
  const teams = api.teams();
  const wf = teams.find((w) => w.id === id);
  useEffect(() => {
    if (!wf) api.choose(null);
  });
  if (!wf) return null;
  const c = wfColor(wf, teams.indexOf(wf));
  const byId = new Map(d.agents.map((a) => [a.id, a]));
  const ts = api.teamState(id);
  const members = wf.members.map((mid) => byId.get(mid)).filter((a): a is Agent => !!a);
  const nameOf = (mid: string) => (mid === 'brain' ? 'Brain' : byId.get(mid)?.name || 'Agent');
  const mention = (a: Agent) => openChat('team', id).mention?.(a.name);
  return (
    <>
      <PanelHead api={api}>
        <span className="st-dot" style={badgeStyle(c)} />
        <div className="grow">
          <div className="label">Team · group chat</div>
          <div className="st-panel-title">{wf.name}</div>
          <div className="st-team-status">
            {ts.working.length ? (
              <span className="st-team-live">
                <span className="dot busy" />
                {`${ts.working.map(nameOf).join(', ')} working${ts.queued.length ? ` · ${ts.queued.length} waiting` : ''}`}
              </span>
            ) : (
              <span className="hint">{members.length ? 'Quiet · waiting for a message' : 'No members yet'}</span>
            )}
          </div>
        </div>
      </PanelHead>
      <div className="st-panel-body">
        {wf.description ? <p className="st-team-goal">{wf.description}</p> : null}
        {/* faces of everyone on the team: who's working pulses, the lead has a star */}
        <div className="st-team-faces">
          {members.map((a) => (
            <button key={a.id} className={`st-face${ts.working.includes(a.id) ? ' working' : ''}`} title={`${a.name}${wf.lead === a.id ? ' · lead' : ''}${ts.working.includes(a.id) ? ' · working' : ''}`} onClick={() => mention(a)}>
              <Avatar agent={a} />
              {wf.lead === a.id ? <span className="st-member-star">★</span> : null}
            </button>
          ))}
          <button className="st-face add" title="Add someone" aria-label="Add someone" onClick={() => setTab('members')}>
            <Icon name="user-plus" size={15} />
          </button>
        </div>
        <button className="btn small st-open-chat" onClick={() => openChat('team', id)}>
          <Icon name="message-square" size={14} />
          Open the team chat
        </button>
        <Tabs
          label="Team"
          rowClassName="st-tabs"
          panelClassName="st-tab-body"
          value={tab}
          onChange={setTab}
          tabs={[
            {
              value: 'members',
              label: (
                <>
                  Members<span className="st-tab-n">{members.length}</span>
                </>
              ),
            },
            { value: 'setup', label: 'Setup' },
          ]}
        >
          {tab === 'setup' ? <TeamSetup api={api} d={d} wf={wf} color={c} /> : <TeamMembers api={api} d={d} wf={wf} members={members} ts={ts} mention={mention} />}
        </Tabs>
      </div>
    </>
  );
}

function TeamMembers({ api, d, wf, members, ts, mention }: { api: StationPanelApi; d: AppState; wf: TeamView; members: Agent[]; ts: TeamState; mention: (a: Agent) => void }) {
  const id = wf.id;
  const others = d.agents.filter((a) => !wf.members.includes(a.id));
  const [pick, setPick] = useState('');
  const addId = others.some((a) => a.id === pick) ? pick : others[0]?.id || '';
  return (
    <>
      <p className="hint">Everyone sees the whole chat. Your messages go to the lead (★) first, or to whoever you @mention. Members hand work to each other with @Name.</p>
      <div className="st-members">
        {members.map((a) => {
          const isLead = wf.lead === a.id;
          const now = api.now(a.id, id);
          const st = ts.working.includes(a.id) ? 'working' : ts.queued.includes(a.id) ? 'queued' : now.st;
          return (
            <div key={a.id} className={`st-member ${st}`}>
              <div className="st-member-av">
                <Avatar agent={a} />
                {isLead ? (
                  <span className="st-member-star" title="Team lead">
                    ★
                  </span>
                ) : null}
              </div>
              <div className="grow">
                <div className="st-member-name" role="button" tabIndex={0} onClick={() => api.choose({ type: 'agent', id: a.id, wf: id })} onKeyDown={(e) => e.key === 'Enter' && api.choose({ type: 'agent', id: a.id, wf: id })}>
                  {a.name}
                  {isLead ? <span className="tc-lead">lead</span> : null}
                </div>
                <div className="st-member-now">
                  {st === 'working' ? (
                    <>
                      <span className="dot busy" /> {now.text || 'Working…'}
                    </>
                  ) : st === 'queued' ? (
                    'Up next'
                  ) : st === 'needs' ? (
                    <>
                      <span className="dot warn" /> Waiting for your OK
                    </>
                  ) : (
                    a.specialty || 'Ready'
                  )}
                </div>
                <DomNode className="st-member-model" make={() => modelChip(a, { compact: true })} deps={[a]} />
              </div>
              <div className="st-member-actions">
                <button title={`Write to ${a.name} in the team chat`} aria-label={`Write to ${a.name} in the team chat`} onClick={() => mention(a)}>
                  @
                </button>
                <button title={isLead ? 'Remove as lead' : 'Make lead: your messages go to them first'} aria-label={isLead ? `Remove ${a.name} as lead` : `Make ${a.name} lead`} className={isLead ? 'on' : ''} onClick={() => void api.saveTeam({ ...wf, lead: isLead ? null : a.id })}>
                  ★
                </button>
                <button title="Take off this team (stays in the project)" aria-label={`Take ${a.name} off this team`} onClick={() => void api.saveTeam(withMembers(wf, wf.members.filter((x) => x !== a.id)))}>
                  ✕
                </button>
              </div>
            </div>
          );
        })}
        {!members.length ? <p className="empty">No agents yet. Add one below, hire from the Library, or ask the Brain.</p> : null}
      </div>
      <div className="label mt-lg">Add someone</div>
      {others.length ? (
        <div className="row nowrap mt">
          <div className="grow">
            <select aria-label="Agent to add" value={addId} onChange={(e) => setPick(e.target.value)}>
              {others.map((a) => (
                <option key={a.id} value={a.id}>{`${a.emoji || ''} ${a.name}`}</option>
              ))}
            </select>
          </div>
          <button className="btn small" onClick={() => addId && void api.saveTeam(withMembers(wf, [...wf.members, addId]))}>
            <Icon name="user-plus" size={14} />
            Add
          </button>
        </div>
      ) : (
        <p className="hint">Every agent in this project is already on it.</p>
      )}
      <div className="row mt" style={{ gap: '6px', flexWrap: 'wrap' }}>
        <button className="btn ghost small" onClick={() => navigate(`#/library?branch=${encodeURIComponent(id)}`)}>
          <Icon name="store" size={14} />
          Hire from the Library
        </button>
        <button className="btn ghost small" onClick={() => openDock('auto', `For the team "${wf.name}": add `)}>
          <Icon name="brain" size={14} />
          Ask the Brain
        </button>
      </div>
      <p className="hint mt">Tip: drag an agent onto this team on the map to add it (hold Ctrl to also keep it on its other team).</p>
    </>
  );
}

function TeamSetup({ api, d, wf, color }: { api: StationPanelApi; d: AppState; wf: TeamView; color: string }) {
  const id = wf.id;
  // the access chips change at once; the save waits until you stop clicking
  const [access, setAccess] = useState<TeamAccess>({ toolGroups: wf.access?.toolGroups || [], mcpServers: wf.access?.mcpServers || [] });
  const accessTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(wf);
  latest.current = wf;
  const saveAccess = (patch: Partial<TeamAccess>) => {
    const next = { ...access, ...patch };
    setAccess(next);
    if (accessTimer.current) clearTimeout(accessTimer.current);
    accessTimer.current = setTimeout(() => void api.saveTeam({ ...latest.current, access: next }), 500);
  };
  const sch = wf.schedule || { type: 'none' };
  const saveSchedule = (patch: Partial<NonNullable<TeamView['schedule']>>) => {
    const schedule = { ...sch, ...patch } as NonNullable<TeamView['schedule']>;
    void api.saveTeam({ ...wf, schedule, enabled: schedule.type !== 'none' });
  };
  const cloneTeam = async (withAgents: boolean) => {
    const c = await attempt(() => POST<Team>(`/workflows/${id}/clone`, { withAgents }), withAgents ? `Cloned ${wf.name} with copies of its agents` : `Cloned ${wf.name}`);
    if (!c) return;
    if (withAgents) refreshSoon(0);
    await api.reloadTeams();
    api.choose({ type: 'branch', id: c.id });
  };
  const remove = async () => {
    if (!(await confirmBox(`Delete the team "${wf.name}"? Its agents stay in the project, the team chat is removed.`, { ok: 'Delete', danger: true }))) return;
    await attempt(() => DEL(`/workflows/${id}`));
    api.choose(null);
    void api.reloadTeams();
  };
  return (
    <>
      <div className="label">Name and goal</div>
      <div className="row nowrap mt">
        <div className="grow">
          <input key={`n:${wf.name}`} aria-label="Team name" defaultValue={wf.name} ref={committed<HTMLInputElement>((el) => void api.saveTeam({ ...latest.current, name: el.value.trim() || latest.current.name }))} />
        </div>
        <input
          key={`c:${color}`}
          type="color"
          aria-label="Team colour"
          defaultValue={color}
          style={{ width: '40px', height: '34px', padding: '2px', background: 'var(--panel)', border: '1px solid var(--line-2)' }}
          ref={committed<HTMLInputElement>((el) => void api.saveTeam({ ...latest.current, color: el.value }))}
        />
      </div>
      <div className="mt">
        <textarea
          key={`d:${wf.description || ''}`}
          rows={3}
          aria-label="Team goal"
          defaultValue={wf.description || ''}
          placeholder="The team's goal, e.g. grow our X account with daily posts"
          ref={committed<HTMLTextAreaElement>((el) => void api.saveTeam({ ...latest.current, description: el.value.trim() }))}
        />
      </div>
      <p className="hint">Every member reads the goal before it answers in the chat.</p>
      <div className="label mt-lg">Team skills</div>
      <p className="hint">Every member gets these while it works for this team (on top of its own and the project's).</p>
      <DomNode
        className="mt"
        make={() => skillPicker(wf.skills || [], (v) => void api.saveTeam({ ...latest.current, skills: v }), { inherited: (d.project?.skills || []).map((slug) => ({ slug, from: 'project' })), empty: 'No team skills yet.' })}
        deps={[id, (wf.skills || []).join('|'), (d.project?.skills || []).join('|')]}
      />
      <div className="label mt-lg">Extra access while working for this team</div>
      <p className="hint">Members get these on top of their own tools.</p>
      <div className="mt">
        <ChipSet label="Extra tools" options={d.toolGroups.map((g) => ({ value: g.id, label: g.label, title: g.description }))} value={access.toolGroups} onChange={(v) => saveAccess({ toolGroups: v })} />
      </div>
      {(d.mcpServers || []).length ? (
        <div className="mt">
          <ChipSet label="Extra MCP servers" options={d.mcpServers.map((m) => ({ value: m, label: m }))} value={access.mcpServers} onChange={(v) => saveAccess({ mcpServers: v })} />
        </div>
      ) : null}
      <div className="label mt-lg">Connections the team can reach</div>
      <ConnectionList api={api} d={d} ids={api.teamLinks(id)} />
      <div className="label mt-lg">Daily routine</div>
      <p className="hint">The team gets this message on its schedule, as if you wrote it in the chat.</p>
      <div className="row" style={{ gap: '8px' }}>
        <Segmented
          label="Daily routine"
          options={[
            { value: 'none', label: 'Off' },
            { value: 'daily', label: 'Every day' },
          ]}
          value={sch.type === 'daily' ? 'daily' : 'none'}
          onChange={(t) => saveSchedule({ type: t })}
        />
        {sch.type === 'daily' ? <input key={`t:${sch.time}`} type="time" aria-label="Time" defaultValue={sch.time || '09:00'} style={{ width: '110px' }} ref={committed<HTMLInputElement>((el) => saveSchedule({ time: el.value }))} /> : null}
      </div>
      {sch.type === 'daily' ? (
        <div className="mt">
          <input key={`m:${sch.input || ''}`} aria-label="What the team should do each time" defaultValue={sch.input || ''} placeholder="What the team should do each time" ref={committed<HTMLInputElement>((el) => saveSchedule({ input: el.value }))} />
        </div>
      ) : null}
      <div className="label mt-lg">Symbol on the map</div>
      <p className="hint">Shown in the middle of the team's pod. An emoji, or a picture or 3D model of your own.</p>
      <SymbolPicker api={api} wf={wf} />
      <div className="label mt-lg">On the map</div>
      <p className="hint">Drag the team to move it anywhere. Shift+drag spins it.</p>
      <div className="row mt" style={{ gap: '6px', flexWrap: 'wrap' }}>
        <button className="btn ghost small" onClick={() => void api.spinTeam(id)}>
          <Icon name="rotate-cw" size={14} />
          Spin 45°
        </button>
        {wf.pos || wf.rot ? (
          <button className="btn ghost small" onClick={() => void api.saveTeam({ ...wf, pos: null, rot: null, angle: null })}>
            <Icon name="rotate-ccw" size={14} />
            Put back next to the Brain
          </button>
        ) : null}
        <button className="btn ghost small" onClick={() => api.zoomToTeam(id)}>
          <Icon name="zoom-in" size={14} />
          Zoom to it
        </button>
      </div>
      <div className="row mt-lg">
        <button className="btn ghost small" onClick={() => openBranchBuilder({ wf, onSaved: () => void api.reloadTeams() })}>
          <Icon name="workflow" size={14} />
          Open the team builder
        </button>
      </div>
      <div className="label mt-lg">Copy it</div>
      <div className="row mt" style={{ gap: '6px', flexWrap: 'wrap' }}>
        <button className="btn ghost small" title="A new team with the same members and settings" onClick={() => void cloneTeam(false)}>
          <Icon name="copy" size={14} />
          Clone team
        </button>
        <button className="btn ghost small" title="A new team with copies of every member" onClick={() => void cloneTeam(true)}>
          <Icon name="copy" size={14} />
          Clone with its agents
        </button>
        <button className="btn ghost small" title="Keep the team and its agents as a template for any project" onClick={() => void presetTeam(wf)}>
          <Icon name="bookmark-plus" size={14} />
          Save as preset
        </button>
      </div>
      <div className="row mt-lg" style={{ gap: '6px' }}>
        <DomNode as="span" className="dom-contents" make={() => historyButton('team', id, () => void api.reloadTeams())} deps={[id]} />
        <button className="btn danger tiny" onClick={() => void remove()}>
          Delete team
        </button>
      </div>
    </>
  );
}

// The symbol in the middle of the team's pod: an emoji, or a picture or 3D model instead.
function SymbolPicker({ api, wf }: { api: StationPanelApi; wf: TeamView }) {
  const own = wf.markFile ? (wf.markFile.kind === 'image' ? 'picture' : '3D model') : null;
  const setEmoji = async (e: string) => {
    if (wf.markFile) await attempt(() => DEL(`/workflows/${wf.id}/mark`));
    await api.saveTeam({ ...wf, mark: e, markFile: null });
  };
  const current = wf.mark || DEFAULT_TEAM_MARK;
  return (
    <div>
      <div className="row" style={{ gap: '4px', flexWrap: 'wrap' }}>
        {EMOJI_CHOICES.map((e) => (
          <button key={e} className={`btn ghost small${!own && current === e ? ' on' : ''}`} title={e} aria-pressed={!own && current === e} style={{ fontSize: '17px', padding: '2px 8px' }} onClick={() => void setEmoji(e)}>
            {e}
          </button>
        ))}
      </div>
      <div className="row mt" style={{ gap: '6px', flexWrap: 'wrap' }}>
        <input aria-label="Your own emoji" placeholder="Type or paste an emoji" maxLength={16} style={{ width: '170px' }} ref={committed<HTMLInputElement>((el) => el.value.trim() && void setEmoji(el.value.trim()))} />
        <button className="btn ghost small" onClick={() => void pickTeamMark({ id: wf.id, name: wf.name }).then((ok) => void (ok && api.reloadTeams()))}>
          <Icon name="image" size={14} />
          Use a picture or 3D model…
        </button>
        {own ? (
          <button className="btn ghost small" onClick={() => void setEmoji(wf.mark || '')}>
            Back to the emoji
          </button>
        ) : null}
      </div>
      {own ? <p className="hint mt">{`Showing your ${own} (a .glb turns, a picture stays flat).`}</p> : null}
    </div>
  );
}

// ---------- an agent ----------
// The agent's model, with its version, and how it signs in. Switch it with the chip.
const AUTH_NAMES: Record<string, string> = { login: 'Claude login (subscription)', anthropic: 'Anthropic API key', openrouter: 'OpenRouter key' };
function ModelSection({ a }: { a: Agent }) {
  // (the chip changes the agent in place: draw again)
  const [, redraw] = useState(0);
  const mi = modelInfo(a);
  const setAuth = async (v: string) => {
    if (await attempt(() => PUT(`/agents/${a.id}`, { claudeAuth: v }), 'Saved')) {
      a.claudeAuth = v as Agent['claudeAuth'];
      refreshSoon(0);
      redraw((n) => n + 1);
    }
  };
  return (
    <div className="st-model">
      <div className="label">Model</div>
      <div className="st-model-now">
        <DomNode as="span" className="dom-contents" make={() => (mi.brand && logo(mi.brand, 22)) || icon('cpu', 22)} deps={[mi.brand]} />
        <div className="grow">
          <div className="st-model-name">
            {mi.name}
            {mi.latest ? <span className="model-latest">always latest</span> : null}
          </div>
          <div className="hint">{mi.where}</div>
        </div>
      </div>
      <div className="st-model-row">
        <span className="hint">Switch</span>
        <DomNode as="span" className="dom-contents" make={() => modelChip(a, { onChange: () => redraw((n) => n + 1) })} deps={[a]} />
      </div>
      {a.engine === 'claude-code' ? (
        <div className="st-model-row">
          <span className="hint">Sign in with</span>
          <select aria-label="Sign in with" value={a.claudeAuth || 'login'} onChange={(e) => void setAuth(e.target.value)}>
            {Object.entries(AUTH_NAMES).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {a.lastModel ? (
        <div className="st-model-last">
          <Icon name="circle-check" size={13} />
          Last run used <b>{a.lastModel}</b>
          <span className="hint">{` · ${ago(a.lastModelAt)}`}</span>
        </div>
      ) : (
        <div className="hint">Not run yet. After the first run you see the exact model it used.</div>
      )}
    </div>
  );
}

// Agent panel: who it is, which teams it's on, what it can reach, its skills.
function AgentPanel({ api, d, id, wfId }: { api: StationPanelApi; d: AppState; id: string; wfId?: string }) {
  const a = d.agents.find((x) => x.id === id);
  useEffect(() => {
    if (!a) api.choose(null);
  });
  const [pick, setPick] = useState('');
  if (!a) return null;
  const teams = api.teams();
  const onTeams = teams.filter((w) => (w.members || []).includes(id));
  const others = teams.filter((w) => !onTeams.includes(w));
  const addTo = others.some((w) => w.id === pick) ? pick : others[0]?.id || '';
  const removeFrom = async (w: TeamView) => {
    await api.saveTeam(withMembers(w, w.members.filter((x) => x !== id)));
    toast(`Removed ${a.name} from ${w.name}`);
  };
  const addToTeam = async () => {
    const w = teams.find((x) => x.id === addTo);
    if (!w) return;
    await api.saveTeam(withMembers(w, [...w.members, id]));
    toast(`Added ${a.name} to ${w.name}`);
  };
  const clone = async () => {
    if (await attempt(() => POST<Agent>(`/agents/${a.id}/duplicate`), `Cloned ${a.name}`)) refreshSoon(0);
  };
  const now = api.now(id, wfId);
  const connectors = a.engine === 'claude-code' ? api.connectors() : [];
  return (
    <>
      <PanelHead api={api}>
        <Avatar agent={a} lg />
        <div className="grow">
          <div className="st-panel-title">{a.name}</div>
          <div className="hint">{a.specialty || ''}</div>
        </div>
      </PanelHead>
      <div className="st-panel-body">
        <div className={`st-agent-now ${now.st}`}>
          <span className={`dot ${now.st === 'working' ? 'busy' : now.st === 'needs' ? 'warn' : 'on'}`} />
          <span className="grow">{now.st === 'working' ? now.text : now.st === 'needs' ? 'Waiting for your OK (see below)' : 'Ready'}</span>
        </div>
        <ModelSection a={a} />
        <div className="row mt" style={{ gap: '6px' }}>
          <button className="btn small" onClick={() => openChat('agent', id)}>
            <Icon name="message-square" size={14} />
            Chat
          </button>
          <button className="btn ghost small" onClick={() => navigate(`#/agents/${id}`)}>
            Full page
          </button>
          {a.engine !== 'openai' ? (
            <button className="btn ghost small" onClick={() => openTerminal(a)}>
              Terminal
            </button>
          ) : null}
          <button className="btn ghost small" onClick={() => navigate(`#/agents/${id}/edit`)}>
            Edit
          </button>
          <button className="btn ghost small" title="Make a copy of this agent" onClick={() => void clone()}>
            <Icon name="copy" size={13} />
            Clone
          </button>
          <button className="btn ghost small" title="Keep it as a template for any project" onClick={() => void presetAgent(a)}>
            <Icon name="bookmark-plus" size={13} />
            Preset
          </button>
        </div>
        <div className="label mt-lg">Skills</div>
        <DomNode
          className="mt"
          make={() =>
            skillPicker(a.skills || [], (v) => void attempt(() => PUT(`/agents/${id}`, { skills: v })).then(() => refreshSoon(0)), {
              inherited: [...(d.project?.skills || []).map((slug) => ({ slug, from: 'project' })), ...onTeams.flatMap((w) => (w.skills || []).map((slug) => ({ slug, from: w.name })))],
              empty: 'No skills yet.',
            })
          }
          deps={[id, (a.skills || []).join('|'), (d.project?.skills || []).join('|'), onTeams.map((w) => `${w.name}:${(w.skills || []).join(',')}`).join('|')]}
        />
        <div className="label mt-lg">{`Teams (${onTeams.length})`}</div>
        <div className="st-conns">
          {onTeams.map((w) => (
            <div key={w.id} className="st-conn ok">
              <span className="st-dot" style={badgeStyle(wfColor(w, teams.indexOf(w)))} />
              <span className="grow" style={{ cursor: 'pointer' }} role="button" tabIndex={0} onClick={() => api.choose({ type: 'branch', id: w.id })} onKeyDown={(e) => e.key === 'Enter' && api.choose({ type: 'branch', id: w.id })}>
                {w.name}
                <span className="hint">{w.lead === id ? ' · ★ lead' : ' · member'}</span>
              </span>
              <button className="btn tiny ghost" title={`Open ${w.name}'s chat with @${a.name}`} onClick={() => openChat('team', w.id).mention?.(a.name)}>
                Chat
              </button>
              {w.lead !== id ? (
                <button className="btn tiny ghost" title="Make lead of this team" aria-label={`Make ${a.name} lead of ${w.name}`} onClick={() => void api.saveTeam({ ...w, lead: id })}>
                  ★
                </button>
              ) : null}
              <button className="btn tiny ghost" title={`Take ${a.name} off this team`} onClick={() => void removeFrom(w)}>
                Remove
              </button>
            </div>
          ))}
          {!onTeams.length ? <p className="hint">On the Bench: not in any team yet. Add it to one below, or drag it onto a team on the map.</p> : null}
        </div>
        {others.length ? (
          <div className="row nowrap mt">
            <div className="grow">
              <select aria-label="Team to add it to" value={addTo} onChange={(e) => setPick(e.target.value)}>
                {others.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </div>
            <button className="btn small" onClick={() => void addToTeam()}>
              Add to team
            </button>
          </div>
        ) : null}
        <div className="label mt-lg">Connections it can use</div>
        <ConnectionList api={api} d={d} ids={agentLinks(a)} />
        {connectors.length ? (
          <div className="st-conns">
            <div className="hint">Plus the connectors on your Claude account:</div>
            <div className="row" style={{ gap: '4px' }}>
              {connectors.map((c) => {
                const look = connectorLook(c.name);
                return (
                  <span key={c.id || c.name} className="st-badge" style={badgeStyle(c.status === 'connected' ? look.color : '#555850')} title={`${c.name}: ${c.status === 'connected' ? 'connected' : 'needs sign-in'}`}>
                    <DomNode as="span" className="dom-contents" make={() => appLogo(c.name, 11) || document.createTextNode(look.glyph)} deps={[c.name]} />
                  </span>
                );
              })}
            </div>
          </div>
        ) : null}
        <Approvals list={d.approvals.filter((x) => x.agentId === id)} />
      </div>
    </>
  );
}
