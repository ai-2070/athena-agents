# Blacksite

**Run AI agents and teams from one local workspace.** Give each agent a role, a model and the tools it needs. Talk to them directly, let them work together, and keep their work with the project it belongs to.

The dashboard runs at **http://localhost:4800**, with no dashboard account or login. Its server and saved state stay on your computer. **Local does not mean offline:** hosted models and connected services receive the requests you send them. You can also use local models through LM Studio or Ollama.

[What you can do](#what-you-can-do) · [Get started](#get-started) · [Connect a model](#connect-a-model) · [Your first project](#your-first-project) · [Where things are](#where-things-are) · [Approvals and safety](#approvals-and-safety) · [Save and restore](#save-and-restore) · [Development](#development) · [Detailed guide](docs/guide.md)

## What you can do

- **Build a team for a job.** Describe the outcome to the Brain, or choose agents from the Library. Each agent keeps its own instructions, knowledge, memory, model, skills and tools.
- **Mix models.** Use Claude Code, Codex, Hermes, pi, oh-my-pi, OpenClaw or OpenAI-compatible APIs, including local model servers. Team members do not need to use the same engine.
- **Work with your files and programs.** Give agents a project folder, attach reference files, and connect tools for programs such as Blender, ComfyUI and ffmpeg. Add more tools through MCP servers.
- **Keep useful instructions.** Write skills in plain words, share them across agents and teams, and turn repeated work into routines you can run by hand or on a schedule.
- **Review work before it goes out.** Handle permission requests in **Needs you**, review X and Reddit drafts in the **Outbox**, and find saved results in **Artifacts**.

## Get started

### Desktop app

Install **Blacksite** like any other app; it needs no Bun and no terminal. Installers are on this repository's **Releases** page:

| System | Download |
|---|---|
| Windows (x64 or Arm) | `…_x64-setup.exe` or `…_arm64-setup.exe` (an `.msi` is there for x64 too) |
| macOS (Apple silicon or Intel) | `…_aarch64.dmg` or `…_x64.dmg` |
| Linux (x64 or Arm) | `.deb` or `.rpm`, or an `.AppImage` on x64 |

The installers are not signed yet: on Windows choose **More info → Run anyway**; on macOS, Control-click the app in Finder and choose **Open**. The app keeps its own data folder and uses port 14800, so it can run next to the browser version on 4800. It checks for new versions and asks before installing one. See [desktop app notes](docs/guide.md#desktop-app-notes).

### From the source code

You need [Bun](https://bun.sh) **1.2 or newer**, and a model to run your agents (see [Connect a model](#connect-a-model)). In this repository's folder:

```sh
bun install
bun run start        # build the page, start the server, open http://localhost:4800
```

Keep the terminal running; **Ctrl+C** stops the server.

```sh
bun server/index.ts --port 4900 --no-open   # choose a port, do not open a browser
bun run dev                                 # rebuild and restart on every change
```

On Windows you can also double-click [`start.cmd`](start.cmd), and `powershell -ExecutionPolicy Bypass -File install-shortcut.ps1` adds a desktop shortcut (`-Autostart` also starts it at sign-in, `-Remove` removes both).

### Connect a model

Open **Settings → General & keys**. You only need to set up the engines you want to use.

| Engine | What you need |
|---|---|
| **Claude Code** | The `claude` CLI. Use your Claude login, an Anthropic key or OpenRouter. |
| **API model** | An OpenRouter key, a running LM Studio or Ollama server, or another OpenAI-compatible endpoint. Configure local endpoints under **Local and custom models**. |
| **Hermes** | An installed Hermes setup with a profile to use. |
| **OpenAI Codex** | The `codex` CLI and your ChatGPT login. Settings offers installation and sign-in; installation uses npm. |
| **pi** | The `pi` coding agent (`npm install -g @earendil-works/pi-coding-agent`), signed in to a model provider (`/login` in pi, or a key such as `ANTHROPIC_API_KEY`). |
| **oh-my-pi** | The `omp` CLI (`bun install -g @oh-my-pi/pi-coding-agent`), signed in with `/login` in omp. |
| **OpenClaw** | The `openclaw` CLI, set up with `openclaw onboard`. Pick which of your OpenClaw agents answers in the agent's settings. |

Choose **The Brain's model** in the same settings page. The Brain is the project-wide assistant: it answers questions, builds agents and teams, writes the project brief, manages skills, routines and MCP servers, switches agents' models, stops work, and hands work to the right people.

Claude Code and Codex receive dashboard tools through an MCP bridge; API-model agents call them directly. Hermes, pi and oh-my-pi need a one-time **Give … the dashboard tools** click under **Settings → MCP servers**. See [Giving engine CLIs the dashboard tools](docs/guide.md#giving-engine-clis-the-dashboard-tools).

## Your first project

1. **Choose a folder.** From the project picker, select **New project**. Start in a new folder, use an existing one, or clone a GitHub repo (with your `gh` login).
2. **Ask the Brain for a small, concrete job.** Open **Ask the Brain**, press **Ctrl+K** (**⌘K** on macOS), or press **Space** on the Station when you are not typing: *“Build a small team to review this project's docs. Have one agent find confusing setup steps and another suggest clearer wording. Do not change files yet.”*
3. **Review the agents and their access** — models, instructions, tools, work folders — or add a ready-made agent from **Library**.
4. **Follow the work.** Click a team or agent on the Station to open its panel and chat.
5. **Handle anything waiting on you:** permissions in **Needs you**, outgoing drafts in **Outbox**, saved results in **Artifacts**.

Projects keep separate agents, teams and chats. The project name at the top left switches projects, creates another one, or makes a backup.

## Where things are

| Place | Use it for |
|---|---|
| **Station** | The live 3D view of the project: the Brain in the middle, agents grouped into team pods, each with a symbol in the middle (an emoji, or your own picture or 3D model, set in the team's Setup tab). Click to open panels and chats. Projects are like floors: the project menu (top left) lists them in an order you can drag to change, and the Up and Down keys on the Station switch between them. From the menu or the All projects screen you can rename a project, clone it, or delete it (a delete first makes a backup and checks it; the project's own folder is never touched). Click the Brain to give the project a logo or a 3D model (`.glb`, `.obj`, `.stl`, `.ply`, `.fbx`, up to 15 MB) that turns inside its globe. |
| **Brain chat** | Project-wide questions, building teams, changing skills, routines and MCP servers, switching models, stopping work and handing work on. On every page. |
| **Agents** | Instructions, knowledge, MEMORY.md, model and effort, autonomy, tools, MCP servers, skills and workspace. |
| **Library** | Ready-made starters, The Agency's 270+ specialists (they come with the dashboard), Hermes profiles, Claude Code subagents and your presets. |
| **Skills** | Reusable instructions, their assignments, earlier versions and recently deleted ones. |
| **Routines** | Repeatable jobs, their schedules and the results of each run. |
| **Outbox** | X and Reddit drafts waiting to be approved, edited or rejected. |
| **Artifacts** | Written results, files and folders that agents have saved, each with a preview (images, video, audio, 3D models you can turn) and a search box. Chats show the same previews for files agents mention. |
| **Settings** | Engines and keys, accounts and connections, MCP servers, programs, UI scale, accent colour and motion. |

In any agent, team or Brain chat, **/** lists the commands (`/queue`, `/stop`, `/resume`, `/resend`, `/loop`, `/goal`, `/compact`) and **@** picks another agent. What each one does, and how files and long chats are handled: [Chats and files](docs/guide.md#chats-and-files).

## Approvals and safety

| Autonomy | When dashboard tools ask you first |
|---|---|
| **Ask first** | For low- and high-risk actions. Tools that do nothing risky never ask. |
| **Auto** (default) | For high-risk actions: shell commands, scripts, sending messages. |
| **Full** | Never; tool approvals are skipped. Use only when you trust the agent and its access. |

- **The Brain approves** is on by default: it allows routine, reversible work and sends risky or unclear requests to **Needs you** with a reason. That is a model's judgment, not a hard safety guarantee.
- The server listens on **127.0.0.1** only, and there is **no dashboard login**: anyone who can reach the running service may be able to use it. Never expose it through a public tunnel or reverse proxy.
- Keys and account tokens stay server-side, in `data/secrets.json` and `data/accounts.json`. They are never sent to the browser or included in project exports.
- Autonomy is not an operating-system sandbox: built-in file tools respect the allowed roots, but shell commands and outside tools act with the access of the account running them.

More: [Approvals and safety](docs/guide.md#approvals-and-safety).

## Save and restore

- **`data/`** (git-ignored) holds projects, agents, teams, chats, knowledge, MEMORY.md files, skills, presets, settings, the Outbox and activity. The desktop app uses its own data folder.
- Each project folder also gets a **`.dashboard`** copy of its agents, teams, routines, chats, memories and the skills it uses, so opening that folder as a project brings the state back. These copies hold no keys or account tokens, but they do hold what you put in chats, knowledge files, memories and skills.
- **Project menu → Back up this project** writes a `.dashbackup` file under `Blacksite Backups` in your home folder; **New project → From backup** restores it as a new project, with schedules paused. Neither includes your working files.
- **History** on a skill, agent, team or MEMORY.md compares earlier versions (the last 50 per item) and restores them.

More: [Save and restore](docs/guide.md#save-and-restore).

## Troubleshooting

- **`bun` is not found:** install it from [bun.sh](https://bun.sh), then open a new terminal.
- **The page does not open:** visit http://localhost:4800 directly (or the port you chose) and check the server terminal for errors.
- **Browser changes do not show:** run `bun run build` and reload, or use `bun run dev` while editing.
- **An agent cannot run:** check its engine in Settings, its login or API key, and whether a local model server is running.

More: [Troubleshooting](docs/guide.md#troubleshooting).

## Development

Bun runs the TypeScript server and bundles the browser app. The code is strict TypeScript; server and shared modules must also work under Node, because Vitest imports them there. CI uses **Bun 1.4.4** and **Node 24**, and checks Windows and Linux.

```sh
bun run dev          # watch browser and server changes
bun run check        # typecheck both sides, then run tests
bun run build        # build the browser bundle
bun run typecheck
bun run test
bunx vitest run tests/server/skills.test.ts
bun run icons        # regenerate icons after editing scripts/build-icons.ts
```

The desktop app needs [Rust](https://rustup.rs) and, on Linux, [Tauri's system libraries](https://tauri.app/start/prerequisites/):

```sh
bun run desktop:dev     # build and open the app
bun run desktop:build   # make installers in src-tauri/target/release/bundle
```

[`docs/desktop.md`](docs/desktop.md) explains how the app works and how releases are made.

| Path | Contents |
|---|---|
| [`server/`](server/) | HTTP and WebSocket server, agent engines, tools, the Brain and JSON storage. |
| [`web/`](web/) | Browser app: mostly plain DOM; React for agent chats; three.js for the Station. |
| [`shared/`](shared/) | Shared types and logic. Data shapes start in `shared/types.ts`. |
| [`public/`](public/) | HTML and styles. `public/dist/` is generated build output; do not edit it. |
| [`tests/`](tests/) | Vitest server and browser tests, on temporary data and home folders. |
| [`scripts/`](scripts/) | Build and development scripts, icon generation and the agent CLI helper. |
| [`src-tauri/`](src-tauri/) | The desktop app (Tauri): a window that starts the bundled server. |

To send a message to an existing agent from a terminal while the server is running:

```sh
bun scripts/try-agent.ts <agentId> "your message" --port 4800
```

`--approve` automatically approves **all pending permission requests**; use it only in an isolated test instance.

Run `bun run check` and `bun run build` before submitting changes. See [`AGENTS.md`](AGENTS.md) for code conventions and security boundaries.

## License

Blacksite is yours to use under either the [MIT license](LICENSE-MIT) or the [Apache License 2.0](LICENSE-APACHE), whichever you prefer. Unless you say otherwise, anything you contribute is offered under the same two licenses.

Some bundled pieces keep their own licenses: the skills in `skills/` and The Agency's agents in `library/agency-agents/` (each folder's `README.md` says where it's from), the Crafting App icons in `public/craft-icons/` (MIT OR Apache-2.0), Lucide icons (ISC) and Simple Icons logos (CC0). Brand names and logos stay their owners' trademarks.

## Credits

Inspired by [agent-office](https://github.com/AgentSystemLabs/agent-office). The Library includes specialists from [agency-agents](https://github.com/msitarzewski/agency-agents). Instant chat compaction draws on [dsh-compaction-instant](https://github.com/TsFreddie/dsh-compaction-instant). The Crafting App icons come from each app's repository (MIT OR Apache-2.0), see `public/craft-icons/README.md`.
