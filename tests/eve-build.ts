import { spawnSync } from 'node:child_process';

/** Node tests exercise the shipped Bun worker against their own temporary providers. */
export default function setup() {
  const built = spawnSync('bun', ['scripts/build-eve.ts'], { stdio: 'pipe', encoding: 'utf8', windowsHide: true });
  if (built.status !== 0) {
    const message = `The test Eve runtime could not build.\n${built.error || ''}\n${built.stderr}\n${built.stdout}`;
    console.error(message);
    throw new Error(message);
  }
}
