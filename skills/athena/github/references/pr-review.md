# Reviewing a pull request

The user wants to know whether a PR does what it says, safely, and whether it's ready. The review you post speaks
for them, so it's drafted in the chat first and the verdict is theirs.

## 1. Understand it before the code

```
gh pr view 123
gh pr view 123 --comments
gh pr view 123 --json closingIssuesReferences,headRefOid,isCrossRepository
gh pr diff 123 --name-only
gh pr checks 123
```

Add the line comments (SKILL.md says how) and the linked issue. Repeat a point an earlier review made only if it's
still unanswered. A very large PR is worth raising with the user first: a review of one part, said to be a part, beats
a skim of the whole.

## 2. Get the code, when the diff isn't enough

Check it out in a worktree of its own, in a new folder outside the repo, so the user's working copy stays as it is
(tell the user where):
`gh pr checkout 123 --branch pr-123 --worktree ../review-123` from gh 2.98, or with any version
`git fetch origin pull/123/head:pr-123` and then `git worktree add ../review-123 pr-123` (`pull/123/head` exists for
every PR, forks included). Afterwards remove both, since they're yours: `git worktree remove ../review-123` and
`git branch -D pr-123`. Before running its tests or build, SKILL.md's rule on running a PR's code applies;
`isCrossRepository: true` means the PR comes from a fork.

## 3. What to look for

Roughly in this order, because the first ones cost the most when missed:

- **Does it do what it says?** Check it against the description and the linked issue. Follow one real input through
  the changed code. Look for the part that's missing as much as the part that's wrong.
- **What does it break?** Search for callers of what changed. Watch for changed defaults, renamed flags or fields,
  file formats or database schemas changed with no migration, error paths, shared state, and paths and line endings
  on Windows.
- **Security.** Input that reaches a shell, a query, a file path or a page; checks on who may do what; secrets in code,
  tests or logs; new dependencies (needed? from whom?). A workflow on `pull_request_target` that checks out the PR's
  code runs it with the base repo's secrets and token.
- **Tests.** Would they fail if the change were wrong? Do they cover the case the PR is about? A test whose
  expectation was edited to match the new behaviour deserves a question.
- **Fit.** Naming, a helper that duplicates one the repo already has, comments that explain why. Worth less than the
  above: don't bury one real problem under twenty of these.

Read the code around each hunk as well: a change can be right where it is and wrong where it's called.

## 4. Draft the findings

- Each finding says where (file and line), what's wrong, why it matters (what breaks, for whom), and a fix, or a
  question when you aren't sure. Mark its weight: blocking, worth fixing, or minor.
- Specific praise is useful: it tells the author what to keep.
- Write about the code, not the person, in plain words.
- For a small exact change, a line comment can carry a suggestion block, which the author applies in one click:
  a fenced block whose language is `suggestion`, holding the replacement lines.
- Say what you didn't check: tests not run, a platform you don't have.

Show the user the whole draft: the summary, each line comment with its file and line, and the verdict you'd suggest.
They choose to comment, approve, request changes, or post nothing.

## 5. Post it as one review

One review with all its line comments sends one notification and keeps the threads together. Write
`gh-work/review.json` with your file tools:

```json
{
  "commit_id": "<headRefOid, read just now>",
  "event": "COMMENT",
  "body": "Summary of the review.",
  "comments": [
    { "path": "src/auth.ts", "line": 42, "side": "RIGHT", "body": "What's wrong, why, and a fix." },
    { "path": "src/auth.ts", "start_line": 50, "line": 54, "side": "RIGHT", "body": "A comment on lines 50 to 54." }
  ]
}
```

```
gh api --method POST 'repos/{owner}/{repo}/pulls/123/reviews' --input gh-work/review.json
```

- `commit_id` is the head commit you reviewed. If the author has pushed since, read the new diff first: lines move.
- `line` is the line number in the file at that commit, with `side` `RIGHT`; a deleted line is on `LEFT`, numbered as
  in the old file. `start_line` and `line` make a range. The line has to be in the diff, changed or shown as context
  around a change; one comment outside it makes GitHub refuse the whole request (422), so nothing goes out half done.
- `event` is `COMMENT`, `APPROVE` or `REQUEST_CHANGES`, as the user chose; `COMMENT` and `REQUEST_CHANGES` need a
  `body`. Leave `event` out and GitHub keeps the review pending, visible only to the user, who can read it in place
  and submit it with their own verdict. GitHub doesn't let authors approve their own PR.
- The answer includes the review's `html_url`: give it to the user.
- A review with no line comments needs no JSON: `gh pr review 123 --comment --body-file gh-work/review.md`
  (`--approve` or `--request-changes` likewise).

To answer one line comment on the user's own PR, drafted first like any post (the comment's `id` is in the list of
line comments; `-F body=@file` reads the text from the file):

```
gh api --method POST 'repos/{owner}/{repo}/pulls/123/comments/<comment id>/replies' -F body=@gh-work/reply.md
```
