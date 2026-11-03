// Project switcher and the "New project" window. React now: the New project window and the start screen
// (openLauncher) are React inside Base UI dialogs (openModal); the project menu, the rename/clone/delete
// actions and the file tray keep their own modules.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { state, GET, POST, PUT, attempt, promptBox, toast, refreshSoon, ago } from './core.ts';
import { buttonClass } from './ui/classes.ts';
import { Field, Switch } from './ui/controls.tsx';
import { FileDrop, FormSection } from './ui/formsection.tsx';
import { Button, IconButton } from './ui/button.tsx';
import { Pill } from './ui/marks.tsx';
import { DomNode, Icon } from './ui/react.tsx';
import { openModal } from './ui/overlays.tsx';
import { mountProjectMenu } from './projectmenu.tsx';
import { projectMark } from './projectlogo.ts';
import { askBrain } from './dock.tsx';
import { BACKUP_EXT, backupProject, backupAgo, fileSize, listBackups, readBackupSummary, restoreBackup, restoredText, summaryLine } from './backup.tsx';
import type { BackupListing, BackupSummary } from './backup.tsx';
import { attachTray, PICKER_LABELLED } from './attach.tsx';
import type { AttachTray } from './attach.tsx';
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
  if (!(await askDeleteProject(p.name))) return false;
  const r = await attempt(() => POST<{ backup: { name: string } }>(`/projects/${encodeURIComponent(p.id)}/delete`), (x) => `Deleted ${p.name}. Backup: ${x.backup.name}`);
  refreshSoon(0);
  return !!r;
}

/** "Delete the project …?" with the note about the backup and what stays on the PC. */
function askDeleteProject(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    openModal(
      'Are you sure?',
      (close) => (
        <>
          <div className="modal-body">
            <div className="text-[14px] leading-[1.65] text-ink [&_p]:mb-3 [&_p:last-child]:mb-0">
              <p>{`Delete the project "${name}"?`}</p>
              <p className="hint">First a backup is made in Athena Agents Backups and checked. Only if it is complete is the project removed: its agents, teams, chats and settings leave the dashboard (set aside on this PC, not erased). The project's own folder and files are not touched.</p>
            </div>
          </div>
          <div className="modal-foot">
            <Button variant="ghost" onClick={() => (resolve(false), close())}>
              Cancel
            </Button>
            <Button variant="danger" onClick={() => (resolve(true), close())}>
              Back up and delete
            </Button>
          </div>
        </>
      ),
      { narrow: true, onClose: () => resolve(false) },
    );
  });
}

let closeProjectMenu: (() => void) | null = null;

export function openProjectMenu(anchor: Element): void {
  closeProjectMenu?.();
  const d = state.data!;
  closeProjectMenu = mountProjectMenu({
    anchor,
    projects: d.projects || [],
    active: d.project,
    actions: [
      { label: 'All projects…', icon: 'folder-open', separator: true, run: () => openLauncher({ force: true }) },
      { label: 'New project', icon: 'plus', run: () => openNewProject() },
      { label: 'Clone this project…', icon: 'copy', run: () => cloneProject(d.project) },
      { label: 'Voxel world…', icon: 'globe', run: () => import('./views/worldpanel.tsx').then((m) => m.openWorldPicker()) },
      { label: 'Back up this project', icon: 'archive', separator: true, run: () => backupProject(d.project) },
      { label: 'Restore a backup…', icon: 'upload', run: () => openNewProject({ mode: 'backup' }) },
      { label: 'Delete this project…', icon: 'trash-2', danger: true, separator: true, run: () => deleteProject(d.project) },
    ],
  });
}

// Backup: the drop zone (over: a file is dragged onto it), empty or showing the picked backup
const DROP_EMPTY =
  'flex min-h-[132px] cursor-pointer flex-col items-center justify-center gap-1.5 rounded-[12px] border-[1.5px] border-dashed border-line-2 bg-panel-2/70 p-4.5 text-center text-dim [transition:border-color_0.18s,background_0.18s,color_0.18s] hover:border-line-2 hover:bg-panel-2 hover:text-ink focus-visible:border-accent focus-visible:text-ink focus-visible:outline-none [&.over]:border-solid [&.over]:border-accent [&.over]:bg-[color-mix(in_srgb,var(--color-accent)_9%,var(--color-panel))] [&.over]:text-ink';
