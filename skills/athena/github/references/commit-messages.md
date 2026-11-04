# Commit messages

A commit message is read later by someone asking why a line is the way it is. It says what changed and why, in the
repo's own style.

## The repo's style first

`git log --oneline -20` shows it: `Area: what changed`, `fix(auth): …`, a ticket key in front, plain sentences.
CONTRIBUTING.md or AGENTS.md may spell it out, and a commit-lint config (`commitlint.config.*`, a `commit-msg` hook)
enforces it. Follow what's there, even where it differs from the defaults below.

## What a good one holds

- **A subject line** that says what the change does, in the imperative ("Fix login timeout on slow networks", not
  "Fixed stuff"). Git's own documentation suggests keeping it to 50 characters or fewer, since many tools show only
  that line.
- **A blank line, then a body** when the why isn't obvious: the problem, why this approach, what it deliberately leaves
  alone. Wrap it the way the repo does. The diff already shows what changed line by line; don't narrate it.
- **One logical change per commit.** A formatting sweep, a rename and a fix are three commits, so each can be reviewed
  and reverted alone.

## Writing it

A message with a body goes in a file, written with your file tools, and `git commit -F gh-work/commit-msg.txt`. In
PowerShell 5.1, `-m` with quotes or backticks inside gets mangled. Commit only what you staged by name
(`references/pr-workflow.md`), and only when the user asked for a commit, or for something that needs one, like a PR.

## Conventional Commits, where the repo uses them

Format `type(scope): description`, scope optional. The specification defines `feat` (a new feature) and `fix` (a bug
fix); the widely used commitlint set adds `build`, `chore`, `ci`, `docs`, `perf`, `refactor`, `revert`, `style` and
`test`. A breaking change gets `!` before the colon (`feat(api)!: drop the v1 endpoints`) or a `BREAKING CHANGE:`
footer saying what breaks and how to move. Tools that write changelogs and pick version numbers read these, so a
wrong type there means a wrong release note. Don't introduce the format into a repo that doesn't use it.

## Trailers

Lines at the end of the body, after a blank line, in `Key: value` form:

- `Co-authored-by: Name <email>` credits another author; GitHub shows them on the commit. Use the address that person
  uses on GitHub, and only for people who did work on it.
- `Signed-off-by: Name <email>`, added by `git commit -s`, is required by repos that use the Developer Certificate of
  Origin (a DCO check in CI). It's a statement by the committer, so it's the user's name, and only when they agree.
- `Fixes #123` or `Closes #123` in a commit closes the issue when the commit reaches the default branch. In a PR it's
  usually better in the PR body, where the link shows on the PR.

## Before you commit

- `git diff --cached` shows exactly what goes in; nothing generated, no secrets, no debug lines.
- The subject still says what the change does after you've made it, not what you set out to do.
