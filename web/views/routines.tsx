// Routines: instructions you run again and again. Type @ in the text to mention who does it (agents,
// teams) and which skills they use. Run it by hand or on a schedule.
import { Plate } from '../ui/surface.tsx';
import { FormSection } from '../ui/formsection.tsx';
import { Button, ButtonLink } from '../ui/button.tsx';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { h, md, DEL, attempt, navigate, confirmBox, ago, state, toast } from '../core.ts';
import { rpc } from '../client/rpc.ts';
import { icon } from '../icons.ts';
import { skillIcon } from '../skillicons.ts';
import { loadSkills, skillsCache } from '../skillpick.ts';
import { scheduleEditor } from '../schedule.tsx';
import { openChat } from '../chatwin.tsx';
import { attachMentions, startMention, KIND_LABEL } from '../routinemention.ts';
import { attachMentionEditor } from '../chat/mentioneditor.ts';
import type { Candidate } from '../routinemention.ts';
import { findMentions, scheduleSummary } from '../../shared/routines.ts';
import { Field, Switch } from '../ui/controls.tsx';
import { CollapsePanel, CollapseRoot, CollapseTrigger } from '../ui/collapse.tsx';
import { DomNode, Icon, ProjectScoped, reactPage, useAppState, useServerEvents } from '../ui/react.tsx';
import { Dot, Pill } from '../ui/marks.tsx';
import type { PillTone } from '../ui/classes.ts';
import type { AppState, Routine, RoutineListing, RoutineMention, RoutineMentionKind, RoutineRun, RoutineRunTarget, TeamListing } from '../../shared/types.ts';

/** Agents, teams and skills a routine can mention. Agents first: on a name clash they win (the server does the same). */
export function candidates(d: Pick<AppState, 'agents'>, teams: readonly TeamListing[]): Candidate[] {
  return [
    ...d.agents.map((a): Candidate => ({ kind: 'agent', id: a.id, name: a.name, lead: h('span', { class: 'w-3.5 text-center flex-none' }, a.emoji || '🤖'), sub: a.specialty || a.description || '', color: a.color })),
    ...teams.map((t): Candidate => ({ kind: 'team', id: t.id, name: t.name, lead: icon('users', 14), sub: `${t.members.length} member${t.members.length === 1 ? '' : 's'}${t.description ? ` · ${t.description}` : ''}`, color: t.color })),
    ...skillsCache().map((s): Candidate => ({ kind: 'skill', id: s.slug, name: s.name, lead: skillIcon(s.slug, 14), sub: s.description })),
  ];
}

/** Loads the teams and the skills a routine can mention, and keeps the teams current. */
function useTeams(): TeamListing[] | null {
  const [teams, setTeams] = useState<TeamListing[] | null>(null);
  const load = useCallback(() => rpc.workflows.list().catch((): TeamListing[] => []), []);
  useEffect(() => {
    let live = true;
    void Promise.all([load(), loadSkills()]).then(([t]) => live && setTeams(t));
    return () => void (live = false);
  }, [load]);
  useServerEvents((ev) => ['agents', 'workflows'].includes(ev.type) && void load().then(setTeams));
  return teams;
}

// a mention as a chip: a team in its own color (--c), a skill in the accent, crossed out once it's gone
const CHIP = 'pill-shadow inline-flex items-center gap-1.5 py-0.5 px-2.5 rounded-full border border-line-2 text-[12px] whitespace-nowrap max-w-full overflow-hidden text-ellipsis [&_.ico-svg]:flex-none';
const CHIP_KIND: Record<RoutineMentionKind, string> = {
  agent: '[&_.ico-svg]:text-dim',
  team: '[&_.ico-svg]:text-dim border-[color-mix(in_srgb,var(--c,var(--color-accent))_45%,var(--color-line))]',
  skill: '[&_.ico-svg]:text-accent border-[color-mix(in_srgb,var(--color-accent)_35%,var(--color-line))]',
};
const CHIP_BG: Record<RoutineMentionKind, string> = {
  agent: '',
  team: 'bg-[color-mix(in_srgb,var(--c,var(--color-accent))_10%,transparent)]',
  skill: 'bg-accent/9',
};
const CHIPS = 'flex flex-wrap gap-2 items-center min-w-0';

