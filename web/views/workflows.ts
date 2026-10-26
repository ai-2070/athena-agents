// Workflows: chain agents, tools, approvals and posts. Run by hand or on a schedule.
import { h, mount, clear, state, GET, POST, PUT, DEL, attempt, navigate, field, select, toggle, toast, confirmBox, promptBox, ago, lightbox, onState } from '../core.ts';
import { scheduleEditor, scheduleText } from '../schedule.ts';
import type { Option, Child } from '../core.ts';
import type { Schedule, ServerEvent, Team, TeamStep } from '../../shared/types.ts';

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

let root: HTMLElement;
let params: string[] = [];
let toolList: ToolInfo[] = [];

export const title = () => 'Workflows';

export async function render(el: HTMLElement, p: string[]): Promise<void> {
  root = el;
  params = p;
  toolList = (await GET<{ tools: ToolInfo[] }>('/tools')).tools;
  if (p[0]) return renderEditor(p[0]);
  renderList();
}

export function onEvent(ev: ServerEvent): void {
  if (ev.type === 'workflow-run' && params[0] && runsEl) drawRuns();
}

async function renderList() {
  const [list, templates] = await Promise.all([GET<Workflow[]>('/workflows'), GET<WorkflowTemplate[]>('/workflow-templates')]);
  const agents = state.data!.agents;
  mount(
    root,
    h('p.lede', 'A workflow is a list of steps that run in order. Each step gets the result of the one before it, so a researcher can hand findings to a writer, then you approve, then it posts.'),
    h('div.row.between', { style: { marginBottom: '14px' } }, h('h2.section', 'Your workflows'), h('button.btn', { onclick: async () => {
      const name = await promptBox('Name the workflow', { value: 'New workflow' });
      if (!name) return;
      const wf = await attempt(() => POST<Workflow>('/workflows', { name }));
      if (wf) navigate(`#/workflows/${wf.id}`);
    } }, '+ New workflow')),
    list.length
      ? h(
          'div.cards',
          list.map((wf) =>
            h(
              'div.card.clickable',
              { onclick: () => navigate(`#/workflows/${wf.id}`) },
              h('div.card-title', wf.name),
              h('div.card-sub', wf.description || `${wf.steps.length} steps`),
              h(
                'div.card-foot',
                h('span.pill', `${wf.steps.length} steps`),
                wf.schedule?.type !== 'none' ? h(`span.pill${wf.enabled ? '.ok' : ''}`, wf.enabled ? scheduleText(wf.schedule) : 'schedule off') : null,
              ),
            ),
          ),
        )
      : h('div.empty.box', 'No workflows yet. Start from a template below.'),
    h('h2.section.mt-lg', 'Templates'),
    h(
      'div.cards',
      templates.map((t) => {
        const missing = t.needs.filter((n) => !agents.some((a) => a.name.toLowerCase() === n.toLowerCase()));
        return h(
          'div.card',
          h('div.card-title', t.name),
          h('div.card-sub', t.description),
          missing.length ? h('div.hint', `Uses: ${t.needs.join(', ')}. Missing ${missing.join(', ')} (add from Library > Starters, or pick other agents after).`) : h('div.hint', `Uses: ${t.needs.join(', ')}`),
          h('div.card-foot', h('button.btn.small', { onclick: async () => {
            const wf = await attempt(() => POST<Workflow>('/workflow-templates', { name: t.name }));
            if (wf) navigate(`#/workflows/${wf.id}`);
          } }, 'Use template')),
        );
      }),
    ),
  );
}

const STEP_TYPES: Option[] = [
  { value: 'agent', label: 'Ask an agent' },
  { value: 'tool', label: 'Use a tool' },
  { value: 'approval', label: 'Wait for my OK' },
  { value: 'x_post', label: 'Post to X (Outbox)' },
  { value: 'notify', label: 'Notify me' },
];

let runsEl: HTMLDivElement | null = null;
let currentWf: Workflow | null = null;

