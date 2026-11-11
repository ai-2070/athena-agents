# Himalaya 2 in a shell

Checked in November 2026 against Himalaya 2.2.1 (released October 2026): its README, release notes, source and
`--help`. Version 2.0.0 (July 2026) rewrote the configuration and many commands, so anything written for 1.x
(`folder list`, `template send`, `--output json`, `backend.host` in the config) no longer applies. On the user's
machine, `himalaya <command> --help` is the reference for the installed version.

Four habits that save most mistakes:

- **Options first.** Put options before message ids, search words and file names: everything after the query of
  `envelope search`, or after the file of `message send`, is read as part of it. Put `--json` straight after
  `himalaya`, as in `himalaya --json envelope list`.
- **An id belongs to its mailbox.** Ids from `envelope list -m Archive` work only with `-m Archive`, so pass the same
  `-m` to read, reply, flag or move. A moved message gets a new id in its new mailbox: list again.
- **On IMAP, only the inbox is known by role.** `-m sent`, `--save drafts` and `message delete` need either the
  mailbox's exact name from `mailbox list` or an alias in the config (below). A name that matches nothing is passed to
  the server as written, and the server refuses it.
- **Text goes in files.** Message bodies go in UTF-8 files you write with your file tools, in the workspace's
  `mail-work` folder, and the command gets their path (`--body-file`, `--attach`). Always give `--body-file`: without
  it the body is read from standard input, which in an agent's shell is usually empty.

## Installing

Installing is the user's call; ask first.

- **Windows**: `scoop install himalaya` where Scoop is installed. Otherwise the user downloads
  `himalaya.x86_64-windows.zip` (about 20 MB) from github.com/pimalaya/himalaya/releases/latest, takes `himalaya.exe`
  out of it, and puts it in a folder on the PATH.
- **macOS**: `brew install himalaya`.
- **Linux**: the project's installer, which puts it in `~/.local/bin` (a distribution's package may be older):

```sh
curl -sSL https://raw.githubusercontent.com/pimalaya/himalaya/master/install.sh | PREFIX=~/.local sh
```

Then `himalaya --version` should say 2.2.1 or newer: 2.1.0 sent the Bcc line along with the message, so every
recipient could see the blind copies. A configuration written for 1.x doesn't load in 2.x: the error names the account
and points at the project's MIGRATION.md, and running the wizard again is quicker than converting it.

## Setting up an account

### The wizard

The wizard asks questions, so the user runs it in their own terminal: `himalaya` when there is no configuration yet,
`himalaya configure` to add another account. It asks for the email address, finds the provider's servers, offers the
sign-in methods they advertise, asks where the password comes from, tests the connection and adds the account to the
configuration file. It needs a terminal to answer its questions in, so an agent's shell can't run it.

The wizard records how to read the password, never the password itself, and stores it nowhere. So the order for the
user is:

1. Make an app password where the provider needs one (Gmail, iCloud, Fastmail: below).
2. Put it in the system keychain or a password manager under a name of their choice (an entry):
   - macOS: `security add-generic-password -a <entry> -s <entry> -w`, which prompts for the password;
   - Linux: `secret-tool store --label <entry> account <entry>`, which prompts for it;
   - Windows: the wizard knows no keychain program there, so it asks for a command that prints the password. A
     password manager's command-line tool does this, such as 1Password's `op read op://<vault>/<item>/password`.
3. Run the wizard and choose that entry, or type that command, when it asks.

The password never goes into the configuration as text (`password.raw`), and the agent doesn't ask for it in the chat.

### The configuration file

| System  | Where                                                                                                             |
| ------- | ----------------------------------------------------------------------------------------------------------------- |
| Windows | `%APPDATA%\himalaya\config.toml`                                                                                  |
| macOS   | `~/Library/Application Support/himalaya/config.toml`, or `~/.config/himalaya/config.toml` if only that one exists |
| Linux   | `~/.config/himalaya/config.toml`                                                                                  |

The wizard's welcome message names the file it uses. Before editing it, copy it once to a backup, and tell the user
what changed. An IMAP and SMTP account looks like this:

```toml
[accounts.work]
default = true
email = "ana@example.com"
display-name = "Ana Ruiz"

imap.server = "imaps://imap.example.com"
imap.sasl.plain.username = "ana@example.com"
imap.sasl.plain.password.command = ["security", "find-generic-password", "-a", "work-mail", "-w"]

smtp.server = "smtps://smtp.example.com"
smtp.sasl.plain.username = "ana@example.com"
smtp.sasl.plain.password.command = ["security", "find-generic-password", "-a", "work-mail", "-w"]

mailbox.alias.sent = "Sent"
mailbox.alias.drafts = "Drafts"
mailbox.alias.trash = "Trash"
message.send.save-copy = "sent"
```