function MentionChip({ m, teams, extra }: { m: RoutineMention; teams: readonly TeamListing[]; extra?: ReactNode }) {
  const d = state.data;
  const a = m.kind === 'agent' ? d?.agents.find((x) => x.id === m.id) : null;
  const t = m.kind === 'team' ? teams.find((x) => x.id === m.id) : null;
  const look = m.missing ? 'border-dashed text-faint bg-transparent line-through' : `text-ink ${CHIP_BG[m.kind]}`;
  return (
    <span className={`${CHIP} ${CHIP_KIND[m.kind]} ${look}`} style={t?.color ? ({ '--c': t.color } as CSSProperties) : undefined} title={m.missing ? `${m.name} no longer exists` : KIND_LABEL[m.kind].slice(0, -1)}>
      {m.kind === 'agent' ? <span>{a?.emoji || '🤖'}</span> : m.kind === 'skill' ? <DomNode as="span" className="flex flex-none" make={() => skillIcon(m.id, 12)} deps={[m.id]} /> : <Icon name="users" size={11} />}
      {m.name}
      {extra}
    </span>
  );
}

function StatusIcon({ status }: { status: string }) {
  if (status === 'done' || status === 'sent') return <span className="text-ok" aria-label="done">✓</span>;
  if (status === 'failed') return <span className="text-red" aria-label="failed">✕</span>;
  if (status === 'running') return <Dot tone="busy" aria-label="running" />;
  if (status === 'stopped') return <span className="text-amber" aria-label="stopped">■</span>;
  return <span className="text-faint">·</span>;
}

// ---------- the list ----------
/** A new routine is only a draft in the editor: nothing is saved until it has something to do. */
const NEW = 'new';
const create = (): void => navigate(`#/routines/${NEW}`);
const BLANK: Routine = { id: '', name: 'New routine', text: '', mentions: [], schedule: { type: 'none' }, enabled: true };

function RoutinesList() {
  const teams = useTeams();
  const [list, setList] = useState<RoutineListing[] | null>(null);
  const reload = useCallback(() => rpc.routines.list().then(setList).catch(() => {}), []);
  useEffect(() => void reload(), [reload]);
  useServerEvents((ev) => (ev.type === 'routines' || ev.type === 'routine-run') && void reload());
  if (!teams || !list) return <p className="text-dim">Loading routines…</p>;
  return (
    <>
      <p className="lede max-w-[68ch]">A routine is work you want done again and again: a morning news check, a weekly report, a content plan. Write it once, @mention the agents and teams who do it and the skills they should use, then run it by hand or on a schedule.</p>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-line pb-4">
        <h2 className="section m-0">{`Your routines${list.length ? ` (${list.length})` : ''}`}</h2>
        <Button  onClick={() => void create()}>
          <Icon name="plus" size={14} />
          New routine
        </Button>
      </div>
      {list.length ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,300px),1fr))] gap-3">
          {list.map((r) => (
            <RoutineCard key={r.id} r={r} teams={teams} />
          ))}
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3 py-12 text-center">
          <p className="m-0 text-dim">No routines yet.</p>
          <p className="hint m-0 max-w-130">Example: "Every morning, @Researcher finds the 3 biggest AI stories, then @Content Team turns them into a post using @Brand voice."</p>
          <Button  onClick={() => void create()}>
            <Icon name="plus" size={14} />
            Write your first routine
          </Button>
        </div>
      )}
    </>
  );
}

const DESC = 'm-0 text-dim text-[13px] leading-[1.45] line-clamp-3';

