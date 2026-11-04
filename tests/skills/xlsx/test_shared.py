"""What the xlsx scripts share: each stands alone, so a helper both need is a copy, and the copies must stay the same;
soffice.py is the same file as in financial-models; and a mistake on the command line is one line, never a traceback."""

from __future__ import annotations

import ast
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SCRIPTS = ROOT / "skills" / "athena" / "xlsx" / "scripts"
OWN = {"main", "build_parser"}  # each script's own command line


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
    tool, create = top_level(SCRIPTS / "xlsx_tool.py"), top_level(SCRIPTS / "xlsx_create.py")
    shared = (set(tool) & set(create)) - OWN
    assert {"put_value", "apply_style", "formula_problems", "save_book", "lost_parts", "run_job", "decode"} <= shared
    for name in shared:
        assert tool[name] == create[name], f"{name} differs between xlsx_tool.py and xlsx_create.py"


def test_soffice_is_the_same_file_as_in_financial_models():
    ours = (SCRIPTS / "soffice.py").read_bytes()
    theirs = (ROOT / "skills" / "athena" / "financial-models" / "scripts" / "soffice.py").read_bytes()
    assert ours == theirs


def test_mistakes_in_the_command_line_are_one_line(run, book, failed):
    for script, args, says in (
        ("xlsx_tool.py", [], "needs a command"),
        ("xlsx_tool.py", ["restructure", book, "-o", "x.xlsx"], "required"),
        ("xlsx_tool.py", ["to-csv", book], "-o/--out"),
        ("xlsx_create.py", [], "required"),
    ):
        r = run("xlsx", script, *args, ok=False)
        failed(r, script)
        assert says in r.err, (script, args, r.err)


def test_soffice_help(run):
    r = run("xlsx", "soffice.py", "--help")
    assert "recalc" in r.out and "convert" in r.out
