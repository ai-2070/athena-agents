# The fastmcp command

Checked in November 2026 against FastMCP 4.1.6 (MCP Python SDK 2.3.0) and its `--help`. FastMCP 4.0 (August 2026)
moved to version 2 of the MCP SDK; most FastMCP 3 code runs unchanged. `fastmcp <command> --help` has the last word.

**Targets.** `server.py` finds an object named `mcp`, `server` or `app`; `server.py:orders` names one;
`server.py:create_server` calls a factory function. A URL (`http://127.0.0.1:8000/mcp`) connects to a running server,
and a JSON file with an `mcpServers` key starts the servers it lists.

## inspect, list, call

- `fastmcp inspect server.py`: a summary. `--format mcp` is what clients receive, `--format fastmcp` adds FastMCP's
  own fields (tags, output schemas), and `-o report.json` (with `--format`) writes it to a file. Local files only.
- `fastmcp list <target>`: tools as signatures. `--json` includes the schemas but not the annotations (`inspect`
  shows those), `--resources` and `--prompts` add those kinds (resource templates are counted by `inspect`, not
  listed here), and `--timeout <seconds>` limits the wait.
- `fastmcp call <target> <tool> key=value ...` turns each value into the type the schema asks for (`limit=5` a
  number; `true`, `yes`, `1` a boolean; `[...]` and `{...}` JSON). A failed tool prints its error and exits 1.
  `--json` prints the whole result (`content`, `is_error`, `structured_content`). A target with `://` in it reads a
  resource (`fastmcp call server.py files://notes/a.txt`); `--prompt` renders a prompt.
- In a POSIX shell one JSON object can replace the pairs: `fastmcp call server.py add_tag '{"id": 7, "tags": ["new"]}'`.

Windows PowerShell 5.1 strips the double quotes inside a program's arguments, so JSON typed there arrives broken;
`key=value` pairs are fine (`query="blue chair"` arrives as one argument). For nested values, keep the arguments in a
file and call through a scratch script run with the Python that has FastMCP:

```python
# python mcp-work/call.py mcp-work/test.json find_orders mcp-work/args.json
import asyncio, json, sys
from fastmcp import Client

async def main(servers_file: str, tool: str, args_file: str) -> None:
    async with Client(json.load(open(servers_file, encoding="utf-8"))) as client:
        result = await client.call_tool(tool, json.load(open(args_file, encoding="utf-8")), raise_on_error=False)
    print(json.dumps({"is_error": result.is_error, "data": result.structured_content}, indent=2))

asyncio.run(main(*sys.argv[1:4]))
```

## The PATH and a settings file

Each shell call starts fresh, so put the virtual environment first in the same command:
`$env:Path = "$PWD\.venv\Scripts;$env:Path"; fastmcp list server.py` in PowerShell,
`PATH="$PWD/.venv/bin:$PATH" fastmcp list server.py` in a POSIX shell.

`mcp-work/test.json` holds one server, started the way the dashboard will start it. Keep one server per file: with
several, each tool name gets its server's name in front (`orders_find_orders`). Forward slashes work in Windows paths
and spare JSON's doubled backslashes.

```json
{
  "mcpServers": {
    "orders": {
      "command": "uv",
      "env": { "SQLITE_PATH": "C:/Users/ana/shop/orders.db" },
      "args": ["run", "--with", "fastmcp", "fastmcp", "run", "C:/Users/ana/shop/orders_server.py"]
    }
  }
}
```

Then `fastmcp call mcp-work/test.json find_orders customer=ana@example.com`. A start that fails shows only as
"Connection closed": run the start line on its own to read the error. Use a test key where the service offers one.

## run

`fastmcp run server.py` serves over stdio, as the dashboard and desktop apps expect. `--transport http` serves on
`127.0.0.1`, port `8000`, path `/mcp` unless `--host`, `--port` or `--path` say otherwise (`sse` is the older
transport). `--no-banner` drops the start-up box, `--reload` restarts on changes, and words after `--` go to the
server. `--with`, `--with-requirements`, `--project` or `--python` run it inside `uv run`; without them it uses the
current environment. `--host 0.0.0.0` opens it to the network, which is the user's call. In the background:

```powershell
$env:FILES_ROOT = 'C:\Data\notes'; (Start-Process "$PWD\.venv\Scripts\fastmcp.exe" -ArgumentList 'run server.py --transport http --port 8000 --no-banner' -PassThru).Id
```

```sh
FILES_ROOT=/data/notes fastmcp run server.py --transport http --port 8000 --no-banner > mcp-work/http.log 2>&1 & echo $!
```

Test against `http://127.0.0.1:8000/mcp`, then `Stop-Process -Id <id>` or `kill <id>`.
`fastmcp dev inspector server.py` opens the MCP Inspector, a page for trying tools by hand; it needs Node.js (`npx`)
and keeps running, so the user starts it in their own terminal.

## install

`fastmcp install stdio server.py` prints the start line; `fastmcp install mcp-json server.py --name orders` prints the
entry as JSON, without the `mcpServers` wrapper (`--copy` sends either to the clipboard). The other targets change
another app's settings and wait for the user's yes: `claude-code` (runs `claude mcp add`), `claude-desktop` (edits its
config file), `cursor` (opens Cursor to confirm), `gemini-cli` and `goose`. They take `--name`, `--with <package>`
(repeatable), `--with-editable <folder with a pyproject.toml>`, `--with-requirements <file>`, `--project <folder>` and
`--python <version>` (when uv would pick a Python older than 3.10). All but `stdio` take `--env KEY=VALUE` and
`--env-file`, whose values `mcp-json` prints and the others store, so a real key goes in only by the user's choice.

## FastMCP Gateway

Called Prefect Horizon until November 2026 (4.1.6's `--help` still says so), it hosts a server from a GitHub
repository: the entrypoint is written as for `run` (`main.py:mcp`), packages come from `requirements.txt` or
`pyproject.toml`, and the address looks like `https://<name>.fastmcp.app/mcp`. `fastmcp login` signs in through a
code and a browser page, so the user runs it (`whoami` and `logout` go with it; automated runs read
`HORIZON_API_KEY`). The account, the repository link and publishing are the user's steps.
