# My Dashboard

**Run AI agents and teams from one local workspace.** Give each agent a role, a model and the tools it needs. Talk to them directly, let them work together, and keep their work with the project it belongs to.

The dashboard runs at **http://localhost:4800**, with no dashboard account or login. Its server and saved state stay on your computer. **Local does not mean offline:** hosted models and connected services receive the requests you send them. You can also use local models through LM Studio or Ollama.

[Get started](#get-started) · [Your first project](#your-first-project) · [Find-your-way guide](#find-your-way-guide) · [Approvals and safety](#approvals-and-safety) · [Save and restore](#save-and-restore) · [Development](#development)

## What you can do

- **Build a team for a job.** Describe the outcome to the Brain, or choose agents from the Library. Each agent keeps its own instructions, knowledge, memory, model, skills and tools.
- **Mix models.** Use Claude Code, Codex, Hermes or OpenAI-compatible APIs, including local model servers. Team members do not need to use the same engine.
- **Work with your files and programs.** Give agents a project folder, attach reference files, and connect tools for programs such as Blender, ComfyUI and ffmpeg. Add more tools through MCP servers.
- **Keep useful instructions.** Write skills in plain words, share them across agents and teams, and turn repeated work into routines you can run by hand or on a schedule.
- **Review work before it goes out.** Handle permission requests in **Needs you**, review X and Reddit drafts in the **Outbox**, and find saved results in **Artifacts**.

## Get started

### Requirements

- [Bun](https://bun.sh) **1.2 or newer**.
- A model to run your agents: a supported CLI and login, an API key, or a running local model server. See [Connect a model](#connect-a-model).

The app is mainly used on Windows. CI checks Windows and Linux; the terminal commands below can also be used on macOS.

### Start from a terminal

Open a terminal in this repository's folder:

```sh
bun install
bun run start
```

The start command builds the browser app, starts the server and opens **http://localhost:4800**. Keep the terminal running; press **Ctrl+C** to stop the server.

To choose another port or avoid opening a browser:

```sh
bun server/index.ts --port 4900 --no-open
```

This starts the server directly and builds the page if it has not been built yet. After changing browser code, run `bun run build` first, or use `bun run dev`.

### Start on Windows

Once Bun is installed, double-click **[`start.cmd`](start.cmd)**. It installs project dependencies if `node_modules` is missing, builds the page, then starts the server in a minimized window.

Optional desktop shortcut:

```powershell
powershell -ExecutionPolicy Bypass -File install-shortcut.ps1
```

Add `-Autostart` to also launch at Windows sign-in. Use `-Remove` to remove both the desktop and sign-in shortcuts.

### Connect a model

Open **Settings → General & keys**. You only need to set up the engines you want to use.

| Engine | What you need |
|---|---|
| **Claude Code** | The `claude` CLI. Use your Claude login, an Anthropic key or OpenRouter. |
| **API model** | An OpenRouter key, a running LM Studio or Ollama server, or another OpenAI-compatible endpoint. Configure local endpoints under **Local and custom models**. |
| **Hermes** | An installed Hermes setup with a profile to use. |
| **OpenAI Codex** | The `codex` CLI and your ChatGPT login. Settings offers installation and sign-in; installation uses npm. |

Choose **The Brain's model** in the same settings page. The Brain is the project-wide assistant: it answers questions, builds agents and teams, writes the project brief, manages skills and routines, and hands work to the right people.

Claude Code and Codex receive dashboard tools through an MCP bridge; API-model agents call them directly. For Hermes, open **Settings → MCP servers** and click **Give Hermes the dashboard tools**, then restart Hermes sessions.

## Your first project

1. **Choose a folder.** From the project picker, select **New project**. Start in a new folder, use an existing one, or clone a GitHub repo. Give the project a name and describe what you want to make. GitHub cloning uses your `gh` login, including for private repos.
2. **Ask the Brain for a small, concrete job.** Open **Ask the Brain**, press **Ctrl+K** (**⌘K** on macOS), or press **Space** on the Station when you are not typing. For example:

   > Build a small team to review this project's docs. Have one agent find confusing setup steps and another suggest clearer wording. Do not change files yet.

3. **Review the agents and their access.** Check their models, instructions, tools and work folders. You can also add a ready-made agent from **Library** instead of asking the Brain to build one.
4. **Follow the work.** Click a team or agent on the Station to open its panel and chat. Team chats show the conversation and handoffs; individual chats let you work with one agent directly.
5. **Handle anything waiting on you.** Check **Needs you** for permissions and **Outbox** for outgoing drafts. Results that agents save as artifacts appear in **Artifacts**; files they create stay in their work folders.

Projects keep separate agents, teams and chats. Use the project name at the top left to switch projects, create another one or make a backup.

## Find-your-way guide

| Place | Use it for |
|---|---|
| **Station** | The live 3D view of the project. The Brain sits in the middle, with agents grouped into team pods. Click to open panels and chats; drag a team to move it or Shift+drag to rotate it. |
| **Brain chat** | Project-wide questions, building teams, changing skills and routines, and handing off work. Available from every page. |
| **Agents** | Agent instructions, knowledge, MEMORY.md, model and effort, autonomy, tools, MCP servers, skills and workspace. Star models in the picker to keep them in Favorites. |
| **Library** | Ready-made starters, The Agency specialists, Hermes profiles, Claude Code subagents and your saved presets. |
| **Skills** | Reusable instructions, their assignments, earlier versions and recently deleted skills. |
| **Routines** | Repeatable jobs, schedules and the results of each run. |
| **Outbox** | X and Reddit drafts waiting to be approved, edited or rejected. |
| **Artifacts** | Written results, files and folders that agents have saved to the results list. |
| **Settings** | Engines and keys, accounts and connections, MCP servers, programs, UI scale, accent colour and motion. Use search to jump to a setting. |

### Chats and files

Agent and team chats open in floating, resizable windows with tabs. Type **@** in a chat to pick another agent. An agent with **Delegate** enabled can hand that agent part of the work.

Use the paperclip, drop files and folders, or paste them (**Ctrl+V**, **⌘V** on macOS) into a chat, the Brain on the Station, the team builder or the New project dialog. A pasted screenshot is saved as `pasted-image.png`. Pasting on the Station, outside a text box, gives the files to the Brain. Text copied from Word, Excel or a web page still pastes as text. Attachments are saved under the project folder's `uploads/` directory, and the agent or Brain receives their paths. Files attached in the team builder are shared with every team member.

### Skills: instructions worth keeping

Skills use Claude Code's `SKILL.md` format. Assign them to an agent, a team, the whole project or the Brain.

- **Write or change one in plain words.** Ask for something like “Short release notes, with user-facing changes first.” The Brain fills in the editor for you to review and save. Undo restores the previous editor contents.
- **Bring your own.** Import Claude Code skills or install from a GitHub repository, folder or `SKILL.md` link. Installing the same skill again updates it. Private repos use `gh auth login` or `GITHUB_TOKEN`.
- **Let the Brain manage assignments.** It can create, edit, assign, remove assignments, install and delete skills.

By default, the Brain only installs from GitHub repos **you named in Brain chat**. Links found in files, web pages or agent replies do not grant permission. **Install skills from any GitHub link**, under The Brain's model settings, relaxes that rule; leave it off unless you trust those sources.

The Brain starts with a **Self-improvement** skill. After substantial agent work, it can review the outcome and save a useful workflow as a skill, improve an existing skill or assign one where it is needed. Changes are reported in Brain chat. The review is limited to skills and cannot change the Brain's own skills. Remove Self-improvement from the Brain on the Skills page to turn it off.

### MEMORY.md: what agents remember

Every agent, and the Brain, keeps a **MEMORY.md** for each project: short notes it carries from one chat to the next, such as how you like things done, decisions you made and mistakes to avoid. It reads them with every message.

- **Agents add to it as they learn**, with the memory tools every agent has. With **Ask first** autonomy you approve each change.
- **The Brain keeps its own** and can add a note to an agent's memory when you ask it to ("Tell the Writer to remember we use British spelling"). It never rewrites an agent's memory, and the self-improvement review can't change any memory.
- **Read and change it yourself.** Open an agent's editor or its chat page and use **MEMORY.md**. For the Brain, use the page icon at the top of the Brain chat, or **Settings → The Brain's model**. **History** shows earlier versions, who changed them and can restore one.

A chat's **Clear memory** button is different: it starts that chat fresh and leaves MEMORY.md alone. Don't keep keys or passwords in a memory.

### Routines: work worth repeating

Create a routine, write the instructions, and **@mention** the agents or teams that should do the work and the skills they should use. Run it when needed or set a schedule. Each run records what its agents and teams did.

For example, with those agents and skills already created:

> @Researcher finds the week's main product updates. @Content Team turns them into a short report using @Brand voice.

### Long chats

The dashboard compacts older messages so long conversations fit the model's context window. The original messages stay visible to you.

By default, compaction starts at **50%** of the context window and keeps up to the **latest 10 messages** in full, within the size budget. Change these settings under **Settings → General & keys → Chat memory**.

- **Instant compaction** is on by default. It shortens the original text, reduces tool calls to one line and omits tool results without making a model call. Agents can use `recall_history` to retrieve the full entries.
- Turn instant compaction off to have the Brain's model write a summary instead.
- Open a **COMPACTED** marker to see what the agent remembers; you can edit the latest one. Use **Compact** or `/compact` to compact by hand, or `/compact summary` to request a summary.

The amount retained scales with the context window. Set **Context window** if a model's reported size is wrong.

## Approvals and safety

### Choose how much agents may do

| Autonomy | When dashboard tools ask for permission |
|---|---|
| **Ask first** | For low- and high-risk actions. Tools marked as having no risk run without asking. |
| **Auto** (default) | For high-risk actions, such as shell commands, scripts and sending messages. |
| **Full** | Tool approvals are skipped. Use only when you trust the agent and its access. |

An explicit **Always allow** choice can also skip later approval requests for that tool. Autonomy is not an operating-system sandbox: shell commands and external tools can act with the access of the account running them.

**The Brain approves** is on by default. When an agent or team requests permission, the Brain reviews it first. It is instructed to allow routine, reversible work within the task and pass risky or unclear requests to **Needs you**, with a reason. This is a model's judgment, not a hard safety guarantee. Turn it off under **Settings → General & keys → The Brain's model** if you want requests to come to you directly.

Workflow checkpoints and approval requests from outside MCP clients always come to you. X and Reddit drafts wait in the Outbox unless you enable auto-post for that account. **X direct messages always wait for your approval.**

### What “local” protects—and what it does not

- The server listens on **127.0.0.1** only. Host checks, custom headers for API changes and browser-origin checks help stop other websites from controlling it. X and Reddit sign-in callbacks are allowed back from those services.
- There is **no dashboard login**. Anyone with local access to the running service may be able to use it. Do not expose it through a public tunnel or reverse proxy.
- Stored API keys and account tokens are kept server-side, not sent to the browser or included in project exports. They are saved in local files; protect the machine and its data folder.
- Hosted models, MCP servers and connected services have their own access and data handling. Only enable tools, folders and accounts that an agent needs. Built-in file tools enforce allowed roots; this does not constrain arbitrary shell commands or outside tools.

## Save and restore

### Where work is stored

Local dashboard state lives under **`data/`**, which is git-ignored: projects, agents, teams, chats, knowledge, MEMORY.md files, skills, presets, settings, the Outbox and activity. Keys are in `secrets.json`; account tokens are in `accounts.json`.

The dashboard also auto-saves project state into **`<project folder>/.dashboard`**, including its agents, teams, routines, chats, MEMORY.md files, assigned or routine-mentioned skills and earlier versions. Opening that folder as a project brings the saved state back. Existing library skills are not overwritten: a different copy from the project folder is kept as a version.

These copies exclude stored keys and account tokens, **not private content you put in chats, knowledge files, memories or skills**. Review `.dashboard` before sharing or committing a project folder.

### Back up a project

Choose **Project menu → Back up this project**. The dashboard writes a `.dashbackup` file under **`My Dashboard Backups`** in your home folder.

A backup includes the project's agents, teams, routines, layout, Brain and agent/team chats, knowledge files, MEMORY.md files, logo, `PROJECT.md` and notes. It also includes **every skill and saved preset in your library**, plus earlier versions of the project's agents, teams and memories and of library skills, including deleted items. It does not include stored keys or account tokens.

Backups are not a full copy of your working folder: back up source files, uploads and generated work separately. Size limits also apply: 200 MB of agent chats, 50 MB each of knowledge files, skills and earlier versions, and 20 MB each of MEMORY.md files and of project brief and notes. Files that do not fit are left out; the saved-backup message reports the number omitted.

### Restore a backup

Choose **New project → From backup**, then drop in a `.dashbackup` file or choose one from the backups folder.

- Restore creates a new project; it does not replace the original.
- Missing skills and presets are added. If a skill has the same ID but different contents, your existing skill stays and the restored copy gets an `-restored` suffix. Matching skills receive the backup's earlier versions.
- Scheduled teams and routines return **paused**, so the restored copy does not run the same work twice. Re-enable the schedules you want.

### Undo changes

Open **History** in a skill editor, agent editor, team panel or MEMORY.md to compare an earlier version with the current one and restore it. Restoring also keeps the current version, so you can undo the restore.

The dashboard keeps the last **50 versions** per item and groups nearby edits. **Recently deleted** on the Skills and Agents pages can bring deleted items back, including a skill's extra files. Agent and team history is also saved with the project's `.dashboard` copy.

## Troubleshooting

- **Bun is not found:** install it from [bun.sh](https://bun.sh), then open a new terminal. The Windows launcher also checks Bun's default install location.
- **The page does not open:** visit http://localhost:4800 directly and check the server terminal for errors. Use the port you selected if you changed it.
- **Browser changes are missing:** rebuild with `bun run build` and reload, or use `bun run dev` while editing. Direct server startup only builds when the bundle is missing.
- **An agent cannot run:** check its selected engine in Settings, its login or API key, and whether a local model server is running. For missing Hermes dashboard tools, add the MCP bridge as described in [Connect a model](#connect-a-model).

## Development

Bun runs the TypeScript server and bundles the browser app. The code uses strict TypeScript; server and shared modules also need to work under Node because Vitest imports them there. CI uses **Bun 1.4.4** and **Node 24**, and checks Windows and Linux.

```sh
bun run dev          # Watch browser and server changes
bun run check        # Typecheck both sides, then run tests
bun run build        # Build the browser bundle
```

Other commands:

```sh
bun run typecheck
bun run test
bun run test:watch
bunx vitest run tests/server/skills.test.ts
bun run icons        # Regenerate icons after editing scripts/build-icons.ts
```

| Path | Contents |
|---|---|
| [`server/`](server/) | HTTP and WebSocket server, agent engines, tools, the Brain and JSON storage. |
| [`web/`](web/) | Browser app: mostly plain DOM; React for agent chats; three.js for the Station. |
| [`shared/`](shared/) | Shared types and logic. Data shapes start in `shared/types.ts`. |
| [`public/`](public/) | HTML and styles. `public/dist/` is generated build output; do not edit it. |
| [`tests/`](tests/) | Vitest server and browser tests. Server tests use temporary data and home folders, not your real state. |
| [`scripts/`](scripts/) | Build and development scripts, icon generation and the agent CLI helper. |

To send a message to an existing agent from a terminal while the server is running:

```sh
bun scripts/try-agent.ts <agentId> "your message" --port 4800
```

The helper also accepts `--approve`, which automatically approves **all pending permission requests** it receives. Use it only in an isolated test instance.

Run `bun run check` and `bun run build` before submitting code changes. See [`AGENTS.md`](AGENTS.md) for code conventions and security boundaries.

## Credits

Inspired by [agent-office](https://github.com/AgentSystemLabs/agent-office). The Library includes specialists from [agency-agents](https://github.com/msitarzewski/agency-agents). Instant chat compaction draws on [dsh-compaction-instant](https://github.com/TsFreddie/dsh-compaction-instant).
