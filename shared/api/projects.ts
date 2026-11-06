// The projects' routes (server/api/projects.ts): the list, the start screen, making, opening, changing, copying,
// backing up and deleting a project, and its logo, background and 3D model. The files themselves (GET …/logo,
// …/background, …/model) are still sent by server/index.ts. The rules and their words stay in server/projects.ts.
import { oc, type } from '@orpc/contract';
import { z } from 'zod';
import type { BackupRestoreResult, BackupResult, FolderListing, Project, ProjectsOverview, ProjectWithMedia, RestoreResult, SaveStatus } from '../types.ts';

const oneProject = z.object({ id: z.string() });
const picture = oneProject.extend({ data: z.string({ error: 'Pick a PNG, JPG, WebP or GIF image.' }) });
const opacity = z.union([z.number(), z.string(), z.null()], { error: 'An opacity is a percent from 0 to 100.' }).optional();

/** A project's logo (the start screen, the project menu, inside the Brain), the picture behind the Station's map,
 *  and the 3D model that replaces the logo in the Brain's globe. data: a data: URL. */
const media = {
  setLogo: oc.route({ method: 'POST', path: '/projects/{id}/logo' }).input(picture).output(type<ProjectWithMedia>()),
  removeLogo: oc.route({ method: 'DELETE', path: '/projects/{id}/logo' }).input(oneProject).output(type<ProjectWithMedia>()),
  setBackground: oc.route({ method: 'POST', path: '/projects/{id}/background' }).input(picture).output(type<ProjectWithMedia>()),
  removeBackground: oc.route({ method: 'DELETE', path: '/projects/{id}/background' }).input(oneProject).output(type<ProjectWithMedia>()),
  setModel: oc.route({ method: 'POST', path: '/projects/{id}/model' })
    .input(oneProject.extend({ name: z.string({ error: 'Pick a 3D model file.' }), data: z.string({ error: "Couldn't read that file." }) }))
    .output(type<ProjectWithMedia>()),
  removeModel: oc.route({ method: 'DELETE', path: '/projects/{id}/model' }).input(oneProject).output(type<ProjectWithMedia>()),
};

export const projects = {
  /** Every project, in their order, the open one, and the folder new ones go in. */
  list: oc.route({ method: 'GET', path: '/projects' })
    .output(type<{ active: ProjectWithMedia; projects: ProjectWithMedia[]; root: string }>()),
  /** The order projects are listed in (the project menu, and Up / Down on the Station); ids not given keep theirs after. */
  reorder: oc.route({ method: 'POST', path: '/projects/order' })
    .input(z.object({ ids: z.array(z.string(), { error: 'ids must be a list.' }) }))
    .output(type<{ projects: ProjectWithMedia[] }>()),
  /** A new project: mode "new" (a fresh folder), "existing" (one you have) or "github" (a repo cloned into one).
   *  A folder the dashboard saved a project in brings its agents, teams and chats back (restored). */
  create: oc.route({ method: 'POST', path: '/projects' })
    .input(z.object({
      name: z.string({ error: 'Give the project a name.' }),
      mode: z.string().optional(),
      folder: z.string().optional(),
      repo: z.string().optional(),
      description: z.string().optional(),
    }))
    .output(type<Project & { restored: RestoreResult | null }>()),
  /** The start screen: every project, project folders not on the list yet, and whether to show it now. */
  overview: oc.route({ method: 'GET', path: '/projects/overview' })
    .output(type<ProjectsOverview & { showLauncher: boolean }>()),
  /** Saves the open project into its folder now. */
  save: oc.route({ method: 'POST', path: '/projects/save' }).output(type<SaveStatus | null>()),
  /** The start screen closed (picking the open project lands here too). */
  launcherDone: oc.route({ method: 'POST', path: '/projects/launcher-done' }).output(type<{ ok: true }>()),
  /** Opens a project: the page then shows it. */
  activate: oc.route({ method: 'POST', path: '/projects/{id}/activate' }).input(oneProject).output(type<Project>()),
  /** Renames it, or changes its description, skills, folder, the Station's opacities or what the sidebar shows.
   *  An opacity or sidebar of null goes back to the default. */
  change: oc.route({ method: 'PUT', path: '/projects/{id}' })
    .input(oneProject.extend({
      name: z.string({ error: 'Give the project a name.' }).optional(),
      description: z.string({ error: 'description must be text.' }).optional(),
      skills: z.array(z.string(), { error: 'skills must be a list.' }).optional(),
      brainPath: z.string({ error: 'brainPath must be a folder.' }).optional(),
      backgroundOpacity: opacity,
      mapDotsOpacity: opacity,
      sidebar: z.enum(['status', 'limits'], { error: 'The sidebar shows "status" or "limits".' }).nullable().optional(),
    }))
    .output(type<Project>()),
  /** One folder of a project (path from the project folder; '' for the project folder), as the Overview's Files panel lists it. */
  folder: oc.route({ method: 'GET', path: '/projects/{id}/folder' })
    .input(oneProject.extend({ path: z.string().optional() }))
    .output(type<FolderListing>()),
  /** Opens a folder of a project in VS Code (app: 'vscode', which says how it went) or the file manager. */
  open: oc.route({ method: 'POST', path: '/projects/{id}/open' })
    .input(oneProject.extend({ app: z.string().optional(), path: z.string().optional() }))
    .output(type<{ message?: string; ok?: true }>()),
  /** A backup of the project (its agents, chats and knowledge, plus every skill and preset) in the backups folder. */
  backup: oc.route({ method: 'POST', path: '/projects/{id}/backup' }).input(oneProject).output(type<BackupResult>()),
  /** A copy as a new project (schedules start paused). One at a time, like restoring a backup. */
  clone: oc.route({ method: 'POST', path: '/projects/{id}/clone' })
    .input(oneProject.extend({ name: z.string({ error: 'Give the copy a name.' }).optional() }))
    .output(type<ProjectWithMedia & { restored: BackupRestoreResult }>()),
  /** Takes the project off the list; its folder and files stay. The projects left. */
  remove: oc.route({ method: 'DELETE', path: '/projects/{id}' }).input(oneProject).output(type<Project[]>()),
  /** Backs the project up, checks the backup, then deletes it. Not while an agent works in it (409). */
  delete: oc.route({ method: 'POST', path: '/projects/{id}/delete' })
    .input(oneProject)
    .output(type<{ backup: BackupResult; setAside: string }>()),
  ...media,
};
