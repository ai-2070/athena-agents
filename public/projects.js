// Project switcher and "New project" dialog.
import { h, mount, state, GET, POST, attempt, modal, seg, field, toast, refreshSoon } from './core.js';
import { icon } from './icons.js';

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project';

// A small menu under the project name: switch, create, or manage.
export function openProjectMenu(anchor) {
  document.querySelector('.proj-menu')?.remove();
  const d = state.data;
  const r = anchor.getBoundingClientRect();
  const close = () => {
    menu.remove();
    document.removeEventListener('pointerdown', outside, true);
  };
  const outside = (e) => !menu.contains(e.target) && !anchor.contains(e.target) && close();
  const switchTo = async (p) => {
    close();
    if (p.id === d.project.id) return;
    await attempt(() => POST(`/projects/${p.id}/activate`), `Opened ${p.name}`);
    refreshSoon(0);
  };
  const menu = h(
    'div.st-menu.proj-menu',
    { style: { position: 'fixed', left: `${r.left}px`, top: `${r.bottom + 6}px`, transform: 'none' } },
    h('div.st-menu-head', 'Projects'),
    (d.projects || []).map((p) =>
      h(`button.st-menu-item${p.id === d.project.id ? '.on' : ''}`, { onclick: () => switchTo(p) }, p.id === d.project.id ? icon('check', 15) : icon(p.repo ? 'git-branch' : 'folder', 15), h('span.grow', p.name)),
    ),
    h('div.st-menu-sep'),
    h('button.st-menu-item', { onclick: () => (close(), openNewProject()) }, icon('plus', 15), 'New project'),
  );
  document.body.append(menu);
  setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
}

export async function openNewProject() {
  const info = await GET('/projects').catch(() => ({ root: '' }));
  const sep = info.root.includes('\\') ? '\\' : '/';
  let mode = 'new';
  let touchedFolder = false;
  const name = h('input', { placeholder: 'e.g. NET launch, Client X, My game' });
  const folder = h('input.code', { placeholder: info.root ? `${info.root}${sep}…` : 'Folder path' });
  const repo = h('input.code', { placeholder: 'owner/repo or https://github.com/owner/repo' });
  const extra = h('div.col');
  const hint = h('p.hint');
  const suggest = () => {
    if (!touchedFolder && mode !== 'existing') folder.value = info.root ? `${info.root}${sep}${slug(name.value || repo.value.split('/').pop())}` : '';
  };
  name.addEventListener('input', suggest);
  repo.addEventListener('input', () => {
    if (!name.value) name.placeholder = repo.value.split('/').pop()?.replace(/\.git$/, '') || name.placeholder;
    suggest();
  });
  folder.addEventListener('input', () => (touchedFolder = true));
  const draw = () => {
    mount(
      extra,
      mode === 'github' ? field('GitHub repo', repo, 'Cloned with your GitHub login (gh) so private repos work too.') : null,
      field(mode === 'existing' ? 'Your folder' : 'Brain folder', folder, mode === 'existing' ? 'The project Brain is this folder: agents read it and work in it.' : 'A new folder for the project: its files, notes and what the agents make.'),
    );
    hint.textContent =
      mode === 'new' ? 'Starts with a BRAIN.md and a notes folder.' : mode === 'existing' ? 'Nothing in the folder is changed.' : 'Agents work right inside the repo, so they see its code, README and CLAUDE.md.';
    if (mode === 'existing' && !touchedFolder) folder.value = '';
    else suggest();
  };
  let m;
  const create = async (btn) => {
    btn.disabled = true;
    btn.textContent = mode === 'github' ? 'Cloning…' : 'Creating…';
    const p = await attempt(() => POST('/projects', { name: name.value.trim() || name.placeholder, mode, folder: folder.value.trim(), repo: repo.value.trim() }));
    btn.disabled = false;
    btn.textContent = 'Create project';
    if (!p) return;
    m.close();
    toast(`Project "${p.name}" is open`);
    refreshSoon(0);
  };
  const createBtn = h('button.btn', { onclick: (e) => create(e.currentTarget) }, 'Create project');
  m = modal({
    title: 'New project',
    narrow: true,
    body: h(
      'div.col',
      h('p.hint', 'A project has its own agents, teams and chats, and a Brain: a folder with all its files and info.'),
      field('Name', name),
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
    ),
    foot: [h('button.btn.ghost', { onclick: () => m.close() }, 'Cancel'), createBtn],
  });
  draw();
  setTimeout(() => name.focus(), 30);
}
