// Stepping the voxel look down a quality level when this computer can't keep up: frames slower than
// about 30 a second for a few seconds in a row. Only down, and only for this visit (the setting stays).
import type { WorldQuality } from '../../shared/types.ts';

/** Average frame time (ms) above which the look is too heavy. */
export const SLOW_MS = 33;
/** How long it has to stay slow, ms (and how long to wait after a start or a change before judging). */
export const SLOW_FOR_MS = 4000;
/** Frames longer than this are a hidden tab or a pause, not slowness. */
const GAP_MS = 250;

export const lowerQuality = (q: WorldQuality): WorldQuality | null => (q === 'high' ? 'medium' : q === 'medium' ? 'low' : null);

/** Watches frame times; says when to step down. */
export class SlowWatch {
  private frames: number[] = [];
  private total = 0;
  private settled = 0;
  private done = false;
  private readonly quality: WorldQuality;

  constructor(quality: WorldQuality) {
    this.quality = quality;
  }

  /** One frame took `ms`. True (once) when the look should step down. */
  frame(ms: number): boolean {
    if (this.done || !lowerQuality(this.quality)) return false;
    if (ms > GAP_MS) {
      // a pause: start judging afresh
      this.frames = [];
      this.total = 0;
      return false;
    }
    // the first seconds compile shaders and load the world: don't judge them
    if (this.settled < SLOW_FOR_MS) {
      this.settled += ms;
      return false;
    }
    this.frames.push(ms);
    this.total += ms;
    while (this.total - this.frames[0] >= SLOW_FOR_MS) this.total -= this.frames.shift()!;
    if (this.total >= SLOW_FOR_MS && this.total / this.frames.length > SLOW_MS) {
      this.done = true;
      return true;
    }
    return false;
  }
}
