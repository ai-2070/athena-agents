import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const runtime = path.join(root, 'runtime', 'eve');
if (!Bun.semver.satisfies(Bun.version, '>=1.4.0'))
  throw new Error('Bun 1.4 or newer is required to build the Eve runtime.');
for (let attempt = 0; ; attempt++) {
  const build = Bun.spawn(
    [process.execPath, path.join(root, 'node_modules/eve/bin/eve.js'), 'build', '--profile', '.eve/build-profile.json'],
    {
      cwd: runtime,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const [code, stdout, stderr] = await Promise.all([
    build.exited,
    new Response(build.stdout).text(),
    new Response(build.stderr).text(),
  ]);
  // Windows file scanners can hold a newly traced file briefly.
  if (code && process.platform === 'win32' && attempt < 2 && /EBUSY|EPERM/.test(stdout + stderr)) {
    await Bun.sleep(500 * (attempt + 1));
    continue;
  }
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  if (code) throw new Error('The Eve runtime build failed.');
  break;
}
const entry = path.join(runtime, '.output', 'server', 'index.mjs');
if (!fs.existsSync(entry)) throw new Error('The Eve build did not produce a Bun server.');
fs.copyFileSync(path.join(runtime, 'launch.mjs'), path.join(runtime, '.output', 'launch.mjs'));
