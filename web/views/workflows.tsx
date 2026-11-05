// Workflows: chain agents, tools, approvals and posts. Run by hand or on a schedule.
import { Plate, PlateLink } from '../ui/surface.tsx';
import { Button, ButtonLink, IconButton } from '../ui/button.tsx';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { GET, attempt, navigate, confirmBox, promptBox, ago, lightbox } from '../core.ts';
import { rpc } from '../client/rpc.ts';
import { scheduleEditor, scheduleText } from '../schedule.tsx';
import { Field, Switch } from '../ui/controls.tsx';
import { DomNode, Icon, ProjectScoped, reactPage, useAppState, useServerEvents } from '../ui/react.tsx';
import { Dot, Pill } from '../ui/marks.tsx';
import { SelectControl } from '../ui/select.tsx';
import type { AppState, Schedule, Team, TeamStep } from '../../shared/types.ts';

/** One entry of GET /api/tools → tools. */
interface ToolInfo {
  name: string;
  group: string;
  risk: string;
  description: string;
}
/** An old-style workflow step: the fields each step type edits. */
interface WorkflowStep extends TeamStep {
  type: string;
  args?: string;
  message?: string;
  account?: string;
  text?: string;
  thread?: boolean;
  telegram?: boolean;
}
/** The schedule as this page and server/workflows.ts use it (minutes and days aren't in shared Schedule). */
interface WorkflowSchedule extends Schedule {
  minutes?: number;
  days?: number[];
}
type Workflow = Omit<Team, 'steps' | 'schedule'> & { steps: WorkflowStep[]; schedule?: WorkflowSchedule };
/** One entry of GET /api/workflow-templates. */
interface WorkflowTemplate {
  name: string;
  description: string;
  needs: string[];
}
/** GET /api/workflow-runs (mirrors WorkflowRun in server/store.ts). */
interface WorkflowRunStep {
  id?: string;
  label: string;
  type: string;
  status: string;
  output: unknown;
  agentName?: string;
  images?: string[];
}
interface WorkflowRun {
  id: string;
  createdAt?: number;
  workflowId: string;
  workflowName: string;
  input: string;
  trigger: string;
  status: string;
  steps: WorkflowRunStep[];
  error?: string;
}

const STEP_TYPES = [
  { value: 'agent', label: 'Ask an agent' },
  { value: 'tool', label: 'Use a tool' },
  { value: 'approval', label: 'Wait for my OK' },
  { value: 'x_post', label: 'Post to X (Outbox)' },
  { value: 'notify', label: 'Notify me' },
];

