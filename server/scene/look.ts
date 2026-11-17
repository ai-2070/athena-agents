// What builders learn from the open Station tabs (docs/internal/plans/HTML_SCENE_PLAN.md §6a, §6b): a picture of the
// scene (scene_look), whether a version loads (scene_check), and what the scene logged (scene_logs). The server
// has no browser, so it asks the tabs: a 'scene-look' event, answered through rpc.scene.snapshot; load reports and
// logs come in through rpc.scene.loaded and rpc.scene.log.
import { bus, emit } from '../store.ts';
import { uid } from '../util.ts';
import type { SceneVersion, ServerEvent } from '../../shared/types.ts';

export const LOOK_WAIT_MS = 12_000;
const MAX_IMAGE = 6 * 1024 * 1024;
const LOGS_KEPT = 200;

/** How many pages are open (server/index.ts tells it); with none, nobody can answer, so don't wait. */
let openPages: () => number = () => 1;
export function setScenePages(count: () => number): void {
  openPages = count;
}
export const scenePagesOpen = (): number => openPages();

// ---------- pictures ----------
const looks = new Map<
  string,
  { done: (image: string | null, note?: string) => void; timer: ReturnType<typeof setTimeout>; refused: number }
>();

/** Asks the open tabs for a picture of the project's scene; a data: URL, or null with why. */
export function requestSceneLook(
  projectId: string,
  size: { width: number; height: number },
): Promise<{ image: string | null; note?: string; version?: string }> {
  if (!openPages()) return Promise.resolve({ image: null, note: 'No dashboard page is open to draw the scene.' });
  const request = uid('sl-');
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      looks.delete(request);
      resolve({ image: null, note: 'No open Station page answered in time (it may be showing another page).' });
    }, LOOK_WAIT_MS);
    timer.unref?.();
    looks.set(request, {
      timer,
      refused: 0,
      done: (image, note) => {
        clearTimeout(timer);
        looks.delete(request);
        const [version, text] = splitNote(note);
        resolve({ image, ...(text ? { note: text } : {}), ...(version ? { version } : {}) });
      },
    });
    emit('scene-look', { request, project: projectId, width: size.width, height: size.height });
  });
}
// (a tab's answer can say which version it drew: "version:<id>|words")
const splitNote = (note?: string): [string | undefined, string | undefined] => {
  const m = /^version:([\w-]+)\|?([\s\S]*)$/.exec(note || '');
  return m ? [m[1], m[2] || undefined] : [undefined, note];
};

/** A tab's answer: a picture, or why it can't (every tab answers; the first picture wins, and when every open
 *  page said it can't, the builder hears so at once). */
export function deliverSceneLook(request: string, look: { image?: string; error?: string; note?: string }): boolean {
  const w = looks.get(request);
  if (!w) return false;
  if (look.image && /^data:image\/(png|jpeg|webp);base64,/.test(look.image) && look.image.length <= MAX_IMAGE) {
    w.done(look.image, look.note);
    return true;
  }
  w.refused++;
  if (w.refused >= Math.max(1, openPages())) w.done(null, look.error || 'No open Station page shows this scene.');
  return true;
}

// ---------- waiting for a version to load ----------
const loadWaiters = new Set<{ project: string; version: string; done: () => void }>();
bus.on('event', (ev: ServerEvent) => {
  if (ev.type !== 'scene' || !ev.loads) return;
  for (const w of loadWaiters) if (w.project === ev.project && w.version === ev.version) w.done();
});

/** Resolves once a tab says how the version loaded, or after `ms` (false: nobody said). */
export function waitForLoad(projectId: string, version: SceneVersion, ms = LOOK_WAIT_MS): Promise<boolean> {
  if (version.loads) return Promise.resolve(true);
  if (!openPages()) return Promise.resolve(false);
  return new Promise((resolve) => {
    const w = {
      project: projectId,
      version: version.id,
      done: () => {
        clearTimeout(timer);
        loadWaiters.delete(w);
        resolve(true);
      },
    };
    const timer = setTimeout(() => {
      loadWaiters.delete(w);
      resolve(false);
    }, ms);
    timer.unref?.();
    loadWaiters.add(w);
  });
}

// ---------- logs ----------
export interface SceneLog {
  at: number;
  version: string;
  level: 'error' | 'warn' | 'info';
  text: string;
}
const logs = new Map<string, SceneLog[]>();
/** When a tab last showed the project's scene (it sends its logs, or nothing, every few seconds while it does). */
const seen = new Map<string, number>();

export function addSceneLogs(projectId: string, lines: SceneLog[]): void {
  seen.set(projectId, Date.now());
  if (!lines.length) return;
  const list = logs.get(projectId) || [];
  for (const l of lines.slice(-LOGS_KEPT))
    list.push({ at: l.at, version: l.version, level: l.level, text: String(l.text).slice(0, 2000) });
  if (list.length > LOGS_KEPT) list.splice(0, list.length - LOGS_KEPT);
  logs.set(projectId, list);
}
export const sceneLogLines = (projectId: string): SceneLog[] => [...(logs.get(projectId) || [])];
/** A tab showed this project's scene in the last half minute. */
export const sceneShownLately = (projectId: string): boolean => Date.now() - (seen.get(projectId) || 0) < 30_000;

/** Forgets everything (tests). */
export function forgetSceneLook(): void {
  for (const w of looks.values()) clearTimeout(w.timer);
  looks.clear();
  loadWaiters.clear();
  logs.clear();
  seen.clear();
}
