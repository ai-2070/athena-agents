# Repositories and releases

Everything here except reading changes something other people see or rely on, so each change is the user's yes
(SKILL.md).

## Clone and fork

- `gh repo clone owner/repo` into the workspace (a folder name may follow; extra `git clone` flags go after `--`, as
  in `gh repo clone owner/repo -- --depth 1` for a quick look at a big repo).
- To contribute where the user can't push: `gh repo fork owner/repo --clone`. It makes a new repo under the user's
  account, so ask. The clone gets the fork as `origin`, the original as `upstream`, and the original as gh's default
  repo, so `gh pr create` aims at it. Cloning an existing fork with `gh repo clone` sets up the same.
- To bring a fork's default branch up to date with its parent: `gh repo sync owner/fork` on GitHub (a push to the
  fork), or locally `git fetch upstream` then `git merge --ff-only upstream/main` on the default branch.

## Create

Ask first, and make it private unless the user says otherwise.

```
gh repo create my-app --private --source . --remote origin --push
```

That publishes the current folder's committed history. Before it, look at what's in it: `git status`, a
`.gitignore` that keeps out build output, `.env` files and keys, and `git log` for anything committed by mistake,
since a pushed secret stays in the history. Other forms: `gh repo create my-app --private --add-readme --clone` for
an empty one, `org/my-app` for an organization, `--template owner/template` from a template repo. Without a
terminal gh needs one of `--private`, `--public` or `--internal`.

## Settings

- Read them: `gh repo view --json visibility,defaultBranchRef,description,deleteBranchOnMerge,squashMergeAllowed`
  (`gh repo view --json` with no fields lists them all).
- Change them, with the exact change shown first:
  `gh repo edit --description "…" --add-topic cli --delete-branch-on-merge --enable-wiki=false`.
- **Visibility.** gh refuses `--visibility` unless `--accept-visibility-change-consequences` comes with it:
  `gh repo edit --visibility public --accept-visibility-change-consequences`. Tell the user what it means first.
  Going public exposes every commit ever made, and with it any secret that was ever committed (scan the whole history,
  not just today's files), plus the Actions history and logs. Going private loses stars and watchers and detaches
  public forks.
- **Branch rules.** `gh ruleset list` and `gh ruleset check main` show the rules on a branch; classic branch
  protection is at `gh api 'repos/{owner}/{repo}/branches/main/protection'` (admins only). Changes to either are the
  user's, made with them.
- **Deleting a repo** can't be undone. The user does it themselves, on GitHub.

## Secrets and variables for Actions

- `gh secret list -R owner/repo` shows names and dates; values can't be read back. `gh variable list` shows the
  non-secret variables, values included.
- The user types secret values themselves (SKILL.md); `--env <environment>` or `--org <org>` aims one at a deployment
  environment or an organization. Not `--body` with the value, which lands in shell history and logs, and no file
  from the user's home folder (a private SSH key, a `.env`) unless they chose exactly that file for exactly this. A
  key made only for CI can be revoked without breaking anything else.
- Always pass `-R`: gh picks the repo for secrets differently from its other commands.

## Releases

**First, how does this repo release?** Look in `.github/workflows/` for a workflow that runs on pushed tags or on a
published release. If there is one, a release by hand would race it: the release is a tag push (the user's yes),
then watching that run.

1. **The version.** `gh release list --limit 10` and `git describe --tags --abbrev=0` show the scheme and the last one.
   With semantic versioning (MAJOR.MINOR.PATCH), breaking changes raise MAJOR, new features MINOR, fixes PATCH. When
   the number isn't obvious, ask.
2. **The commit.** Release the commit CI passed on:
   `gh run list --branch main --limit 5 --json conclusion,headSha,workflowName`.
3. **The notes.** GitHub drafts them without saving anything:

   ```
   gh api --method POST 'repos/{owner}/{repo}/releases/generate-notes' -f tag_name=v1.5.0 -f previous_tag_name=v1.4.2 --jq .body
   ```

   They list PR titles and authors as written. Edit them into `gh-work/notes.md`: breaking changes and upgrade steps
   first, plain words, noise left out. Show the user.
4. **A draft release**, which the user can look at on GitHub before anyone else sees it:

   ```
   gh release create v1.5.0 --draft --verify-tag --title "v1.5.0" --notes-file gh-work/notes.md
   ```

   `--verify-tag` stops if the tag isn't on GitHub yet. Without it gh makes the tag itself, from the latest commit on
   the default branch (or `--target <sha>`), which may not be the commit that passed. With the user's yes the tag
   comes first: `git tag -a v1.5.0 -m "v1.5.0" <sha>` and `git push origin v1.5.0`. Add files with
   `gh release upload v1.5.0 dist/app-1.5.0.zip` (`--clobber` replaces one of the same name). `--prerelease` marks a
   beta; `--latest=false` keeps a patch for an older line from becoming "Latest".
5. **Publish** on the user's word: `gh release edit v1.5.0 --draft=false`. When the repo has immutable releases, the
   tag and files can't change once it's published, so everything is checked while it's a draft.
6. **Check it**: `gh release view v1.5.0 --json isDraft,isImmutable,publishedAt,url,assets`, and
   `git ls-remote --tags origin v1.5.0` (for an annotated tag, the line ending `^{}` gives the commit) against the
   commit you meant.

`gh release download v1.5.0 -R owner/repo --pattern "*.zip" --dir gh-work/download` fetches a release's files;
from gh 2.96 that works on public repos without signing in.
