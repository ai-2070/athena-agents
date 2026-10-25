// Workflows: chain agents, tools, approvals and posts. Run by hand or on a schedule.
import { h, mount, clear, state, GET, POST, PUT, DEL, attempt, navigate, field, select, seg, toggle, toast, confirmBox, promptBox, ago, lightbox, onState } from '../core.js';

let root;
let params = [];
let toolList = [];

export const title = () => 'Workflows';

export async function render(el, p) {
  root = el;
  params = p;
  toolList = (await GET('/tools')).tools;
  if (p[0]) return renderEditor(p[0]);
  renderList();
}

export function onEvent(ev) {
  if (ev.type === 'workflow-run' && params[0] && runsEl) drawRuns();
}

async function renderList() {
  const [list, templates] = await Promise.all([GET('/workflows'), GET('/workflow-templates')]);
  const agents = state.data.agents;
  mount(
    root,
    h('p.lede', 'A workflow is a list of steps that run in order. Each step gets the result of the one before it, so a researcher can hand findings to a writer, then you approve, then it posts.'),
    h('div.row.between', { style: { marginBottom: '14px' } }, h('h2.section', 'Your workflows'), h('button.btn', { onclick: async () => {
      const name = await promptBox('Name the workflow', { value: 'New workflow' });
      if (!name) return;
      const wf = await attempt(() => POST('/workflows', { name }));
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
            const wf = await attempt(() => POST('/workflow-templates', { name: t.name }));
            if (wf) navigate(`#/workflows/${wf.id}`);
          } }, 'Use template')),
        );
      }),
    ),
  );
}

function scheduleText(s) {
  if (!s || s.type === 'none') return 'manual';
  if (s.type === 'interval') return `every ${s.minutes || 60} min`;
  return `daily ${s.time || '09:00'}`;
}

const STEP_TYPES = [
  { value: 'agent', label: 'Ask an agent' },
  { value: 'tool', label: 'Use a tool' },
  { value: 'approval', label: 'Wait for my OK' },
  { value: 'x_post', label: 'Post to X (Outbox)' },
  { value: 'notify', label: 'Notify me' },
];

let runsEl = null;
let currentWf = null;

async function renderEditor(id) {
  const wf = await GET(`/workflows/${id}`).catch(() => null);
  if (!wf) {
    mount(root, h('p', 'Workflow not found. ', h('a', { href: '#/workflows' }, 'Back')));
    return;
  }
  currentWf = wf;
  const agents = state.data.agents;
  const accounts = state.data.accounts.x;
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
      const set = (k) => (v) => {
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
          s.tool ? h('p.hint', toolList.find((t) => t.name === s.tool)?.description || '') : null,
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

  // schedule
  wf.schedule ||= { type: 'none' };
  const schedBox = h('div.col');
  const drawSched = () => {
    const s = wf.schedule;
    mount(
      schedBox,
      seg([{ value: 'none', label: 'Manual' }, { value: 'interval', label: 'Every…' }, { value: 'daily', label: 'Daily' }], s.type, (v) => ((s.type = v), mark(), drawSched())),
      s.type === 'interval' ? field('Every (minutes)', h('input', { type: 'number', min: 5, value: s.minutes || 60, oninput: (e) => ((s.minutes = Number(e.target.value)), mark()) })) : null,
      s.type === 'daily'
        ? h(
            'div.col',
            field('Time', h('input', { type: 'time', value: s.time || '09:00', oninput: (e) => ((s.time = e.target.value), mark()) })),
            h(
              'div.chips',
              ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d, i) => {
                const days = s.days?.length ? s.days : [0, 1, 2, 3, 4, 5, 6];
                const c = h(`button.chip${days.includes(i) ? '.on' : ''}`, {
                  onclick: () => {
                    const cur = new Set(s.days?.length ? s.days : [0, 1, 2, 3, 4, 5, 6]);
                    cur.has(i) ? cur.delete(i) : cur.add(i);
                    s.days = [...cur].sort();
                    mark();
                    drawSched();
                  },
                }, d);
                return c;
              }),
            ),
          )
        : null,
      s.type !== 'none' ? field('Input for scheduled runs', h('input', { value: s.input || '', oninput: (e) => ((s.input = e.target.value), mark()) })) : null,
      s.type !== 'none' ? h('label.row', toggle(!!wf.enabled, (v) => ((wf.enabled = v), mark())), h('span', 'Schedule on (runs while the dashboard is open)')) : null,
    );
  };

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
  drawSched();
  drawRuns();
}

let runsTimer;
async function drawRuns() {
  clearTimeout(runsTimer);
  runsTimer = setTimeout(async () => {
    if (!runsEl || !currentWf) return;
    const list = await GET(`/workflow-runs?workflowId=${currentWf.id}`);
    const icon = (st) => (st === 'done' ? h('span.accent', '✓') : st === 'failed' ? h('span.red', '✕') : st === 'running' ? h('span.dot.busy') : st === 'needs-you' ? h('span.amber', '!') : h('span.faint', '·'));
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
                  h('div', h('div', h('b', `${i + 1}. ${s.label}`), s.agentName ? h('span.hint', ` · ${s.agentName}`) : null), s.output ? h('pre', s.output) : null, s.images?.length ? h('div.tool-images', s.images.map((src) => h('img', { src, onclick: () => lightbox(src) }))) : null),
                ),
              ),
              r.error ? h('p.red', r.error) : null,
            ),
          )
        : h('p.empty', 'No runs yet.'),
    );
  }, 150);
}
