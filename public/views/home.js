// Home: what's happening, what needs you, and a quick way to give any agent a task.
import { h, mount, state, GET, POST, attempt, avatar, ago, navigate, approvalCard, onState, select } from '../core.js';

let root;
let off;
let progs = [];
let activity = [];
const quick = { text: '', agentId: '', el: null };

export const title = () => 'Home';

export async function render(el) {
  root = el;
  off = onState(draw);
  draw();
  [progs, activity] = await Promise.all([GET('/programs').catch(() => []), GET('/activity').catch(() => [])]);
  draw();
}

export function unmount() {
  off?.();
}

export function onEvent(ev) {
  if (ev.type === 'activity') {
    activity.unshift(ev.entry);
    activity = activity.slice(0, 200);
    drawActivity();
  }
}

let activityEl;
function drawActivity() {
  if (!activityEl) return;
  const icons = { run: '◉', error: '✕', approval: '!', social: '⟁', workflow: '⇢', program: '▣', mcp: '⌁', library: '▤', terminal: '›', system: '·', notify: '✉' };
  mount(
    activityEl,
    activity.length
      ? activity.slice(0, 40).map((a) =>
          h('div.list-item', h('span.mono', { class: a.kind === 'error' ? 'red' : 'faint', style: { width: '16px', textAlign: 'center' } }, icons[a.kind] || '·'), h('div.grow', { style: { fontSize: '13.5px' } }, a.text), h('span.mono.faint.nowrap', { style: { fontSize: '11px' } }, ago(a.ts))),
        )
      : h('p.empty', 'Nothing yet.'),
  );
}

function draw() {
  const d = state.data;
  if (!d || !root) return;
  const agents = d.agents || [];
  const services = progs.filter((p) => p.installed && ['comfyui', 'lmstudio', 'ollama', 'netdesk', 'orca', 'blender', 'premiere', 'photoshop'].includes(p.id));

  // quick ask (keeps its text, choice and focus when the page refreshes live)
  if (!agents.some((a) => a.id === quick.agentId)) quick.agentId = agents[0]?.id || '';
  const hadFocus = quick.el && document.activeElement === quick.el;
  const msg = h('textarea', { rows: 3, value: quick.text, placeholder: agents.length ? 'Tell an agent what to do…  (Ctrl+Enter to send)' : 'Add an agent first', oninput: (e) => (quick.text = e.target.value) });
  quick.el = msg;
  if (hadFocus) setTimeout(() => (msg.focus(), msg.setSelectionRange(msg.value.length, msg.value.length)), 0);
  const send = () =>
    attempt(async () => {
      const text = msg.value.trim();
      const agentId = quick.agentId;
      if (!text || !agentId) return;
      const chat = await POST(`/agents/${agentId}/chats`);
      await POST(`/agents/${agentId}/chats/${chat.id}/messages`, { text });
      quick.text = '';
      navigate(`#/agents/${agentId}/${chat.id}`);
    });
  msg.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send();
  });

  activityEl = h('div.list');
  mount(
    root,
    h(
      'div.stats',
      stat('Agents', agents.length, '', () => navigate('#/agents')),
      stat('Working now', d.runs.length, d.runs.length ? 'live' : ''),
      stat('Needs you', d.approvals.length + d.outboxPending, d.approvals.length + d.outboxPending ? 'hot' : '', () => document.getElementById('drawer').classList.remove('hidden')),
      stat('X accounts', d.accounts.x.length, '', () => navigate('#/settings?tab=connections')),
    ),
    !agents.length ? onboarding(d) : null,
    h(
      'div.two-col',
      h(
        'div.col.gap-lg',
        agents.length
          ? h(
              'div.panel',
              h('div.panel-head', h('h2', 'Give an agent a task')),
              h('div', { style: { maxWidth: '300px' } }, select(agents.map((a) => ({ value: a.id, label: `${a.emoji || ''} ${a.name}` })), quick.agentId, (v) => (quick.agentId = v))),
              h('div.mt', msg),
              h('div.row.mt.between', h('span.hint', 'Opens a new chat with that agent.'), h('button.btn', { onclick: send }, 'Send')),
            )
          : null,
        d.approvals.length ? h('div.panel', h('div.panel-head', h('h2', 'Needs you')), h('div.col', d.approvals.map(approvalCard))) : null,
        d.runs.length
          ? h(
              'div.panel',
              h('div.panel-head', h('h2', 'Working now')),
              h(
                'div.list',
                d.runs.map((r) => {
                  const a = agents.find((x) => x.id === r.agentId);
                  return h('div.list-item', a ? avatar(a) : null, h('div.grow', h('div.title', r.agentName), h('div.hint', `started ${ago(r.startedAt)}`)), h('button.btn.ghost.small', { onclick: () => navigate(`#/agents/${r.agentId}/${r.chatId}`) }, 'Watch'));
                }),
              ),
            )
          : null,
        agents.length
          ? h(
              'div.panel',
              h('div.panel-head', h('h2', 'Your agents'), h('div.actions', h('a.btn.ghost.small', { href: '#/agents' }, 'All agents'))),
              h(
                'div.cards',
                { style: { gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))' } },
                agents.slice(0, 8).map((a) =>
                  h(
                    'div.card.clickable',
                    { onclick: () => navigate(`#/agents/${a.id}`) },
                    h('div.card-top', avatar(a), h('div.grow', h('div.card-title', a.name), h('div.card-sub', { style: { WebkitLineClamp: 2 } }, a.specialty || ''))),
                    d.runs.some((r) => r.agentId === a.id) ? h('span.corner', h('span.dot.busy')) : null,
                  ),
                ),
              ),
            )
          : null,
      ),
      h(
        'div.col.gap-lg',
        h(
          'div.panel',
          h('div.panel-head', h('h2', 'Programs'), h('div.actions', h('a.btn.ghost.small', { href: '#/settings?tab=programs' }, 'All programs'))),
          services.length
            ? h(
                'div.list',
                services.map((p) =>
                  h(
                    'div.list-item',
                    h('span', { style: { width: '22px', textAlign: 'center' } }, p.icon),
                    h('div.grow', h('div.title', p.name), h('div.hint', p.running ? (p.serviceUrl ? `running · ${p.serviceUrl}` : 'running') : p.version ? `v${p.version}` : 'installed')),
                    h('span', { class: `dot ${p.running ? 'on' : ''}` }),
                  ),
                ),
              )
            : h('p.empty', 'Scanning…'),
        ),
        h('div.panel', h('div.panel-head', h('h2', 'Activity')), activityEl),
      ),
    ),
  );
  drawActivity();
}

