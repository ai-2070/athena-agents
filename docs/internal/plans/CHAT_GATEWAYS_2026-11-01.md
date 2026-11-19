# Chat gateways

_Plan, 1 November 2026; rebuilt 19 November 2026. Telegram, Slack and Discord bots that bring messages to the Brain, a
team or an agent of one project and answer in the same chat. The user guide is
[Chat gateways](../../guide.md#chat-gateways-telegram-slack-and-discord)._

## The rebuild

The first version (2–17 November) grew to about 18,000 lines of server and page code and 31,000 lines of tests:
a Chat SDK state adapter with kernel-held ownership ports, an inbox journal with operation IDs and reconciliation,
album grouping, per-transfer inode proofs, quota reservations, removed-instance retirement with 24-hour scratch
cleanup, Outbox delivery revisions, and a WhatsApp relay on Cloudflare. It never left a hidden Settings tab and was
never tried with a real account. It was replaced by the small version below; WhatsApp was dropped (it needs a public
endpoint, so a relay, which a local login-free app shouldn't need). It can come back on this base.

Kept from the first version: private conversations (`server/private-conversations.ts`, now shared with Tasks board
tasks), the Brain/team/agent entry points that take a conversation ID, and the sender rules below.

## How it works

- `server/gateways/store.ts`: instances (`chat-gateways`, global; each names its project and who answers), tokens
  (`gateway-secrets.json`, never sent to the page), and per instance `gateway-runtime/<id>/` with its messages (last
  200 finished ones kept), the chats it has talked in (for the Outbox) and Telegram's next update.
- `telegram.ts`, `slack.ts`, `discord.ts`: each app through its own API, no SDK. Telegram long polling; Slack Socket
  Mode; the Discord Gateway with heartbeats and resume. Nothing listens for the outside world. Each hands messages on
  in order (a name lookup never lets a later one overtake an earlier one).
- `supervisor.ts`: keeps every enabled instance connected (backoff; a wrong token or missing permission stops it with
  what to change until Reconnect), checks who may talk to it, saves each message before anything is done with it,
  saves its files into the project's uploads, runs it, and sends the answer as a reply, split to the app's limit,
  then the files the agent chose. One message at a time per chat, three per instance.
- `run.ts`: the message goes to the target in the chat's private conversation (`gw-<instance>-<hash of chat>`), and
  the gateway waits for the finished answer: an agent's chat quiet (helpers and background work done), a team quiet,
  or the Brain's answer and then the work it handed on. A brief's summary wins when there is one.

## Rules

- Telegram answers only listed user IDs (anyone can find a bot): an empty list means nobody. Slack direct messages:
  everyone in the workspace unless there is a list. Discord direct messages need the list (anyone sharing a server
  could write). In groups and channels: only when mentioned or replied to, and only in listed channels
  (Telegram groups: any group, but only listed users). Ignored people and channels are shown in Settings to let in.
- Restart safety without a journal: a message is saved before work starts. One that was being worked on when Athena
  stopped becomes failed, never re-run by itself. Retry keeps saved files, the answer and the parts that arrived
  (`sentParts`), so nothing reaches the chat twice. Telegram's offset moves only after the message is saved.
- The person gets one short note when a message fails before any of the answer arrived.
- `send_gateway_files` is high risk (files leave the dashboard) and takes only finished files in the agent's workspace
  or the project uploads, the checks `boardfiles.ts` `finishedFile()` makes for Tasks board files.
- Outbox: `gateway_draft` saves a draft; you choose the chat (one the bot has talked in) and approve. No tool sends to
  a chat app by itself.

## Not done

- Not yet tried with real accounts on each app (the tests fake the APIs and sockets).
- Answers go as plain text: Markdown shows as written on Telegram and Slack (Discord renders it).
- Missed Discord messages while disconnected are lost when the session can't resume; Slack redelivers unacknowledged
  events only while connected.
