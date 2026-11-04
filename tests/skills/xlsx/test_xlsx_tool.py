"""xlsx_tool.py: every command on real workbooks and CSV files, including the ways they go wrong."""

from __future__ import annotations

import codecs
import json
import zipfile
from pathlib import Path

import pytest
from openpyxl import Workbook, load_workbook

SKILL, TOOL = "xlsx", "xlsx_tool.py"
COMMANDS = ["info", "read", "diff", "to-csv", "from-csv", "edit", "restructure"]


def write_json(path: Path, data: object) -> Path:
    path.write_text(json.dumps(data), encoding="utf-8")
    return path


@pytest.mark.parametrize("command", COMMANDS)
def test_every_command_has_help(run, command):
    r = run(SKILL, TOOL, command, "--help")
    assert "usage:" in r.out and "example:" in r.out


# ---------------------------------------------------------------- info and read


def test_info_says_what_the_workbook_holds(run, book, title):
    info = run(SKILL, TOOL, "info", book).json()
    data = info["sheets"][0]
    assert [s["name"] for s in info["sheets"]] == ["Data", "My Summary", title]
    assert data["tables"] == [{"name": "Sales", "range": "A1:D4", "columns": ["Region", "Units", "Price", "Revenue"]}]
    assert data["charts"] == 1 and data["notes"] == 1 and data["freeze"] == "A2"
    assert sorted(data["merged"]) == ["F1:G1", "F2:F4"]
    assert {n["name"] for n in info["names"]} == {"Total", "Units"}
    # written by openpyxl, so no formula has a saved result yet
    assert info["results"] == "missing" and "note" in info
    assert info["would_lose_on_save"] == [] and info["macros"] is False


def test_info_names_what_a_save_would_drop(run, book_with_extras):
    lost = run(SKILL, TOOL, "info", book_with_extras).json()["would_lose_on_save"]
    assert "slicers" in lost
    assert "drawn shapes and text boxes (1)" in lost


def test_read_shows_values_formulas_or_both(run, book, title):
    r = run(SKILL, TOOL, "read", book, "--sheet", "data", "--range", "A1:D5", "--show", "both").json()
    sheet = r["sheets"][0]
    assert sheet["name"] == "Data" and sheet["range"] == "A1:D5"
    assert sheet["rows"][0]["values"] == ["Region", "Units", "Price", "Revenue"]
    assert sheet["rows"][1]["values"][3] == {"formula": "=B2*C2", "value": None}
    assert sheet["formulas_without_saved_result"] == 4 and "note" in r
    # a sheet name and text outside Windows-1252 come through a cp1252 pipe intact
    other = run(SKILL, TOOL, "read", book, "--sheet", title).json()["sheets"][0]
    assert other["name"] == title and other["rows"][0]["values"] == ["Żółć"]


def test_read_stops_at_max_rows(run, tmp_path):
    wb = Workbook()
    for i in range(1, 31):
        wb.active.append([i, f"row {i}"])
    path = tmp_path / "long.xlsx"
    wb.save(path)
    sheet = run(SKILL, TOOL, "read", path, "--max-rows", "10").json()["sheets"][0]
    assert len(sheet["rows"]) == 10 and sheet["truncated"] is True and "note" in sheet


def test_number_options_are_checked(run, book, failed):
    assert "--max-rows" in failed(run(SKILL, TOOL, "read", book, "--max-rows", "0", ok=False), "xlsx_tool.py read")
    assert "--limit" in failed(run(SKILL, TOOL, "diff", book, book, "--limit", "-1", ok=False), "xlsx_tool.py diff")
    r = run(SKILL, TOOL, "restructure", book, "--sheet", "Data", "--insert-rows", "3", "--count", "0", "-o",
            book.parent / "x.xlsx", ok=False)
    assert "--count" in failed(r, "xlsx_tool.py restructure")
    r = run(SKILL, TOOL, "restructure", book, "--sheet", "Data", "--delete-rows", "0", "-o", book.parent / "x.xlsx", ok=False)
    assert "from 1" in failed(r, "xlsx_tool.py restructure")


