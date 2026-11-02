// Agent library: ready-made agents. Athena's own (made for this dashboard's tools), The Agency (msitarzewski/agency-agents), Hermes profiles, Claude Code subagents,
// and your presets. A React page on Base UI controls.
import { defaultModelForEngine } from '../../shared/modeldefaults.ts';
import { Plate } from '../ui/surface.tsx';
import { Bone, Skeleton } from '../ui/skeleton.tsx';
import { Button, ButtonLink } from '../ui/button.tsx';
import { Pill } from '../ui/marks.tsx';
import { useEffect, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { h, GET, POST, PUT, DEL, attempt, navigate, md, modal, toast, refreshSoon, confirmBox } from '../core.ts';
import { Chips, SearchBox, Segmented, Tabs } from '../ui/controls.tsx';
import { domButton } from '../ui/dom.ts';
import { Icon, reactPage, useAppState } from '../ui/react.tsx';
import { modelInfo, openModelPicker } from '../models.tsx';
import type { ModelPatch } from '../models.tsx';
import type { Agent, AppState, EngineId, PresetListing, Team } from '../../shared/types.ts';

/** An agent of The Agency as GET /api/library lists it (server/library.ts AgencyAgent without file). */
interface AgencyListing {
  slug: string;
  name: string;
  description: string;
  emoji: string;
  color: string;
  vibe: string;
  division: string;
  divisionLabel: string;
}
/** A Hermes profile (`hermes profile list`). */
interface HermesProfile {
  name: string;
  model: string;
  gateway: string;
  isDefault: boolean;
}
/** A Claude Code subagent (server/library.ts ClaudeSubagent without file). */
interface ClaudeSubagentListing {
  slug: string;
  name: string;
  description: string;
  model: string;
}
interface StarterListing {
  name: string;
  emoji: string;
  specialty: string;
}
/** GET /api/library */
interface LibraryIndex {
  agency: { agents: AgencyListing[] };
  hermes: HermesProfile[];
  claude: ClaudeSubagentListing[];
  starters: StarterListing[];
}
type Overrides = Pick<Agent, 'engine' | 'model'> & Partial<Pick<Agent, 'provider' | 'effort'>>;
type HirePayload = { source: 'starter'; name: string; overrides: Overrides } | { source: 'agency'; slug: string; overrides: Overrides } | { source: 'hermes'; profile: string } | { source: 'claude'; slug: string };
type Tab = 'starters' | 'agency' | 'hermes' | 'claude' | 'presets';

// Kept while you move around the app, as before.
let lastTab: Tab = 'agency';
let lastQuery = '';
let lastDivision = '';
/** The Agency's cards shown at once; search to see others. */
const SHOWN = 240;

const params = () => new URLSearchParams(location.hash.split('?')[1] || '');
// Opened from a Station branch (#/library?branch=id): new hires join that branch.
const branchParam = () => params().get('branch');

function overrides(engine: EngineId, data: AppState, choice: ModelPatch | null): Overrides {
  const d = data.settings.defaults;
  return {
    engine,
    model: engine === 'eve' ? choice?.model || defaultModelForEngine(engine, d, choice?.provider) : defaultModelForEngine(engine, d),
    ...(engine === 'eve' && choice ? { provider: choice.provider, effort: choice.effort } : {}),
  };
}

async function hire(payload: HirePayload, name: string): Promise<Agent | undefined> {
  const a = await attempt(() => POST<Agent>('/library/hire', payload));
  if (!a) return;
  refreshSoon(0);
  const branch = branchParam();
  if (branch) {
    const wf = await GET<Team>(`/workflows/${branch}`).catch(() => null);
    if (wf) {
      wf.members = [...new Set([...(wf.members || []), a.id])];
      // the step list mirrors members (the Team editor and runs use it)
      const steps = wf.steps || [];
      if (!steps.some((s) => s.type === 'agent' && s.agentId === a.id)) wf.steps = [...steps, { id: Math.random().toString(36).slice(2), type: 'agent', agentId: a.id, prompt: steps.length ? 'Continue from this:\n{{prev}}' : '{{input}}' }];
      await PUT(`/workflows/${branch}`, wf).catch(() => {});
      toast(`${name} joined the ${wf.name} team`);
      return a;
    }
  }
  toast(`${name} joined your team`);
  return a;
}

async function preview(a: AgencyListing, doHire: () => unknown) {
  const full = await attempt(() => GET<{ body: string }>(`/library/agency/${a.slug}`));
  if (!full) return;
  const m = modal({
    title: `${a.emoji} ${a.name}`,
    body: h('div.msg.assistant', md(full.body.replace(/^---[\s\S]*?---/, ''))),
    foot: [domButton({ variant: 'ghost', onclick: () => m.close() }, 'Close'), domButton({ onclick: () => (m.close(), doHire()) }, 'Hire')],
  });
}

/** A tab with nothing in it: one line, and what to do about it. */
function Empty({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-4 py-12 text-center">
      <p className="m-0 max-w-[48ch] text-dim">{children}</p>
      {action}
    </div>
  );
}

// ---------- while it loads: the page's shape ----------
const LEDE = 'Hire a specialist and it joins your team with its instructions already written. You can change anything afterwards.';
const TAB_W = ['w-20', 'w-32', 'w-30', 'w-44', 'w-28'];
const CHIP_W = ['w-11', 'w-22', 'w-17', 'w-25', 'w-19', 'w-36', 'w-13', 'w-27', 'w-24', 'w-25', 'w-20', 'w-36', 'w-22', 'w-15'];
const TITLE_W = ['w-32', 'w-28', 'w-24', 'w-36'];

function LibrarySkeleton() {
  return (
    <Skeleton label="Loading library…">
      <p className="lede max-w-[68ch]">{LEDE}</p>
      <div className="flex gap-7 border-b border-line px-4 pt-2 pb-3.5">
        {TAB_W.map((w, i) => <Bone key={i} className={`h-4 ${w}`} />)}
      </div>
      <div className="mt-8 flex flex-wrap items-center gap-3">
        <Bone className="h-10 w-[min(400px,100%)]" />
        <Bone className="ml-auto h-10 w-[560px] max-xl:hidden" />
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        {CHIP_W.map((w, i) => <Bone key={i} className={`h-8 rounded-full ${w}`} />)}
      </div>
      <div className="cards mt-6">
        {Array.from({ length: 8 }, (_, i) => (
          <Plate key={i} className="card hover:shadow-none">
            <div className="card-top">
              <Bone className="size-11 rounded-[11px]" />
              <div className="flex min-w-0 flex-1 flex-col gap-2 pt-1">
                <Bone className={`h-4 ${TITLE_W[i % TITLE_W.length]}`} />
                <Bone className="h-3 w-16" />
              </div>
            </div>
            <div className="flex flex-col gap-2 py-1">
              <Bone className="h-3 w-full" />
              <Bone className="h-3 w-3/5" />
            </div>
            <div className="card-foot">
              <Bone className="h-7 w-14" />
              <Bone className="h-7 w-15" />
            </div>
          </Plate>
        ))}
      </div>
    </Skeleton>
  );
}

// ---------- the page ----------
function LibraryPage() {
  const data = useAppState();
  const [lib, setLib] = useState<LibraryIndex | null>(null);
  const [presets, setPresets] = useState<PresetListing[]>([]);
  const [failed, setFailed] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>(() => (params().get('tab') === 'presets' ? 'presets' : lastTab));
  const [engine, setEngine] = useState<EngineId>(() => data?.settings?.defaults?.engine || 'claude-code');
  const [apiChoice, setApiChoice] = useState<ModelPatch | null>(null);

  useEffect(() => {
    let live = true;
    Promise.all([GET<LibraryIndex>('/library'), GET<PresetListing[]>('/presets').catch((): PresetListing[] => [])])
      .then(([l, p]) => live && (setLib(l), setPresets(p)))
      .catch((e: unknown) => live && setFailed(e instanceof Error ? e.message : String(e)));
    return () => void (live = false);
  }, []);

  if (failed) return <Plate className="panel"><p className="text-red">Something went wrong: {failed}</p></Plate>;
  if (!lib || !data) return <LibrarySkeleton />;

  const pick = (t: Tab) => setTab((lastTab = t));
  const tabs = [
    { value: 'starters' as const, label: `Athena (${lib.starters.length})` },
    { value: 'agency' as const, label: `The Agency (${lib.agency.agents.length})` },
    { value: 'hermes' as const, label: `Hermes profiles (${lib.hermes.length})` },
    { value: 'claude' as const, label: `Claude Code subagents (${lib.claude.length})` },
    { value: 'presets' as const, label: `Your presets (${presets.length})` },
  ];
  const runsOn =
    tab === 'agency' || tab === 'starters' ? (
      <div className="ml-auto flex flex-wrap items-center gap-3">
        <span className="label">Runs on</span>
        <Segmented label="Runs on" options={data.engineList.map((e) => ({ value: e.id, label: e.label }))} value={engine} onChange={setEngine} />
        {engine === 'eve' ? <Button variant="ghost" size="small" onClick={(event) => openModelPicker(event.currentTarget, apiChoice || { engine: 'eve', provider: 'openrouter', model: data.settings.defaults.openrouterModel }, setApiChoice, { title: 'Model for new hires', engines: ['eve'] })}>
          {apiChoice ? `${modelInfo(apiChoice).where} · ${modelInfo(apiChoice).short}` : 'Choose API model'}
        </Button> : null}
      </div>
    ) : null;
  const ov = () => overrides(engine, data, apiChoice);

  return (
    <>
      <p className="lede max-w-[68ch]">{LEDE}</p>
      {branchParam() ? (
        <Plate className="panel mb-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>Hiring into a Station team: new hires are added as its next step.</span>
            <ButtonLink variant="ghost" size="small" href="#/station">Back to Station</ButtonLink>
          </div>
        </Plate>
      ) : null}
      <Tabs label="Agent library" tabs={tabs} value={tab} onChange={pick} rowClassName="[&_.tabs]:flex-1">
        {tab === 'starters' ? <Starters lib={lib} overrides={ov} runsOn={runsOn} /> : null}
        {tab === 'agency' ? <Agency lib={lib} overrides={ov} runsOn={runsOn} /> : null}
        {tab === 'hermes' ? <Hermes lib={lib} data={data} /> : null}
        {tab === 'claude' ? <Claude lib={lib} /> : null}
        {tab === 'presets' ? <Presets presets={presets} reload={() => GET<PresetListing[]>('/presets').then(setPresets)} /> : null}
      </Tabs>
    </>
  );
}

/** A card's buttons: one to add it, then Chat and Edit for the agent it made. */
function HireFoot({ onHire, children }: { onHire: () => Promise<Agent | undefined>; children: (hire: () => void) => ReactNode }) {
  const [hired, setHired] = useState<Agent | null>(null);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    if (busy) return;
    setBusy(true);
    const a = await onHire();
    setBusy(false);
    if (a) setHired(a);
  };
  return (
    <div className="card-foot">
      {hired ? (
        <>
          <Button size="small" onClick={() => navigate(`#/agents/${hired.id}`)}>Chat</Button>
          <Button variant="ghost" size="small" onClick={() => navigate(`#/agents/${hired.id}/edit`)}>Edit</Button>
        </>
      ) : (
        children(go)
      )}
    </div>
  );
}

