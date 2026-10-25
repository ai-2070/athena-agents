// Team builder: name it, give it a goal, pick its agents and lead (or let the Brain build it), choose its access.
import { h, mount, clear, state, GET, POST, PUT, attempt, modal, chipSet, select, toast, refreshSoon, avatar } from './core.js';

const PALETTE = ['#3d58c0', '#b0508a', '#c07a34', '#3a8a7a', '#7350c8', '#b8a03a', '#4f7fa8', '#5a9a3a', '#a84a5a', '#2f8fa0'];

// wf: an existing team to edit. prefill: a design from the Brain ({ name, description, members, leadIndex, access }).
export async function openBranchBuilder({ wf = null, prefill = null, describe = '', onSaved } = {}) {
  const d = state.data;
  const mcp = await GET('/mcp').catch(() => ({ servers: {} }));
  // members: { agentId } for existing agents, { newAgent } for ones the Brain suggests hiring
  const fromTeam = (wf?.members || []).map((agentId) => ({ agentId }));
  const b = {
    name: wf?.name || prefill?.name || '',
    description: wf?.description || prefill?.description || describe || '',
    members: fromTeam.length ? fromTeam : structuredClone(prefill?.members || []),
    lead: wf?.lead || null,
    leadIndex: prefill?.leadIndex ?? -1,
    access: { toolGroups: [...(wf?.access?.toolGroups || prefill?.access?.toolGroups || [])], mcpServers: [...(wf?.access?.mcpServers || prefill?.access?.mcpServers || [])] },
  };
  if (!b.lead && b.leadIndex >= 0) b.lead = b.members[b.leadIndex]?.agentId || `new:${b.leadIndex}`;
  const byId = () => new Map(state.data.agents.map((a) => [a.id, a]));
  const keyOf = (m, j) => m.agentId || `new:${j}`;

  const name = h('input', { value: b.name, placeholder: 'e.g. Social, Video studio, Launch crew' });
  const desc = h('textarea', { rows: 2, value: b.description, placeholder: "The team's goal. Write it here and press Auto-build to let the Brain pick the agents." });
  name.addEventListener('input', () => (b.name = name.value));
  desc.addEventListener('input', () => (b.description = desc.value));

  const listEl = h('div.bb-steps');
  const drawMembers = () => {
    const agents = byId();
    clear(listEl);
    b.members.forEach((m, j) => {
      const a = m.agentId ? agents.get(m.agentId) : null;
      const k = keyOf(m, j);
      const isLead = b.lead === k;
      listEl.append(
        h(
          'div.bb-step',
          a ? avatar(a) : h('div.avatar', m.newAgent?.emoji || '🤖'),
          h(
            'div.grow',
            h('div.row', { style: { gap: '6px' } }, h('b', a ? a.name : m.newAgent?.name || 'Agent'), m.newAgent ? h('span.pill.ok', 'new agent') : null, isLead ? h('span.tc-lead', '★ lead') : null),
            h('div.hint', a ? a.specialty || '' : m.newAgent?.specialty || ''),
          ),
          h(
            'div.st-step-actions',
            h('button', { class: isLead ? 'on' : '', title: isLead ? 'Remove as lead' : 'Make lead: your messages go to them first', onclick: () => ((b.lead = isLead ? null : k), drawMembers()) }, '★'),
            h('button', { title: 'Remove', onclick: () => (b.members.splice(j, 1), b.lead === k && (b.lead = null), drawMembers()) }, '✕'),
          ),
        ),
      );
    });
    if (!b.members.length) listEl.append(h('p.empty', 'No agents yet. Add them below, or describe the goal and press Auto-build.'));
  };

  let addId = d.agents[0]?.id || '';
  const addRow = h(
    'div.row.mt',
    d.agents.length
      ? [
          h('div', { style: { width: '260px' } }, select(d.agents.map((a) => ({ value: a.id, label: `${a.emoji || ''} ${a.name}` })), addId, (v) => (addId = v))),
          h('button.btn.small', {
            onclick: () => {
              if (!addId || b.members.some((m) => m.agentId === addId)) return;
              b.members.push({ agentId: addId });
              drawMembers();
            },
          }, '+ Add agent'),
        ]
      : h('span.hint', 'You have no agents yet: Auto-build can create them.'),
  );

  const accessEl = h('div');
  const drawAccess = () =>
    mount(
      accessEl,
      h('div.label', 'Programs & tools'),
      h('div.mt', chipSet(state.data.toolGroups.map((g) => ({ value: g.id, label: g.label, title: g.description })), b.access.toolGroups, (v) => (b.access.toolGroups = v))),
      Object.keys(mcp.servers).length ? [h('div.label.mt', 'MCP servers'), h('div.mt', chipSet(Object.keys(mcp.servers), b.access.mcpServers, (v) => (b.access.mcpServers = v)))] : null,
      h('p.hint.mt', 'While working for this team, every member gets these on top of its own tools.'),
    );

  const status = h('span.hint');
  const autoBtn = h('button.btn.small', {
    onclick: async () => {
      const text = [b.name, b.description].filter(Boolean).join(': ').trim();
      if (!text) return toast("Describe the team's goal first.", 'warn');
      autoBtn.disabled = true;
      status.textContent = 'The Brain is picking agents…';
      const design = await attempt(() => POST('/assist/branch', { text }));
      autoBtn.disabled = false;
      status.textContent = '';
      if (!design) return;
      b.name = b.name || design.name;
      b.description = b.description || design.description;
      name.value = b.name;
      desc.value = b.description;
      b.members = design.members;
      b.lead = design.leadIndex >= 0 ? keyOf(design.members[design.leadIndex], design.leadIndex) : null;
      b.access = { toolGroups: design.access.toolGroups, mcpServers: design.access.mcpServers };
      drawMembers();
      drawAccess();
      const fresh = design.members.filter((m) => m.newAgent).length;
      toast(`Picked ${design.members.length} agents${fresh ? `, ${fresh} of them new` : ''}. Change anything, then save.`);
    },
  }, '✨ Auto-build');

  let m;
  const save = async () => {
    if (!b.name.trim()) return toast('Give the team a name.', 'warn');
    // hire the new agents the Brain suggested
    const ids = [];
    let lead = b.lead;
    for (const [j, mem] of b.members.entries()) {
      if (mem.agentId) ids.push(mem.agentId);
      else if (mem.newAgent) {
        const a = await attempt(() => POST('/agents', mem.newAgent));
        if (!a) return;
        if (lead === `new:${j}`) lead = a.id;
        ids.push(a.id);
      }
    }
    if (lead && !ids.includes(lead)) lead = null;
    const body = { name: b.name.trim(), description: b.description.trim(), members: ids, steps: ids.map((agentId) => ({ type: 'agent', agentId })), lead, access: b.access };
    const saved = wf
      ? await attempt(() => PUT(`/workflows/${wf.id}`, { ...wf, ...body }))
      : await attempt(() => POST('/workflows', { ...body, color: PALETTE[Math.floor(Math.random() * PALETTE.length)], schedule: { type: 'none' }, enabled: false }));
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
      h('p.hint', 'A team is a group chat of agents. You write to the team, the lead (or the best fit) takes it, and they hand work to each other with @mentions.'),
      h('div.col', h('label.field', h('span', 'Name'), name), h('label.field', h('span', 'Goal'), desc), h('div.row', autoBtn, status)),
      h('div', h('div.label', 'Members'), h('div.mt', listEl), addRow),
      h('div', accessEl),
    ),
    foot: [h('button.btn.ghost', { onclick: () => m.close() }, 'Cancel'), h('button.btn', { onclick: save }, wf ? 'Save team' : 'Create team')],
  });
  drawMembers();
  drawAccess();
  setTimeout(() => (b.name ? desc : name).focus(), 30);
  return m;
}
