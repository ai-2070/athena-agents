import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const runtime = path.join(root, 'runtime', 'eve');
if (!Bun.semver.satisfies(Bun.version, '>=1.4.0')) throw new Error('Bun 1.4 or newer is required to build the Eve runtime.');
const build = Bun.spawn([process.execPath, path.join(root, 'node_modules/eve/bin/eve.js'), 'build', '--profile', '.eve/build-profile.json'], {
  cwd: runtime, stdout: 'inherit', stderr: 'inherit',
});
if (await build.exited !== 0) throw new Error('The Eve runtime build failed.');
const entry = path.join(runtime, '.output', 'server', 'index.mjs');
if (!fs.existsSync(entry)) throw new Error('The Eve build did not produce a Bun server.');
fs.copyFileSync(path.join(runtime, 'launch.mjs'), path.join(runtime, '.output', 'launch.mjs'));
