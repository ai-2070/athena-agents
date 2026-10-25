// Bundles the browser app (web/*.ts) into public/dist with Bun. Pass --watch to rebuild on change.
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const outdir = path.join(root, 'public', 'dist');
const watch = process.argv.includes('--watch');

async function build(): Promise<boolean> {
  const started = performance.now();
  fs.rmSync(outdir, { recursive: true, force: true });
  const result = await Bun.build({
    entrypoints: [path.join(root, 'web', 'app.ts')],
    outdir,
    target: 'browser',
    format: 'esm',
    splitting: true,
    minify: !watch,
    sourcemap: 'linked',
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    return false;
  }
  const size = result.outputs.reduce((n, o) => n + o.size, 0);
  console.log(`web: ${result.outputs.length} files, ${(size / 1024).toFixed(0)} KB in ${Math.round(performance.now() - started)} ms → public/dist`);
  return true;
}

const ok = await build();
if (!watch) process.exit(ok ? 0 : 1);

// --watch: rebuild when anything in web/ or shared/ changes
let timer: ReturnType<typeof setTimeout> | null = null;
for (const dir of ['web', 'shared']) {
  fs.watch(path.join(root, dir), { recursive: true }, () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void build(), 120);
  });
}
console.log('web: watching for changes');