const DROP_HAS =
  'flex min-h-0 cursor-pointer flex-row items-start justify-start gap-3.5 rounded-[12px] border-[1.5px] border-solid border-[color-mix(in_srgb,var(--color-accent)_45%,var(--color-line))] bg-panel-2/70 p-4.5 text-left text-dim [transition:border-color_0.18s,background_0.18s,color_0.18s] hover:text-ink focus-visible:text-ink focus-visible:outline-none [&.over]:bg-[color-mix(in_srgb,var(--color-accent)_9%,var(--color-panel))] [&.over]:text-ink';
const DROP_ICO = 'grid h-11 w-11 flex-none place-items-center rounded-box bg-accent/10 text-accent';
const DROP_TITLE = 'text-[15px] font-semibold text-ink';
const DROP_META = 'mt-0.75 text-[12.5px] wrap-anywhere text-dim';
const BACKUP_ITEM =
  'flex w-full cursor-pointer items-center gap-3 rounded-[9px] border border-line bg-transparent px-3 py-2.5 text-left text-ink [transition:border-color_0.15s,background_0.15s] hover:bg-panel-2 focus-visible:border-accent focus-visible:bg-panel-2 focus-visible:outline-none [&>svg]:flex-none [&>svg]:text-dim';
const ITEM_META = 'text-[12px] whitespace-nowrap text-faint';

// the four ways into a project: tiles at the top of the window, since the choice decides the fields under them
const MODES: readonly { value: NewProjectMode; icon: string; label: string; sub: string }[] = [
  { value: 'new', icon: 'folder-plus', label: 'New folder', sub: 'Start empty' },
  { value: 'existing', icon: 'folder-open', label: 'Existing folder', sub: 'A folder you have' },
  { value: 'github', icon: 'github-logo', label: 'GitHub', sub: 'Clone a repo' },
  { value: 'backup', icon: 'archive-restore', label: 'Backup', sub: 'Bring one back' },
];
const MODE_TILE =
  'flex min-w-0 cursor-pointer flex-col items-start gap-2.5 rounded-box border border-line bg-panel/60 p-3 text-left [transition:border-color_0.15s,background-color_0.15s,box-shadow_0.15s] hover:border-line-2 hover:bg-panel-2 disabled:cursor-default disabled:opacity-60 aria-checked:border-accent aria-checked:bg-accent/8 aria-checked:shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-accent)_14%,transparent)]';
const MODE_ICON = 'grid size-8 place-items-center rounded-[9px] border border-line bg-panel-2 text-dim [[aria-checked=true]_&]:border-accent/40 [[aria-checked=true]_&]:bg-accent/12 [[aria-checked=true]_&]:text-accent';
const NAME_PLACEHOLDER = 'e.g. Bakery website, Podcast launch, Trip to Japan';
const ABOUT_PLACEHOLDER =
  'What you want to make and who it is for. e.g. "A simple website for my bakery: the menu, opening hours and a few photos, so people nearby can find us."';

/** A picked backup: a dropped file, or one from the backups folder. */
type PickSrc = { file: File } | { listed: string };

interface NewProjectProps {
  info: { root: string };
  startMode: NewProjectMode;
  onDone?: (p: CreatedProject) => unknown;
  close: () => void;
  /** Set once the project exists (its files may still fail); read after the window closes. */
  made: { current: CreatedProject | null };
  tray: AttachTray;
}

