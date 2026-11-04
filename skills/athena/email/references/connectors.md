# Ways into a mailbox

Checked in November 2026. Which of these an agent has depends on its engine and on what the user has set up; the
dashboard tells each agent its real tools at run time. A tool that asks the user to confirm a send on its own is a
second check: it doesn't replace the yes in the conversation that SKILL.md asks for.

## Telling what you have

- Look through your tools for mail ones: names or descriptions that mention Gmail, Outlook, mail, email or Himalaya.
  Composio and OOMOL show up as tools that search and run their services' actions.
- In a shell, `himalaya --version` says whether Himalaya is installed (`references/himalaya.md` covers 2.2.1 and
  newer), and `himalaya account list` which accounts it knows.
- The `composio` and `oo` skills say how to check their own sign-in from a shell.

## The options

### Claude Code's Gmail connector

For agents on the Claude Code engine, through the user's Claude account. It searches and reads Gmail, writes drafts,
sends, replies and forwards (Claude asks the user before each of those by default), and manages labels. If its tools
are missing, the user signs in to Gmail in Claude Code with `/mcp`. Google Calendar sits beside it: check the calendar
before a draft proposes meeting times.

The dashboard's Library has a mail specialist, the Mail Assistant, built on this connector, with rules that match this
skill: replies and new mail become Gmail drafts shown in full in the chat, and nothing is sent, accepted or deleted
unless the user asks for that exact action.

### Composio

Gmail, Outlook and hundreds of other apps through the user's Composio account, on any engine: the `composio` skill
(its command-line tool) or the Composio server on the dashboard's MCP page (a Composio session link and API key).
Both Gmail and Outlook have actions for drafts, sending, replying, forwarding, folders or labels, and deleting. Read an
action's description before running it: for Gmail there are actions that move mail to the trash and others that delete
it for good, skipping the trash. Use the trash ones.

### OOMOL

Connected accounts (Gmail, Outlook and others) through the user's OOMOL account, on any engine: the `oo` skill or the
OOMOL server on the MCP page (an OOMOL MCP key and team name). Pick it when the user's mail is already connected
there. Its connector actions describe what they do; read the description of anything that sends or deletes.

### Himalaya

A program on the user's own computer that reads and sends mail for any IMAP and SMTP account, and also speaks JMAP and
the Gmail and Microsoft Graph APIs. The password stays on that computer, and no other service sits between the agent
and the mailbox. Two ways to use it:

- **In a shell**, as `references/himalaya.md` describes. Every engine with a shell can do this.
- **As an MCP server** (`himalaya mcp`), which the user adds by hand on the MCP page: command `himalaya`, arguments
  `mcp`. That command isn't in Himalaya 2.2.1, the current release (October 2026); it is in Himalaya's development
  version, so check `himalaya --help` lists `mcp` first. Until a release has it, use Himalaya in a shell.

Once the server runs, it serves one account (the default one, or another named with `--account <name>` in the
server's arguments), and its tools are named after the commands (`envelope_list`, `envelope_search`, `message_read`,
`message_reply` and so on). As added it only reads: the reply and compose tools return the text of a message but can't
save it as a draft. Two arguments on the MCP page widen it, and each is the user's decision:

- `--allow-write` adds saving drafts, flags (marking read), moving, copying and deleting mail, and creating, renaming
  and deleting mailboxes. Saving drafts needs it, and so does everything destructive: say so when the user adds it for
  drafts.
- `--allow-send` adds sending and setting an auto-reply. The server's own description warns that a message an agent
  reads could ask it to send; leave it off unless the user wants agents to send.

## Which to pick

1. The user named one, or exactly one is set up and signed in: use it.
2. Gmail on a Claude Code agent: the Gmail connector.
3. Outlook or Microsoft 365: Composio or OOMOL. Himalaya can reach these accounts too, but Microsoft has retired plain
   passwords, so it needs an OAuth token from a separate token program, a setup few users want.
4. Fastmail, iCloud, Posteo, Proton (through Proton Bridge), a company or internet provider's mailbox, or a user who
   doesn't want mail passing through another service: Himalaya.
5. Gmail on an engine other than Claude Code: Composio or OOMOL if the user has one, otherwise Himalaya with a Google
   app password.
6. Several accounts: one connection each. The MCP page can add a service more than once, each copy with its own name;
   say which account every finding came from.

## Drafts and sending

- **Drafts.** Save them where the route allows: a Gmail draft through the connector, a draft action in Composio or
  OOMOL, `--save` with the drafts folder in Himalaya. Where nothing saves drafts (Himalaya's server without
  `--allow-write`), the full draft in the chat is the draft.
- **Sending an approved draft.** Send the text the user approved, not a fresh rewrite. Connectors that can send a saved
  draft do exactly that; Himalaya sends a new copy built from the same text, and the draft stays in the drafts folder
  until the user wants it removed.
- **After a send**, confirm it: the tool's answer (a message id, "sent") and, where you can read it, the Sent folder.
  Gmail and Outlook file mail sent through their own APIs (the connectors above) in Sent themselves; for an IMAP
  account it depends on how Himalaya is set up (`references/himalaya.md`, "If a send fails").
