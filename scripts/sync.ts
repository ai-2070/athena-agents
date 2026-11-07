// Brings in the latest Athena souls and skills, which live in repos of their own:
//   souls   ai-2070/athena-souls   → library/athena-souls   (the Agent library's agents)
//   skills  ai-2070/athena-skills  → skills/athena          (the dashboard's own skills, without their tests)
// Change them in those repos, then: bun run sync [souls|skills] [--ref <branch, tag or commit>] [--force]
// Each folder's source.json records the commit it came from. The repos are private for now, so git needs your
// GitHub sign-in (the one you push with).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

interface Source {
  repo: string;
  into: string;
  /** top-level names in the repo that the dashboard doesn't ship */
  skip: string[];
}
const SOURCES: Record<string, Source> = {
  souls: { repo: 'ai-2070/athena-souls', into: 'library/athena-souls', skip: ['.git', '.github', '.gitignore'] },
  skills: { repo: 'ai-2070/athena-skills', into: 'skills/athena', skip: ['.git', '.github', '.gitignore', 'tests'] },
};

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

function git(args: string[], cwd = root): string {
  const r = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString().trim()}`);
  return r.stdout.toString().trim();
}

function sync(name: string, src: Source, ref: string, force: boolean): void {
  // a change made in the copy would be lost, and it belongs in the repo anyway
  const changed = git(['status', '--porcelain', '--', src.into]);
  if (changed && !force) throw new Error(`${src.into} has changes that aren't committed. Move them to ${src.repo} first, or pass --force to drop them:\n${changed}`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `athena-${name}-`));
  try {
    // a full clone, so --ref can also be a commit
    git(['clone', '--quiet', `https://github.com/${src.repo}.git`, tmp]);
    git(['checkout', '--quiet', ref], tmp);
    const commit = git(['rev-parse', 'HEAD'], tmp);

    const dest = path.join(root, src.into);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
    for (const e of fs.readdirSync(tmp)) {
      if (!src.skip.includes(e)) fs.cpSync(path.join(tmp, e), path.join(dest, e), { recursive: true });
    }
    fs.writeFileSync(path.join(dest, 'source.json'), `${JSON.stringify({ repo: src.repo, commit }, null, 2)}\n`);

    const stat = git(['status', '--short', '--', src.into]);
    console.log(`${name}: ${src.repo} at ${commit.slice(0, 7)} → ${src.into}${stat ? `\n${stat}` : ' (no changes)'}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const which = process.argv.slice(2).find((a) => !a.startsWith('--') && a !== argValue('--ref'));
if (which && !SOURCES[which]) {
  console.error(`Unknown "${which}": use souls, skills, or nothing for both.`);
  process.exit(1);
}
const ref = argValue('--ref') || 'main';
const force = process.argv.includes('--force');
try {
  for (const [name, src] of Object.entries(SOURCES)) if (!which || which === name) sync(name, src, ref, force);
  console.log('Next: bun run check, then commit the result.');
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
