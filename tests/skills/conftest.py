"""Shared helpers for the tests of the scripts that come with Athena's skills (skills/athena/<id>/scripts).

Each script runs the way the dashboard runs it on Windows: in its own process, from a folder that isn't the skill's,
with output going to a pipe that isn't UTF-8 unless the script switches it. A script that writes into its own skill
folder, or prints text the pipe can't take, fails here on any OS.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parents[2]
SKILLS = ROOT / "skills" / "athena"


def script(skill: str, name: str) -> Path:
    """The path of one of a skill's scripts."""
    path = SKILLS / skill / "scripts" / name
    assert path.is_file(), f"no script {name} in skills/athena/{skill}/scripts"
    return path


def _listing(folder: Path) -> list[str]:
    return sorted(str(p.relative_to(folder)) for p in folder.rglob("*") if "__pycache__" not in p.parts)


@dataclass
class Result:
    code: int
    out: str
    err: str

    def json(self) -> Any:
        return json.loads(self.out)


@pytest.fixture
def run(tmp_path: Path):
    """run(skill, script_name, *args, ok=True, stdin=None) runs the script from tmp_path and returns its Result."""

    def _run(skill: str, name: str, *args: object, ok: bool = True, stdin: str | None = None, env: dict[str, str] | None = None) -> Result:
        folder = SKILLS / skill
        before = _listing(folder)
        environ = {**os.environ, "PYTHONIOENCODING": "cp1252", "PYTHONUTF8": "0", "PYTHONDONTWRITEBYTECODE": "1", **(env or {})}
        proc = subprocess.run(
            [sys.executable, str(script(skill, name)), *(str(a) for a in args)],
            cwd=tmp_path,
            env=environ,
            input=stdin.encode("utf-8") if stdin is not None else None,
            capture_output=True,
            timeout=300,
        )
        result = Result(proc.returncode, proc.stdout.decode("utf-8"), proc.stderr.decode("utf-8", errors="replace"))
        assert _listing(folder) == before, f"{name} changed files in its own skill folder"
        if ok:
            assert result.code == 0, f"{name} {' '.join(map(str, args))} exited {result.code}:\n{result.err}"
        return result

    return _run
