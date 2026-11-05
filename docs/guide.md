# Athena Agents: the detailed guide

The [README](../README.md) says what the dashboard is, how to install it, which engines and models it can use, and the everyday commands. This file explains how it behaves once it is running.

- [Desktop app notes](#desktop-app-notes)
- [Giving engine CLIs the dashboard tools](#giving-engine-clis-the-dashboard-tools)
- [Venice models](#venice-models)
- [Your first project](#your-first-project)
- [Chats and files](#chats-and-files)
- [Tasks](#tasks)
- [Skills: instructions worth keeping](#skills-instructions-worth-keeping)
- [MEMORY.md: what agents remember](#memorymd-what-agents-remember)
- [Routines: work worth repeating](#routines-work-worth-repeating)
- [The Brain and your teams](#the-brain-and-your-teams)
- [Models, effort and stopping work from Brain chat](#models-effort-and-stopping-work-from-brain-chat)
- [MCP servers from Brain chat](#mcp-servers-from-brain-chat)
- [Long chats](#long-chats)
- [Approvals and safety](#approvals-and-safety)
- [Save and restore](#save-and-restore)
- [Troubleshooting](#troubleshooting)

## Desktop app notes

The [desktop app](../README.md#desktop-app) is the same dashboard in its own window. It starts the dashboard's server when you open it and stops it when you quit. Links to other sites open in your browser.

- **Closing the window keeps it running** in the tray (the notification area on Windows, the menu bar on macOS), so agents keep working. Click the tray icon, or open the app again, to bring the window back. To quit, right-click the tray icon and choose **Quit Athena Agents**. On a Linux desktop that hides tray icons (GNOME without an extension), open the app again from the app menu to bring the window back.
- **Its data is separate** from a checkout's `data/` folder. It lives in `%APPDATA%\com.ai2070.athena-agents\data` on Windows, `~/Library/Application Support/com.ai2070.athena-agents/data` on macOS and `~/.local/share/com.ai2070.athena-agents/data` on Linux. To use another folder, start the app with `DASH_DATA` set to it. Its first project uses the same **My workspace** folder as the browser version: if that folder already has a saved copy (`.dashboard`), the app loads it first instead of saving an empty project over it.
- **It uses port 14800**, not 4800, so it can run next to the browser version. If 14800 is taken, it uses the next free port. To sign in to X or Reddit from the app, add the callback address its **Connections** page shows (with 14800) to your X or Reddit app.
- **The installers are not signed yet.** On Windows, choose **More info → Run anyway**. On macOS, Control-click the app in Finder and choose **Open**, or allow it under **System Settings → Privacy & Security**.
- **Files open in their own programs.** A file in a chat, a team chat, the Brain or the Outbox has an **Open** button that opens it with the program your computer uses for it, and clicking a PDF or any other file the page can't show opens it there too, instead of a browser tab or a download. Programs and scripts (`.exe`, `.bat`, `.ps1`, `.py` and the like) are never opened this way: use **Show in Explorer** / **Show in Finder** to look at them.
- **It updates itself.** A little after it opens, and every few hours after that, the app checks for a new version. When there is one, it asks you: **Install and restart** downloads it (the window's title shows how far it got), installs it and opens the app again. Installing restarts the dashboard, so agents that are working stop; they pick up again when you write to them. **Later** asks again the next time you open the app. On Linux, a `.deb` or `.rpm` update asks for your password. To turn updates off, start the app with `DASH_NO_UPDATES` set. What the updater did is in `updater.log`, next to the server's log.

## Giving engine CLIs the dashboard tools

Claude Code and Codex receive dashboard tools through an MCP bridge; API-model agents call them directly. For Hermes, open **Settings → MCP servers** and click **Give Hermes the dashboard tools**, then restart Hermes sessions. pi and oh-my-pi get them through their own `mcp.json` (pi needs version 0.99 or newer): the first run of an agent on either adds the dashboard there, and puts it right if the app was moved. **Give pi and oh-my-pi the dashboard tools** on the same page does it by hand. If that file isn't valid JSON it is left alone, and you get a message saying the agent can't use the dashboard tools until it is fixed.

pi and oh-my-pi run their own tools (files, shell, edits) without asking, whatever the agent's autonomy says. OpenClaw follows its own approval settings. Each chat keeps its own pi, oh-my-pi or OpenClaw session. OpenClaw goes through its Gateway when it is running; otherwise it answers on this PC.

Claude Code, Codex, pi, oh-my-pi, Hermes and OpenClaw have their own tools for files and commands, so they don't also get the dashboard's **Files** and **Shell** tools: those two switches are for API-model agents. Every other dashboard tool reaches them as usual. Codex gets the dashboard's tools without the bridge's key on its command line; with Codex 0.136 or later, the keys of your MCP servers go in its environment instead, hidden from the commands it runs.

## Built-in tools

- **Files** (API-model agents): `read_file` reads a long file in parts and several files in one call. `edit_file` changes part of a file without writing all of it again. `find_files` finds files by name (`*.md`, `notes/**/*.txt`), and `search_files` finds the lines that match. They stay inside the agent's workspace and the folders you allow, and never follow links out of them.
- **Browser:** `fetch_url` returns a page as Markdown, in parts of up to 50,000 characters. The next part comes from a copy kept for ten minutes, not a new download.
- **Shell:** `run_command` uses PowerShell 7 when it is installed, otherwise Windows PowerShell on Windows and bash (or sh) on Mac and Linux. Long output keeps its start and its end, where errors usually are.
- **Delegate:** `await_agent` can wait for several helpers at once, until the first is done or all of them. `ask_agent` can wait for a quick answer in the same call.
- **Long results:** a tool result longer than **Settings → General & keys → Context → Longest tool result** (24,000 characters by default) reaches the agent with its start and its end. The whole text is saved in `outputs/tool-results` for a week, where the agent can read the rest. Tools that already read in parts, and task lists, are not shortened.
- **Board and gateway tools** show up only in the conversations they work in: a Tasks board task, or a gateway conversation.
- **Tool stats:** the dashboard counts how each tool is used (calls, errors, time and result size) in `data/tool-stats.json`. The numbers stay on this computer.

## Venice models

In **Settings → General & keys → API keys**, save a Venice inference key from [Venice API settings](https://venice.ai/settings/api). **Test** checks the saved key without generating an answer. It shows access, expiration and any available USD, DIEM and bundled-credit balances separately. A valid key can still have blocked access or no credits. Remove or replace the key in the same row. Keys stay in the server's secret store and are excluded from project folders and backups.

The chat model picker and Station’s AI engines strip show only engines that are set up: saved API keys, installed local engines and, where checked, an active sign-in. Add or change setup in **Settings**.

Pick **Venice** in the model picker for an agent or **The Brain's model**. In the agent editor, choose **API model**, then **Venice** as the provider. In the Agent library, choose **API model**, then **Choose API model** before hiring. Favorites keep their provider, so a Venice model stays on Venice when selected again. The Brain can also look up Venice models and move an agent or whole team onto one by name.

Venice models have their own ids. Set **Defaults for new agents → Venice model**, then **Save settings**, to supply a model when a Venice agent or the Brain has none selected. Otherwise choose a model explicitly. OpenRouter's default does not apply to Venice. The existing default engine choice stays unchanged.

The model list shows prices and context size, flags models without tool use and disables unavailable models, including in Favorites. Effort appears only when the selected model advertises supported levels. The Agent library keeps your chosen effort for new hires; **Default** uses the model's own setting. Image attachments follow its vision and image-count limits. If the catalog cannot load, the picker keeps the selected model and offers manual model entry; effort is omitted until its supported levels are known.

Venice uses Athena's agent and Brain instructions with Venice's added system prompt disabled. Venice's built-in search, scraping and character features are not enabled. This integration covers chat, including supported image attachments; it does not add Venice image generation, video, audio, embeddings or wallet authentication.

The Station's usage readout shows available Venice balances separately from Claude, Codex and OpenRouter. Each run's usage is still recorded, telling reported USD and DIEM charges apart from an **estimated USD equivalent** based on token counts and catalog prices (an estimate is not a USD debit), but the chat no longer shows a cost and token line after each reply.

**Cost limit per message** stops API runs between model steps after a known cost passes the limit. Venice uses a USD-equivalent estimate when needed, including for DIEM-funded runs. A single answer can exceed the limit. If cost information is missing, the monetary limit cannot be measured; the tool-step limit still applies. This is a local stop, not a hard spending cap at Venice.

## Your first project

1. **Choose a folder.** From the project picker, select **New project**. Start in a new folder, use an existing one, or clone a GitHub repo. Give the project a name and describe what you want to make. GitHub cloning uses your `gh` login, including for private repos.
2. **Ask the Brain for a small, concrete job.** Open **Ask the Brain**, press **Ctrl+K** (**⌘K** on macOS), or press **Space** on the Station when you are not typing. For example:

   > Build a small team to review this project's docs. Have one agent find confusing setup steps and another suggest clearer wording. Do not change files yet.

3. **Review the agents and their access.** Check their models, instructions, tools and work folders. In an agent's editor, choose an emoji for its icon or type your own. You can also add a ready-made agent from the **Agent library** instead of asking the Brain to build one. Each comes with its instructions, tools and skills, and is told that its role is where it's strongest, not a limit: it takes on nearby work it can do well and asks for a tool it doesn't have (see **Agents ask for tools**).
4. **Follow the work.** Click a team or agent on the Station to open its panel and chat. Team chats show the conversation and handoffs; individual chats let you work with one agent directly.
5. **Handle anything waiting on you.** Check **Needs you** for permissions and **Outbox** for agents' questions and outgoing drafts. Results that agents save as artifacts appear in **Artifacts**; files they create stay in their work folders.

Projects keep separate agents, teams and chats. Use the project name at the top left to switch projects, create another one or make a backup.

**Esc** takes you back to the Station from any other page, which is handy when you have followed a link into Settings or an agent's editor. What is open closes first: a dialog, a dropdown, the Brain chat, a chat's find box. A field you are typing in just loses the cursor, and the **Needs you** drawer keeps what you have typed until you close it yourself. On the Station itself there is nowhere to go back to, so **Esc** opens the wide menu sidebar instead, and **Esc** again closes it.

On the Station, the activity feed says **Live** in green while live updates are connected. **Reconnecting…** means the
connection dropped and the dashboard is trying again.

## Chats and files

Agent and team chats open in floating, resizable windows with tabs. Drag a tab along the tabs to reorder it, out onto the map to open it in a new window, or onto another window's tabs to move it there; drag a window by its title bar onto another window's tabs to join them. Press **Ctrl+↓** (**⌘↓** on macOS) to minimize the window on top, again for the next one, and **Ctrl+↑** (**⌘↑**) to bring them back, the one minimized last first.

To find something in a chat, press **Ctrl+F** (**⌘F** on macOS) while you are in it: the Brain chat, an agent's chat or a team's. A search box opens with the number of matches; every match is lit up, **Enter** goes to the next one, **Shift+Enter** to the previous one, and **Esc** closes the box. It reads the whole chat, including old messages that are not drawn on screen. The same works in a Markdown file opened to read. Very large Markdown files open at once, because only the part you are reading is drawn. A file over 200 MB is too big to read here; open it in another app.

To arrange the windows, use the **Arrange** button in a window's title bar or the keys (**Ctrl+Alt** on Windows, **Ctrl+⌥** on macOS):

- **Left half** / **Right half** (**←** / **→**): snaps the window on top to that side, next to the sidebar and above the bottom bar. Press it again for ⅔ of the width, then ⅓.
- **Side by side** (menu only): puts all the windows next to each other, keeping their tabs.
- **Separate tabs** (**↑**): gives every tab a window of its own, all side by side. When they don't fit across, they go in rows.
- **Combine all** (**↓**): puts every tab back into the window on top, on the chat you were in.

Minimized windows come back when you arrange them. If Rectangle or Magnet is installed on your Mac, it takes **Ctrl+⌥** + arrows first; the Arrange button still works. A new chat opens in the window you used last, and the windows and their tabs are remembered in this browser. Type **@** in a chat to pick another agent; it shows as a pill while you write (Backspace takes the whole pill away). In the Brain chat, **@** offers the project's agents, teams and skills. An agent with **Delegate** enabled can hand that agent part of the work. Handing off doesn't make it wait: the other agent starts at once, so an agent can hand out several tasks side by side and collect each answer when it's ready, however long the work takes.

Type **/** in an agent, team or Brain chat to see the commands. They work while the agent is busy:

- `/queue <message>` lines up your next message. It waits above the box and goes once the work going on now is done, one at a time. In a team chat that is when the whole team is done; in Brain chat, when the Brain and anything it handed on are done. **×** takes one back. If nothing is working it goes right away. You can change a queued message before it goes: click it, or press **Up** in an empty box for the last one (Enter keeps the change, Esc drops it). Drag one, or use **Alt+Up** / **Alt+Down**, to change the order.
  Agent and team queues survive a restart, including edits, order and files. Unfinished work pauses for you to check what was done. Use `/resume` or send an ordinary message to continue; the saved queue follows. Teams keep who was assigned each message and how far each member had read. A member that already finished supplies its saved result without running again. Requests between teams stay saved too; resume the receiving team to continue a paused request. **Stop** takes back the saved queue. Delegated tasks keep their handles and saved answers for six hours across restarts. API-model tasks whose saved turns can resume keep the same handle open until their final answer is ready; an interrupted task reports that it could not finish instead of starting again by itself.
- **Changing course while it works.** The button under the paperclip is **Stop** while something works and the box is empty, and **Send** once you type. A message you send then doesn't wait, and queued messages keep waiting:
  - In an agent chat, an agent on an API model, Claude Code, pi or oh-my-pi doesn't stop: it reads your message between its steps and carries on with it. Your message shows inside its turn, marked "Read while it worked". If it was already writing its final answer, it finishes that and then answers your message too. Until a Claude Code, pi or oh-my-pi agent has read it, your message waits at the top of the queue marked "Sent": **Stop** gives it back like any queued message, and if the agent finishes without reading it, it goes next as its own message. Other agents (Codex, Hermes, OpenClaw) stop what they are doing and take your message up right away, carrying on from what they did so far. A `/goal` and a `/loop` carry on too. If the agent is slow to stop, your message waits at the top of the queue and goes the moment it has. Not while the agent works for a team or another agent (they wait on its answer): `/queue` your message instead.
  - In a team chat, whoever is working takes it up, unless you @mention someone else or reply to a message. Agents on an API model, Claude Code, pi or oh-my-pi read it without stopping, and answer it in their reply. The others stop: their stopped turn stays in the thread with its steps open, under a quiet "Stopped to take your new message" line.
  - An agent that stops keeps what it did before the stop and is told its last turn was cut off, so it builds on that work instead of starting over.
  - In Brain chat, the answer the Brain is writing stops (it changes nothing) and your new message is answered now; the Brain still knows what you asked before. Agents and teams it handed work to carry on. An answer that was already carrying out what it decided still finishes, and shows in the chat. A message to a team from Brain chat changes that team's course the same way.
- `/stop` stops the work, like the **Stop** button. Queued messages come back to the box instead of being sent. In Brain chat it also stops the agents and teams the Brain handed work to, and an answer it was still writing changes nothing.
- `/resume` picks up work that was stopped: the agent carries on where its turn was cut off, a team's interrupted agents start again (also after a restart or the team paused at its turn limit), and in Brain chat what the last `/stop` cut off.
- `/resend` sends your last message again, with its files.
- `/loop <message>` repeats a message. `/loop 15m check the build` sends it every 15 minutes, never while a turn is still going; `/loop 5x improve the tests` sends it again after each answer, 5 times. A loop runs 10 times unless you say otherwise (at most 100). It shows above the box with **×** to end it; `/loop off` or `/stop` ends it too. Loops last until the dashboard restarts; use a Routine for anything permanent.
- Assignments in agent, team and Brain chats get automatic completion checks by default. A greeting or a simple question is not an assignment: it gets no goal and closes quietly once answered. When your message asks for real work, the agent (in a team, the lead) sets the goal itself, saying what done looks like, and it shows above the box at once. If it doesn't, the Brain's check after the reply decides whether the message was work, and the goal shows from then on. The Brain follows up on missing work while results advance. It checks tool results as well as replies, and waits for background delegates and other teams before judging the result. Completed work is reported as finished; a missing account, approval, decision, unrecoverable error, impossible request, or repeated lack of progress is reported separately in **Needs you**. Answer the question or send a message to continue. Work stays in its project when you open another one. After a restart, unfinished work and its checks pause until you resume it or send a message. **Stop**, clearing the chat, and deleting it cancel continuation.
- `/goal <what done looks like>` supplies an explicit completion condition. It works even when ordinary completion checks are off. `/goal` alone shows the current condition, `/goal clear` drops it. In Brain chat, the Brain hands the goal to the right agent or team and follows up there. Productive work has no fixed follow-up limit; three consecutive checks without new progress stop and ask for your help. Temporary connection and service errors retry up to three times; authentication, credits, limits and other errors that need you stop with a question. The Brain's model must be set up for completion checks, and each check uses that model.
- `/compact` (agent chats) shortens the chat; see Long chats.
- `/clear` (team chats) empties the chat after you confirm, and each agent forgets the conversation.

Commands the dashboard doesn't know go to the agent as you typed them. A Claude Code agent's own commands and skills (from `~/.claude` and its work folder's `.claude`) are listed in the **/** menu too.

When you paste a lot of text (more than 10 lines or 800 characters) into an agent, team or Brain chat, the box shows a short `[Pasted text #1 · 52 lines]` instead, with a chip above it. Click the chip (or the marker) to see what you pasted, copy it, remove it, or put the whole text in the box to change it. Backspace right after the marker removes it. The full text is sent in its place.

Use the paperclip, drop files and folders, or paste them (**Ctrl+V**, **⌘V** on macOS) into a chat, the Brain on the Station, the team builder or the New project dialog. A pasted screenshot is saved as `pasted-image.png`. Pasting on the Station, outside a text box, gives the files to the Brain. Text copied from Word, Excel or a web page still pastes as text. Attachments are saved under the project folder's `uploads/` directory, and the agent or Brain receives their paths. Files attached in the team builder are shared with every team member.

Eve sends attached images and documents as native model inputs, with a limit of 16 MB per file and 24 MB per turn. Context limits can be tighter: it budgets instructions, tools, text and files before sending, including PDF pages. A request that Eve could shorten during compaction is rejected intact; use smaller attachments or ask the agent to read files with its tools. The model must support the attached media. Tool results can supply up to six images of 5 MB each to the model; a result says when an image cannot be supplied.

Click an attached picture, Markdown file or PDF to look at it, before or after sending: pictures open big, Markdown opens to read, and a PDF opens in a new browser tab (once it has uploaded). A big picture fits the window; zoom with a click (click again to zoom back out), the scroll wheel, a pinch, the **−** / **+** buttons or the **+**, **−** and **0** keys, and drag to move around.

Clicking the Brain on the Station shows what is in its folder. Pictures, Markdown files and PDFs there open the same way, so does **from PROJECT.md** under the description, and a folder opens in Finder or Explorer.

## Overview

**Overview** shows every project at once. It isn't in the sidebar for now: open it by going to `#/overview` in the address bar. Each project lists its agents, its teams, the Brain, its terminals and the board tasks an agent or team works on. Each one shows how it's doing: a small breathing dot while it works, and an amber **!** when it needs you. That means an approval, a question it asked you, or work that stopped and waits for you; point at the **!** to see which.

- **Show** picks **This project**, **All projects** or one project. **Sort** puts the ones that need you first (the default), or orders them by last update, by kind, by name, or in **Your order**: then drag them up and down within their project.
- The star next to one pins it to the top of its project. Click a project's name to fold it. **Search** narrows the list by name.
- **Needs you** and **Working now** list them across what is shown, with **Open** next to each. The line at the bottom counts them: "2 need you · 4 of 7 working · 3 projects".
- Clicking an agent, a team or a terminal opens it on the strip, beside the others, whichever project it is in: you can write to an agent or a team of another project without opening that project (its pane says which project it is, the files you attach go to that project, the files it mentions show their previews, and its MEMORY.md is the one it has there). A task opens on its page.
- The Brain of another project opens on the strip too: its conversation, a box to ask it something (with files), the answer as it is written, its MEMORY.md, and **Open** on the work it hands to an agent or a team, which opens beside it. The open project's Brain opens in the Brain chat at the bottom, which also has who a message goes to, /goal, /loop and /queue.
- A copied project's agents and teams can sit beside the originals: each pane talks to its own project.
- Your choices (what is shown, the sort, pins, folded projects) are remembered in this browser.

**The strip.** Open chats and terminals sit side by side and keep their width; the strip slides sideways instead of squeezing them.
- **−** and **+** at the bottom right choose how many fit in one view (1 to 8). The dashes beside them are the panes, the one in use longer; click one to go to it.
- Drag the line at a pane's right edge to make it wider or narrower.
- A pane's **…** menu pins it at the left (it stays in view while the rest slides), stacks it under the pane before it (up to three in one column; drag the line between them to share the height), moves it, opens it in a chat window, or closes it. A terminal's menu can also end it.
- Drag a pane by its grip (⋮⋮) onto another: its left or right quarter puts it before or after, its middle stacks it.
- Panes out of view show as small marks at the edge, with a dot when they work or need you; click one to slide to it. Chats far out of view aren't drawn until they come back; terminals stay connected.
- **New terminal** (the terminal button next to the open project's name) opens PowerShell (or your shell) in the project's folder as a pane. Terminals belong to the project they were opened in.
- One strip for all projects, remembered in this browser.
- **Panels** beside the strip, one at a time (the buttons at the bottom right):
  - **Needs you**: approvals to decide right there, then the questions, stopped work and tasks waiting for you, each with **Open**.
  - **Tasks**: the open tasks of what is shown, by column; click one to open it, or make a **New task**.
  - **Files**: a project's folder, one level at a time. Pictures, Markdown and PDFs open in their preview (another project's open in a new tab). **Open in VS Code** and **Show in Finder** (or Explorer) open the folder you are in.
- A pane's **…** menu also has **Open folder in VS Code**: an agent's own workspace, or the project folder for a team or a terminal.

| Keys (**Ctrl+Alt** on Windows, **Ctrl+⌥** on macOS) | What they do |
|---|---|
| **1** … **9** | Go to pane 1 to 9 |
| **[** and **]** | Previous and next pane |
| **Shift+[** and **Shift+]** | Move the pane left or right |
| **−** and **=** | Fewer or more panes in one view |
| **0** | Even the panes out |
| **P** | Pin the pane, or let it go |
| **S** | Stack the pane under the one before, or take it out |
| **W** | Close the pane |
| **N** | Open the next one that needs you |
| **O** | Open the pane's folder in VS Code |

On a keyboard where **Ctrl+Alt** (AltGr) types a character with one of these keys, such as **[** or **ó**, it types that character instead.

## Tasks

Open **Tasks** in an agent, team or Brain chat to see the steps of a job. Agent and team chats show their own list and project tasks assigned to them. The Brain starts with **All project tasks**; filter by the Brain, a team or an agent, then by status or a search phrase. Lists update as work changes.

Use **Add task** to write a title and description of what must be done and how to check it. Choose an owner, or leave shared work unassigned. Click a task to edit its details, owner, status, working label or prerequisites. **Open** shows unfinished work; choose **All statuses** to include finished tasks. **Show more tasks** loads the next page. Prerequisite choices come from the loaded rows in the same list; clear a search or load more rows to include another task. **Remove** asks first and removes that task's dependency links too. If someone changed a task while you edited it, your draft stays open; **Reload saved task** loads their saved version.

Use **Clear tasks** beside **Add task** to remove all open tasks in the selected list. Confirm the popup to clear them; completed tasks stay. The button is disabled when the list has no open tasks. Search and status filters do not limit which open tasks are cleared.

Every engine receives the dashboard's `TaskCreate`, `TaskGet`, `TaskList` and `TaskUpdate` tools. The Brain uses the same saved records. Agents can read their own lists, their teams' lists and project tasks assigned to them or their team. The Brain and the user can manage the whole project. A task's list stays fixed; its owner can change within that list. Team tasks can belong to the team or a member, and project tasks can belong to the Brain, an agent or a team.

`TaskCreate` and `TaskUpdate` also accept a `tasks` array, with no per-call task-count cap. Each item has the same fields as a single task or update. Items run in order, with a result or error for each; successful items stay saved if another item fails. Agents retry only the failed items. Put prerequisite completion before dependent completion in the array. A deletion anywhere in a tool batch asks for the normal approval before any item runs. Existing single-task calls keep their original responses.

Tasks start **Pending**. A worker claims ready work as **In progress**, checks the result, then marks it **Completed**. Another agent cannot take a task already claimed by an agent. A task with unfinished prerequisites is **Blocked** and cannot start or finish until they are complete. Dependencies must be in the same list; cycles are refused. Reopening a prerequisite returns dependent work to Pending so it gets checked again.

Creating or assigning a task records the plan. Ask the agent, team or Brain in the chat to do the work. During supervised work, unfinished tasks linked to the assignment prevent a premature completion report. Completing every task still requires the Brain's usual check of the requested result. A blocker continues to go to **Needs you**.

**The Tasks board** is something else: **Tasks** in the sidebar holds the project's own tasks, the work you track, apart from the step lists agents keep in their chats. Each task has a number (#12), a title, a description, a priority (Urgent, High, Normal, Low) and someone who has it (you, the Brain, an agent or a team). They sit in five columns: **To do**, **In progress**, **In review**, **Blocked** and **Done**.

- **New task** (or **+** at the top of To do, In progress or In review) opens a window with a big title, its description, and pills for its status, priority, who has it and its project. **Create another** keeps the window open for the next one; **Ctrl+Enter** creates it.
- Drag a card to another column or up and down its own: a copy follows the pointer, a gap opens where it will land, and the card glides into place. Or focus it and press **[** / **]** to change column and **Alt+↑** / **Alt+↓** to move it within one; the card's **…** menu does the same and has **Remove**. Click the person mark on a card to give it to you, the Brain, an agent or a team. Moving a card to **Blocked** asks why; the reason shows on the card until it moves on. If the task was changed somewhere else a moment before (by the Brain or in another tab), the move is refused and the card goes back.
- Click a card to open its page: the title to edit in place, the description shown as Markdown (**Edit** to change it), its status, priority and who has it, and when it was made and changed. **Copy a link** gives an address that opens it again. If someone changes the description while you are editing it, **Save** asks before replacing their version with yours.
- **Comments.** Under **Activity** on a task's page, leave a comment (Markdown supported; **Ctrl+Enter** sends it); yours can be changed or removed.
- **Mentions.** In a description or a comment (and in the New task window), type **@** to mention one of the project's agents or teams, or a skill: it shows as a pill while you write and when you read it, a team's and a skill's with their icon. The Brain can mention them too. A card shows how many comments it has. The Brain reads them and can add its own.
- **Draft with the Brain** in the New task window, under a description you are editing and under the comment box: say what it should say (or leave it empty), and the Brain writes a draft into the box from the task, its comments and what is there. Nothing is saved until you save; **Undo** takes the draft back.
- Choose **This project**, **All projects** or one project above the board; in **All projects** each card says which project it is in, and the choice is remembered on this PC (if that project is removed, the board goes back to This project). A change is saved in the task's own project, whichever project is open. Search, **Assigned to** and **Priority** narrow the cards. Done shows the last 14 days; **Show older** shows the rest.
- **Agents and teams pick up their tasks.** Move a task that is given to an agent or a team to **In progress** (or make it there, or give a task that is already In progress to one) and they start on it at once: "Writer started on #4" appears, with **Stop**. An agent works in a chat of its own for that task; a team works in a thread of its own for it, apart from its main chat, so two tasks given to one team don't mix. They comment on the task as they go, attach the files they made, and move it to **In review** when it's done or to **Blocked** with the reason when they can't finish it. They never move it to Done; you do. When they stop without saying, the usual completion check settles it: finished work goes to In review with their answer as a comment; work that needs you goes to Blocked with the Brain's note, and the question waits in **Needs you**.
  - A card shows a small breathing dot while someone works on it, **Needs you** while it waits for your OK on a step, and **Check** when it needs a look.
  - The task's page has a **Work** box: who has it and how it goes, with **Stop**, **Start** (or **Start again**), **Open chat** (or **Open thread**) and, when the dashboard couldn't tell how it went (a restart in the middle, say), **Check saved work**, which looks again without starting anything twice.
  - Your comments reach them while they work, with their files, and so does a description you change. Moving the task to another column, giving it to someone else or removing it stops the work; the board asks first.
  - The Brain's own moves on the board never start work.
- **Files.** Attach files to a new task, to a description you are editing and to a comment (the paperclip, or drop or paste them). They are kept with the task in its own project (copied there when you work in All projects) and go to whoever works on it. Pictures show as thumbnails; a card shows how many files it has.
- The Brain sees the board and can manage it: ask it to "put that on the board", "move #12 to review", "give #4 to the Writer" or "what's blocked?". Tasks it adds say they were made by the Brain. It moves a task to Done only when you say so or it has checked the result; otherwise finished work goes to In review. A Brain answering you on Telegram, Slack or Discord doesn't see the board and can't change it.
- The board is included in folder saves, backups and clones. Backups and clones take the files on its tasks and comments too, as many as fit (a backup holds up to 512 MB in all); any that don't are counted as left out.

Tasks survive restarts and are included in folder saves, backups and clones. Opening a saved copy keeps task IDs and dependency links, resets In progress tasks to Pending and drops old completion-check links. Each project's tasks remain separate when you switch projects.

## Skills: instructions worth keeping

Skills use Claude Code's `SKILL.md` format. Assign them to an agent, a team, the whole project or the Brain.

- **Write or change one in plain words.** Ask for something like “Short release notes, with user-facing changes first.” The Brain fills in the editor for you to review and save. Undo restores the previous editor contents.
- **Bring your own.** Import Claude Code skills or install from a GitHub repository, folder or `SKILL.md` link. Installing the same skill again updates it. Private repos use `gh auth login` or `GITHUB_TOKEN`.
- **Let the Brain manage assignments.** It can create, edit, assign, remove assignments, install and delete skills.

By default, the Brain only installs from GitHub repos **you named in Brain chat**. Links found in files, web pages or agent replies do not grant permission. **Install skills from any GitHub link**, under The Brain's model settings, relaxes that rule; leave it off unless you trust those sources.

The Brain starts with a **Self-improvement** skill. After substantial agent work, it can review the outcome and save a useful workflow as a skill, improve an existing skill or assign one where it is needed. Changes are reported in Brain chat. The review is limited to skills and cannot change the Brain's own skills. Remove Self-improvement from the Brain on the Skills page to turn it off.

The library also comes with the **storytold skills** ([hermes-pro/storytold-skills](https://github.com/hermes-pro/storytold-skills)), one per [storytold Crafting App](https://github.com/storytold): VectorCraft, PhotoCraft, LightCraft, EffectCraft, FilmCraft, DesignCraft, PdfCraft, WordCraft, GridCraft, DeckCraft, SoundCraft, CADCraft, FigCraft, SolidCraft (3D parts, from Tangency Labs), MaterialCraft, TextureCraft and Craft Anything. Two more come with them: **storytold** picks the right app for a creative task, and **storytold-install** installs the apps and sets up their MCP servers. They aren't given to anyone until you assign them. Delete the ones you don't want; they stay deleted. **Download again** gets the latest version from GitHub; skills added in a newer version of the dashboard show up in the library by themselves. When a Crafting App's MCP server is set up, the map's **Connected to** row shows it with the app's own icon.

Two more sets come with it, for connecting agents to your accounts and apps: the **OOMOL skills** ([oomol-lab/oo-cli](https://github.com/oomol-lab/oo-cli)): **oo**, which reaches your connected accounts, OOMOL's hosted AI and Open Flow workflows, plus **oo-find-skills**, **oo-create-skill** and **oo-publish-skill**; and the **Composio skill** ([ComposioHQ/skills](https://github.com/ComposioHQ/skills)), **composio**, which uses more than 1,000 apps through the Composio command line tool. Both need their command line tool (`oo` or `composio`), which isn't part of the dashboard. They work the same way: not given to anyone until you assign them, and deleted ones stay deleted.

The **Orca skills** ([stablyai/orca](https://github.com/stablyai/orca)) come with it too, for agents working inside [Orca](https://github.com/stablyai/orca): **orca-cli** (worktrees, terminals and Orca's browser), **orchestration** (several Orca agents working together), **computer-use** (clicking and typing in an app window), **orca-linear**, **orca-jira** and **jira-tickets** (Linear and Jira tickets), **orca-emulator** and **orca-emulator-android** (iOS and Android emulators) and **orca-per-workspace-env** (a fresh sandbox for each workspace). Each one loads its full guide from the installed Orca app, so they need Orca. Same rules: not given to anyone until you assign them, and deleted ones stay deleted.

**Athena's own skills** come with it too, written for the dashboard so they work on every engine and on Windows. They cover coding (**systematic-debugging**, **test-driven-development**, **spike**, **requesting-code-review** for a check before you commit, **github**, **dogfood** for testing a web app, **ast-grep**, **grill-me**, **rest-graphql-debug**, **docker-management**, **jupyter-notebook**, **fastmcp** for MCP servers), documents and finance (**pdf**, **docx**, **xlsx**, **powerpoint**, **financial-models**, **stocks** for market data and SEC filings), research (**arxiv**, **grounded-citations**, **llm-wiki**, **rss-feeds**, which also reads Reddit without an account, **youtube-content**, **maps**), everyday work (**email**, **action-items**, **weekly-review-planning**, **decisions**) and **humanizer** and **comfyui**. Some run Python scripts that come with them, which need Python 3.10 or newer and the packages the skill names; the agent asks before installing anything. They replace the copies of Hermes Agent's skills that used to come with it (`skills/athena/README.md` says where each one went). Same rules: not given to anyone until you assign them, and deleted ones stay deleted.

One more comes with the dashboard itself: **Start agents in Orca**. Give it to an agent and it can start Claude Code, Codex, pi, oh-my-pi or OpenClaw in Orca, each in its own worktree with a task brief. It first checks that Orca is installed; if it isn't, the agent says so and starts nothing. When Orca is installed on this PC, creating or opening a project turns it on for the whole project, so every agent in it has it.

Agents read a skill's extra files with `read_skill`. They can search long reference files instead of reading them whole, or read them in parts. `read_skill` also tells them the skill's folder, so an agent with a shell can run the scripts that come with it; where a skill installed from Hermes Agent names Hermes's own folder for it, that is pointed at the skill in the library.

## MEMORY.md: what agents remember

Every agent, and the Brain, keeps a **MEMORY.md** for each project: short notes it carries from one chat to the next, such as how you like things done, decisions you made and mistakes to avoid. It reads them with every message.

- **Agents add to it as they learn**, with the memory tools every agent has. With **Ask first** autonomy you approve each change.
- **The Brain keeps its own** and can add a note to an agent's memory when you ask it to ("Tell the Writer to remember we use British spelling"). It never rewrites an agent's memory, and the self-improvement review can't change any memory.
- **Read and change it yourself.** Open an agent's editor or its chat page and use **MEMORY.md**. For the Brain, use the page icon at the top of the Brain chat, or **Settings → The Brain's model**. **History** shows earlier versions, who changed them and can restore one.

A chat's **Clear memory** button is different: it starts that chat fresh and leaves MEMORY.md alone (pressed while the agent answers, the answer it is writing is forgotten too). Don't keep keys or passwords in a memory.

## The voxel world

The Station can be a voxel world the Brain and your agents build around themselves: a diorama, a miniature scene you look at, not a game level anyone walks through (agents are told so, so nobody plans routes or playtests). Builders work big to small: the shape of the terrain first, then the buildings, then the props. The classic dark map stays the default: turn the world on in **Settings › Appearance › Station look** (Voxel world) and pick a quality (Low for older computers; High adds softer creases).

Each project can have its own background picture behind the map: click the Brain and choose **Add background**, use **Settings › Appearance › Station look › Background**, or ask the Brain (*"use the photo I attached as the background"*). The Brain can use a picture you attached or one in the project folder, and take it away again. In the classic look the picture is dimmed so the map stays easy to read; in the voxel look it takes the sky's place. Under the picture in **Settings › Appearance**, **Picture opacity** sets how strongly it shows (50% in the classic look and 100% in the voxel look unless you pick one) and **Map dots opacity** fades the dots on the classic map's floor (0% hides them); **Default** puts one back. Both are kept per project, and the Brain can set them too (*"make the background fainter"*, *"hide the map dots"*). Builders' `world_look` pictures still show the world's own sky. The picture is kept in the project folder (`.dashboard/background.*`), so it travels with the folder and goes into backups.

- **Ask the Brain for one.** Describe the world you want. The Brain asks a few questions (theme, mood, era, colours), writes **WORLD.md**, builds the big pieces itself and hands the details to a builder. The **World Builder** (Agent library › Athena) comes ready with the **Voxel world** tools and the **Voxel building** skill; you can give the tools to any agent in its editor.
- **WORLD.md** says what the world is: its theme and meaning, look, feel, places, characters, story and rules. Every builder reads it before building and updates it as they go. You can edit it too. Earlier versions are kept.
- **Nothing comes ready-made.** Builders make big pieces (ground, buildings, rivers) as objects, and the small things there are many of (people, trees, lamps, cars, boats) as **prefabs**: made once, then placed many times, scattered, along a street or in a grid, turned to any angle and recoloured per copy. Hundreds of copies cost the page very little. A builder can turn part of an object into a prefab, and share a good prefab with every project through the **prefab library**.
- **Agents build near their team.** Builds pinned to a team move with it when you drag its platform. One build call changes at most 250,000 voxels and places 2,000 copies; a world holds up to 4 million voxels and 20,000 copies, and one object or prefab can show at most 20,000 copies, counting copies inside copies.
- **Light, weather and life.** Glowing voxels (lanterns, windows, signs, headlights) light up what is around them. Builders can also put up lights (a doorway's warm spill, a spotlight, a flickering fire), set the time of day, sky, fog, weather and wind, and add particles in an area: petals, leaves, snow, rain, fireflies, embers, sparks, smoke, steam, mist, dust, birds. Finishing touches put snow on every ledge the sky can see, moss and vines on old walls, and wear near the ground.
- **Agents take a form in the world.** An agent can be dressed in a voxel form of its own: a person, an animal, a tree, a lamp, anything a builder makes, with a desk if it wants one. Builders design its animations themselves (keys per part: an arm that types, a crown that sways, a crystal that spins) and pick which plays while the agent is idle, working or waiting for you; they can also play one once, like a cheer when work is done. Team platforms and the Brain can be dressed too. For the sake of the picture, a builder can also take an agent, a platform or the Brain off the map (and their name labels): they keep working, and the side panel and Agents page still open them. Dressing yourself or your own team needs no OK; anyone else, or the Brain, asks you first.
- **Voxel size** is per object and can change in the middle of a build: coarse for ground, fine for small props and characters. Builders give sizes and positions in map units (the same numbers `world_info` and the team's plans use), whatever the voxel size; `world_steps` lists every build step there is. For anything repetitive or procedural (a lane of cottages that each differ, trees that branch, terrain from noise), a builder can give `world_build` a small JavaScript program instead of steps. It runs sealed off from your computer (no files, no network, at most 20 seconds) and builds through the same steps, so the same limits, undo and all-or-nothing apply.
- **The World panel.** The globe button above the zoom buttons (voxel look only) opens it: **WORLD.md** (read, edit, history and restore), **Built** (objects by builder with Hide and Delete, prefabs and where they are used, recent changes and *Undo the last change*), **Look** (time of day, weather, glow, miniature blur, lights and effects, and who is off the map, with *Show on the map*), and **World** (below). The project menu's **Voxel world…** opens the world picker in any look.
- **Builders look at their work.** `world_look` gives an agent a picture of the whole world or one thing in it, from any angle, made by an open Station page in the voxel look. When the Station is in the classic look, the agent asks you first: **Turn on the voxel look** in Needs you switches it (only you can answer that; the Brain's approvals don't). Without a picture it gets a map in words, and is told why so it can ask you. You can also ask the Brain to turn the voxel look on or off. `world_info` tells builders where every team platform and desk stands, with the same numbers the Station draws. New builds rise into place, with a beam from the builder's desk.
- **Files in and out.** Builders can bring in MagicaVoxel `.vox` models (as prefabs or objects) and save an object, a prefab or the whole world as a `.glb` 3D model (for Blender, game engines, the web) or a `.vox` file. The World panel has the same exports and a **Save a picture** button; all of them go to **Artifacts** and the project folder's `exports/`. Good prefabs can be shared with every project through the **prefab library** (World panel › Built › Library).
- **Undo.** An agent can undo its own last change (`world_undo`). Changing or deleting what someone else built asks you first (unless the agent's autonomy is Full). So does changing a material other builders used (colours are shared by the whole world), rebuilding a prefab others placed copies of, and publishing to the prefab library under a name someone else published there.
- **One world per project, and it carries over.** A project with nothing built yet shows the world you marked as the default, or else the most recently built one. In the World panel's **World** tab you can share another project's world (both build in it), start from a copy, start a new empty one, go back to carry-over, mark the default, rename a world, and delete one no project uses. Its first change (a build, a move, the weather) gives it its own copy, so the other project's world stays as it was; a change that fails or finds nothing to do leaves it carrying over. The world goes into the project's folder (`.dashboard/world/`) and into backups; a restored backup, a clone or the same folder opened as a second project gets its own copy (unless it was shared).

## Routines: work worth repeating

Create a routine, write the instructions, and **@mention** the agents or teams that should do the work and the skills they should use. Each mention shows as a pill, as in a team chat's message box, with an icon for a team or a skill; **×** on a pill takes it out. Use **Run now** to run its saved instructions, or set a schedule. A new routine is only saved once it has something to do. Every routine has a sliding switch, on its card in the list and on its page, to switch it on or off: a routine that is off doesn't run, by hand or on its schedule. The same switch controls manual and scheduled runs. A daily schedule can have several times; use **Add time** to add another. Pick the hour, minute and AM/PM, then press **OK**. The routine card shows every time and the selected days. Each run records what its agents and teams did. On the Station, a team's **Setup** tab lists the routines that mention it; **New routine for this team** starts one with the team already mentioned.

In **Runs**, expand a run to see each agent's or team's result. Markdown in a result is shown formatted, and **Chat** opens the conversation.

For example, with those agents and skills already created:

> @Researcher finds the week's main product updates. @Content Team turns them into a short report using @Brand voice.

## The Brain and your teams

When the Brain hands work to a team, it writes in the team chat as **Brain**, so the work goes out even when no browser tab is open. Work for a single agent starts a new chat with that agent. Brain chat follows that work below the Brain's answer, and it shows the same after you reopen the app: the files the Brain read, what it changed, and the agent's or team's work it handed on.

**Who answers in a team chat.** Agents you **@mention** answer. Otherwise: the agent whose message you replied to; else the only member with what the message needs (Blender, Maya, Houdini, Substance 3D, CAD and 3D printing, NVIDIA, ComfyUI, Adobe, FFmpeg, posting on X or Reddit, Orca, or one of its MCP servers such as GitHub); else the team's lead; else the member who fits best. Agents see who has what in the team roster and hand such work to that member.

If there is no match, the first free member answers. If everyone is busy, the message waits for the first member. A note in the chat names who was chosen and says when the work is queued. A match, a lead, a reply or an @mention still goes to that member even when they are busy.

When several members are assigned the same message, each is told who else has it, including the member who starts first. This helps them divide the work, but does not assign each part for them. Shared messages enter each member's chat with their full original text, including instructions at the end of long messages. The team's saved transcript keeps older messages too; it no longer expires after 500 messages. A member joining later gets the saved conversation. Messages already removed by the old limit cannot be recovered.

**Agents can look up earlier conversations.** Every agent has `search_conversations` to search its own saved chats and the shared threads of teams it belongs to, in this project. It returns matching excerpts and message references. `read_conversation` reads an original message, with explicit pages for long text so the agent can continue to its end. These tools work without granting Files tools. Another member's private chats are not included, and explicitly cleared or deleted conversations are not searched.

**When the conversation fills the model's memory.** The normal Chat memory settings decide when to compact; saved originals remain available through the conversation tools. Current addressed requests stay in full. If a request itself is too large for the selected model, the turn reports that it cannot fit instead of clipping instructions or marking them read. Choose a model with more room or split the request. Failed turns leave the read mark unchanged, and retries keep the full messages.

**Team members finish their part.** Each agent in a team is told to finish the work it's given rather than decline it or stop partway, to start its own part without waiting for teammates, to install what it needs, and to ask for missing tools (see **Agents ask for tools**) or ask you for access and keys.

**How long a team keeps going.** Agents keep handing work to each other until the work is done or you press **Stop**. There is no limit on turns. Only chatter pauses a team: when 8 replies in a row are only talk (no tool used, a short reply), like two agents passing the work back and forth, the team stops and says so. Reply, mention someone or use `/resume` to keep going.

- **A team gets the tools its work needs.** Each agent from the Agent library comes with the tools its own role needs, and the Brain gives the team what else its work needs: **Social** when it posts or messages anywhere (X, Reddit, Telegram, Discord; posts wait in the Outbox for your OK), the voxel world tools when it builds the world, and the image, 3D or video tools for that work. A team whose name or goal mentions posting or the voxel world gets them even if the Brain forgets; if you take a tool away from a team, it stays away. Every agent can hand in finished results to **Artifacts**.
- **Ask the Brain from a team chat.** Anyone in a team chat, an agent or you, can write **@Brain** to ask a question or say they're stuck. The Brain answers in the thread and may pass work to a teammate. An agent's request can't make it change agents, teams, skills, routines or settings (an agent asks for tools with `request_tool` instead, below): when the team needs something only you can give, such as an account, a teammate or a decision, the Brain tells you in Brain chat.
- **Teams ask each other.** In a team chat, an agent or you can write **#Team Name** (type **#** to pick one) to ask another team in the same project. The message goes to that team's chat, marked with the team it came from and who asked, and is answered there like a message from you. Once that team is done, its last reply comes back to the team that asked, to the agent that asked, who carries on. When you write it, nobody on your own team starts unless you also @mention them. A team asks other teams at most 4 times per message you send, and teams asking teams stops 3 deep. If the team you asked is stopped, the team that asked is told.
- **The Brain follows up.** Direct assignments and work handed out by the Brain are checked automatically after each turn. Greetings and simple questions aren't treated as assignments. Missing work gets a concrete next step, without requiring you to type a command. Completion and blockers are separate: only delivered work is called finished. A blocker or repeated lack of progress creates an actionable question in **Needs you**. Direct assignments report in their chat; work handed out by the Brain reports in Brain chat. Turn ordinary checks off with **The Brain follows up** under **Settings → The Brain's model**; explicit `/goal` requests still get checked. Existing approval rules and Outbox review still apply.

## Models, effort and stopping work from Brain chat

- **Switch models and effort.** "Put the video team on Opus at high effort" changes one agent, several agents or every agent on a team. The Brain checks model names against the provider's list before it changes anything.
- **Look up models.** "Which Gemini models are on OpenRouter?" or "Which Venice models support tools?" lists matching models with prices and context size. Ask "which model is each agent on?" to see every agent's model and effort.
- **Stop work.** "Stop the Writer", "stop the video team" or "stop everything" stops an agent, a team, or everything running in the open project: teams, agents, routines and workflows.

The Brain changes models or stops work only when you ask.

## MCP servers from Brain chat

The Brain can set up MCP servers and decide who gets them, the same as **Settings → MCP servers**.

- **Add one.** "Add the Playwright browser and give it to the Researcher." The Brain prefers the ready-made servers and the ones it finds in your Claude Code or Claude Desktop settings. For any other server, give it the exact command or link: "Add the weather server: `npx -y @acme/weather-mcp`". Ready-made servers that need a key (Brave Search, Firecrawl, ElevenLabs, Tripo, Meshy, Sketchfab, Unsplash, Pixabay, Pexels, Topaz, OOMOL, Composio) are added with the key you type in the chat: "Add Brave search, my key is …". The Brain asks for it if you leave it out, and tells you any setup step outside the dashboard (the ones that control an open program, such as Unity, Maya, Houdini, Substance 3D Painter, GIMP, Krita, Audacity, REAPER, MuseScore, OBS, FreeCAD and Rhino, need something turned on or installed in that program). The services' own servers need no key at all: Notion, Linear, Jira and Confluence, developer services (GitLab, Sentry, Vercel, Netlify, Cloudflare, Supabase…), Canva, Freepik and the others open a browser window to sign in the first time they run. A second account of one of these signs in on its own. The docs, search and travel ones (DeepWiki, Microsoft and AWS docs, Wolfram|Alpha, Kiwi.com flights, trivago hotels) need nothing. The 3D printer server needs your printer's type, address and key, and asks before it prints. The Audacity server works with Audacity 3 only.
- **Suggestions.** Settings → MCP servers starts with **Suggested for this PC**: the ready-made servers for programs found on your PC (Blender, Maya, GIMP, OBS, Unity…) and a few that help most agents (web fetch, library docs). When the Brain builds a team or agent that would use one of them, it says which and why and offers to add it. It adds a server only when you say yes: each one runs a program from its maker on your PC.
- **Change one.** Change its command, link, keys, description or name, or turn it off and on. A new name is updated on every agent and team that has the server.
- **Several accounts of one service.** "Add a second OOMOL for my client work." Another account of a server you already have needs a label and a line saying what it is for; the Brain asks you for both, and for the line of the one you already have. It gives an agent or team the account whose line fits its work. It gives one agent two accounts of the same service only when its work spans both (an assistant for your work and your personal mail), and only when each account says what it is for; otherwise it swaps one for the other. When none fits, it asks you. The agent is told which account is which and says which one it used, and an approval names the account (**… on OOMOL: Work**). While an agent works for a team, the team's account of a service takes the place of the agent's own. On **Settings → MCP servers**, **Add another** on a preset does the same, and **Same service as** in a server's settings joins one you added by hand to a service (**Its own service** keeps one apart that only looks like a ready-made one). Renaming a server keeps it with its other accounts.
- **Give, take back, move.** Give a server to agents or teams, take it back, or move it from one to another. A team's servers are available to every member while they work for that team.
- **Remove one.** "Remove the weather server" deletes it and takes it off every agent and team, in every project. The Brain removes a server only when you ask.

A server runs a program on your PC or connects to a site, with the keys you give it. So the Brain only uses a command, link, environment variable or header **that you typed in Brain chat**. For a new program that means the whole command, as you wrote it (`npx -y @acme/weather-mcp`, not just "weather"). For a link, the site must be one you wrote. Commands found in files, on web pages or in agent replies are refused. When a server needs a key, the Brain asks you for it. It doesn't write the key back in its reply, and its view of your servers shows key names, not their values, and hides anything in a command or link that looks like a key or password. The server starts the next time an agent that has it runs.

Renaming or removing a server also renames or removes the tools you always allowed for it, so a new server with an old name starts with nothing allowed.

## Programs for 3D, textures, video, audio, CAD and 3D printing

The **Programs** page finds what is installed and sorts it into 3D and animation, images and design, video, audio and music, CAD, 3D printing and NVIDIA. You can start any of them from there. If one is installed somewhere unusual, set its path in **Settings → Programs**.

Agents use some of them directly when you switch on that tool group for the agent:

| Tools | What agents can do |
|---|---|
| **ComfyUI** | Run your saved ComfyUI workflows with a new prompt, settings and input pictures (with a mask for inpainting), and get the pictures, video, audio and 3D files back. The agent also hears which parts ComfyUI left out and why. Start ComfyUI Desktop and wait for it; when Desktop won't start ComfyUI by itself, the agent tells you what to click. Workflows are found in every install Comfy Desktop knows of, and in the extra folders you add in **Settings → Programs**. |
| **Maya** | Run Maya Python without opening the window: build scenes, key animation, render and export. Open Maya with a scene. |
| **Houdini** | Run Houdini Python (hython): build node networks, simulate, render and export. Open Houdini with a .hip file. |
| **Substance 3D** | Render a Substance material (.sbsar) to texture maps at the size you want, using Designer's sbsrender. Open Painter (with remote scripting on, for the Substance Painter MCP server), Designer or Sampler. |
| **CAD and 3D printing** | Turn OpenSCAD models into STL, 3MF and other files. Slice a model into G-code with PrusaSlicer, using your exported profiles. Slicing never starts a print. |
| **NVIDIA** | See how busy the graphics cards are. Compress textures into DDS files (BC7, BC5 for normal maps, and so on) with the NVIDIA Texture Tools Exporter. |
| **Free asset libraries** | Search Poly Haven and ambientCG and download HDRIs, PBR textures (one file per map) and models into the project. Everything there is CC0: free for any use, no credit needed. No key needed. |
| **FFmpeg, HandBrake and ImageMagick** | Cut and convert video and audio with ffmpeg. Shrink or convert videos with HandBrake presets (needs the free HandBrakeCLI download). Resize, convert and batch-edit images with ImageMagick. |

Running Maya or Houdini Python, ffmpeg or ImageMagick counts as running code or overwriting files, so you are asked first unless autonomy is Full. So does sending pictures to a ComfyUI on another computer; to a ComfyUI on this one, the agent only sends files from its workspace and the folders you allow. The texture, asset, OpenSCAD, slicing and HandBrake tools only read and write in the agent's workspace and the folders you allow.

The ffmpeg, HandBrake and ImageMagick tools work in the agent's workspace, so a relative path lands there, and ffmpeg is told never to overwrite a file it didn't make. Agents on any engine can look at a picture with **View a picture** (in the Files tools): a PNG, JPEG, WebP or GIF up to 5 MB in folders they may use. **ComfyUI** results list the seeds used, so a good picture can be made again; when a workflow has no negative prompt, the agent is told its negative wasn't used. Workflows and outputs from the newer Comfy Desktop app are found too.

For live control of an open program, add its MCP server, for example Maya, Houdini, Substance 3D Painter, GIMP, Krita, Audacity, REAPER, OBS, FreeCAD, Rhino or your 3D printer. Each one says what to turn on in the program first.

Some sites and programs can't be connected because they have no API or MCP server: Envato Elements, ArtStation, 1001 Fonts, Poliigon and Luminar Neo. Mesh2Motion works in the browser at mesh2motion.org; the Programs page finds its desktop app.

## Long chats

API-model agents run through Eve. Eve keeps each session and handles its own context compaction, as the CLI engines do for their sessions. A **Compacted** mark records that the engine shortened its active memory; saved original messages and tool results stay visible and searchable.

The dashboard no longer shortens conversations, writes summaries or lets you edit checkpoints. Use **Clear memory** to start a new session. When changing engines or models, it supplies the saved originals after the last clear. If they do not fit, choose a larger-context model or clear memory; originals are never silently trimmed.

The context meter uses the engine's last measurement when available, otherwise an estimate. Under **Settings → General & keys → Context**, set **Context window** if a model's reported size is wrong.

Eve turns survive an app restart, including saved approvals and questions. Stop ends the native session. Queued messages remain saved. Private runtime files stay on this computer and are excluded from project copies, backups and exports.

An API-model agent's instructions stay the same for a whole turn, so the model provider can reuse them from its cache at every step. A note the agent adds to MEMORY.md or WORLD.md during a turn is in its instructions from the next message; the tool's result already tells the agent what changed.

If a tool may have made changes before failing, the run pauses and a **Check the outcome** request stays in **Needs you**, including after a restart. Check what happened, then allow the request to mark the check done. This does not repeat the tool or resume the interrupted run.

Clear memory retires the old session; if a turn is still answering, the reset takes effect again when it finishes. Deleting a chat removes its searchable originals and tool images. Retired native records remain in private app data on this computer, including prior inputs and tool outcomes. They cannot run again and are never copied into a project or backup. Eve removes a turn's private records 30 days after it ended, once everything it did is in the chat and nothing in it waits for you: no approval, question or **Check the outcome** request. The chat keeps its messages and tool results. Changing engines or installing an incompatible Eve update also retires old sessions. An update interrupts unfinished work for you to review before starting a fresh turn.

Very long chats still scroll smoothly: from 50 messages on, the chat page and the floating window only draw the messages near what you see, so the floating window can show the whole chat too. Because of this, your browser's Find (Ctrl+F) only finds text in the messages near where you have scrolled.

## Light and dark

**Settings → Appearance → Colour scheme** picks **System**, **Light** or **Dark**. System is the default: the page follows your computer, white when the system is set to light and near-black when it is set to dark, and it switches by itself while the app is open. Light and Dark keep it that way whatever the computer says. Your choice comes back the moment the page opens, before anything is drawn. **Accent colour** starts with **Aegean** (`#18688e`, with a lighter tone in dark mode) and picks the highlight colour (**Aegean**, **Olive**, **Gold**, **Terracotta**, **Amethyst** or **Slate**); each one has a light and a dark version, so it reads well on both. A project saved with an older accent (lime, ice, amber, rose, violet or mint) moves to the closest new one. The Station's classic map follows it too: a pale map on a light system, a night map on a dark one. The voxel world keeps its own sky. The page is set in Geist; the font that chats are written in is still your choice under **Appearance**.

## Your Claude and Codex usage limits

- **See them in the sidebar.** Click **Limits** above the list at the bottom of the menu (or pick **Usage limits** under **Settings → Appearance → Sidebar**). In place of what's set up, it shows how much of your Claude and Codex plans you have used in each window (5 hours, the week) and when each starts again. It reads them again every minute. **Status** brings the list back. Each project remembers which one you picked last.
- **And at the top right of the Station.** The same numbers as **Session** and **Week** meters, taking turns every few seconds between Claude, Codex, OpenRouter (credits left) and Venice (separate balances) for each one you've set up.
- **Free Codex resets.** When OpenAI has given your Codex account free limit resets, point at **Codex** in the sidebar: a card beside it says how many you have and when the next one runs out. **Reset now** asks first, then uses the one that runs out first and sets your Codex limits back to 0%. If you haven't used any of your limit yet, Codex keeps the reset.
- **Where the numbers come from.** Claude's come from Anthropic with your Claude Code login; Codex's from the Codex program on this PC (`codex app-server`) with your Codex login. Nothing else is sent anywhere.

## Approvals and safety

### Choose how much agents may do

| Autonomy | When dashboard tools ask for permission |
|---|---|
| **Ask first** | For low- and high-risk actions. Tools marked as having no risk run without asking. |
| **Auto** (default) | For high-risk actions, such as shell commands, scripts and sending messages. |
| **Full** | Tool approvals are skipped. Use only when you trust the agent and its access. |

Agents can't fetch the dashboard's own pages, so a web page can't lead them to your settings. The MCP servers page shows saved keys as dots; leave the dots when you edit a server to keep its key. A failed **Test** shows what the server printed, and a server that refuses its key says so. Slow tools that keep reporting progress don't time out early.

For API-model agents, an MCP server's tool counts as low risk only when the server says it just reads; any other one asks on **Auto** too. A server you turn off isn't started for them.

An explicit **Always allow** choice can also skip later approval requests for that tool, from that moment on in the same run too. Autonomy is not an operating-system sandbox: shell commands and external tools can act with the access of the account running them. Agents' shell commands run in PowerShell 7 when it's installed, otherwise in Windows PowerShell on Windows and in bash (or sh) on macOS and Linux.

**The Brain approves** is on by default. When an agent or team requests permission, the Brain reviews it first. It is instructed to allow routine, reversible work within the task and pass risky or unclear requests to **Needs you**, with a reason. This is a model's judgment, not a hard safety guarantee. Turn it off under **Settings → General & keys → The Brain's model** if you want requests to come to you directly.

Workflow checkpoints and approval requests from outside MCP clients always come to you. X and Reddit drafts wait in the Outbox unless you enable auto-post for that account. **X replies and direct messages always wait for your approval.** The Outbox counts X characters the way X does: emoji and Chinese, Japanese and Korean characters count as 2, and any link as 23. Agents can add alt text to X images and a flair to Reddit posts, and read a subreddit's rules themselves.

**Agents ask for tools.** Every agent has a `request_tool` tool. When its task needs a set of tools it doesn't have (Files, Browser, Programs, Blender and so on), it asks for that set and says why. The request goes to the Brain first, like any approval. The Brain gives it when the task needs it and the tools fit the agent's role, and sends the rest to **Needs you** marked **Asks for tools**. **Shell** always comes to you, and the Brain is told to pass on **Social** (posts and messages). With **The Brain approves** off, every request comes to you. A given set stays on the agent (take it away in the agent's settings), and the agent can use it right away. Risky uses of the new tools are still checked one by one, by the agent's autonomy.

**Questions from agents.** When an agent needs you to decide something, needs something only you can give (a login, a file, an OK) or is stuck, it asks with its `ask_user` tool instead of only writing the question in its reply. The question goes to the top of the **Outbox** and into the **Needs you** drawer, with its choices as buttons and a box for an answer in your own words in both; whatever you write goes along with a choice you click. While the agent waits, the same card shows under its tool call in the chat, so you can answer there too. The agent waits up to 30 minutes (4 for Hermes). If you answer later, your answer goes to its chat as a new message, or to its team chat addressed to it, so it picks up where it stopped. **Dismiss** closes a question without an answer, and stopping the run closes its question.

### What “local” protects—and what it does not

- The server listens on **127.0.0.1** only. Host checks, custom headers for API changes and browser-origin checks help stop other websites from controlling it. X and Reddit sign-in callbacks are allowed back from those services.
- There is **no dashboard login**. Anyone with local access to the running service may be able to use it. Do not expose it through a public tunnel or reverse proxy.
- Stored API keys and account tokens are kept server-side, not sent to the browser or included in project exports. They are saved in local files; protect the machine and its data folder.
- Hosted models, MCP servers and connected services have their own access and data handling. Only enable tools, folders and accounts that an agent needs. Built-in file tools enforce allowed roots; this does not constrain arbitrary shell commands or outside tools.

## Save and restore

### Where work is stored

Local dashboard state lives under **`data/`**, which is git-ignored (the [desktop app](#desktop-app-notes) uses its own data folder): projects, agents, teams, chats, knowledge, MEMORY.md files, skills, presets, settings, the Outbox and activity. Keys are in `secrets.json`; account tokens are in `accounts.json`.

The dashboard also auto-saves project state into **`<project folder>/.dashboard`**, including its agents, teams, routines, chats, MEMORY.md files, assigned or routine-mentioned skills and earlier versions. Opening that folder as a project brings the saved state back. Existing library skills are not overwritten: a different copy from the project folder is kept as a version.

These copies exclude stored keys and account tokens, **not private content you put in chats, knowledge files, memories or skills**. Review `.dashboard` before sharing or committing a project folder.

### Back up a project

Choose **Project menu → Back up this project**. The dashboard writes a `.dashbackup` file under **`Athena Agents Backups`** in your home folder.

A backup includes the project's agents, teams, routines, layout, Brain and agent/team chats, knowledge files, MEMORY.md files, logo and background picture (with its opacity and the map dots' opacity), the teams' pictures and 3D models, `PROJECT.md` and notes, and its voxel world (with WORLD.md and its prefabs). It also includes **every skill and saved preset in your library, and every prefab in the prefab library**, plus earlier versions of the project's agents, teams and memories and of library skills, including deleted items. It does not include stored keys or account tokens.

Backups are not a full copy of your working folder: back up source files, other uploads and generated work separately (the files on Tasks board tasks and comments go in with whatever room is left). Size limits also apply: 300 MB of voxel world, 200 MB of agent chats, 100 MB each of prefab library and team pictures and models, 50 MB each of knowledge files, skills and earlier versions, and 20 MB each of MEMORY.md files and of project brief and notes. A restore adds the library prefabs this computer doesn't have yet and leaves the ones it has as they are. Files that do not fit are left out; the saved-backup message reports the number omitted.

### Restore a backup

Choose **New project → Backup**, then drop in a `.dashbackup` file or choose one from the backups folder.

- Restore creates a new project; it does not replace the original.
- Missing skills and presets are added. If a skill has the same ID but different contents, your existing skill stays and the restored copy gets an `-restored` suffix. Matching skills receive the backup's earlier versions.
- Scheduled teams and routines return **paused**, so the restored copy does not run the same work twice. Turn the routines and team schedules you want back on.
- Agent chats come back with what was said, but a Claude Code, Codex, Hermes or OpenClaw chat starts a new session from that history: the copy never carries on in the original's conversation.
- A `BRAIN.md` already in the folder you restore into stays as it is.

### Undo changes

Open **History** in a skill editor, agent editor, team panel or MEMORY.md to compare an earlier version with the current one and restore it. Restoring also keeps the current version, so you can undo the restore.

The dashboard keeps the last **50 versions** per item and groups nearby edits. **Recently deleted** on the Skills and Agents pages can bring deleted items back, including a skill's extra files. Deleting a team deletes its agents too, except agents that are also on another team; to bring a team back with its agents, bring the agents back first. Agent and team history is also saved with the project's `.dashboard` copy.

## Troubleshooting

- **Bun is not found:** install it from [bun.sh](https://bun.sh), then open a new terminal. The Windows launcher also checks Bun's default install location.
- **The desktop app says it could not start:** it shows where the server's log is (`server.log`; the one before is `server.old.log`). Choose **Try again**, or check the log for the error.
- **The page does not open:** visit http://localhost:4800 directly and check the server terminal for errors. Use the port you selected if you changed it.
- **Browser changes are missing:** rebuild with `bun run build` and reload, or use `bun run dev` while editing. Direct server startup only builds when the bundle is missing.
- **The fans spin up, the battery drains, or the Station stutters:** lower **Settings → Appearance → Station quality**. **Balanced** (the default) draws 60 frames a second while you move around the map, 30 when nothing moves, and fewer when the window is in the back. **Battery saver** draws at most 30, a little softer, and leaves desk screens still until you zoom in. Other pages don't draw the map at all. Many agents working at once mostly use memory: each Claude Code agent that is working runs its own program, a few hundred MB each.
- **A Claude Code agent is missing Gmail, Calendar or other claude.ai connectors:** set its sign-in to **My Claude login**. With that choice an `ANTHROPIC_API_KEY` set on the PC is ignored, and the Claude Code status only shows signed in for a real login.
- **An agent cannot run:** check its selected engine in Settings, its login or API key, and whether a local model server is running. For missing Hermes dashboard tools, add the MCP bridge as described in [Giving engine CLIs the dashboard tools](#giving-engine-clis-the-dashboard-tools).

## Development

Building, testing and packaging the dashboard is in the [README](../README.md#development).

Chat gateways are still being built. Experimental Telegram, Slack and Discord instances can pass allowed text and attached files
to the Brain, a team or an agent and send final text replies. Files explicitly selected through the local API
can be sent as Telegram documents, Slack files or Discord attachments after their size, location and saved content hash are checked.
Gateway agents can also inspect specific finished files and request their delivery through the normal
approval policy. Files changed after inspection are refused. Artifacts and tool images are not attached automatically.
Delegated files can come from the agent's custom workspace. Their source run, private conversation and
current folder access are checked again before delivery; missing records or revoked access hold the file for review.
Set up Telegram under **Settings → Gateways**. The tab is hidden for now: open it by going to `#/settings?tab=gateways` in the address bar. Add an instance with its numeric bot account ID and
BotFather token, choose a project and the Brain, a team or an agent, and enter the allowed Telegram
user IDs. Choose whether direct messages are allowed and list exact group/topic IDs when needed.
Save leaves the instance paused; click **Enable** to connect. Saving an edit pauses it again. Each bot
account has its own instance and token. **Pause** stops receiving and delivering; native work already
started keeps its normal stop behavior. **Reconnect** retries connection setup. **Delete** removes the
connection and token but retains conversation receipts for recovery.

Choose **Set up Telegram** on the saved instance and **Check setup** while paused. This verifies the
token's bot identity and reads its webhook status without receiving messages or sending replies.
The page shows only the webhook host and the last pending-update count; full URL paths and secrets
stay private. Opening or reloading the page reads saved local status and makes no Telegram request.

If another service registered a webhook, stop that integration first, then confirm **Switch to
polling**. Athena rechecks the same bot and webhook, saves an intent before the change, and asks
Telegram to remove the webhook with pending updates kept. It verifies the result and leaves the
instance paused. Pending messages may be handled under the saved sender and conversation rules
when you enable it. Telegram has no atomic check-and-switch operation, so another integration must
stay stopped during the change. Connecting never removes an existing webhook automatically.

If the request is interrupted or its result cannot be saved, the switch remains unconfirmed across
restarts. Polling is blocked until you explicitly **Check setup** again. A check can verify that no
webhook remains, or show the current webhook for a new explicit confirmation; Athena never retries
the switch automatically. Existing inbox receipts, byte accounting and native work stay intact.

For Slack, choose **Add Slack instance** and enter the workspace ID (starting with T), a bot OAuth
token (xoxb-) and an app-level token (xapp-) from the same Slack app. Enable Socket Mode; the app
token needs `connections:write`. The bot needs `app_mentions:read`, `channels:history`, `channels:read`,
`groups:history`, `groups:read`, `im:history`, `im:read`, `users:read`, `chat:write`, `files:read` and
`files:write`. Subscribe to `app_mention`, `message.channels`, `message.groups` and `message.im`.
Reinstall the app after changing scopes, and invite the bot into each allowed channel. No public
callback URL is needed. Bot and app tokens can be changed or removed separately; blank fields keep
the saved tokens. Save pauses the instance; **Enable** starts it once both tokens are saved.

Slack's user-ID list is optional. Empty allows local workspace users within the configured scope;
adding IDs restricts it to those exact users. Direct messages are a separate choice. List channel IDs
or channel ID/thread timestamp pairs under **Allowed channels and threads**. Mention the bot to start
an assignment in a channel, then reply in that thread to continue. Direct messages also start a thread
per new root message. Different threads keep separate Athena histories. Shared channels, external
users, group DMs and org-wide installations are refused. Slack files must be hosted uploads shared
in the saved local conversation; external or inaccessible files hold the request for review. Downloads
are bounded and rechecked; selected output files use the same workspace, channel and thread.
Replies are plain text and cannot turn model output into Slack mentions or unfurls. Ambiguous sends
stay held until explicitly retried after checking Slack. Approvals are reviewed in Athena.

For Discord, choose **Add Discord instance** and enter the bot user ID and token from the Discord
Developer Portal. Enable the **Message content** intent on the Bot page. Invite the bot with the
`bot` scope and View channels, Read message history, Send messages, Send messages in threads and
Attach files permissions. List exact server IDs under **Allowed servers** and channel or native
thread IDs under **Allowed channels and threads**. Allowing a parent channel also allows its threads.
Direct messages have a separate rule. The optional user-ID list narrows access; leaving it empty
allows any human who can message the bot or post in those channels. Bots and webhooks are refused.
Choose a project and the Brain, a team or an agent; save pauses the instance and **Enable** connects.
Multiple bot accounts keep separate routes, credentials, histories and delivery receipts.

Discord replies stay attached to the source message, with mentions and link previews suppressed.
Files are fetched from refreshed attachment links without exposing them in saved receipts. Selected
output files use the same verified channel or thread and saved byte limits. **Reconnect** resumes a
saved session and honors Discord's requested wait. If Discord cannot replay that session, intake
stops and **Review recovery** explains the gap. Pause the instance, check Discord for missed messages,
and confirm **Allow new session** to acknowledge that the missing messages cannot be recovered
automatically. The instance stays paused until you enable it. Existing work and confirmed deliveries
stay saved; the review never starts a second run or blindly resends output. Real-account checks
remain pending.

Open an instance's **Inbox** to see messages needing review, or choose **All messages** for its saved
history. Expand a message to see its original sender, saved destination, attachments, final reply and
individual delivery results. **Retry remaining reply** preserves confirmed text parts. Outgoing files
have separate **Retry file** and **Skip file** controls; uncertain deliveries ask you to check the messaging app
first because a retry might create a duplicate. Skipping cannot undo a delivery that already happened.
Enable a paused instance before retrying. To send specific files for the current assignment, enter
absolute paths under **Files to send**, one per line. The server checks their location, size and content
hash before upload. These actions never replay model work.

For a completed saved answer, **Review delivery** also works while the instance is paused or its
platform is unavailable. It shows the original source and saved destination, each text part, outgoing
file and advisory notice. Check the messaging app first. **Record confirmed delivery** requires the
app's message or file ID and marks only an attempted uncertain item as sent; other parts keep their
own receipts. It records your confirmation locally and makes no provider request. Pending,
unattempted, failed or already confirmed items cannot be promoted this way.

**Recover interrupted receipts** classifies that answer's saved in-flight sends as uncertain before
review; opening the panel never does this automatically. **Finish delivery locally** permanently
stops the remaining text and files for that answer. It keeps the saved answer, native operation,
confirmed deliveries, uncertainty and charged bytes. It cannot recall a message or reopen delivery.
Later messages can continue after other holds are resolved and the instance is enabled. Native work
must already be complete; active or held assignments keep their separate controls in Athena.
These local reviews stay available for old receipts after sender access or relay setup changes,
and never grant permission to send. Resolved receipts remain eligible for the normal confirmed
cleanup, with compact replay markers and byte reservations kept.

Telegram albums wait for you to confirm their parts in the inbox. Once all files are saved, choose
**Group album and start** on the first received part. Check Telegram for the complete album before
confirming the listed message IDs: Telegram does not provide an album completion marker. One
assignment receives all saved files, captions and source IDs. Limits apply to the whole album.
The other parts point to that assignment's work and delivery receipts. A late part or an edit holds
unfinished work and unsent deliveries for review; it never starts a second assignment automatically.
Confirmed sends stay confirmed. Album receipts can only be cleaned together, and replay protection
continues to hold late parts after cleanup.

For a held message with a saved operation, **Check saved work** checks that original operation without
starting another run. If its completion is verified and the original sender and destination are still
allowed, its saved reply is queued for delivery. Work still in progress resumes completion tracking.
Missing records, edited input, changed destinations and unproven completion remain held; this action
does not override them. Team recovery needs a completed review of the original message, rather than
the latest team reply.

For reserved or started work without a saved final reply, pause the instance and choose **Review
saved work**. The panel shows the original source and destination, the saved operation and native
conversation IDs, and how many other requests will stay held. These are historical gateway
receipts, not a live native-status check. Review or stop the original work using Athena's native
controls; it may still be running. An operation reservation alone does not prove that admission
failed or that nothing happened.

**Keep work in Athena** permanently ends gateway tracking and any future reply or file delivery
for this request. Confirm that native work may still run, that no gateway reply should follow, and
that new incoming messages will use a separate private conversation. This does not stop native
work, mark it complete, approve tools or replay it. It preserves the operation IDs, original
input, saved files, delivery evidence and byte reservations. These receipts remain in the inbox
for recovery and are not eligible for normal inbox cleanup.

Already queued requests in the earlier conversation stay held. New messages accepted after the
review use a fresh private conversation with the instance's current project, destination and
sender rules; other conversations and threads keep their history. Earlier edits and late grouped
album parts stay in their original conversation. A changed project, sender identity or relay
keeps its own separate routing boundary. This local review is also available for unavailable
platforms and after access changes, but grants no new permission to receive or send. If saved
notices or files still say they were in flight, **Recover interrupted receipts** classifies only
this request's interrupted receipts before keeping the work locally. Opening the panel never
does that automatically.

For a held request that has never started, pause its instance and choose **Dismiss request**. Athena
checks the current receipt and asks you to confirm. The request will not start an assignment or send
a reply, and later messages in that conversation can continue once other holds are resolved. Its
text, files and byte charges stay saved. Ask the sender to send a new message if the work is still
needed; an old request cannot replay. This action refuses even a reserved operation with no proven
run, saved native work, replies, outgoing files and albums. Existing native work still uses
**Check saved work**, and uncertain deliveries still need their separate review. Unconfirmed WhatsApp
requests require the exact ACK or a reviewed retention gap before they can be dismissed; relay holds
must be resolved first. Dismissing an abandoned receipt never marks it confirmed.

Under **Clean resolved receipts**, choose a received-before age or **All resolved receipts**, then
choose **Remove resolved receipts** and confirm **Remove receipts**. Completed and dismissed requests are eligible. Only the displayed eligible selection is removed; unresolved
conversations keep their earlier context. Paused instances can be cleaned without reconnecting.
This removes inbox message text and delivery receipts, while native chats, project files and conversation
links stay. Compact replay markers and daily byte totals stay too, so cleanup cannot resend an old
request or refill a file budget. These records do not expire; if their storage limit is reached, cleanup
refuses to remove further receipts. There is no automatic purge of unresolved work.

Removing an instance first saves a permanent removal record and blocks new gateway work. Athena
stops its worker, claims exclusive ownership, then clears only that instance's local credentials
and WhatsApp pairing. In-flight replies settle before ownership is released; an interrupted reply
can remain uncertain. Native chats and work, saved input, uploaded files, byte accounting and
approved Outbox receipts stay. Manage any native work still running through Athena's usual controls.
Removal makes no messaging-service or relay-administration request.

If storage or ownership prevents removal from finishing, its saved record keeps the instance
blocked. Restarting Athena retries valid unfinished removals; the guarded local delete API can
also be retried with the original instance ID. A broken removal record must be restored before
cleanup can finish. A newly added instance gets a separate identity and history.
Read-only recovery is available through the local API: `GET /api/gateways/retired` lists removal
records and `GET /api/gateways/retired/:id/inbox` reads their saved inbox receipts. These reads
do not claim ownership, classify interrupted receipts or enable a connection.

In **Settings → Gateways**, choose **View removed instances**. Find the old instance by name,
platform, account, project or instance ID, then choose **View saved history**. The view shows its
original identity and destination, source messages, saved native operation/conversation IDs,
answers and per-part text, notice and file receipts. Confirmed IDs and uncertain or in-flight
statuses stay as saved. Long histories show 25 entries at a time; expand a message to read its details.
These are historical gateway records, not a live native-status or messaging-app check.

If removal is unfinished, **Retry removal** asks you to confirm the exact instance and account
before draining its worker and clearing its local credentials under ownership. The connection
stays blocked, and receipts remain. Cancel or close the history before confirming to leave removal
unchanged. Failed reads and failed cleanup show separate reload/retry controls. A direct link uses
`#/settings?tab=gateways&retired=<instance-id>`; `retired=all` opens the list. Removed history can
load even when active gateway credentials need recovery. Legacy deleted folders without a removal
record need separate recovery.

Expand a saved answer or native operation and choose **Review local finish**. Opening the review
only reads the original source, destination, native work IDs and current saved delivery receipts.
For a completed answer, **Finish locally** permanently closes its remaining text, file and notice
delivery. Confirmed IDs, uncertain results, waiting parts and byte reservations remain as evidence.
For reserved or started work without a final answer, the same action permanently keeps its work in
Athena and closes future gateway tracking, replies and files. Other saved requests in that conversation
stay held. Native work may still be running; manage it through Athena's usual controls first. A saved
reservation does not prove that native admission failed or that the work completed.

If saved sends still say they were in flight, choose **Recover interrupted receipts** explicitly
before finishing. This classifies only the selected request's interrupted receipts locally. The
review then needs a fresh receipt revision. **Finish locally** asks for confirmation naming the
original chat, message and project. It cannot be undone. It sends nothing, starts no work and keeps
the removed connection blocked. Removal must be complete first, and another process owning the
account or private state blocks the change. SDK state and saved credentials are not read or rewritten.
Late gateway callbacks cannot reopen closed delivery or tracking. Queued requests, edits and album
members keep their saved evidence without a local-finish action. Manual delivery confirmations for
removed instances remain planned.

New gateway downloads record their temporary files privately before saving any bytes. After removal
finishes, Athena waits at least 24 hours, then checks at startup and hourly for leftover partial files,
empty name reservations and uploads interrupted before their saved receipt. It removes only files
whose original project, batch and file identity still match those records. Files edited after removal,
replacement files, links, unknown files and older uploads without ownership records stay untouched.
Missing projects or unreadable ownership/inbox records also prevent cleanup; recover the records
before a later check. Another process owning the gateway account or state blocks that check.

Saved attachments stay in their project, including files on held or failed requests. Selected outgoing
files, chat history, replay/quota markers and delivery receipts remain. This policy clears temporary
leftovers. SDK state and credentials are not
opened by this cleanup. Filesystems without usable file identities keep their leftovers for recovery.

The sidebar's **Status** panel shows gateway connection state and messages needing review once an instance is set up. Click an
instance needing review to open its inbox, or a connection warning to open its setup. Its tooltip names
the bound project. Up to five instances appear, with attention items first; **All gateways** opens the full
list. If an inbox is unreadable, its status says **check inbox** rather than reporting no problems.
Uncertain sends need review before retrying; automatic retries preserve confirmed reply parts.
Slow requests can send one working notice. When a run needs approval, the messaging app says **Needs approval in Athena**;
review it in the dashboard. Gateway messages cannot approve requests.
For a Telegram or Discord follow-up, open **Outbox → Gateway message → Draft a message**. Save the
draft, choose an instance and a known conversation in this project, then choose **Review & send**.
Only enabled, connected instances and completed source messages with confirmed replies are eligible.
Review shows the bot account, conversation, thread, source message and every exact text part. It
saves your edits; cancelling leaves a draft and does not approve delivery. Check the recipient and
full text, then choose **Approve & send**. Long text is split without truncation or broken emoji.

Outbox keeps a receipt for every approved part. Queued and sending are separate from confirmed
delivery. Confirmed parts are not resent; provider rate-limit waits survive restart. An interrupted,
unknown or failed send stops for review. Changes to access, routing, credentials or source messages
hold the unsent text. Approved text and recipients cannot be edited, rejected, removed or sent back
to a team through draft actions. Pause the instance and choose **Finish locally** to permanently stop
the remaining delivery while keeping confirmed IDs and uncertainty. An uncertain part may already
have arrived: check the messaging app before creating a new draft.

Choose **Review delivery** on an approved post to see the original recipient, text parts and receipts.
Opening the review only reads saved metadata. Pause its instance before changing receipts. If a send
was interrupted, choose **Recover interrupted receipts** to classify it as uncertain locally. This
contacts no messaging service. Choose the exact uncertain part you found in the messaging app,
enter its messaging-app ID and choose **Record confirmed delivery**. Pending and unattempted parts
cannot be confirmed. The saved ID, time and attempt stay recorded; this action sends nothing and
holds that post's remaining parts until you explicitly continue them.

**Retry remaining delivery** starts with the first failed or uncertain part. Check the messaging app
first: retrying an attempted part can send a duplicate. **Continue remaining delivery** releases the
pending tail after you recorded a confirmation. Both actions queue only the original approved text
and recipient and keep every confirmed part. They leave the instance paused; enable it in Gateways
when ready. Current route, project, sender access, credentials and every source/album part must still
match the original approval. Changed setup, edited sources or a locally finished post cannot be
reopened by retry; keep that delivery local and review a new draft instead. Other already approved
posts can continue under their own rules when the instance is enabled. Review history survives
restart and is retained with the delivery receipts; native runs, files and byte accounting stay intact.

For a removed instance's approved Outbox post, open **Review delivery** in its original project.
The view keeps the original recipient and text and links to **View removed instance**. Removal must
be complete before changing receipts. If a send was interrupted, **Recover interrupted receipts**
requires the displayed review revision and classifies only that post's interrupted part as uncertain.
Review the refreshed receipts, then confirm **Finish locally**. The connection stays blocked and
the old post cannot send again. Delivery retry and manual confirmation remain unavailable here.

The finished post moves to **History**. Open **Review delivery** there to read its closure time,
confirmed IDs, uncertainty and original attempt counts. Waiting parts stay as historical evidence;
they will not send after local finish. Missing or corrupt removal records need recovery first.
Ownership conflicts and stale or changed Outbox rows stop the change and require a reload. Native
inbox, SDK state and credentials are not opened or rewritten by this flow. A project switch invalidates
an open review; return to the post's original project to continue.

Telegram and Discord setup now lives in **Settings → Gateways**, with links from Connections. Add
fresh bot credentials there; old global Telegram tokens/chat IDs and Discord webhooks are not used.
There is no default test-send button: review a test draft with an explicit recipient in Outbox instead.
The Social tool `gateway_draft` saves an unsent draft for your recipient choice and approval. The
high-risk `telegram_send` and `discord_send` tools require explicit instance and source-event IDs
provided by you and follow the normal tool approval policy. They report queued delivery, with results
in Outbox. `notify_user` only notifies inside Athena. X and Reddit account handling is unchanged;
the workflow notification option also saves a Telegram draft for recipient choice and approval.
Slack and WhatsApp proactive Outbox sends remain unavailable. The
[gateway plan](internal/plans/CHAT_GATEWAYS_2026-11-01.md) tracks the remaining work;
`bun run gateways:smoke` checks a fake local Telegram service without using accounts or keys.
`bun run gateways:slack-smoke` checks Slack Socket Mode, private downloads and selected file replies
locally with throwaway data. Real-account checks and Windows/Linux verification remain pending.
`bun run gateways:discord-smoke` checks Discord intake with local REST and WebSocket fixtures:
bot identity, optional sender rules, explicit guild/channel scopes, permissions, message edits and
saved-session recovery after a failed inbox write, private downloads and selected document replies.
It uses no real account or platform messages. Discord setup, supervised connections and explicit
recovery review are available for testing; real-account checks remain pending.

The separate [WhatsApp relay and deployment guide](../relay/whatsapp/README.md) describes its
one-phone-per-deployment scope, signature checks, one-time pairing, queue limits and explicit gap
review/revocation. It keeps Athena's port private and stores no outbound Meta token or model keys.
`bun run gateways:whatsapp-relay-smoke` proves the bundled Worker across separate local processes;
no real deployment or account is used. In **Settings → Gateways**, add a WhatsApp instance and choose
its project, Brain/team/agent destination and allowed phone numbers. Save its business phone ID,
access token and Meta app secret; blank secret fields keep saved values, and each removal control
removes only that credential. Each business phone needs its own relay deployment.

Open **Set up relay**, enter the relay HTTPS address, business account ID and a new one-use pairing
code, then confirm the starting position. **Check setup** reads the Meta phone/account and saved
relay status; it does not claim or acknowledge messages, download files, start work or send replies.
It checks that an app secret is saved; a signed webhook is still needed to prove that secret works.
A successful check is a current observation and leaves the instance paused. Receiving and sending
remain disabled while the remaining recovery controls and acceptance checks are completed.

If setup was interrupted, **Finish saved pairing** completes a locally saved key without exchanging
the code again. **Pairing outcome unknown** requires revoking the pairing at the relay and reviewing
its queue loss before clearing the local attempt and using a new code. For expired queued messages,
**Check relay gap** saves the observed loss; ask the relay operator to review that exact gap before
**Review gap locally**. Saved work and delivery receipts remain held for their own review. Changed
installations or invalid receipts require restoration; gap review cannot reset them.

If **Restore the saved relay** appears, restore the original installation and its saved data at the
same relay address first. Then choose **Check restored relay** and confirm. Athena checks the saved
installation, account, phone, queue epoch and receipt position before clearing only the connection
hold. For example, after accidentally pointing the relay address at a replacement deployment, put
the original deployment and its data back before checking. A new installation or skipped messages
will fail the check. Pending acknowledgements still need their exact envelope proof on connection;
saved work, files and delivery receipts stay held for separate review. This leaves the instance
paused and does not enable WhatsApp. Retired sender aliases stay blocked.

If the original deployment is gone, use **Replace relay** instead. Revoke or permanently stop the
old relay and review its queued-message loss first. Enter the replacement's HTTPS address, the
same business account ID and a new pairing code, then confirm **Pair replacement**. The new key
is saved privately before **Finish replacement** asks for a separate review of the current work.
If finishing is interrupted, reopen setup and finish the saved key; do not exchange the code again.
An unknown replacement outcome requires revoking the new pairing before clearing that attempt.

For example, after losing a relay deployment's stored data, deploy a fresh relay for the same business
phone, create its pairing code and use this flow. The instance keeps its project, Brain/team/agent
destination, receipt history and duplicate protection. Old requests, files and delivery receipts
remain held; running native agents keep their controls in Athena. Senders must message again after
finishing to establish fresh phone proof and start new private conversations. Delayed messages from
before replacement are ignored. Retired sender IDs stay blocked, and pending acknowledgements are
archived as unconfirmed. Setup still leaves WhatsApp disabled and the instance paused.

Open **Review senders** from relay setup to see each allowed phone's signed status: **Needs phone
proof**, **Verified**, **Needs review** or **Reviewed**. This reads saved local records only. It
shows counts of retired IDs, missing phone proofs and verified numbers outside the allowed list;
provider IDs and private pairing details stay hidden. Use **Edit allowed phones** for the guard
and **Open inbox** to inspect earlier work.

For example, if Alice keeps the same allowed phone but WhatsApp changes her sender ID, Athena
retires the old ID and holds its requests. Once signed proof confirms the new association and its
relay acknowledgement is saved, pause the instance and choose **Review sender** for Alice's phone.
Confirming keeps earlier requests, files and delivery receipts held, and preserves native operation records. Ask
Alice to message again after the review; that fresh message starts a new private conversation with
the same Brain, team or agent. The review itself starts no work, sends nothing and keeps the
instance paused. Retired IDs cannot be restored by this action.

If Alice has a different number, explicitly add that full number to the allowed list and wait for
signed phone proof. Permission is not copied from her old number. Missing proofs, pending pairing,
relay recovery and unconfirmed acknowledgements block sender review. Ordinary verified phones
need no review, and a change after a saved review needs a fresh confirmation.

## License and credits

Both are in the [README](../README.md#license).
