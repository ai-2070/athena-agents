"""check_model.py: the audit of a model workbook. Results are written into the test workbooks the way a spreadsheet
program saves them; the last tests recalculate with the real LibreOffice and skip when it isn't installed."""

from __future__ import annotations

import datetime
import os
from pathlib import Path

import pytest
from openpyxl import Workbook
from openpyxl.comments import Comment
from openpyxl.styles import Font
from openpyxl.styles.colors import Color
from openpyxl.workbook.defined_name import DefinedName

SKILL, CHECK = "financial-models", "check_model.py"
INPUT, FORMULA, LINK = Font(color="0000FF"), Font(color="000000"), Font(color="008000")
SOURCE = "Source: test figures, 2026-11-04"


def model(folder: Path, name: str = "model.xlsx", tweak=None) -> Path:
    """A small, clean model: inputs with sources, formulas, a cross-sheet link and a Checks sheet."""
    wb = Workbook()
    inputs = wb.active
    inputs.title = "Inputs"
    inputs["B3"], inputs["B4"], inputs["B5"] = "Revenue", "Growth", "Valuation date"
    for ref, value in (("C3", 1000.0), ("C4", 0.05), ("C5", datetime.date(2026, 12, 31))):
        inputs[ref] = value
        inputs[ref].font = INPUT
        inputs[ref].comment = Comment(SOURCE, "Athena")
    wb.defined_names["Growth"] = DefinedName("Growth", attr_text="Inputs!$C$4")
    calc = wb.create_sheet("Calc")
    calc["B3"] = "Revenue, last actual"
    calc["C3"] = "=Inputs!C3"
    calc["C3"].font = LINK
    calc["D3"] = "=C3*(1+Growth)"
    calc["E3"] = "=ROUND(D3*(1+Growth),2)"
    calc["F3"] = "=(D3+E3)/2"
    calc["G3"] = "=EDATE(Inputs!C5,12)"
    for ref in ("D3", "E3", "F3", "G3"):
        calc[ref].font = FORMULA
    checks = wb.create_sheet("Checks")
    checks["B3"] = "Revenue grows"
    checks["C3"] = "=Calc!E3>Calc!C3"
    checks["C3"].font = FORMULA
    if tweak:
        tweak(wb)
    path = folder / name
    wb.save(path)
    return path


RESULTS = {("Calc", "C3"): 1000.0, ("Calc", "D3"): 1050.0, ("Calc", "E3"): 1102.5, ("Calc", "F3"): 1076.25, ("Calc", "G3"): 46752, ("Checks", "C3"): True}


def test_help(run):
    r = run(SKILL, CHECK, "--help")
    assert "usage:" in r.out and "--structure-only" in r.out


def test_a_clean_calculated_model_passes(run, tmp_path, with_results):
    book = with_results(model(tmp_path), tmp_path / "calc.xlsx", RESULTS)
    body = run(SKILL, CHECK, book).json()
    assert body["ok"] is True and body["calculated"] is True
    assert body["failures"] == {} and body["warnings"] == {}
    assert body["counts"] == {"formulas": 6, "with_results": 6, "typed_values": 3, "inputs": 3, "checks_true": 1}


def test_a_model_nothing_has_calculated_fails_unless_structure_only(run, tmp_path):
    book = model(tmp_path)
    r = run(SKILL, CHECK, book, ok=False)
    assert r.code == 1 and r.err == ""  # the audit ran: what it found is the result, on stdout
    body = r.json()
    assert body["ok"] is False
    assert body["calculated"] is False and list(body["failures"]) == ["not_calculated"]
    assert "soffice.py recalc" in body["how_to_fix"]["not_calculated"]
    body = run(SKILL, CHECK, book, "--structure-only").json()
    assert body["ok"] is True and body["calculated"] is None and "error_values" in body["skipped"]


def test_numbers_typed_into_formulas(run, tmp_path, with_results):
    def tweak(wb):
        calc = wb["Calc"]
        calc["H3"], calc["I3"], calc["J3"] = "=D3*1.05", "=D3*5%", "=_xlfn.QUARTILE.INC(C3:F3,3)+D3*12/365"
        calc["K3"] = "=ROUND(D3*0.21,0)"
        # a signed whole argument is still a place or a count; a signed factor is still a typed number
        calc["L3"], calc["M3"], calc["N3"] = "=ROUND(D3,-3)", "=EDATE(Inputs!C5,-6)", "=D3*-1.5"
        for ref in ("H3", "I3", "J3", "K3", "L3", "M3", "N3"):
            calc[ref].font = FORMULA

    results = {**RESULTS, ("Calc", "H3"): 1102.5, ("Calc", "I3"): 52.5, ("Calc", "J3"): 1, ("Calc", "K3"): 220,
               ("Calc", "L3"): 1000, ("Calc", "M3"): 46203, ("Calc", "N3"): -1575}
    book = with_results(model(tmp_path, tweak=tweak), tmp_path / "calc.xlsx", results)
    r = run(SKILL, CHECK, book, ok=False)
    found = {c["cell"]: c["detail"]["numbers"] for c in r.json()["failures"]["numbers_in_formulas"]["cells"]}
    assert found == {"Calc!H3": ["1.05"], "Calc!I3": ["5%"], "Calc!K3": ["0.21"], "Calc!N3": ["1.5"]}
    body = run(SKILL, CHECK, book, "--allow", "1.05", "--allow", "0.05", "--allow", "0.21", "--allow", "1.5").json()
    assert body["ok"] is True