- A server without a scheme uses TLS from the start (`imaps://`, `smtps://`). For a server on port 587, write
  `smtp.server = "smtp://smtp.example.com:587"` and `smtp.starttls = true`.
- `password.command` as a list runs the program directly. As one string it runs through `cmd /C` on Windows and
  `/bin/sh -c` elsewhere.
- The aliases let `-m sent`, `--save drafts` and `message delete` work on IMAP. Copy the names from
  `himalaya mailbox list`; the wizard doesn't fill them in.
- `display-name` puts the user's name beside the address in From; the wizard records only the address.
- A `signature = "…"` line is added to everything composed, so drafts shouldn't end with it too.
- `message.send.save-copy` is explained under "If a send fails".
- Several accounts are several `[accounts.<name>]` blocks; `himalaya -a <name> …` picks one.

### Providers

- **Gmail**: an app password (2-Step Verification must be on; myaccount.google.com/apppasswords). Google doesn't offer
  them for work and school accounts, Advanced Protection, or 2-Step Verification with security keys only: use a
  connector there. Servers `imaps://imap.gmail.com:993` and `smtps://smtp.gmail.com:465`. Labels are mailboxes and the
  special ones sit under `[Gmail]/`: alias `sent`, `drafts` and `trash` to `[Gmail]/Sent Mail`, `[Gmail]/Drafts` and
  `[Gmail]/Trash`, and `archive` to `[Gmail]/All Mail`, after checking the exact names with `mailbox list`. Leave
  `message.send.save-copy` unset. The wizard also offers the Gmail API, which needs an OAuth token from a separate
  token program (Ortie, for one); IMAP is the simpler route.
- **iCloud**: an app-specific password (two-factor authentication on; account.apple.com, Sign-In and Security).
  `imaps://imap.mail.me.com:993` with the part of the address before `@` as the username, and
  `smtp://smtp.mail.me.com:587` with `smtp.starttls = true` and the whole address. The sent mailbox is
  `Sent Messages`.
- **Fastmail**: an app password.
- **Outlook and Microsoft 365**: plain passwords are retired, so Himalaya needs an OAuth token program. A connector is
  simpler (`connectors.md`).
- **Proton**: Proton Bridge, Proton's program that serves the mailbox over IMAP and SMTP on the user's own computer,
  with a password the Bridge generates.

Then check: `himalaya account list` shows the accounts, and `himalaya account check` connects to each server and
names any that fail, with the error. `himalaya --log debug account check` prints what happened along the way.

## Mailboxes, listing and searching

`himalaya mailbox list` shows each mailbox's name, and its role where the server reports one (on IMAP, only the
inbox). `--counts` adds total and unread counts, at one extra request per mailbox on IMAP, which is slow on a big
account.

`himalaya envelope list` shows the inbox, newest first, 25 to a page unless the config's `envelope.list.page-size`
says otherwise: `--page 2`, `--page-size 50`, `-m <mailbox>`. With `--json`, each envelope carries `id`, `flags`,
`subject`, `from`, `to`, `date`, `message-id`, `in-reply-to` and `size`. Nothing marks the last page: a full page means
there may be more, so keep asking for the next one until a page comes back short.

`himalaya envelope search <query>` takes the same paging options, and a query built from:

| Clause                                                      | Finds                                                                                     |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `from <word>`, `to <word>`, `subject <word>`, `body <word>` | That text in that part of the message (on IMAP the server matches, usually ignoring case) |
| `date 2026-11-03`                                           | Sent that day, by the message's Date line                                                 |
| `after 2026-11-01`                                          | Sent after that day, not on it                                                            |
| `flag seen`, `flag answered`, `flag flagged`, `flag draft`  | Messages with that flag                                                                   |

Clauses combine with `and`, `or`, `not` and parentheses, and `order by date desc` at the end sorts (`from`, `to` and
`subject` too; ascending without `desc`). 2.2.1 has no `before`: `not after 2026-10-31` means up to and including that
day. Keep each pattern to one word and join words with `and`: a pattern with spaces needs quotes inside the query,
which the shells pass on differently and Windows PowerShell 5.1 strips.

```
himalaya envelope search not flag seen and after 2026-10-27 order by date desc
himalaya envelope search -m sent subject invoice and subject march
himalaya --json envelope search -m "[Gmail]/All Mail" from alice and after 2026-10-01
```

- 2.2.1 has no thread command. To rebuild a thread, search the inbox and Sent for the subject's words and pair
  messages by `message-id` and `in-reply-to`. On Gmail, `[Gmail]/All Mail` holds both sides.
- Most mail programs set `answered` when the user replies, but Himalaya 2.2.1's own replies don't, so check Sent
  before calling a thread unanswered.

