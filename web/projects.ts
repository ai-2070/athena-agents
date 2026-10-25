// Project switcher and "New project" dialog.
import { h, mount, state, GET, POST, attempt, modal, seg, field, toast, refreshSoon, ago } from './core.ts';
import { icon } from './icons.ts';
import { uiZoom } from './look.ts';
import { askBrain } from './dock.ts';
import type { ModalHandle } from './core.ts';
import type { Project } from '../shared/types.ts';

export type NewProjectMode = 'new' | 'existing' | 'github';
/** A saved copy the dashboard found in a folder (.dashboard/project.json). */
export interface ProjectPeek {
  name: string;
  description: string;
  agents: number;
  teams: number;
  savedAt: number;
}
/** POST /api/projects: the project, plus what was loaded back from its folder. */
export interface CreatedProject extends Project {
  restored: { agents: number; teams: number; project?: unknown } | null;
}
/** GET /api/projects */
interface ProjectList {
  active: Project;
  projects: Project[];
  root: string;
}
/** GET /api/projects/overview: the start screen. */
interface ProjectsOverview {
  active: string;
  root: string;
  projects: (Project & { agents: number; teams: number; hasProjectMd: boolean; saved: ProjectPeek | null })[];
  found: { name: string; folder: string; brief?: string; saved: ProjectPeek | null }[];
  showLauncher: boolean;
}

const slug = (s: string | null | undefined) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project';

// A small menu under the project name: switch, create, or manage.
export function openProjectMenu(anchor: Element): void {
  document.querySelector('.proj-menu')?.remove();
  const d = state.data!;
  const r = anchor.getBoundingClientRect();
  const close = () => {
    menu.remove();
    document.removeEventListener('pointerdown', outside, true);
  };
  const outside = (e: PointerEvent) => !menu.contains(e.target as Node) && !anchor.contains(e.target as Node) && close();
  const switchTo = async (p: Project) => {
    close();
    if (p.id === d.project.id) return;
    await attempt(() => POST(`/projects/${p.id}/activate`), `Opened ${p.name}`);
    refreshSoon(0);
  };
  const menu = h(
    'div.st-menu.proj-menu',
    { style: { position: 'fixed', left: `${r.left / uiZoom()}px`, top: `${r.bottom / uiZoom() + 6}px`, transform: 'none' } },
    h('div.st-menu-head', 'Projects'),
    (d.projects || []).map((p) =>
      h(`button.st-menu-item${p.id === d.project.id ? '.on' : ''}`, { onclick: () => switchTo(p) }, p.id === d.project.id ? icon('check', 15) : icon(p.repo ? 'git-branch' : 'folder', 15), h('span.grow', p.name)),
    ),
    h('div.st-menu-sep'),
    h('button.st-menu-item', { onclick: () => (close(), openLauncher({ force: true })) }, icon('folder-open', 15), 'All projects…'),
    h('button.st-menu-item', { onclick: () => (close(), openNewProject()) }, icon('plus', 15), 'New project'),
  );
  document.body.append(menu);
  setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
}

