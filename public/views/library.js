// Library: ready-made agents. Starters, The Agency (msitarzewski/agency-agents), Hermes profiles, Claude Code subagents.
import { h, mount, clear, state, GET, POST, PUT, attempt, navigate, md, modal, seg, toast, refreshSoon } from '../core.js';

let root;
let lib = null;
let tab = 'agency';
let query = '';
let division = '';
let hireEngine = null;

export const title = () => 'Library';

export async function render(el) {
  root = el;
  hireEngine = state.data?.settings?.defaults?.engine || 'claude-code';
  mount(el, h('p.dim', 'Loading library…'));
  lib = await GET('/library');
  draw();
}

function draw() {
  const tabs = [
    ['starters', `Starters (${lib.starters.length})`],
    ['agency', `The Agency (${lib.agency.agents.length})`],
    ['hermes', `Hermes profiles (${lib.hermes.length})`],
    ['claude', `Claude Code subagents (${lib.claude.length})`],
  ];
  const body = h('div');
  mount(
    root,
    h('p.lede', 'Hire a specialist and it joins your team with its instructions already written. You can change anything afterwards.'),
    branchParam() ? h('div.panel', { style: { marginBottom: '14px', borderColor: 'var(--accent-dim)' } }, h('div.row.between', h('span', 'Hiring into a Station team: new hires are added as its next step.'), h('a.btn.ghost.small', { href: '#/station' }, 'Back to Station'))) : null,
    h(
      'div.row.between',
      { style: { marginBottom: '6px' } },
      h('div.tabs', { style: { marginBottom: 0, borderBottom: 0 } }, tabs.map(([id, label]) => h(`button${tab === id ? '.on' : ''}`, { onclick: () => ((tab = id), draw()) }, label))),
      tab === 'agency' || tab === 'starters'
        ? h('div.row', h('span.label', 'Runs on'), seg(state.data.engineList.map((e) => ({ value: e.id, label: e.label })), hireEngine, (v) => (hireEngine = v)))
        : null,
    ),
    h('div', { style: { borderTop: '1px solid var(--line)', paddingTop: '18px' } }, body),
  );
  if (tab === 'starters') drawStarters(body);
  else if (tab === 'agency') drawAgency(body);
  else if (tab === 'hermes') drawHermes(body);
  else drawClaude(body);
}

function engineOverrides() {
  const d = state.data.settings.defaults;
  return { engine: hireEngine, model: hireEngine === 'claude-code' ? d.claudeModel : hireEngine === 'openai' ? d.openrouterModel : '' };
}

// Opened from a Station branch (#/library?branch=id): new hires join that branch.
const branchParam = () => new URLSearchParams(location.hash.split('?')[1] || '').get('branch');

async function hire(payload, name) {
  const a = await attempt(() => POST('/library/hire', payload));
  if (!a) return;
  refreshSoon(0);
  const branch = branchParam();
  if (branch) {
    const wf = await GET(`/workflows/${branch}`).catch(() => null);
    if (wf) {
      wf.steps.push({ id: Math.random().toString(36).slice(2), type: 'agent', agentId: a.id, prompt: wf.steps.length ? 'Continue from this:\n{{prev}}' : '{{input}}' });
      await PUT(`/workflows/${branch}`, wf).catch(() => {});
      toast(`${name} joined the ${wf.name} team`);
      return a;
    }
  }
  toast(`${name} joined your team`);
  return a;
}

function hiredButtons(a) {
  return [h('button.btn.small', { onclick: () => navigate(`#/agents/${a.id}`) }, 'Chat'), h('button.btn.ghost.small', { onclick: () => navigate(`#/agents/${a.id}/edit`) }, 'Edit')];
}

function drawStarters(body) {
  mount(
    body,
    h(
      'div.cards',
      lib.starters.map((s) => {
        const foot = h('div.card-foot');
        mount(
          foot,
          h('button.btn.small', {
            onclick: async () => {
              const a = await hire({ source: 'starter', name: s.name, overrides: engineOverrides() }, s.name);
              if (a) mount(foot, hiredButtons(a));
            },
          }, 'Add'),
        );
        return h('div.card', h('div.card-top', h('div.avatar.lg', s.emoji), h('div.grow', h('div.card-title', s.name), h('div.card-sub', s.specialty))), foot);
      }),
    ),
  );
}