# ---------------------------------------------------------------- restructure


def test_inserting_rows_moves_references_everywhere(run, book, tmp_path):
    out = tmp_path / "inserted.xlsx"
    r = run(SKILL, TOOL, "restructure", book, "--sheet", "Data", "--insert-rows", "3", "--count", "2", "-o", out, ok=False)
    assert r.code == 1  # the chart and the INDIRECT formula weren't moved, and the result says so
    rep = r.json()
    wb = load_workbook(out)
    d, s = wb["Data"], wb["My Summary"]
    assert d["D7"].value == "=SUM(D2:D6)"  # the range spanning the insert grew
    assert d["D6"].value == "=B6*C6" and d["D2"].value == "=B2*C2"
    assert s["A1"].value == "=SUM(Data!D2:D6)"
    assert s["A2"].value == "='Data'!$D$7*2"
    assert s["A4"].value == '="D3 is "&Data!D5'  # moved, while the text in quotes didn't
    assert s["A3"].value == "=SUM(Sales[Revenue])" and s["A6"].value == "=SUM(Data!B:B)"
    assert s["A7"].value == "=SUM(Data!2:5)"
    assert {n: x.attr_text for n, x in wb.defined_names.items()} == {"Total": "Data!$D$7", "Units": "Data!$B$2:$B$6"}
    assert sorted(str(m) for m in d.merged_cells.ranges) == ["F1:G1", "F2:F6"]
    table = d.tables["Sales"]
    assert table.ref == "A1:D6" and table.autoFilter.ref == "A1:D6"
    assert [str(v.sqref) for v in d.data_validations.dataValidation] == ["A2:A6"]
    assert [v.formula1 for v in s.data_validations.dataValidation] == ["Data!$A$2:$A$6"]
    assert [str(c.sqref) for c in d.conditional_formatting] == ["D2:D6"]
    assert d.freeze_panes == "A2" and d.print_area == "'Data'!$A$1:$D$7"
    assert d.row_dimensions[5].height == 30 and not d.row_dimensions[3].height
    assert d["B5"].comment.text == "checked"
    assert d["A6"].hyperlink.ref == "A6"  # openpyxl itself would leave the link on A4
    chart = next(x for x in rep["not_shifted"] if x["what"] == "chart")
    assert {"now": "'Data'!$D$2:$D$4", "should_be": "'Data'!$D$2:$D$6"} in chart["data"]
    assert any("INDIRECT" in x["what"] and x["cells"] == ["My Summary!A5"] for x in rep["not_shifted"])
    assert wb.worksheets[2]["A2"].value == "=Data!D7"
    assert rep["formulas_changed"] == 8 and not rep.get("ref_errors")


def test_inserting_above_a_frozen_row_and_conditional_rules(run, book, tmp_path):
    out = tmp_path / "top.xlsx"
    rep = run(SKILL, TOOL, "restructure", book, "--sheet", "Data", "--insert-rows", "1", "-o", out, ok=False).json()
    d = load_workbook(out)["Data"]
    assert d.freeze_panes == "A3" and rep["freeze"] == {"from": "A2", "to": "A3"}
    rule = next(iter(d.conditional_formatting)).rules[0]
    assert rule.formula == ["$D3>50"]
    chart = next(x for x in rep["not_shifted"] if x["what"] == "chart")
    assert chart["position"] and chart["at"] == "I2"


def test_deleting_rows_leaves_ref_errors_and_shrinks_ranges(run, book, tmp_path):
    out = tmp_path / "deleted.xlsx"
    r = run(SKILL, TOOL, "restructure", book, "--sheet", "Data", "--delete-rows", "3", "-o", out, ok=False)
    assert r.code == 1
    rep = r.json()
    assert rep["cells_deleted"] == 4
    assert {"cell": "My Summary!A4", "formula": '="D3 is "&#REF!'} in rep["ref_errors"]
    wb = load_workbook(out)
    d = wb["Data"]
    assert d["D4"].value == "=SUM(D2:D3)" and d["A3"].value == "East"
    assert d.tables["Sales"].ref == "A1:D3"
    assert sorted(str(m) for m in d.merged_cells.ranges) == ["F1:G1", "F2:F3"]
    assert wb.defined_names["Total"].attr_text == "Data!$D$4"


