"""An MCP server that reads from an HTTP JSON API (a FastMCP template).

Copy this file into the project, name it after the API, and change the paths, fields and
tool names below to the API's own. Settings come from environment variables, so no key is
ever written into the file:

    API_BASE_URL   the API's address, such as https://api.example.com/v1 (required)
    API_TOKEN      sent as "Authorization: Bearer <token>" (optional)
    API_TIMEOUT    seconds to wait for an answer (default 20)

Besides fastmcp it uses only Python's standard library, so it starts with
    uv run --with fastmcp fastmcp run <this file>
If you move to another HTTP package, declare it there as well (--with <package>).
"""

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from typing import Annotated, Any

from fastmcp import FastMCP
from fastmcp.exceptions import ToolError
from pydantic import Field

# mask_error_details: only the ToolError messages below reach the client, never the text of
# an unexpected exception (which could hold a full address or other internals).
mcp = FastMCP(
    "Example API",
    instructions="Reads items from the Example API. Run check_connection first when a call fails.",
    mask_error_details=True,
)

BASE_URL = os.environ.get("API_BASE_URL", "").strip().rstrip("/")
TOKEN = os.environ.get("API_TOKEN", "").strip()
USER_AGENT = "example-api-mcp/0.1 (FastMCP server)"
# Tells clients these tools only read, so an agent may call them without asking each time.
READS = {"readOnlyHint": True, "openWorldHint": True}

# What a tool passes on from an item. An agent reads every word a tool returns, so keep
# what helps it decide and act, and use the API's real field names.
ITEM_FIELDS = ("id", "name", "status", "updated_at", "url")


class _NoRedirects(urllib.request.HTTPRedirectHandler):
    """Refuses redirects: following one could carry the token to another host."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_OPENER = urllib.request.build_opener(_NoRedirects)


def _base_url() -> str:
    if not BASE_URL:
        raise ToolError("API_BASE_URL is not set. Add it to this server's environment settings.")
    parts = urllib.parse.urlsplit(BASE_URL)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise ToolError(f"API_BASE_URL must be an https:// address (it is {BASE_URL!r}).")
    if parts.scheme == "http" and TOKEN and parts.hostname not in ("localhost", "127.0.0.1", "::1"):
        raise ToolError("API_BASE_URL uses plain http, which would send the token unencrypted. Use https.")
    return BASE_URL


def _timeout() -> float:
    raw = os.environ.get("API_TIMEOUT", "20")
    try:
        seconds = float(raw)
    except ValueError:
        raise ToolError(f"API_TIMEOUT must be a number of seconds, not {raw!r}.") from None
    if not 0 < seconds <= 600:
        raise ToolError("API_TIMEOUT must be more than 0 and at most 600 seconds.")
    return seconds


def _http_error(error: urllib.error.HTTPError) -> str:
    """One line that says what the API's error answer means."""
    if 300 <= error.code < 400:
        return (
            f"The API sent a redirect ({error.code}) to {error.headers.get('Location')}. "
            "Set API_BASE_URL to the final address."
        )
    if error.code in (401, 403):
        return f"The API refused the request ({error.code}). Check API_TOKEN and what it is allowed to read."
    if error.code == 404:
        return "Not found (404): check the id, or the path this tool asks for."
    if error.code == 429:
        wait = error.headers.get("Retry-After")
        return f"The API is limiting requests (429). Try again {'after ' + wait + ' seconds' if wait else 'later'}."
    try:
        excerpt = " ".join(error.read(300).decode("utf-8", "replace").split())
    except OSError:
        excerpt = ""
    return f"The API answered {error.code} {error.reason}" + (f": {excerpt}" if excerpt else ".")


def _get(path: str, params: dict[str, Any] | None = None) -> Any:
    """GET <API_BASE_URL>/<path> and return the decoded JSON. Every failure becomes a ToolError."""
    url = f"{_base_url()}/{path.lstrip('/')}"
    query = {key: value for key, value in (params or {}).items() if value is not None}
    if query:
        url += "?" + urllib.parse.urlencode(query)
    headers = {"Accept": "application/json", "User-Agent": USER_AGENT}
    if TOKEN:
        headers["Authorization"] = f"Bearer {TOKEN}"
    timeout = _timeout()
    try:
        with _OPENER.open(urllib.request.Request(url, headers=headers), timeout=timeout) as response:
            body = response.read()
    except urllib.error.HTTPError as error:
        raise ToolError(_http_error(error)) from None
    except urllib.error.URLError as error:
        raise ToolError(f"Could not reach {_base_url()}: {error.reason}.") from None
    except TimeoutError:
        raise ToolError(f"The API did not answer within {timeout:g} seconds.") from None
    try:
        return json.loads(body)
    except ValueError:
        raise ToolError(f"The API answered with something other than JSON ({len(body)} bytes).") from None


def _item(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise ToolError("The API's answer was not an item object.")
    return {key: raw[key] for key in ITEM_FIELDS if key in raw}


@mcp.tool(annotations=READS)
def check_connection() -> dict[str, Any]:
    """Check that the API answers and accepts the token. Use it first when other tools fail."""
    _get("status")  # a cheap endpoint the API has
    return {"ok": True, "api": _base_url(), "token_sent": bool(TOKEN)}


@mcp.tool(annotations=READS)
def get_item(item_id: Annotated[str, Field(min_length=1, description="The item's id")]) -> dict[str, Any]:
    """Get one item by its id: its name, status, last change and link."""
    # quote() keeps an id such as "../admin" inside this one path segment
    return _item(_get(f"items/{urllib.parse.quote(item_id, safe='')}"))


@mcp.tool(annotations=READS)
def search_items(
    query: Annotated[str, Field(min_length=1, description="Words to search for")],
    limit: Annotated[int, Field(ge=1, le=50, description="Most results to return")] = 10,
) -> dict[str, Any]:
    """Search items by text and return the best matches, at most `limit` of them."""
    data = _get("items", {"q": query, "limit": limit})
    found = data.get("results", []) if isinstance(data, dict) else data
    if not isinstance(found, list):
        raise ToolError("The API's search answer was not a list.")
    return {"query": query, "count": len(found[:limit]), "items": [_item(entry) for entry in found[:limit]]}


if __name__ == "__main__":
    # `python <this file>` runs it over stdio too; `fastmcp run` skips this block.
    mcp.run()
