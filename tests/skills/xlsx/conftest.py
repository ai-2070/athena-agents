"""Real workbooks for the xlsx skill's tests, made with openpyxl (not with the scripts under test), and the real
LibreOffice when it's installed."""

from __future__ import annotations

import json
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parents[3] / "skills" / "athena" / "xlsx" / "scripts"
TITLE = "Отчёт о продажах"  # not in Windows-1252, so printing it proves the scripts switch their output to UTF-8


def make_book(path: Path) -> Path:
    """Two sheets that point at each other: formulas, a table, names, merged cells, validations (one on another
    sheet reading this one), a conditional format, a chart, a note, a link, frozen panes, a print area and a row
    height, plus a sheet with a non-Latin name."""
    from openpyxl import Workbook
    from openpyxl.chart import BarChart, Reference
    from openpyxl.comments import Comment
    from openpyxl.formatting.rule import FormulaRule
    from openpyxl.styles import PatternFill
    from openpyxl.workbook.defined_name import DefinedName
    from openpyxl.worksheet.datavalidation import DataValidation
    from openpyxl.worksheet.table import Table

    wb = Workbook()
    d = wb.active
    d.title = "Data"
    for row in [["Region", "Units", "Price", "Revenue"], ["North", 10, 2.5, "=B2*C2"], ["South", 20, 3, "=B3*C3"],
                ["East", 30, 4, "=B4*C4"]]:
        d.append(row)
    d["D5"] = "=SUM(D2:D4)"
    d["F1"] = "Merged title"
    d.merge_cells("F1:G1")
    d.merge_cells("F2:F4")
    d.add_table(Table(displayName="Sales", ref="A1:D4"))
    dv = DataValidation(type="list", formula1='"North,South,East,West"')
    d.add_data_validation(dv)
    dv.add("A2:A4")
    d.conditional_formatting.add("D2:D4", FormulaRule(formula=["$D2>50"], fill=PatternFill("solid", fgColor="FFC7CE")))
    d.freeze_panes = "A2"
    d.print_area = "A1:D5"
    d.row_dimensions[3].height = 30
    d["B3"].comment = Comment("checked", "tester")
    d["A4"].hyperlink = "https://example.com"
    chart = BarChart()
    chart.add_data(Reference(d, min_col=4, min_row=1, max_row=4), titles_from_data=True)
    chart.set_categories(Reference(d, min_col=1, min_row=2, max_row=4))
    d.add_chart(chart, "I2")

    s = wb.create_sheet("My Summary")
    s["A1"] = "=SUM(Data!D2:D4)"
    s["A2"] = "='Data'!$D$5*2"
    s["A3"] = "=SUM(Sales[Revenue])"
    s["A4"] = '="D3 is "&Data!D3'
    s["A5"] = '=INDIRECT("Data!D3")'
    s["A6"] = "=SUM(Data!B:B)"
    s["A7"] = "=SUM(Data!2:3)"
    pick = DataValidation(type="list", formula1="Data!$A$2:$A$4")
    s.add_data_validation(pick)
    pick.add("B1:B5")
    wb.defined_names["Total"] = DefinedName("Total", attr_text="Data!$D$5")
    wb.defined_names["Units"] = DefinedName("Units", attr_text="Data!$B$2:$B$4")

    r = wb.create_sheet(TITLE)
    r["A1"] = "Żółć"
    r["A2"] = "=Data!D5"
    wb.save(path)
    return path


@pytest.fixture
def book(tmp_path: Path) -> Path:
    return make_book(tmp_path / "book.xlsx")


@pytest.fixture
def title() -> str:
    return TITLE


def rewrite_zip(src: Path, dst: Path, change: dict, add: dict | None = None) -> Path:
    """Copy a workbook's zip, passing named parts through change[name](text) and adding the parts in add."""
    with zipfile.ZipFile(src) as zin, zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            data = zin.read(item.filename)
            if item.filename in change:
                data = change[item.filename](data.decode("utf-8")).encode("utf-8")
            zout.writestr(item, data)
        for name, data in (add or {}).items():
            zout.writestr(name, data)
    return dst


SHAPE = ('<twoCellAnchor><from><col>6</col><colOff>0</colOff><row>8</row><rowOff>0</rowOff></from>'
         '<to><col>8</col><colOff>0</colOff><row>12</row><rowOff>0</rowOff></to>'
         '<sp macro="" textlink=""><nvSpPr><cNvPr id="99" name="Text box"/><cNvSpPr/></nvSpPr><spPr/></sp>'
         '<clientData/></twoCellAnchor>')


@pytest.fixture
def book_with_extras(book: Path, tmp_path: Path) -> Path:
    """The workbook plus a drawn text box and a slicer part, which openpyxl leaves out when it saves."""
    def types(text: str) -> str:
        return text.replace("</Types>", '<Override PartName="/xl/slicers/slicer1.xml" '
                                         'ContentType="application/vnd.ms-excel.slicer+xml"/></Types>')

    return rewrite_zip(book, tmp_path / "extras.xlsx", {
        "xl/drawings/drawing1.xml": lambda t: t.replace("</wsDr>", SHAPE + "</wsDr>"),
        "[Content_Types].xml": types,
    }, {"xl/slicers/slicer1.xml": b'<slicers xmlns="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main"/>'})


@pytest.fixture
def macro_book(tmp_path: Path) -> Path:
    """An .xlsm: a workbook marked macro-enabled with a (stand-in) VBA project part."""
    from openpyxl import Workbook

    wb = Workbook()
    wb.active["A1"] = 1
    plain = tmp_path / "plain.xlsx"
    wb.save(plain)

    def types(text: str) -> str:
        text = text.replace("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
                            "application/vnd.ms-excel.sheet.macroEnabled.main+xml")
        return text.replace("</Types>", '<Default Extension="bin" ContentType="application/vnd.ms-office.vbaProject"/></Types>')

    def rels(text: str) -> str:
        return text.replace("</Relationships>", '<Relationship Id="rIdVba" Type="http://schemas.microsoft.com/office/'
                                                '2006/relationships/vbaProject" Target="vbaProject.bin"/></Relationships>')

    return rewrite_zip(plain, tmp_path / "macro.xlsm", {"[Content_Types].xml": types, "xl/_rels/workbook.xml.rels": rels},
                       {"xl/vbaProject.bin": b"VBA-STAND-IN" * 8})


def _failed(r, prog: str) -> str:
    """A run that couldn't do the job: exit 2, nothing on stdout, one line on stderr naming the script, no traceback."""
    assert r.code == 2, (r.code, r.out, r.err)
    assert r.out == ""
    lines = r.err.strip().splitlines()
    assert len(lines) == 1 and lines[0].startswith(prog) and "Traceback" not in r.err, r.err
    return lines[0]


@pytest.fixture
def failed():
    """failed(result, "xlsx_tool.py") checks a run failed in one line and returns that line."""
    return _failed


@pytest.fixture(scope="session")
def libreoffice() -> str:
    """The real soffice, found the way soffice.py finds it; tests that need it skip when there's none."""
    proc = subprocess.run([sys.executable, str(SCRIPTS / "soffice.py"), "find"], capture_output=True, timeout=60)
    if proc.returncode != 0:
        pytest.skip("LibreOffice isn't installed here (soffice.py find found none); set SOFFICE to run these tests")
    return json.loads(proc.stdout.decode("utf-8"))["soffice"]