function Card({ top, sub, foot }: { top: ReactNode; sub?: ReactNode; foot: ReactNode }) {
  return (
    <Plate className="card hover:shadow-none">
      <div className="card-top">{top}</div>
      {sub}
      {foot}
    </Plate>
  );
}

function Starters({ lib, overrides: ov, runsOn }: { lib: LibraryIndex; overrides: () => Overrides; runsOn: ReactNode }) {
  return (
    <>
      <div className="mb-6 flex flex-wrap items-center gap-3">{runsOn}</div>
      <div className="cards">
      {lib.starters.map((s) => (
        <Card
          key={s.name}
          top={
            <>
              <div className="avatar lg">{s.emoji}</div>
              <div className="flex-1 min-w-0">
                <div className="card-title">{s.name}</div>
                <div className="card-sub">{s.specialty}</div>
              </div>
            </>
          }
          foot={<HireFoot onHire={() => hire({ source: 'starter', name: s.name, overrides: ov() }, s.name)}>{(go) => <Button size="small" onClick={go}>Add</Button>}</HireFoot>}
        />
      ))}
      </div>
    </>
  );
}

function Agency({ lib, overrides: ov, runsOn }: { lib: LibraryIndex; overrides: () => Overrides; runsOn: ReactNode }) {
  const [query, setQuery] = useState(lastQuery);
  const [division, setDivision] = useState(lastDivision);
  const divisions = [...new Map(lib.agency.agents.map((a) => [a.division, a.divisionLabel])).entries()];
  const q = query.toLowerCase();
  const list = lib.agency.agents.filter((a) => (!division || a.division === division) && (!q || `${a.name} ${a.description} ${a.vibe}`.toLowerCase().includes(q)));
  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <SearchBox className="w-[min(400px,100%)]" autoFocus label="Search the specialists" placeholder={'Search 270+ specialists: "tiktok", "unity", "seo", "security"…'} value={query} onChange={(v) => setQuery((lastQuery = v))} />
        {runsOn}
      </div>
      {/* (a toggle's value can't be empty, so All is 'all') */}
      <Chips
        label="Division"
        className="mt-4"
        options={[{ value: 'all', label: 'All' }, ...divisions.map(([value, label]) => ({ value, label }))]}
        value={division || 'all'}
        onChange={(d) => setDivision((lastDivision = d === 'all' ? '' : d))}
      />
      <div className="mt-6">
        <div className="cards">
          {list.slice(0, SHOWN).map((a) => {
            const doHire = () => hire({ source: 'agency', slug: a.slug, overrides: ov() }, a.name);
            return (
              <Card
                key={a.slug}
                top={
                  <>
                    <div className="avatar" style={{ '--agent-color': a.color || 'var(--color-accent)' } as CSSProperties}>{a.emoji}</div>
                    <div className="flex-1 min-w-0">
                      <div className="card-title">{a.name}</div>
                      <div className="label mt-0.5">{a.divisionLabel}</div>
                    </div>
                  </>
                }
                sub={<div className="card-sub">{a.vibe || a.description}</div>}
                foot={
                  <HireFoot onHire={doHire}>
                    {(go) => (
                      <>
                        <Button size="small" onClick={go}>Hire</Button>
                        <Button variant="ghost" size="small" onClick={() => void preview(a, go)}>Read</Button>
                      </>
                    )}
                  </HireFoot>
                }
              />
            );
          })}
          {list.length > SHOWN ? <p className="hint">Showing {SHOWN} of {list.length}. Search to narrow down.</p> : null}
          {!list.length ? <div className="empty col-span-full py-12">No agent matches.</div> : null}
        </div>
      </div>
    </>
  );
}

