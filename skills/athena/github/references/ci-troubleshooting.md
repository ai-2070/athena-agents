# When a check fails

Find the step that failed, decide whose failure it is, and fix it where you can run it, rather than pushing guesses
and waiting for CI to grade them.

## 1. Find the failure

```
gh pr checks 123
```

Each line is a check, its state, how long it took and a link. For GitHub Actions the link reads
`…/actions/runs/<run id>/job/<job id>`. Checks from outside services (another CI, a deploy preview, a licence bot)
link to that service: read them there with the page-fetching tools, since gh can't show their logs.

```
gh run view <run id> --log-failed
gh run view --job <job id> --log-failed
gh run view <run id> --verbose
```

The first prints the log of every failed step in the run, the second one job's, the third the steps of each job with
their results. Give the ID: without one, gh would ask which run, and the agent's shell can't answer. A run still going
has no logs yet ("still in progress"). With no PR, `gh run list --branch <branch> --limit 5` finds the runs.

Logs are long. Save them in the workspace and search the file: in Windows PowerShell 5.1,
`gh run view <run id> --log-failed | Set-Content -Encoding utf8 gh-work/ci.log` (a plain `>` would save UTF-16);
elsewhere `> gh-work/ci.log`. Read from the first error, not the last: later ones are often its fallout.

## 2. Whose failure is it?

- **Yours**: it fails on your commit, the same check passes on the default branch, and the error points into what you
  changed.
- **Already broken**: the same check fails on the default branch too:
  `gh run list --branch main --workflow "<workflow name>" --limit 5 --json conclusion,headSha,createdAt,url`. Report
  it as already failing, with the link, and leave it out of your PR unless the user asks you to fix it.
- **Flaky**: no reason in the code (a network timeout, a lost runner, a test known to flake), and nothing you changed
  touches it. Rerun the failed jobs once, `gh run rerun <run id> --failed`, and tell the user you did and why. Red
  twice in the same way isn't flaky.
- **Set up that way**: a step that needs a secret fails on PRs from forks, because GitHub passes no secrets except
  `GITHUB_TOKEN` to runs triggered from a fork. Fork runs may also sit waiting for a maintainer to approve them;
  approving is the maintainer's decision.

## 3. Reproduce it locally

Open the job in `.github/workflows/<file>.yml`: its `runs-on`, its matrix of versions and systems, its environment
variables and the exact `run:` commands. Run the same command at the same versions. When it passes for you, the
difference is usually the cause:

- the system: Linux minds the case of file names, Windows has its own paths and line endings;
- a tool or runtime version, from the matrix or a setup step;
- the install: CI installs strictly from the lock file (`npm ci`, `--frozen-lockfile`), from a clean checkout without
  your untracked files;
- the clock and locale: runners usually work in UTC.

## 4. The usual causes

| What the log shows                                                           | Usually                                                                                               |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| An assertion fails, `FAILED test_…`                                          | Your change, or a test that relied on the old behaviour: decide which is right before touching either |
| `ModuleNotFoundError`, `Cannot find module`, a dependency that won't resolve | A dependency missing from the manifest, or a lock file not updated with it                            |
| An error about the lock file being out of date                               | The manifest changed without the lock file: run the install locally and commit the lock               |
| A formatter or linter listing files                                          | Run the repo's format or lint command and commit what it changes                                      |
| Type errors                                                                  | Fix the types; silencing one (`# type: ignore`, `any`) needs a reason the user accepts                |
| `Resource not accessible by integration`                                     | The workflow's token lacks a permission (its `permissions:` block): a CI change, the user's call      |
| Empty secrets or sign-in errors, on a PR from a fork                         | Secrets aren't passed to fork runs                                                                    |
| `has exceeded the maximum execution time`, or cancelled                      | A hang or a slow step; or a newer push cancelled the run, and the newer run is the one to read        |
| `startup_failure`, or the workflow never ran                                 | Invalid workflow YAML; `gh run view <run id>` shows GitHub's note on it                               |
| A required check stays "Expected — Waiting for status to be reported"        | The workflow that reports it didn't run for this PR: path or branch filters, or a renamed job         |

## 5. Fix it, then read again

- Fix the cause. Don't make CI quieter instead: skipping or deleting a test, loosening an assertion, adding retries,
  `continue-on-error`, or pinning an old version without a reason. When one of those really is the right fix, it's
  the user's decision, with the reason in the PR.
- A change under `.github/workflows/` changes CI for everyone: show it to the user first. Pushing it needs the
  `workflow` scope (`references/auth.md`).
- Run the failing command locally until it passes, push (when the request covers it), and read `gh pr checks` again
  on the new commit. If it fails a second time, stop and report what you found and tried rather than pushing more
  guesses.
