// Project switcher and "New project" dialog.
import { h, mount, state, GET, POST, PUT, attempt, promptBox, confirmBox, modal, seg, field, toast, refreshSoon, ago } from './core.ts';
import { icon } from './icons.ts';
import { projectMark } from './projectlogo.ts';
import { moveId } from './projectnav.ts';
import { uiZoom } from './look.ts';
import { askBrain } from './dock.ts';
import { BACKUP_EXT, backupProject, backupAgo, fileSize, listBackups, readBackupSummary, restoreBackup, restoredText, summaryLine } from './backup.ts';
import type { BackupListing, BackupSummary } from './backup.ts';
import { attachTray } from './attach.ts';
import type { ModalHandle } from './core.ts';
import type { Project } from '../shared/types.ts';

export type NewProjectMode = 'new' | 'existing' | 'github' | 'backup';
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
// ---------- what you can do with a project: rename, clone, delete (in the project menu and on the All projects screen) ----------
type ProjectRef = Pick<Project, 'id' | 'name'>;

/** Asks for a new name and saves it (only the name: the folder and files keep theirs). */
export async function renameProject(p: ProjectRef): Promise<boolean> {
  const name = (await promptBox('Rename project', { value: p.name }))?.trim();
  if (!name || name === p.name) return false;
  const r = await attempt(() => PUT(`/projects/${encodeURIComponent(p.id)}`, { name }), `Renamed to ${name}`);
  refreshSoon(0);
  return !!r;
}

/** A copy as a new project (agents, teams, routines, notes, skills and chats; schedules start paused), which is opened. */
export async function cloneProject(p: ProjectRef): Promise<boolean> {
  const name = (await promptBox('Clone project', { label: 'Name of the copy', value: `${p.name} (copy)`, ok: 'Clone' }))?.trim();
  if (!name) return false;
  const made = await attempt(() => POST<CreatedProject>(`/projects/${encodeURIComponent(p.id)}/clone`, { name }), (r) => `Cloned as ${r.name}: ${r.restored?.agents ?? 0} agents, ${r.restored?.teams ?? 0} teams`);
  if (!made) return false;
  await attempt(() => POST(`/projects/${encodeURIComponent(made.id)}/activate`));
  refreshSoon(0);
  return true;
}

