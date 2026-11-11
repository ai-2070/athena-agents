// Run against source output or the relocated desktop package with the same fault windows.
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const entry = process.argv[2] || path.join(root, 'runtime/eve/.output/server/index.mjs');
const executable = process.argv[3] || process.execPath;
const templates = process.argv[4] || path.join(root, 'runtime/eve/.eve/sandbox-cache');
for (const window of ['intent', 'event', 'cleanup', 'model']) {
  console.log(
    `eve recovery: crash ${window === 'intent' ? 'before saving the step' : window === 'event' ? 'before saving its event' : window === 'cleanup' ? 'before clearing the intent' : 'during a model call'}`,
  );
  const child = Bun.spawn(
    [
      process.execPath,
      path.join(root, 'scripts/eve-smoke.ts'),
      entry,
      executable,
      templates,
      '--interrupt-after-reply',
      `--checkpoint-window=${window}`,
    ],
    { stdout: 'inherit', stderr: 'inherit' },
  );
  if ((await child.exited) !== 0) throw new Error(`Eve did not recover the ${window} checkpoint window.`);
}
