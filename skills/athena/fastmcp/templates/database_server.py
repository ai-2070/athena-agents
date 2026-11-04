"""An MCP server that reads one SQLite database and never changes it (a FastMCP template).

Copy this file into the project and name it after the data. Settings come from environment
variables:

    SQLITE_PATH       the database file (required); it is opened read-only
    SQLITE_MAX_ROWS   the most rows one query returns (default 200)
    SQLITE_TIMEOUT    seconds a query may run before it is stopped (default 10)

Reading only is enforced three ways: the file is opened read-only, the connection is set to
query-only, and an authorizer lets a query read tables and nothing else. Any single SELECT
works, WITH ... SELECT included. For PostgreSQL or MySQL keep the same tools and rules (a
database login that can only read, one statement per call, a row cap and a time limit) and
declare the driver when you install it (--with psycopg[binary], say).

Besides fastmcp it uses only Python's standard library, so it starts with
    uv run --with fastmcp fastmcp run <this file>
"""

import os
import sqlite3
import time
from contextlib import closing
from pathlib import Path
from typing import Annotated, Any

from fastmcp import FastMCP
from fastmcp.exceptions import ToolError
from pydantic import Field

mcp = FastMCP(
    "SQLite reader",
    instructions=(
        "Reads one SQLite database. Call list_tables and describe_table before writing a query; "
        "run_query accepts one SELECT (or WITH ... SELECT) and returns at most the rows asked for."
    ),
    mask_error_details=True,
)

# Tells clients these tools only read, and only this database, so an agent may call them without asking.
READS = {"readOnlyHint": True, "openWorldHint": False}
# Long text in one cell fills an agent's context without helping it; it is cut to this length.
MAX_CELL_CHARS = 2000
# What a query may do: read tables and call functions. Writes, ATTACH and PRAGMA are refused.
QUERY_ACTIONS = {sqlite3.SQLITE_SELECT, sqlite3.SQLITE_READ, sqlite3.SQLITE_FUNCTION, sqlite3.SQLITE_RECURSIVE}


def _setting(name: str, default: float, low: float, high: float) -> float:
    raw = os.environ.get(name, "")
    if not raw.strip():
        return default
    try:
        value = float(raw)
    except ValueError:
        raise ToolError(f"{name} must be a number, not {raw!r}.") from None
    if not low <= value <= high:
        raise ToolError(f"{name} must be between {low:g} and {high:g}.")
    return value


def _connect() -> sqlite3.Connection:
    raw = os.environ.get("SQLITE_PATH", "").strip()
    if not raw:
        raise ToolError("SQLITE_PATH is not set. Add the database file's path to this server's environment.")
    path = Path(raw).expanduser()
    if not path.is_file():
        raise ToolError(f"There is no database file at {path}.")
    try:
        # mode=ro: SQLite refuses to write to this file whatever a query says
        connection = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)
        connection.execute("PRAGMA query_only = ON")
    except sqlite3.Error as error:
        raise ToolError(f"Could not open {path} as a SQLite database: {error}.") from None
    return connection


def _only_reads(action: int, *_: Any) -> int:
    return sqlite3.SQLITE_OK if action in QUERY_ACTIONS else sqlite3.SQLITE_DENY


def _cell(value: Any) -> Any:
    """A value that is safe in JSON and short enough to read."""
    if isinstance(value, bytes):
        return f"<{len(value)} bytes>"
    if isinstance(value, str) and len(value) > MAX_CELL_CHARS:
        return value[:MAX_CELL_CHARS] + f"... [{len(value) - MAX_CELL_CHARS} more characters]"
    return value


@mcp.tool(annotations=READS)
def list_tables() -> list[dict[str, str]]:
    """List the database's tables and views."""
    with closing(_connect()) as connection:
        rows = connection.execute(
            "SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') "
            "AND name NOT LIKE 'sqlite_%' ORDER BY name"
        ).fetchall()
    return [{"name": name, "type": kind} for name, kind in rows]


@mcp.tool(annotations=READS)
def describe_table(table: Annotated[str, Field(min_length=1, description="A name from list_tables")]) -> dict[str, Any]:
    """Show a table's or view's columns (name, type, required, default, primary key) and its links to other tables."""
    with closing(_connect()) as connection:
        # the table name is a bound parameter here, never pasted into SQL
        columns = connection.execute(
            'SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info(?) ORDER BY cid', (table,)
        ).fetchall()
        if not columns:
            raise ToolError(f"There is no table or view named {table!r}. list_tables shows the names.")
        links = connection.execute('SELECT "from", "table", "to" FROM pragma_foreign_key_list(?)', (table,)).fetchall()
    return {
        "table": table,
        "columns": [
            {"name": name, "type": kind, "required": bool(notnull), "default": default, "primary_key": bool(pk)}
            for name, kind, notnull, default, pk in columns
        ],
        "links": [{"column": col, "to_table": other, "to_column": to} for col, other, to in links],
    }


@mcp.tool(annotations=READS)
def run_query(
    sql: Annotated[str, Field(min_length=1, description="One SELECT or WITH ... SELECT statement")],
    max_rows: Annotated[int, Field(ge=1, description="Most rows to return; the server also has its own cap")] = 50,
) -> dict[str, Any]:
    """Run one read-only SQL query and return its column names and rows. `truncated` says whether more rows matched."""
    cap = min(max_rows, int(_setting("SQLITE_MAX_ROWS", 200, 1, 100_000)))
    seconds = _setting("SQLITE_TIMEOUT", 10, 0.1, 3600)
    deadline = time.monotonic() + seconds
    with closing(_connect()) as connection:
        connection.set_authorizer(_only_reads)
        # SQLite calls this every 10,000 steps of the query; a non-zero answer stops it
        connection.set_progress_handler(lambda: int(time.monotonic() > deadline), 10_000)
        try:
            cursor = connection.execute(sql)
            rows = cursor.fetchmany(cap + 1)
        except sqlite3.DatabaseError as error:
            if "authoriz" in str(error):  # "not authorized", "authorization denied"
                raise ToolError("Only reading is allowed: one SELECT or WITH ... SELECT.") from None
            if "interrupted" in str(error):
                raise ToolError(f"The query ran longer than {seconds:g} seconds and was stopped.") from None
            raise ToolError(f"SQLite refused the query: {error}.") from None
        except sqlite3.Warning as error:  # Python before 3.12 raises this for two statements
            raise ToolError(f"{error} Send one statement per call.") from None
        columns = [entry[0] for entry in cursor.description or []]
    return {
        "columns": columns,
        "rows": [[_cell(value) for value in row] for row in rows[:cap]],
        "row_count": min(len(rows), cap),
        "truncated": len(rows) > cap,
    }


if __name__ == "__main__":
    # `python <this file>` runs it over stdio too; `fastmcp run` skips this block.
    mcp.run()