/** Deletes a project after a backup that is made and checked first. Its folder and files on the PC are never touched. */
export async function deleteProject(p: ProjectRef): Promise<boolean> {
  const sure = await confirmBox(
    h(
      'div',
      h('p', `Delete the project "${p.name}"?`),
      h('p.hint', 'First a backup is made in My Dashboard Backups and checked. Only if it is complete is the project removed: its agents, teams, chats and settings leave the dashboard (set aside on this PC, not erased). The project\'s own folder and files are not touched.'),
    ),
    { ok: 'Back up and delete', danger: true },
  );
  if (!sure) return false;
  const r = await attempt(() => POST<{ backup: { name: string } }>(`/projects/${encodeURIComponent(p.id)}/delete`), (x) => `Deleted ${p.name}. Backup: ${x.backup.name}`);
  refreshSoon(0);
  return !!r;
}

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
  // the projects in their order (the floors): drag one, or Alt+Up / Alt+Down on it, to move it; the pencil (or F2) renames it
  const list = h('div.proj-menu-list');
  const rows = new Map<string, HTMLElement>();
  const order = () => [...list.children].map((c) => (c as HTMLElement).dataset.id!);
  const save = (ids: string[]) => {
    for (const id of ids) list.append(rows.get(id)!);
    void attempt(() => POST('/projects/order', { ids })).then(() => refreshSoon(0));
  };
  let dragId = '';
  const clearMarks = () => list.querySelectorAll('.drop-above, .drop-below, .dragging').forEach((el) => el.classList.remove('drop-above', 'drop-below', 'dragging'));
  // the name turns into a box: Enter or leaving it saves, Esc keeps the old name
  const startRename = (p: Project, row: HTMLElement, item: HTMLElement, label: HTMLElement) => {
    if (row.querySelector('.proj-rename-row')) return;
    const input = h('input', { value: p.name, maxlength: 80, 'aria-label': `New name for ${p.name}` });
    const box = h('div.proj-rename-row', projectMark(p, 16), input);
    let done = false;
    const finish = (commit: boolean) => {
      if (done) return;
      done = true;
      box.remove();
      item.classList.remove('hidden');
      row.draggable = true;
      const next = input.value.trim();
      if (!commit || !next || next === p.name) return;
      label.textContent = next;
      p.name = next;
      void attempt(() => PUT(`/projects/${encodeURIComponent(p.id)}`, { name: next }), `Renamed to ${next}`).then(() => refreshSoon(0));
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        finish(true);
        setTimeout(() => item.focus(), 0);
      } else if (e.key === 'Escape') {
        e.preventDefault(); // (the menu itself stays open)
        finish(false);
        setTimeout(() => item.focus(), 0);
      }
    });
    input.addEventListener('blur', () => finish(true));
    row.draggable = false;
    item.classList.add('hidden');
    row.prepend(box);
    input.focus();
    input.select();
  };
  for (const p of d.projects || []) {
    const label = h('span.grow', p.name);
    const item = h(
      `button.st-menu-item${p.id === d.project.id ? '.on' : ''}`,
      { title: 'Drag to change the order (or Alt+Up / Alt+Down)', onclick: () => switchTo(p) },
      icon('grip-vertical', 13),
      projectMark(p, 16),
      label,
      p.id === d.project.id ? icon('check', 14) : null,
    );
    const row = h('div.proj-menu-row', { draggable: 'true', 'data-id': p.id }, item);
    row.append(h('button.proj-rename-btn', { title: `Rename ${p.name} (F2)`, 'aria-label': `Rename ${p.name}`, onclick: () => startRename(p, row, item, label) }, icon('pencil', 13)));
    row.addEventListener('dragstart', (e) => {
      dragId = p.id;
      e.dataTransfer?.setData('text/plain', p.id);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      setTimeout(() => row.classList.add('dragging'), 0);
    });
    row.addEventListener('dragend', clearMarks);
    row.addEventListener('dragover', (e) => {
      if (!dragId || dragId === p.id) return;
      e.preventDefault();
      const r2 = row.getBoundingClientRect();
      const below = e.clientY > r2.top + r2.height / 2;
      list.querySelectorAll('.drop-above, .drop-below').forEach((el) => el.classList.remove('drop-above', 'drop-below'));
      row.classList.add(below ? 'drop-below' : 'drop-above');
    });
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      const below = row.classList.contains('drop-below');
      clearMarks();
      const dragged = dragId;
      dragId = '';
      if (!dragged || dragged === p.id) return;
      const without = order().filter((x) => x !== dragged);
      const at = without.indexOf(p.id) + (below ? 1 : 0);
      save([...without.slice(0, at), dragged, ...without.slice(at)]);
    });
    row.addEventListener('keydown', (e) => {
      if (e.key === 'F2') {
        e.preventDefault();
        return startRename(p, row, item, label);
      }
      if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
      e.preventDefault();
      const ids = order();
      const i = ids.indexOf(p.id);
      save(moveId(ids, p.id, e.key === 'ArrowUp' ? i - 1 : i + 1));
      setTimeout(() => item.focus(), 0);
    });
    rows.set(p.id, row);
    list.append(row);
  }
  const menu = h(
    'div.st-menu.proj-menu',
    { style: { position: 'fixed', left: `${r.left / uiZoom()}px`, top: `${r.bottom / uiZoom() + 6}px`, transform: 'none' } },
    h('div.st-menu-head', 'Projects'),
    h('div.st-menu-hint', 'Drag to reorder, the pencil renames. On the Station, Up and Down switch between them.'),
    list,
    h('div.st-menu-sep'),
    h('button.st-menu-item', { onclick: () => (close(), openLauncher({ force: true })) }, icon('folder-open', 15), 'All projects…'),
    h('button.st-menu-item', { onclick: () => (close(), openNewProject()) }, icon('plus', 15), 'New project'),
    h('button.st-menu-item', { onclick: () => (close(), void cloneProject(d.project)) }, icon('copy', 15), 'Clone this project…'),
    h('div.st-menu-sep'),
    h('button.st-menu-item', { onclick: () => (close(), backupProject(d.project)) }, icon('archive', 15), 'Back up this project'),
    h('button.st-menu-item', { onclick: () => (close(), openNewProject({ mode: 'backup' })) }, icon('upload', 15), 'Restore a backup…'),
    h('div.st-menu-sep'),
    h('button.st-menu-item.danger', { onclick: () => (close(), void deleteProject(d.project)) }, icon('trash-2', 15), 'Delete this project…'),
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
  // the project's folder doesn't exist yet: the files wait and go into it once it is created
  const tray = attachTray({ deferred: true });
  const extra = h('div.col');
  const hint = h('p.hint');
  // a blank name falls back to the repo's name (GitHub only); otherwise the server asks for one
  const repoName = () => (mode === 'github' && repo.value.trim().split('/').pop()?.replace(/\.git$/, '')) || '';
  const namePlaceholder = name.placeholder;
  const suggest = () => {
    name.placeholder = repoName() || namePlaceholder;
    if (!touchedFolder && mode !== 'existing' && mode !== 'backup') folder.value = info.root ? `${info.root}${sep}${slug(name.value || repo.value.split('/').pop())}` : '';
  };
  name.addEventListener('input', suggest);
  repo.addEventListener('input', suggest);
  folder.addEventListener('input', () => (touchedFolder = true));
  let touchedName = false;
  let touchedAbout = false;
  name.addEventListener('input', () => (touchedName = true));
  about.addEventListener('input', () => (touchedAbout = true));

  // From backup: a dropped or chosen .dashbackup file, or one from the backups folder
  let picked: { file: File } | { listed: string } | null = null;
  let pickedSummary: BackupSummary | null = null;
  let pickedLabel = '';
  let backups: BackupListing[] | null = null;
  const chooser = h('input', { type: 'file', accept: BACKUP_EXT, style: { display: 'none' } });
  chooser.addEventListener('change', () => {
    const f = chooser.files?.[0];
    chooser.value = '';
    if (f) void pickFile(f);
  });
  const usePicked = (src: NonNullable<typeof picked>, sum: BackupSummary | null, label: string) => {
    picked = src;
    pickedSummary = sum;
    pickedLabel = label;
    // the backup's name and description, unless you typed your own
    if (sum && !touchedName) name.value = sum.name;
    if (sum && !touchedAbout) about.value = sum.description;
    draw();
  };
  const pickFile = async (f: File) => {
    const sum = await readBackupSummary(f).catch(() => null);
    if (!sum) return toast(`${f.name} isn't a dashboard backup (a ${BACKUP_EXT} file).`, 'error');
    usePicked({ file: f }, sum, `${f.name} · ${fileSize(f.size)}`);
  };
  const dropZone = () => {
    const zone: HTMLDivElement = h(
      `div.backup-drop${picked ? '.has' : ''}`,
      {
        role: 'button',
        tabindex: 0,
        'aria-label': 'Choose a backup file',
        onclick: () => chooser.click(),
        onkeydown: (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), chooser.click()),
        ondragenter: (): void => zone.classList.add('over'),
        ondragleave: (e: DragEvent): void => {
          if (!zone.contains(e.relatedTarget as Node | null)) zone.classList.remove('over');
        },
        ondrop: (): void => zone.classList.remove('over'),
      },
      picked && pickedSummary
        ? [
            h('div.backup-drop-ico', icon('archive', 22)),
            h(
              'div.grow',
              h('div.backup-drop-title', pickedSummary.name || 'Backup'),
              h('div.backup-drop-meta', summaryLine(pickedSummary)),
              pickedSummary.agentList.length ? h('div.backup-drop-agents', pickedSummary.agentList.map((a) => h('span', { title: a.name }, a.emoji, ' ', a.name))) : null,
              h('div.backup-drop-meta', `Backed up ${ago(pickedSummary.createdAt)} · ${pickedLabel}`),
            ),
            h('span.btn.tiny.ghost', 'Change'),
          ]
        : [h('div.backup-drop-ico', icon('upload', 24)), h('div.backup-drop-title', 'Drop a backup here'), h('div.hint', `or click to choose a ${BACKUP_EXT} file`)],
    );
    return zone;
  };
  const recent = () => {
    if (picked || !backups?.length) return null;
    return h(
      'div.col',
      h('div.label', 'In your backups folder'),
      h(
        'div.backup-list',
        backups.slice(0, 6).map((b) =>
          h(
            'button.backup-item',
            { type: 'button', onclick: () => usePicked({ listed: b.name }, b.summary, `${b.name} · ${fileSize(b.size)}`) },
            icon('archive', 15),
            h('span.grow', h('span.backup-item-name', b.summary?.name || b.name), b.summary ? h('span.backup-item-meta', summaryLine(b.summary)) : null),
            h('span.backup-item-meta', backupAgo(b.summary, b.modifiedAt)),
          ),
        ),
      ),
    );
  };

  // set once the dialog exists: the tray takes drops in every mode but "From backup"
  let syncDrop = () => {};
  const draw = () => {
    if (mode === 'backup') {
      if (backups === null) {
        backups = [];
        void listBackups()
          .then((r) => ((backups = r.backups), mode === 'backup' && draw()))
          .catch(() => {});
      }
      folder.placeholder = info.root ? `A new folder in ${info.root}` : 'Folder path';
      mount(
        extra,
        dropZone(),
        chooser,
        recent(),
        field('Brain folder', folder, 'Leave empty for a new folder. In a folder you already have, files there are never overwritten.'),
      );
      hint.textContent = 'Brings back its agents, teams, routines, chats, knowledge files and notes, and adds its skills and saved presets to your library (yours stay as they are).';
      kickoffRow.style.display = 'none';
      filesRow.style.display = 'none';
      syncDrop();
      createBtn.textContent = 'Restore project';
      createBtn.disabled = !picked;
      if (!touchedFolder) folder.value = '';
      return;
    }
    folder.placeholder = info.root ? `${info.root}${sep}…` : 'Folder path';
    kickoffRow.style.display = '';
    filesRow.style.display = '';
    syncDrop();
    createBtn.textContent = created ? 'Try the files again' : 'Create project';
    createBtn.disabled = false;
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
  // made already (its files failed to upload): the next click only tries the files again
  let created: CreatedProject | null = null;
  const restore = async (btn: HTMLButtonElement) => {
    if (!picked) return toast('Drop a backup file first.', 'error');
    btn.disabled = true;
    btn.textContent = 'Restoring…';
    const p = await attempt(() => restoreBackup(picked!, { name: name.value.trim(), folder: touchedFolder ? folder.value.trim() : '', description: about.value.trim() }));
    btn.disabled = false;
    btn.textContent = 'Restore project';
    if (!p) return;
    m.close();
    toast(restoredText(p.name, p.restored), p.restored.paused ? 'warn' : 'info', 8000);
    await refreshSoon(0);
    onDone?.(p);
  };
  const create = async (btn: HTMLButtonElement) => {
    if (mode === 'backup') return restore(btn);
    btn.disabled = true;
    btn.textContent = created ? 'Uploading files…' : mode === 'github' ? 'Cloning…' : 'Creating…';
    const p = created || (await attempt(() => POST<CreatedProject>('/projects', { name: name.value.trim() || repoName(), mode, folder: folder.value.trim(), repo: repo.value.trim(), description: about.value.trim() })));
    if (!p) {
      btn.disabled = false;
      btn.textContent = 'Create project';
      return;
    }
    if (!created) {
      created = p;
      // the project exists now: only its files can still change
      for (const f of [name, folder, repo, about]) f.disabled = true;
    }
    // the new project is the active one now, so the files land in its folder (uploads/), shown here while they go
    let files: string[] = [];
    if (tray.count()) {
      btn.textContent = 'Uploading files…';
      const up = await tray.ready();
      if (!up) {
        // stay open: try again, or remove the ones that failed and go on
        btn.disabled = false;
        btn.textContent = 'Try the files again';
        return;
      }
      files = up;
    }
    m.close();
    toast(p.restored ? `Loaded "${p.name}": ${p.restored.agents} agents and ${p.restored.teams} teams from the folder` : `Project "${p.name}" is open`);
    if (files.length && !kickoff.checked) toast(`Added ${files.length} file${files.length === 1 ? '' : 's'} to the project folder (uploads/)`);
    await refreshSoon(0);
    onDone?.(p);
    // the Brain studies the new project, asks what it needs, then writes PROJECT.md and sets up teams
    if (kickoff.checked)
      setTimeout(
        () =>
          askBrain(
            `I just created the project "${p.name}".${about.value.trim() ? ` What it is: ${about.value.trim()}` : ''}${files.length ? ' I attached files for it: study them too.' : ''}
Look at the project folder and help me set it up: ask me what you need to know first, then write PROJECT.md and create the teams and agents it needs.`,
            files,
          ),
        600,
      );
  };
  const createBtn = h('button.btn', { onclick: (e) => create(e.currentTarget) }, 'Create project');
  const kickoffRow = h('label.row', { style: { gap: '8px', cursor: 'pointer' } }, kickoff, h('span', 'Let the Brain set it up (PROJECT.md, teams and agents)'));
  const filesRow = h('div', h('div.label', 'Files'), h('div.col.mt', { style: { gap: '8px' } }, tray.el, h('div.row', { style: { gap: '8px' } }, tray.picker, h('span.hint', 'Briefs, docs, assets: drop or paste files or folders anywhere here. They go into the project folder and the Brain reads them.'))));
  const modes = () =>
    seg(
      [
        { value: 'new', label: 'New folder' },
        { value: 'existing', label: 'Existing folder' },
        { value: 'github', label: 'From GitHub' },
        { value: 'backup', label: 'From backup' },
      ],
      mode,
      (v) => {
        if (created) return void mount(modeBox, modes());
        mode = v;
        draw();
      },
    );
  const modeBox = h('div', modes());
  m = modal({
    title: 'New project',
    narrow: true,
    body: h(
      'div.col',
      h('p.hint', 'A project has its own agents, teams and chats, and a Brain: a folder with all its files and info.'),
      field('Name', name),
      field('What is this project?', about, 'The Brain reads this, looks at the folder and asks you what it needs to know.'),
      modeBox,
      extra,
      hint,
      filesRow,
      kickoffRow,
    ),
    foot: [h('button.btn.ghost', { onclick: () => m.close() }, 'Cancel'), createBtn],
    // closed after the project was made but before its files went: it is still open in the dashboard
    onClose: () => created && refreshSoon(0),
  });
  // Dropped files go to the tray, except a backup: in "From backup" anything dropped is taken as the
  // backup, and a lone .dashbackup dropped in another mode switches to "From backup".
  const modalEl = m.el.querySelector<HTMLElement>('.modal')!;
  let stopTrayDrop: (() => void) | null = null;
  syncDrop = () => {
    if (mode === 'backup') {
      stopTrayDrop?.();
      stopTrayDrop = null;
    } else stopTrayDrop ||= tray.dropZone(modalEl, 'Drop files or folders for the new project');
  };
  m.el.addEventListener('dragover', (e) => {
    if (mode !== 'backup' || !e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  m.el.addEventListener(
    'drop',
    (e) => {
      const files = e.dataTransfer?.files;
      const f = files?.[0];
      if (!f || (mode !== 'backup' && !(files.length === 1 && f.name.toLowerCase().endsWith(BACKUP_EXT)))) return;
      // before the tray sees it (it listens further down, on the dialog itself)
      e.preventDefault();
      e.stopPropagation();
      if (created) return;
      if (mode !== 'backup') {
        mode = 'backup';
        mount(modeBox, modes());
        draw();
      }
      void pickFile(f);
    },
    true,
  );
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
      h(`div.launch-ico${p.logoAt ? '.has-logo' : ''}`, projectMark(p, p.logoAt ? 40 : 20, p.repo ? 'git-branch' : 'folder-open')),
      h(
        'div.grow',
        h('div.launch-name', p.name, p.id === o.active ? h('span.pill.ok', 'last open') : null),
        p.description ? h('div.launch-desc', p.description.length > 120 ? `${p.description.slice(0, 120)}…` : p.description) : null,
        h('div.launch-meta', h('span', icon('bot', 12), plural(p.agents, 'agent')), h('span', icon('users', 12), plural(p.teams, 'team')), p.hasProjectMd ? h('span', icon('file-text', 12), 'PROJECT.md') : null, p.openedAt || p.createdAt ? h('span', icon('clock', 12), ago(p.openedAt || p.createdAt)) : null),
        h('div.launch-path', p.brainPath),
      ),
      icon('chevron-right', 18),
    );
  // the card, with rename / clone / delete beside it (they close this screen, do their thing, and bring it back with the new list)
  const row = (p: ProjectsOverview['projects'][number]) => {
    const again = async (action: (x: ProjectRef) => Promise<boolean>) => {
      m.close();
      await action(p);
      void openLauncher({ force: true });
    };
    const btn = (ico: string, title: string, action: (x: ProjectRef) => Promise<boolean>, danger = false) =>
      h(`button.launch-act${danger ? '.danger' : ''}`, { type: 'button', title: `${title} ${p.name}`, 'aria-label': `${title} ${p.name}`, onclick: () => void again(action) }, icon(ico, 14));
    return h('div.launch-row', card(p), h('div.launch-actions', btn('pencil', 'Rename', renameProject), btn('copy', 'Clone', cloneProject), btn('trash-2', 'Delete', deleteProject, true)));
  };
  m = modal({
    title: 'Open a project',
    onClose: done,
    body: h(
      'div.launcher',
      h('p.hint', 'Each project has its own agents, teams, chats and a Brain folder, and is auto-saved into that folder. Pick one to load it, open a folder you saved before, or start a new one.'),
      h('div.launch-list', o.projects.map(row)),
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
      h('button.btn.ghost', { onclick: () => (m.close(), openNewProject({ mode: 'backup' })) }, icon('upload', 15), ' Restore a backup…'),
      h('button.btn.ghost', { onclick: () => (m.close(), openNewProject({ mode: 'existing' })) }, icon('folder-open', 15), ' Open a folder…'),
      h('button.btn', { onclick: () => (m.close(), openNewProject()) }, icon('plus', 15), ' New project'),
    ],
  });
}