def test_a_column_inserted_inside_a_table_becomes_a_table_column(run, book, tmp_path):
    out = tmp_path / "col.xlsx"
    run(SKILL, TOOL, "restructure", book, "--sheet", "Data", "--insert-cols", "C", "-o", out, ok=False)
    d = load_workbook(out)["Data"]
    table = d.tables["Sales"]
    assert table.ref == "A1:E4"
    assert [c.name for c in table.tableColumns] == ["Region", "Units", "Column1", "Price", "Revenue"]
    assert d["C1"].value == "Column1" and d["E2"].value == "=B2*D2"
    assert sorted(str(m) for m in d.merged_cells.ranges) == ["G1:H1", "G2:G4"]


def test_deleting_a_column_reports_what_pointed_at_it(run, book, tmp_path):
    out = tmp_path / "nocol.xlsx"
    rep = run(SKILL, TOOL, "restructure", book, "--sheet", "Data", "--delete-cols", "B", "-o", out, ok=False).json()
    errors = rep["ref_errors"]
    assert {"cell": "Data!C2", "formula": "=#REF!*B2"} in errors
    assert {"name": "Units", "refers_to": "#REF!"} in errors
    assert [c.name for c in load_workbook(out)["Data"].tables["Sales"].tableColumns] == ["Region", "Price", "Revenue"]


def test_a_delete_that_would_break_a_table_is_refused(run, book, tmp_path, failed):
    out = tmp_path / "broken.xlsx"
    r = run(SKILL, TOOL, "restructure", book, "--sheet", "Data", "--delete-rows", "1", "-o", out, ok=False)
    assert "header row of table Sales" in failed(r, "xlsx_tool.py restructure")
    r = run(SKILL, TOOL, "restructure", book, "--sheet", "Data", "--delete-rows", "2", "--count", "3", "-o", out, ok=False)
    assert "no rows" in failed(r, "xlsx_tool.py restructure")
    assert not out.exists()


def test_restructure_needs_the_sheet_when_there_are_several(run, book, tmp_path, failed):
    r = run(SKILL, TOOL, "restructure", book, "--insert-rows", "2", "-o", tmp_path / "x.xlsx", ok=False)
    assert "--sheet" in failed(r, "xlsx_tool.py restructure")


def test_restructured_workbooks_calculate_cleanly(run, book, tmp_path, libreoffice):
    """LibreOffice opens each result, and its totals match the original's."""
    before = tmp_path / "before.xlsx"
    run(SKILL, "soffice.py", "recalc", book, "-o", before)
    total = load_workbook(before, data_only=True)["My Summary"]["A1"].value
    assert total == 205
    for args, cell in ((["--insert-rows", "3", "--count", "2"], "A1"), (["--insert-cols", "C"], "A1")):
        out, calc = tmp_path / "out.xlsx", tmp_path / "calc.xlsx"
        run(SKILL, TOOL, "restructure", book, "--sheet", "Data", *args, "-o", out, ok=False)
        report = run(SKILL, "soffice.py", "recalc", out, "-o", calc).json()
        assert report["error_count"] == 0, (args, report["errors"])
        values = load_workbook(calc, data_only=True)
        assert values["My Summary"][cell].value == total
        assert values["My Summary"]["A2"].value == 2 * total


# ---------------------------------------------------------------- edit