def test_typed_results_and_misstyled_cells(run, tmp_path, with_results):
    def tweak(wb):
        calc = wb["Calc"]
        calc["H3"] = 1157.63  # a result pasted as a number
        calc["I3"] = "=D3+E3"
        calc["I3"].font = INPUT  # a formula dressed as an input
        calc["J3"] = 7
        calc["J3"].font = Font(color=Color(theme=1))  # a theme colour can't be read as an input
        inputs = wb["Inputs"]
        inputs["C6"] = 0.25
        inputs["C6"].font = INPUT  # an input with no source
        inputs["C7"] = 9.0
        inputs["C7"].font = INPUT
        inputs["C7"].comment = Comment("from the user", "Athena")  # a source with no date

    book = with_results(model(tmp_path, tweak=tweak), tmp_path / "calc.xlsx", {**RESULTS, ("Calc", "I3"): 2152.5})
    body = run(SKILL, CHECK, book, ok=False).json()
    cells = lambda kind, where="failures": [c["cell"] for c in body[where][kind]["cells"]]  # noqa: E731
    assert cells("typed_value_not_input") == ["Calc!H3", "Calc!J3"]
    assert cells("formula_styled_as_input") == ["Calc!I3"]
    assert cells("input_without_source") == ["Inputs!C6"]
    assert cells("source_without_date", "warnings") == ["Inputs!C7"]
    assert set(body["how_to_fix"]) == {"typed_value_not_input", "formula_styled_as_input", "input_without_source"}


def test_links_to_other_sheets_should_be_green(run, tmp_path, with_results):
    def tweak(wb):
        calc = wb["Calc"]
        calc["C3"].font = FORMULA
        calc["H3"] = "=Growth"  # a name defined on another sheet is a link too
        calc["H3"].font = FORMULA
        calc["I3"] = "=D3"  # same sheet: not a link
        calc["I3"].font = FORMULA

    book = with_results(model(tmp_path, tweak=tweak), tmp_path / "calc.xlsx", {**RESULTS, ("Calc", "H3"): 0.05, ("Calc", "I3"): 1050.0})
    body = run(SKILL, CHECK, book).json()
    assert body["ok"] is True
    assert [c["cell"] for c in body["warnings"]["link_not_green"]["cells"]] == ["Calc!C3", "Calc!H3"]


def test_error_values_and_failed_checks(run, tmp_path, with_results):
    def tweak(wb):
        checks = wb["Checks"]
        checks["B4"], checks["C4"] = "Balance sheet balances", "=Calc!D3=Calc!E3"
        checks["B5"], checks["C5"] = "Grid centre equals the model", "=Calc!F3/0>1"

    results = {**RESULTS, ("Calc", "E3"): "#REF!", ("Checks", "C4"): False, ("Checks", "C5"): "#DIV/0!"}
    book = with_results(model(tmp_path, tweak=tweak), tmp_path / "calc.xlsx", results)
    body = run(SKILL, CHECK, book, ok=False).json()
    errors = {c["cell"]: c["detail"]["error"] for c in body["failures"]["error_values"]["cells"]}
    assert errors == {"Calc!E3": "#REF!", "Checks!C5": "#DIV/0!"}
    failed = {c["cell"]: c["detail"]["label"] for c in body["failures"]["checks_sheet"]["cells"]}
    assert failed == {"Checks!C4": "Balance sheet balances", "Checks!C5": "Grid centre equals the model"}
    assert body["counts"]["checks_true"] == 1


