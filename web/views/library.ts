// Library: ready-made agents. Starters, The Agency (msitarzewski/agency-agents), Hermes profiles, Claude Code subagents.
import { h, mount, clear, state, GET, POST, PUT, DEL, attempt, navigate, md, modal, seg, toast, refreshSoon, confirmBox } from '../core.ts';
import { icon } from '../icons.ts';
import type { Agent, EngineId, PresetListing, Team } from '../../shared/types.ts';

/** An agent of The Agency as GET /api/library lists it (server/library.ts AgencyAgent without file). */
interface AgencyListing {
  slug: string;
  name: string;
  description: string;
  emoji: string;
  color: string;
  vibe: string;
  division: string;
  divisionLabel: string;
}
/** A Hermes profile (`hermes profile list`). */
interface HermesProfile {
  name: string;
  model: string;
  gateway: string;
  isDefault: boolean;
}
/** A Claude Code subagent (server/library.ts ClaudeSubagent without file). */
interface ClaudeSubagentListing {
  slug: string;
  name: string;
  description: string;
  model: string;
}
interface StarterListing {
  name: string;
  emoji: string;
  specialty: string;
}
/** GET /api/library */
interface LibraryIndex {
  agency: { agents: AgencyListing[] };
  hermes: HermesProfile[];
  claude: ClaudeSubagentListing[];
  starters: StarterListing[];
}
type HirePayload = { source: 'starter'; name: string; overrides: ReturnType<typeof engineOverrides> } | { source: 'agency'; slug: string; overrides: ReturnType<typeof engineOverrides> } | { source: 'hermes'; profile: string } | { source: 'claude'; slug: string };

let root: HTMLElement | undefined;
let lib: LibraryIndex | null = null;
let tab = 'agency';
let query = '';
let division = '';
let hireEngine: EngineId | null = null;
let presets: PresetListing[] = [];

export const title = () => 'Library';

export async function render(el: HTMLElement): Promise<void> {
  root = el;
  hireEngine = state.data?.settings?.defaults?.engine || 'claude-code';
  mount(el, h('p.dim', 'Loading library…'));
  [lib, presets] = await Promise.all([GET<LibraryIndex>('/library'), GET<PresetListing[]>('/presets').catch((): PresetListing[] => [])]);
  if (new URLSearchParams(location.hash.split('?')[1] || '').get('tab') === 'presets') tab = 'presets';
  draw();
}

function draw() {
  const tabs: [string, string][] = [
    ['starters', `Starters (${lib!.starters.length})`],
    ['agency', `The Agency (${lib!.agency.agents.length})`],
    ['hermes', `Hermes profiles (${lib!.hermes.length})`],
    ['claude', `Claude Code subagents (${lib!.claude.length})`],
    ['presets', `Your presets (${presets.length})`],
  ];
  const body = h('div');
  mount(
    root!,
    h('p.lede', 'Hire a specialist and it joins your team with its instructions already written. You can change anything afterwards.'),
    branchParam() ? h('div.panel', { style: { marginBottom: '14px', borderColor: 'var(--accent-dim)' } }, h('div.row.between', h('span', 'Hiring into a Station team: new hires are added as its next step.'), h('a.btn.ghost.small', { href: '#/station' }, 'Back to Station'))) : null,
    h(
      'div.row.between',
      { style: { marginBottom: '6px' } },
      h('div.tabs', { style: { marginBottom: 0, borderBottom: 0 } }, tabs.map(([id, label]) => h(`button${tab === id ? '.on' : ''}`, { onclick: () => ((tab = id), draw()) }, label))),
      tab === 'agency' || tab === 'starters'
        ? h('div.row', h('span.label', 'Runs on'), seg(state.data!.engineList.map((e) => ({ value: e.id, label: e.label })), hireEngine, (v) => (hireEngine = v)))
        : null,
    ),
    h('div', { style: { borderTop: '1px solid var(--line)', paddingTop: '18px' } }, body),
  );
  if (tab === 'starters') drawStarters(body);
  else if (tab === 'agency') drawAgency(body);
  else if (tab === 'hermes') drawHermes(body);
  else if (tab === 'presets') drawPresets(body);
  else drawClaude(body);
}

function engineOverrides() {
  const d = state.data!.settings.defaults;
  return { engine: hireEngine, model: hireEngine === 'claude-code' ? d.claudeModel : hireEngine === 'openai' ? d.openrouterModel : '' };
}

// Opened from a Station branch (#/library?branch=id): new hires join that branch.
const branchParam = () => new URLSearchParams(location.hash.split('?')[1] || '').get('branch');

async function hire(payload: HirePayload, name: string): Promise<Agent | undefined> {
  const a = await attempt(() => POST<Agent>('/library/hire', payload));
  if (!a) return;
  refreshSoon(0);
  const branch = branchParam();
  if (branch) {
    const wf = await GET<Team>(`/workflows/${branch}`).catch(() => null);
    if (wf) {
      wf.members = [...new Set([...(wf.members || []), a.id])];
      // the step list mirrors members (the Team editor and runs use it)
      const steps = wf.steps || [];
      if (!steps.some((s) => s.type === 'agent' && s.agentId === a.id)) wf.steps = [...steps, { id: Math.random().toString(36).slice(2), type: 'agent', agentId: a.id, prompt: steps.length ? 'Continue from this:\n{{prev}}' : '{{input}}' }];
      await PUT(`/workflows/${branch}`, wf).catch(() => {});
      toast(`${name} joined the ${wf.name} team`);
      return a;
    }
  }
  toast(`${name} joined your team`);
  return a;
}

