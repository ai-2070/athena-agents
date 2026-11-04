# Calling MCP servers from the command line

A command-line client is for trying a server before it's added, checking one answers, reading a tool's exact
arguments, or one call while testing. For regular use, add the server on the MCP page instead: the agent then gets
real tools, each call goes through the dashboard's approvals, and keys stay in the dashboard's settings. A server
already on that page has a **Test** button that starts it and lists its tools.

## What needs the user's yes first

- **Starting a server you haven't vetted.** `npx -y <package>`, `uvx <package>` or a start line copied from a README
  runs someone else's code with the user's rights. Say what it is, who publishes it and what it can reach, ask, and
  pin the version you run (`@1.4.2`, `==1.4.2`).
- **Signing in.** A remote server that uses OAuth opens a browser and waits, which is the user's step. `--auth none`
  (fastmcp) and `--no-oauth` (mcporter) stop a call from starting one.
- **Tools that change things** (write, send, post, delete): the same yes as doing it any other way. Read the schema
  first and start with the tools that only read.
- **Other apps' saved servers stay unlisted.** `fastmcp discover` and `mcporter config list` print the commands and
  links those apps keep, and `mcporter config get` (or `list --json`) their environment values and headers too, where
  keys often sit; whatever is printed lands in the chat. A bare `mcporter list` goes further: it reads the configs of
  Cursor, Claude Code and Desktop, Codex, Windsurf, OpenCode and VS Code and starts every server it finds. To use one
  of those servers, the MCP page's "Found in your Claude configs" imports it without showing its keys; otherwise ask
  the user which one they mean.

## FastMCP's client

It talks to any MCP server, whatever language it's written in (flags in `fastmcp-cli.md`):

- `fastmcp list https://example.com/mcp --json` and `fastmcp call https://example.com/mcp search query=lamps`;
  `--transport sse` for an older server.
- `fastmcp list --command "npx -y @scope/some-server@1.4.2"` starts a local one. It too gets a cleaned environment,
  so a server that needs settings goes in an `mcpServers` file with an `env` block instead.
- `--auth <token>` sends a bearer token. Let the shell fill it in, `--auth $env:SERVICE_TOKEN` in PowerShell or
  `--auth "$SERVICE_TOKEN"` in a POSIX shell, so the key itself never appears in the command or the chat.

## mcporter

mcporter (github.com/openclaw/mcporter, docs at mcporter.sh) is a Node.js client; checked against 0.16.1, which needs
Node 24 or newer. `npx mcporter@0.16.1 …` downloads it on first use, so it is an install like any other: ask first.
It's worth it when Node is there and Python isn't, or for its TypeScript-style signatures.

- `npx mcporter@0.16.1 list https://example.com/mcp --schema` lists tools with their full schemas.
- `npx mcporter@0.16.1 call https://example.com/mcp.search query=lamps --output json` calls one; the tool goes after
  the address, separated by a dot.
- `--stdio "<start line>"` runs a local server for one command, `--env KEY=value` adds a setting, and a local
  `http://` address needs `--http-url http://127.0.0.1:8000/mcp --allow-http`.
- `key=@mcp-work/body.md` reads a long text argument from a file, which avoids quoting trouble in PowerShell.
- Unlike FastMCP's client, a server mcporter starts inherits the shell's environment, keys included.
