// Routines: instructions you run again and again. Type @ in the text to mention who does it (agents,
// teams) and which skills they use. Run it by hand or on a schedule.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { h, GET, POST, PUT, DEL, attempt, navigate, confirmBox, ago, state } from '../core.ts';
import { icon } from '../icons.ts';
import { loadSkills, skillsCache } from '../skillpick.ts';
import { scheduleEditor, scheduleText } from '../schedule.ts';
import { openChat } from '../chatwin.ts';
import { attachMentions, startMention, KIND_LABEL } from '../routinemention.ts';
import type { Candidate } from '../routinemention.ts';
import { findMentions } from '../../shared/routines.ts';
import { Field } from '../ui/controls.tsx';
import { DomNode, Icon, reactPage, useAppState, useServerEvents } from '../ui/react.tsx';
import type { AppState, Routine, RoutineListing, RoutineMention, RoutineMentionKind, RoutineRun, RoutineRunTarget, TeamListing } from '../../shared/types.ts';

/** Agents, teams and skills a routine can mention. Agents first: on a name clash they win (the server does the same). */
export function candidates(d: Pick<AppState, 'agents'>, teams: readonly TeamListing[]): Candidate[] {
  return [
    ...d.agents.map((a): Candidate => ({ kind: 'agent', id: a.id, name: a.name, lead: h('span.rt-emoji', a.emoji || '🤖'), sub: a.specialty || a.description || '', color: a.color })),
    ...teams.map((t): Candidate => ({ kind: 'team', id: t.id, name: t.name, lead: icon('users', 14), sub: `${t.members.length} member${t.members.length === 1 ? '' : 's'}${t.description ? ` · ${t.description}` : ''}`, color: t.color })),
    ...skillsCache().map((s): Candidate => ({ kind: 'skill', id: s.slug, name: s.name, lead: icon('puzzle', 14), sub: s.description })),
  ];
}

/** Loads the teams and the skills a routine can mention, and keeps the teams current. */
function useTeams(): TeamListing[] | null {
  const [teams, setTeams] = useState<TeamListing[] | null>(null);
  const load = useCallback(() => GET<TeamListing[]>('/workflows').catch((): TeamListing[] => []), []);
  useEffect(() => {
    let live = true;
    void Promise.all([load(), loadSkills()]).then(([t]) => live && setTeams(t));
    return () => void (live = false);
  }, [load]);
  useServerEvents((ev) => ['agents', 'workflows'].includes(ev.type) && void load().then(setTeams));
  return teams;
}

function MentionChip({ m, teams, extra }: { m: RoutineMention; teams: readonly TeamListing[]; extra?: ReactNode }) {
  const d = state.data;
  const a = m.kind === 'agent' ? d?.agents.find((x) => x.id === m.id) : null;
  const t = m.kind === 'team' ? teams.find((x) => x.id === m.id) : null;
  return (
    <span className={`rt-m ${m.kind}${m.missing ? ' missing' : ''}`} style={t?.color ? ({ '--c': t.color } as CSSProperties) : undefined} title={m.missing ? `${m.name} no longer exists` : KIND_LABEL[m.kind].slice(0, -1)}>
      {m.kind === 'agent' ? <span>{a?.emoji || '🤖'}</span> : <Icon name={m.kind === 'team' ? 'users' : 'puzzle'} size={11} />}
      {m.name}
      {extra}
    </span>
  );
}

function StatusIcon({ status }: { status: string }) {
  if (status === 'done' || status === 'sent') return <span className="accent" aria-label="done">✓</span>;
  if (status === 'failed') return <span className="red" aria-label="failed">✕</span>;
  if (status === 'running') return <span className="dot busy" aria-label="running" />;
  if (status === 'stopped') return <span className="amber" aria-label="stopped">■</span>;
  return <span className="faint">·</span>;
}

// ---------- the list ----------
async function create(): Promise<void> {
  const r = await attempt(() => POST<Routine>('/routines', { name: 'New routine' }));
  if (r) navigate(`#/routines/${r.id}`);
}

