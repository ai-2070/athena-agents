// Agents: your team, and the editor for one agent.
import { Plate } from '../ui/surface.tsx';
import { Button, ButtonLink } from '../ui/button.tsx';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Autocomplete } from '@base-ui/react/autocomplete';
import type { ReactNode } from 'react';
import { GET, POST, attempt, refreshSoon, navigate, toast, confirmBox, promptBox, isRunning, ENGINE_LABEL } from '../core.ts';
import { rpc } from '../client/rpc.ts';
import { skillPicker } from '../skillpick.ts';
import { historyButton, deletedButton } from '../history.tsx';
import { memoryEditor } from '../memory.tsx';
import { ChipSet, Field, SearchBox, Segmented, Switch } from '../ui/controls.tsx';
import { FormSection } from '../ui/formsection.tsx';
import { buttonClass, chipClass } from '../ui/classes.ts';
import { Dot, Pill } from '../ui/marks.tsx';
import { Avatar, DomNode, Icon, ProjectScoped, reactPage, useAppState } from '../ui/react.tsx';
import { ProgramGlyph, PresetGlyph } from '../ui/programmark.tsx';
import { SelectControl } from '../ui/select.tsx';
import type { SelectOption } from '../ui/select.tsx';
import { themeColor } from '../theme.ts';
import type { ModelListing } from '../models.tsx';
import { defaultModelForEngine } from '../../shared/modeldefaults.ts';
import { EFFORT_NAMES, effortFor, effortLevels } from '../../shared/effort.ts';
import { copiesWarning, mcpOptions } from '../mcpcopies.ts';
import { CATEGORY_COLORS, ENGINE_NAMES, OTHER_COLOR, agentCategory, agentModel, categorySlices, engineKey, inSlice, modelSlices } from '../agentstats.ts';
import type { Slice } from '../agentstats.ts';
import type { Agent, AgentDetail, AppState, Autonomy, EngineStatus, McpServerInfo, Team, Terminal } from '../../shared/types.ts';

const EmojiPicker = lazy(() => import('../ui/emojipicker.tsx').then((m) => ({ default: m.EmojiPicker })));

/** GET /api/agents/:id: the agent plus its knowledge files and resolved workspace. */
export type { AgentDetail };
/** One entry of GET /api/openclaw/agents. */
interface OpenClawAgent {
  id: string;
  model: string;
  isDefault: boolean;
}
/** One entry of GET /api/hermes/profiles. */
interface HermesProfile {
  name: string;
  model: string;
  gateway: string;
  isDefault: boolean;
}
/** The part of GET /api/mcp used here. */
interface McpListing {
  servers: Record<string, unknown>;
  info?: Record<string, McpServerInfo>;
}

export async function openTerminal(agent: Pick<Agent, 'id'>): Promise<void> {
  const t = await attempt(() => POST<Terminal>('/terminals', { kind: 'agent', agentId: agent.id }));
  if (t) navigate(`#/terminals/${t.id}`);
}

/** "Claude Code", "API model · openrouter", "Hermes · writer"… */
export function engineLabel(a: Pick<Agent, 'engine'> & Partial<Pick<Agent, 'provider' | 'hermesProfile' | 'openclawAgent'>>): string {
  const label = ENGINE_LABEL[a.engine] || a.engine;
  const extra = a.engine === 'eve' ? ` · ${a.provider}` : a.engine === 'hermes' && a.hermesProfile ? ` · ${a.hermesProfile}` : a.engine === 'openclaw' && a.openclawAgent ? ` · ${a.openclawAgent}` : '';
  return `${label}${extra}`;
}

// ---------- the overview ----------
/** A category or model picked in the overview, or an engine tile clicked on the Station: the list shows only its agents. */
interface ChartPick {
  kind: 'category' | 'model' | 'engine';
  slice: Slice;
}
/** The small caption over a figure or a chart. */
const CAPTION = 'text-[12.5px] leading-none font-medium text-dim';

/** One number of the overview: what it counts, the figure. live: something is going on (a pulsing dot). */
function StatTile({ icon, label, value, live = false, valueClass = '' }: { icon: string; label: string; value: number; live?: boolean; valueClass?: string }) {
  return (
    <Plate className="rounded-box px-5 py-4">
      <div className="flex items-center justify-between gap-2">
        <span className={`${CAPTION} truncate`}>{label}</span>
        {live ? <Dot tone="busy" /> : <Icon name={icon} size={15} className="text-faint" />}
      </div>
      <b className={`${valueClass} mt-3.5 block text-[28px] leading-none font-semibold tracking-tight text-ink tabular-nums`}>{value}</b>
    </Plate>
  );
}