function hiredButtons(a: Agent) {
  return [h('button.btn.small', { onclick: () => navigate(`#/agents/${a.id}`) }, 'Chat'), h('button.btn.ghost.small', { onclick: () => navigate(`#/agents/${a.id}/edit`) }, 'Edit')];
}

function drawStarters(body: HTMLElement) {
  mount(
    body,
    h(
      'div.cards',
      lib!.starters.map((s) => {
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

function drawAgency(body: HTMLElement) {
  const divisions = [...new Map(lib!.agency.agents.map((a) => [a.division, a.divisionLabel])).entries()];
  const grid = h('div.cards');
  const fill = () => {
    const q = query.toLowerCase();
    const list = lib!.agency.agents.filter((a) => (!division || a.division === division) && (!q || `${a.name} ${a.description} ${a.vibe}`.toLowerCase().includes(q)));
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
  );
  fill();
  setTimeout(() => search.focus(), 30);
}

async function preview(a: AgencyListing, doHire: () => unknown) {
  const full = await GET<{ body: string }>(`/library/agency/${a.slug}`);
  const m = modal({
    title: `${a.emoji} ${a.name}`,
    body: h('div.msg.assistant', md(full.body.replace(/^---[\s\S]*?---/, ''))),
    foot: [h('button.btn.ghost', { onclick: () => m.close() }, 'Close'), h('button.btn', { onclick: () => (m.close(), doHire()) }, 'Hire')],
  });
}

function drawHermes(body: HTMLElement) {
  if (!lib!.hermes.length) {
    mount(body, h('div.empty.box', state.data!.engines.hermes.installed ? 'No Hermes profiles found.' : 'Hermes is not installed on this PC.'));
    return;
  }
  const have = new Set(state.data!.agents.filter((a) => a.engine === 'hermes').map((a) => a.hermesProfile || 'default'));
  mount(
    body,
    h('p.hint', { style: { marginBottom: '14px' } }, 'Each Hermes profile keeps its own memory, skills and tools. Add one to chat with it here, use it in workflows, or let other agents ask it for help.'),
    h(
      'div.cards',
      lib!.hermes.map((p) => {
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

// Agents and teams you saved as presets: make a fresh copy in this project.
function drawPresets(body: HTMLElement) {
  const use = async (p: PresetListing, btn: HTMLButtonElement) => {
    btn.disabled = true;
    const r = await attempt(() => POST<{ agent?: Agent; team?: Team }>(`/presets/${p.id}/use`), p.kind === 'team' ? `Team "${p.name}" created with ${p.members!.length} agents` : `${p.name} created`);
    btn.disabled = false;
    if (!r) return;
    refreshSoon(0);
    if (r.agent) navigate(`#/agents/${r.agent.id}/edit`);
    else navigate(`#/station?team=${r.team!.id}`);
  };
  const del = async (p: PresetListing) => {
    if (!(await confirmBox(`Delete the preset "${p.name}"? Agents and teams made from it stay.`, { ok: 'Delete', danger: true }))) return;
    if (await attempt(() => DEL(`/presets/${p.id}`), 'Deleted')) {
      presets = await GET<PresetListing[]>('/presets');
      draw();
    }
  };
  const card = (p: PresetListing) =>
    h(
      'div.card.preset-card',
      h(
        'div.card-top',
        p.kind === 'team' ? h('div.avatar', { style: { background: p.color || '#7350c8' } }, icon('users', 18)) : h('div.avatar', p.emoji || '🤖'),
        h('div.grow', h('div.card-title', p.name), h('div.hint', p.kind === 'team' ? `Team · ${p.members!.length} agents${p.lead ? ` · ★ ${p.lead}` : ''}` : 'Agent')),
      ),
      p.description ? h('div.card-sub', p.description) : null,
      p.kind === 'team' ? h('div.preset-members', p.members!.map((m) => h('span.pill', `${m.emoji || ''} ${m.name}`))) : null,
      p.skills?.length ? h('div.hint', `${p.skills.length} skill${p.skills.length === 1 ? '' : 's'}`) : null,
      h('div.card-foot', h('button.btn.small', { onclick: (e) => use(p, e.currentTarget) }, icon('plus', 13), p.kind === 'team' ? 'Create this team' : 'Create this agent'), h('span.grow'), h('button.btn.ghost.tiny.danger', { title: 'Delete preset', onclick: () => del(p) }, icon('trash-2', 13))),
    );
  const teamsP = presets.filter((p) => p.kind === 'team');
  const agentsP = presets.filter((p) => p.kind === 'agent');
  mount(
    body,
    h('p.hint', { style: { marginBottom: '14px' } }, 'Save any agent or team as a preset (its panel on the Station, or right-click it). Presets work in every project: each use makes fresh copies here.'),
    !presets.length ? h('p.empty', 'No presets yet.') : null,
    teamsP.length ? [h('h2.section', `Teams (${teamsP.length})`), h('div.cards', teamsP.map(card))] : null,
    agentsP.length ? [h('h2.section.mt-lg', `Agents (${agentsP.length})`), h('div.cards', agentsP.map(card))] : null,
  );
}

function drawClaude(body: HTMLElement) {
  mount(
    body,
    h('p.hint', { style: { marginBottom: '14px' } }, 'Subagents saved in ~/.claude/agents. Import one as a dashboard agent, or go the other way with "Install in Claude Code" on any agent.'),
    lib!.claude.length
      ? h(
          'div.cards',
          lib!.claude.map((s) => {
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
