// Skills: reusable instructions (Claude Code's SKILL.md format) you give to agents three ways:
// per agent, per team (every member while it works for the team) or per project (every agent).
import { h, mount, state, GET, POST, PUT, DEL, attempt, modal, field, toast, refreshSoon, confirmBox, navigate, avatar } from '../core.ts';
import { icon } from '../icons.ts';
import { uiZoom } from '../look.ts';
import { skillPicker, loadSkills, forgetSkills } from '../skillpick.ts';
import type { Agent, ClaudeSkill, Project, ServerEvent, Skill, SkillListing, TeamListing } from '../../shared/types.ts';
import type { Child, ModalHandle } from '../core.ts';

interface SkillsData {
  skills: SkillListing[];
  claude: ClaudeSkill[];
}

let root: HTMLElement | undefined;
let data: SkillsData = { skills: [], claude: [] };
let teams: TeamListing[] = [];
let query = '';

export const title = () => 'Skills';

export async function render(el: HTMLElement): Promise<void> {
  root = el;
  mount(el, h('p.dim', 'Loading skills…'));
  await reload();
}

async function reload() {
  [data, teams] = await Promise.all([GET<SkillsData>('/skills'), GET<TeamListing[]>('/workflows').catch((): TeamListing[] => [])]);
  forgetSkills();
  await loadSkills(true);
  draw();
}

export function onEvent(ev: ServerEvent): void {
  if (['agents', 'workflows', 'project'].includes(ev.type) && root?.isConnected) GET<TeamListing[]>('/workflows').then((t) => ((teams = t), draw())).catch(() => {});
}

// Who has a skill: the project, teams, agents.
function usedBy(slug: string) {
  const d = state.data!;
  return {
    project: (d.project?.skills || []).includes(slug),
    teams: teams.filter((t) => (t.skills || []).includes(slug)),
    agents: d.agents.filter((a) => (a.skills || []).includes(slug)),
  };
}

const saveProject = (skills: string[]) => attempt(() => PUT(`/projects/${state.data!.project.id}`, { skills })).then(() => refreshSoon(0));
const saveAgent = (a: Agent, skills: string[]) => attempt(() => PUT(`/agents/${a.id}`, { skills })).then(() => refreshSoon(0));
const saveTeam = (t: TeamListing, skills: string[]) => attempt(() => PUT(`/workflows/${t.id}`, { skills })).then(async () => ((teams = await GET<TeamListing[]>('/workflows')), draw()));

function draw() {
  if (!root?.isConnected) return;
  const r0 = root;
  const d = state.data!;
  const proj: Partial<Project> = d.project || {};
  const q = query.toLowerCase();
  const shown = data.skills.filter((s) => !q || `${s.name} ${s.description}`.toLowerCase().includes(q));
  const search = h('input.skills-search', { type: 'search', placeholder: 'Search skills…', value: query });
  search.addEventListener('input', () => {
    query = search.value;
    draw();
    r0.querySelector<HTMLInputElement>('.skills-search')?.focus();
    const el = r0.querySelector<HTMLInputElement>('.skills-search');
    el?.setSelectionRange(el.value.length, el.value.length);
  });
  const toImport = data.claude.filter((c) => !c.inLibrary);
  mount(
    r0,
    h('p.lede', 'Skills are instructions for a kind of work: how you want an email written, your brand voice, a video edit checklist, a research method. Give them to one agent, to a team, or to the whole project. Agents open a skill when the task matches it.'),
    h(
      'div.skills-scopes',
      h('div.skills-scope', h('div.skills-scope-ico', icon('folder-open', 18)), h('div', h('b', 'Project'), h('div.hint', 'Every agent in the project'))),
      h('div.skills-scope', h('div.skills-scope-ico', icon('users', 18)), h('div', h('b', 'Team'), h('div.hint', 'Every member, while it works for the team'))),
      h('div.skills-scope', h('div.skills-scope-ico', icon('bot', 18)), h('div', h('b', 'Agent'), h('div.hint', 'That agent, everywhere'))),
    ),
    h(
      'div.panel.mt',
      h('div.panel-head', h('h2', icon('folder-open', 16), ` Project skills · ${proj.name || ''}`), h('span.hint', 'every agent in this project gets these')),
      skillPicker(proj.skills || [], saveProject, { empty: 'None yet. Add skills every agent here should follow, like your brand voice or how files are named.' }),
    ),
    h(
      'div.row.between.mt-lg',
      h('div.row', { style: { gap: '8px' } }, h('h2.section', { style: { margin: 0 } }, `Library (${data.skills.length})`), search),
      h(
        'div.row',
        { style: { gap: '8px' } },
        toImport.length ? h('button.btn.ghost.small', { onclick: openImport }, icon('download', 14), `Import from Claude Code (${toImport.length})`) : null,
        h('button.btn.small', { onclick: () => openEditor() }, icon('plus', 14), 'New skill'),
      ),
    ),
    shown.length
      ? h('div.skills-grid.mt', shown.map(card))
      : h(
          'div.panel.mt',
          h('p.empty', data.skills.length ? 'No skill matches.' : 'No skills yet.'),
          h('div.row', { style: { justifyContent: 'center', gap: '8px' } }, h('button.btn.small', { onclick: () => openEditor() }, icon('plus', 14), 'Write your first skill'), toImport.length ? h('button.btn.ghost.small', { onclick: openImport }, icon('download', 14), 'Import from Claude Code') : null),
        ),
  );
}