function RoutinesList() {
  const teams = useTeams();
  const [list, setList] = useState<RoutineListing[] | null>(null);
  const reload = useCallback(() => GET<RoutineListing[]>('/routines').then(setList).catch(() => {}), []);
  useEffect(() => void reload(), [reload]);
  useServerEvents((ev) => (ev.type === 'routines' || ev.type === 'routine-run') && void reload());
  if (!teams || !list) return <p className="dim">Loading routines…</p>;
  return (
    <>
      <p className="lede">A routine is work you want done again and again: a morning news check, a weekly report, a content plan. Write it once, @mention the agents and teams who do it and the skills they should use, then run it by hand or on a schedule.</p>
      <div className="row between rt-head">
        <h2 className="section">{`Your routines${list.length ? ` (${list.length})` : ''}`}</h2>
        <button className="btn small" onClick={() => void create()}>
          <Icon name="plus" size={14} />
          New routine
        </button>
      </div>
      {list.length ? (
        <div className="rt-grid">
          {list.map((r) => (
            <RoutineCard key={r.id} r={r} teams={teams} />
          ))}
        </div>
      ) : (
        <div className="empty box">
          <p className="rt-empty-title">No routines yet.</p>
          <p className="hint rt-empty-example">Example: "Every morning, @Researcher finds the 3 biggest AI stories, then @Content Team turns them into a post using @Brand voice."</p>
          <button className="btn small" onClick={() => void create()}>
            <Icon name="plus" size={14} />
            Write your first routine
          </button>
        </div>
      )}
    </>
  );
}

