# Issues

Finding, writing and tending issues. Reading a whole thread and the duplicate search are in SKILL.md; this adds the
rest.

## Finding them

- `gh issue list` shows 30 open issues. Narrow it with `--label bug`, `--assignee @me`, `--author <login>`,
  `--milestone <title>`, widen it with `--state all` and `--limit 100`, or pass GitHub's search syntax:
  `--search "label:bug sort:updated-desc timeout"`.
- `gh search issues "timeout" --repo owner/repo --state open` searches across repos (`--owner` for an organization).
  From gh 2.98, `--search-type semantic` matches meaning rather than words, which finds duplicates written another way.
- Ask for JSON when you'll sort or count: `--json number,title,labels,updatedAt,url`.
- Through the API, `repos/{owner}/{repo}/issues` returns pull requests as well (they carry a `pull_request` field);
  `gh issue list` leaves them out.

## Before writing one

- **Security problems don't go in a public issue.** Read the repo's policy (SECURITY.md, or the address in
  `gh repo view --json securityPolicyUrl`) and use the private route it gives. Tell the user why.
- **The repo's templates.** `gh repo view --json issueTemplates` lists its Markdown templates. Issue forms (`.yml`
  files in `.github/ISSUE_TEMPLATE/`) aren't in that list, and gh can't fill them in: read the form, use its fields'
  labels as the headings of your body, and add the labels it sets. `config.yml` there may send questions elsewhere
  (Discussions, a forum), and `isBlankIssuesEnabled: false` says the maintainers want their forms used.
- **Labels** have to exist already (`gh label list`); gh stops on an unknown one. Making new labels is the
  maintainers' call.

## Writing a good one

- **The title** is the symptom and where it shows, specific enough to be found by search: "CSV export drops rows past
  10,000 on Windows", not "Export broken".
- **A bug report** gives what happened (the exact error text), what should have happened, steps from a clean start,
  versions and system, and the smallest reproduction you have. Trim logs to the part that matters and take out tokens,
  email addresses, user names in paths and customer data.
- **A feature request** starts from the problem as the user meets it, then the proposal, alternatives considered and
  what's out of scope. A proposal without the problem is hard to weigh.
- **One problem per issue.** Facts you don't have are asked for, or left as a marked placeholder (`[version]`);
  never an invented version or step. `templates/issue.md` has both shapes, for repos without templates of their own.

```
gh issue create --title "CSV export drops rows past 10,000 on Windows" --body-file gh-work/issue.md --label bug
```

Newer gh can do more at creation: `--type Bug` (where the organization uses issue types), `--parent 100` for a
sub-issue, `--blocked-by 200` (all from 2.94), `--attach ./error.png` to upload a screenshot (from 2.99). Assign
people only when the user names them: it notifies them. gh prints the new issue's URL; give it to the user.

## Tending them

- **Labels, people, milestones**: `gh issue edit 123 --add-label bug --remove-label needs-triage`, `--add-assignee`,
  `--milestone`. Watchers see each change.
- **Comments**: `gh issue comment 123 --body-file gh-work/comment.md`, drafted for the user first. `--edit-last`
  corrects the user's most recent comment instead of adding another.
- **Closing**: post the explanation as a comment first, then `gh issue close 123 --reason "not planned"`. Reasons are
  `completed`, `not planned` and, from gh 2.88, `duplicate`, with `--duplicate-of 456` linking the original.
  `gh issue reopen 123` undoes it.
- **Delete, transfer, lock, pin** exist too (`gh issue --help`). Deleting can't be undone and takes the thread with
  it: closing is nearly always what's wanted.

## Many at once

1. List the candidates with the search that found them: `--json number,title,updatedAt,labels,url`.
2. Show the user the list and what would happen to each, and drop any they take out.
3. Run one command per approved number, stopping at the first error. PowerShell:

   ```powershell
   foreach ($n in 101, 107, 115) { gh issue close $n --reason "not planned"; if ($LASTEXITCODE -ne 0) { "stopped at $n"; break } }
   ```

   POSIX shell:

   ```sh
   for n in 101 107 115; do gh issue close "$n" --reason "not planned" || { echo "stopped at $n"; break; }; done
   ```

4. GitHub limits bursts of writes (`references/gh-api.md`), so a long list goes in smaller batches. Report which
   numbers were done, so nothing runs twice.
