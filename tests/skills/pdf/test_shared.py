"""What the three pdf scripts share: each stands alone, so a helper they all need is a copy, and the copies must stay
the same; page lists mean the same everywhere; and every failure is one line on stderr with exit code 2."""

from __future__ import annotations

import ast
import re
from pathlib import Path

import pytest

SKILL = "pdf"
SCRIPTS = Path(__file__).resolve().parents[3] / "skills" / "athena" / "pdf" / "scripts"
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
    copies: dict[str, list[tuple[str, str]]] = {}
    for path in sorted(SCRIPTS.glob("*.py")):
        for name, text in top_level(path).items():
            copies.setdefault(name, []).append((path.name, text))
    shared = {name: c for name, c in copies.items() if len(c) > 1 and name not in OWN}
    assert {"parse_pages", "open_pdf", "write_atomic", "emit", "run_job", "render_pages"} <= set(shared)
    for name, found in shared.items():
        first_script, first = found[0]
        for script, text in found[1:]:
            assert text == first, f"{name} differs between {first_script} and {script}"


@pytest.mark.parametrize("pages, expected", [
    ("2", [2]), ("3-1", [3, 2, 1]), ("2-", [2, 3]), ("-2", [1, 2]), (" 1 , 3 ", [1, 3]),
    ("-", None), (",", None), ("0", None), ("2-9", None), ("a", None), ("1-2-3", None),
])
def test_page_lists_mean_the_same_in_every_script(run, report_pdf, pages, expected):
    ok = expected is not None
    tool = run(SKILL, "pdf_tool.py", "text", report_pdf, f"--pages={pages}", ok=ok)
    forms = run(SKILL, "pdf_forms.py", "layout", report_pdf, f"--pages={pages}", ok=ok)
    if ok:
        assert [p["page"] for p in tool.json()["pages"]] == expected == [p["page"] for p in forms.json()["pages"]]
    else:
        assert tool.code == forms.code == 2
        # the same reason after each script's own name
        assert tool.err.split(": ", 1)[1] == forms.err.split(": ", 1)[1]


def one_line(err: str) -> bool:
    return len(err.strip().splitlines()) == 1 and "Traceback" not in err


def test_mistakes_in_the_command_line_are_one_line(run, report_pdf):
    for script, args, says in (
        ("pdf_tool.py", ["stamp", report_pdf, "--text", "X"], "-o/--out"),
        ("pdf_tool.py", [], "needs a command"),
        ("pdf_forms.py", ["fill", report_pdf], "required"),
        ("pdf_forms.py", [], "needs a command"),
        ("pdf_create.py", [], "required"),
    ):
        r = run(SKILL, script, *args, ok=False)
        assert r.code == 2 and one_line(r.err) and says in r.err, (script, args, r.err)
        assert r.out == ""


def test_a_damaged_pdf_is_one_line(run, report_pdf, tmp_path):
    """pypdf logs its own complaint ("EOF marker not found") as well as raising: only the reason reaches stderr."""
    cut = tmp_path / "cut.pdf"
    data = report_pdf.read_bytes()
    cut.write_bytes(data[: len(data) // 2])
    for script, command in (("pdf_tool.py", "info"), ("pdf_forms.py", "fields")):
        r = run(SKILL, script, command, cut, ok=False)
        assert r.code == 2 and one_line(r.err) and "cut.pdf" in r.err, r.err


def test_what_a_library_repaired_is_in_the_result(run, report_pdf, tmp_path):
    bad = tmp_path / "bad-xref.pdf"
    data = report_pdf.read_bytes()
    m = re.search(rb"startxref\s+(\d+)", data)
    bad.write_bytes(data[: m.start(1)] + str(int(m.group(1)) + 7).encode() + data[m.end(1):])
    r = run(SKILL, "pdf_tool.py", "info", bad)
    assert r.err == "" and r.json()["pages"] == 3
    assert any("startxref" in w for w in r.json()["library_warnings"])


def test_an_unexpected_failure_is_one_line(run, report_pdf, tmp_path):
    """Something no one planned for inside a library still ends as one line and exit code 2, not a traceback."""
    stub = tmp_path / "broken-packages" / "pdfplumber"
    stub.mkdir(parents=True)
    (stub / "__init__.py").write_text("def open(*args, **kwargs):\n    raise RuntimeError('boom')\n", encoding="utf-8")
    r = run(SKILL, "pdf_tool.py", "tables", report_pdf, ok=False, env={"PYTHONPATH": str(stub.parent)})
    assert r.code == 2 and one_line(r.err) and "RuntimeError: boom" in r.err
