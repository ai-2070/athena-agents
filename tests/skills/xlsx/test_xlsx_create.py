"""xlsx_create.py: a workbook from a JSON spec, checked by opening it again and by recalculating it."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from openpyxl import load_workbook

SKILL, CREATE = "xlsx", "xlsx_create.py"


def spec_file(tmp_path: Path, spec: dict, name: str = "spec.json") -> Path:
    path = tmp_path / name
    path.write_text(json.dumps(spec, ensure_ascii=False), encoding="utf-8")
    return path


FULL = {
    "properties": {"title": "Q3 sales", "creator": "Finance"},
    "names": {"TaxRate": "Inputs!$B$1"},
    "sheets": [
        {"name": "Inputs", "rows": [["Tax rate", 0.25]], "formats": {"B1": {"number_format": "0%"}},
         "protect": {"password_file": "pw.txt", "unlocked": ["B1"]}},
        {"name": "Продажи", "header": True,
         "rows": [["Region", "Units", "Price", "Revenue", "Status"], ["North", 120, 9.5, "=B2*C2", "Open"],
                  ["Søuth", 80, 11, "=B3*C3", "Done"], ["East", 95, 10.25, "=B4*C4", "Open"]],
         "cells": {"G1": "Total", "G2": {"formula": "SUM(D2:D4)", "number_format": "#,##0.00", "bold": True},
                   "G3": "=G2*(1-TaxRate)", "G4": {"text": "=not a formula"}, "G5": {"date": "2026-01-31"},
                   "G6": {"value": "Docs", "link": "https://example.com"}, "G7": {"value": 1, "note": "typed by hand"}},
         "validations": [{"range": "E2:E20", "list": ["Open", "Done"]}, {"range": "B2:B20", "whole": [0, 1000]}],
         "conditional": [{"range": "D2:D4", "when": ">", "value": 1000, "fill": "C6EFCE"},
                         {"range": "B2:B4", "scale": ["F8696B", "63BE7B"]},
                         {"range": "A2:E4", "formula": "$E2=\"Done\"", "font_color": "808080"}],
         "charts": [{"type": "column", "data": "D1:D4", "categories": "A2:A4", "at": "I2", "title": "Revenue"},
                    {"type": "scatter", "x": "B2:B4", "data": "D1:D4", "at": "I18"}],
         "print": {"landscape": True, "fit_width": True, "paper": "A4", "title_rows": "1:1"},
         "tab_color": "1F4E79"},
        {"name": "Items", "rows": [["Item", "Qty"], ["a", 1], ["b", 2]], "tables": [{"name": "ItemList", "range": "A1:B3"}],
         "merge": ["D1:E1"], "hidden": True},
    ],
}


def test_help_shows_the_spec(run):
    r = run(SKILL, CREATE, "--help")
    assert "usage:" in r.out and '"sheets"' in r.out and "example:" in r.out


def test_a_full_spec_builds_every_part(run, tmp_path):
    (tmp_path / "pw.txt").write_text("s3cret-pass\r\n", encoding="utf-8")
    out = tmp_path / "report.xlsx"
    r = run(SKILL, CREATE, spec_file(tmp_path, FULL), "-o", out)
    assert "s3cret-pass" not in r.out + r.err
    result = r.json()
    assert result["formulas"] == 5 and "note" in result and "formula_problems" not in result
    wb = load_workbook(out)
    assert wb.sheetnames == ["Inputs", "Продажи", "Items"]
    assert wb.defined_names["TaxRate"].attr_text == "Inputs!$B$1"
    assert wb.properties.title == "Q3 sales"
    inputs, sales, items = wb.worksheets
    assert inputs.protection.sheet and inputs.protection.password and inputs["B1"].protection.locked is False
    assert sales["D2"].value == "=B2*C2" and sales["G2"].value == "=SUM(D2:D4)" and sales["G2"].font.b
    assert sales["G4"].value == "=not a formula" and sales["G4"].data_type == "s"
    assert sales["G5"].number_format == "yyyy-mm-dd" and sales["G6"].hyperlink.target == "https://example.com"
    assert sales["G7"].comment.text == "typed by hand"
    assert sales.freeze_panes == "A2" and sales.auto_filter.ref == "A1:E4" and sales["A1"].font.b
    assert len(sales.data_validations.dataValidation) == 2 and len(sales.conditional_formatting) == 3
    assert len(sales._charts) == 2 and sales.page_setup.orientation == "landscape"
    assert sales.print_title_rows == "$1:$1"
    assert sales.column_dimensions["G"].width >= 12  # wide enough for the date and the text
    assert items.tables["ItemList"].ref == "A1:B3" and items.sheet_state == "hidden"
    assert [str(m) for m in items.merged_cells.ranges] == ["D1:E1"]


def test_every_problem_in_a_spec_is_listed_and_nothing_is_written(run, tmp_path, failed):
    bad = {"sheets": [
        {"name": "Bad/name"},
        {"name": "Ok", "rows": [["A", "A"], [1, 2]], "tables": [{"name": "Q3", "range": "A1:B2"}],
         "cells": {"B9": {"value": 1, "colour": "red"}}, "validations": [{"range": "C1:C9", "list": ["a,b"]}],
         "charts": [{"type": "radar", "data": "A1:B2", "at": "D2"}],
         "protect": {"password": "in the spec"}},
    ]}
    out = tmp_path / "never.xlsx"
    line = failed(run(SKILL, CREATE, spec_file(tmp_path, bad), "-o", out, ok=False), "xlsx_create.py")
    for words in ("Bad/name", "'Q3' can't be a table name", "colour", "without commas", "radar", "password_file"):
        assert words in line, words
    assert not out.exists()


def test_table_headings_must_be_text_and_unique(run, tmp_path, failed):
    spec = {"sheets": [{"name": "S", "rows": [["Item", "Item"], ["a", 1]], "tables": [{"name": "T", "range": "A1:B2"}]}]}
    line = failed(run(SKILL, CREATE, spec_file(tmp_path, spec), "-o", tmp_path / "x.xlsx", ok=False), "xlsx_create.py")
    assert "headings" in line


def test_unknown_functions_are_written_but_flagged(run, tmp_path):
    spec = {"sheets": [{"name": "S", "rows": [[1, '=XLOOKUP(1,A1:A1,A1:A1)', "=_xlfn.IFS(A1>0,1)", "=Other!A1"]]}]}
    out = tmp_path / "f.xlsx"
    r = run(SKILL, CREATE, spec_file(tmp_path, spec), "-o", out, ok=False)
    assert r.code == 1 and out.exists()
    problems = r.json()["formula_problems"]
    assert [p["cell"] for p in problems] == ["B1", "D1"]
    assert "_xlfn.XLOOKUP" in problems[0]["problem"] and "Other" in problems[1]["problem"]


def test_it_never_writes_over_the_spec(run, tmp_path, failed):
    spec = spec_file(tmp_path, {"sheets": [{"name": "S"}]}, "spec.xlsx")
    before = spec.read_bytes()
    assert "won't write over" in failed(run(SKILL, CREATE, spec, "-o", spec, ok=False), "xlsx_create.py")
    assert spec.read_bytes() == before


def test_a_spec_that_is_not_json_is_one_line(run, tmp_path, failed):
    path = tmp_path / "spec.json"
    path.write_text("{sheets: [", encoding="utf-8")
    assert "isn't valid JSON" in failed(run(SKILL, CREATE, path, "-o", tmp_path / "x.xlsx", ok=False), "xlsx_create.py")


def test_the_built_workbook_calculates(run, tmp_path, libreoffice):
    (tmp_path / "pw.txt").write_text("pw", encoding="utf-8")
    out, calc = tmp_path / "report.xlsx", tmp_path / "calc.xlsx"
    run(SKILL, CREATE, spec_file(tmp_path, FULL), "-o", out)
    report = run(SKILL, "soffice.py", "recalc", out, "-o", calc).json()
    assert report["error_count"] == 0
    sales = load_workbook(calc, data_only=True)["Продажи"]
    assert sales["G2"].value == pytest.approx(1140 + 880 + 973.75)
    assert sales["G3"].value == pytest.approx(0.75 * (1140 + 880 + 973.75))
