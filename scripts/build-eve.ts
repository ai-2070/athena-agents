import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const runtime = path.join(root, 'runtime', 'eve');
const node = Bun.which('node');
if (!node) throw new Error('Node.js 24 is required to build the Eve runtime.');
const version = Bun.spawnSync([node, '--version'], { stdout: 'pipe', stderr: 'pipe' });
if (version.exitCode !== 0 || !/^v(?:2[4-9]|[3-9]\d)\./.test(version.stdout.toString())) throw new Error('Node.js 24 or newer is required to build the Eve runtime.');
const build = Bun.spawn([node, path.join(root, 'node_modules/eve/bin/eve.js'), 'build', '--profile', '.eve/build-profile.json'], {
  cwd: runtime, stdout: 'inherit', stderr: 'inherit',
});
if (await build.exited !== 0) throw new Error('The Eve runtime build failed.');
const entry = path.join(runtime, '.output', 'server', 'index.mjs');
if (!fs.existsSync(entry)) throw new Error('The Eve build did not produce a Node server.');
