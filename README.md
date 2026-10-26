# My Dashboard

A local command center for your AI agents. No login, no cloud: it runs on this PC at
**http://localhost:4800** and only this PC can open it.

Build agents, each with its own instructions, knowledge, model, skills and tools, and put them in
teams that work together in a group chat. They can use the programs on your PC (Blender, Premiere,
Photoshop, After Effects, ComfyUI, ffmpeg, Orca, browsers…), any MCP server, your X and Reddit
accounts (posts wait for your approval), and each other. The Brain oversees the whole project.

Built from ideas in [agent-office](https://github.com/AgentSystemLabs/agent-office),
[agency-agents](https://github.com/msitarzewski/agency-agents) (270+ ready specialists in the
Library) and Net Desk in `net-internal/ops`.

## Start

Double-click **`start.cmd`**. The first run installs what it needs. Or in a terminal:

```powershell
bun install
bun run start              # builds the page, then http://localhost:4800 (opens your browser)
bun server/index.ts --port 4900 --no-open
```

Needs [Bun](https://bun.sh) 1.2+ (`powershell -c "irm bun.sh/install.ps1 | iex"`).

Desktop shortcut (and optional start-with-Windows):

```powershell
powershell -ExecutionPolicy Bypass -File install-shortcut.ps1            # Desktop shortcut
powershell -ExecutionPolicy Bypass -File install-shortcut.ps1 -Autostart # also start at sign-in
powershell -ExecutionPolicy Bypass -File install-shortcut.ps1 -Remove
```

## What's where

| Page | What it does |
|---|---|
| **Station** (start page) | The live 3D map. The Brain in the middle; each team is a round pod where its agents sit around a chat hub (the lead ★ faces the Brain). Drag a team anywhere, Shift+drag to spin it. Light shows handoffs between agents. Click a team or agent for its panel and its chat. The top bar shows connections, AI engines and your plan usage. |
| **Chat window** | Floating, resizable, one tab per team group chat or agent. Opens when you click a team or agent. |
| **Brain chat** (Space on the Station, or Ctrl+K / ⌘K anywhere) | Ask the Brain anything about the project, or for anything to be done: it answers, builds teams from the Library, writes PROJECT.md, makes and edits skills and routines, switches the model and effort of an agent, several agents or a whole team ("put the video team on Opus at high effort"), looks up which models a provider has ("which Gemini models are on OpenRouter?"), tells you which model and effort each agent is on, stops an agent, a team or everything running in the project ("stop everything"), and hands work to the right agent or team. |
| **Projects** | Pick or create at the start screen or top left. Each project has its own agents, teams and chats and a folder (new, existing, or a GitHub repo). Auto-saved into that folder. |
| **Agents** | Each agent: instructions, knowledge, model (Claude Code, OpenRouter, Hermes or Codex) and effort (how hard it thinks), autonomy, tools, MCP servers, skills, workspace. In the model picker, star the models you use most: they get a Favorites tab at the front. |
| **Library** | Starters, The Agency (270+ specialists), Hermes profiles, Claude Code subagents, and your saved presets. |
| **Skills** | Reusable instructions (Claude Code's SKILL.md format). Give a skill to one agent, a team, the whole project, or the Brain itself. Write one in plain words ("how we write release notes: short bullets, user-facing changes first") or tell an existing one what to change ("add a section on thumbnails"): the Brain fills in the editor, you look it over and save (Undo puts back what was there). Import your Claude Code skills, or install them from a GitHub link (repo, folder or SKILL.md; installing again updates them). The Brain can make, edit, give, take back, re-assign, install and delete skills too. |
| **Routines** | Work you want done again and again. Write it once and @mention who does it (one or more agents and teams) and the skills they use. Run it by hand or on a schedule; each run shows what every agent and team did. |
| **Settings** | Keys and engines, connections (X, Reddit, Telegram, Discord, Outbox), MCP servers, programs, Look (UI scale, accent, motion). Searchable. |

**Attach files**: drop files or whole folders on any chat (Brain, agent, team), the team builder, the New
project dialog, or the Brain on the map, or use the paperclip. They're saved in the project folder under
`uploads/`, and the agent (or the Brain) is told where they are. Files added in the team builder stay with the
team: every member is told about them.

**Self-improvement**: the Brain comes with this skill. With it, after an agent finishes a sizeable job (5+ tool
calls), the Brain reviews how it went. When it finds something worth keeping, it records the workflow as a skill,
improves a skill that was missing a step, or gives a skill to whoever needs it, and says what it did in the Brain
chat; when it doesn't, it changes nothing and says nothing. This review can only touch skills, and
never the Brain's own skills. Take the skill away from the Brain (Skills page) to turn it off.

**Skills from GitHub**: the Brain installs skills only from GitHub repos you named in the Brain chat yourself, so a
link planted in a file, a page or an agent's answer can't get a skill installed. To allow any link, turn on Settings >
The Brain's model > "Install skills from any GitHub link". Private repos work once you sign in with the GitHub CLI
(`gh auth login`) or set `GITHUB_TOKEN`.

**Versions**: every change to a skill, agent or team keeps the version from before it, and who made the change (you
or the Brain); edits within a few minutes of each other count as one. **History** (skill editor, agent editor, team
panel) compares any version with the current one and puts it back; restoring keeps the current version too, so it can
be undone. **Recently deleted** (Skills page, Agents page) brings deleted ones back, skills with their extra files. The
last 50 versions of each are kept, in `data/versions` (skills) and `data/projects/<id>/versions` (agents and teams).
Agent and team versions are also saved into the project folder's `.dashboard`, so they come back when you open it.
An agent's last model, a pin, and a team's place on the map don't count as changes.

**Needs you** (top right) collects everything waiting on you: tool approvals, Claude Code
permission requests and Outbox posts.

## Engines

- **Claude Code**: the `claude` CLI, headless. Your Claude login, an Anthropic key, or OpenRouter.
- **API model**: any OpenRouter model, LM Studio, Ollama, or any OpenAI-compatible server.
- **Hermes**: one of your Hermes profiles.
- **OpenAI Codex**: the `codex` CLI with your ChatGPT login (install and sign in from Settings).

Claude Code and Codex get the dashboard tools through the MCP bridge (`server/mcp-bridge.ts`);
API-model agents call them directly. Hermes gets them once you click "Give Hermes the dashboard
tools" in Tools & MCP.

## Autonomy

- **Ask first**: anything that changes something needs an OK (from the Brain first, when The Brain approves is on).
- **Auto** (default): asks only for risky actions (shell, scripts, sending messages).
- **Full**: never asks.

**The Brain approves** (on by default, Settings > General > The Brain's model): when an agent or
team asks permission, the Brain answers first. It allows routine, on-task work and passes anything
risky or unclear (deleting, pushing, sending, secrets, work outside the project and the agent's
work folders) to Needs you, with its reason. Workflow checkpoints and outside MCP clients always
come to you.

Posts to X and Reddit always go to the Outbox unless you turn on auto-post for that account; DMs
always wait for you.

## Chat memory

Long chats fill up the model's memory, so the dashboard compacts them (Settings > General > Chat
memory). When an agent's memory of a chat reaches **50%** of the model's context window, the older
messages become a short history the agent keeps reading, and up to the **latest 10 messages**
(with their tool calls) stay in full, as far as the size budget allows (very long ones are trimmed
to fit). Both numbers are settings.

- **Instant compaction** (on by default, after
  [dsh-compaction-instant](https://github.com/TsFreddie/dsh-compaction-instant)): no model call. It
  keeps the original words, cut to fit: long messages are shortened, a tool call becomes one line,
  and tool results are left out. Every entry keeps its `[seq N]`, and the agent can read any of them
  back in full with the `recall_history` tool. Off: the Brain's model writes a summary instead.
- **Sized by the context window**: everything it keeps grows with the window, so a 1M-token model
  keeps far more (about 150k tokens of compacted history and up to 250k tokens of recent messages)
  than a 200k one. Set the window under Context window if your models have 1M and don't say so.
- Every message stays in the chat for you. A **— COMPACTED —** mark shows where it happened; open it
  to read what the agent remembers, and edit the latest one. Compact by hand with **Compact** in a
  chat, or type `/compact` (`/compact summary` for a summary).
- API-model agents compact between tool steps too, and once more if the model says the chat is too
  long. Claude Code, Codex and Hermes start a fresh session from the compacted history. When Claude
  Code compacts its own memory, that is marked too.

## Data

Everything lives in `data/` (git-ignored): projects (agents, teams, chats, knowledge), skills,
presets, settings, `secrets.json` (keys), `accounts.json` (tokens), the Outbox, the activity log.
Keys and tokens never go to the browser. Each project's agents, teams, chats, the skills it uses (given to the
project, a team or an agent, or mentioned in a routine, with their files) and their earlier versions are
also auto-saved into `<project folder>/.dashboard` (no keys), so opening that folder elsewhere brings them back.
Skills the library doesn't have are added; one it already has is never changed, and a different copy from the folder
is kept as one of its versions.

**Backups.** Project menu > **Back up this project** writes one `.dashbackup` file to
`My Dashboard Backups` in your home folder (`C:\Users\<you>` on Windows, `~` on macOS and Linux).
It holds the project's agents, teams, routines, layout, Brain chat, team and agent chats, knowledge
files, logo, PROJECT.md and notes, plus every skill in your library and every saved preset, and the
earlier versions of the project's agents and teams and of every skill (deleted ones too, so History and
Recently deleted come back with it). No keys or tokens. Each kind has a size limit: agent chats 200 MB,
knowledge files 50 MB, skills 50 MB, earlier versions 50 MB, PROJECT.md and notes 20 MB. A file that no longer fits is left out, and the "Backup saved" message
says how many were. To restore: **New project > From backup**, drop the file in (or pick one from the
backups folder). It becomes a new project in a new folder. Skills and presets you don't have are
added; a skill you have with the same id but different content is kept, and the backup's copy is
added as `<id>-restored` (its history goes with it, under that id). A skill you have that is the same
gets the backup's earlier versions added to its own. Scheduled teams and routines come back paused, so a
copy never runs them twice.

## Security

Listens on 127.0.0.1 only, answers only to `localhost`/`127.0.0.1` host names, needs a custom
header for every API change, and refuses API requests and WebSocket connections from other
websites. The one exception is the X and Reddit sign-in callbacks, which arrive from those sites.
There is no login, so anyone using this Windows account can open it.

## Development

TypeScript everywhere, run by Bun. Strict mode, no `any`.

| Folder | What's in it |
|---|---|
| `server/` | The server (`bun server/index.ts`): router, engines, tools, teams, the Brain, storage |
| `web/` | The page, bundled by Bun into `public/dist` (`bun run build`) |
| `shared/types.ts` | Types both sides use: agents, teams, projects, chats, skills, events |
| `public/` | `index.html`, styles, icon |
| `tests/` | Vitest: `tests/server` (logic, API and security, with throwaway data) and `tests/web` (DOM helpers) |
| `scripts/` | Build, dev, icon generator, `try-agent.ts` |

```powershell
bun run dev          # rebuild the page and restart the server on every change
bun run typecheck    # tsc for server/ and web/
bun run test         # Vitest (bun run test:watch to keep it running)
bun run check        # both
bun run icons        # after adding icon names in scripts/build-icons.ts
```

The tests never touch your real data: they use a throwaway data folder and home folder, and stop
if that isn't in place.

Talk to an agent from the terminal:

```powershell
bun scripts/try-agent.ts <agentId> "your message" [--port 4800] [--approve]
```