## Reading

- `himalaya message read 42` (with `-m <mailbox>` outside the inbox) shows the main headers, then each part of the
  message with its number, plain text written out. A message with only HTML prints the HTML. Reading leaves the
  message unread (`--seen` would mark it).
- `himalaya message read --raw 42` prints the source with every header (Reply-To, Received, Authentication-Results),
  which helps when a sender looks forged.
- `himalaya attachment list 42` lists the attachments. `himalaya attachment download --dir mail-work 42` saves them
  (or only the part numbers given after the id), and only when the user wants them read. Never run one.

## Drafting and sending

```
himalaya message reply 42 --body-file mail-work/reply-42.txt
himalaya message reply 42 --body-file mail-work/reply-42.txt --save drafts
himalaya message reply 42 --body-file mail-work/reply-42.txt --send
```

1. Without `--save` or `--send`, the reply is only printed, as it would go: To taken from the original's
   Reply-To or From, the `Re:` subject, the headers that keep it in the thread, the body, the quote and the signature.
   Check it, or show it to the user.
2. `--save drafts` saves it in the drafts mailbox (an alias or the exact name).
3. `--send` sends it. Only after the user's yes.

- 2.2.1 has no reply-to-all switch. Keep the default To and add the others with `--cc`, once per address, copied from
  the original's To and Cc without the user's own address. `--to` replaces the default recipients.
- `--posting-style` puts the reply above the quote (`top`, the default), below it (`bottom`), or leaves the quote out
  (`none`).
- A new message: `himalaya message compose --to bob@example.com --subject "Quarterly numbers" --body-file
mail-work/new.txt --attach mail-work/q3.pdf --save drafts`. `--to`, `--cc`, `--bcc` and `--attach` repeat.
- A forward: `himalaya message forward 42 --to carol@example.com --body-file mail-work/fwd.txt --save drafts`. In 2.2.1
  a forward quotes the text but leaves the original's attachments behind: download them (with the user's yes) and add
  each with `--attach`.
- To send an approved draft, run the same command with `--send` in place of `--save drafts`, from the same body file.
  The draft stays in the drafts mailbox; offer to remove it (`himalaya message delete -m drafts <id>`).
- `himalaya message send mail-work/message.eml` sends a complete message file (headers, a blank line, the body)
  exactly as written, so anything beyond plain English text needs its own MIME headers. Compose is simpler. HTML mail
  and signed mail need Pimalaya's separate `mml` program feeding `message send`; plain text suits replies.

### If a send fails

Himalaya sends first and saves a copy afterwards, when one is asked for: `--save` together with `--send`, or the
config's `message.send.save-copy`. An error that begins "Message sent, but saving a copy to" means the mail went. Don't
send it again: fix the mailbox name or alias, and tell the user the copy is missing. For any other error that comes
after connecting (a timeout, a dropped connection), look in Sent before a retry
(`himalaya envelope search -m sent subject <word>`).

That check only works when sent mail reaches Sent. Gmail, and Microsoft accounts reached through the Graph API, file
it there themselves, so leave `message.send.save-copy` unset for them. Many other providers don't: set
`message.send.save-copy` to the sent mailbox, or sent mail never shows there and an empty Sent proves nothing.
`--no-save` skips the copy for one send.

## Changing mail

Each of these is done only after the user's yes:

```
himalaya flag add --flag seen 42 43
himalaya flag remove --flag seen 42
himalaya message move --to Archive 42 43
himalaya message move --from Archive --to INBOX 7
himalaya message copy --to Receipts 42
himalaya message delete 42 43
```

- The flags are `seen` (read), `answered`, `flagged` and `draft`; `-m <mailbox>` reaches messages outside the inbox.
- `--to` and `--from` take an alias or an exact name; without `--from`, messages move out of the inbox.
- On Gmail, archiving is moving out of the inbox to `[Gmail]/All Mail` (or the `archive` alias).
- `message delete` moves messages to the trash, which on IMAP needs `mailbox.alias.trash` (without it, the command
  stops with an error and changes nothing). Run on messages already in the trash, it deletes them for good, which is
  asked for on its own.

## Windows PowerShell 5.1

- Begin any command whose output you read with `[Console]::OutputEncoding = [Text.Encoding]::UTF8;`, or accented
  names and subjects come back garbled.
- There's no `<` redirection, and text piped into a program loses letters outside English. Pass files by path
  (`--body-file`, `--attach`, `message send <file>`), written with the file tools, not with `>` or `Out-File`, which
  write UTF-16.
- A value with spaces in double quotes passes fine (`--subject "Re: Budget"`); a value that itself contains double
  quotes doesn't, because 5.1 strips them.
- The wizard and the keychain commands above ask questions, so the user runs them in their own terminal.
