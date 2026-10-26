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
| **Brain chat** (Ctrl+K) | Ask the Brain anything about the project, or for anything to be done: it answers, builds teams from the Library, writes PROJECT.md and hands work to the right agent or team. |
| **Projects** | Pick or create at the start screen or top left. Each project has its own agents, teams and chats and a folder (new, existing, or a GitHub repo). Auto-saved into that folder. |
| **Agents** | Each agent: instructions, knowledge, model (Claude Code, OpenRouter, Hermes or Codex), autonomy, tools, MCP servers, skills, workspace. |
| **Library** | Starters, The Agency (270+ specialists), Hermes profiles, Claude Code subagents, and your saved presets. |
| **Skills** | Reusable instructions (Claude Code's SKILL.md format). Give a skill to one agent, a team, or the whole project. Import your Claude Code skills. |
| **Routines** | Work you want done again and again. Write it once and @mention who does it (one or more agents and teams) and the skills they use. Run it by hand or on a schedule; each run shows what every agent and team did. |
| **Settings** | Keys and engines, connections (X, Reddit, Telegram, Discord, Outbox), MCP servers, programs, Look (UI scale, accent, motion). Searchable. |

**Attach files**: drop files or whole folders on any chat (Brain, agent, team), the team builder, the New
project dialog, or the Brain on the map, or use the paperclip. They're saved in the project folder under
`uploads/`, and the agent (or the Brain) is told where they are. Files added in the team builder stay with the
team: every member is told about them.

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

## Data

Everything lives in `data/` (git-ignored): projects (agents, teams, chats, knowledge), skills,
presets, settings, `secrets.json` (keys), `accounts.json` (tokens), the Outbox, the activity log.
Keys and tokens never go to the browser. Each project's agents, teams and chats are also
auto-saved into `<project folder>/.dashboard` (no keys), so opening that folder elsewhere brings
them back.

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
