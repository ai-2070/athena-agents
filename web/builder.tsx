// Team builder: name it, give it a goal, pick its agents and lead (or let the Brain build it), choose its access.
// React now: openModal() with React content and the app's shared controls, mounted and drawn the way the
// wizard was before. It holds its draft in one object and redraws by hand, so Save reads exactly what is shown.
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { GET, POST, PUT, attempt, state, toast, refreshSoon } from './core.ts';
import type { ModalHandle } from './core.ts';
import { teamSteps } from '../shared/teams.ts';
import { mcpOptions } from './mcpcopies.ts';
import { attachTray, baseName, isFolderPath } from './attach.tsx';
import type { AttachTray } from './attach.tsx';
import { openModal } from './ui/overlays.tsx';
import { Button } from './ui/button.tsx';
import { ChipSet, Field } from './ui/controls.tsx';
import { Pill } from './ui/marks.tsx';
import { Avatar, DomNode, Icon } from './ui/react.tsx';
import { PlateSection } from './ui/surface.tsx';
import type { Agent, Team, TeamAccess, TeamStep } from '../shared/types.ts';

/** An agent the Brain designed (POST /api/assist/agent), not created yet. */
export type AgentDraft = Pick<Agent, 'name' | 'emoji' | 'specialty' | 'systemPrompt' | 'toolGroups' | 'mcpServers' | 'engine'>;
/** A team member: an existing agent, or one the Brain suggests hiring. */
export type BranchMember = { agentId: string; newAgent?: undefined } | { newAgent: AgentDraft; agentId?: undefined };
/** A team the Brain designed (POST /api/assist/branch). leadIndex points into members (-1 = no lead). */
export interface BranchDesign {
  name: string;
  description: string;
  access: TeamAccess;
  members: BranchMember[];
  leadIndex: number;
}
export interface BranchBuilderOptions {
  wf?: Team | null;
  prefill?: Partial<BranchDesign> | null;
  describe?: string;
  /** Files already uploaded (e.g. attached in the Brain chat) that the team starts with. */
  files?: string[];
  onSaved?: (wf: Team) => unknown;
}

// a member's ★ (lead) and ✕ buttons
const STEP_BTN = 'size-7 rounded-ctl p-0 border cursor-pointer text-[12px] hover:enabled:text-ink hover:enabled:bg-panel-2 disabled:opacity-30 disabled:cursor-default';

const PALETTE = ['#3d58c0', '#b0508a', '#c07a34', '#3a8a7a', '#7350c8', '#b8a03a', '#4f7fa8', '#5a9a3a', '#a84a5a', '#2f8fa0'];

/** One boxed part of the dialog: an icon and a title (and a count or the like at the end), then its content. */
function BuilderSection({ title, ico, end, children }: { title: string; ico: string; end?: ReactNode; children: ReactNode }) {
  return (
    <PlateSection className="flex flex-col gap-4 rounded-box p-5">
      <div className="flex items-center gap-2.5 text-[14px] font-semibold text-ink">
        <Icon name={ico} size={15} className="text-faint" />
        {title}
        {end}
      </div>
      {children}
    </PlateSection>
  );
}

// what the wizard is working on, mutated in place (the object Save reads)
interface BuilderDraft {
  name: string;
  description: string;
  members: BranchMember[];
  lead: BranchMember | null;
  access: TeamAccess;
  files: string[];
}
// what it keeps between redraws: the close/save state and the agents hired already
interface BuilderFlags {
  saving: boolean;
  savedOk: boolean;
  closed: boolean;
}
interface BuilderProps {
  wf: Team | null;
  draft: BuilderDraft;
  hired: Map<string, Agent>;
  tray: AttachTray;
  agents: Agent[];
  mcpNames: string[];
  flags: BuilderFlags;
  close: () => void;
  onSaved?: (wf: Team) => unknown;
}