/** The steps with one moved up or down (by -1 or +1); unchanged at the ends. */
export function moveStep<T>(steps: readonly T[], i: number, by: -1 | 1): T[] {
  const j = i + by;
  if (j < 0 || j >= steps.length) return [...steps];
  const out = [...steps];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

function Status({ st }: { st: string }) {
  if (st === 'done') return <span className="text-ok" aria-label="done">✓</span>;
  if (st === 'failed') return <span className="text-red" aria-label="failed">✕</span>;
  if (st === 'running') return <Dot tone="busy" aria-label="running" />;
  if (st === 'needs-you') return <span className="text-amber" aria-label="needs you">!</span>;
  return <span className="text-faint">·</span>;
}

// ---------- the list ----------
function WorkflowsList() {
  const d = useAppState();
  const [data, setData] = useState<{ list: Workflow[]; templates: WorkflowTemplate[] } | null>(null);
  useEffect(() => {
    let live = true;
    void Promise.all([rpc.workflows.list(), rpc.workflows.templates.list()]).then(([list, templates]) => live && setData({ list, templates }));
    return () => void (live = false);
  }, []);
  if (!data || !d) return null;
  const create = async () => {
    const name = await promptBox('Name the workflow', { value: 'New workflow' });
    if (!name) return;
    const wf = await attempt(() => rpc.workflows.create({ name }));
    if (wf) navigate(`#/workflows/${wf.id}`);
  };
  const useTemplate = async (t: WorkflowTemplate) => {
    const wf = await attempt(() => rpc.workflows.templates.create({ name: t.name }));
    if (wf) navigate(`#/workflows/${wf.id}`);
  };
  return (
    <>
      <p className="lede max-w-[68ch]">A workflow is a list of steps that run in order. Each step gets the result of the one before it, so a researcher can hand findings to a writer, then you approve, then it posts.</p>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h2 className="section m-0">Your workflows</h2>
        <Button  onClick={() => void create()}>
          <Icon name="plus" size={14} />
          New workflow
        </Button>
      </div>
      {data.list.length ? (
        <div className="cards">
          {data.list.map((wf) => (
            <PlateLink key={wf.id} className="card hover:shadow-none clickable" href={`#/workflows/${wf.id}`}>
              <div className="card-title">{wf.name}</div>
              <div className="card-sub">{wf.description || `${wf.steps.length} steps`}</div>
              <div className="card-foot">
                <Pill>{`${wf.steps.length} steps`}</Pill>
                {wf.schedule && wf.schedule.type !== 'none' ? <Pill tone={wf.enabled ? 'ok' : 'dim'}>{wf.enabled ? scheduleText(wf.schedule) : 'schedule off'}</Pill> : null}
              </div>
            </PlateLink>
          ))}
        </div>
      ) : (
        <div className="empty py-12">No workflows yet. Start from a template below.</div>
      )}
      <h2 className="section mt-10 mb-6">Templates</h2>
      <div className="cards">
        {data.templates.map((t) => {
          const missing = t.needs.filter((n) => !d.agents.some((a) => a.name.toLowerCase() === n.toLowerCase()));
          return (
            <Plate key={t.name} className="card hover:shadow-none">
              <div className="card-title">{t.name}</div>
              <div className="card-sub">{t.description}</div>
              <div className="hint">{missing.length ? `Uses: ${t.needs.join(', ')}. Missing ${missing.join(', ')} (add from Agent library > Athena, or pick other agents after).` : `Uses: ${t.needs.join(', ')}`}</div>
              <div className="card-foot">
                <Button size="small" onClick={() => void useTemplate(t)}>Use template</Button>
              </div>
            </Plate>
          );
        })}
      </div>
    </>
  );
}

// ---------- the editor ----------
function WorkflowEditor({ id }: { id: string }) {
  const d = useAppState();
  const [loaded, setLoaded] = useState<{ wf: Workflow; tools: ToolInfo[] } | 'gone' | null>(null);
  useEffect(() => {
    let live = true;
    void Promise.all([rpc.workflows.get({ id }), GET<{ tools: ToolInfo[] }>('/tools')])
      .then(([wf, t]) => live && setLoaded({ wf, tools: t.tools }))
      .catch(() => live && setLoaded('gone'));
    return () => void (live = false);
  }, [id]);
  if (loaded === 'gone')
    return (
      <p>
        Workflow not found. <a href="#/workflows">Back</a>
      </p>
    );
  if (!loaded || !d) return null;
  return <EditorForm first={loaded.wf} tools={loaded.tools} d={d} />;
}

function EditorForm({ first, tools, d }: { first: Workflow; tools: ToolInfo[]; d: AppState }) {
  const id = first.id;
  // the schedule editor (plain DOM) changes schedule and enabled on this object directly
  const sched = useRef<Workflow>(structuredClone(first));
  const [name, setName] = useState(first.name);
  const [description, setDescription] = useState(first.description || '');
  const [steps, setSteps] = useState<WorkflowStep[]>(() => structuredClone(first.steps));
  const [dirty, setDirty] = useState(false);
  const [input, setInput] = useState('');
  const [runsVersion, setRunsVersion] = useState(0);
  const change = (next: WorkflowStep[]) => (setSteps(next), setDirty(true));
  const setStep = (i: number, patch: Partial<WorkflowStep>) => change(steps.map((s, j) => (j === i ? { ...s, ...patch } : s)));

  const save = async () => {
    const r = await attempt(() => rpc.workflows.change({ ...sched.current, name, description, steps, id }), 'Saved');
    if (r) setDirty(false);
    return r;
  };
  const run = async () => {
    if (dirty && !(await save())) return;
    if (await attempt(() => rpc.workflows.run({ id, input }), 'Started')) setRunsVersion((v) => v + 1);
  };
  const del = async () => {
    if (!(await confirmBox(`Delete workflow "${name}"?`, { ok: 'Delete', danger: true }))) return;
    await attempt(() => rpc.workflows.remove({ id }));
    navigate('#/workflows');
  };

  return (
    <>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <ButtonLink variant="ghost" size="small" href="#/workflows">← Workflows</ButtonLink>
        <div className="flex flex-wrap items-center gap-3">
          <Button  disabled={!dirty} onClick={() => void save()}>Save</Button>
        </div>
      </div>
      <div className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] items-start gap-6 max-lg:grid-cols-1">
        <div className="flex flex-col gap-6 [&>.panel]:mt-0 [&>.panel>:last-child]:mb-0">
          <Plate className="panel">
            <div className="grid grid-cols-2 gap-4 max-md:grid-cols-1">
              <Field label="Name">
                <input value={name} onChange={(e) => (setName(e.target.value), setDirty(true))} />
              </Field>
              <Field label="Description">
                <input value={description} onChange={(e) => (setDescription(e.target.value), setDirty(true))} />
              </Field>
            </div>
          </Plate>
          <Plate className="panel">
            <div className="panel-head">
              <h2>Steps</h2>
            </div>
            {steps.length ? null : <p className="empty py-6">No steps yet. Add the first one below.</p>}
            <ol>
              {steps.map((s, i) => (
                <li key={s.id || i}>
                  {i ? <div className="py-2 text-center text-[14px] leading-none text-faint" aria-hidden="true">↓</div> : null}
                  <Plate className="step relative rounded-box p-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex flex-wrap items-center gap-3">
                        <span className="text-[12.5px] leading-[normal] font-semibold text-dim">{`Step ${i + 1}`}</span>
                        <SelectControl aria-label={`Step ${i + 1}: what it does`} value={s.type} onChange={(value) => setStep(i, { type: value })} options={STEP_TYPES} />
                        <input className="wf-label w-55" aria-label={`Step ${i + 1}: label`} value={s.label || ''} placeholder="Label (optional)" onChange={(e) => setStep(i, { label: e.target.value })} />
                      </div>
                      <div className="flex flex-wrap items-center gap-1">
                        <IconButton title="Move up" aria-label={`Move step ${i + 1} up`} disabled={i === 0} onClick={() => change(moveStep(steps, i, -1))}>↑</IconButton>
                        <IconButton title="Move down" aria-label={`Move step ${i + 1} down`} disabled={i === steps.length - 1} onClick={() => change(moveStep(steps, i, 1))}>↓</IconButton>
                        <IconButton title="Remove" aria-label={`Remove step ${i + 1}`} onClick={() => change(steps.filter((_, j) => j !== i))}>✕</IconButton>
                      </div>
                    </div>
                    <div className="mt-4 flex flex-col gap-4">
                      <StepFields s={s} set={(patch) => setStep(i, patch)} tools={tools} d={d} />
                    </div>
                  </Plate>
                </li>
              ))}
            </ol>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              {STEP_TYPES.map((t) => (
                <Button key={t.value} variant="ghost" size="small" onClick={() => change([...steps, { id: Math.random().toString(36).slice(2), type: t.value, prompt: '{{prev}}' }])}>{`+ ${t.label}`}</Button>
              ))}
            </div>
          </Plate>
        </div>
        <div className="flex flex-col gap-6 [&>.panel]:mt-0 [&>.panel>:last-child]:mb-0">
          <Plate className="panel">
            <div className="panel-head">
              <h2>Run it</h2>
            </div>
            <textarea rows={2} aria-label="Input for this run" placeholder="Input for this run ({{input}})" value={input} onChange={(e) => setInput(e.target.value)} />
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <Button  onClick={() => void run()}>Run now</Button>
            </div>
          </Plate>
          <Plate className="panel">
            <div className="panel-head">
              <h2>Schedule</h2>
            </div>
            <DomNode make={() => scheduleEditor(sched.current, () => setDirty(true))} deps={[id]} />
          </Plate>
          <Plate className="panel">
            <div className="panel-head">
              <h2>Runs</h2>
            </div>
            <Runs id={id} version={runsVersion} />
          </Plate>
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="danger" size="small" onClick={() => void del()}>Delete workflow</Button>
          </div>
        </div>
      </div>
    </>
  );
}