/** What kinds of agents the project has (one bar, a segment per category) and which models they run on. */
function AgentsOverview({ agents, d, pick, setPick }: { agents: Agent[]; d: AppState; pick: ChartPick | null; setPick: (p: ChartPick | null) => void }) {
  const [hot, setHot] = useState<string | null>(null);
  const total = agents.length;
  const cats = categorySlices(agents);
  const models = modelSlices(agents, d.settings.defaults);
  // the model bars are measured against the biggest one
  const topModel = Math.max(1, ...models.map((m) => m.count));
  const kinds = new Set(agents.map((a) => agentCategory(a).id)).size;
  const working = agents.filter((a) => isRunning(a.id)).length;
  const pct = (n: number) => `${Math.round((n / total) * 100)}%`;
  const toggle = (kind: ChartPick['kind'], slice: Slice) => setPick(pick?.kind === kind && pick.slice.id === slice.id ? null : { kind, slice });
  const picked = (kind: ChartPick['kind'], s: Slice) => pick?.kind === kind && pick.slice.id === s.id;
  // a segment is dimmed while another one is pointed at or picked
  const catFocus = hot || (pick?.kind === 'category' ? pick.slice.id : null);
  const shown = cats.find((s) => s.id === hot);
  const before = shown ? cats.slice(0, cats.indexOf(shown)).reduce((n, s) => n + s.count, 0) : 0;
  return (
    <section className="agents-overview mb-8 flex flex-col gap-4" aria-label="Your agents at a glance">
      <div className="grid grid-cols-4 gap-4 max-lg:grid-cols-2">
        <StatTile icon="bot" label="Agents" value={total} valueClass="agents-total" />
        <StatTile icon="radio" label="Working now" value={working} live={working > 0} />
        <StatTile icon="layout-grid" label={kinds === 1 ? 'Category' : 'Categories'} value={kinds} />
        <StatTile icon="cpu" label="Models" value={new Set(agents.map((a) => agentModel(a, d.settings.defaults).id)).size} />
      </div>
      <Plate className="panel grid grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] gap-x-12 gap-y-8 max-lg:grid-cols-1">
        <div className="min-w-0">
          <div className={`${CAPTION} mb-4`}>By category</div>
          <div className="relative">
            <div className="agents-cat-bar flex h-2.5 gap-0.5" onMouseLeave={() => setHot(null)}>
              {cats.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className={`h-full min-w-1 cursor-pointer transition-opacity duration-150 first:rounded-l-full last:rounded-r-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${catFocus && catFocus !== s.id ? 'opacity-30' : ''}`}
                  style={{ flexGrow: s.count, flexBasis: 0, background: s.color }}
                  aria-label={`${s.label}: ${s.count} of ${total} agents`}
                  aria-pressed={picked('category', s)}
                  onMouseEnter={() => setHot(s.id)}
                  onFocus={() => setHot(s.id)}
                  onBlur={() => setHot(null)}
                  onClick={() => toggle('category', s)}
                />
              ))}
            </div>
            {shown ? (
              <div className="glass pointer-events-none absolute bottom-full z-10 mb-3 -translate-x-1/2 rounded-ctl px-3 py-2 text-[12.5px] leading-[1.4] whitespace-nowrap" style={{ left: `${((before + shown.count / 2) / total) * 100}%` }} role="tooltip">
                <b className="text-ink">{shown.label}</b>
                <span className="text-dim tabular-nums">{`  ${shown.count} · ${pct(shown.count)}`}</span>
                {shown.rest ? <div className="max-w-70 whitespace-normal text-dim">{shown.rest.map((r) => `${r.label} ${r.count}`).join(', ')}</div> : null}
              </div>
            ) : null}
          </div>
          <ul className="agents-cat-legend mt-4 -ml-2 flex flex-wrap gap-x-1 gap-y-1">
            {cats.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  className={`inline-flex cursor-pointer items-center gap-2 rounded-ctl px-2 py-1.5 text-[13px] leading-none text-ink transition-[background,opacity] duration-150 hover:bg-ink/5 focus-visible:outline-2 focus-visible:outline-accent ${catFocus && catFocus !== s.id ? 'opacity-45' : ''} ${picked('category', s) ? 'bg-ink/7' : ''}`}
                  aria-pressed={picked('category', s)}
                  onMouseEnter={() => setHot(s.id)}
                  onMouseLeave={() => setHot(null)}
                  onClick={() => toggle('category', s)}
                >
                  <span className="size-2.5 flex-none rounded-full" style={{ background: s.color }} aria-hidden="true" />
                  {s.label}
                  <span className="text-[12px] text-dim tabular-nums">{s.count}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
        <div className="min-w-0">
          <div className={`${CAPTION} mb-3`}>By model</div>
          <ul className="agents-models -mx-2 flex flex-col">
            {models.map((m, i) => (
              <li key={m.id}>
                <button
                  type="button"
                  className={`group grid w-full cursor-pointer grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_1.5rem] items-center gap-3 rounded-ctl px-2 py-2 text-left transition-[background,opacity] duration-150 hover:bg-ink/5 focus-visible:outline-2 focus-visible:outline-accent ${pick?.kind === 'model' && !picked('model', m) ? 'opacity-45' : ''} ${picked('model', m) ? 'bg-ink/7' : ''}`}
                  title={m.rest ? m.rest.map((r) => `${r.label} (${r.sub}) ${r.count}`).join('\n') : `${m.label} · ${m.sub}`}
                  aria-label={`${m.label}${m.sub ? ` on ${m.sub}` : ''}: ${m.count} of ${total} agents`}
                  aria-pressed={picked('model', m)}
                  onClick={() => toggle('model', m)}
                >
                  <span className="min-w-0 truncate text-[13px] leading-[1.3]">
                    <span className="text-ink">{m.label}</span>
                    <span className="ml-2 text-[12px] text-faint">{m.rest ? `${m.rest.length} more` : m.sub}</span>
                  </span>
                  <span className="h-1.5 overflow-hidden rounded-full bg-panel-2" aria-hidden="true">
                    {/* (each model in its own colour from the same six as the categories) */}
                    <span className="block h-full rounded-full opacity-85 transition-opacity duration-150 group-hover:opacity-100" style={{ width: `${(m.count / topModel) * 100}%`, background: m.id === 'other' ? OTHER_COLOR : CATEGORY_COLORS[i % CATEGORY_COLORS.length] }} />
                  </span>
                  <span className="text-right text-[12.5px] text-dim tabular-nums">{m.count}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </Plate>
    </section>
  );
}

// ---------- the list ----------
// kept while you move around the app, as before
let lastFilter = '';
let lastPick: ChartPick | null = null;
/** #/agents?uses=claude-code (from an engine tile on the Station): that engine's agents. */
function engineFromLink(): ChartPick | null {
  const key = new URLSearchParams(location.hash.split('?')[1] || '').get('uses');
  return key && ENGINE_NAMES[key] ? { kind: 'engine', slice: { id: key, label: ENGINE_NAMES[key], count: 0 } } : null;
}

function AgentsList() {
  const d = useAppState();
  const [filter, setFilter] = useState(lastFilter);
  const [pick, setPickState] = useState(() => (lastPick = engineFromLink() || lastPick));
  const setPick = (p: ChartPick | null) => {
    setPickState((lastPick = p));
    // (the link's ?uses= goes with it, so a reload shows what you picked)
    if (location.hash.includes('?')) history.replaceState(null, '', '#/agents');
  };
  if (!d) return null;
  const q = filter.toLowerCase();
  const inPick = (a: Agent) => !pick || inSlice(pick.slice, pick.kind === 'category' ? agentCategory(a).id : pick.kind === 'engine' ? engineKey(a) : agentModel(a, d.settings.defaults).id);
  const shown = d.agents.filter((a) => (!q || `${a.name} ${a.specialty} ${a.description}`.toLowerCase().includes(q)) && inPick(a));
  const create = async () => {
    const a = await attempt(() => rpc.agents.create({ name: 'New agent' }));
    if (a) navigate(`#/agents/${a.id}/edit`);
  };
  return (
    <>
      {d.agents.length > 1 ? <AgentsOverview agents={d.agents} d={d} pick={pick} setPick={setPick} /> : null}
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <SearchBox className="w-[min(360px,100%)]" label="Search agents" placeholder="Search agents" value={filter} onChange={(v) => setFilter((lastFilter = v))} />
        {pick ? (
          <button type="button" className={chipClass(true, "agents-pick")} onClick={() => setPick(null)} title="Show every agent">
            {pick.kind === 'model' ? `Model: ${pick.slice.label}` : pick.kind === 'engine' ? `On ${pick.slice.label}` : pick.slice.label}
            <span aria-hidden="true">✕</span>
          </button>
        ) : null}
        <div className="ml-auto flex flex-wrap items-center gap-3">
          <DomNode as="span" make={() => deletedButton(['agent', 'team'], () => refreshSoon(0))} deps={[]} />
          <ButtonLink variant="ghost" href="#/library">
            <Icon name="store" size={14} />
            Hire from Agent library
          </ButtonLink>
          <Button  onClick={() => void create()}>
            <Icon name="plus" size={14} />
            New agent
          </Button>
        </div>
      </div>
      {shown.length ? (
        <div className="cards">
          {shown.map((a) => (
            <Plate key={a.id} className="card hover:shadow-none agent-card gap-4">
              <div className="card-top">
                <Avatar agent={a} lg />
                <div className="min-w-0 flex-1">
                  <div className="card-title pr-16 text-[15.5px]">{a.name}</div>
                  <div className="card-sub mt-1 text-[13px]">{a.specialty || a.description || 'No specialty yet'}</div>
                </div>
              </div>
              {isRunning(a.id) ? (
                <Pill tone="warn" className="corner items-center">
                  <Dot tone="busy" />
                  working
                </Pill>
              ) : a.pinned ? (
                <span className="corner text-faint" aria-label="pinned">★</span>
              ) : null}
              <div className="flex flex-wrap items-center gap-2">
                <Pill className="inline-flex items-center gap-1.5">
                  <Icon name="cpu" size={11} />
                  {engineLabel(a)}
                </Pill>
                <Pill className="inline-flex items-center gap-1.5">
                  <Icon name={a.autonomy === 'full' ? 'zap' : a.autonomy === 'ask' ? 'hand' : 'shield-check'} size={11} />
                  {a.autonomy === 'full' ? 'full autonomy' : a.autonomy === 'ask' ? 'asks first' : 'auto'}
                </Pill>
              </div>
              <div className="card-foot border-t border-line pt-4">
                <ButtonLink size="small" href={`#/agents/${a.id}`}>
                  <Icon name="message-square" size={13} />
                  Chat
                </ButtonLink>
                <ButtonLink variant="ghost" size="small" href={`#/agents/${a.id}/edit`}>
                  <Icon name="pencil" size={13} />
                  Edit
                </ButtonLink>
                {a.engine !== 'eve' ? (
                  <Button variant="ghost" size="small" className="ml-auto" title="Open a terminal for this agent" aria-label={`Terminal for ${a.name}`} onClick={() => void openTerminal(a)}>
                    <Icon name="terminal" size={13} />
                    Terminal
                  </Button>
                ) : null}
              </div>
            </Plate>
          ))}
        </div>
      ) : d.agents.length ? (
        <div className="empty py-12">No agent matches.</div>
      ) : (
        <div className="flex flex-col items-center gap-4 py-12 text-center">
          <p className="m-0 max-w-[44ch] text-dim">No agents yet. Hire a specialist from the Agent library, or start with a blank one.</p>
          <ButtonLink  href="#/library">
            <Icon name="store" size={14} />
            Hire from Agent library
          </ButtonLink>
        </div>
      )}
    </>
  );
}

// ---------- the editor ----------
const AUTONOMY: { value: Autonomy; label: string; title: string; icon: string }[] = [
  { value: 'ask', label: 'Ask first', title: 'You approve every action that changes something', icon: 'hand' },
  { value: 'auto', label: 'Auto', title: 'Asks only for risky things: running code, shell, sending messages', icon: 'shield-check' },
  { value: 'full', label: 'Full', title: 'Never asks. Only for agents you trust completely', icon: 'zap' },
];

// the editor's parts, in page order: the list beside the page jumps to them
const PARTS = [
  { id: 'identity', label: 'Identity', icon: 'bot' },
  { id: 'brain', label: 'Brain', icon: 'cpu' },
  { id: 'knowledge', label: 'Knowledge', icon: 'file-text' },
  { id: 'behaviour', label: 'Autonomy', icon: 'shield-check' },
  { id: 'tools', label: 'Tools and skills', icon: 'wrench' },
  { id: 'workspace', label: 'Workspace', icon: 'folder' },
  { id: 'more', label: 'More', icon: 'ellipsis' },
] as const;
const partId = (id: string) => `agent-part-${id}`;

/** A choice tile (an engine, an autonomy level): its icon over its name, lit when picked. */
const TILE =
  'relative flex min-w-0 cursor-pointer flex-col items-start gap-2.5 rounded-box border border-line bg-panel/60 p-3 text-left text-dim [transition:border-color_0.15s,background-color_0.15s,color_0.15s,box-shadow_0.15s] hover:border-line-2 hover:bg-panel-2 hover:text-ink aria-checked:border-accent aria-checked:bg-accent/8 aria-checked:text-ink aria-checked:shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-accent)_14%,transparent)]';
const TILE_ICON = 'grid size-8 flex-none place-items-center rounded-[9px] border border-line bg-panel-2 text-dim [[aria-checked=true]_&]:border-accent/40 [[aria-checked=true]_&]:bg-accent/12 [[aria-checked=true]_&]:text-accent';
/** A part of the page: one surface, its sections split by hairlines. */
const PART = 'scroll-mt-40 rounded-box p-6 max-sm:p-4';

interface EditorData {
  agent: AgentDetail;
  servers: string[];
  /** each server's label, service and "use for" */
  info?: Record<string, McpServerInfo>;
  teams: Team[];
}

function AgentEditor({ id }: { id: string }) {
  const d = useAppState();
  const [data, setData] = useState<EditorData | null>(null);
  // a new number draws the editor again from the server (after History put back an earlier version)
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let live = true;
    // (Hermes profiles and OpenClaw agents ask their CLIs, which can be slow: they load with their engine's fields)
    void Promise.all([rpc.agents.get({ id }), GET<McpListing>('/mcp').catch(() => ({ servers: {} })), rpc.workflows.list().catch((): Team[] => [])]).then(
      ([agent, mcp, teams]) => live && setData({ agent, servers: Object.keys(mcp.servers), info: (mcp as McpListing).info, teams }),
    );
    return () => void (live = false);
  }, [id, version]);
  if (!data || !d) return null;
  return <EditorForm key={version} data={data} d={d} reload={() => setVersion((v) => v + 1)} />;
}