function BranchBuilder({ wf, draft: b, hired, tray, agents, mcpNames, flags, close, onSaved }: BuilderProps): ReactNode {
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const name = useRef<HTMLInputElement | null>(null);
  const desc = useRef<HTMLTextAreaElement | null>(null);
  const [asking, setAsking] = useState(false);
  const [status, setStatus] = useState('');
  const [saving, setSaving] = useState(false);
  const searching = useRef<HTMLInputElement | null>(null);
  // (a ref, not the state: a second click in the same tick would otherwise start a second design)
  const building = useRef(false);

  // the box the search list is read from; a plain listener, since it filters as you type
  const searchRef = useCallback((el: HTMLInputElement | null) => {
    searching.current = el;
    if (el) el.addEventListener('input', () => flushSync(redraw));
  }, []);
  useEffect(() => {
    const t = setTimeout(() => (b.name ? desc.current : name.current)?.focus(), 30);
    return () => clearTimeout(t);
  }, []);

  const byId = () => new Map<string, Agent>([...hired, ...(state.data?.agents || []).map((a): [string, Agent] => [a.id, a])]);
  const allFiles = async (): Promise<string[] | null> => {
    const fresh = await tray.ready();
    return fresh ? [...new Set([...b.files, ...fresh])] : null;
  };

  // Plain words (or the name and goal): the Brain picks the agents and writes the team
  const autoBuild = async () => {
    const text = [b.name, b.description].filter(Boolean).join(': ').trim();
    if (!text && !tray.count() && !b.files.length) return toast("Describe the team's goal first.", 'warn');
    if (building.current) return;
    building.current = true;
    setAsking(true);
    setStatus(tray.busy() ? 'Uploading files…' : 'The Brain is picking agents…');
    const attachments = await allFiles();
    if (!attachments) {
      building.current = false;
      setAsking(false);
      setStatus('');
      return;
    }
    setStatus('The Brain is picking agents…');
    const design = await attempt(() => POST<BranchDesign>('/assist/branch', { text, attachments }));
    building.current = false;
    setAsking(false);
    setStatus('');
    if (!design) return;
    b.name = b.name || design.name;
    b.description = b.description || design.description;
    if (name.current) name.current.value = b.name;
    if (desc.current) desc.current.value = b.description;
    b.members = design.members;
    b.lead = design.members[design.leadIndex] || null;
    b.access = { toolGroups: design.access.toolGroups, mcpServers: design.access.mcpServers };
    flushSync(redraw);
    const fresh = design.members.filter((m) => m.newAgent).length;
    toast(`Picked ${design.members.length} agents${fresh ? `, ${fresh} of them new` : ''}. Change anything, then save.`);
  };

  const save = async () => {
    if (!b.name.trim()) return toast('Give the team a name.', 'warn');
    const teamFiles = await allFiles();
    if (flags.closed) return tray.discard();
    if (!teamFiles) return;
    // hire the new agents the Brain suggested; each becomes a normal member right away, so a retry won't hire it again
    for (const mem of [...b.members]) {
      if (!mem.newAgent) continue;
      const a = await attempt(() => POST<Agent>('/agents', mem.newAgent));
      if (!a) return (refreshSoon(0), flushSync(redraw));
      hired.set(a.id, a);
      const done: BranchMember = { agentId: a.id };
      b.members = b.members.map((x) => (x === mem ? done : x));
      if (b.lead === mem) b.lead = done;
    }
    const ids = b.members.map((mem) => mem.agentId).filter((id): id is string => !!id);
    // a step list keeps its own steps (the Station hands over its saved ones as stepList)
    const { stepList, ...rest } = (wf || {}) as Team & { stepList?: TeamStep[] };
    const own = stepList ?? rest.steps ?? [];
    const lead = b.lead?.agentId || null;
    const body = { name: b.name.trim(), description: b.description.trim(), members: ids, steps: teamSteps({ steps: own, members: ids }), lead, access: b.access, files: teamFiles };
    const saved = wf
      ? await attempt(() => PUT<Team>(`/workflows/${wf.id}`, { ...rest, ...body }))
      : await attempt(() => POST<Team>('/workflows', { ...body, color: PALETTE[Math.floor(Math.random() * PALETTE.length)], schedule: { type: 'none' }, enabled: false }));
    if (!saved) {
      // already closed: nothing will save these now
      if (flags.closed) tray.discard();
      return (refreshSoon(0), flushSync(redraw));
    }
    flags.savedOk = true;
    refreshSoon(0);
    close();
    toast(wf ? 'Team saved' : `Team "${saved.name}" created`);
    onSaved?.(saved);
  };

  // one save at a time, or a double click hires everyone twice
  const saveOnce = async () => {
    if (flags.saving) return;
    flags.saving = true;
    setSaving(true);
    try {
      await save();
    } finally {
      flags.saving = false;
      setSaving(false);
    }
  };

  const membersById = byId();
  const query = (searching.current?.value || '').toLowerCase();
  const left = agents.filter((a) => !b.members.some((m) => m.agentId === a.id) && (!query || `${a.name} ${a.specialty || ''}`.toLowerCase().includes(query)));

  return (
    <>
      <div className="modal-body">
        <div className="flex flex-col gap-5">
          <p className="hint m-0">A team is a group chat of agents. You write to the team, the lead (or the best fit) takes it, and they hand work to each other with @mentions.</p>
          <BuilderSection title="Basics" ico="users">
            <Field label="Name">
              <input ref={name} defaultValue={b.name} placeholder="e.g. Social, Video studio, Launch crew" onInput={(e) => (b.name = e.currentTarget.value)} />
            </Field>
            <Field label="Goal">
              <textarea ref={desc} rows={2} defaultValue={b.description} placeholder={"The team's goal. Write it here and press Auto-build to let the Brain pick the agents."} onInput={(e) => (b.description = e.currentTarget.value)} />
            </Field>
            <div className="flex flex-wrap items-center gap-3">
              <Button size="small" disabled={asking} onClick={() => void autoBuild()}>
                <Icon name="sparkles" size={14} />
                Auto-build
              </Button>
              <span className="hint">{status}</span>
            </div>
          </BuilderSection>
          <BuilderSection title="Files" ico="paperclip">
            <div className={b.files.length ? 'att-tray' : 'att-tray hidden'}>
              {b.files.map((p) => (
                <span key={p} className="att-chip sent" title={p}>
                  <span className="att-ico">
                    <Icon name={isFolderPath(p) ? 'folder' : 'file'} size={13} />
                  </span>
                  <span className="att-name">{`${baseName(p)}${isFolderPath(p) ? '/' : ''}`}</span>
                  <button
                    type="button"
                    className="att-x"
                    title="Take off the team (the file stays in uploads/)"
                    onClick={() =>
                      flushSync(() => {
                        b.files = b.files.filter((x) => x !== p);
                        redraw();
                      })
                    }
                  >
                    <Icon name="x" size={12} />
                  </button>
                </span>
              ))}
            </div>
            <DomNode className="dom-contents" make={() => tray.el} deps={[]} />
            <div className="flex flex-wrap items-center gap-3">
              <DomNode as="span" className="dom-contents" make={() => tray.picker} deps={[]} />
              <span className="hint">Briefs, brand guides, assets: drop or paste files or folders anywhere here. Auto-build reads them, and every member is told where they are.</span>
            </div>
          </BuilderSection>
          <BuilderSection title="Members" ico="bot" end={<Pill>{b.members.length}</Pill>}>
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-2">
                {b.members.map((m, j) => {
                  const a = m.agentId ? membersById.get(m.agentId) : null;
                  const isLead = b.lead === m;
                  return (
                    <div key={j} className="flex items-center gap-3 p-3 border border-line bg-bg rounded-box [&_.avatar]:size-8.5 [&_.avatar]:text-[17px]">
                      {a ? <Avatar agent={a} /> : <Avatar agent={{ emoji: m.newAgent?.emoji || '🤖' }} />}
                      <div className="flex-1 min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <b>{a ? a.name : m.newAgent?.name || 'Agent'}</b>
                          {m.newAgent ? <Pill tone="ok">new agent</Pill> : null}
                          {isLead ? <span className="tc-lead">★ lead</span> : null}
                        </div>
                        <div className="hint">{a ? a.specialty || '' : m.newAgent?.specialty || ''}</div>
                      </div>
                      <div className="flex gap-1 flex-none">
                        <button
                          type="button"
                          className={`${STEP_BTN} ${isLead ? 'text-amber border-amber' : 'text-dim border-line-2'}`}
                          title={isLead ? 'Remove as lead' : 'Make lead: your messages go to them first'}
                          onClick={() =>
                            flushSync(() => {
                              b.lead = isLead ? null : m;
                              redraw();
                            })
                          }
                        >
                          ★
                        </button>
                        <button
                          type="button"
                          className={`${STEP_BTN} text-dim border-line-2`}
                          title="Remove"
                          onClick={() =>
                            flushSync(() => {
                              b.members.splice(j, 1);
                              if (isLead) b.lead = null;
                              redraw();
                            })
                          }
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                  );
                })}
                {b.members.length ? null : <p className="empty">No agents yet. Add them below, or describe the goal and press Auto-build.</p>}
              </div>
              <div className="label mt-2">Add an agent</div>
              <div className="mt-3 flex flex-col gap-3">
                {agents.length ? <input ref={searchRef} placeholder="Search your agents…" aria-label="Search your agents" /> : null}
                <div className="flex max-h-56 flex-col gap-1.5 overflow-y-auto">
                  {left.length ? (
                    left.map((a) => (
                      <button
                        key={a.id}
                        type="button"
                        className="flex w-full cursor-pointer items-center gap-3 rounded-ctl border border-line bg-bg px-3 py-2 text-left text-ink [transition:background-color_0.15s] hover:bg-panel-2 [&_.avatar]:size-7 [&_.avatar]:text-[14px]"
                        title={`Add ${a.name} to the team`}
                        onClick={() =>
                          flushSync(() => {
                            b.members.push({ agentId: a.id });
                            redraw();
                          })
                        }
                      >
                        <Avatar agent={a} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] leading-tight font-medium">{a.name}</span>
                          {a.specialty ? <span className="mt-0.5 block truncate text-[11.5px] leading-tight text-faint">{a.specialty}</span> : null}
                        </span>
                        <span className="flex flex-none items-center gap-1.5 text-[12.5px] font-medium text-dim">
                          <Icon name="plus" size={12} />
                          Add
                        </span>
                      </button>
                    ))
                  ) : (
                    <p className="hint">{agents.length ? (query ? 'No agent matches.' : 'Everyone is already on the team.') : 'You have no agents yet: Auto-build can create them.'}</p>
                  )}
                </div>
              </div>
            </div>
          </BuilderSection>
          <BuilderSection title="Access" ico="wrench">
            <div className="label">Programs &amp; tools</div>
            <div className="mt-3">
              <ChipSet
                label="Programs & tools"
                options={(state.data?.toolGroups || []).map((g) => ({ value: g.id, label: g.label, title: g.description }))}
                value={b.access.toolGroups}
                onChange={(v) =>
                  flushSync(() => {
                    b.access.toolGroups = v;
                    redraw();
                  })
                }
              />
            </div>
            {mcpNames.length ? (
              <>
                <div className="label mt-5">MCP servers</div>
                <div className="mt-3">
                  <ChipSet
                    label="MCP servers"
                    options={mcpOptions(mcpNames, state.data?.mcpInfo)}
                    value={b.access.mcpServers}
                    onChange={(v) =>
                      flushSync(() => {
                        b.access.mcpServers = v;
                        redraw();
                      })
                    }
                  />
                </div>
              </>
            ) : null}
            <p className="hint mt-4">While working for this team, every member gets these on top of its own tools.</p>
          </BuilderSection>
        </div>
      </div>
      <div className="modal-foot">
        <Button variant="ghost" onClick={close}>
          Cancel
        </Button>
        <Button disabled={saving} onClick={() => void saveOnce()}>
          {wf ? 'Save team' : 'Create team'}
        </Button>
      </div>
    </>
  );
}