export async function openNewProject({ mode: startMode = 'new', onDone }: { mode?: NewProjectMode; onDone?: (p: CreatedProject) => unknown } = {}): Promise<void> {
  const info = await GET<ProjectList>('/projects').catch(() => ({ root: '' }));
  const sep = info.root.includes('\\') ? '\\' : '/';
  let mode: NewProjectMode = startMode;
  let touchedFolder = false;
  const name = h('input', { placeholder: 'e.g. NET launch, Client X, My game' });
  const folder = h('input.code', { placeholder: info.root ? `${info.root}${sep}…` : 'Folder path' });
  const repo = h('input.code', { placeholder: 'owner/repo or https://github.com/owner/repo' });
  const about = h('textarea', { rows: 4, placeholder: 'What is it, who is it for, what should come out of it? e.g. "Launch campaign for my app NET: X and Reddit posts, a 30s promo video and thumbnails, in a calm, technical voice."' });
  const kickoff = h('input', { type: 'checkbox', checked: true });
  const extra = h('div.col');
  const hint = h('p.hint');
  // a blank name falls back to the repo's name (GitHub only); otherwise the server asks for one
  const repoName = () => (mode === 'github' && repo.value.trim().split('/').pop()?.replace(/\.git$/, '')) || '';
  const namePlaceholder = name.placeholder;
  const suggest = () => {
    name.placeholder = repoName() || namePlaceholder;
    if (!touchedFolder && mode !== 'existing') folder.value = info.root ? `${info.root}${sep}${slug(name.value || repo.value.split('/').pop())}` : '';
  };
  name.addEventListener('input', suggest);
  repo.addEventListener('input', suggest);
  folder.addEventListener('input', () => (touchedFolder = true));
  const draw = () => {
    mount(
      extra,
      mode === 'github' ? field('GitHub repo', repo, 'Cloned with your GitHub login (gh) so private repos work too.') : null,
      field(mode === 'existing' ? 'Your folder' : 'Brain folder', folder, mode === 'existing' ? 'The project Brain is this folder: agents read it and work in it.' : 'A new folder for the project: its files, notes and what the agents make.'),
    );
    hint.textContent =
      (mode === 'new' ? 'Starts with a BRAIN.md and a notes folder.' : mode === 'existing' ? 'If the dashboard saved this folder before, its agents, teams and chats load back in.' : 'Agents work right inside the repo, so they see its code, README and CLAUDE.md.') +
      ' Everything is auto-saved into the folder (.dashboard).';
    if (mode === 'existing' && !touchedFolder) folder.value = '';
    suggest();
  };
  let m: ModalHandle;
  const create = async (btn: HTMLButtonElement) => {
    btn.disabled = true;
    btn.textContent = mode === 'github' ? 'Cloning…' : 'Creating…';
    const p = await attempt(() => POST<CreatedProject>('/projects', { name: name.value.trim() || repoName(), mode, folder: folder.value.trim(), repo: repo.value.trim(), description: about.value.trim() }));
    btn.disabled = false;
    btn.textContent = 'Create project';
    if (!p) return;
    m.close();
    toast(p.restored ? `Loaded "${p.name}": ${p.restored.agents} agents and ${p.restored.teams} teams from the folder` : `Project "${p.name}" is open`);
    await refreshSoon(0);
    onDone?.(p);
    // the Brain studies the new project, asks what it needs, then writes PROJECT.md and sets up teams
    if (kickoff.checked)
      setTimeout(
        () =>
          askBrain(
            `I just created the project "${p.name}".${about.value.trim() ? ` What it is: ${about.value.trim()}` : ''}
Look at the project folder and help me set it up: ask me what you need to know first, then write PROJECT.md and create the teams and agents it needs.`,
          ),
        600,
      );
  };
  const createBtn = h('button.btn', { onclick: (e) => create(e.currentTarget) }, 'Create project');
  m = modal({
    title: 'New project',
    narrow: true,
    body: h(
      'div.col',
      h('p.hint', 'A project has its own agents, teams and chats, and a Brain: a folder with all its files and info.'),
      field('Name', name),
      field('What is this project?', about, 'The Brain reads this, looks at the folder and asks you what it needs to know.'),
      seg(
        [
          { value: 'new', label: 'New folder' },
          { value: 'existing', label: 'Existing folder' },
          { value: 'github', label: 'From GitHub' },
        ],
        mode,
        (v) => ((mode = v), draw()),
      ),
      extra,
      hint,
      h('label.row', { style: { gap: '8px', cursor: 'pointer' } }, kickoff, h('span', 'Let the Brain set it up (PROJECT.md, teams and agents)')),
    ),
    foot: [h('button.btn.ghost', { onclick: () => m.close() }, 'Cancel'), createBtn],
  });
  draw();
  setTimeout(() => name.focus(), 30);
}

