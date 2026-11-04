"""What the powerpoint scripts share: each stands alone, so a helper both need is a copy and the copies must stay the
same; soffice.py is the same file in every skill that has it; slide lists mean the same in both scripts."""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

SKILL = "powerpoint"
ATHENA = Path(__file__).resolve().parents[3] / "skills" / "athena"
SCRIPTS = ATHENA / SKILL / "scripts"
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
    tool, deck = top_level(SCRIPTS / "pptx_tool.py"), top_level(SCRIPTS / "pptx_deck.py")
    shared = (set(tool) & set(deck)) - OWN
    assert {"open_deck", "parse_slides", "iter_shapes", "write_atomic", "emit", "run_job", "decode", "ph_type"} <= shared
    for name in sorted(shared):
        assert tool[name] == deck[name], f"{name} differs between pptx_tool.py and pptx_deck.py"


def test_soffice_is_the_same_file_as_in_the_other_skills():
    copies = sorted(ATHENA.glob("*/scripts/soffice.py"))
    assert SCRIPTS / "soffice.py" in copies
    for other in copies:
        assert other.read_bytes() == (SCRIPTS / "soffice.py").read_bytes(), f"{other} differs"


@pytest.mark.parametrize("slides, expected", [("2", [2]), ("3-1", [3, 2, 1]), ("5-", [5, 6]), ("-2", [1, 2]), ("0", None), ("2-9", None), ("x", None)])
def test_slide_lists_mean_the_same_in_both_scripts(run, sample, write_plan, tmp_path, slides, expected):
    ok = expected is not None
    tool = run(SKILL, "pptx_tool.py", "outline", sample, f"--slides={slides}", ok=ok)
    deck = run(SKILL, "pptx_deck.py", "edit", sample, write_plan([{"do": "hide", "slides": slides}]), "-o", tmp_path / "o.pptx", ok=ok)
    if ok:
        assert [s["slide"] for s in tool.json()["slides"]] == expected
        assert deck.json()["steps"][0]["slides"] == expected
    else:
        assert tool.code == deck.code == 2
        assert tool.err.split(": ", 1)[1] == deck.err.split(": ", 1)[1]  # the same reason after each script's name


def test_an_unexpected_failure_is_one_line(run, sample, tmp_path, h):
    """Something no one planned for inside a library still ends as one line and exit code 2, not a traceback."""
    stub = tmp_path / "broken-packages" / "pptx"
    stub.mkdir(parents=True)
    (stub / "__init__.py").write_text("__version__ = '1.0.2'\nclass Presentation:\n    def __init__(self, src=None):\n        pass\n", encoding="utf-8")
    r = run(SKILL, "pptx_tool.py", "info", sample, ok=False, env={"PYTHONPATH": str(stub.parent)})
    assert r.code == 2 and h.one_line(r.err) and "stopped unexpectedly (AttributeError" in r.err


def test_a_missing_package_names_the_install_command(run, sample, tmp_path, h):
    stub = tmp_path / "hidden" / "pptx"
    stub.mkdir(parents=True)
    (stub / "__init__.py").write_text("raise ImportError('hidden for this test')\n", encoding="utf-8")
    for script, args in (("pptx_tool.py", ["info", sample]), ("pptx_deck.py", ["new", tmp_path / "p.json", "-o", tmp_path / "o.pptx"])):
        (tmp_path / "p.json").write_text('{"steps": []}', encoding="utf-8")
        r = run(SKILL, script, *args, ok=False, env={"PYTHONPATH": str(stub.parent)})
        assert r.code == 2 and h.one_line(r.err) and "python -m pip install python-pptx" in r.err, r.err