function RoutineCard({ r, teams }: { r: RoutineListing; teams: TeamListing[] }) {
  const [running, setRunning] = useState(false);
  const last = r.lastRun;
  // the switch answers at once; the list catches up when the server says it changed
  const [on, setOn] = useState(r.enabled);
  useEffect(() => setOn(r.enabled), [r.enabled]);
  const toggleOn = async (v: boolean) => {
    setOn(v);
    if (!(await attempt(() => rpc.routines.change({ id: r.id, enabled: v }), v ? 'Routine on' : 'Routine off'))) setOn(!v);
  };
  const run = async () => {
    setRunning(true);
    await attempt(() => rpc.routines.run({ id: r.id }), 'Routine started');
    setRunning(false);
  };
  return (
    <div className={`card glass-plate hover:shadow-none gap-3 !rounded-[10px] !p-4 ${on ? '' : '[&>:not(:first-child)]:opacity-55'}`}>
      <div className="flex items-center gap-3">
        <div className="skill-ico !h-9 !w-9 !rounded-[8px]"><Icon name="repeat" size={16} /></div>
        <div className="flex-1 min-w-0">
          <a className="skill-name text-[14px] font-semibold text-ink hover:text-ink hover:underline" href={`#/routines/${r.id}`}>{r.name}</a>
          <div className="hint mt-0.5 flex items-start gap-1.5"><Icon name={r.schedule?.type === 'daily' ? 'calendar' : r.schedule?.type === 'interval' ? 'repeat' : 'hand'} size={13} className="mt-0.5 shrink-0" /><span>{!on ? 'Switched off · ' : ''}{scheduleSummary(r.schedule)}</span></div>
        </div>
        <Switch checked={on} onChange={(v) => void toggleOn(v)} className="flex-none flex-nowrap" >
          <span className="text-[12.5px] font-medium text-dim" title={`Switch ${r.name} ${on ? 'off' : 'on'}`}>{on ? 'On' : 'Off'}</span>
        </Switch>
      </div>
      {r.description || r.text ? <p className={DESC}>{r.description || r.text}</p> : <p className={DESC}>Nothing written yet.</p>}
      {r.mentions.length ? (
        <div className={CHIPS}>
          {r.mentions.map((m) => (
            <MentionChip key={`${m.kind}:${m.id}`} m={m} teams={teams} />
          ))}
        </div>
      ) : (
        <span className="hint">Nobody mentioned yet</span>
      )}
      <div className="mt-auto flex flex-wrap items-center gap-2 border-t border-line pt-3">
        <Button size="small" disabled={running || !on} title={on ? undefined : 'Switch the routine on to run it'} onClick={() => void run()}>
          <Icon name="play" size={13} />
          Run
        </Button>
        {last ? (
          <span className="hint">
            <StatusIcon status={last.status} />
            {` ${last.status} · ${ago(last.createdAt)}`}
          </span>
        ) : (
          <span className="hint">never run</span>
        )}
      </div>
    </div>
  );
}

// ---------- the editor ----------
function RoutineEditor({ id }: { id: string }) {
  const teams = useTeams();
  const [loaded, setLoaded] = useState<Routine | null | 'gone'>(null);
  useEffect(() => {
    // (not the routine before this one, while it loads)
    setLoaded(id === NEW ? BLANK : null);
    if (id === NEW) return;
    let live = true;
    void rpc.routines.get({ id })
      .then((r) => live && setLoaded(r))
      .catch(() => live && setLoaded('gone'));
    return () => void (live = false);
  }, [id]);
  if (loaded === 'gone')
    return (
      <p>
        Routine not found. <a href="#/routines">Back to routines</a>
      </p>
    );
  if (!loaded || !teams) return <p className="text-dim">Loading routines…</p>;
  // (from a team's panel on the Station: a new routine starts with that team mentioned)
  const team = loaded === BLANK ? teams.find((t) => t.id === new URLSearchParams(location.hash.split('?')[1] || '').get('team')) : undefined;
  return <EditorForm key={loaded.id} first={team ? { ...BLANK, text: `@${team.name} ` } : loaded} teams={teams} />;
}

