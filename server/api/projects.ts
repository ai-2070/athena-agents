// The projects' routes (shared/api/projects.ts). Changes to a project's pictures and opacities tell open tabs
// ('project-logo'), so the Station and the project menu draw them at once.
import { implement } from '@orpc/server';
import { projects as contract } from '../../shared/api/projects.ts';
import * as store from '../store.ts';
import * as projects from '../projects.ts';
import * as projectSync from '../projectsync.ts';
import * as backup from '../backup.ts';
import * as engines from '../engines/index.ts';
import * as programs from '../programs.ts';
import { enableOrcaSkill } from '../skills.ts';
import { openWithShell } from '../util.ts';
import { savedOpacity } from '../../shared/look.ts';
import { refuse } from './refuse.ts';
import type { Project, RestoreResult } from '../../shared/types.ts';

const os = implement(contract);

const projectOf = (id: string): Project => store.listProjects().find((p) => p.id === id) || refuse('That project is unavailable.', 404);
/** A change to a project's pictures, told to open tabs. */
const pictured = <T>(id: string, p: T): T => (store.emit('project-logo', { id }), p);

export const projectsRouter = os.router({
  list: os.list.handler(() => ({ active: projects.withLogo(store.activeProject()), projects: store.listProjects().map(projects.withLogo), root: projects.projectsRoot() })),
  reorder: os.reorder.handler(({ input }) => ({ projects: store.reorderProjects(input.ids).map(projects.withLogo) })),
  create: os.create.handler(async ({ input }) => {
    let p: Project & { restored?: RestoreResult | null } = await projects.createProject(input);
    // a folder saved by the dashboard before: load its agents, teams and chats
    const restored = projectSync.restoreInto(p.id, p.brainPath);
    if (restored && !p.description && restored.project.description) p = projects.updateProject(p.id, { description: restored.project.description });
    if (restored?.project.skills?.length) p = projects.updateProject(p.id, { skills: restored.project.skills });
    if (restored) p = projects.updateProject(p.id, savedOpacity(restored.project));
    if (restored) store.emit('project', { id: p.id });
    const made = { ...(enableOrcaSkill(p.id) || p), restored };
    projects.touch(made.id);
    projects.startScreenDone();
    return made;
  }),
  overview: os.overview.handler(() => ({ ...projects.overview(projectSync.peek), showLauncher: projects.startScreenPending() })),
  save: os.save.handler(() => projectSync.saveProject(store.activeProject().id)),
  launcherDone: os.launcherDone.handler(() => {
    projects.startScreenDone();
    enableOrcaSkill(store.activeProject().id);
    return { ok: true as const };
  }),
  activate: os.activate.handler(({ input: { id } }) => {
    const p = store.setActiveProject(id);
    enableOrcaSkill(id);
    projects.touch(id);
    projects.startScreenDone();
    store.log('project', `Switched to project "${p.name}"`);
    return p;
  }),
  change: os.change.handler(({ input: { id, ...patch } }) => {
    const p = projects.updateProject(id, patch);
    // the Station in other tabs draws the new opacity
    return 'backgroundOpacity' in patch || 'mapDotsOpacity' in patch ? pictured(id, p) : p;
  }),
  folder: os.folder.handler(({ input }) => projects.folderListing(input.path || '', projectOf(input.id))),
  open: os.open.handler(async ({ input }) => {
    const dir = projects.brainFolder(input.path, projectOf(input.id));
    if (input.app === 'vscode') return { message: await programs.launchProgram('vscode', { file: dir }) };
    openWithShell(dir);
    return { ok: true as const };
  }),
  backup: os.backup.handler(({ input }) => backup.createBackup(input.id)),
  clone: os.clone.handler(async ({ input }) => {
    const r = await backup.oneAtATime('Another project is being copied or restored. Try again when it is done.', () => backup.cloneProject(input.id, input.name));
    projects.touch(r.project.id);
    return { ...projects.withLogo(enableOrcaSkill(r.project.id) || r.project), restored: r.restored };
  }),
  remove: os.remove.handler(({ input }) => projects.removeProject(input.id)),
  // Backs it up, checks the backup, then removes it. Not while an agent is working in it.
  delete: os.delete.handler(({ input: { id } }) => {
    if (engines.activeRuns().some((run) => engines.runInfo(run.id)?.projectId === id)) return refuse('An agent is still working in this project. Stop it first, then delete the project.', 409);
    try {
      return backup.backupAndDeleteProject(id);
    } catch (e) {
      return refuse(e instanceof Error ? e.message : String(e), 400);
    }
  }),
  setLogo: os.setLogo.handler(({ input }) => pictured(input.id, projects.setLogo(input.id, input.data))),
  removeLogo: os.removeLogo.handler(({ input }) => pictured(input.id, projects.removeLogo(input.id))),
  setBackground: os.setBackground.handler(({ input }) => pictured(input.id, projects.setBackground(input.id, input.data))),
  removeBackground: os.removeBackground.handler(({ input }) => pictured(input.id, projects.removeBackground(input.id))),
  setModel: os.setModel.handler(({ input }) => pictured(input.id, projects.setModel(input.id, input.name, input.data))),
  removeModel: os.removeModel.handler(({ input }) => pictured(input.id, projects.removeModel(input.id))),
});
