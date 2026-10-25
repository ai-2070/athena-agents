// Development: rebuild the browser app on change and restart the server on change.
//   bun run dev
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const web = Bun.spawn(['bun', 'scripts/build-web.ts', '--watch'], { cwd: root, stdout: 'inherit', stderr: 'inherit' });
const server = Bun.spawn(['bun', '--watch', 'server/index.ts', '--no-open', ...process.argv.slice(2)], { cwd: root, stdout: 'inherit', stderr: 'inherit' });

const stop = () => {
  web.kill();
  server.kill();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
await Promise.race([web.exited, server.exited]);
stop();
