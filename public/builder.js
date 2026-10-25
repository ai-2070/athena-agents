// Branch builder: name it, pick its agents (or let the Brain build it), choose what it can access.
import { h, mount, clear, state, GET, POST, PUT, attempt, modal, chipSet, select, toast, refreshSoon, avatar } from './core.js';

const PALETTE = ['#3d58c0', '#b0508a', '#c07a34', '#3a8a7a', '#7350c8', '#b8a03a', '#4f7fa8', '#5a9a3a', '#a84a5a', '#2f8fa0'];
const rid = () => Math.random().toString(36).slice(2);
const LOOK = { approval: ['✋', 'Wait for your OK'], x_post: ['𝕏', 'Post to X (Outbox)'], notify: ['✉', 'Notify you'], tool: ['⚙', 'Tool'] };

// Opens the builder. prefill: a design from the Brain ({name, description, steps, access}); wf: an existing branch to edit.
export async function openBranchBuilder({ wf = null, prefill = null, describe = '', onSaved } = {}) {
  const d = state.data;
  const mcp = await GET('/mcp').catch(() => ({ servers: {} }));
  const b = {
    name: wf?.name || prefill?.name || '',
    description: wf?.description || prefill?.description || describe || '',
    steps: structuredClone(wf?.steps || prefill?.steps || []),
    access: { toolGroups: [...(wf?.access?.toolGroups || prefill?.access?.toolGroups || [])], mcpServers: [...(wf?.access?.mcpServers || prefill?.access?.mcpServers || [])] },
  };
  const agentsById = () => new Map(state.data.agents.map((a) => [a.id, a]));

  const name = h('input', { value: b.name, placeholder: 'e.g. Daily X content, Client reports, Video pipeline' });
  const desc = h('textarea', { rows: 2, value: b.description, placeholder: 'What this team does. Write it here and press Auto-build to let the Brain set it up.' });
  name.addEventListener('input', () => (b.name = name.value));
  desc.addEventListener('input', () => (b.description = desc.value));

  const stepsEl = h('div.bb-steps');
  const drawSteps = () => {
    const byId = agentsById();
    clear(stepsEl);
    b.steps.forEach((s, j) => {
      const a = s.type === 'agent' ? byId.get(s.agentId) : null;
      const isNew = s.type === 'agent' && s.newAgent;
      const look = LOOK[s.type];
      const prompt = h('input', { value: s.prompt ?? s.text ?? s.message ?? '', placeholder: s.type === 'agent' ? 'What it should do ({{input}}, {{prev}})' : '' });
      prompt.addEventListener('input', () => {
        if (s.type === 'agent') s.prompt = prompt.value;
        else if (s.type === 'approval') s.message = prompt.value;
        else s.text = prompt.value;
      });
      stepsEl.append(
        h(
          'div.bb-step',
          h('span.bb-n', String(j + 1)),
          a ? avatar(a) : h('div.avatar', isNew ? s.newAgent.emoji || '🤖' : look?.[0] || '?'),
          h(
            'div.grow',
            h('div.row', { style: { gap: '6px' } }, h('b', a ? a.name : isNew ? s.newAgent.name : s.type === 'agent' ? 'Missing agent' : look?.[1] || s.type), isNew ? h('span.pill.ok', 'new agent') : null, isNew && s.newAgent.specialty ? h('span.hint', s.newAgent.specialty) : null),
            s.type === 'tool' ? h('div.hint', s.tool) : prompt,
          ),
          h(
            'div.st-step-actions',
            h('button', { title: 'Move up', disabled: j === 0, onclick: () => (b.steps.splice(j - 1, 0, b.steps.splice(j, 1)[0]), drawSteps()) }, '↑'),
            h('button', { title: 'Move down', disabled: j === b.steps.length - 1, onclick: () => (b.steps.splice(j + 1, 0, b.steps.splice(j, 1)[0]), drawSteps()) }, '↓'),
            h('button', { title: 'Remove', onclick: () => (b.steps.splice(j, 1), drawSteps()) }, '✕'),
          ),
        ),
      );
    });
    if (!b.steps.length) stepsEl.append(h('p.empty', 'No agents yet. Add them below, or describe the team and press Auto-build.'));
  };

  let addId = d.agents[0]?.id || '';
  const addRow = h(
    'div.row.mt',
    d.agents.length
      ? [
          h('div', { style: { width: '240px' } }, select(d.agents.map((a) => ({ value: a.id, label: `${a.emoji || ''} ${a.name}` })), addId, (v) => (addId = v))),
          h('button.btn.small', {
            onclick: () => {
              if (!addId) return;
              b.steps.push({ id: rid(), type: 'agent', agentId: addId, prompt: b.steps.length ? 'Continue from this:\n{{prev}}' : '{{input}}' });
              drawSteps();
            },
          }, '+ Add agent'),
        ]
      : h('span.hint', 'You have no agents yet: Auto-build can create them.'),
    h('button.btn.ghost.tiny', { onclick: () => (b.steps.push({ id: rid(), type: 'approval', label: 'Check before it continues', message: '{{prev}}' }), drawSteps()) }, '+ ✋ Your OK'),
    h('button.btn.ghost.tiny', { onclick: () => (b.steps.push({ id: rid(), type: 'x_post', label: 'Post to X', text: '{{prev}}' }), drawSteps()) }, '+ 𝕏 Post'),
    h('button.btn.ghost.tiny', { onclick: () => (b.steps.push({ id: rid(), type: 'notify', label: 'Tell me', text: 'Done: {{prev}}' }), drawSteps()) }, '+ ✉ Notify'),
  );

  const accessEl = h('div');
  const drawAccess = () =>
    mount(
      accessEl,
      h('div.label', 'Programs & tools'),
      h('div.mt', chipSet(state.data.toolGroups.map((g) => ({ value: g.id, label: g.label, title: g.description })), b.access.toolGroups, (v) => (b.access.toolGroups = v))),
      Object.keys(mcp.servers).length ? [h('div.label.mt', 'MCP servers'), h('div.mt', chipSet(Object.keys(mcp.servers), b.access.mcpServers, (v) => (b.access.mcpServers = v)))] : null,
      h('p.hint.mt', 'While this team runs, every agent on it gets these on top of its own tools.'),
    );

  const status = h('span.hint');
  const autoBtn = h('button.btn.small', {
    onclick: async () => {
      const text = [b.name, b.description].filter(Boolean).join(': ').trim();
      if (!text) return toast('Describe what the team should do first.', 'warn');
      autoBtn.disabled = true;
      status.textContent = 'The Brain is building it from your agents…';
      const design = await attempt(() => POST('/assist/branch', { text }));
      autoBtn.disabled = false;
      status.textContent = '';
      if (!design) return;
      b.name = b.name || design.name;
      b.description = b.description || design.description;
      name.value = b.name;
      desc.value = b.description;
      b.steps = design.steps.map((s) => ({ id: rid(), ...s }));
      b.access = { toolGroups: design.access.toolGroups, mcpServers: design.access.mcpServers };
      drawSteps();
      drawAccess();
      const fresh = design.steps.filter((s) => s.newAgent).length;
      toast(`Built ${design.steps.length} steps${fresh ? `, with ${fresh} new agent${fresh > 1 ? 's' : ''} to hire` : ''}. Change anything, then save.`);
    },
  }, '✨ Auto-build');

  let m;
  const save = async () => {
    if (!b.name.trim()) return toast('Give the team a name.', 'warn');
    // hire the new agents the Brain suggested
    for (const s of b.steps) {
      if (s.type === 'agent' && s.newAgent) {
        const a = await attempt(() => POST('/agents', s.newAgent));
        if (!a) return;
        s.agentId = a.id;
        delete s.newAgent;
      }
    }
    const body = { name: b.name.trim(), description: b.description.trim(), steps: b.steps.map((s) => ({ id: s.id || rid(), ...s })), access: b.access };
    const saved = wf ? await attempt(() => PUT(`/workflows/${wf.id}`, { ...wf, ...body })) : await attempt(() => POST('/workflows', { ...body, color: PALETTE[(state.data?.workflowsCount || Math.floor(Math.random() * 10)) % PALETTE.length], schedule: { type: 'none' }, enabled: false }));
    if (!saved) return;
    refreshSoon(0);
    m.close();
    toast(wf ? 'Team saved' : `Team "${saved.name}" created`);
    onSaved?.(saved);
  };

  m = modal({
    title: wf ? `Edit ${wf.name}` : 'New team',
    body: h(
      'div.col.gap-lg',
      h('div.col', h('label.field', h('span', 'Name'), name), h('label.field', h('span', 'What it does'), desc), h('div.row', autoBtn, status)),
      h('div', h('div.label', 'Agents & steps, in order'), h('div.mt', stepsEl), addRow),
      h('div', accessEl),
    ),
    foot: [h('button.btn.ghost', { onclick: () => m.close() }, 'Cancel'), h('button.btn', { onclick: save }, wf ? 'Save team' : 'Create team')],
  });
  drawSteps();
  drawAccess();
  setTimeout(() => (b.name ? desc : name).focus(), 30);
  return m;
}
