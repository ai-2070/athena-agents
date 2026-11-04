# Pull requests, start to finish

The order matters: the branch is pushed before the PR exists, and the PR is read back before you say it's open. Each
step that leaves the machine falls under the "What needs the user's yes" rule in SKILL.md.

## 1. Start from the right place

```
git status
git fetch origin
git switch -c fix/login-timeout origin/main
```

- `git status` first. Changes already in the working copy belong to the user: don't carry them into your branch,
  stash them or throw them away. If the working copy is busy, work in a worktree of your own, in a new folder outside
  the repo (`git worktree add ../app-login-timeout -b fix/login-timeout origin/main`; `orca-cli` makes and tracks one
  in Orca), tell the user where it is, and remove it when the work is done.
- Branch from the real default branch (`gh repo view --json defaultBranchRef`), not a guess at `main`, and name the
  branch the way the repo does (`git branch -r` shows the habit), or else a kind and a topic, `fix/login-timeout`.
- A repo you can't push to: fork it (`references/repos-and-releases.md`), push the branch to your fork, and open the
  PR against the original.

## 2. Commit

- Stage files by name: `git add src/auth.ts tests/auth.test.ts`. `git add -A` and `git add .` sweep in build output,
  logs and `.env` files. `git diff --cached --stat` shows what's about to go in.
- Check who git will say made the commit (`git config user.name`, `git config user.email`). If they're empty, ask the
  user what to use rather than inventing a name.
- The message: `references/commit-messages.md`.
- On Windows, a diff where every line of a file changed is nearly always line endings.
  `git diff --stat --ignore-cr-at-eol` shows the real change; put the file's endings back rather than commit churn.

## 3. Check before pushing

Run what CI will run: the repo's documented command (`npm test`, `bun run check`, `pytest`), or the `run:` steps in
`.github/workflows/*.yml`. Read your whole diff once (`git diff origin/main...HEAD`); `requesting-code-review` is a
fuller pass. Note what you ran and what it printed, for the PR body.

## 4. Push, then open

```
git push -u origin HEAD
gh pr create --draft --base main --title "Fix login timeout on slow networks" --body-file gh-work/pr-body.md
```

- Push first. In a non-interactive shell gh won't push for you; it stops with "you must first push the current
  branch".
- The body follows the repo's own template if it has one (`.github/pull_request_template.md`, or
  `gh repo view --json pullRequestTemplates`), its headings filled in; otherwise `templates/pr-body-fix.md` or
  `templates/pr-body-change.md`.
- `--draft` when CI should run before anyone is asked to look; CI runs on drafts too unless the workflow says
  otherwise. `gh pr ready 123` takes it out of draft and notifies reviewers, so that's the user's call.
- From a fork: `gh pr create -R upstream-owner/repo --head your-login:fix/login-timeout …`.
- Reviewers, labels and assignees only as the user names them (`--reviewer`, `--label`, `--assignee`): a review
  request sends people a notification. Screenshots: from gh 2.99, `--attach ./before.png` uploads one into the body.

## 5. Read it back

```
gh pr view --json url,number,baseRefName,headRefName,headRefOid,isDraft,files
```

The base is the branch you meant, `headRefOid` matches `git rev-parse HEAD`, and `files` lists what you changed and
nothing else. Fix a wrong title, body or base now with `gh pr edit 123 --title … --body-file … --base …`. Then the
checks: `gh pr checks 123` (`--required` shows only those that block merging), and for a red one
`references/ci-troubleshooting.md`.

## 6. Review comments and follow-up commits

- Read every review and every line comment (SKILL.md says where they are) and answer each one: fixed, in which
  commit, or why not. Replies are posts under the user's name, drafted for them first; `references/pr-review.md`
  has the call for replying in a thread.
- Push follow-up commits rather than rewriting history while a review is open: a force-push loses reviewers' place.
  Some repos want a tidy history before merging; then squash at the end, with the user's yes.
- To bring the branch up to date with the base, do what the repo does (merge the base in, or rebase). Rebasing a
  pushed branch means a force-push.

## 7. Landing it

Merging is the user's call, every time. When they ask:

1. Check it can go: `gh pr view 123 --json state,isDraft,mergeable,mergeStateStatus,reviewDecision,headRefOid` and
   `gh pr checks 123 --required`. Tell the user what's blocking rather than working around it.
2. Merge the way the repo does (`gh repo view --json squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed`, or
   ask), with `--match-head-commit` set to the SHA you just checked, so the merge is refused if someone pushed since:
   `gh pr merge 123 --squash --match-head-commit 3f9c2a1e…`.
3. `--auto` merges once the requirements are met, where the repo allows auto-merge; on a branch with a merge queue,
   gh adds the PR to the queue. `--delete-branch` deletes the branch locally and on GitHub and needs its own yes
   (many repos delete merged branches themselves: `gh repo view --json deleteBranchOnMerge`). `--admin` overrides the
   branch's rules: only on the user's explicit word.
4. Confirm with `gh pr view 123 --json state,mergedAt,mergeCommit` before saying it's merged. If the user wants their
   copy current, switch back to the default branch and `git pull --ff-only`.