function RoutineCard({ r, teams }: { r: RoutineListing; teams: TeamListing[] }) {
  const [running, setRunning] = useState(false);
  const last = r.lastRun;
  const sched = r.schedule && r.schedule.type !== 'none';
  const run = async () => {
    setRunning(true);
    await attempt(() => POST(`/routines/${r.id}/run`, {}), 'Routine started');
    setRunning(false);
  };
  return (
    <div className="rt-card">
      <div className="skill-top">
        <div className="skill-ico"><Icon name="repeat" size={18} /></div>
        <div className="grow">
          <a className="skill-name rt-card-link" href={`#/routines/${r.id}`}>{r.name}</a>
          <div className="hint">{sched ? (r.enabled ? scheduleText(r.schedule) : `${scheduleText(r.schedule)} · off`) : 'run by hand'}</div>
        </div>
      </div>
      {r.description || r.text ? <p className="skill-desc">{r.description || r.text}</p> : <p className="skill-desc faint">Nothing written yet.</p>}
      {r.mentions.length ? (
        <div className="rt-ms">
          {r.mentions.map((m) => (
            <MentionChip key={`${m.kind}:${m.id}`} m={m} teams={teams} />
          ))}
        </div>
      ) : (
        <span className="hint">Nobody mentioned yet</span>
      )}
      <div className="skill-foot">
        <button className="btn small" disabled={running} onClick={() => void run()}>
          <Icon name="play" size={13} />
          Run
        </button>
        <span className="grow" />
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
    let live = true;
    void GET<Routine>(`/routines/${id}`)
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
  if (!loaded || !teams) return <p className="dim">Loading routines…</p>;
  return <EditorForm first={loaded} teams={teams} />;
}

function EditorForm({ first, teams }: { first: Routine; teams: TeamListing[] }) {
  const d = useAppState();
  const id = first.id;
  // the routine as edited; the schedule editor (plain DOM) changes schedule and enabled on it directly
  const r = useRef<Routine>(structuredClone(first));
  const [name, setName] = useState(first.name);
  const [description, setDescription] = useState(first.description || '');
  const [text, setText] = useState(first.text);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const missing = first.mentions.filter((m) => m.missing);
  const ta = useRef<HTMLTextAreaElement>(null);
  const cands = () => (d ? candidates(d, teams) : []);
  const candsRef = useRef(cands);
  candsRef.current = cands;
  useEffect(() => attachMentions(ta.current!, () => candsRef.current(), () => {}), []);

  const save = async (): Promise<boolean> => {
    setSaving(true);
    const out = await attempt(() => PUT<Routine>(`/routines/${id}`, { name, description, text, schedule: r.current.schedule, enabled: r.current.enabled }), 'Saved');
    setSaving(false);
    if (!out) return false;
    r.current.mentions = out.mentions;
    setDirty(false);
    return true;
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
        return <MentionChip key={`a:${m.id}`} m={m} teams={teams} extra={t ? <span className="rt-via">{`in ${t.name}`}</span> : null} />;
      }),
  ];
  const skills = found.filter((m) => m.kind === 'skill').map((m) => <MentionChip key={`s:${m.id}`} m={m} teams={teams} />);
  const whoRow = (label: string, ico: string, items: ReactNode[], empty: string) => (
    <div className="rt-who-row">
      <div className="rt-who-label">
        <Icon name={ico} size={13} />
        {label}
      </div>
      <div className="rt-ms">{items.length ? items : <span className="hint">{empty}</span>}</div>
    </div>
  );
  const insert = (kind: RoutineMentionKind, label: string, ico: string) => (
    <button className="btn ghost tiny" type="button" title={`Mention ${label.toLowerCase()}`} onClick={() => startMention(ta.current!, kind)}>
      <Icon name={ico} size={12} />
      {label}
    </button>
  );

  return (
    <>
      <div className="row between rt-edit-head">
        <a className="btn ghost small" href="#/routines">← Routines</a>
        <div className="row">
          <button className="btn" disabled={!dirty || saving} onClick={() => void save()}>Save</button>
        </div>
      </div>
      <div className="two-col">
        <div className="col gap-lg">
          <div className="panel">
            <div className="grid-2">
              <Field label="Name">
                <input value={name} onChange={(e) => (setName(e.target.value), setDirty(true))} />
              </Field>
              <Field label="Description">
                <input value={description} placeholder="Optional, shown on the card" onChange={(e) => (setDescription(e.target.value), setDirty(true))} />
              </Field>
            </div>
          </div>
          <div className="panel">
            <div className="panel-head">
              <h2>What to do</h2>
              <div className="actions">
                {insert('agent', 'Agent', 'bot')}
                {insert('team', 'Team', 'users')}
                {insert('skill', 'Skill', 'puzzle')}
              </div>
            </div>
            <textarea
              ref={ta}
              className="rt-text"
              rows={9}
              aria-label="What to do"
              value={text}
              placeholder={'What should be done? Type @ to mention who does it and the skills to use.\n\ne.g. @Researcher find the 3 most interesting AI stories from the last day, with links. Then @Content Team writes one X post about the best one using @Brand voice.'}
              onChange={(e) => (setText(e.target.value), setDirty(true))}
            />
            <p className="hint">
              Type <b>@</b> to mention an agent, a team or a skill. Mentioned agents and teams each get the routine (an agent in a mentioned team gets it in that team chat); mentioned skills are given to all of them for it.
            </p>
            <div className="rt-who">
              {whoRow('Who does it', 'users', doers, 'Mention at least one agent or team.')}
              {whoRow('Skills', 'puzzle', skills, 'None. Mention a skill to have them follow it.')}
              {gone.length ? (
                <p className="hint amber">
                  <Icon name="triangle-alert" size={12} />
                  {` ${gone.map((m) => `@${m.name}`).join(', ')} ${gone.length === 1 ? 'was' : 'were'} deleted, so ${gone.length === 1 ? 'it is' : 'they are'} left out.`}
                </p>
              ) : null}
            </div>
          </div>
        </div>
        <div className="col gap-lg">
          <RunIt id={id} beforeRun={async () => !dirty || (await save())} />
          <div className="panel">
            <div className="panel-head">
              <h2>Schedule</h2>
            </div>
            <DomNode make={() => scheduleEditor(r.current, () => setDirty(true), { inputLabel: 'Extra for scheduled runs (optional)' })} deps={[id]} />
          </div>
          <div className="panel">
            <div className="panel-head">
              <h2>Runs</h2>
            </div>
            <Runs id={id} />
          </div>
          <div className="row">
            <button className="btn danger small" onClick={() => void del()}>Delete routine</button>
          </div>
        </div>
      </div>
    </>
  );
}