def test_a_checks_sheet_is_required_and_must_hold_checks(run, tmp_path, with_results):
    def no_checks(wb):
        del wb["Checks"]

    book = with_results(model(tmp_path, tweak=no_checks), tmp_path / "calc.xlsx", RESULTS)
    body = run(SKILL, CHECK, book, ok=False).json()
    assert body["failures"]["checks_sheet"]["cells"][0]["detail"] == "no sheet named Checks"

    def numbers_only(wb):
        wb["Checks"]["C3"] = "=Calc!E3-Calc!C3"

    book = with_results(model(tmp_path, "b.xlsx", tweak=numbers_only), tmp_path / "calc-b.xlsx", {**RESULTS, ("Checks", "C3"): 102.5})
    body = run(SKILL, CHECK, book, ok=False).json()
    assert "TRUE or FALSE" in body["failures"]["checks_sheet"]["cells"][0]["detail"]

    def renamed(wb):
        wb["Checks"].title = "Prüfungen – Bilanz"

    book = with_results(model(tmp_path, "c.xlsx", tweak=renamed), tmp_path / "calc-c.xlsx", {**{k: v for k, v in RESULTS.items() if k[0] != "Checks"}, ("Prüfungen – Bilanz", "C3"): True})
    body = run(SKILL, CHECK, book, "--checks-sheet", "Prüfungen – Bilanz").json()
    assert body["ok"] is True and body["counts"]["checks_true"] == 1


def test_another_input_colour_and_ignored_sheets(run, tmp_path, with_results):
    def tweak(wb):
        for ref in ("C3", "C4", "C5"):
            wb["Inputs"][ref].font = Font(color="0070C0")
        raw = wb.create_sheet("Pasted data")
        raw["A1"] = 123.4

    book = with_results(model(tmp_path, tweak=tweak), tmp_path / "calc.xlsx", RESULTS)
    assert run(SKILL, CHECK, book, ok=False).code == 1
    body = run(SKILL, CHECK, book, "--input-color", "#0070c0", "--ignore-sheet", "Pasted data").json()
    assert body["ok"] is True
    for bad in (["--input-color", "blue"], ["--link-color", "0F0"], ["--limit", "-1"]):
        r = run(SKILL, CHECK, book, *bad, ok=False)
        assert r.code == 2 and bad[0] in r.err and "Traceback" not in r.err


def test_an_old_openpyxl_is_named_not_misread(run, tmp_path):
    # openpyxl 3.0 reads defined names differently; the audit would fail with an unrelated-looking error
    fake = tmp_path / "old" / "openpyxl"
    fake.mkdir(parents=True)
    (fake / "__init__.py").write_text('__version__ = "3.0.10"\n', encoding="utf-8")
    r = run(SKILL, CHECK, model(tmp_path), env={"PYTHONPATH": str(tmp_path / "old")}, ok=False)
    assert "3.1 or newer" in failed(r)


def failed(r) -> str:
    """A run that couldn't audit: exit 2, nothing on stdout, one line on stderr, no traceback."""
    assert r.code == 2, r.err
    assert r.out == ""
    lines = r.err.strip().splitlines()
    assert len(lines) == 1 and lines[0].startswith("check_model.py: "), r.err
    return lines[0]


def test_files_it_cannot_read(run, tmp_path):
    assert "no such file" in failed(run(SKILL, CHECK, tmp_path / "missing.xlsx", ok=False))
    (tmp_path / "folder.xlsx").mkdir()
    assert "is a folder" in failed(run(SKILL, CHECK, tmp_path / "folder.xlsx", ok=False))
    junk = tmp_path / "junk.xlsx"
    junk.write_text("not a workbook", encoding="utf-8")
    line = failed(run(SKILL, CHECK, junk, ok=False))
    assert "couldn't read" in line and "junk.xlsx" in line


@pytest.mark.skipif(os.name == "nt" or getattr(os, "geteuid", lambda: 1)() == 0, reason="needs a file this user can't open")
def test_a_file_it_may_not_open(run, tmp_path):
    # what a workbook Excel holds open looks like on Windows
    book = model(tmp_path)
    book.chmod(0)
    try:
        line = failed(run(SKILL, CHECK, book, ok=False))
    finally:
        book.chmod(0o644)
    assert "permission denied" in line and "model.xlsx" in line and "close it" in line


# --- with the real LibreOffice: build, recalculate, audit


def test_recalculated_model_passes_and_a_broken_one_fails(run, tmp_path, libreoffice):
    book = model(tmp_path)
    run(SKILL, "soffice.py", "recalc", book, "-o", tmp_path / "model-calc.xlsx")
    body = run(SKILL, CHECK, tmp_path / "model-calc.xlsx").json()
    assert body["ok"] is True and body["counts"]["checks_true"] == 1

    def broken(wb):
        wb["Calc"]["E3"] = "=D3*(1+Growht)"  # a misspelt name

    bad = model(tmp_path, "bad.xlsx", tweak=broken)
    r = run(SKILL, "soffice.py", "recalc", bad, "-o", tmp_path / "bad-calc.xlsx", ok=False)
    assert r.code == 1
    body = run(SKILL, CHECK, tmp_path / "bad-calc.xlsx", ok=False).json()
    assert "error_values" in body["failures"] and "checks_sheet" in body["failures"]