function EditorForm({ first, teams }: { first: Routine; teams: TeamListing[] }) {
  const d = useAppState();
  const id = first.id;
  // The schedule editor changes the draft in place.
  const r = useRef<Routine>(structuredClone(first));
  const [name, setName] = useState(first.name);
  const [description, setDescription] = useState(first.description || '');
  const [text, setText] = useState(first.text);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  // a draft has no id yet: its first Save makes the routine
  const isNew = !id;
  // The schedule editor tells us when its fields change (the side card shows its summary).
  const [kind, setKind] = useState(first.schedule?.type || 'none');
  const [, scheduleChanged] = useState(0);
  // the newest run, from the runs list, for the side card
  const [last, setLast] = useState<RoutineRun | null>(null);
  // One switch controls manual and scheduled runs.
  const [active, setActive] = useState(first.enabled);
  const canSave = dirty && !saving && !!name.trim() && !!text.trim();
  const missing = first.mentions.filter((m) => m.missing);
  const ta = useRef<HTMLTextAreaElement>(null);
  const cands = () => (d ? candidates(d, teams) : []);
  const candsRef = useRef(cands);
  candsRef.current = cands;
  useEffect(() => {
    // mentions show as pills, like in a team chat's message box
    const offEditor = attachMentionEditor(ta.current!, () => candsRef.current().map((c) => ({ tag: `@${c.name}`, icon: c.kind === 'team' ? 'users' : c.kind === 'skill' ? 'puzzle' : undefined })));
    const offMenu = attachMentions(ta.current!, () => candsRef.current(), () => {});
    return () => (offMenu(), offEditor());
  }, []);

  const save = async (): Promise<boolean> => {
    // never an empty routine
    if (!text.trim()) return toast('Write what the routine should do first', 'warn'), ta.current?.focus(), false;
    if (!name.trim()) return toast('Give the routine a name', 'warn'), false;
    if (r.current.schedule?.type === 'daily' && r.current.schedule.times?.some((time) => !time)) return toast('Choose each daily time, or remove empty times', 'warn'), false;
    setSaving(true);
    const body = { name, description, text, schedule: r.current.schedule, enabled: r.current.enabled };
    const out = await attempt(() => (isNew ? rpc.routines.create(body) : rpc.routines.change({ ...body, id })), isNew ? 'Routine added' : 'Saved');
    setSaving(false);
    if (!out) return false;
    r.current.mentions = out.mentions;
    setDirty(false);
    if (isNew) navigate(`#/routines/${out.id}`);
    return true;
  };
  const run = async () => {
    if (dirty && !(await save())) return;
    setRunning(true);
    await attempt(() => rpc.routines.run({ id, input: '' }), 'Routine started');
    setRunning(false);
  };
  const switchActive = (v: boolean) => {
    setActive(v);
    r.current.enabled = v;
    if (isNew) setDirty(true);
    else void attempt(() => rpc.routines.change({ id, enabled: v }), v ? 'Routine on' : 'Routine off').then((ok) => {
      if (!ok) { r.current.enabled = !v; setActive(!v); }
    });
  };
  const del = async () => {
    if (!(await confirmBox(`Delete the routine "${name}"?`, { ok: 'Delete', danger: true }))) return;
    if (await attempt(() => DEL(`/routines/${id}`), 'Deleted')) navigate('#/routines');
  };

  // who the text mentions
  const found = findMentions(text, cands());
  const mTeams = found.filter((m) => m.kind === 'team');
  const viaTeam = (agentId: string) => mTeams.map((m) => teams.find((t) => t.id === m.id)).find((t) => t?.members.includes(agentId));
  const gone = missing.filter((m) => findMentions(text, [m]).length);
  const doers = [
    ...mTeams.map((m) => <MentionChip key={`t:${m.id}`} m={m} teams={teams} />),
    ...found
      .filter((m) => m.kind === 'agent')
      .map((m) => {
        const t = viaTeam(m.id);
        return <MentionChip key={`a:${m.id}`} m={m} teams={teams} extra={t ? <span className="text-[11.5px] leading-[normal] font-normal text-faint">{`in ${t.name}`}</span> : null} />;
      }),
  ];
  const skills = found.filter((m) => m.kind === 'skill').map((m) => <MentionChip key={`s:${m.id}`} m={m} teams={teams} />);
  const whoRow = (label: string, ico: string, items: ReactNode[], empty: string) => (
    <div className="grid grid-cols-[112px_minmax(0,1fr)] items-start gap-3 max-sm:grid-cols-1 max-sm:gap-1.5">
      <div className="inline-flex items-center gap-2 pt-1 text-[12.5px] leading-[normal] font-medium text-dim">
        <Icon name={ico} size={13} />
        {label}
      </div>
      <div className={CHIPS}>{items.length ? items : <span className="pt-0.5 text-[12.5px] text-faint">{empty}</span>}</div>
    </div>
  );
  const insert = (kind: RoutineMentionKind, label: string, ico: string) => (
    <Button variant="ghost" size="tiny" type="button" title={`Mention ${label.toLowerCase()}`} onClick={() => startMention(ta.current!, kind)}>
      <Icon name={ico} size={12} />
      {label}
    </Button>
  );
  const schedule = r.current.schedule;
  const lastLook = last ? runLook(last.status) : null;

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <ButtonLink variant="ghost" size="small" href="#/routines">← Routines</ButtonLink>
        <div className="flex items-center gap-3">
          {dirty && !isNew ? <span className="text-[12.5px] text-faint">Unsaved changes</span> : null}
          <Button disabled={!canSave} title={!text.trim() ? 'Write what the routine should do first' : undefined} onClick={() => void save()}>Save</Button>
        </div>
      </div>
      <div className="mb-7 flex items-start gap-4">
        <span aria-hidden="true" className="grid size-11 flex-none place-items-center rounded-[12px] border border-accent/25 bg-accent/10 text-accent">
          <Icon name="repeat" size={20} />
        </span>
        <div className="min-w-0">
          <h1 className="m-0 truncate text-[22px] leading-[1.2] font-semibold text-ink">{isNew ? 'New routine' : name || 'Routine'}</h1>
          <p className="hint mt-1.5 mb-0">{description || 'Set the work, who does it and when it runs.'}</p>
        </div>
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)_340px] items-start gap-6 max-lg:grid-cols-1">
        {/* the work: what it is called, what it asks, who it goes to */}
        <Plate className="flex min-w-0 flex-col gap-6 rounded-box p-5 sm:p-6">
          <FormSection icon="pen-line" title="Details">
            <div className="grid grid-cols-2 gap-4 max-md:grid-cols-1">
              <Field label="Name">
                <input value={name} onChange={(e) => (setName(e.target.value), setDirty(true))} />
              </Field>
              <Field label="Description">
                <input value={description} placeholder="Optional, shown on the card" onChange={(e) => (setDescription(e.target.value), setDirty(true))} />
              </Field>
            </div>
          </FormSection>
          <FormSection
            icon="list-checks"
            title="What to do"
            hint={<>Type <b className="font-semibold text-ink">@</b> to mention an agent, a team or a skill. Agents and teams each get the routine (an agent in a mentioned team gets it in that team chat); skills are given to all of them.</>}
            end={<>{insert('agent', 'Agent', 'bot')}{insert('team', 'Team', 'users')}{insert('skill', 'Skill', 'puzzle')}</>}
          >
            <textarea
              ref={ta}
              // the text box look as utilities: the pill editor shown in its place copies these classes
              className="code min-h-45 w-full resize-y rounded-ctl border border-line-2 bg-bg px-3 py-[9px] font-mono text-[12.5px] leading-[1.55] text-ink shadow-card outline-none [transition:border-color_0.15s,box-shadow_0.15s] hover:border-[color-mix(in_srgb,var(--color-ink)_22%,var(--color-line-2))] focus:border-accent focus:[box-shadow:0_0_0_3px_color-mix(in_srgb,var(--color-accent)_18%,transparent)] empty:before:pointer-events-none empty:before:text-faint empty:before:content-[attr(data-placeholder)]"
              rows={9}
              aria-label="What to do"
              value={text}
              placeholder={'What should be done? Type @ to mention who does it and the skills to use.\n\ne.g. @Researcher find the 3 most interesting AI stories from the last day, with links. Then @Content Team writes one X post about the best one using @Brand voice.'}
              onChange={(e) => (setText(e.target.value), setDirty(true))}
            />
            {/* who the text mentions, read back as chips */}
            <div className="rt-who flex flex-col gap-3 rounded-box border border-line bg-panel-2/40 px-4 py-3.5">
              {whoRow('Who does it', 'users', doers, 'Mention at least one agent or team.')}
              {whoRow('Skills', 'puzzle', skills, 'None. Mention a skill to have them follow it.')}
              {gone.length ? (
                <p className="hint m-0 inline-flex items-center gap-1.5 text-amber!">
                  <Icon name="triangle-alert" size={12} />
                  {`${gone.map((m) => `@${m.name}`).join(', ')} ${gone.length === 1 ? 'was' : 'were'} deleted, so ${gone.length === 1 ? 'it is' : 'they are'} left out.`}
                </p>
              ) : null}
            </div>
          </FormSection>
        </Plate>
        {/* the routine's state: on or off, run it, when it runs on its own */}
        <aside className="flex min-w-0 flex-col lg:sticky lg:top-20">
          <Plate className="flex flex-col gap-5 rounded-box p-5">
            <div className="flex flex-col gap-3">
              <Switch checked={active} onChange={switchActive} className="flex-nowrap!">
                <span className="text-[13.5px] font-semibold text-ink">{active ? 'Routine on' : 'Routine off'}</span>
              </Switch>
              <p className="m-0 text-[12.5px] leading-normal text-dim">
                {!active ? "It doesn't run, by hand or on its schedule." : kind === 'none' ? 'It runs when you press Run now.' : `Runs by hand, and ${scheduleSummary(schedule).replace(/^./, (c) => c.toLowerCase())}.`}
              </p>
              <Button variant="ghost" className="w-full justify-center" disabled={running || isNew || !active} title={isNew || !active ? 'Save the routine first, and switch it on, to run it' : undefined} onClick={() => void run()}>
                <Icon name="play" size={14} />
                Run now
              </Button>
              <div className="flex items-center gap-2 text-[12.5px] text-dim">
                <Icon name="history" size={13} className="text-faint" />
                {last && lastLook ? (
                  <>
                    <span>Last run</span>
                    <Pill tone={lastLook.tone}>{lastLook.label}</Pill>
                    <span className="ml-auto text-faint">{ago(last.createdAt)}</span>
                  </>
                ) : (
                  <span>{isNew ? 'Not saved yet' : 'Not run yet'}</span>
                )}
              </div>
            </div>
            <div className="flex flex-col gap-4 border-t border-line pt-5">
              <div className="flex items-center gap-3">
                <span aria-hidden="true" className="grid size-8 flex-none place-items-center rounded-[9px] border border-line bg-panel-2 text-dim">
                  <Icon name="calendar" size={15} />
                </span>
                <div className="min-w-0">
                  <h3 className="m-0 text-[14px] leading-snug font-semibold text-ink">Schedule</h3>
                  <p className="m-0 text-[12.5px] text-dim">{scheduleSummary(schedule)}</p>
                </div>
              </div>
              <DomNode make={() => scheduleEditor(r.current, () => (setDirty(true), setKind(r.current.schedule?.type || 'none'), scheduleChanged((n) => n + 1)), { inputLabel: 'Additional instructions for scheduled runs (optional)', inputHint: 'Added to the main instructions when this routine runs automatically. Not used by Run now.', showToggle: false })} deps={[id]} />
              {kind !== 'none' ? <p className="hint m-0">Runs while the dashboard is open.</p> : null}
            </div>
          </Plate>
        </aside>
        <Plate className="col-span-2 rounded-box p-5 sm:p-6 max-lg:col-span-1">
          <FormSection icon="history" title="Runs" hint="What each agent and team did, newest first.">
            <Runs id={id} onLatest={setLast} />
          </FormSection>
        </Plate>
        {!isNew && <div className="col-span-2 flex justify-end max-lg:col-span-1">
          <Button variant="danger" onClick={() => void del()}><Icon name="trash-2" size={14} />Delete routine</Button>
        </div>}
      </div>
    </div>
  );
}