function RunIt({ id, beforeRun }: { id: string; beforeRun: () => Promise<boolean> }) {
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async () => {
    if (!(await beforeRun())) return;
    setBusy(true);
    const out = await attempt(() => POST(`/routines/${id}/run`, { input }), 'Routine started');
    setBusy(false);
    if (out) setInput('');
  };
  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Run it</h2>
      </div>
      <textarea rows={2} aria-label="Extra for this run" placeholder="Optional: anything extra for this run" value={input} onChange={(e) => setInput(e.target.value)} />
      <div className="row mt">
        <button className="btn" disabled={busy} onClick={() => void run()}>
          <Icon name="play" size={14} />
          Run now
        </button>
      </div>
    </div>
  );
}

/** The routine's last runs, kept current; the newest is open, and whichever you opened stays open. */
function Runs({ id }: { id: string }) {
  const [runs, setRuns] = useState<RoutineRun[] | null>(null);
  const [open, setOpen] = useState<Set<string> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const load = useCallback(() => {
    clearTimeout(timer.current);
    // (a burst of events loads once)
    timer.current = setTimeout(() => void GET<RoutineRun[]>(`/routine-runs?routineId=${encodeURIComponent(id)}`).then(setRuns).catch(() => setRuns([])), 150);
  }, [id]);
  useEffect(() => (load(), () => clearTimeout(timer.current)), [load]);
  useServerEvents((ev) => ev.type === 'routine-run' && (ev as { routineId?: string }).routineId === id && load());
  if (!runs) return null;
  if (!runs.length) return <p className="empty">No runs yet.</p>;
  const isOpen = (run: RoutineRun, i: number) => (open ? open.has(run.id) : i === 0);
  return (
    <div className="col">
      {runs.slice(0, 15).map((run, i) => (
        <details
          key={run.id}
          open={isOpen(run, i)}
          onToggle={(e) => {
            const now = (e.currentTarget as HTMLDetailsElement).open;
            if (now === isOpen(run, i)) return;
            const next = new Set(open ?? (runs[0] ? [runs[0].id] : []));
            if (now) next.add(run.id);
            else next.delete(run.id);
            setOpen(next);
          }}
        >
          <summary className="rt-run-head">
            <StatusIcon status={run.status} />
            <b>{run.status}</b>
            <span className="hint">{`${ago(run.createdAt)} · ${run.trigger}`}</span>
            {run.status === 'running' ? (
              <button className="btn tiny danger" onClick={(e) => (e.preventDefault(), void attempt(() => POST(`/routine-runs/${run.id}/stop`)))}>Stop</button>
            ) : null}
          </summary>
          {run.targets.map((t) => (
            <TargetRow key={`${t.kind}:${t.id}`} t={t} />
          ))}
          {run.skills.length ? <div className="hint">{`Skills: ${run.skills.map((slug) => skillsCache().find((s) => s.slug === slug)?.name || slug).join(', ')}`}</div> : null}
        </details>
      ))}
    </div>
  );
}

function TargetRow({ t }: { t: RoutineRunTarget }) {
  return (
    <div className="run-step">
      <StatusIcon status={t.status} />
      <div>
        <div className="row rt-target">
          <b>{t.name}</b>
          <span className="hint">{t.kind === 'team' ? `team · ${t.status}` : t.status}</span>
          <span className="grow" />
          {t.kind === 'team' ? (
            <button className="btn ghost tiny" onClick={() => openChat('team', t.id)}>
              <Icon name="message-square" size={12} />
              Team chat
            </button>
          ) : t.chatId ? (
            <a className="btn ghost tiny" href={`#/agents/${t.id}/${t.chatId}`}>
              <Icon name="message-square" size={12} />
              Chat
            </a>
          ) : null}
        </div>
        {t.output ? <pre>{t.output}</pre> : null}
      </div>
    </div>
  );
}

export const title = (p: string[]) => (p[0] ? 'Routine' : 'Routines');
export const { render, unmount } = reactPage((p) => (p[0] ? <RoutineEditor id={p[0]} /> : <RoutinesList />));