function drawAgency(body) {
  if (!lib.agency.installed) {
    const btn = h('button.btn', {
      onclick: async () => {
        btn.disabled = true;
        btn.textContent = 'Downloading…';
        const r = await attempt(() => POST('/library/install'));
        if (r) {
          lib = await GET('/library');
          draw();
        } else {
          btn.disabled = false;
          btn.textContent = 'Download the library';
        }
      },
    }, 'Download the library');
    mount(body, h('div.empty.box', h('p', 'The Agency is a free collection of 270+ specialist agents (marketing, engineering, design, game dev, sales and more) from github.com/msitarzewski/agency-agents.'), btn));
    return;
  }
  const divisions = [...new Map(lib.agency.agents.map((a) => [a.division, a.divisionLabel])).entries()];
  const grid = h('div.cards');
  const fill = () => {
    const q = query.toLowerCase();
    const list = lib.agency.agents.filter((a) => (!division || a.division === division) && (!q || `${a.name} ${a.description} ${a.vibe}`.toLowerCase().includes(q)));
    mount(
      grid,
      list.slice(0, 240).map((a) => {
        const foot = h('div.card-foot');
        const doHire = async () => {
          const ag = await hire({ source: 'agency', slug: a.slug, overrides: engineOverrides() }, a.name);
          if (ag) mount(foot, hiredButtons(ag));
        };
        mount(foot, h('button.btn.small', { onclick: doHire }, 'Hire'), h('button.btn.ghost.small', { onclick: () => preview(a, doHire) }, 'Read'));
        return h(
          'div.card',
          h('div.card-top', h('div.avatar', { style: { '--agent-color': a.color || 'var(--accent)' } }, a.emoji), h('div.grow', h('div.card-title', a.name), h('div.label', { style: { marginTop: '2px' } }, a.divisionLabel))),
          h('div.card-sub', a.vibe || a.description),
          foot,
        );
      }),
      list.length > 240 ? h('p.hint', `Showing 240 of ${list.length}. Search to narrow down.`) : null,
      !list.length ? h('div.empty.box', 'No agent matches.') : null,
    );
  };
  const search = h('input', { placeholder: 'Search 270+ specialists: "tiktok", "unity", "seo", "security"…', value: query, oninput: (e) => ((query = e.target.value), fill()) });
  mount(
    body,
    h('div', { style: { maxWidth: '560px' } }, search),
    h(
      'div.chips.mt',
      h(`button.chip${!division ? '.on' : ''}`, { onclick: () => ((division = ''), draw()) }, 'All'),
      divisions.map(([id, label]) => h(`button.chip${division === id ? '.on' : ''}`, { onclick: () => ((division = id), draw()) }, label)),
    ),
    h('div.mt', grid),
    h('div.row.mt-lg', h('button.btn.ghost.small', { onclick: () => attempt(() => POST('/library/install'), (r) => r.message).then(async () => ((lib = await GET('/library')), draw())) }, 'Update library')),
  );
  fill();
  setTimeout(() => search.focus(), 30);
}

async function preview(a, doHire) {
  const full = await GET(`/library/agency/${a.slug}`);
  const m = modal({
    title: `${a.emoji} ${a.name}`,
    body: h('div.msg.assistant', md(full.body.replace(/^---[\s\S]*?---/, ''))),
    foot: [h('button.btn.ghost', { onclick: () => m.close() }, 'Close'), h('button.btn', { onclick: () => (m.close(), doHire()) }, 'Hire')],
  });
}

function drawHermes(body) {
  if (!lib.hermes.length) {
    mount(body, h('div.empty.box', state.data.engines.hermes.installed ? 'No Hermes profiles found.' : 'Hermes is not installed on this PC.'));
    return;
  }
  const have = new Set(state.data.agents.filter((a) => a.engine === 'hermes').map((a) => a.hermesProfile || 'default'));
  mount(
    body,
    h('p.hint', { style: { marginBottom: '14px' } }, 'Each Hermes profile keeps its own memory, skills and tools. Add one to chat with it here, use it in workflows, or let other agents ask it for help.'),
    h(
      'div.cards',
      lib.hermes.map((p) => {
        const foot = h('div.card-foot');
        mount(
          foot,
          have.has(p.name)
            ? h('span.pill.ok', 'on your team')
            : h('button.btn.small', {
                onclick: async () => {
                  const a = await hire({ source: 'hermes', profile: p.name }, p.name);
                  if (a) mount(foot, hiredButtons(a));
                },
              }, 'Add as agent'),
        );
        return h('div.card', h('div.card-top', h('div.avatar', '☤'), h('div.grow', h('div.card-title', p.name), h('div.card-sub', `${p.model} · gateway ${p.gateway}${p.isDefault ? ' · default' : ''}`))), foot);
      }),
    ),
  );
}

function drawClaude(body) {
  mount(
    body,
    h('p.hint', { style: { marginBottom: '14px' } }, 'Subagents saved in ~/.claude/agents. Import one as a dashboard agent, or go the other way with "Install in Claude Code" on any agent.'),
    lib.claude.length
      ? h(
          'div.cards',
          lib.claude.map((s) => {
            const foot = h('div.card-foot');
            mount(
              foot,
              h('button.btn.small', {
                onclick: async () => {
                  const a = await hire({ source: 'claude', slug: s.slug }, s.name);
                  if (a) mount(foot, hiredButtons(a));
                },
              }, 'Import'),
            );
            return h('div.card', h('div.card-top', h('div.avatar', '✳️'), h('div.grow', h('div.card-title', s.name), h('div.card-sub', s.description))), foot);
          }),
        )
      : h('div.empty.box', 'No Claude Code subagents found.'),
  );
}