/** The list of parts beside the page: a click scrolls to one, and the one in view is lit. */
function PartsNav() {
  const [seen, setSeen] = useState<string>(PARTS[0].id);
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        const top = entries.filter((e) => e.isIntersecting).sort((x, y) => x.boundingClientRect.top - y.boundingClientRect.top)[0];
        if (top) setSeen(top.target.id.replace('agent-part-', ''));
      },
      { rootMargin: '-15% 0px -65% 0px' },
    );
    for (const p of PARTS) {
      const el = document.getElementById(partId(p.id));
      if (el) io.observe(el);
    }
    return () => io.disconnect();
  }, []);
  return (
    <nav aria-label="Parts of the agent" className="sticky top-40 flex flex-col gap-0.5 max-lg:hidden">
      {PARTS.map((p) => (
        <button
          key={p.id}
          type="button"
          aria-current={seen === p.id ? 'true' : undefined}
          className="flex items-center gap-2.5 rounded-ctl px-2.5 py-1.5 text-left text-[13px] text-dim [transition:background-color_0.15s,color_0.15s] hover:bg-ink/5 hover:text-ink aria-[current]:bg-ink/5 aria-[current]:font-medium aria-[current]:text-ink"
          onClick={() => document.getElementById(partId(p.id))?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
        >
          <Icon name={p.icon} size={14} />
          {p.label}
        </button>
      ))}
    </nav>
  );
}

