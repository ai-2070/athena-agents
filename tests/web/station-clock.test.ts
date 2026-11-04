// The Station's clock ticks just after each whole second, so it turns over with the computer's clock.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { everySecond, msToNextSecond } from '../../web/views/stationclock.ts';

describe('Station clock', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('waits until just past the next whole second', () => {
    expect(msToNextSecond(10_000)).toBe(1005);
    expect(msToNextSecond(10_400)).toBe(605);
    expect(msToNextSecond(10_999)).toBe(6);
  });

  it('ticks in the first moments of each new second, not part-way through', () => {
    vi.setSystemTime(20_400);
    const seen: number[] = [];
    const stop = everySecond(() => seen.push(Date.now()));
    vi.advanceTimersByTime(3000);
    stop();
    expect(seen).toEqual([21_005, 22_005, 23_005]);
  });

  it('stops when asked', () => {
    vi.setSystemTime(0);
    const tick = vi.fn();
    const stop = everySecond(tick);
    vi.advanceTimersByTime(1500);
    stop();
    vi.advanceTimersByTime(5000);
    expect(tick).toHaveBeenCalledTimes(1);
  });
});
