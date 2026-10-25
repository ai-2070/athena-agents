# My Dashboard

A local command center for your AI agents. No login, no cloud: it runs on this PC at
**http://localhost:4800** and only this PC can open it.

Build a team of agents, each with its own instructions, knowledge, brain and tools. They can use
the programs on your PC (Blender, Premiere, Photoshop, After Effects, ComfyUI, ffmpeg, Orca,
browsers…), any MCP server, your X account (posts wait for your approval), and each other.

Built from ideas in [agent-office](https://github.com/AgentSystemLabs/agent-office) (agents with
live terminals that can manage other agents), [agency-agents](https://github.com/msitarzewski/agency-agents)
(270+ ready specialists in the Library) and Net Desk in `net-internal/ops` (Hermes agents,
approve-first posting to X, OpenRouter models).

## Start

Double-click **`start.cmd`** (first run installs dependencies). Or in a terminal:

```powershell
npm install
npm start                 # http://localhost:4800, opens your browser
node server/index.js --port 4900 --no-open
```

Desktop shortcut (and optional start-with-Windows):

```powershell
powershell -ExecutionPolicy Bypass -File install-shortcut.ps1            # Desktop shortcut
powershell -ExecutionPolicy Bypass -File install-shortcut.ps1 -Autostart # also start at sign-in
powershell -ExecutionPolicy Bypass -File install-shortcut.ps1 -Remove
```

Needs Node.js 20+.

## What's where

| Page | What it does |
|---|---|
| **Station** (start page) | The live 3D map. The Brain in the middle; every team is a workflow with its agents at desks in step order; dashed lines to every connection; light pulses as work moves. Type a task in the bar and it goes to the right agent. Click a team to see what it does, reorder, add or remove agents and run it; click a desk to chat with that agent and see its connections. Top bar: everything connected (grey = not yet), what agents run on, your Claude session/week usage, clock. |
| **Brain chat** (Ctrl+K, every page) | Send to Auto (it picks the agent or team that fits), to a new agent or team designed from your message, or to any agent or team. |
| **Projects** | Switch at the top left. Each project has its own agents, teams and chats, and a Brain folder (new, existing, or a cloned GitHub repo) that its agents work in. |
| **Overview** | What's running, what needs you, give any agent a task, activity log |
| **Agents** | Your team. Each agent: name, specialty, instructions, knowledge, brain, autonomy, tools, MCP servers, workspace folder |
| **Library** | Starters, The Agency (270+ specialists), your Hermes profiles, your Claude Code subagents |
| **Workflows** | Steps in order: ask an agent → use a tool → wait for your OK → post to X → notify. Manual or scheduled |
| **Programs** | Everything found on this PC, start buttons, ComfyUI runner, every Start Menu app |
| **Tools & MCP** | Built-in tools, MCP servers (presets: Playwright browser, Chrome DevTools, files, fetch, memory, Blender live, Hermes, GitHub), import from Claude configs |
| **Connections** | X accounts (OAuth with your own X app), Telegram, Discord, and the **Outbox** where posts wait for approval |
| **Terminals** | Live terminals in the browser: PowerShell, Claude Code, Hermes, Orca, or any agent |
| **Settings** | OpenRouter / Anthropic keys, defaults, LM Studio / Ollama / custom servers, program paths, limits |

**Needs you** (top right) collects everything waiting on you: tool approvals, Claude Code
permission requests, workflow checkpoints and Outbox posts.

## Brains

- **Claude Code**: runs the `claude` CLI headless. Sign in with your Claude login (subscription),
  an Anthropic API key, or your OpenRouter key. Gets Claude Code's own tools plus the dashboard tools.
  Uses your Claude plan's usage limits.
- **API model**: any OpenRouter model, or a local model in LM Studio / Ollama, or any
  OpenAI-compatible server. Uses the dashboard tools and MCP servers directly.
- **Hermes**: one of your Hermes profiles, with its own memory, skills and tools.

## Autonomy

- **Ask first**: you approve anything that changes something.
- **Auto** (default): asks only for risky actions (shell commands, Photoshop/AE scripts, Telegram/Discord messages).
- **Full**: never asks.

X posts always go to the Outbox unless you turn on auto-post for that account. "Always allow" on
an approval remembers that tool for that agent (clear it in the agent's Autonomy section).

## Built-in tools (per agent, by group)

Programs (list, launch, open), Browser (open URL, read page), ComfyUI (status, start, list,
describe, run workflows → images in chat), Blender (headless Python, open), Adobe (Photoshop and
After Effects ExtendScript, open Premiere projects), FFmpeg (ffmpeg, ffprobe), Social (draft X
posts/threads, read posts and mentions, Telegram, Discord), Team (list agents, ask an agent, ask a
Hermes profile), Files (workspace and allowed folders), Orca CLI, Shell (PowerShell), plus
knowledge search when an agent has knowledge files.

Hermes, Claude Desktop, Cursor or any MCP app can use the same tools: Tools & MCP → "Give
Hermes the dashboard tools" or "Copy MCP config". The bridge is `server/mcp-bridge.js`.

## X setup (one time)

1. [developer.x.com](https://developer.x.com/en/portal/dashboard) → your app → User authentication settings.
2. Permissions **Read and write**, type **Web App / Native App**.
3. Callback URL: `http://localhost:4800/oauth/x/callback` (open the dashboard at that same address).
4. Paste the OAuth 2.0 Client ID (and secret, if X shows one) in Connections → Connect.

## Data

Everything lives in `data/` (git-ignored): `agents/`, `chats/`, `knowledge/`, `workspaces/`,
`workflows/`, `runs/`, `outbox/`, `settings.json`, `secrets.json` (keys), `accounts.json`
(X tokens), `mcp.json`, `activity.jsonl`, `library/agency-agents/`. Keys and tokens never go to
the browser. Plain JSON: back it up by copying the folder.

## Security

Listens on 127.0.0.1 only, answers only to `localhost`/`127.0.0.1` host names, and refuses
requests and WebSocket connections from other websites. There is no login, so anyone using this
Windows account can open it.

## Check an agent from the terminal

```powershell
node scripts/try-agent.js <agentId> "your message" [--port 4800] [--approve]
```