function card(s: SkillListing) {
  const u = usedBy(s.slug);
  const chips = [
    u.project ? h('span.skill-use.proj', icon('folder-open', 11), 'Project') : null,
    ...u.teams.map((t) => h('span.skill-use.team', { style: { '--c': t.color || '#7350c8' } }, icon('users', 11), t.name)),
    ...u.agents.map((a) => h('span.skill-use', `${a.emoji || ''} ${a.name}`)),
  ].filter(Boolean);
  return h(
    'div.skill-card',
    h('div.skill-top', h('div.skill-ico', icon('puzzle', 18)), h('div.grow', h('div.skill-name', s.name), h('div.hint', s.files.length ? `${s.files.length} extra file${s.files.length === 1 ? '' : 's'}` : 'instructions only'))),
    h('p.skill-desc', s.description),
    h('div.skill-uses', chips.length ? chips : h('span.hint', 'Not given to anyone yet')),
    h(
      'div.skill-foot',
      h('button.btn.small', { onclick: (e) => openAssign(e.currentTarget, s) }, icon('plus', 13), 'Give to…'),
      h('button.btn.ghost.small', { onclick: () => openEditor(s.slug) }, icon('pencil', 13), 'Edit'),
      h('span.grow'),
      h('button.btn.ghost.tiny.danger', {
        title: 'Delete the skill',
        onclick: async () => {
          if (!(await confirmBox(`Delete the skill "${s.name}"? It is taken off every agent, team and project that has it.`, { ok: 'Delete', danger: true }))) return;
          if (await attempt(() => DEL(`/skills/${s.slug}`), 'Deleted')) reload();
        },
      }, icon('trash-2', 13)),
    ),
  );
}

// "Give to…": the project, a team, or an agent (ticks show who already has it; click again to take it away)
function openAssign(anchor: HTMLElement, s: SkillListing) {
  document.querySelector('.skp-menu')?.remove();
  const d = state.data!;
  const u = usedBy(s.slug);
  const r = anchor.getBoundingClientRect();
  const z = uiZoom();
  const close = () => {
    menu.remove();
    document.removeEventListener('pointerdown', outside, true);
  };
  const outside = (e: PointerEvent) => !menu.contains(e.target as Node) && close();
  const row = (on: boolean, label: string, lead: Child, fn: () => Promise<unknown>) => h(`button.st-menu-item${on ? '.on' : ''}`, { onclick: async () => (close(), await fn(), draw()) }, on ? icon('check', 14) : lead, h('span.grow', label));
  const toggle = (arr: string[], on: boolean) => (on ? arr.filter((x) => x !== s.slug) : [...new Set([...arr, s.slug])]);
  const menu = h(
    'div.st-menu.skp-menu',
    h('div.st-menu-head', `Give "${s.name}" to`),
    row(u.project, `This project (${d.project?.name || ''})`, icon('folder-open', 14), () => saveProject(toggle(d.project?.skills || [], u.project))),
    teams.length ? h('div.st-menu-head', 'A team') : null,
    teams.map((t) => {
      const on = u.teams.some((x) => x.id === t.id);
      return row(on, t.name, icon('users', 14), () => saveTeam(t, toggle(t.skills || [], on)));
    }),
    d.agents.length ? h('div.st-menu-head', 'An agent') : null,
    h(
      'div.model-list',
      d.agents.map((a) => {
        const on = u.agents.some((x) => x.id === a.id);
        return row(on, a.name, h('span', { style: { width: '14px', textAlign: 'center' } }, a.emoji || '🤖'), () => saveAgent(a, toggle(a.skills || [], on)));
      }),
    ),
  );
  document.body.append(menu);
  Object.assign(menu.style, { position: 'fixed', left: `${Math.min(r.left / z, window.innerWidth / z - 320)}px`, top: `${Math.min(r.bottom / z + 6, window.innerHeight / z - 420)}px`, transform: 'none', zIndex: 96, width: '300px' });
  setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
}