function Hermes({ lib, data }: { lib: LibraryIndex; data: AppState }) {
  if (!lib.hermes.length) return <Empty>{data.engines.hermes.installed ? 'No Hermes profiles found.' : 'Hermes is not installed on this PC.'}</Empty>;
  const have = new Set(data.agents.filter((a) => a.engine === 'hermes').map((a) => a.hermesProfile || 'default'));
  return (
    <>
      <p className="hint mb-6 max-w-[68ch]">Each Hermes profile keeps its own memory, skills and tools. Add one to chat with it here, use it in workflows, or let other agents ask it for help.</p>
      <div className="cards">
        {lib.hermes.map((p) => (
          <Card
            key={p.name}
            top={
              <>
                <div className="avatar">☤</div>
                <div className="flex-1 min-w-0">
                  <div className="card-title">{p.name}</div>
                  <div className="card-sub">{`${p.model} · gateway ${p.gateway}${p.isDefault ? ' · default' : ''}`}</div>
                </div>
              </>
            }
            foot={
              have.has(p.name) ? (
                <div className="card-foot"><Pill tone="ok">on your team</Pill></div>
              ) : (
                <HireFoot onHire={() => hire({ source: 'hermes', profile: p.name }, p.name)}>{(go) => <Button size="small" onClick={go}>Add as agent</Button>}</HireFoot>
              )
            }
          />
        ))}
      </div>
    </>
  );
}

