"""What docx_tool.py and docx_create.py share: each stands alone, so a helper both need is a copy, and the copies
must stay the same; soffice.py is the same file the other office skills carry."""

from __future__ import annotations

import ast
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SCRIPTS = ROOT / "skills" / "athena" / "docx" / "scripts"
OWN = {"main", "build_parser"}


def top_level(path: Path) -> dict[str, str]:
    """name -> source of each function, class and assignment at the top of a script."""
    source = path.read_text(encoding="utf-8")
    found = {}
    for node in ast.parse(source).body:
        if isinstance(node, (ast.FunctionDef, ast.ClassDef)):
            names = [node.name]
        elif isinstance(node, ast.Assign):
            names = [t.id for t in node.targets if isinstance(t, ast.Name)]
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            names = [node.target.id]
        else:
            continue
        for name in names:
            found[name] = ast.get_source_segment(source, node)
    return found


def test_helpers_the_scripts_share_are_identical_copies():
    tool, create = top_level(SCRIPTS / "docx_tool.py"), top_level(SCRIPTS / "docx_create.py")
    shared = (set(tool) & set(create)) - OWN
    assert {"open_docx", "save_docx", "write_atomic", "decode", "emit", "run_job", "check_output", "MAIN_TYPES"} <= shared
    for name in shared:
        assert tool[name] == create[name], f"{name} differs between docx_tool.py and docx_create.py"


def test_soffice_is_the_same_copy_as_in_financial_models():
    other = ROOT / "skills" / "athena" / "financial-models" / "scripts" / "soffice.py"
    assert (SCRIPTS / "soffice.py").read_bytes() == other.read_bytes()


def test_soffice_finds_libreoffice_or_says_how_to_get_it(run):
    r = run("docx", "soffice.py", "find", ok=False)
    if r.code == 0:
        assert r.json()["ok"] is True
    else:
        assert r.code == 2 and "winget install" in r.err and "Traceback" not in r.err