async function renderEditor(id: string) {
  const wf = await GET<Workflow>(`/workflows/${id}`).catch(() => null);
  if (!wf) {
    mount(root, h('p', 'Workflow not found. ', h('a', { href: '#/workflows' }, 'Back')));
    return;
  }
  currentWf = wf;
  const agents = state.data!.agents;
  const accounts = state.data!.accounts.x;
  let dirty = false;
  const saveBtn = h('button.btn', { disabled: true, onclick: () => save() }, 'Save');
  const mark = () => {
    dirty = true;
    saveBtn.disabled = false;
  };
  const save = async () => {
    const r = await attempt(() => PUT(`/workflows/${id}`, wf), 'Saved');
    if (r) {
      dirty = false;
      saveBtn.disabled = true;
    }
    return r;
  };

  const stepsEl = h('div');
  const drawSteps = () => {
    clear(stepsEl);
    wf.steps.forEach((s, i) => {
      if (i) stepsEl.append(h('div.step-arrow', '↓'));
      const set = (k: string) => (v: string | boolean) => {
        s[k] = v;
        mark();
      };
      const body = h('div.col.mt');
      if (s.type === 'agent')
        body.append(
          field('Agent', select([{ value: '', label: 'Pick an agent…' }, ...agents.map((a) => ({ value: a.id, label: `${a.emoji || ''} ${a.name}` }))], s.agentId || '', set('agentId'))),
          field('Message', h('textarea', { rows: 4, value: s.prompt || '', placeholder: '{{prev}}', oninput: (e) => set('prompt')(e.target.value) }), 'Use {{input}} for the run input, {{prev}} for the last step, {{step1}}… for any step, {{date}}.'),
        );
      else if (s.type === 'tool')
        body.append(
          field('Tool', select([{ value: '', label: 'Pick a tool…' }, ...toolList.filter((t) => t.group !== 'knowledge').map((t) => ({ value: t.name, label: `${t.name} (${t.group})` }))], s.tool || '', (v) => (set('tool')(v), drawSteps()))),
          // (no tool picked: append() turns null into the text "null")
          s.tool ? h('p.hint', toolList.find((t) => t.name === s.tool)?.description || '') : (null as unknown as Node),
          field('Arguments (JSON)', h('textarea.code', { rows: 4, value: s.args || '{}', oninput: (e) => set('args')(e.target.value) }), 'Placeholders work inside strings, e.g. {"workflow": "imagegen", "prompt": "{{prev}}"}'),
        );
      else if (s.type === 'approval')
        body.append(field('What to show you', h('textarea', { rows: 2, value: s.message || '{{prev}}', oninput: (e) => set('message')(e.target.value) }), 'The run pauses in Needs you. You can edit the text before it continues.'));
      else if (s.type === 'x_post')
        body.append(
          field('Account', select([{ value: '', label: accounts.length ? 'First connected account' : 'No X account connected yet' }, ...accounts.map((a) => ({ value: a.username, label: `@${a.username}` }))], s.account || '', set('account'))),
          field('Text', h('textarea', { rows: 3, value: s.text || '{{prev}}', oninput: (e) => set('text')(e.target.value) })),
          h('label.row', toggle(!!s.thread, set('thread')), h('span', 'Thread: split parts on a line with ---')),
          h('p.hint', 'It goes to the Outbox for approval unless the account has auto-post on.'),
        );
      else if (s.type === 'notify')
        body.append(field('Message', h('textarea', { rows: 2, value: s.text || '{{prev}}', oninput: (e) => set('text')(e.target.value) })), h('label.row', toggle(!!s.telegram, set('telegram')), h('span', 'Also send on Telegram')));
      stepsEl.append(
        h(
          'div.step',
          h(
            'div.row.between',
            h('div.row', h('span.step-num', `STEP ${i + 1}`), select(STEP_TYPES, s.type, (v) => ((s.type = v), mark(), drawSteps())), h('input', { value: s.label || '', placeholder: 'Label (optional)', style: { width: '220px' }, oninput: (e) => set('label')(e.target.value) })),
            h(
              'div.row',
              { style: { gap: '4px' } },
              h('button.icon-btn', { title: 'Move up', disabled: i === 0, onclick: () => (wf.steps.splice(i - 1, 0, wf.steps.splice(i, 1)[0]), mark(), drawSteps()) }, '↑'),
              h('button.icon-btn', { title: 'Move down', disabled: i === wf.steps.length - 1, onclick: () => (wf.steps.splice(i + 1, 0, wf.steps.splice(i, 1)[0]), mark(), drawSteps()) }, '↓'),
              h('button.icon-btn', { title: 'Remove', onclick: () => (wf.steps.splice(i, 1), mark(), drawSteps()) }, '✕'),
            ),
          ),
          body,
        ),
      );
    });
    stepsEl.append(
      h('div.row.mt', STEP_TYPES.map((t) => h('button.btn.ghost.small', { onclick: () => (wf.steps.push({ id: Math.random().toString(36).slice(2), type: t.value, prompt: '{{prev}}' }), mark(), drawSteps()) }, `+ ${t.label}`))),
    );
  };

  const schedBox = scheduleEditor(wf, mark);

  const runInput = h('textarea', { rows: 2, placeholder: 'Input for this run ({{input}})' });
  runsEl = h('div.col');
  mount(
    root,
    h('div.row.between', { style: { marginBottom: '16px' } }, h('a.btn.ghost.small', { href: '#/workflows' }, '← Workflows'), h('div.row', saveBtn)),
    h(
      'div.two-col',
      h(
        'div.col.gap-lg',
        h(
          'div.panel',
          h('div.grid-2', field('Name', h('input', { value: wf.name, oninput: (e) => ((wf.name = e.target.value), mark()) })), field('Description', h('input', { value: wf.description || '', oninput: (e) => ((wf.description = e.target.value), mark()) }))),
        ),
        h('div.panel', h('div.panel-head', h('h2', 'Steps')), stepsEl),
      ),
      h(
        'div.col.gap-lg',
        h(
          'div.panel',
          h('div.panel-head', h('h2', 'Run it')),
          runInput,
          h('div.row.mt', h('button.btn', { onclick: async () => {
            if (dirty && !(await save())) return;
            const r = await attempt(() => POST(`/workflows/${id}/run`, { input: runInput.value }), 'Started');
            if (r) drawRuns();
          } }, 'Run now')),
        ),
        h('div.panel', h('div.panel-head', h('h2', 'Schedule')), schedBox),
        h('div.panel', h('div.panel-head', h('h2', 'Runs')), runsEl),
        h('div.row', h('button.btn.danger.small', { onclick: async () => {
          if (!(await confirmBox(`Delete workflow "${wf.name}"?`, { ok: 'Delete', danger: true }))) return;
          await attempt(() => DEL(`/workflows/${id}`));
          navigate('#/workflows');
        } }, 'Delete workflow')),
      ),
    ),
  );
  drawSteps();
  drawRuns();
}