/** The colour box takes #rrggbb: an agent without a colour starts on the accent. */
const colorValue = (c?: string): string => (c && /^#[0-9a-f]{6}$/i.test(c) ? c : /^#[0-9a-f]{6}$/i.test(themeColor('accent')) ? themeColor('accent') : '#18688e');

function EditorForm({ data, d, reload }: { data: EditorData; d: AppState; reload: () => void }) {
  const { agent, servers, info, teams } = data;
  const id = agent.id;
  const [a, setA] = useState<Agent>(() => structuredClone(agent));
  const [dirty, setDirty] = useState(false);
  const set = <K extends keyof Agent>(k: K, v: Agent[K]) => {
    setA((x) => ({ ...x, [k]: v }));
    setDirty(true);
  };
  // (saved by its own Save button: the agent may write to it while you edit the rest)
  const memory = useRef<ReturnType<typeof memoryEditor> | null>(null);
  useEffect(() => {
    window.onbeforeunload = () => (dirty || memory.current?.dirty() ? true : undefined);
    return () => void (window.onbeforeunload = null);
  }, [dirty]);

  const save = async (thenChat = false) => {
    if (await attempt(() => rpc.agents.change({ ...a, id }), 'Saved')) {
      setDirty(false);
      if (thenChat) navigate(`#/agents/${id}`);
    }
  };
  // A new engine or provider may not have the effort level: keep the nearest one it has, the one the Effort field shows.
  const fit = (x: Agent): Agent => (x.effort && !(x.engine === 'eve' && x.provider === 'venice') ? { ...x, effort: effortFor(x.engine, x.effort, x.provider) } : x);
  const pickEngine = (engine: Agent['engine']) => {
    setA((x) => fit({ ...x, engine, model: defaultModelForEngine(engine, d.settings.defaults, x.provider) }));
    setDirty(true);
  };
  const del = async () => {
    if (!(await confirmBox(`Delete ${a.name}? Its chats stay in the data folder.`, { ok: 'Delete', danger: true }))) return;
    if (await attempt(() => rpc.agents.remove({ id }), 'Deleted')) navigate('#/agents');
  };
  const clone = async () => {
    const c = await attempt(() => rpc.agents.duplicate({ id }), 'Duplicated');
    if (c) navigate(`#/agents/${c.id}/edit`);
  };
  const pin = () =>
    void rpc.agents.change({ id, pinned: !a.pinned }).then(() => {
      setA((x) => ({ ...x, pinned: !x.pinned }));
      toast(a.pinned ? 'Unpinned' : 'Pinned');
    });

  const engineInfo = d.engineList.find((e) => e.id === a.engine);
  return (
    <div className="mx-auto max-w-6xl">
      {/* the agent at the top, with Chat and Save: it stays in view on this long page */}
      {/* (just under the app's own top bar, which is sticky too and 3.5rem tall) */}
      <div className="sticky top-14 z-10 -mx-3 mb-8 flex flex-wrap items-center gap-x-4 gap-y-3 border-b border-line px-3 py-3 backdrop-blur-md">
        <ButtonLink variant="ghost" size="small" href="#/agents">← Agents</ButtonLink>
        <div className="flex min-w-0 flex-1 items-center gap-3 [&_.avatar]:size-10 [&_.avatar]:rounded-[11px] [&_.avatar]:text-[20px]">
          <Avatar agent={a} />
          <div className="min-w-0">
            <h1 className="m-0 truncate text-[18px] leading-tight font-semibold text-ink">{a.name.trim() || 'Agent'}</h1>
            <p className="m-0 mt-0.5 truncate text-[12.5px] text-dim">{`Edit agent · ${engineLabel(a)}${a.model ? ` · ${a.model}` : ''}`}</p>
          </div>
        </div>
        {dirty ? (
          <span className="inline-flex items-center gap-1.5 text-[12.5px] text-dim" role="status">
            <Dot tone="warn" />
            Not saved yet
          </span>
        ) : null}
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={() => (dirty ? void save(true) : navigate(`#/agents/${id}`))}>
            <Icon name="message-square" size={14} />
            Chat
          </Button>
          <Button disabled={!dirty} onClick={() => void save()}>Save</Button>
        </div>
      </div>

      <div className="grid grid-cols-[180px_minmax(0,1fr)] items-start gap-10 max-lg:grid-cols-1">
        <PartsNav />
        <div className="flex min-w-0 flex-col gap-6">
          <Plate id={partId('identity')} className={PART}>
            <FormSection icon="bot" title="Identity and instructions" hint="Who it is and how it works. Click the picture to change it.">
              <div className="grid grid-cols-[auto_minmax(0,1fr)] items-end gap-4">
                <div className="flex-none [&_.avatar]:size-15 [&_.avatar]:rounded-[14px] [&_.avatar]:text-[30px]">
                  <Suspense fallback={<Avatar agent={a} lg />}>
                    <EmojiPicker value={a.emoji} onChange={(emoji) => set('emoji', emoji)}><Avatar agent={a} lg /></EmojiPicker>
                  </Suspense>
                </div>
                <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-end gap-3">
                  <div className="min-w-0">
                    <Field label="Name">
                      <input value={a.name} onChange={(e) => set('name', e.target.value)} />
                    </Field>
                  </div>
                  <Field label="Color">
                    <input type="color" value={colorValue(a.color)} aria-label="Color" onChange={(e) => set('color', e.target.value)} />
                  </Field>
                </div>
              </div>
              <Field label="Specialty" hint="One line. Other agents see it when deciding who to ask.">
                <input value={a.specialty} placeholder="e.g. writes punchy X threads about AI" onChange={(e) => set('specialty', e.target.value)} />
              </Field>
              <Field label="Instructions">
                <textarea className="code min-h-60 leading-[1.6]" rows={12} value={a.systemPrompt} placeholder="How this agent thinks, works and talks. Its process, rules, what good output looks like." onChange={(e) => set('systemPrompt', e.target.value)} />
              </Field>
            </FormSection>
          </Plate>

          <Plate id={partId('brain')} className={PART}>
            <FormSection icon="cpu" title="Brain" hint={engineInfo?.description || 'What runs the agent, and which model it thinks with.'}>
              <div role="radiogroup" aria-label="Brain" className="grid grid-cols-4 gap-2 max-sm:grid-cols-2">
                {d.engineList.map((e) => (
                  <button key={e.id} type="button" role="radio" aria-checked={a.engine === e.id} title={e.description} className={TILE} onClick={() => a.engine !== e.id && pickEngine(e.id)}>
                    <span className={TILE_ICON}><ProgramGlyph id={e.id} size={16} /></span>
                    <span className="max-w-full truncate text-[13px] font-semibold">{e.label}</span>
                  </button>
                ))}
              </div>
              <div className="border-t border-line pt-5">
                <EngineFields a={a} d={d} set={set} fit={(x) => (setA(fit(x)), setDirty(true))} />
              </div>
            </FormSection>
          </Plate>

          <Plate id={partId('knowledge')} className={PART}>
            <div className="flex flex-col gap-6">
              <FormSection icon="file-text" title="Knowledge" hint="Notes, files, folders and web pages it can read.">
                {/* Save keeps any knowledge linked while editing. */}
                <Knowledge id={id} synced={(knowledge) => setA((x) => ({ ...x, knowledge }))} />
              </FormSection>
              <FormSection icon="brain" title="MEMORY.md" end={<Pill>saved on its own</Pill>}>
                <DomNode make={() => (memory.current = memoryEditor(id, { rows: 10 })).el} deps={[id]} />
              </FormSection>
            </div>
          </Plate>

          <Plate id={partId('behaviour')} className={PART}>
            <div className="flex flex-col gap-6">
              <FormSection icon="shield-check" title="Autonomy" hint="How much it does before asking you. X posts always wait in the Outbox unless an account has auto-post on.">
                <div role="radiogroup" aria-label="Autonomy" className="grid grid-cols-3 gap-2 max-sm:grid-cols-1">
                  {AUTONOMY.map((o) => (
                    <button key={o.value} type="button" role="radio" aria-checked={(a.autonomy || 'auto') === o.value} className={TILE} onClick={() => set('autonomy', o.value)}>
                      <span className={TILE_ICON}><Icon name={o.icon} size={16} /></span>
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <span className="text-[13px] font-semibold text-ink">{o.label}</span>
                        <span className="text-[12px] leading-normal text-dim">{o.title}</span>
                      </span>
                    </button>
                  ))}
                </div>
                {a.alwaysAllow?.length ? (
                  <div className="flex flex-wrap items-center gap-2 rounded-box border border-line bg-panel-2/40 px-4 py-3">
                    <span className="mr-1 text-[12.5px] font-medium text-dim">Always allowed</span>
                    {a.alwaysAllow.map((t) => (
                      <Pill key={t}>{t}</Pill>
                    ))}
                    <Button variant="ghost" size="tiny" className="ml-auto" onClick={() => (set('alwaysAllow', []), toast('Cleared; save to apply'))}>Clear</Button>
                  </div>
                ) : null}
              </FormSection>
              <FormSection icon="sparkles" title="Answers">
                <Switch checked={!!a.richAnswers} onChange={(v) => set('richAnswers', v)} className="flex-nowrap! items-start! gap-3.5! rounded-box border border-line bg-panel-2/40 px-4 py-3.5 [&_.switch]:mt-0.5 [&_.switch]:flex-none">
                  <span className="block text-[13.5px] font-medium text-ink">Rich answers</span>
                  <span className="mt-0.5 block text-[12.5px] leading-normal text-dim">In your own chats it answers with live cards, tables, charts and forms. Good for research and reports. Leave off for coding agents and small or local models: it adds about 13k tokens to every message. Team chats, routines and other agents always get plain text.</span>
                </Switch>
              </FormSection>
            </div>
          </Plate>

          <Plate id={partId('tools')} className={PART}>
            <div className="flex flex-col gap-6">
              <FormSection icon="wrench" title="Tools" hint="Point at a tool for what it does. Claude Code and Hermes agents also keep their own built-in tools.">
                <ChipSet label="Tools" options={d.toolGroups.map((g) => ({ value: g.id, label: g.label, title: g.description }))} value={a.toolGroups} onChange={(v) => set('toolGroups', v)} />
              </FormSection>
              <FormSection icon="plug" title="MCP servers" hint="Outside apps and services it can use.">
                {servers.length ? (
                  <div>
                    <ChipSet label="MCP servers" options={mcpOptions(servers, info).map((option) => ({ ...option, label: <span className="inline-flex items-center gap-2"><PresetGlyph id={info?.[option.value]?.kind || option.value} size={14} />{option.label}</span> }))} value={a.mcpServers} onChange={(v) => set('mcpServers', v)} />
                    {copiesWarning(a.mcpServers, info) ? <p className="hint mcp-copies-warning mt-2 text-amber">{copiesWarning(a.mcpServers, info)}</p> : null}
                  </div>
                ) : (
                  <p className="m-0 rounded-box border border-dashed border-line-2 px-4 py-3 text-[13px] text-dim">
                    No MCP servers yet. <a href="#/settings?tab=mcp">Add one</a> (browser control, GitHub, Blender live…).
                  </p>
                )}
              </FormSection>
              <FormSection icon="puzzle" title="Skills" hint="Its own skills. It also gets the project's and, while working for a team, that team's (both greyed). Save to apply.">
                <DomNode
                  make={() =>
                    skillPicker(a.skills || [], (skills) => set('skills', skills), {
                      inherited: [
                        ...(d.project?.skills || []).map((slug) => ({ slug, from: 'project' })),
                        ...teams.filter((w) => (w.members || []).includes(id)).flatMap((w) => (w.skills || []).map((slug) => ({ slug, from: w.name }))),
                      ],
                      empty: 'No skills of its own yet.',
                    })
                  }
                  deps={[id]}
                />
              </FormSection>
            </div>
          </Plate>

          <Plate id={partId('workspace')} className={PART}>
            <FormSection icon="folder" title="Workspace" hint="Where it saves files and runs commands. Empty: its own folder in the dashboard data.">
              <div className="flex items-end gap-2 max-sm:flex-col max-sm:items-stretch">
                <div className="min-w-0 flex-1">
                  <Field label="Working folder">
                    <input className="code" value={a.workspace || ''} placeholder={agent.workspacePath} onChange={(e) => set('workspace', e.target.value.trim())} />
                  </Field>
                </div>
                <Button variant="ghost" onClick={() => void attempt(() => rpc.agents.openWorkspace({ id }))}>
                  <Icon name="folder-open" size={14} />
                  Open folder
                </Button>
              </div>
            </FormSection>
          </Plate>

          {/* the rest: quiet actions, and Delete set apart at the end */}
          <section id={partId('more')} className="scroll-mt-40 flex flex-col gap-3 border-t border-line pt-6">
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="ghost" size="small" onClick={pin}>
                <Icon name="star" size={13} />
                {a.pinned ? 'Unpin' : 'Pin to top'}
              </Button>
              <Button variant="ghost" size="small" onClick={() => void clone()}>
                <Icon name="copy" size={13} />
                Clone
              </Button>
              {/* put back: show it as it is now (changes not saved yet are dropped) */}
              <DomNode as="span" make={() => historyButton('agent', id, () => (setDirty(false), reload()))} deps={[id]} />
              <Button variant="ghost" size="small" title="Keep it as a template you can create again in any project (Agent library > Your presets)" onClick={() => void attempt(() => rpc.presets.saveAgent({ id }), `Saved ${a.name} as a preset`)}><Icon name="bookmark-plus" size={13} />
                Save as preset
              </Button>
              <Button variant="ghost" size="small" title="Write it to ~/.claude/agents so any Claude Code session can use it" onClick={() => void attempt(() => rpc.agents.exportClaude({ id }), (r) => `Saved as ${r.file}`)}><Icon name="terminal" size={13} />
                Install in Claude Code
              </Button>
              <Button variant="danger" size="small" className="ml-auto" onClick={() => void del()}>
                <Icon name="trash-2" size={13} />
                Delete
              </Button>
            </div>
            <p className="m-0 font-mono text-[11.5px] text-faint">{`Id: ${a.id}${a.source?.type && a.source.type !== 'custom' ? ` · from ${a.source.type}${a.source.slug ? ` (${a.source.slug})` : ''}` : ''}`}</p>
          </section>
        </div>
      </div>
    </div>
  );
}

function ModelInput({ label, hint, value, placeholder, models, onChange }: { label: string; hint: string; value: string; placeholder: string; models: ModelListing[]; onChange: (value: string) => void }) {
  const anchor = useRef<HTMLDivElement>(null);
  const [showAll, setShowAll] = useState(false);
  return (
    <Field label={label} hint={hint} group="agent-model-label">
      <Autocomplete.Root
        items={models}
        value={value}
        onValueChange={(next, details) => {
          if (details.reason !== 'item-press') setShowAll(false);
          onChange(next.trim());
        }}
        onOpenChange={(open) => { if (!open) setShowAll(false); }}
        itemToStringValue={(item: ModelListing) => item.id}
        filter={showAll ? null : (item: ModelListing, query: string) => `${item.id} ${item.name}`.toLowerCase().includes(query.toLowerCase())}
        openOnInputClick
      >
        <div className="relative" ref={anchor}>
          <Autocomplete.Input aria-labelledby="agent-model-label" className="code w-full pr-10" placeholder={placeholder} />
          <Autocomplete.Trigger aria-label="Show models" className="absolute inset-y-0 right-0 grid w-10 cursor-pointer place-items-center rounded-ctl text-dim hover:text-ink" onClick={() => setShowAll(true)}>
            <Icon name="chevron-down" size={14} />
          </Autocomplete.Trigger>
        </div>
        <Autocomplete.Portal>
          <Autocomplete.Positioner positionMethod="fixed" anchor={anchor} side="bottom" align="start" sideOffset={5} className="z-96 outline-none" collisionPadding={8}>
            <Autocomplete.Popup className="glass st-menu w-(--anchor-width) max-w-(--available-width) outline-none empty:hidden has-[>[role=listbox]:empty]:hidden">
              <Autocomplete.List className="max-h-72 overflow-y-auto">
                {(item: ModelListing) => (
                  <Autocomplete.Item key={item.id} value={item} disabled={item.offline} className="st-menu-item">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-mono text-[12px]">{item.id}</span>
                      <span className="block truncate text-[11.5px] text-dim">{`${item.name || item.id}${item.price ? ` · $${item.price.in.toFixed(2)}/$${item.price.out.toFixed(2)} per M` : ''}${item.tools === false ? ' · no tools' : ''}${item.offline ? ' · temporarily unavailable' : ''}`}</span>
                    </span>
                  </Autocomplete.Item>
                )}
              </Autocomplete.List>
            </Autocomplete.Popup>
          </Autocomplete.Positioner>
        </Autocomplete.Portal>
      </Autocomplete.Root>
    </Field>
  );
}

/** The fields that depend on the engine: model, sign-in, provider, profile, and how hard it thinks. */
function EngineFields({ a, d, set, fit }: {
  a: Agent;
  d: AppState;
  set: <K extends keyof Agent>(k: K, v: Agent[K]) => void;
  fit: (x: Agent) => void;
}) {
  const [models, setModels] = useState<ModelListing[]>([]);
  const [profiles, setProfiles] = useState<HermesProfile[]>([]);
  const [clawAgents, setClawAgents] = useState<OpenClawAgent[]>([]);
  const needs = a.engine === 'hermes' ? 'hermes' : a.engine === 'openclaw' ? 'openclaw' : null;
  useEffect(() => {
    let live = true;
    if (needs === 'hermes') void GET<HermesProfile[]>('/hermes/profiles').then((p) => live && setProfiles(p)).catch(() => {});
    if (needs === 'openclaw') void GET<OpenClawAgent[]>('/openclaw/agents').then((c) => live && setClawAgents(c)).catch(() => {});
    return () => void (live = false);
  }, [needs]);
  useEffect(() => {
    let live = true;
    const q = a.engine === 'eve' ? `engine=eve&provider=${a.provider}` : `engine=${a.engine}`;
    setModels([]);
    void GET<ModelListing[]>(`/models?${q}`)
      .catch((): ModelListing[] => [])
      .then((m) => live && setModels(m.slice(0, 600)));
    return () => void (live = false);
  }, [a.engine, a.provider]);
  const placeholder =
    a.engine === 'claude-code' ? 'sonnet' : a.engine === 'hermes' ? "profile's default" : a.engine === 'openclaw' ? "the OpenClaw agent's model" : a.engine === 'pi' || a.engine === 'omp' ? 'its default (e.g. anthropic/claude-sonnet-5-5)' : a.provider === 'venice' ? 'Choose a Venice model' : 'anthropic/claude-sonnet-5.5';
  const pick = (label: string, value: string, options: SelectOption[], onChange: (v: string) => void, hint?: ReactNode) => (
    <Field label={label} hint={hint}>
      <SelectControl aria-label={label} value={value} options={options} onChange={onChange} />
    </Field>
  );
  const modelEfforts = models.find((m) => m.id === a.model)?.reasoningEfforts;
  const showEffort = a.engine !== 'eve' || a.provider !== 'venice' || !!modelEfforts?.length;
  const model = (label: string, hint: string) => (
    <div className={showEffort ? 'col-span-full grid grid-cols-2 items-start gap-4 max-md:grid-cols-1' : 'col-span-full'}>
      <ModelInput label={label} hint={hint} value={a.model || ''} placeholder={placeholder} models={models} onChange={(value) => set('model', value)} />
      {showEffort ? pick(
        'Effort',
        effortFor(a.engine, a.effort, a.provider, modelEfforts),
        [{ value: '', label: "Model's default" }, ...effortLevels(a.engine, a.provider, modelEfforts).map((e) => ({ value: e, label: EFFORT_NAMES[e] }))],
        (v) => set('effort', v as Agent['effort']),
        'How hard the model thinks before it answers. More effort: better on hard work, but slower and uses more of your plan.',
      ) : null}
    </div>
  );
  let parts: ReactNode = null;
  if (a.engine === 'claude-code')
    parts = (
      <div className="grid grid-cols-2 gap-4 max-md:grid-cols-1">
        {model('Model', 'sonnet, opus, haiku, fable, or a full model id.')}
        {pick(
          'Sign in with',
          a.claudeAuth || 'login',
          [
            { value: 'login', label: 'My Claude login (subscription)' },
            { value: 'anthropic', label: `Anthropic API key${d.secrets.anthropicKey.set ? '' : ' (not set)'}` },
            { value: 'openrouter', label: `OpenRouter key${d.secrets.openrouterKey.set ? '' : ' (not set)'}` },
          ],
          (v) => set('claudeAuth', v as Agent['claudeAuth']),
          'With OpenRouter, use OpenRouter model ids like anthropic/claude-sonnet-5.5.',
        )}
      </div>
    );
  else if (a.engine === 'eve')
    parts = (
      <>
        <div className="grid grid-cols-2 gap-4 max-md:grid-cols-1">
          {pick(
            'Provider',
            a.provider || 'openrouter',
            [
              { value: 'openrouter', label: `OpenRouter${d.secrets.openrouterKey.set ? '' : ' (add key in Settings)'}` },
              { value: 'venice', label: `Venice${d.secrets.veniceKey?.set ? '' : ' (add key in Settings)'}` },
              { value: 'lmstudio', label: 'LM Studio (local)' },
              { value: 'ollama', label: 'Ollama (local)' },
              { value: 'custom', label: 'Custom OpenAI-compatible' },
              // each with its logo (Custom: a plug)
            ].map((o) => ({ ...o, mark: <ProgramGlyph id={o.value} size={16} /> })),
            // a server on this PC takes fewer effort levels
            (v) => fit({ ...a, provider: v, model: defaultModelForEngine('eve', d.settings.defaults, v) }),
          )}
          {model('Model', 'Start typing to search. Pick one that supports tools.')}
        </div>
        <Field label="Temperature">
          <input type="number" step="0.1" min="0" max="2" value={a.temperature ?? ''} placeholder="model default" onChange={(e) => set('temperature', (e.target.value === '' ? '' : Number(e.target.value)) as Agent['temperature'])} />
        </Field>
      </>
    );
  else if (a.engine === 'codex') {
    const cx: Partial<EngineStatus['codex']> = d.engines.codex || {};
    parts = (
      <>
        <div className="grid grid-cols-2 gap-4 max-md:grid-cols-1">
          {model('Model', "Empty = Codex's default. Pick one of the models Codex lists, or type an id.")}
          <div>
            <div className="label">Codex</div>
            <p className="hint">{cx.installed ? (cx.loggedIn ? `Signed in · ${cx.version || ''}` : 'Installed, not signed in yet: Settings > General > Sign in') : 'Not installed yet: Settings > General > Install Codex'}</p>
          </div>
        </div>
        <p className="hint">Codex runs in the workspace folder. Autonomy maps to its sandbox: Ask first = read-only, Auto = can edit the workspace, Full = no sandbox.</p>
      </>
    );
  } else if (a.engine === 'hermes')
    parts = (
      <>
        <div className="grid grid-cols-2 gap-4 max-md:grid-cols-1">
          {pick('Hermes profile', a.hermesProfile || '', [{ value: '', label: 'default' }, ...profiles.filter((p) => p.name !== 'default').map((p) => ({ value: p.name, label: `${p.name} (${p.model})` }))], (v) => set('hermesProfile', v), 'The profile brings its own memory, skills and tools.')}
          {model('Model override', "Leave empty to use the profile's model.")}
        </div>
        <p className="hint">Hermes uses its own tools. To give it the dashboard tools too, use "Give Hermes the dashboard tools" on the MCP servers page.</p>
      </>
    );
  else if (a.engine === 'pi' || a.engine === 'omp') {
    const name = a.engine === 'pi' ? 'pi' : 'oh-my-pi';
    const st: Partial<EngineStatus['pi']> = d.engines[a.engine] || {};
    parts = (
      <>
        <div className="grid grid-cols-2 gap-4 max-md:grid-cols-1">
          {model('Model', `Empty = ${name}'s default. Ids are provider/model, e.g. anthropic/claude-sonnet-5-5.`)}
          <div>
            <div className="label">{name}</div>
            <p className="hint">{st.installed ? `Found${st.version ? ` · ${st.version}` : ''}` : `Not installed yet: ${a.engine === 'pi' ? 'npm install -g @earendil-works/pi-coding-agent' : 'bun install -g @oh-my-pi/pi-coding-agent'}`}</p>
          </div>
        </div>
        <p className="hint">{`${name} works in the workspace folder with its own tools (read, bash, edit, write…) and runs them without asking, whatever the autonomy below says. Sign it in to a model provider in a terminal (/login). For the dashboard tools too, use "Give pi and oh-my-pi the dashboard tools" on the MCP servers page.`}</p>
      </>
    );
  } else if (a.engine === 'openclaw')
    parts = (
      <>
        <div className="grid grid-cols-2 gap-4 max-md:grid-cols-1">
          {pick('OpenClaw agent', a.openclawAgent || '', [{ value: '', label: 'its default agent' }, ...clawAgents.map((x) => ({ value: x.id, label: `${x.id}${x.model ? ` (${x.model})` : ''}${x.isDefault ? ' · default' : ''}` }))], (v) => set('openclawAgent', v), 'It brings its own memory, skills and tools.')}
          {model('Model override', "Leave empty to use the OpenClaw agent's model.")}
        </div>
        <p className="hint">Each chat here is its own OpenClaw session. It goes through your OpenClaw Gateway when it is running, else OpenClaw answers here on its own. OpenClaw's own approval settings apply to its tools.</p>
      </>
    );
  return <div className="flex flex-col gap-4">{parts}</div>;
}

/** What the agent knows: notes and files of its own, linked folders, saved web pages. */
function Knowledge({ id, synced }: { id: string; synced: (knowledge: Agent['knowledge']) => void }) {
  const [info, setInfo] = useState<{ folders: string[]; files: AgentDetail['knowledgeFiles'] } | null>(null);
  const load = useCallback(
    () =>
      rpc.agents.get({ id })
        .then((fresh) => {
          setInfo({ folders: fresh.knowledge?.folders || [], files: fresh.knowledgeFiles });
          synced(fresh.knowledge);
        })
        .catch(() => {}),
    [id],
  );
  useEffect(() => void load(), [load]);
  if (!info) return null;
  const total = info.files.reduce((n, f) => n + f.size, 0);
  const addNote = async () => {
    const name = await promptBox('Note name', { value: 'notes.md' });
    if (!name) return;
    const content = await promptBox(name, { multiline: true, placeholder: 'Facts, style guides, product details, anything this agent should know.' });
    if (content == null) return;
    await attempt(() => rpc.agents.knowledge.add({ id, name, content }), 'Added');
    await load();
  };
  const upload = async (files: FileList | null) => {
    for (const f of files || []) {
      if (f.size > 5_000_000) {
        toast(`${f.name} is over 5 MB; link its folder instead.`, 'warn');
        continue;
      }
      await attempt(() => f.text().then((content) => rpc.agents.knowledge.add({ id, name: f.name, content })));
    }
    toast('Uploaded');
    await load();
  };
  const addFolder = async () => {
    const folder = await promptBox('Link a folder or file', { label: 'Full path on this PC (the agent reads text files inside it)', placeholder: 'C:\\Users\\you\\Documents\\brand' });
    if (!folder) return;
    await attempt(() => rpc.agents.knowledge.add({ id, folder: folder.trim().replace(/^"|"$/g, '') }), 'Linked');
    await load();
  };
  const addUrl = async () => {
    const url = await promptBox('Save a web page as knowledge', { placeholder: 'https://…' });
    if (!url) return;
    await attempt(() => rpc.agents.knowledge.add({ id, url: url.trim() }), 'Saved');
    await load();
  };
  return (
    <div className="flex flex-col gap-3">
      <p className="hint m-0">
        {total <= 24000 ? 'Small knowledge is given to the agent in full with every message.' : 'Large knowledge: the agent searches it when needed (knowledge_search).'}
        {` ${info.files.length} file${info.files.length === 1 ? '' : 's'} · ${Math.round(total / 1024)} KB`}
      </p>
      {info.folders.map((f) => (
        <div key={f} className="list-row">
          <Icon name="folder" size={15} className="flex-none text-dim" />
          <div className="flex-1 min-w-0 font-mono text-[12.5px] wrap-anywhere">{f}</div>
          <Button variant="ghost" size="tiny" onClick={() => void attempt(() => rpc.agents.knowledge.remove({ id, folder: f })).then(load)}>Unlink</Button>
        </div>
      ))}
      {info.files
        .filter((f) => f.own)
        .map((f) => (
          <div key={f.label} className="list-row">
            <Icon name="file-text" size={15} className="flex-none text-dim" />
            <div className="flex-1 min-w-0">
              {f.label}
              <span className="hint">{` · ${Math.max(1, Math.round(f.size / 1024))} KB`}</span>
            </div>
            <Button variant="ghost" size="tiny" onClick={() => void attempt(() => rpc.agents.knowledge.remove({ id, label: f.label })).then(load)}>Remove</Button>
          </div>
        ))}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="small" onClick={() => void addNote()}><Icon name="pen-line" size={13} />Write a note</Button>
        <label className={buttonClass('ghost', 'small')}>
          <Icon name="upload" size={13} />
          Upload files
          <input type="file" multiple hidden onChange={(e) => void upload(e.target.files)} />
        </label>
        <Button variant="ghost" size="small" onClick={() => void addFolder()}><Icon name="folder-open" size={13} />Link a folder</Button>
        <Button variant="ghost" size="small" onClick={() => void addUrl()}><Icon name="globe" size={13} />From a web page</Button>
      </div>
    </div>
  );
}

export const title = (params: string[] = []): string => (params[1] === 'edit' ? 'Edit agent' : 'Agents');
export const { render, unmount } = reactPage((params) => (params[0] && params[1] === 'edit' ? <ProjectScoped><AgentEditor id={params[0]} /></ProjectScoped> : <AgentsList />));