function NewProjectWindow({ info, startMode, onDone, close, made, tray }: NewProjectProps) {
  const sep = info.root.includes('\\') ? '\\' : '/';
  const [mode, setMode] = useState<NewProjectMode>(startMode);
  const [name, setName] = useState('');
  const [folder, setFolder] = useState('');
  const [repo, setRepo] = useState('');
  const [about, setAbout] = useState('');
  const [kickoff, setKickoff] = useState(true);
  const [pick, setPick] = useState<{ src: PickSrc; summary: BackupSummary | null; label: string } | null>(null);
  const [backups, setBackups] = useState<BackupListing[] | null>(null);
  const [created, setCreated] = useState<CreatedProject | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  // what the user typed keeps its place: the folder is only suggested while it is untouched
  const touchedFolder = useRef(false);
  const touchedName = useRef(false);
  const touchedAbout = useRef(false);
  const box = useRef<HTMLDivElement>(null);
  const nameIn = useRef<HTMLInputElement>(null);
  const chooser = useRef<HTMLInputElement>(null);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const loadedBackups = useRef(false);
  const stopTrayDrop = useRef<(() => void) | null>(null);

  // a blank name falls back to the repo's name (GitHub only); otherwise the server asks for one
  const repoName = () => (mode === 'github' && repo.trim().split('/').pop()?.replace(/\.git$/, '')) || '';

  const usePicked = (src: PickSrc, sum: BackupSummary | null, label: string) => {
    setPick({ src, summary: sum, label });
    // the backup's name and description, unless you typed your own
    if (sum && !touchedName.current) setName(sum.name);
    if (sum && !touchedAbout.current) setAbout(sum.description);
  };

  const pickFile = async (f: File) => {
    const sum = await readBackupSummary(f).catch(() => null);
    if (!sum) return toast(`${f.name} isn't a dashboard backup (a ${BACKUP_EXT} file).`, 'error');
    usePicked({ file: f }, sum, `${f.name} · ${fileSize(f.size)}`);
  };
  const pickFileNow = useRef(pickFile);
  pickFileNow.current = pickFile;

  // the folder follows the name and the repo, until you type one of your own
  useEffect(() => {
    if (touchedFolder.current) return;
    if (mode === 'existing' || mode === 'backup') return void setFolder('');
    setFolder(info.root ? `${info.root}${sep}${slug(name || repo.split('/').pop())}` : '');
  }, [info.root, mode, name, repo, sep]);

  // the backups folder is read the first time the window shows "Backup"
  useEffect(() => {
    if (mode !== 'backup' || loadedBackups.current) return;
    loadedBackups.current = true;
    setBackups([]);
    void listBackups().then((r) => setBackups(r.backups)).catch(() => {});
  }, [mode]);

  // in every mode but "Backup" the tray takes dropped files anywhere on the window
  useEffect(() => {
    if (mode === 'backup') {
      stopTrayDrop.current?.();
      stopTrayDrop.current = null;
      return;
    }
    if (stopTrayDrop.current) return;
    const modalEl = box.current?.closest<HTMLElement>('.modal');
    if (modalEl) stopTrayDrop.current = tray.dropZone(modalEl, 'Drop files or folders for the new project');
  }, [mode, tray]);
  useEffect(() => () => stopTrayDrop.current?.(), []);

  // A backup dropped on the window is taken as the backup, before the tray sees it (it listens further
  // down, on the dialog itself). A lone .dashbackup dropped in another mode switches to "Backup".
  useEffect(() => {
    const back = box.current?.closest<HTMLElement>('.modal-back');
    if (!back) return;
    const over_ = (e: DragEvent) => {
      if (modeRef.current !== 'backup' || !e.dataTransfer?.types.includes('Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    };
    const drop = (e: DragEvent) => {
      const list = e.dataTransfer?.files;
      if (!list || !list[0]) return;
      const f = list[0];
      if (modeRef.current !== 'backup' && !(list.length === 1 && f.name.toLowerCase().endsWith(BACKUP_EXT))) return;
      e.preventDefault();
      e.stopPropagation();
      if (made.current) return;
      if (modeRef.current !== 'backup') setMode('backup');
      setOver(false);
      void pickFileNow.current(f);
    };
    back.addEventListener('dragover', over_);
    back.addEventListener('drop', drop, true);
    return () => {
      back.removeEventListener('dragover', over_);
      back.removeEventListener('drop', drop, true);
    };
  }, [made]);

  useEffect(() => {
    const t = setTimeout(() => nameIn.current?.focus(), 30);
    return () => clearTimeout(t);
  }, []);

  const markCreated = (p: CreatedProject) => {
    made.current = p;
    setCreated(p);
  };

  const restore = async () => {
    if (!pick) return toast('Drop a backup file first.', 'error');
    setBusy('Restoring…');
    const p = await attempt(() => restoreBackup(pick.src, { name: name.trim(), folder: touchedFolder.current ? folder.trim() : '', description: about.trim() }));
    setBusy(null);
    if (!p) return;
    close();
    toast(restoredText(p.name, p.restored), p.restored.paused ? 'warn' : 'info', 8000);
    await refreshSoon(0);
    onDone?.(p);
  };

  const create = async () => {
    if (mode === 'backup') return restore();
    setBusy(created ? 'Uploading files…' : mode === 'github' ? 'Cloning…' : 'Creating…');
    const p = created || (await attempt(() => POST<CreatedProject>('/projects', { name: name.trim() || repoName(), mode, folder: folder.trim(), repo: repo.trim(), description: about.trim() })));
    if (!p) {
      setBusy(null);
      return;
    }
    // the project exists now: only its files can still change
    if (!created) markCreated(p);
    // the new project is the active one now, so the files land in its folder (uploads/), shown here while they go
    let files: string[] = [];
    if (tray.count()) {
      setBusy('Uploading files…');
      const up = await tray.ready();
      if (!up) {
        // stay open: try again, or remove the ones that failed and go on
        setBusy(null);
        return;
      }
      files = up;
    }
    close();
    toast(p.restored ? `Loaded "${p.name}": ${p.restored.agents} agents and ${p.restored.teams} teams from the folder` : `Project "${p.name}" is open`);
    if (files.length && !kickoff) toast(`Added ${files.length} file${files.length === 1 ? '' : 's'} to the project folder (uploads/)`);
    await refreshSoon(0);
    onDone?.(p);
    // the Brain studies the new project, asks what it needs, then writes PROJECT.md and sets up teams
    if (kickoff)
      setTimeout(
        () =>
          void askBrain(
            `I just created the project "${p.name}".${about.trim() ? ` What it is: ${about.trim()}` : ''}${files.length ? ' I attached files for it: study them too.' : ''}\nLook at the project folder and help me set it up: ask me what you need to know first, then write PROJECT.md and create the teams and agents it needs.`,
            files,
          ),
        600,
      );
  };

  const disabled = !!created;
  const restoreMode = mode === 'backup';
  const hintText = restoreMode
    ? 'Brings back its agents, teams, routines, chats, knowledge files and notes, and adds its skills and saved presets to your library (yours stay as they are).'
    : (mode === 'new' ? 'Starts with a BRAIN.md and a notes folder.' : mode === 'existing' ? 'If the dashboard saved this folder before, its agents, teams and chats load back in.' : 'Agents work right inside the repo, so they see its code, README and CLAUDE.md.') +
      ' Everything is auto-saved into the folder (.dashboard).';
  const folderHint = mode === 'existing' ? 'The project Brain is this folder: agents read it and work in it.' : restoreMode ? 'Leave empty for a new folder. In a folder you already have, files there are never overwritten.' : 'A new folder for the project: its files, notes and what the agents make.';
  const folderPlaceholder = restoreMode ? (info.root ? `A new folder in ${info.root}` : 'Folder path') : info.root ? `${info.root}${sep}…` : 'Folder path';
  const label = busy ?? (restoreMode ? 'Restore project' : created ? 'Try the files again' : 'Create project');

  return (
    <>
      <div className="modal-body">
        <div ref={box} className="flex flex-col gap-6">
          <FormSection icon="layers" title="Start from" hint="A project has its own agents, teams and chats, and a Brain: a folder with all its files and notes.">
            <div role="radiogroup" aria-label="New project from" className="grid grid-cols-4 gap-2 max-sm:grid-cols-2">
              {MODES.map((m) => (
                <button key={m.value} type="button" role="radio" aria-checked={mode === m.value} disabled={disabled && mode !== m.value} className={MODE_TILE} onClick={() => !created && setMode(m.value)}>
                  <span className={MODE_ICON}><Icon name={m.icon} size={16} /></span>
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-[13px] font-semibold text-ink">{m.label}</span>
                    <span className="truncate text-[11.5px] text-faint">{m.sub}</span>
                  </span>
                </button>
              ))}
            </div>
          </FormSection>
          <FormSection icon="pen-line" title="About it">
            <Field label="Name">
              <input
                ref={nameIn}
                placeholder={repoName() || NAME_PLACEHOLDER}
                value={name}
                disabled={disabled}
                onChange={(e) => {
                  touchedName.current = true;
                  setName(e.currentTarget.value);
                }}
              />
            </Field>
            <Field label="What is this project?" hint="The Brain reads this, looks at the folder and asks you what it needs to know.">
              <textarea
                rows={3}
                placeholder={ABOUT_PLACEHOLDER}
                value={about}
                disabled={disabled}
                onChange={(e) => {
                  touchedAbout.current = true;
                  setAbout(e.currentTarget.value);
                }}
              />
            </Field>
          </FormSection>
          <FormSection icon={restoreMode ? 'archive' : mode === 'github' ? 'github-logo' : 'folder'} title={restoreMode ? 'The backup' : mode === 'github' ? 'The repo' : 'The folder'} hint={hintText}>
            {restoreMode ? (
                <>
                  <div
                    className={`${pick ? DROP_HAS : DROP_EMPTY} ${over ? 'over' : ''}`.trim()}
                    role="button"
                    tabIndex={0}
                    aria-label="Choose a backup file"
                    onClick={() => chooser.current?.click()}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        chooser.current?.click();
                      }
                    }}
                    onDragEnter={() => setOver(true)}
                    onDragLeave={(e) => {
                      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
                    }}
                    onDrop={() => setOver(false)}
                  >
                    {pick && pick.summary ? (
                      <>
                        <div className={DROP_ICO}>
                          <Icon name="archive" size={22} />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className={DROP_TITLE}>{pick.summary.name || 'Backup'}</div>
                          <div className={DROP_META}>{summaryLine(pick.summary)}</div>
                          {pick.summary.agentList.length ? (
                            <div className="mt-1.5 flex flex-wrap gap-x-2.5 gap-y-1 text-[12px] text-ink">
                              {pick.summary.agentList.map((a) => (
                                <span key={a.name} title={a.name}>{`${a.emoji} ${a.name}`}</span>
                              ))}
                            </div>
                          ) : null}
                          <div className={DROP_META}>{`Backed up ${ago(pick.summary.createdAt)} · ${pick.label}`}</div>
                        </div>
                        <span className={buttonClass('ghost', 'tiny')}>Change</span>
                      </>
                    ) : (
                      <>
                        <div className={DROP_ICO}>
                          <Icon name="upload" size={24} />
                        </div>
                        <div className={DROP_TITLE}>Drop a backup here</div>
                        <div className="hint">{`or click to choose a ${BACKUP_EXT} file`}</div>
                      </>
                    )}
                  </div>
                  <input ref={chooser} type="file" accept={BACKUP_EXT} style={{ display: 'none' }} onChange={(e) => {
                    const f = e.currentTarget.files?.[0];
                    e.currentTarget.value = '';
                    if (f) void pickFile(f);
                  }} />
                  {!pick && backups?.length ? (
                    <div className="flex flex-col gap-2">
                      <div className="label">In your backups folder</div>
                      <div className="flex max-h-[210px] flex-col gap-2 overflow-y-auto p-px">
                        {backups.slice(0, 6).map((b) => (
                          <button key={b.name} type="button" className={BACKUP_ITEM} onClick={() => usePicked({ listed: b.name }, b.summary, `${b.name} · ${fileSize(b.size)}`)}>
                            <Icon name="archive" size={15} />
                            <span className="flex min-w-0 flex-1 flex-col">
                              <span className="truncate text-[13.5px] font-semibold">{b.summary?.name || b.name}</span>
                              {b.summary ? <span className={ITEM_META}>{summaryLine(b.summary)}</span> : null}
                            </span>
                            <span className={ITEM_META}>{backupAgo(b.summary, b.modifiedAt)}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </>
            ) : mode === 'github' ? (
              <Field label="GitHub repo" hint="Cloned with your GitHub login (gh) so private repos work too.">
                <input
                  className="code"
                  placeholder="owner/repo or https://github.com/owner/repo"
                  value={repo}
                  disabled={disabled}
                  onChange={(e) => setRepo(e.currentTarget.value)}
                />
              </Field>
            ) : null}
            <Field label={mode === 'existing' ? 'Your folder' : restoreMode ? 'Restore into' : 'Brain folder'} hint={folderHint}>
              <input
                className="code"
                placeholder={folderPlaceholder}
                value={folder}
                disabled={disabled}
                onChange={(e) => {
                  touchedFolder.current = true;
                  setFolder(e.currentTarget.value);
                }}
              />
            </Field>
          </FormSection>
          {/* (hidden, not taken away, for a backup: the tray keeps its picker and what was added) */}
          <FormSection icon="paperclip" title="Files" hint="Optional. They go into the project folder and the Brain reads them." className={restoreMode ? 'hidden' : ''}>
              <FileDrop picker={<DomNode as="span" make={() => tray.picker} deps={[]} />} hint="Briefs, docs, assets. Or drop or paste them anywhere in this window.">
                <DomNode className="dom-contents" make={() => tray.el} deps={[]} />
              </FileDrop>
          </FormSection>
          <Switch checked={kickoff} onChange={setKickoff} className={`flex-nowrap! items-start! gap-3.5! rounded-box border border-line bg-panel-2/40 px-4 py-3.5 [&_.switch]:mt-0.5 [&_.switch]:flex-none ${restoreMode ? 'hidden!' : ''}`}>
              <span className="block text-[13.5px] font-medium text-ink">Let the Brain set it up</span>
              <span className="mt-0.5 block text-[12.5px] leading-normal text-dim">It writes PROJECT.md and suggests the teams and agents to start with.</span>
          </Switch>
        </div>
      </div>
      <div className="modal-foot">
        <Button variant="ghost" onClick={close}>
          Cancel
        </Button>
        <Button disabled={busy !== null || (restoreMode && !pick)} onClick={() => void create()}>
          {label}
        </Button>
      </div>
    </>
  );
}

export async function openNewProject({ mode: startMode = 'new', onDone }: { mode?: NewProjectMode; onDone?: (p: CreatedProject) => unknown } = {}): Promise<void> {
  const info = await GET<ProjectList>('/projects').catch(() => ({ root: '' }));
  const made: { current: CreatedProject | null } = { current: null };
  const tray = attachTray({ deferred: true, pickerButton: PICKER_LABELLED });
  const dlg = openModal('New project', (close) => <NewProjectWindow info={info} startMode={startMode} onDone={onDone} close={close} made={made} tray={tray} />, {
    medium: true,
    // closed after the project was made but before its files went: it is still open in the dashboard
    onClose: () => {
      if (made.current) refreshSoon(0);
    },
  });
  dlg.el.classList.add('glass');
}

// The start screen's project cards. They rise in one after another (the first few, a little apart).
// the launcher: projects as rows on one surface, split by hairlines (not a stack of cards)
const L_LIST = 'flex flex-col divide-y divide-line overflow-hidden rounded-box border border-line bg-panel';
const L_ROW =
  'relative flex w-full cursor-pointer items-center gap-3.5 px-4 py-3 text-left text-ink [transition:background-color_0.15s] hover:bg-panel-2 focus-visible:bg-panel-2 focus-visible:outline-none';
// the project open now: a short accent bar at its left edge
const L_ROW_CUR = 'before:absolute before:inset-y-3 before:left-0 before:w-[3px] before:rounded-r-full before:bg-accent';
const L_RISE = [
  'animate-[rise-in_0.25s_var(--ease-soft)_both]',
  'animate-[rise-in_0.25s_var(--ease-soft)_0.03s_both]',
  'animate-[rise-in_0.25s_var(--ease-soft)_0.06s_both]',
  'animate-[rise-in_0.25s_var(--ease-soft)_0.09s_both]',
  'animate-[rise-in_0.25s_var(--ease-soft)_0.12s_both]',
];
const L_ICO = 'grid size-10 flex-none place-items-center rounded-[10px] border border-line bg-panel-2 text-dim';
const L_ICO_CUR = 'grid size-10 flex-none place-items-center rounded-[10px] border border-accent/30 bg-accent/10 text-accent';
const L_ICO_LOGO = 'grid size-10 flex-none place-items-center overflow-hidden rounded-[10px] bg-ink/5 [&_.proj-logo]:rounded-[8px]';
const L_NAME = 'flex min-w-0 items-center gap-2 text-[14px] font-semibold';
const L_META = 'mt-1 flex min-w-0 items-center gap-x-3 text-[12px] text-dim *:inline-flex *:flex-none *:items-center *:gap-1';
const L_PATH = 'min-w-0 flex-1! truncate font-mono text-[11px] text-faint';
const L_HEAD = 'flex items-baseline justify-between gap-3 px-1 text-[12.5px] font-medium text-dim';

/** A project's logo or its folder / GitHub mark, drawn by the plain-DOM projectMark(). */
function Mark({ project, size, fallback }: { project: Project; size: number; fallback: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) el.replaceChildren(projectMark(project, size, fallback));
  }, [project, size, fallback]);
  return <span ref={ref} className="contents" />;
}

const launcherDone = () => POST('/projects/launcher-done').catch(() => {});

function LauncherWindow({ o, close }: { o: ProjectsOverview; close: () => void }) {
  const [query, setQuery] = useState('');
  const open = async (p: ProjectsOverview['projects'][number]) => {
    if (p.id !== o.active) {
      const r = await attempt(() => POST(`/projects/${p.id}/activate`), `Opened ${p.name}`);
      if (!r) return;
    } else void launcherDone();
    close();
    refreshSoon(0);
  };
  const addFound = async (f: ProjectsOverview['found'][number]) => {
    const p = await attempt(() => POST<CreatedProject>('/projects', { name: f.name, mode: 'existing', folder: f.folder }), (r) => (r.restored ? `Loaded ${f.name}: ${r.restored.agents} agents, ${r.restored.teams} teams` : `Added ${f.name}`));
    if (!p) return;
    close();
    refreshSoon(0);
  };
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  // a search box once there are enough to look through
  const q = query.trim().toLowerCase();
  const fits = (...words: (string | undefined)[]) => !q || words.join(' ').toLowerCase().includes(q);
  const projects = o.projects.filter((p) => fits(p.name, p.description, p.brainPath));
  const found = o.found.filter((f) => fits(f.name, f.folder));
  const searchable = o.projects.length + o.found.length > 5;

  // one project: its mark, name, what is in it, where it is; rename / clone / delete show when you point at it
  const row = (p: ProjectsOverview['projects'][number], i: number) => {
    const cur = p.id === o.active;
    const again = async (action: (x: ProjectRef) => Promise<boolean>) => {
      close();
      await action(p);
      void openLauncher({ force: true });
    };
    const act = (ico: string, title: string, action: (x: ProjectRef) => Promise<boolean>, danger = false) => (
      <IconButton
        variant="inset"
        type="button"
        className={danger ? 'hover:border-red hover:text-red' : ''}
        title={`${title} ${p.name}`}
        aria-label={`${title} ${p.name}`}
        onClick={() => void again(action)}
      >
        <Icon name={ico} size={14} />
      </IconButton>
    );
    return (
      <div key={p.id} className={`group relative ${L_RISE[i] ?? L_RISE[4]}`}>
        <button className={`${L_ROW} ${cur ? L_ROW_CUR : ''}`} type="button" onClick={() => void open(p)}>
          <div className={p.logoAt ? L_ICO_LOGO : cur ? L_ICO_CUR : L_ICO}>
            <Mark project={p} size={p.logoAt ? 40 : 18} fallback={p.repo ? 'git-branch' : 'folder-open'} />
          </div>
          <div className="min-w-0 flex-1">
            <div className={L_NAME}>
              <span className="truncate">{p.name}</span>
              {cur ? <Pill tone="ok">last open</Pill> : null}
            </div>
            {p.description ? <div className="mt-0.5 truncate text-[12.5px] text-dim">{p.description}</div> : null}
            <div className={L_META}>
              <span><Icon name="bot" size={12} />{plural(p.agents, 'agent')}</span>
              <span><Icon name="users" size={12} />{plural(p.teams, 'team')}</span>
              {p.openedAt || p.createdAt ? <span><Icon name="clock" size={12} />{ago(p.openedAt || p.createdAt)}</span> : null}
              <span className={L_PATH} title={p.brainPath}>{p.brainPath}</span>
            </div>
          </div>
          <Icon name="chevron-right" size={16} className="flex-none text-faint" />
        </button>
        <div className="absolute top-1/2 right-10 flex -translate-y-1/2 gap-1 rounded-ctl bg-panel-2 pl-2 opacity-0 [transition:opacity_0.15s] group-hover:opacity-100 focus-within:opacity-100">
          {act('pencil', 'Rename', renameProject)}
          {act('copy', 'Clone', cloneProject)}
          {act('trash-2', 'Delete', deleteProject, true)}
        </div>
      </div>
    );
  };
  return (
    <>
      <div className="modal-body">
        <div className="launcher flex min-w-[min(620px,86vw)] flex-col gap-5">
          <div className="flex flex-wrap items-center gap-3">
            <p className="m-0 min-w-0 flex-1 basis-64 text-[13px] leading-normal text-dim">Pick a project to load it. Each one keeps its own agents, teams and chats, saved into its folder.</p>
            {searchable ? (
              <label className="relative w-56 max-sm:w-full">
                <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint"><Icon name="search" size={14} /></span>
                <input className="pl-8.5!" aria-label="Find a project" placeholder="Find a project" value={query} onChange={(e) => setQuery(e.currentTarget.value)} />
              </label>
            ) : null}
          </div>
          <div className="flex flex-col gap-2">
            <div className={L_HEAD}><span>Your projects</span><span className="text-faint tabular-nums">{o.projects.length}</span></div>
            {projects.length ? <div className={L_LIST}>{projects.map(row)}</div> : <p className="empty m-0 py-6!">No project matches.</p>}
          </div>
          {o.found.length ? (
            <div className="flex flex-col gap-2">
              <div className={L_HEAD}><span>Found on this PC</span><span className="font-normal text-faint">folders with saved agents and teams</span></div>
              {found.length ? (
                <div className={L_LIST}>
                  {found.map((f, i) => (
                    <button key={f.folder} className={`${L_ROW} ${L_RISE[i] ?? L_RISE[4]}`} type="button" onClick={() => void addFound(f)}>
                      <div className={`${L_ICO} border-dashed`}>
                        <Icon name="folder" size={18} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className={L_NAME}><span className="truncate">{f.name}</span></div>
                        <div className={L_META}>
                          {f.saved ? (
                            <>
                              <span><Icon name="bot" size={12} />{plural(f.saved.agents, 'agent')}</span>
                              <span><Icon name="users" size={12} />{plural(f.saved.teams, 'team')}</span>
                              <span><Icon name="clock" size={12} />{`saved ${ago(f.saved.savedAt)}`}</span>
                            </>
                          ) : null}
                          <span className={L_PATH} title={f.folder}>{f.folder}</span>
                        </div>
                      </div>
                      <span className={buttonClass('ghost', 'tiny', 'flex-none')}><Icon name="plus" size={12} />Add</span>
                    </button>
                  ))}
                </div>
              ) : <p className="empty m-0 py-6!">No folder matches.</p>}
            </div>
          ) : null}
        </div>
      </div>
      <div className="modal-foot">
        <Button variant="ghost" onClick={() => (close(), void openNewProject({ mode: 'backup' }))}>
          <Icon name="upload" size={15} /> Restore a backup…
        </Button>
        <Button variant="ghost" onClick={() => (close(), void openNewProject({ mode: 'existing' }))}>
          <Icon name="folder-open" size={15} /> Open a folder…
        </Button>
        <Button onClick={() => (close(), void openNewProject())}>
          <Icon name="plus" size={15} /> New project
        </Button>
      </div>
    </>
  );
}

// The start screen: pick a project you already have (with its agents and teams), add a project
// folder found on this PC, or create a new one. Shown once each time the dashboard starts.
export async function openLauncher({ force = false }: { force?: boolean } = {}): Promise<void> {
  const o = await GET<ProjectsOverview>('/projects/overview').catch(() => null);
  if (!o || (!force && !o.showLauncher)) return;
  if (document.querySelector('.launcher')) return;
  openModal('Open a project', (close) => <LauncherWindow o={o} close={close} />, { onClose: launcherDone });
}