let runsTimer: ReturnType<typeof setTimeout> | undefined;
async function drawRuns() {
  clearTimeout(runsTimer);
  runsTimer = setTimeout(async () => {
    if (!runsEl || !currentWf) return;
    const list = await GET<WorkflowRun[]>(`/workflow-runs?workflowId=${currentWf.id}`);
    const icon = (st: string) => (st === 'done' ? h('span.accent', '✓') : st === 'failed' ? h('span.red', '✕') : st === 'running' ? h('span.dot.busy') : st === 'needs-you' ? h('span.amber', '!') : h('span.faint', '·'));
    mount(
      runsEl,
      list.length
        ? list.slice(0, 15).map((r) =>
            h(
              'details',
              { open: r === list[0] },
              h('summary', { style: { cursor: 'pointer', padding: '6px 0' } }, h('span.row', { style: { display: 'inline-flex' } }, icon(r.status), h('b', r.status), h('span.hint', `${ago(r.createdAt)} · ${r.trigger}`), r.status === 'running' ? h('button.btn.tiny.danger', { onclick: (e) => (e.preventDefault(), attempt(() => POST(`/workflow-runs/${r.id}/stop`))) }, 'Stop') : null)),
              r.input ? h('div.hint', `Input: ${r.input}`) : null,
              r.steps.map((s, i) =>
                h(
                  'div.run-step',
                  icon(s.status),
                  h('div', h('div', h('b', `${i + 1}. ${s.label}`), s.agentName ? h('span.hint', ` · ${s.agentName}`) : null), s.output ? h('pre', s.output as Child) : null, s.images?.length ? h('div.tool-images', s.images.map((src) => h('img', { src, onclick: () => lightbox(src) }))) : null),
                ),
              ),
              r.error ? h('p.red', r.error) : null,
            ),
          )
        : h('p.empty', 'No runs yet.'),
    );
  }, 150);
}