def test_edit_sets_appends_renames_and_names(run, book, tmp_path):
    from openpyxl.worksheet.table import Table

    wb = load_workbook(book)
    wb["Data"]["D5"] = None  # leave room under the table
    wb["Data"]["E5"] = "=SUM(D2:D5)"
    src = tmp_path / "room.xlsx"
    wb.save(src)
    changes = write_json(tmp_path / "changes.json", {"changes": [
        {"do": "set", "sheet": "Data", "cells": {"C2": 2.75, "H1": {"text": "=not a formula"}, "H2": "42",
                                                 "H3": {"date": "2026-01-31"}, "A1": "Area",
                                                 "H4": {"value": 0.25, "number_format": "0%", "bold": True}}},
        {"do": "append", "table": "Sales", "rows": [["West", 40, 5, "=B5*C5"]]},
        {"do": "rename_sheet", "sheet": "Data", "to": "Sales data"},
        {"do": "name", "name": "Rate", "refers_to": "'Sales data'!$C$2"},
        {"do": "format", "sheet": "Sales data", "range": "C2:C5", "number_format": "#,##0.00"},
    ]})
    out = tmp_path / "edited.xlsx"
    r = run(SKILL, TOOL, "edit", src, "--changes", changes, "-o", out, ok=False)
    assert r.code == 1  # the INDIRECT text still names Data
    rep = r.json()
    assert rep["not_updated"]["cells"] == ["My Summary!A5"]
    assert rep["text_that_looks_like_numbers"]["cells"] == ["Sales data!H2"]
    wb = load_workbook(out)
    assert wb.sheetnames[0] == "Sales data"
    d, s = wb["Sales data"], wb["My Summary"]
    assert s["A1"].value == "=SUM('Sales data'!D2:D4)"
    assert wb.defined_names["Total"].attr_text == "'Sales data'!$D$5"
    assert wb.defined_names["Rate"].attr_text == "'Sales data'!$C$2"
    assert [v.formula1 for v in s.data_validations.dataValidation] == ["'Sales data'!$A$2:$A$4"]
    series = d._charts[0].series[0]
    assert series.val.numRef.f == "'Sales data'!$D$2:$D$4"
    table = d.tables["Sales"]
    assert table.ref == "A1:D5" and [c.name for c in table.tableColumns][0] == "Area"
    assert d["A5"].value == "West" and d["D5"].value == "=B5*C5"
    assert d["H1"].value == "=not a formula" and d["H1"].data_type == "s"
    assert d["H2"].value == "42" and d["H4"].font.b and d["H4"].number_format == "0%"
    assert d["C5"].number_format == "#,##0.00"
    assert d["H3"].number_format == "yyyy-mm-dd"


def test_edit_lists_every_problem_and_writes_nothing(run, book, tmp_path, failed):
    changes = write_json(tmp_path / "bad.json", {"changes": [
        {"do": "set", "sheet": "Nope", "cells": {"A1": 1}},
        {"do": "set", "sheet": "Data", "cells": {"G1": 5, "ZZZZ1": 2}},
        {"do": "rename_sheet", "sheet": "Data", "to": "a/b"},
        {"do": "explode"},
    ]})
    out = tmp_path / "never.xlsx"
    line = failed(run(SKILL, TOOL, "edit", book, "--changes", changes, "-o", out, ok=False), "xlsx_tool.py edit")
    assert "4 problems" in line or "5 problems" in line
    for words in ("no sheet named 'Nope'", "G1 is inside merged cells F1:G1", "isn't a cell address", "a/b", "explode"):
        assert words in line, words
    assert not out.exists()


def test_edit_flags_formulas_excel_would_not_know(run, book, tmp_path):
    changes = write_json(tmp_path / "f.json", {"changes": [{"do": "set", "sheet": "Data", "cells": {
        "H1": '=XLOOKUP("North",A2:A4,D2:D4)', "H2": '=_xlfn.XLOOKUP("North",A2:A4,D2:D4)', "H3": "=Nowhere!A1"}}]})
    r = run(SKILL, TOOL, "edit", book, "--changes", changes, "-o", tmp_path / "f.xlsx", ok=False)
    assert r.code == 1
    problems = {(p["cell"], p["problem"].split(" ")[0]) for p in r.json()["formula_problems"]}
    assert ("H1", "XLOOKUP") in problems and ("H3", "refers") in problems
    assert not any(cell == "H2" for cell, _ in problems)


