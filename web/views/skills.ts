// Skills: reusable instructions (Claude Code's SKILL.md format) you give to agents three ways:
// per agent, per team (every member while it works for the team) or per project (every agent).
// The Brain has skills too: it follows them in every turn (Self-improvement: it records workflows itself).
import { h, mount, state, GET, POST, PUT, DEL, attempt, modal, field, toast, refreshSoon, confirmBox, navigate, avatar } from '../core.ts';
import { icon, logo } from '../icons.ts';
import { uiZoom } from '../look.ts';
import { skillPicker, loadSkills, forgetSkills } from '../skillpick.ts';
import { historyButton, deletedButton } from '../history.ts';
import { attachTray } from '../attach.ts';
import type { Agent, ClaudeSkill, Project, ServerEvent, Skill, SkillInstallResult, SkillListing, TeamListing } from '../../shared/types.ts';
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

// #/skills/<slug> opens that skill (the Brain chat links here when it changed one)
export async function render(el: HTMLElement, params: string[] = []): Promise<void> {
  root = el;
  mount(el, h('p.dim', 'Loading skills…'));
  await reload();
  if (params[0] && data.skills.some((s) => s.slug === params[0])) openEditor(params[0]);
}

async function reload() {
  [data, teams] = await Promise.all([GET<SkillsData>('/skills'), GET<TeamListing[]>('/workflows').catch((): TeamListing[] => [])]);
  forgetSkills();
  await loadSkills(true);
  draw();
}

export function onEvent(ev: ServerEvent): void {
  // the Brain made or changed a skill: show it
  if (ev.type === 'activity' && (ev as ServerEvent & { entry?: { kind?: string } }).entry?.kind === 'skill' && root?.isConnected) void reload();
  if (['agents', 'workflows', 'project'].includes(ev.type) && root?.isConnected) GET<TeamListing[]>('/workflows').then((t) => ((teams = t), draw())).catch(() => {});
}

// Who has a skill: the project, teams, agents.
function usedBy(slug: string) {
  const d = state.data!;
  return {
    project: (d.project?.skills || []).includes(slug),
    teams: teams.filter((t) => (t.skills || []).includes(slug)),
    agents: d.agents.filter((a) => (a.skills || []).includes(slug)),
    brain: brainList().includes(slug),
  };
}