// The start screen: pick a project you already have (with its agents and teams), add a project
// folder found on this PC, or create a new one. Shown once each time the dashboard starts.
export async function openLauncher({ force = false }: { force?: boolean } = {}): Promise<void> {
  const o = await GET<ProjectsOverview>('/projects/overview').catch(() => null);
  if (!o || (!force && !o.showLauncher)) return;
  if (document.querySelector('.launcher')) return;
  const done = () => POST('/projects/launcher-done').catch(() => {});
  let m: ModalHandle;
  const open = async (p: Project) => {
    if (p.id !== o.active) {
      const r = await attempt(() => POST(`/projects/${p.id}/activate`), `Opened ${p.name}`);
      if (!r) return;
    } else done();
    m.close();
    refreshSoon(0);
  };
  const addFound = async (f: ProjectsOverview['found'][number]) => {
    const p = await attempt(() => POST<CreatedProject>('/projects', { name: f.name, mode: 'existing', folder: f.folder }), (r) => (r.restored ? `Loaded ${f.name}: ${r.restored.agents} agents, ${r.restored.teams} teams` : `Added ${f.name}`));
    if (!p) return;
    m.close();
    refreshSoon(0);
  };
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const card = (p: ProjectsOverview['projects'][number]) =>
    h(
      `button.launch-card${p.id === o.active ? '.cur' : ''}`,
      { type: 'button', onclick: () => open(p) },
      h('div.launch-ico', icon(p.repo ? 'git-branch' : 'folder-open', 20)),
      h(
        'div.grow',
        h('div.launch-name', p.name, p.id === o.active ? h('span.pill.ok', 'last open') : null),
        p.description ? h('div.launch-desc', p.description.length > 120 ? `${p.description.slice(0, 120)}…` : p.description) : null,
        h('div.launch-meta', h('span', icon('bot', 12), plural(p.agents, 'agent')), h('span', icon('users', 12), plural(p.teams, 'team')), p.hasProjectMd ? h('span', icon('file-text', 12), 'PROJECT.md') : null, p.openedAt || p.createdAt ? h('span', icon('clock', 12), ago(p.openedAt || p.createdAt)) : null),
        h('div.launch-path', p.brainPath),
      ),
      icon('chevron-right', 18),
    );
  m = modal({
    title: 'Open a project',
    onClose: done,
    body: h(
      'div.launcher',
      h('p.hint', 'Each project has its own agents, teams, chats and a Brain folder, and is auto-saved into that folder. Pick one to load it, open a folder you saved before, or start a new one.'),
      h('div.launch-list', o.projects.map(card)),
      o.found.length
        ? h(
            'div.mt',
            h('div.label', 'Found on this PC'),
            h(
              'div.launch-list',
              o.found.map((f) =>
                h('button.launch-card.found', { type: 'button', onclick: () => addFound(f) }, h('div.launch-ico', icon('folder', 20)), h('div.grow', h('div.launch-name', f.name), h('div.launch-meta', f.saved ? [h('span', icon('bot', 12), plural(f.saved.agents, 'agent')), h('span', icon('users', 12), plural(f.saved.teams, 'team')), h('span', icon('clock', 12), `saved ${ago(f.saved.savedAt)}`)] : null, f.brief ? h('span', icon('file-text', 12), f.brief) : null), h('div.launch-path', f.folder)), h('span.btn.tiny', 'Add')),
              ),
            ),
          )
        : null,
    ),
    foot: [
      h('button.btn.ghost', { onclick: () => (m.close(), openNewProject({ mode: 'existing' })) }, icon('folder-open', 15), ' Open a folder…'),
      h('button.btn', { onclick: () => (m.close(), openNewProject()) }, icon('plus', 15), ' New project'),
    ],
  });
}
