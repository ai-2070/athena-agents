# From an issue to a tested PR

For "fix issue #123" or "implement this feature request". The order is there to stop the expensive mistakes: building
what someone else already built, fixing behaviour that was chosen on purpose, and a test that would pass anyway.

## 1. Know what's being asked now

Read the issue and its whole thread (SKILL.md, "Read the whole thing first") and the repo's contribution rules. The
body is what someone thought on the day they wrote it; later comments may narrow the ask, report a partial fix or put
a question to whoever takes it on. You're ready when you can say what's wanted, what isn't, and what's still open. An
open question, or maintainers who disagree, goes to the user before any code does.

## 2. Look for work that already exists

SKILL.md's search finds linked PRs and PRs under other wordings. Also look for branches linked to the issue
(`gh issue develop --list 123`) and a fix already on the default branch (`git fetch origin`, then
`git log --oneline -15 origin/main -- <the files>`).

Someone else's open PR for the same thing goes to the user (review it, help it along, or wait) rather than a second
PR racing it.

## 3. Check the premise

- **Show the problem before changing anything.** On the current default branch, a failing test or a short script
  that shows the symptom the issue describes (`systematic-debugging` for a bug whose cause is unknown; for a feature,
  the missing behaviour). The reporter may be on an old version: check theirs against the latest release.
- **If it doesn't reproduce,** say so with what you ran, and offer the user a comment asking the reporter for the
  missing detail, rather than fixing on a guess.
- **Was it deliberate?** Find the change that made the code this way.
  `git log -S "<the code in question>" --oneline -- <path>` lists the commits that added or removed that text,
  `git blame -L 40,60 <file>` names the last commit for each line, and
  `gh api 'repos/{owner}/{repo}/commits/<sha>/pulls'` finds the PR with its discussion. A restriction added for
  security or compatibility is a decision, not a bug: take it to the user, who may want a doc change or a reply on
  the issue instead of code.

## 4. Agree what done means

List the outcomes the PR has to deliver: the behaviour asked for, inputs at the edges, compatibility with existing
callers and saved data, docs. Give each one a test or a check you'll run. Where the ask is vague, ask the user now;
it's cheaper than a second round of review.

## 5. Write the test, then the fix

1. Branch as in `references/pr-workflow.md`. `gh issue develop 123 --checkout` instead makes a branch on GitHub,
   linked to the issue, which is a push and needs the user's yes; gh 2.99 and later add `--worktree <path>`.
2. Write the regression test and watch it fail for the reason in the issue, not for a typo or a missing import
   (`test-driven-development`).
3. Fix it where the problem starts. Then fix the whole class: search for the same mistake elsewhere (`git grep -n`,
   or `ast-grep` for code shapes) and fix every place it appears, or name in the PR the ones you left and why. A fix
   in one caller that leaves its siblings broken invites the next issue.
4. Keep the diff to what the issue needs. Tidying that's tempting goes in a separate PR, or in a note to the user.

## 6. Prove the test bites

Take the fix out and watch the new test fail; put it back and watch it pass. Never with `git stash`, which every
worktree shares and which can carry off the user's changes:

- A fix of a few lines: undo them in the file, run the test, put them back, and check `git diff` shows the fix
  exactly as it was.
- A larger fix: copy the old code into the workspace and run the new test against it there. Make the folder
  `gh-work/old`, then `git archive -o gh-work/old.tar HEAD <paths>` (`origin/main` in place of `HEAD` once the fix
  is committed) and `tar -xf gh-work/old.tar -C gh-work/old`, and copy the new test in at its path. `tar` comes
  with Windows 10 and later.

A test that passes without the fix proves nothing about it: rewrite it until it fails. Python can reuse a cached copy
of a file that changed back within the same second and kept its size (swapping `-` for `+` does that); if a result
surprises you, delete that `__pycache__` folder and run again.

## 7. Open the PR early, then see it through

1. As soon as the work is sound, run the repo's checks, push, and open the PR as a draft (`references/pr-workflow.md`,
   steps 3 to 5): CI is usually the slowest step, and it runs on systems you don't have.
2. The body (`templates/pr-body-fix.md`) links the issue with `Fixes #123` and says the cause, the fix, what the test
   proves, what you checked by hand, and what's deliberately out of scope.
3. Offer the user a comment on the issue: the PR link and the cause in a sentence, so the reporter can follow it.
   Leave the issue open; `Fixes #123` closes it when the PR merges.

## Report

The PR link, the state of its checks from a fresh read, the cause in a sentence or two, what the test proves, other
places the problem showed up, and what's left for the user (review, merge, a reply to the reporter).