def test_edit_reports_what_the_save_dropped(run, book_with_extras, tmp_path):
    changes = write_json(tmp_path / "c.json", {"changes": [{"do": "set", "sheet": "Data", "cells": {"H1": 1}}]})
    r = run(SKILL, TOOL, "edit", book_with_extras, "--changes", changes, "-o", tmp_path / "out.xlsx", ok=False)
    assert r.code == 1
    assert "slicers" in r.json()["lost_on_save"]
    assert len(load_workbook(tmp_path / "out.xlsx")["Data"]._charts) == 1  # charts survive a load and save


def test_macros_stay_and_need_an_xlsm(run, macro_book, tmp_path, failed):
    changes = write_json(tmp_path / "c.json", {"changes": [{"do": "set", "cells": {"B1": 2}}]})
    r = run(SKILL, TOOL, "edit", macro_book, "--changes", changes, "-o", tmp_path / "out.xlsx", ok=False)
    assert ".xlsm" in failed(r, "xlsx_tool.py edit")
    out = tmp_path / "out.xlsm"
    run(SKILL, TOOL, "edit", macro_book, "--changes", changes, "-o", out)
    with zipfile.ZipFile(out) as z:
        assert "xl/vbaProject.bin" in z.namelist()
        assert "macroEnabled" in z.read("[Content_Types].xml").decode("utf-8")
    assert run(SKILL, TOOL, "info", out).json()["macros"] is True