function Claude({ lib }: { lib: LibraryIndex }) {
  return (
    <>
      <p className="hint mb-6 max-w-[68ch]">Subagents saved in ~/.claude/agents. Import one as a dashboard agent, or go the other way with "Install in Claude Code" on any agent.</p>
      {lib.claude.length ? (
        <div className="cards">
          {lib.claude.map((s) => (
            <Card
              key={s.slug}
              top={
                <>
                  <div className="avatar">✳️</div>
                  <div className="flex-1 min-w-0">
                    <div className="card-title">{s.name}</div>
                    <div className="card-sub">{s.description}</div>
                  </div>
                </>
              }
              foot={<HireFoot onHire={() => hire({ source: 'claude', slug: s.slug }, s.name)}>{(go) => <Button size="small" onClick={go}>Import</Button>}</HireFoot>}
            />
          ))}
        </div>
      ) : (
        <Empty>No Claude Code subagents found.</Empty>
      )}
    </>
  );
}

// Agents and teams you saved as presets: make a fresh copy in this project.
function Presets({ presets, reload }: { presets: PresetListing[]; reload: () => Promise<unknown> }) {
  const [busy, setBusy] = useState<string | null>(null);
  const use = async (p: PresetListing) => {
    setBusy(p.id);
    const r = await attempt(() => POST<{ agent?: Agent; team?: Team }>(`/presets/${p.id}/use`), p.kind === 'team' ? `Team "${p.name}" created with ${p.members!.length} agents` : `${p.name} created`);
    setBusy(null);
    if (!r) return;
    refreshSoon(0);
    if (r.agent) navigate(`#/agents/${r.agent.id}/edit`);
    else navigate(`#/station?team=${r.team!.id}`);
  };
  const del = async (p: PresetListing) => {
    if (!(await confirmBox(`Delete the preset "${p.name}"? Agents and teams made from it stay.`, { ok: 'Delete', danger: true }))) return;
    if (await attempt(() => DEL(`/presets/${p.id}`), 'Deleted')) await reload();
  };
  const card = (p: PresetListing) => (
    <Card
      key={p.id}
      top={
        <>
          {p.kind === 'team' ? (
            <div className="avatar" style={{ '--agent-color': p.color || 'var(--color-accent)', color: p.color || 'var(--color-accent)' } as CSSProperties}><Icon name="users" size={18} /></div>
          ) : (
            <div className="avatar">{p.emoji || '🤖'}</div>
          )}
          <div className="flex-1 min-w-0">
            <div className="card-title">{p.name}</div>
            <div className="hint">{p.kind === 'team' ? `Team · ${p.members!.length} agents${p.lead ? ` · ★ ${p.lead}` : ''}` : 'Agent'}</div>
          </div>
        </>
      }
      sub={
        <>
          {p.description ? <div className="card-sub">{p.description}</div> : null}
          {p.kind === 'team' ? <div className="my-1 flex flex-wrap gap-2">{p.members!.map((m) => <Pill key={m.name}>{`${m.emoji || ''} ${m.name}`}</Pill>)}</div> : null}
          {p.skills?.length ? <div className="hint">{`${p.skills.length} skill${p.skills.length === 1 ? '' : 's'}`}</div> : null}
        </>
      }
      foot={
        <div className="card-foot">
          <Button size="small" disabled={busy === p.id} onClick={() => void use(p)}>
            <Icon name="plus" size={13} />
            {p.kind === 'team' ? 'Create this team' : 'Create this agent'}
          </Button>
          <span className="flex-1 min-w-0" />
          <Button variant="danger" size="small" title="Delete preset" aria-label={`Delete the preset ${p.name}`} onClick={() => void del(p)}>
            <Icon name="trash-2" size={13} />
          </Button>
        </div>
      }
    />
  );
  const teamsP = presets.filter((p) => p.kind === 'team');
  const agentsP = presets.filter((p) => p.kind === 'agent');
  return (
    <>
      <p className="hint mb-6 max-w-[68ch]">Save any agent or team as a preset (its panel on the Station, or right-click it). Presets work in every project: each use makes fresh copies here.</p>
      {!presets.length ? <p className="empty py-12">No presets yet.</p> : null}
      {teamsP.length ? (
        <>
          <h2 className="section mt-2">{`Teams (${teamsP.length})`}</h2>
          <div className="cards">{teamsP.map(card)}</div>
        </>
      ) : null}
      {agentsP.length ? (
        <>
          <h2 className="section mt-10">{`Agents (${agentsP.length})`}</h2>
          <div className="cards">{agentsP.map(card)}</div>
        </>
      ) : null}
    </>
  );
}

/** Forgets the remembered tab, search and division (tests). */
export function resetLibrary(): void {
  lastTab = 'agency';
  lastQuery = '';
  lastDivision = '';
}

// ---------- the router's view ----------
export const title = () => 'Agent library';
export const { render, unmount } = reactPage(() => <LibraryPage />);