function StepFields({ s, set, tools, d }: { s: WorkflowStep; set: (patch: Partial<WorkflowStep>) => void; tools: ToolInfo[]; d: AppState }) {
  const area = (label: string, key: 'prompt' | 'message' | 'text', rows: number, fallback: string, hint?: ReactNode) => (
    <Field label={label} hint={hint}>
      <textarea rows={rows} value={(s[key] as string | undefined) ?? fallback} placeholder={key === 'prompt' ? '{{prev}}' : undefined} onChange={(e) => set({ [key]: e.target.value })} />
    </Field>
  );
  if (s.type === 'agent')
    return (
      <>
        <Field label="Agent">
          <SelectControl aria-label="Agent" value={s.agentId || ''} onChange={(value) => set({ agentId: value })} options={[{ value: '', label: 'Pick an agent…' }, ...d.agents.map((a) => ({ value: a.id, label: `${a.emoji || ''} ${a.name}` }))]} />
        </Field>
        {area('Message', 'prompt', 4, '', 'Use {{input}} for the run input, {{prev}} for the last step, {{step1}}… for any step, {{date}}.')}
      </>
    );
  if (s.type === 'tool')
    return (
      <>
        <Field label="Tool">
          <SelectControl aria-label="Tool" value={s.tool || ''} onChange={(value) => set({ tool: value })} options={[{ value: '', label: 'Pick a tool…' }, ...tools.filter((t) => t.group !== 'knowledge').map((t) => ({ value: t.name, label: `${t.name} (${t.group})` }))]} />
        </Field>
        {s.tool ? <p className="hint">{tools.find((t) => t.name === s.tool)?.description || ''}</p> : null}
        <Field label="Arguments (JSON)" hint={'Placeholders work inside strings, e.g. {"workflow": "imagegen", "prompt": "{{prev}}"}'}>
          <textarea className="code" rows={4} value={s.args ?? '{}'} onChange={(e) => set({ args: e.target.value })} />
        </Field>
      </>
    );
  if (s.type === 'approval') return area('What to show you', 'message', 2, '{{prev}}', 'The run pauses in Needs you. You can edit the text before it continues.');
  if (s.type === 'x_post')
    return (
      <>
        <Field label="Account">
          <SelectControl aria-label="Account" value={s.account || ''} onChange={(value) => set({ account: value })} options={[{ value: '', label: d.accounts.x.length ? 'First connected account' : 'No X account connected yet' }, ...d.accounts.x.map((a) => ({ value: a.username, label: `@${a.username}` }))]} />
        </Field>
        {area('Text', 'text', 3, '{{prev}}')}
        <Switch checked={!!s.thread} onChange={(v) => set({ thread: v })}>Thread: split parts on a line with ---</Switch>
        <p className="hint">It goes to the Outbox for approval unless the account has auto-post on.</p>
      </>
    );
  if (s.type === 'notify')
    return (
      <>
        {area('Message', 'text', 2, '{{prev}}')}
        <Switch checked={!!s.telegram} onChange={(v) => set({ telegram: v })}>Also draft a Telegram message in Outbox</Switch>
        <p className="hint">Choose the gateway recipient and approve the draft in Outbox before it sends.</p>
      </>
    );
  return null;
}

