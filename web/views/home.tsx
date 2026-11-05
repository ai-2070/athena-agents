// Home: what's happening, what needs you, and a quick way to give any agent a task.
import { Plate, PlateLink } from '../ui/surface.tsx';
import { Button, ButtonLink } from '../ui/button.tsx';
import { Dot } from '../ui/marks.tsx';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { GET, attempt, ago, navigate, approvalCard } from '../core.ts';
import { rpc } from '../client/rpc.ts';
import { Avatar, DomNode, Icon, reactPage, useAppState, useServerEvents } from '../ui/react.tsx';
import { SelectControl } from '../ui/select.tsx';
import type { ActivityEntry, AppState } from '../../shared/types.ts';
import { appIconStyle, appIconUrl } from '../appicons.ts';

/** One entry of GET /api/programs (only the fields this page reads). */
interface ProgramInfo {
  id: string;
  name: string;
  icon: string;
  installed: boolean;
  running: boolean;
  serviceUrl: string | null;
  version: string | null;
}

const SERVICES = ['comfyui', 'lmstudio', 'ollama', 'netdesk', 'orca', 'blender', 'premiere', 'photoshop'];
const KIND_ICON: Record<string, string> = { run: 'play', error: 'circle-x', approval: 'hand', social: 'send', workflow: 'workflow', program: 'monitor', mcp: 'plug', library: 'store', terminal: 'terminal', system: 'clock', notify: 'bell', skill: 'puzzle' };
/** The newest activity kept on the page. */
const KEEP = 200;

// the quick task keeps its text and choice while you move around the app
const quick = { text: '', agentId: '' };