const brainList = (): string[] => state.data?.settings?.brainSkills || [];
// (the saved list goes into the page's state right away, so a menu redrawn next shows it)
const saveBrain = (skills: string[]) =>
  attempt(() => PUT<{ skills: string[] }>('/brain/skills', { skills })).then((r) => {
    if (r && state.data) state.data.settings.brainSkills = r.skills;
    refreshSoon(0);
  });

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
      h('div.skills-scope', h('div.skills-scope-ico', icon('brain', 18)), h('div', h('b', 'The Brain'), h('div.hint', 'Follows it in every turn'))),
    ),
    h(
      'div.panel.mt',
      h('div.panel-head', h('h2', icon('folder-open', 16), ` Project skills · ${proj.name || ''}`), h('span.hint', 'every agent in this project gets these')),
      skillPicker(proj.skills || [], saveProject, { empty: 'None yet. Add skills every agent here should follow, like your brand voice or how files are named.' }),
    ),
    h(
      'div.panel.mt',
      h('div.panel-head', h('h2', icon('brain', 16), " The Brain's skills"), h('span.hint', 'in every project')),
      skillPicker(brainList(), saveBrain, { empty: 'None. The Brain still makes and edits skills when you ask it to.' }),
      h(
        'p.hint',
        brainList().includes('self-improvement')
          ? 'With Self-improvement the Brain keeps your skills up to date by itself: after an agent finishes a sizeable job, it records the workflow as a skill or improves one, and says so in the Brain chat. Take the skill away to stop that.'
          : 'Give the Brain Self-improvement and it records workflows as skills by itself after agents finish sizeable jobs. You can also ask it in the Brain chat: "save how we did that as a skill".',
      ),
    ),
    h(
      'div.row.between.mt-lg',
      h('div.row', { style: { gap: '8px' } }, h('h2.section', { style: { margin: 0 } }, `Library (${data.skills.length})`), search),
      h(
        'div.row',
        { style: { gap: '8px' } },
        deletedButton(['skill'], () => void reload()),
        h('button.btn.ghost.small', { onclick: () => openGitHub() }, logo('github', 14) || icon('download', 14), 'From GitHub'),
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
    u.brain ? h('span.skill-use.proj', icon('brain', 11), 'The Brain') : null,
    u.project ? h('span.skill-use.proj', icon('folder-open', 11), 'Project') : null,
    ...u.teams.map((t) => h('span.skill-use.team', { style: { '--c': t.color || '#7350c8' } }, icon('users', 11), t.name)),
    ...u.agents.map((a) => h('span.skill-use', `${a.emoji || ''} ${a.name}`)),
  ].filter(Boolean);
  return h(
    'div.skill-card',
    h(
      'div.skill-top',
      h('div.skill-ico', icon('puzzle', 18)),
      h(
        'div.grow',
        h('div.skill-name', s.name),
        h('div.hint', s.files.length ? `${s.files.length} extra file${s.files.length === 1 ? '' : 's'}` : 'instructions only', s.origin ? h('span', ' · from ', h('a', { href: s.origin.url, target: '_blank', rel: 'noopener' }, s.origin.repo)) : null),
      ),
    ),
    h('p.skill-desc', s.description),
    h('div.skill-uses', chips.length ? chips : h('span.hint', 'Not given to anyone yet')),
    h(
      'div.skill-foot',
      h('button.btn.small', { onclick: (e) => openAssign(e.currentTarget, s) }, icon('plus', 13), 'Give to…'),
      h('button.btn.ghost.small', { onclick: () => openEditor(s.slug) }, icon('pencil', 13), 'Edit'),
      s.origin
        ? h('button.btn.ghost.small', {
            title: `Download it again from ${s.origin.repo} (the current version is kept in History)`,
            onclick: async (e: MouseEvent) => {
              const btn = e.currentTarget as HTMLButtonElement;
              btn.disabled = true;
              const r = await attempt(() => POST<SkillInstallResult>('/skills/install', { url: s.origin!.url }), (x) => (x.installed.length ? `Updated ${x.installed.map((i) => i.name).join(', ')}` : 'Nothing updated'));
              btn.disabled = false;
              if (r) reload();
            },
          }, icon('rotate-cw', 13), 'Update')
        : null,
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
    row(u.brain, 'The Brain', icon('brain', 14), () => saveBrain(toggle(brainList(), u.brain))),
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

  // Plain words: describe a new skill, or say what to change, and the Brain writes it into the fields
  // below. Nothing is saved until Save (and saving keeps the version from before, in History).
  const ask = h('textarea.skill-ask-input', {
    rows: 2,
    placeholder: slug
      ? 'What should change? e.g. "Add a section on thumbnails", "Make the rules shorter", "Write it for LinkedIn instead of X"'
      : 'Describe the skill in your own words. e.g. "How we write release notes: short bullets, user-facing changes first, no jargon, link the PR"',
  });
  const tray = attachTray();
  const askStatus = h('span.hint.grow');
  let before: { name: string; description: string; body: string } | null = null;
  const undoBtn = h('button.btn.ghost.small.hidden', {
    type: 'button',
    title: 'Put back what the fields said before',
    onclick: () => {
      if (!before) return;
      [name.value, desc.value, body.value] = [before.name, before.description, before.body];
      before = null;
      undoBtn.classList.add('hidden');
      askStatus.textContent = 'Undone.';
    },
  }, icon('rotate-ccw', 13), 'Undo');
  const fields = () => ({ name: name.value, description: desc.value, body: body.value });
  let asking = false;
  const runAsk = async () => {
    if (asking) return;
    const text = ask.value.trim();
    if (!text && !tray.count()) return toast(slug ? 'Say what to change first.' : 'Describe the skill first.', 'warn');
    asking = askBtn.disabled = true;
    try {
      askStatus.textContent = tray.busy() ? 'Uploading files…' : '';
      const attachments = await tray.ready();
      if (!attachments) return void (askStatus.textContent = '');
      askStatus.textContent = slug || name.value || body.value ? 'The Brain is changing the skill…' : 'The Brain is writing the skill…';
      const now = fields();
      const draft = await attempt(() => POST<{ name: string; description: string; body: string; note: string }>('/assist/skill', { text, slug: slug || undefined, current: now, attachments }));
      if (!draft) return void (askStatus.textContent = '');
      before = now;
      [name.value, desc.value, body.value] = [draft.name, draft.description, draft.body];
      undoBtn.classList.remove('hidden');
      askStatus.textContent = `${draft.note || 'Done.'} Look it over, then ${slug ? 'Save' : 'Add skill'}.`;
      ask.value = '';
    } finally {
      asking = askBtn.disabled = false;
    }
  };
  const askBtn = h('button.btn.small', { type: 'button', onclick: () => void runAsk() }, icon('sparkles', 13), slug ? 'Change it' : 'Write it');
  ask.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void runAsk();
    }
  });
  const askBox = h(
    'div.skill-ask',
    h('div.label', icon('sparkles', 13), slug ? ' Change it in plain words' : ' Write it in plain words'),
    ask,
    tray.el,
    h('div.row', { style: { gap: '8px' } }, askBtn, tray.picker, undoBtn, askStatus),
    h('p.hint', `${slug ? 'The Brain rewrites the fields below as you ask (what you typed there counts too).' : 'The Brain fills in the fields below.'} Drop examples or notes to learn from. Nothing is saved until you press ${slug ? 'Save' : 'Add skill'}. Ctrl+Enter sends.`),
  );
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
      askBox,
      field('Name', name),
      field('When to use it', desc, 'Agents decide from this line whether the skill fits, so be specific.'),
      field('Instructions', body, 'Markdown. Steps, rules, examples, what good output looks like. The agent reads this when it uses the skill.'),
      s?.files?.length ? h('div', h('div.label', `Files with this skill (${s.files.length})`), h('div.skill-files', s.files.map((f) => h('span.pill', f.path)))) : null,
      s ? h('p.hint', `Saved as data/skills/${s.slug}/SKILL.md, in the same format Claude Code uses. Every change keeps the version from before it (History).`) : null,
    ),
    foot: [
      slug ? historyButton('skill', slug, () => (m.close(), void reload(), void openEditor(slug))) : null,
      h('span.grow'),
      h('button.btn.ghost', { onclick: () => m.close() }, 'Cancel'),
      h('button.btn', { onclick: (e) => save(e.currentTarget) }, slug ? 'Save' : 'Add skill'),
    ],
    // the files were only for the Brain to read: they go with the dialog
    onClose: () => tray.discard(),
  });
  tray.dropZone(m.el.querySelector<HTMLElement>('.modal')!, 'Drop examples or notes for the Brain');
  setTimeout(() => ask.focus(), 40);
}