def test_pictures_need_pillow_before_an_edit(book, tmp_path, monkeypatch):
    """openpyxl drops pictures when Pillow is missing, so the script refuses to change such a workbook."""
    import importlib.util
    import sys

    from openpyxl.drawing.image import Image as Picture
    from PIL import Image

    Image.new("RGB", (10, 10), (200, 30, 30)).save(tmp_path / "dot.png")
    wb = load_workbook(book)
    wb["Data"].add_image(Picture(str(tmp_path / "dot.png")), "K20")
    pictured = tmp_path / "pictured.xlsx"
    wb.save(pictured)

    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location("xlsx_tool_under_test", Path(__file__).resolve().parents[3] /
                                                  "skills" / "athena" / "xlsx" / "scripts" / "xlsx_tool.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    real = module.importlib.util.find_spec
    monkeypatch.setattr(module.importlib.util, "find_spec", lambda name, *a: None if name == "PIL" else real(name, *a))
    with pytest.raises(module.Fail, match="pillow"):
        module.open_book(str(pictured), edit=True)
    assert module.open_book(str(pictured))  # only reading is fine


# ---------------------------------------------------------------- diff


def test_diff_lists_changed_cells(run, book, tmp_path):
    assert run(SKILL, TOOL, "diff", book, book).json()["same"] is True
    changes = write_json(tmp_path / "c.json", {"changes": [{"do": "set", "sheet": "Data", "cells": {"C2": 9}}]})
    out = tmp_path / "changed.xlsx"
    run(SKILL, TOOL, "edit", book, "--changes", changes, "-o", out)
    r = run(SKILL, TOOL, "diff", book, out).json()
    assert r["same"] is False and r["changed_cells"] == 1
    assert r["changes"] == [{"sheet": "Data", "cell": "C2", "before": 2.5, "after": 9}]


# ---------------------------------------------------------------- CSV

GERMAN = ("Kunde;Betrag;Datum;PLZ;Notiz\r\nMüller;1.234,50;2026-01-31;01067;=SUMME(A1)\r\n"
          "Żółć;12,5;31.01.2026;80331;ok\r\nSmith;-3,25%;2026-02-01 14:30;12345678901234567;\r\n")


@pytest.mark.parametrize("name, data, encoding", [
    ("utf16.csv", codecs.BOM_UTF16_LE + GERMAN.encode("utf-16-le"), "utf-16"),
    ("bom.csv", GERMAN.encode("utf-8-sig"), "utf-8 with BOM"),
    ("ansi.csv", GERMAN.replace("Żółć", "Gärtner").encode("cp1252"), "cp1252"),
])
def test_from_csv_reads_european_files(run, tmp_path, name, data, encoding):
    src = tmp_path / name
    src.write_bytes(data)
    out = tmp_path / "de.xlsx"
    rep = run(SKILL, TOOL, "from-csv", src, "-o", out, "--text-columns", "PLZ").json()["sheets"][0]
    assert rep["encoding"] == encoding and rep["delimiter"] == ";" and rep["decimal"] == "comma (guessed)"
    assert rep["dates_left_as_text"]["count"] == 1
    ws = load_workbook(out).active
    assert ws["A2"].value == "Müller" and ws["A3"].value in ("Żółć", "Gärtner")
    assert ws["B2"].value == 1234.5 and ws["B3"].value == 12.5 and ws["B4"].value == pytest.approx(-0.0325)
    assert ws["C2"].value.year == 2026 and ws["C3"].value == "31.01.2026"
    assert ws["D2"].value == "01067" and ws["D3"].value == "80331"  # a text column, so the postcode stays as written
    assert ws["D4"].value == "12345678901234567"
    assert ws["E2"].value == "=SUMME(A1)" and ws["E2"].data_type == "s"  # text from a file never becomes a formula
    assert ws.freeze_panes == "A2" and ws["A1"].font.b


def test_from_csv_follows_sep_lines_and_date_order(run, tmp_path):
    src = tmp_path / "hinted.csv"
    src.write_text("sep=|\nName|When|Code\nA|31/01/2026|007\nB|01/02/2026|8\n", encoding="utf-8")
    out = tmp_path / "hinted.xlsx"
    rep = run(SKILL, TOOL, "from-csv", src, "-o", out, "--dates", "dmy").json()["sheets"][0]
    assert rep["delimiter"].startswith("|") and rep["kept_as_text_leading_zeros"]["count"] == 1
    ws = load_workbook(out).active
    assert ws["A1"].value == "Name" and ws["B2"].value.month == 1 and ws["B3"].value.month == 2
    assert ws["C2"].value == "007" and ws["C3"].value == 8


def test_from_csv_flags_rows_of_the_wrong_length(run, tmp_path):
    src = tmp_path / "commas.csv"
    src.write_text("Item,Price\nTea,2,50\nCake,3\n", encoding="utf-8")  # a decimal comma in a comma file
    r = run(SKILL, TOOL, "from-csv", src, "-o", tmp_path / "x.xlsx", ok=False)
    assert r.code == 1 and r.json()["sheets"][0]["ragged_rows"]["rows"] == [2]


def test_from_csv_refuses_a_wrong_encoding_in_one_line(run, tmp_path, failed):
    src = tmp_path / "ansi.csv"
    src.write_bytes("Name\nGärtner\n".encode("cp1252"))
    r = run(SKILL, TOOL, "from-csv", src, "-o", tmp_path / "x.xlsx", "--encoding", "utf-8", ok=False)
    assert "isn't utf-8" in failed(r, "xlsx_tool.py from-csv")


def test_csv_round_trip_keeps_the_values(run, tmp_path):
    src = tmp_path / "in.csv"
    src.write_bytes(GERMAN.encode("utf-8-sig"))
    book = tmp_path / "mid.xlsx"
    run(SKILL, TOOL, "from-csv", src, "-o", book, "--text-columns", "PLZ")
    back = tmp_path / "back.csv"
    r = run(SKILL, TOOL, "to-csv", book, "-o", back, "--delimiter", ";", "--decimal", "comma", "--encoding", "utf-8-sig")
    assert r.json()["rows"] == 4
    raw = back.read_bytes()
    assert raw.startswith(codecs.BOM_UTF8)
    lines = raw.decode("utf-8-sig").splitlines()
    assert lines[1] == "Müller;1234,5;2026-01-31;01067;=SUMME(A1)"
    assert lines[2].startswith("Żółć;12,5;31.01.2026;80331")
    assert lines[3] == "Smith;-0,0325;2026-02-01 14:30:00;12345678901234567;"


def test_to_csv_refuses_letters_the_code_page_lacks(run, tmp_path, failed):
    wb = Workbook()
    wb.active.append(["Name"])
    wb.active.append(["Żółć"])
    src = tmp_path / "names.xlsx"
    wb.save(src)
    out = tmp_path / "names.csv"
    r = run(SKILL, TOOL, "to-csv", src, "-o", out, "--encoding", "cp1252", ok=False)
    assert "utf-8-sig" in failed(r, "xlsx_tool.py to-csv") and not out.exists()


def test_to_csv_says_when_results_are_missing(run, book, tmp_path):
    r = run(SKILL, TOOL, "to-csv", book, "--sheet", "Data", "-o", tmp_path / "d.csv", ok=False)
    assert r.code == 1 and r.json()["formulas_without_saved_result"]["count"] == 4


def test_to_csv_after_recalculating(run, book, tmp_path, libreoffice):
    calc = tmp_path / "calc.xlsx"
    run(SKILL, "soffice.py", "recalc", book, "-o", calc)
    out = tmp_path / "data.csv"
    run(SKILL, TOOL, "to-csv", calc, "--sheet", "Data", "-o", out)
    lines = out.read_text(encoding="utf-8").splitlines()
    assert lines[1] == "North,10,2.5,25,," and lines[4] == ",,,205,,"


# ---------------------------------------------------------------- safety and bad input


def test_nothing_writes_over_its_input(run, book, tmp_path, failed):
    before = book.read_bytes()
    changes = write_json(tmp_path / "c.json", {"changes": [{"do": "set", "sheet": "Data", "cells": {"H1": 1}}]})
    for args in (["edit", book, "--changes", changes, "-o", book],
                 ["restructure", book, "--sheet", "Data", "--insert-rows", "2", "-o", book]):
        assert "won't write over the input" in failed(run(SKILL, TOOL, *args, ok=False), f"xlsx_tool.py {args[0]}")
    r = run(SKILL, TOOL, "edit", book, "--changes", changes, "-o", changes, ok=False)
    assert "won't write over the input" in failed(r, "xlsx_tool.py edit")
    assert book.read_bytes() == before


def test_an_output_that_is_a_folder_is_one_line(run, book, tmp_path, failed):
    folder = tmp_path / "out.xlsx"
    folder.mkdir()
    r = run(SKILL, TOOL, "restructure", book, "--sheet", "Data", "--insert-rows", "2", "-o", folder, ok=False)
    assert "folder" in failed(r, "xlsx_tool.py restructure")


@pytest.mark.parametrize("name, data, says", [
    ("text.xlsx", b"just some text", "isn't an Excel workbook"),
    ("locked.xlsx", b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"\0" * 64, "password-protected"),
    ("old.xls", b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"\0" * 64, "soffice.py convert"),
    ("data.csv", b"a,b\n1,2\n", "from-csv"),
])
def test_files_that_are_not_workbooks_are_one_line(run, tmp_path, failed, name, data, says):
    path = tmp_path / name
    path.write_bytes(data)
    assert says in failed(run(SKILL, TOOL, "info", path, ok=False), "xlsx_tool.py info")


def test_a_damaged_workbook_is_one_line(run, book, tmp_path, failed):
    cut = tmp_path / "cut.xlsx"
    data = book.read_bytes()
    cut.write_bytes(data[: len(data) // 2])
    assert "cut.xlsx" in failed(run(SKILL, TOOL, "read", cut, ok=False), "xlsx_tool.py read")
    assert "no such file" in failed(run(SKILL, TOOL, "info", tmp_path / "missing.xlsx", ok=False), "xlsx_tool.py info")


def test_a_changes_file_from_powershell_is_read(run, book, tmp_path):
    """Windows PowerShell 5.1's > writes UTF-16 with a byte-order mark."""
    path = tmp_path / "ps.json"
    path.write_bytes(codecs.BOM_UTF16_LE + json.dumps(
        {"changes": [{"do": "set", "sheet": "Data", "cells": {"H1": "Grüße"}}]}).encode("utf-16-le"))
    out = tmp_path / "ps.xlsx"
    run(SKILL, TOOL, "edit", book, "--changes", path, "-o", out)
    assert load_workbook(out)["Data"]["H1"].value == "Grüße"
