# Signing in

How gh and git get access to GitHub without leaving a token lying around. Checked in November 2026 against gh 2.103
and GitHub's docs on tokens.

## Look first

```
gh auth status
git config --show-origin --get-all credential.helper
```

`gh auth status` lists each account, which one is active, where its token is kept (the system's credential store, a
plain file, or an environment variable such as `GH_TOKEN`), the git protocol and the token's scopes. The second line
shows which helper hands git its credentials, and from which config file.

## Safe ways in, best first

1. **gh, through the browser.** The sign-in waits for a person in a browser, which the agent's shell can't do, so the
   user runs it in a terminal of their own (Windows Terminal or PowerShell, Terminal on macOS):

   ```
   gh auth login --web --git-protocol https
   ```

   gh shows a one-time code (2.101 and later copy it to the clipboard too) and opens github.com/login/device. The
   token goes into the system's credential store (Windows Credential Manager, the macOS Keychain, the Secret Service
   on Linux); with no store, as on a server with no desktop, gh falls back to a plain-text file and says so. When gh
   offers to set up git, the answer is yes, or `gh auth setup-git` afterwards: git then asks gh for its credentials
   on github.com, so `git push` uses the same sign-in. The agent confirms with `gh auth status`.

2. **Git Credential Manager on Windows.** It comes with Git for Windows: the first push or fetch that needs a login
   opens a browser window and keeps the result in Windows Credential Manager. Let the user do that first push in their
   own terminal. It covers git only; gh still needs its own sign-in.
3. **A fine-grained token in `GH_TOKEN`**, when the user wants access limited to some repositories or the machine
   can't open a browser. The user makes it on github.com (Settings › Developer settings › Personal access tokens ›
   Fine-grained tokens) for one owner, with only the repositories and permissions needed (for PR work usually
   Contents, Pull requests and Issues; Actions to read CI runs) and an expiry. They set the variable themselves,
   never through the chat (on Windows a user variable under System › About › Advanced system settings › Environment
   Variables), then restart the dashboard so its shells see it. gh's help sends fine-grained tokens to `GH_TOKEN`;
   `gh auth login --with-token` expects a classic one. GitHub lists what fine-grained tokens can't do yet: contribute
   to public repos the account isn't a member of or is an outside collaborator on, reach several organizations at
   once, Packages, and the Checks API (`gh run watch` refuses them). For those, the browser sign-in.
4. **SSH**, for users who prefer it: a key with a passphrase, held by ssh-agent. The user makes it
   (`ssh-keygen -t ed25519 -C "their email"` asks for the passphrase), adds the `.pub` file at github.com under
   Settings › SSH and GPG keys, and tests it with `ssh -T git@github.com`. gh still needs its own sign-in for API work.

gh 2.103 added expiring tokens as a preview: `gh auth login --expiring` gets a short-lived token that gh renews itself.
With HTTPS git, it wants git 2.46 or newer and `gh auth setup-git`, so git doesn't keep an expired copy.

## Not these

| Shortcut                                                                                 | Why not                                                                      |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `git config credential.helper store`                                                     | Writes the token in plain text to `~/.git-credentials`                       |
| A token in the remote URL (`https://user:token@github.com/…`)                            | It ends up in `.git/config`, shell history and error output                  |
| A classic token with the `repo` scope when a fine-grained one would do                   | It reaches every repo the account can                                        |
| An SSH key with no passphrase                                                            | Anyone who copies the file has the account                                   |
| Writing gh's `hosts.yml` by hand, or a script that runs the device flow with gh's app ID | Skips the credential store and gh's checks; when sign-in fails, find out why |
| Printing a token (`gh auth token`, `gh auth status --show-token`) into the chat or a log | Anything printed is kept                                                     |

## Scopes and accounts

- A browser sign-in asks for `repo`, `read:org` and `gist`. Some work needs more, and adding a scope is another
  browser step for the user: `gh auth refresh -s workflow` to push changes under `.github/workflows/`,
  `gh auth refresh -s project` to put issues and PRs on projects.
- Several accounts: running `gh auth login` again adds one; `gh auth switch --user <login>` picks the active one, and
  git, set up through `gh auth setup-git`, follows it.
- `GH_TOKEN` and `GITHUB_TOKEN` in the environment beat every stored sign-in, and `gh auth status` names them as the
  source. To use the stored account for one session, remove the variable there: `Remove-Item Env:GH_TOKEN` in
  PowerShell, `unset GH_TOKEN` in a POSIX shell.

## When it goes wrong

| What you see                                                  | Likely cause                                                                                            | What to do                                                                                                                                                                        |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gh` isn't recognised                                         | Not installed, or installed after the dashboard started                                                 | Ask to install; restart the dashboard. On Windows it's usually `C:\Program Files\GitHub CLI\gh.exe`                                                                               |
| `gh auth status`: not logged in, or the token is invalid      | Never signed in, revoked or expired                                                                     | The user signs in again in their own terminal                                                                                                                                     |
| The wrong account acts                                        | `GH_TOKEN` set, or another account active                                                               | `gh auth status`; remove the variable or `gh auth switch`                                                                                                                         |
| `gh auth login` in the agent's shell hangs or fails           | It needs a person                                                                                       | The user runs it in their own terminal                                                                                                                                            |
| `Support for password authentication was removed`             | git is sending a password                                                                               | `gh auth setup-git`, or Git Credential Manager                                                                                                                                    |
| `fatal: Authentication failed`                                | A stale stored credential                                                                               | Sign in again; check which helper answers (`credential.helper` above)                                                                                                             |
| `Permission to owner/repo.git denied to <login>`              | That account can't write there                                                                          | Right account? Otherwise fork and open a PR from the fork                                                                                                                         |
| `refusing to allow an OAuth App to create or update workflow` | No `workflow` scope                                                                                     | `gh auth refresh -s workflow` (the user runs it)                                                                                                                                  |
| `Resource not accessible by personal access token`            | The fine-grained token lacks that repo or permission                                                    | The user edits the token, or signs in through the browser                                                                                                                         |
| 404 on a repo the user can open in the browser                | The account or token in use can't see it; an organization with SAML single sign-on hasn't authorized it | `gh auth status`; the user authorizes the token for that organization on GitHub                                                                                                   |
| `ssh: connect to host github.com port 22` times out           | Port 22 is blocked                                                                                      | GitHub answers SSH on port 443 too: `ssh -T -p 443 git@ssh.github.com`; a `Host github.com` entry with `Hostname ssh.github.com` and `Port 443` in `~/.ssh/config` makes it stick |
| `Permission denied (publickey)`                               | No key loaded, or not added to the account                                                              | `ssh-add -l` lists loaded keys; `ssh -T git@github.com` says which account a key belongs to                                                                                       |
