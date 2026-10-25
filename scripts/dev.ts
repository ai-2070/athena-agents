// Development: rebuild the browser app on change and restart the server on change.
//   bun run dev
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const web = Bun.spawn(['bun', 'scripts/build-web.ts', '--watch'], { cwd: root, stdout: 'inherit', stderr: 'inherit' });
const server = Bun.spawn(['bun', '--watch', 'server/index.ts', '--no-open', ...process.argv.slice(2)], { cwd: root, stdout: 'inherit', stderr: 'inherit' });

// If one of them ends on its own, stop the other and pass on its exit code.
const stop = (code = 0) => {
  web.kill();
  server.kill();
  process.exit(code);
};
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
stop(await Promise.race([web.exited, server.exited]));