function stat(label, num, kind = '', onclick) {
  return h(`div.stat${kind ? '.' + kind : ''}`, { onclick, style: onclick ? { cursor: 'pointer' } : {} }, h('div.label', label), h('div.num', String(num)));
}

function onboarding(d) {
  const steps = [
    { done: d.engines['claude-code'].installed || d.secrets.openrouterKey.set, text: 'Pick how agents think: Claude Code is found on this PC; add an OpenRouter key for any other model.', href: '#/settings', cta: 'Settings' },
    { done: false, text: 'Add agents: start with ready-made ones, or hire specialists from the library of 270+.', href: '#/library', cta: 'Open library' },
    { done: d.accounts.x.length > 0, text: 'Connect your X account so agents can draft posts for you to approve.', href: '#/settings?tab=connections', cta: 'Connections' },
    { done: false, text: 'Give agents more abilities: browser control, files, GitHub and any MCP server.', href: '#/settings?tab=mcp', cta: 'Tools & MCP' },
  ];
  return h(
    'div.panel',
    { style: { marginBottom: '16px', borderColor: 'var(--accent-dim)' } },
    h('div.panel-head', h('h2', 'Get started')),
    h(
      'div.list',
      steps.map((s, i) =>
        h(
          'div.list-item',
          h('span.mono', { class: s.done ? 'accent' : 'faint' }, s.done ? '✓' : `0${i + 1}`),
          h('div.grow', s.text),
          i === 1 ? h('button.btn.small', { onclick: addStarterTeam }, 'Add starter team') : null,
          h('a.btn.ghost.small', { href: s.href }, s.cta),
        ),
      ),
    ),
  );
}

// One click: Chief of Staff, X Writer, Image Maker, 3D Artist, Video Editor, Researcher.
async function addStarterTeam(e) {
  e.target.disabled = true;
  const lib = await GET('/library').catch(() => null);
  for (const s of lib?.starters || []) await attempt(() => POST('/library/hire', { source: 'starter', name: s.name }));
  navigate('#/agents');
}