function HomePage() {
  const d = useAppState();
  const [progs, setProgs] = useState<ProgramInfo[] | null>(null);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  useEffect(() => {
    void GET<ProgramInfo[]>('/programs').then(setProgs).catch(() => setProgs([]));
    void rpc.status.activity().then(setActivity).catch(() => {});
  }, []);
  useServerEvents((ev) => ev.type === 'activity' && setActivity((a) => [ev.entry as ActivityEntry, ...a].slice(0, KEEP)));
  if (!d) return null;
  const agents = d.agents || [];
  const needs = d.approvals.length + d.outboxPending + (d.questions?.length || 0);
  const services = (progs || []).filter((p) => p.installed && SERVICES.includes(p.id));
  return (
    <>
      <div className="stats mb-8 grid grid-cols-4 gap-4 max-lg:grid-cols-2">
        <Stat label="Agents" num={agents.length} href="#/agents" />
        <Stat label="Working now" num={d.runs.length} kind={d.runs.length ? 'live' : ''} />
        <Stat label="Needs you" num={needs} kind={needs ? 'hot' : ''} onClick={() => document.getElementById('drawer')!.classList.remove('hidden')} />
        <Stat label="X accounts" num={d.accounts.x.length} href="#/settings?tab=connections" />
      </div>
      {!agents.length ? <Onboarding d={d} /> : null}
      <div className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] items-start gap-6 max-lg:grid-cols-1">
        <div className="flex flex-col gap-6 [&>.panel]:mt-0 [&>.panel>:last-child]:mb-0">
          {agents.length ? <QuickTask d={d} /> : null}
          {d.approvals.length ? (
            <Plate className="panel">
              <div className="panel-head">
                <h2>Needs you</h2>
              </div>
              <div className="flex flex-col gap-3">
                {d.approvals.map((a) => (
                  <DomNode key={a.id} make={() => approvalCard(a)} deps={[JSON.stringify(a)]} />
                ))}
              </div>
            </Plate>
          ) : null}
          {d.runs.length ? (
            <Plate className="panel">
              <div className="panel-head">
                <h2>Working now</h2>
              </div>
              <div className="list">
                {d.runs.map((r) => {
                  const a = agents.find((x) => x.id === r.agentId);
                  return (
                    <div key={r.id} className="list-row">
                      {a ? <Avatar agent={a} /> : null}
                      <div className="flex-1 min-w-0">
                        <div className="title">{r.agentName}</div>
                        <div className="hint">{`started ${ago(r.startedAt)}`}</div>
                      </div>
                      <ButtonLink variant="ghost" size="small" href={`#/agents/${r.agentId}/${r.chatId}`}>Watch</ButtonLink>
                    </div>
                  );
                })}
              </div>
            </Plate>
          ) : null}
          {agents.length ? (
            <Plate className="panel">
              <div className="panel-head">
                <h2>Your agents</h2>
                <div className="actions">
                  <ButtonLink variant="ghost" size="small" href="#/agents">All agents</ButtonLink>
                </div>
              </div>
              <div className="cards grid-cols-[repeat(auto-fill,minmax(200px,1fr))]">
                {agents.slice(0, 8).map((a) => (
                  <PlateLink key={a.id} className="card hover:shadow-none clickable" href={`#/agents/${a.id}`}>
                    <div className="card-top">
                      <Avatar agent={a} />
                      <div className="flex-1 min-w-0">
                        <div className="card-title">{a.name}</div>
                        <div className="card-sub line-clamp-2">{a.specialty || ''}</div>
                      </div>
                    </div>
                    {d.runs.some((r) => r.agentId === a.id) ? (
                      <span className="corner" aria-label="working">
                        <Dot tone="busy" />
                      </span>
                    ) : null}
                  </PlateLink>
                ))}
              </div>
            </Plate>
          ) : null}
        </div>
        <div className="flex flex-col gap-6 [&>.panel]:mt-0 [&>.panel>:last-child]:mb-0">
          <Plate className="panel">
            <div className="panel-head">
              <h2>Programs</h2>
              <div className="actions">
                <ButtonLink variant="ghost" size="small" href="#/settings?tab=programs">All programs</ButtonLink>
              </div>
            </div>
            {services.length ? (
              <div className="list">
                {services.map((p) => (
                  <div key={p.id} className="list-row">
                    <span className="w-6 text-center">{appIconUrl(p.id) ? <img className="app-icon inline-block align-middle" src={appIconUrl(p.id)!} width={20} height={20} alt="" style={appIconStyle(p.id)} /> : p.icon}</span>
                    <div className="flex-1 min-w-0">
                      <div className="title">{p.name}</div>
                      <div className="hint">{p.running ? (p.serviceUrl ? `running · ${p.serviceUrl}` : 'running') : p.version ? `v${p.version}` : 'installed'}</div>
                    </div>
                    <Dot tone={p.running ? 'on' : 'off'} />
                  </div>
                ))}
              </div>
            ) : (
              <p className="empty">{progs ? 'None of the usual programs found.' : 'Scanning…'}</p>
            )}
          </Plate>
          <Plate className="panel">
            <div className="panel-head">
              <h2>Activity</h2>
            </div>
            <div className="list">
              {activity.length ? (
                activity.slice(0, 40).map((a, i) => (
                  <div key={`${a.ts}:${i}`} className="list-row">
                    <span className={`flex-none ${a.kind === 'error' ? 'text-red' : 'text-faint'}`}>
                      <Icon name={KIND_ICON[a.kind] || 'clock'} size={15} />
                    </span>
                    <div className="home-activity flex-1 min-w-0 text-[13.5px]">{a.text}</div>
                    <span className="whitespace-nowrap text-[12px] text-faint tabular-nums">{ago(a.ts)}</span>
                  </div>
                ))
              ) : (
                <p className="empty">Nothing yet.</p>
              )}
            </div>
          </Plate>
        </div>
      </div>
    </>
  );
}

const NUM = 'num mt-3.5 text-[28px] leading-none font-semibold tracking-tight text-ink tabular-nums';

/** A number at the top. With href or onClick it is a link or a button to where that number lives.
 *  kind: live (something is running) or hot (it needs you) put a small dot by the caption. */
function Stat({ label, num, kind = '', href, onClick }: { label: string; num: number; kind?: string; href?: string; onClick?: () => void }) {
  // stat and num stay for the tests
  const base = 'stat glass-plate block w-full rounded-box px-5 py-4 text-left text-ink [font:inherit]';
  const cls = href || onClick ? `${base} cursor-pointer transition-colors hover:bg-panel-2 hover:text-ink` : base;
  const body: ReactNode = (
    <>
      <div className="flex items-center justify-between gap-2">
        <div className="label">{label}</div>
        {kind === 'live' ? <Dot tone="busy" /> : kind === 'hot' ? <Dot tone="warn" /> : null}
      </div>
      <div className={NUM}>{num}</div>
    </>
  );
  if (href) return <a className={cls} href={href}>{body}</a>;
  if (onClick) return <button type="button" className={cls} onClick={onClick}>{body}</button>;
  return <div className={cls}>{body}</div>;
}