// Install skills from a GitHub link: a repo, a folder or a SKILL.md.
function openGitHub() {
  let m: ModalHandle;
  const url = h('input', { placeholder: 'https://github.com/owner/repo/tree/main/skills/my-skill' });
  const out = h('div.col');
  const go = async (btn: HTMLButtonElement) => {
    if (!url.value.trim()) return url.focus();
    btn.disabled = true;
    btn.textContent = 'Installing…';
    const r = await attempt(() => POST<SkillInstallResult>('/skills/install', { url: url.value.trim() }));
    btn.disabled = false;
    btn.textContent = 'Install';
    if (!r) return;
    mount(
      out,
      r.installed.map((x) => h('div.list-item', icon('check', 14), h('div.grow', h('b', x.name), h('span.hint', ` · ${x.updated ? 'updated' : 'installed'}, ${x.files} file${x.files === 1 ? '' : 's'}`)))),
      r.skipped.map((x) => h('div.list-item', icon('triangle-alert', 14), h('div.grow.hint', x))),
      r.installed.length ? h('p.hint', 'Give them to an agent, a team or the project with "Give to…" on each card.') : null,
    );
    if (r.installed.length) reload();
  };
  url.addEventListener('keydown', (e) => e.key === 'Enter' && go(m.el.querySelector<HTMLButtonElement>('.gh-install')!));
  m = modal({
    title: 'Install skills from GitHub',
    body: h(
      'div.col',
      field('GitHub link', url, 'A repo, a folder or a SKILL.md. Every folder with a SKILL.md at or under the link is installed, with its files (up to 20 skills). Installing from the same place again updates them; the old version stays in History.'),
      h('p.hint', 'Skills are instructions your agents follow: install them only from people you trust. Private repos work once you sign in with the GitHub CLI (gh auth login).'),
      out,
    ),
    foot: [h('button.btn.ghost', { onclick: () => m.close() }, 'Close'), h('button.btn.gh-install', { onclick: (e) => go(e.currentTarget) }, 'Install')],
  });
  setTimeout(() => url.focus(), 40);
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
                  const btn = e.currentTarget;
                  btn.disabled = true;
                  const r = await attempt(() => POST('/skills/import', { name: c.slug }), `Imported ${c.name}`);
                  if (!r) {
                    btn.disabled = false; // failed: let them try again
                    return;
                  }
                  c.inLibrary = true;
                  drawRows();
                  reload();
                },
              }, 'Import'),
        ),
      ),
    );
  drawRows();
  m = modal({ title: 'Import from Claude Code', body: h('div.col', h('p.hint', 'Your Claude Code skills (~/.claude/skills). Importing copies the skill and its files into the dashboard library; the original stays where it is.'), rows), foot: [h('button.btn', { onclick: () => m.close() }, 'Done')] });
}