/** How a run (or one of its agents) ended, as a pill's tone and words. */
const RUN_LOOK: Record<string, { tone: PillTone; label: string }> = {
  running: { tone: 'info', label: 'Running' },
  done: { tone: 'ok', label: 'Done' },
  sent: { tone: 'ok', label: 'Sent to the team' },
  failed: { tone: 'bad', label: 'Failed' },
  stopped: { tone: 'warn', label: 'Stopped' },
};
const runLook = (status: string) => RUN_LOOK[status] || { tone: 'dim' as const, label: status };

/** How long a run took: "12s", "3m 5s", "1h 4m". */
export function runTook(ms: number): string {
  const sec = Math.max(1, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m${sec % 60 ? ` ${sec % 60}s` : ''}`;
  return `${Math.floor(min / 60)}h${min % 60 ? ` ${min % 60}m` : ''}`;
}

type Who = { emoji?: string; color?: string } | undefined;

/** An agent's emoji on its colour, or a team's icon: small, for a run's summary and its rows. */
function TargetMark({ t, agent, small = false }: { t: RoutineRunTarget; agent: Who; small?: boolean }) {
  const size = small ? 'size-6 rounded-[7px] text-[12px] ring-2 ring-panel' : 'size-8 rounded-[9px] text-[15px]';
  return t.kind === 'team' ? (
    <span className={`grid flex-none place-items-center border border-line bg-panel-2 text-dim ${size}`} title={t.name}><Icon name="users" size={small ? 12 : 15} /></span>
  ) : (
    <span className={`avatar ${size}`} style={{ '--agent-color': agent?.color || 'var(--color-accent)' } as CSSProperties} title={t.name}>{agent?.emoji || '🤖'}</span>
  );
}

/** The routine's last runs, kept current; the newest is open, and whichever you opened stays open. */
function Runs({ id, onLatest }: { id: string; onLatest?: (run: RoutineRun | null) => void }) {
  const d = useAppState();
  const [runs, setRuns] = useState<RoutineRun[] | null>(null);
  const [open, setOpen] = useState<Set<string> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const load = useCallback(() => {
    clearTimeout(timer.current);
    // a draft has no runs (an empty id would ask for every routine's)
    if (!id) return setRuns([]);
    // (a burst of events loads once)
    timer.current = setTimeout(() => void rpc.routines.runs.list({ routineId: id }).then(setRuns).catch(() => setRuns([])), 150);
  }, [id]);
  useEffect(() => (load(), () => clearTimeout(timer.current)), [load]);
  useEffect(() => onLatest?.(runs?.[0] ?? null), [runs, onLatest]);
  useServerEvents((ev) => ev.type === 'routine-run' && (ev as { routineId?: string }).routineId === id && load());
  if (!runs) return null;
  if (!runs.length)
    return (
      <div className="flex flex-col items-center gap-2 rounded-box border border-dashed border-line-2 px-6 py-10 text-center">
        <Icon name="history" size={20} className="text-faint" />
        <p className="m-0 text-[13.5px] text-dim">No runs yet. Use Run now, or set a schedule.</p>
      </div>
    );
  const agentOf = (t: RoutineRunTarget): Who => (t.kind === 'agent' ? d?.agents.find((a) => a.id === t.id) : undefined);
  const isOpen = (run: RoutineRun, i: number) => (open ? open.has(run.id) : i === 0);
  return (
    <div className="flex flex-col gap-3">
      {runs.slice(0, 15).map((run, i) => {
        const look = runLook(run.status);
        const took = run.finishedAt && run.createdAt ? runTook(run.finishedAt - run.createdAt) : '';
        return (
          <div key={run.id} className="relative overflow-hidden rounded-box border border-line bg-bg shadow-card">
            {/* (opens and closes with the app's shared motion) */}
            <CollapseRoot
              data-run={run.id}
              open={isOpen(run, i)}
              onOpenChange={(now) => {
                if (now === isOpen(run, i)) return;
                const next = new Set(open ?? (runs[0] ? [runs[0].id] : []));
                if (now) next.add(run.id);
                else next.delete(run.id);
                setOpen(next);
              }}
            >
              <CollapseTrigger className="flex w-full cursor-pointer flex-wrap items-center gap-x-3 gap-y-2 border-0 bg-transparent px-4 py-3 text-left text-ink transition-colors hover:bg-panel-2/60">
                <Pill tone={look.tone} className="gap-1.5">
                  {run.status === 'running' ? <Dot tone="busy" /> : null}
                  {look.label}
                </Pill>
                <span className="inline-flex items-center gap-1.5 text-[12.5px] text-dim">
                  <Icon name={run.trigger === 'manual' ? 'hand' : 'calendar'} size={13} />
                  {run.trigger === 'manual' ? 'Run by hand' : run.trigger === 'schedule' ? 'Scheduled' : run.trigger}
                </span>
                <span className="flex items-center -space-x-1.5" aria-label={run.targets.map((t) => t.name).join(', ')}>
                  {run.targets.slice(0, 5).map((t) => <TargetMark key={`${t.kind}:${t.id}`} t={t} agent={agentOf(t)} small />)}
                </span>
                <span className="ml-auto shrink-0 text-[12px] text-faint tabular-nums" title={run.createdAt ? new Date(run.createdAt).toLocaleString() : undefined}>
                  {ago(run.createdAt)}{took ? ` · took ${took}` : ''}
                </span>
                {run.status === 'running' ? <span className="w-14 flex-none" aria-hidden="true" /> : null}
                <Icon name="chevron-down" size={14} className={`flex-none text-dim transition-transform duration-200 ease-in-out ${isOpen(run, i) ? 'rotate-180' : ''}`} />
              </CollapseTrigger>
              <CollapsePanel>
                <div className="flex flex-col gap-1 border-t border-line px-4 py-3">
                  {run.error ? <p className="m-0 rounded-ctl bg-red/8 px-3 py-2 text-[13px] text-red">{run.error}</p> : null}
                  {run.targets.map((t) => (
                    <TargetRow key={`${t.kind}:${t.id}`} t={t} agent={agentOf(t)} />
                  ))}
                  {run.skills.length ? (
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[12.5px] text-dim">
                      <Icon name="puzzle" size={13} />
                      {run.skills.map((slug) => skillsCache().find((sk) => sk.slug === slug)?.name || slug).join(', ')}
                    </div>
                  ) : null}
                </div>
              </CollapsePanel>
            </CollapseRoot>
            {run.status === 'running' ? (
              <Button variant="danger" size="tiny" className="absolute top-3 right-10" onClick={() => void attempt(() => rpc.routines.runs.stop({ id: run.id }))}>Stop</Button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function TargetRow({ t, agent }: { t: RoutineRunTarget; agent: Who }) {
  const look = runLook(t.status);
  return (
    <div className="flex gap-3 py-2 [&_pre]:max-h-50">
      <TargetMark t={t} agent={agent} />
      <div className="min-w-0 flex-1">
        <div className="flex min-h-8 flex-wrap items-center gap-x-2 gap-y-1">
          <b className="min-w-0 break-words text-[14px]">{t.name}</b>
          <span className="inline-flex items-center gap-1 text-[12.5px] text-dim">
            <StatusIcon status={t.status} />
            {t.kind === 'team' ? `Team · ${look.label.toLowerCase()}` : look.label}
          </span>
          <span className="ml-auto">
            {t.kind === 'team' ? (
              <Button variant="ghost" size="tiny" onClick={() => openChat('team', t.id)}>
                <Icon name="message-square" size={12} />
                Team chat
              </Button>
            ) : t.chatId ? (
              <ButtonLink variant="ghost" size="tiny" href={`#/agents/${t.id}/${t.chatId}`}>
                <Icon name="message-square" size={12} />
                Chat
              </ButtonLink>
            ) : null}
          </span>
        </div>
        {t.output ? (
          <div className="mt-2 max-h-72 max-w-[80ch] overflow-y-auto rounded-ctl border border-line bg-panel-2/50 px-4 py-3 text-[13px] leading-[1.65] text-ink [&_.md>:first-child]:mt-0 [&_.md>:last-child]:mb-0">
            <DomNode make={() => md(t.output)} deps={[t.output]} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

export const title = (p: string[]) => (p[0] ? 'Routine' : 'Routines');
export const { render, unmount } = reactPage((p) => (p[0] ? <ProjectScoped><RoutineEditor id={p[0]} /></ProjectScoped> : <RoutinesList />));