function QuickTask({ d }: { d: AppState }) {
  const agents = d.agents;
  const [text, setText] = useState(quick.text);
  const [agentId, setAgentId] = useState(() => (agents.some((a) => a.id === quick.agentId) ? quick.agentId : agents[0].id));
  const box = useRef<HTMLTextAreaElement>(null);
  const send = () =>
    attempt(async () => {
      const t = text.trim();
      if (!t || !agentId) return;
      const chat = await rpc.agents.chats.create({ id: agentId });
      await rpc.agents.chats.send({ id: agentId, chatId: chat.id, text: t });
      quick.text = '';
      navigate(`#/agents/${agentId}/${chat.id}`);
    });
  return (
    <Plate className="panel">
      <div className="panel-head">
        <h2>Give an agent a task</h2>
      </div>
      <div className="max-w-75">
        <SelectControl aria-label="Agent" value={agentId} onChange={(value) => setAgentId((quick.agentId = value))} options={agents.map((a) => ({ value: a.id, label: `${a.emoji || ''} ${a.name}` }))} />
      </div>
      <div className="mt-4">
        <textarea
          ref={box}
          rows={3}
          aria-label="Task"
          value={text}
          placeholder="Tell an agent what to do…  (Ctrl+Enter to send)"
          onChange={(e) => setText((quick.text = e.target.value))}
          onKeyDown={(e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && void send()}
        />
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <span className="hint">Opens a new chat with that agent.</span>
        <Button  onClick={() => void send()}>Send</Button>
      </div>
    </Plate>
  );
}

function Onboarding({ d }: { d: AppState }) {
  const [adding, setAdding] = useState(false);
  // One click: the library's agents marked starter (Coordinator, X Writer, Image Maker, Researcher…).
  const addStarterTeam = async () => {
    setAdding(true);
    const lib = await rpc.library.list().catch(() => null);
    for (const a of (lib?.agents || []).filter((x) => x.starter)) await attempt(() => rpc.library.hire({ source: 'library', slug: a.slug }));
    navigate('#/agents');
  };
  const steps = [
    { done: d.engines['claude-code'].installed || (d.secrets.openrouterKey.set || !!d.secrets.veniceKey?.set), text: 'Pick how agents think: use Claude Code on this PC, or add an OpenRouter or Venice key for API models.', href: '#/settings', cta: 'Settings' },
    { done: false, text: 'Add agents: start with the Athena team, or hire specialists from the Agent library.', href: '#/library', cta: 'Open library' },
    { done: d.accounts.x.length > 0, text: 'Connect your X account so agents can draft posts for you to approve.', href: '#/settings?tab=connections', cta: 'Connections' },
    { done: false, text: 'Give agents more abilities: browser control, files, GitHub and any MCP server.', href: '#/settings?tab=mcp', cta: 'MCP servers' },
  ];
  return (
    <div className="panel mb-8">
      <div className="panel-head">
        <h2>Get started</h2>
      </div>
      <ol className="list home-steps">
        {steps.map((s, i) => (
          <li key={s.cta} className="list-row">
            <span className={`w-6 text-[13px] tabular-nums ${s.done ? 'text-ok' : 'text-faint'}`} aria-label={s.done ? 'done' : `step ${i + 1}`}>{s.done ? '✓' : `0${i + 1}`}</span>
            <div className="flex-1 min-w-0">{s.text}</div>
            {i === 1 ? <Button size="small" disabled={adding} onClick={() => void addStarterTeam()}>Add Athena team</Button> : null}
            <ButtonLink variant="ghost" size="small" href={s.href}>{s.cta}</ButtonLink>
          </li>
        ))}
      </ol>
    </div>
  );
}

export const title = () => 'Home';
export const { render, unmount } = reactPage(() => <HomePage />);
