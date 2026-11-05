// Development: edits to the page show at once (hot reload: Vite, scripts/vite-dev.ts), and the server restarts
// when its code changes.
//   bun run dev              (any server flags pass through: bun run dev --port 4900)
//   bun run dev --no-hot     the bundle only, rebuilt on change (reload the page yourself)
// The bundle in public/dist is rebuilt on change either way: the voxel worker, the fonts and the chats' stylesheet
// come from it, `bun run start` serves it, and its build catches code Bun can't bundle.
import fs from 'node:fs';
import path from 'node:path';
import { startVite } from './vite-dev.ts';
import type { DevServer } from './vite-dev.ts';

const root = path.resolve(import.meta.dirname, '..');
const hot = !process.argv.includes('--no-hot');
const serverArgs = process.argv.slice(2).filter((a) => a !== '--no-hot');
// Fresh checkout: build the page once first, so the server doesn't start a second build of its own.
if (!fs.existsSync(path.join(root, 'public', 'dist', 'app.js'))) {
  const first = Bun.spawn(['bun', 'scripts/build-web.ts'], { cwd: root, stdout: 'inherit', stderr: 'inherit' });
  if (await first.exited) process.exit(1);
}
const eve = Bun.spawn(['bun', 'scripts/build-eve.ts'], { cwd: root, stdout: 'inherit', stderr: 'inherit' });
if (await eve.exited) process.exit(1);
const web = Bun.spawn(['bun', 'scripts/build-web.ts', '--watch'], { cwd: root, stdout: 'inherit', stderr: 'inherit' });
let vite: DevServer | null = null;
if (hot) {
  try {
    vite = await startVite();
    console.log(`  Hot reload: ${vite.origin}`);
  } catch (e) {
    // the page still works from the bundle; it just won't update by itself
    console.error(`  Hot reload could not start (${e instanceof Error ? e.message : String(e)}). Reload the page to see changes.`);
  }
}
const server = Bun.spawn(['bun', '--watch', 'server/index.ts', '--no-open', ...serverArgs], {
  cwd: root,
  stdout: 'inherit',
  stderr: 'inherit',
  env: { ...process.env, ...(vite ? { DASH_VITE: vite.origin } : {}) },
});

// If one of them ends on its own, stop the others and pass on its exit code.
const stop = async (code = 0) => {
  web.kill();
  server.kill();
  await vite?.close().catch(() => {});
  process.exit(code);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
await stop(await Promise.race([web.exited, server.exited]));
