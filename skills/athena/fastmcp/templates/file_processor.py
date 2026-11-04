"""An MCP server that reads text files in one folder (a FastMCP template).

Copy this file into the project and change the tools to the work at hand (parse logs, pull
fields out of reports...). Settings come from environment variables:

    FILES_ROOT        the one folder it may read (required)
    FILES_MAX_BYTES   the largest file it opens (default 2000000)

Every path, whether given to a tool or in a resource address, is resolved first (links
included) and refused unless the real file is inside FILES_ROOT, so neither "../" nor a
link that points elsewhere gets out. Paths are relative to FILES_ROOT.

Besides fastmcp it uses only Python's standard library, so it starts with
    uv run --with fastmcp fastmcp run <this file>
"""

import codecs
import os
from pathlib import Path
from typing import Annotated, Any

from fastmcp import FastMCP
from fastmcp.exceptions import ResourceError, ToolError
from pydantic import Field

mcp = FastMCP(
    "Folder reader",
    instructions=(
        "Reads text files in one folder. list_files shows what is there; paths are relative to that folder. "
        "Each file can also be read whole as the resource files://<path>."
    ),
    mask_error_details=True,
)

# Tells clients these tools only read, and only this folder, so an agent may call them without asking.
READS = {"readOnlyHint": True, "openWorldHint": False}
# A long line is cut to this length in search results, so one minified file can't flood the answer.
MAX_LINE_CHARS = 400


def _root() -> Path:
    raw = os.environ.get("FILES_ROOT", "").strip()
    if not raw:
        raise ToolError("FILES_ROOT is not set. Add the folder's path to this server's environment.")
    root = Path(raw).expanduser().resolve()
    if not root.is_dir():
        raise ToolError(f"FILES_ROOT is not a folder: {root}.")
    return root


def _within(path: Path, root: Path) -> bool:
    # normcase: on Windows C:\Data and c:\data are the same folder
    try:
        return os.path.commonpath([os.path.normcase(path), os.path.normcase(root)]) == os.path.normcase(root)
    except ValueError:  # different drives
        return False


def _inside(path: str) -> Path:
    """The real file `path` names, when it is inside FILES_ROOT; a ToolError otherwise."""
    root = _root()
    try:
        # resolve(strict=True) follows every link and fails when nothing is there
        real = (root / path).resolve(strict=True)
    except (FileNotFoundError, NotADirectoryError):
        raise ToolError(f"There is no file at {path!r}. list_files shows what there is.") from None
    except OSError as error:
        raise ToolError(f"Could not open {path!r}: {error.strerror}.") from None
    if not _within(real, root):
        raise ToolError(f"{path!r} is outside the folder this server may read.")
    if not real.is_file():
        raise ToolError(f"{path!r} is a folder, not a file.")
    return real


def _max_bytes() -> int:
    raw = os.environ.get("FILES_MAX_BYTES", "2000000")
    if not raw.strip().isdigit() or int(raw) < 1:
        raise ToolError(f"FILES_MAX_BYTES must be a whole number of bytes above 0, not {raw!r}.")
    return int(raw)


def _read_text(real: Path, shown: str) -> str:
    size = real.stat().st_size
    if size > _max_bytes():
        raise ToolError(f"{shown!r} is {size} bytes, more than FILES_MAX_BYTES allows.")
    data = real.read_bytes()
    # Windows tools often save UTF-16 with a byte-order mark; everything else is tried as UTF-8
    encoding = "utf-16" if data.startswith((codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE)) else "utf-8-sig"
    try:
        return data.decode(encoding)
    except UnicodeDecodeError:
        raise ToolError(f"{shown!r} is not UTF-8 or UTF-16 text.") from None


@mcp.tool(annotations=READS)
def list_files(
    pattern: Annotated[str, Field(description='A glob pattern relative to the folder, such as "**/*.md"')] = "**/*",
    max_results: Annotated[int, Field(ge=1, le=1000, description="Most paths to return")] = 200,
) -> dict[str, Any]:
    """List the files in the folder that match a pattern, with their sizes in bytes."""
    root = _root()
    if Path(pattern).is_absolute() or ".." in Path(pattern).parts:
        raise ToolError("The pattern must stay inside the folder: no absolute paths or '..'.")
    found: list[dict[str, Any]] = []
    more = False
    try:
        for entry in root.glob(pattern):
            real = entry.resolve()
            if not real.is_file() or not _within(real, root):
                continue  # folders, and links that lead out of the folder
            if len(found) == max_results:
                more = True
                break
            found.append({"path": entry.relative_to(root).as_posix(), "bytes": real.stat().st_size})
    except (ValueError, NotImplementedError) as error:
        raise ToolError(f"That pattern can't be used: {error}.") from None
    return {"files": found, "truncated": more}


@mcp.tool(annotations=READS)
def summarize_file(
    path: Annotated[str, Field(description="A path from list_files")],
    preview_chars: Annotated[int, Field(ge=0, le=20000, description="How much of the start to include")] = 1000,
) -> dict[str, Any]:
    """Give a text file's size, line and word counts, and the first `preview_chars` characters."""
    text = _read_text(_inside(path), path)
    return {
        "path": path,
        "characters": len(text),
        "lines": len(text.splitlines()),
        "words": len(text.split()),
        "preview": text[:preview_chars],
    }


@mcp.tool(annotations=READS)
def search_file(
    path: Annotated[str, Field(description="A path from list_files")],
    text: Annotated[str, Field(min_length=1, description="Text to look for; case is ignored")],
    max_matches: Annotated[int, Field(ge=1, le=500, description="Most matching lines to return")] = 20,
) -> dict[str, Any]:
    """Find the lines of a text file that contain `text`, with their line numbers."""
    needle = text.casefold()
    matches: list[dict[str, Any]] = []
    more = False
    for number, line in enumerate(_read_text(_inside(path), path).splitlines(), start=1):
        if needle in line.casefold():
            if len(matches) == max_matches:
                more = True
                break
            matches.append({"line": number, "text": line[:MAX_LINE_CHARS]})
    return {"path": path, "matches": matches, "truncated": more}


@mcp.resource("files://{path*}", mime_type="text/plain")
def read_file(path: str) -> str:
    """The whole text of one file in the folder, for clients that read documents as resources."""
    try:
        return _read_text(_inside(path), path)
    except ToolError as error:
        raise ResourceError(str(error)) from None


if __name__ == "__main__":
    # `python <this file>` runs it over stdio too; `fastmcp run` skips this block.
    mcp.run()
