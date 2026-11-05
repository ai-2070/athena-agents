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
// the server's port, read the way server/index.ts reads it
const port = (serverArgs.includes('--port') && Number(serverArgs[serverArgs.indexOf('--port') + 1])) || Number(process.env.DASH_PORT) || 4800;
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
    vite = await startVite({ dashboard: `http://127.0.0.1:${port}/` });
    console.log(`  Hot reload: ${vite.origin}`);
  } catch (e) {
    // the page still works from the bundle; it just won't update by itself
    console.error(`  Hot reload could not start (${e instanceof Error ? e.message : String(e)}). Reload the page to see changes.`);
  }
}
// --vite on the command line, not in the environment: what the server starts doesn't inherit it (server/devpage.ts)
const server = Bun.spawn(['bun', '--watch', 'server/index.ts', '--no-open', ...(vite ? ['--vite', vite.origin] : []), ...serverArgs], {
  cwd: root,
  stdout: 'inherit',
  stderr: 'inherit',
});

// If one of them ends on its own, stop the others and pass on its exit code. Once: Ctrl+C ends them too, and
// their exit must not replace its code.
let stopping = false;
const stop = async (code = 0) => {
  if (stopping) return;
  stopping = true;
  web.kill();
  server.kill();
  await vite?.close().catch(() => {});
  process.exit(code);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
await stop(await Promise.race([web.exited, server.exited]));