/** The workflow's last runs, kept current; the newest is open. */
function Runs({ id, version }: { id: string; version: number }) {
  const [runs, setRuns] = useState<WorkflowRun[] | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const load = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void rpc.workflows.runs.list({ workflowId: id }).then(setRuns).catch(() => setRuns([])), 150);
  }, [id]);
  useEffect(() => (load(), () => clearTimeout(timer.current)), [load, version]);
  useServerEvents((ev) => ev.type === 'workflow-run' && load());
  if (!runs) return null;
  if (!runs.length) return <p className="empty py-6">No runs yet.</p>;
  return (
    <div className="flex flex-col gap-3">
      {runs.slice(0, 15).map((r, i) => (
        <details key={r.id} open={i === 0}>
          <summary className="cursor-pointer py-2">
            <span className="inline-flex flex-wrap items-center gap-3">
              <Status st={r.status} />
              <b>{r.status}</b>
              <span className="hint">{`${ago(r.createdAt)} · ${r.trigger}`}</span>
              {r.status === 'running' ? (
                <Button variant="danger" size="tiny" onClick={(e) => (e.preventDefault(), void attempt(() => rpc.workflows.runs.stop({ id: r.id })))}>Stop</Button>
              ) : null}
            </span>
          </summary>
          {r.input ? <div className="hint">{`Input: ${r.input}`}</div> : null}
          {r.steps.map((s, j) => (
            <div key={s.id || j} className="grid grid-cols-[22px_1fr] gap-3 border-b border-line py-3 last:border-b-0 [&_pre]:max-h-50">
              <Status st={s.status} />
              <div>
                <div>
                  <b>{`${j + 1}. ${s.label}`}</b>
                  {s.agentName ? <span className="hint">{` · ${s.agentName}`}</span> : null}
                </div>
                {s.output ? <pre>{typeof s.output === 'string' ? s.output : JSON.stringify(s.output, null, 2)}</pre> : null}
                {s.images?.length ? (
                  <div className="tool-images">
                    {s.images.map((src) => (
                      <button key={src} type="button" className="img-button" aria-label="Show the image big" onClick={() => lightbox(src)}>
                        <img src={src} alt="" />
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
          ))}
          {r.error ? <p className="text-red">{r.error}</p> : null}
        </details>
      ))}
    </div>
  );
}

export const title = () => 'Workflows';
export const { render, unmount } = reactPage((p) => (p[0] ? <ProjectScoped><WorkflowEditor id={p[0]} /></ProjectScoped> : <WorkflowsList />));
