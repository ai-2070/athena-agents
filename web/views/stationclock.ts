// The Station's clock turns over with the computer's clock. A plain one-second interval starts
// part-way through a second and drifts, so the seconds would change up to a second late.

// A few milliseconds past the boundary, so a timer that fires a touch early still lands in the new second
const SLACK = 5;

export const msToNextSecond = (now: number): number => 1000 - (now % 1000) + SLACK;

// Calls `tick` just after every whole second until the returned function is called
export function everySecond(tick: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const next = () => {
    timer = setTimeout(() => {
      if (stopped) return;
      tick();
      next();
    }, msToNextSecond(Date.now()));
  };
  next();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
