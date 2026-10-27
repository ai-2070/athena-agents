// world_look: a picture of the world for a builder, so it can see what it built and fix it. The server has
// no renderer, so it asks the open Station tabs (a 'world-look' event); the first one to answer posts back a
// picture (POST /api/world/snapshot/:request). With no tab in the voxel look open, the builder gets words.
import { emit } from '../store.ts';
import { uid } from '../util.ts';
import type { WorldLookView } from '../../shared/types.ts';

export const LOOK_WAIT_MS = 12_000;
/** The biggest picture accepted from a tab (a data: URL). */
const MAX_IMAGE = 6 * 1024 * 1024;

/** How many pages are open (index.ts tells it); with none, nobody can answer, so don't wait. */
let openPages: () => number = () => 1;
export function setOpenPages(count: () => number): void {
  openPages = count;
}

const waiting = new Map<string, { done: (image: string | null, note?: string) => void; timer: ReturnType<typeof setTimeout> }>();

/** Asks the open tabs for a picture; resolves with a data: URL, or null when none answered in time. */
export function requestLook(worldId: string, project: string, view: WorldLookView, waitMs = LOOK_WAIT_MS): Promise<{ image: string | null; note?: string }> {
  const request = uid('look');
  if (!openPages()) return Promise.resolve({ image: null, note: 'no page is open' });
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiting.delete(request);
      resolve({ image: null, note: 'no open Station answered' });
    }, waitMs);
    timer.unref?.();
    waiting.set(request, { done: (image, note) => resolve({ image, note }), timer });
    emit('world-look', { request, world: worldId, project, view });
  });
}

/** A tab's answer: a picture, or why it couldn't make one. The first answer wins. */
export function deliverLook(request: string, body: { image?: unknown; error?: unknown }): boolean {
  const w = waiting.get(request);
  if (!w) return false;
  const image = typeof body.image === 'string' ? body.image : '';
  if (image && (image.length > MAX_IMAGE || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(image))) return false;
  // a tab that can't draw it (not in the voxel look) says so; wait for another unless it's the only answer
  if (!image) return false;
  clearTimeout(w.timer);
  waiting.delete(request);
  w.done(image);
  return true;
}