async function openEditor(slug: string | null = null) {
  const s = slug ? await GET<Skill>(`/skills/${slug}`).catch(() => null) : null;
  const name = h('input', { value: s?.name || '', placeholder: 'e.g. Brand voice, Email to clients, YouTube thumbnail checklist' });
  const desc = h('textarea', { rows: 2, value: s?.description || '', placeholder: 'When should an agent use it? e.g. "Use when writing any post, email or reply for the NET brand."' });
  const body = h('textarea.code', { rows: 16, value: s?.body?.trim() || '', placeholder: '# How to do it\n\n1. …\n2. …\n\n## Rules\n- …\n\n## Example\n…' });
  let m: ModalHandle;
  const save = async (btn: HTMLButtonElement) => {
    btn.disabled = true;
    const r = await attempt(() => (slug ? PUT(`/skills/${slug}`, { name: name.value, description: desc.value, body: body.value }) : POST('/skills', { name: name.value, description: desc.value, body: body.value })), slug ? 'Saved' : 'Skill added');
    btn.disabled = false;
    if (!r) return;
    m.close();
    reload();
  };
  m = modal({
    title: slug ? `Edit skill · ${s?.name || slug}` : 'New skill',
    body: h(
      'div.col',
      field('Name', name),
      field('When to use it', desc, 'Agents decide from this line whether the skill fits, so be specific.'),
      field('Instructions', body, 'Markdown. Steps, rules, examples, what good output looks like. The agent reads this when it uses the skill.'),
      s?.files?.length ? h('div', h('div.label', `Files with this skill (${s.files.length})`), h('div.skill-files', s.files.map((f) => h('span.pill', f.path)))) : null,
      s ? h('p.hint', `Saved as data/skills/${s.slug}/SKILL.md, in the same format Claude Code uses.`) : null,
    ),
    foot: [h('button.btn.ghost', { onclick: () => m.close() }, 'Cancel'), h('button.btn', { onclick: (e) => save(e.currentTarget) }, slug ? 'Save' : 'Add skill')],
  });
  setTimeout(() => (slug ? body : name).focus(), 40);
}

function openImport() {
  let m: ModalHandle;
  const rows = h('div.list');
  const drawRows = () =>
    mount(
      rows,
      data.claude.map((c) =>
        h(
          'div.list-item',
          h('div.skill-ico', icon('puzzle', 16)),
          h('div.grow', h('div.title', c.name), h('div.hint', c.description.slice(0, 160))),
          c.inLibrary
            ? h('span.pill.ok', 'in library')
            : h('button.btn.small', {
                onclick: async (e) => {
                  e.currentTarget.disabled = true;
                  const r = await attempt(() => POST('/skills/import', { name: c.slug }), `Imported ${c.name}`);
                  if (r) {
                    c.inLibrary = true;
                    drawRows();
                    reload();
                  }
                },
              }, 'Import'),
        ),
      ),
    );
  drawRows();
  m = modal({ title: 'Import from Claude Code', body: h('div.col', h('p.hint', 'Your Claude Code skills (~/.claude/skills). Importing copies the skill and its files into the dashboard library; the original stays where it is.'), rows), foot: [h('button.btn', { onclick: () => m.close() }, 'Done')] });
}