export async function openBranchBuilder({ wf = null, prefill = null, describe = '', files = [], onSaved }: BranchBuilderOptions = {}): Promise<ModalHandle> {
  const d = state.data!;
  const mcp = await GET<{ servers: Record<string, unknown> }>('/mcp').catch(() => ({ servers: {} as Record<string, unknown> }));
  // members: { agentId } for existing agents, { newAgent } for ones the Brain suggests hiring
  const fromTeam: BranchMember[] = (wf?.members || []).map((agentId) => ({ agentId }));
  // the lead is the member object itself, so removing or hiring others never loses it
  const b: BuilderDraft = {
    files: [...new Set([...(wf?.files || []), ...files])],
    name: wf?.name || prefill?.name || '',
    description: wf?.description || prefill?.description || describe || '',
    members: fromTeam.length ? fromTeam : structuredClone(prefill?.members || []),
    lead: null,
    access: { toolGroups: [...(wf?.access?.toolGroups || prefill?.access?.toolGroups || [])], mcpServers: [...(wf?.access?.mcpServers || prefill?.access?.mcpServers || [])] },
  };
  b.lead = (wf?.lead ? b.members.find((m) => m.agentId === wf.lead) : fromTeam.length ? null : b.members[prefill?.leadIndex ?? -1]) || null;
  // agents hired by an earlier save attempt, until the state catches up
  const hired = new Map<string, Agent>();
  const flags: BuilderFlags = { saving: false, savedOk: false, closed: false };
  const tray = attachTray();
  const m = openModal(
    wf ? `Edit ${wf.name}` : 'New team',
    (close) => (
      <BranchBuilder wf={wf} draft={b} hired={hired} tray={tray} agents={d.agents} mcpNames={Object.keys(mcp.servers)} flags={flags} close={close} onSaved={onSaved} />
    ),
    // closed without saving: the files dropped here go too
    // (a save already under way finishes, with its files; one still waiting for uploads stops)
    {
      onClose: () => {
        flags.closed = true;
        if (!flags.savedOk && !flags.saving) tray.discard();
      },
    },
  );
  tray.dropZone(m.el.querySelector<HTMLElement>('.modal')!, 'Drop files or folders for the team');
  return m;
}
