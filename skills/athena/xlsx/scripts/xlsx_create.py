#!/usr/bin/env python3
"""Make an Excel workbook (.xlsx) from a JSON spec, with openpyxl: rows and cells, formulas, number formats and
styles, column widths, frozen panes, filters, merged cells, tables, drop-down lists and other validations,
conditional formats, charts, notes, links, print setup, sheet protection and defined names.

Packages: openpyxl 3.1 or newer.

The spec (UTF-8 JSON; a password file's path is relative to the spec's folder):

  {
    "properties": {"title": "Q3 sales", "creator": "Finance"},
    "names": {"TaxRate": "Inputs!$B$3"},
    "sheets": [
      {
        "name": "Sales",
        "rows": [["Region", "Units", "Price", "Revenue"], ["North", 120, 9.5, "=B2*C2"]],
        "start": "A1",                      # where rows begin (default A1)
        "header": true,                     # first row bold, frozen below it, filter on (unless a table is there)
        "cells": {"F1": "Total", "F2": {"formula": "=SUM(D2:D9)", "number_format": "#,##0.00", "bold": true}},
        "formats": {"C2:D9": {"number_format": "#,##0.00"}},
        "widths": {"A": 18},                # or "auto" (the default)
        "freeze": "A2", "filter": "A1:D9", "merge": ["A12:D12"],
        "tables": [{"name": "SalesTable", "range": "A1:D9", "style": "TableStyleMedium2"}],
        "validations": [{"range": "E2:E9", "list": ["Open", "Done"]}, {"range": "B2:B9", "whole": [0, 1000]},
                        {"range": "F2:F9", "source": "Lists!$A$1:$A$9"}],
        "conditional": [{"range": "D2:D9", "when": ">", "value": 1000, "fill": "C6EFCE"},
                        {"range": "B2:B9", "scale": ["F8696B", "FFEB84", "63BE7B"]},
                        {"range": "A2:D9", "formula": "$D2>1000", "bold": true}],
        "charts": [{"type": "column", "data": "B1:B9", "categories": "A2:A9", "at": "G2", "title": "Units"}],
        "print": {"landscape": true, "fit_width": true, "paper": "A4", "title_rows": "1:1", "area": "A1:D9"},
        "protect": {"password_file": "pw.txt", "unlocked": ["B2:C9"]},
        "tab_color": "1F4E79", "hidden": false
      }
    ]
  }

A cell is a number, true/false, null, text (text starting with = is a formula), or an object with one of value,
formula, text (stays text even when it starts with =), date ("2026-01-31") or datetime ("2026-01-31 14:30"), plus
any of number_format, bold, italic, size, font_color, fill, align, wrap, border, note and link. Chart types: column,
bar, line, area, pie, scatter (with "x" for the x values). references/create-spec.md has every key.

openpyxl writes formulas but never calculates them: the file holds no results until a spreadsheet program opens it
(soffice.py recalc makes a calculated copy to check).

The result is printed on stdout as JSON. Exit codes: 0 done; 1 written, but a formula uses a function Excel 2007
doesn't know without the _xlfn. prefix, or a sheet that isn't there (listed in the JSON); 2 nothing written: the
spec has problems (all listed on the one stderr line) or the file couldn't be saved.
"""

from __future__ import annotations

import argparse
import codecs
import datetime as dt
import importlib
import json
import locale
import math
import os
import re
import sys
import tempfile
import warnings
import zipfile
from collections import Counter
from copy import copy
from typing import Any, Callable, NoReturn
from xml.etree import ElementTree


# ---------------------------------------------------------------- shared helpers
# xlsx_tool.py and xlsx_create.py each stand alone, so the helpers they share are copies, kept identical (the tests
# check): change one, change both.


def utf8_output() -> None:
    # A Windows pipe is cp1252 unless the script says otherwise; sheet names and cell text often aren't.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
        except (AttributeError, ValueError):
            pass


class Fail(Exception):
    """A problem to report in one line and exit 2."""


def need_openpyxl() -> Any:
    try:
        openpyxl = importlib.import_module("openpyxl")
    except ImportError:
        raise Fail("needs the Python package openpyxl: python -m pip install openpyxl") from None
    version = tuple(int(p) for p in re.findall(r"\d+", openpyxl.__version__)[:2])
    if version < (3, 1):
        raise Fail(f"needs openpyxl 3.1 or newer (this is {openpyxl.__version__}): "
                   "python -m pip install --upgrade openpyxl")
    return openpyxl


# What a result also says, gathered while the command runs: an input read in an encoding other than UTF-8, and what
# openpyxl warned about while reading (often a part of the file it is going to leave out).
NOTES: dict[str, Any] = {}


def emit(data: dict[str, Any]) -> None:
    """Print the result on stdout as JSON, with the notes gathered on the way."""
    for key, value in NOTES.items():
        data.setdefault(key, value)
    print(json.dumps(data, ensure_ascii=False, indent=2, default=str))


def note_warning(message: Any, category: Any, filename: str, lineno: int, file: Any = None, line: Any = None) -> None:
    """Put what openpyxl warns about into the result instead of on stderr, which carries only a failure's reason."""
    text = " ".join(str(message).split())
    found = NOTES.setdefault("library_warnings", [])
    if text not in found:
        found.append(text)


class Parser(argparse.ArgumentParser):
    """argparse, reporting a mistake in the command line in one line with exit code 2, like any other failure."""

    def error(self, message: str) -> NoReturn:
        self.exit(2, f"{self.prog}: {message} (see --help)\n")


def run_job(prog: str, job: Callable[[], int]) -> int:
    """Run a command, and turn whatever stops it into one line on stderr and exit code 2, never a traceback."""
    warnings.simplefilter("always")
    warnings.showwarning = note_warning
    try:
        return job()
    except Fail as e:
        why = str(e)
    except OSError as e:  # a file open in Excel on Windows, a full disk, a folder where a file should go
        where = e.filename2 or e.filename  # for a move into place, the second name is the output
        hint = " (if Excel has it open, close it there first)" if isinstance(e, PermissionError) else ""
        why = f"{e.strerror or e}" + (f": {where}" if where else "") + hint
    except Exception as e:  # a damaged file can fail deep inside openpyxl
        why = f"stopped unexpectedly ({type(e).__name__}: {e})"
    print(f"{prog}: " + " ".join(why.split()), file=sys.stderr)
    return 2


def decode(raw: bytes, path: str) -> str:
    """The text of a file, whichever way Windows PowerShell 5.1 wrote it: > and Out-File write UTF-16, Set-Content
    the ANSI code page, -Encoding utf8 UTF-8 with a byte-order mark."""
    if raw[:2] in (codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE):
        return raw.decode("utf-16", "replace")
    try:
        return raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        ansi = locale.getpreferredencoding(False)
        if codecs.lookup(ansi).name == "utf-8":
            ansi = "cp1252"  # not this machine's code page, so most likely Windows' Western European one
        NOTES.setdefault("encoding_notes", []).append(f"{path} isn't UTF-8; read it as {ansi}")
        return raw.decode(ansi, "replace")


def load_json(path: str) -> Any:
    try:
        with open(path, "rb") as fh:
            return json.loads(decode(fh.read(), path))
    except FileNotFoundError:
        raise Fail(f"no such file: {path}") from None
    except json.JSONDecodeError as e:
        raise Fail(f"{path} isn't valid JSON: {e}") from None


def same_file(a: str, b: str) -> bool:
    if os.path.exists(a) and os.path.exists(b):
        return os.path.samefile(a, b)
    return os.path.normcase(os.path.realpath(a)) == os.path.normcase(os.path.realpath(b))


def check_output(out: str, inputs: list[str]) -> None:
    for src in inputs:
        if same_file(out, src):
            raise Fail(f"won't write over the input {src}: give -o another path (to change the user's file, copy it "
                       "to a backup first and write from the backup to the original name)")
    if os.path.isdir(out):
        raise Fail(f"-o names a folder, not a file: {out}")
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)


def write_atomic(out: str, write: Callable[[Any], None]) -> None:
    """Write to a temporary file beside the output, then move it into place, so a failure leaves no half file."""
    folder = os.path.dirname(os.path.abspath(out))
    script = os.path.splitext(os.path.basename(__file__))[0]
    fd, tmp = tempfile.mkstemp(prefix=f".{script}-", suffix=".part", dir=folder)
    try:
        with os.fdopen(fd, "wb") as fh:
            write(fh)
        os.replace(tmp, out)
    except BaseException:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise


# Excel's own limits ("Excel specifications and limits")
MAX_ROW, MAX_COL, MAX_TEXT = 1048576, 16384, 32767
BOOK_TYPES = (".xlsx", ".xlsm", ".xltx", ".xltm")
MACRO_TYPES = (".xlsm", ".xltm")


def sheet_name_problem(name: Any) -> str | None:
    """Why Excel would refuse this sheet name, or None."""
    if not isinstance(name, str) or not name.strip():
        return "a sheet name is text that isn't empty"
    if len(name) > 31:
        return f"sheet names are at most 31 characters ({name!r} has {len(name)})"
    bad = sorted(set(re.findall(r"[\\/?*\[\]:]", name)))
    if bad:
        return f"sheet name {name!r} has {' '.join(bad)}, which Excel doesn't allow"
    if name.startswith("'") or name.endswith("'"):
        return f"sheet name {name!r} can't start or end with an apostrophe"
    if name.casefold() == "history":
        return "Excel keeps the sheet name History for itself"
    return None


def parse_color(value: Any) -> str | None:
    """'1F4E79' or '#1F4E79' -> '1F4E79'; None when it isn't a colour like that."""
    if isinstance(value, str) and re.fullmatch(r"#?[0-9A-Fa-f]{6}", value.strip()):
        return value.strip().lstrip("#").upper()
    return None


STYLE_KEYS = ("number_format", "bold", "italic", "size", "font_color", "fill", "align", "wrap", "border")


def apply_style(cell: Any, spec: dict[str, Any], where: str, problems: list[str]) -> None:
    """Apply the style keys of a cell spec (number_format, bold, italic, size, font_color, fill, align, wrap,
    border) to an openpyxl cell, keeping the rest of its look."""
    from openpyxl.styles import Alignment, Border, PatternFill, Side

    if "number_format" in spec:
        if isinstance(spec["number_format"], str) and spec["number_format"]:
            cell.number_format = spec["number_format"]
        else:
            problems.append(f"{where}: number_format is an Excel format such as \"#,##0.00\" or \"yyyy-mm-dd\"")
    font = copy(cell.font)
    font_changed = False
    for key, attr in (("bold", "b"), ("italic", "i")):
        if key in spec:
            if isinstance(spec[key], bool):
                setattr(font, attr, spec[key])
                font_changed = True
            else:
                problems.append(f"{where}: {key} is true or false")
    if "size" in spec:
        size = spec["size"]
        if isinstance(size, (int, float)) and not isinstance(size, bool) and 1 <= size <= 409:
            font.sz = size
            font_changed = True
        else:
            problems.append(f"{where}: size is a font size in points, 1 to 409")
    if "font_color" in spec:
        colour = parse_color(spec["font_color"])
        if colour:
            font.color = colour
            font_changed = True
        else:
            problems.append(f"{where}: font_color is a hex colour like \"1F4E79\"")
    if font_changed:
        cell.font = font
    if "fill" in spec:
        colour = parse_color(spec["fill"])
        if colour:
            cell.fill = PatternFill(fill_type="solid", start_color=colour, end_color=colour)
        elif spec["fill"] is None:
            cell.fill = PatternFill(fill_type=None)
        else:
            problems.append(f"{where}: fill is a hex colour like \"DDEBF7\" (or null for none)")
    if "align" in spec or "wrap" in spec:
        align = copy(cell.alignment)
        if "align" in spec:
            if spec["align"] in ("left", "center", "right"):
                align.horizontal = spec["align"]
            else:
                problems.append(f"{where}: align is left, center or right")
        if "wrap" in spec:
            if isinstance(spec["wrap"], bool):
                align.wrap_text = spec["wrap"]
            else:
                problems.append(f"{where}: wrap is true or false")
        cell.alignment = align
    if "border" in spec:
        if spec["border"] in ("thin", "medium", "thick"):
            side = Side(style=spec["border"])
            cell.border = Border(left=side, right=side, top=side, bottom=side)
        elif spec["border"] in ("none", None):
            cell.border = Border()
        else:
            problems.append(f"{where}: border is thin, medium, thick or none")


VALUE_KEYS = ("value", "formula", "text", "date", "datetime")
CELL_KEYS = VALUE_KEYS + STYLE_KEYS + ("note", "link")
ILLEGAL = re.compile(r"[\000-\010\013\014\016-\037]")  # control characters an .xlsx can't hold


def put_value(cell: Any, spec: Any, where: str, problems: list[str]) -> None:
    """Write one cell from a spec: a number, true/false, null (empty), text ("=..." is a formula), or an object with
    one of value, formula, text (stays text even if it starts with =), date, datetime, plus style keys, note, link."""
    from openpyxl.comments import Comment
    from openpyxl.worksheet.hyperlink import Hyperlink

    style: dict[str, Any] = {}
    if isinstance(spec, dict):
        unknown = sorted(set(spec) - set(CELL_KEYS))
        if unknown:
            problems.append(f"{where}: unknown key {', '.join(unknown)} (a cell takes {', '.join(CELL_KEYS)})")
        given = [k for k in VALUE_KEYS if k in spec]
        if len(given) > 1:
            problems.append(f"{where}: give one of {', '.join(given)}, not several")
            return
        kind = given[0] if given else None
        raw = spec.get(kind) if kind else None
        style = {k: spec[k] for k in STYLE_KEYS if k in spec}
    else:
        kind, raw = "value", spec
    text_only = False
    value: Any = raw
    if kind is None and isinstance(spec, dict):
        pass  # only a look, a note or a link: the value stays as it is
    elif kind == "value":
        if isinstance(raw, (dict, list)):
            problems.append(f"{where}: a value is a number, text, true/false or null")
            return
        if isinstance(raw, float) and not math.isfinite(raw):
            problems.append(f"{where}: {raw} isn't a number Excel can store")
            return
    elif kind == "formula":
        if not isinstance(raw, str) or not raw.strip():
            problems.append(f"{where}: formula is text like \"=SUM(B2:B9)\"")
            return
        value = raw if raw.startswith("=") else "=" + raw
    elif kind == "text":
        if not isinstance(raw, str):
            problems.append(f"{where}: text is a string")
            return
        text_only = True
    elif kind in ("date", "datetime"):
        try:
            parsed = dt.datetime.fromisoformat(str(raw).replace("Z", ""))
        except ValueError:
            problems.append(f"{where}: {kind} is written like 2026-01-31" + (" 14:30" if kind == "datetime" else ""))
            return
        value = parsed.date() if kind == "date" else parsed
        style.setdefault("number_format", "yyyy-mm-dd" if kind == "date" else "yyyy-mm-dd hh:mm")
    if isinstance(value, str):
        if len(value) > MAX_TEXT:
            problems.append(f"{where}: {len(value)} characters; an Excel cell holds at most {MAX_TEXT}")
            return
        if ILLEGAL.search(value):
            problems.append(f"{where}: has control characters an Excel file can't hold")
            return
    if kind is not None:
        cell.value = value
    if text_only and isinstance(value, str):
        cell.data_type = "s"  # openpyxl would otherwise read a leading = as a formula
    if isinstance(spec, dict) and spec.get("link"):
        link = spec["link"]
        if not isinstance(link, str):
            problems.append(f"{where}: link is a web address, or #Sheet!A1 for a place in the workbook")
        else:
            cell.hyperlink = Hyperlink(ref=cell.coordinate, location=link[1:]) if link.startswith("#") else link
            cell.style = "Hyperlink"
    if isinstance(spec, dict) and spec.get("note"):
        note = spec["note"]
        text, author = (note.get("text"), note.get("author") or "Athena") if isinstance(note, dict) else (note, "Athena")
        if isinstance(text, str) and text:
            cell.comment = Comment(text, str(author))
        else:
            problems.append(f"{where}: note is text, or {{\"text\": ..., \"author\": ...}}")
    if style:
        apply_style(cell, style, where, problems)


def sheet_of_ref(operand: str) -> tuple[str | None, bool]:
    """The sheet a reference names ('My Sheet'!A1 -> My Sheet), and whether it's in another workbook ([1]Sheet!A1)."""
    m = re.match(r"^(\[[^\]]*\])?('(?:[^']|'')+'|[^'!]+)!", operand)
    if not m:
        return None, False
    raw = m.group(2)
    name = raw[1:-1].replace("''", "'") if raw.startswith("'") else raw
    return name, bool(m.group(1)) or "[" in name


def formula_problems(wb: Any, cells: list[tuple[str, str, str]]) -> list[dict[str, str]]:
    """For (sheet, cell, formula) triples: functions Excel 2007 doesn't know written without the _xlfn. prefix newer
    ones need (Excel and LibreOffice show #NAME?), references to sheets that aren't in the workbook, and formulas
    that can't be read."""
    from openpyxl.formula.tokenizer import Tokenizer, TokenizerError
    from openpyxl.utils import FORMULAE

    sheets = {s.casefold() for s in wb.sheetnames}
    found = []
    for sheet, coord, text in cells:
        try:
            tokens = Tokenizer(text).items
        except TokenizerError as e:
            found.append({"sheet": sheet, "cell": coord, "formula": text, "problem": f"can't be read: {e}"})
            continue
        for t in tokens:
            if t.type == "FUNC" and t.subtype == "OPEN":
                name = t.value[:-1].lstrip("@").upper()
                if name.startswith(("_XLFN.", "_XLWS.", "_XLL.")) or not name or name in FORMULAE:
                    continue
                found.append({"sheet": sheet, "cell": coord, "formula": text,
                              "problem": f"{name} isn't a function Excel 2007 knows: if it's a newer one, write it "
                                         f"_xlfn.{name}; if it's misspelt, fix it (otherwise Excel shows #NAME?)"})
            elif t.type == "OPERAND" and t.subtype == "RANGE":
                ref_sheet, external = sheet_of_ref(t.value)
                if ref_sheet and not external and ":" not in ref_sheet and ref_sheet.casefold() not in sheets:
                    found.append({"sheet": sheet, "cell": coord, "formula": text,
                                  "problem": f"refers to a sheet named {ref_sheet!r}, which isn't in the workbook"})
    return found


# What openpyxl leaves out when it saves a workbook it read, by the content type of the part that held it.
FRIENDLY = {
    "application/vnd.ms-excel.slicer+xml": "slicers",
    "application/vnd.ms-excel.slicercache+xml": "slicers",
    "application/vnd.ms-excel.timeline+xml": "timelines",
    "application/vnd.ms-excel.timelinecache+xml": "timelines",
    "application/vnd.ms-excel.threadedcomments+xml": "threaded comments (replies)",
    "application/vnd.ms-excel.person+xml": "the people in threaded comments",
    "application/vnd.ms-office.chartstyle+xml": "chart styles",
    "application/vnd.ms-office.chartcolorstyle+xml": "chart colour styles",
    "application/vnd.ms-excel.controlproperties+xml": "form controls (buttons, check boxes, drop-downs)",
    "application/vnd.ms-office.activex+xml": "ActiveX controls",
    "application/vnd.openxmlformats-officedocument.oleobject": "embedded objects",
    "application/vnd.ms-office.vbaproject": "macros",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheetmetadata+xml": "cell metadata (where Excel marks formulas that spill)",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.printersettings": "printer settings",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.querytable+xml": "query tables",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.connections+xml": "data connections",
    "application/vnd.openxmlformats-officedocument.drawingml.diagramdata+xml": "SmartArt",
    "application/vnd.openxmlformats-officedocument.customxmlproperties+xml": "custom XML parts",
}
REBUILT = {"application/vnd.openxmlformats-officedocument.spreadsheetml.calcchain+xml"}  # Excel rebuilds it
SHAPES = ("sp", "grpSp", "cxnSp")


def part_counts(book: Any) -> tuple[Counter, int]:
    """How many parts of each content type a workbook (a path or a file object) holds, and how many drawn shapes."""
    counts: Counter = Counter()
    shapes = 0
    with zipfile.ZipFile(book) as z:
        types = ElementTree.fromstring(z.read("[Content_Types].xml"))
        defaults, overrides = {}, {}
        for e in types:
            tag = e.tag.rsplit("}", 1)[-1]
            if tag == "Default":
                defaults[(e.get("Extension") or "").lower()] = (e.get("ContentType") or "").lower()
            elif tag == "Override":
                overrides[(e.get("PartName") or "").lstrip("/").lower()] = (e.get("ContentType") or "").lower()
        for name in z.namelist():
            if name.endswith("/") or name.endswith(".rels") or name == "[Content_Types].xml":
                continue
            kind = overrides.get(name.lower()) or defaults.get(name.rsplit(".", 1)[-1].lower()) or "unknown"
            counts[kind] += 1
            if name.startswith("xl/drawings/") and name.endswith(".xml"):
                try:
                    root = ElementTree.fromstring(z.read(name))
                except ElementTree.ParseError:
                    continue
                shapes += sum(1 for anchor in root for child in anchor if child.tag.rsplit("}", 1)[-1] in SHAPES)
    return counts, shapes


def lost_parts(before: Any, after: Any) -> list[str]:
    """What the workbook `before` held that `after` doesn't, in plain words, plus what openpyxl warned it removed."""
    old, old_shapes = part_counts(before)
    new, new_shapes = part_counts(after)
    lost: list[str] = []
    for kind, n in old.items():
        gone = n - new.get(kind, 0)
        if gone <= 0 or kind in REBUILT:
            continue
        name = FRIENDLY.get(kind) or (f"pictures ({kind})" if kind.startswith("image/") else kind)
        if name not in lost:
            lost.append(name)
    if old_shapes > new_shapes:
        lost.append(f"drawn shapes and text boxes ({old_shapes - new_shapes})")
    for message in NOTES.get("library_warnings", []):
        if re.search(r"removed|lost|dropp|discard", message, re.I) and message not in lost:
            lost.append(message)
    return lost


def save_book(wb: Any, out: str, src: str | None = None) -> list[str]:
    """Save an openpyxl workbook to out; with src, return what the save left out that src held."""
    ext = os.path.splitext(out)[1].lower()
    macros = getattr(wb, "vba_archive", None) is not None
    if ext not in BOOK_TYPES:
        raise Fail(f"-o should end in .xlsx (or .xlsm for a workbook with macros), not {ext or 'nothing'}: {out}")
    if macros and ext not in MACRO_TYPES:
        raise Fail("the workbook has macros: give -o a name ending in .xlsm (Excel refuses an .xlsx that holds them)")
    if not macros and ext in MACRO_TYPES:
        raise Fail("the workbook has no macros: give -o a name ending in .xlsx")
    wb.template = ext in (".xltx", ".xltm")
    wb.calculation.fullCalcOnLoad = True  # saved results are gone; this has Excel work them out on opening
    write_atomic(out, wb.save)
    return lost_parts(src, out) if src else []


# ---------------------------------------------------------------- building the workbook

RANGE_RE = re.compile(r"\$?[A-Za-z]{1,3}\$?\d+(:\$?[A-Za-z]{1,3}\$?\d+)?")
CELL_ONLY = re.compile(r"\$?[A-Za-z]{1,3}\$?\d+")
TABLE_NAME = re.compile(r"(?:[^\W\d]|\\)[\w.\\]*")
CELLISH = re.compile(r"[A-Za-z]{1,3}\d+|[RrCc]|[Rr]\d*[Cc]\d*|[Rr]\d+|[Cc]\d+")
OPERATORS = {">": "greaterThan", ">=": "greaterThanOrEqual", "<": "lessThan", "<=": "lessThanOrEqual",
             "=": "equal", "!=": "notEqual", "between": "between"}
CHARTS = ("column", "bar", "line", "area", "pie", "scatter")
SHEET_KEYS = ("name", "rows", "start", "header", "cells", "formats", "widths", "freeze", "filter", "merge", "tables",
              "validations", "conditional", "charts", "print", "protect", "tab_color", "hidden")


def bounds(text: Any, where: str, problems: list[str]) -> tuple[int, int, int, int] | None:
    """(min_col, min_row, max_col, max_row) of a range like A1:D9 (or one cell); None after noting a problem."""
    from openpyxl.utils import range_boundaries

    if not isinstance(text, str) or not RANGE_RE.fullmatch(text.strip()):
        problems.append(f"{where}: {text!r} isn't a range like A1:D9")
        return None
    c1, r1, c2, r2 = range_boundaries(text.replace("$", "").upper())
    if c2 > MAX_COL or r2 > MAX_ROW:
        problems.append(f"{where}: {text} goes past the sheet's last row or column")
        return None
    return c1, r1, c2, r2


def overlaps(a: tuple[int, int, int, int], b: tuple[int, int, int, int]) -> bool:
    return not (a[2] < b[0] or b[2] < a[0] or a[3] < b[1] or b[3] < a[1])


def quoted(title: str) -> str:
    return "'" + title.replace("'", "''") + "'"


def qualify(ref: str, ws: Any) -> str:
    return ref if "!" in ref else f"{quoted(ws.title)}!{ref}"


def read_password(spec: dict[str, Any], base: str, where: str, problems: list[str]) -> str | None:
    if spec.get("password_file"):
        path = os.path.join(base, str(spec["password_file"]))
        try:
            with open(path, "rb") as fh:
                lines = decode(fh.read(), path).splitlines()
        except OSError as e:
            problems.append(f"{where}: can't read the password file {path}: {e.strerror}")
            return None
        return lines[0] if lines else ""
    if spec.get("password_env"):
        value = os.environ.get(str(spec["password_env"]))
        if value is None:
            problems.append(f"{where}: the environment variable {spec['password_env']} isn't set")
        return value
    if "password" in spec:
        problems.append(f"{where}: put the password in a file (password_file) or a variable (password_env), not in the spec")
    return None


def add_chart(ws: Any, spec: Any, where: str, problems: list[str]) -> None:
    from openpyxl.chart import AreaChart, BarChart, LineChart, PieChart, Reference, ScatterChart, Series
    from openpyxl.chart.marker import Marker

    if not isinstance(spec, dict):
        problems.append(f"{where}: a chart is an object with type, data and at")
        return
    kind = spec.get("type", "column")
    if kind not in CHARTS:
        problems.append(f"{where}: type {kind!r} isn't one of {', '.join(CHARTS)}")
        return
    data = spec.get("data")
    sheet_part, _, cells = str(data).rpartition("!")
    box = bounds(cells, f"{where} data", problems)
    at = spec.get("at", "")
    if not isinstance(at, str) or not CELL_ONLY.fullmatch(at):
        problems.append(f"{where}: \"at\" is the cell for the chart's top-left corner, like G2")
        return
    for key in ("width", "height"):
        if key in spec and (not isinstance(spec[key], (int, float)) or isinstance(spec[key], bool) or not 1 <= spec[key] <= 100):
            problems.append(f"{where}: {key} is in centimetres, 1 to 100")
            return
    if box is None:
        return
    sheet = sheet_part or quoted(ws.title)
    if kind == "scatter":
        xs = spec.get("x")
        xbox = bounds(str(xs).rpartition("!")[2], f"{where} x", problems)
        if xbox is None:
            return
        chart: Any = ScatterChart()
        xref = Reference(range_string=qualify(str(xs), ws))
        from openpyxl.utils import get_column_letter

        for col in range(box[0], box[2] + 1):
            letter = get_column_letter(col)
            values = Reference(range_string=f"{sheet}!${letter}${box[1]}:${letter}${box[3]}")
            series = Series(values, xref, title_from_data=True)
            series.marker = Marker(symbol="circle", size=7)
            series.marker.graphicalProperties = None  # an outline-only marker draws as nothing in LibreOffice
            series.graphicalProperties.line.noFill = True  # points, not a line
            chart.series.append(series)
        chart.style = 13
    else:
        chart = {"column": BarChart, "bar": BarChart, "line": LineChart, "area": AreaChart, "pie": PieChart}[kind]()
        if kind in ("column", "bar"):
            chart.type = "col" if kind == "column" else "bar"
        if spec.get("stacked") and kind in ("column", "bar", "area"):
            chart.grouping = "stacked"
            if kind != "area":
                chart.overlap = 100
        chart.add_data(Reference(range_string=f"{sheet}!{cells}"), titles_from_data=True)
        if spec.get("categories"):
            cat = str(spec["categories"])
            if bounds(cat.rpartition("!")[2], f"{where} categories", problems) is None:
                return
            chart.set_categories(Reference(range_string=qualify(cat, ws)))
    if spec.get("title"):
        chart.title = str(spec["title"])
    if kind != "pie":
        if spec.get("x_title"):
            chart.x_axis.title = str(spec["x_title"])
        if spec.get("y_title"):
            chart.y_axis.title = str(spec["y_title"])
        # written out, not left to the default: some Excel versions hide an axis whose flag is missing
        chart.x_axis.delete = False
        chart.y_axis.delete = False
    chart.width = spec.get("width", 15)
    chart.height = spec.get("height", 7.5)
    ws.add_chart(chart, at.replace("$", "").upper())


def add_validation(ws: Any, spec: Any, where: str, problems: list[str]) -> None:
    from openpyxl.worksheet.datavalidation import DataValidation

    if not isinstance(spec, dict) or bounds(spec.get("range"), where, problems) is None:
        return
    kinds = [k for k in ("list", "source", "whole", "decimal", "date") if k in spec]
    if len(kinds) != 1:
        problems.append(f"{where}: give one of list, source, whole, decimal or date")
        return
    kind = kinds[0]
    rule = spec[kind]
    if kind == "list":
        if not isinstance(rule, list) or not rule or any("," in str(x) or '"' in str(x) for x in rule):
            problems.append(f"{where}: list is a list of choices without commas or quotes in them")
            return
        text = ",".join(str(x) for x in rule)
        if len(text) > 255:  # what Excel accepts typed into a list's source
            problems.append(f"{where}: the choices come to {len(text)} characters, over Excel's 255: put them on a "
                            "sheet and use \"source\"")
            return
        dv = DataValidation(type="list", formula1=f'"{text}"')
    elif kind == "source":
        if not isinstance(rule, str) or not rule.strip():
            problems.append(f"{where}: source is a range like Lists!$A$1:$A$9")
            return
        dv = DataValidation(type="list", formula1=rule.lstrip("="))
    else:
        if not isinstance(rule, list) or len(rule) != 2:
            problems.append(f"{where}: {kind} is [lowest, highest]")
            return
        if kind == "date":
            try:
                lo, hi = (dt.date.fromisoformat(str(x)) for x in rule)
            except ValueError:
                problems.append(f"{where}: date is [\"2026-01-01\", \"2026-12-31\"]")
                return
            f1, f2 = (f"DATE({d.year},{d.month},{d.day})" for d in (lo, hi))
        else:
            if not all(isinstance(x, (int, float)) and not isinstance(x, bool) for x in rule):
                problems.append(f"{where}: {kind} is two numbers, [lowest, highest]")
                return
            f1, f2 = str(rule[0]), str(rule[1])
        dv = DataValidation(type=kind, operator="between", formula1=f1, formula2=f2)
    dv.allow_blank = bool(spec.get("allow_blank", True))
    dv.showErrorMessage = True  # without it Excel lets anything in
    if spec.get("error"):
        dv.error, dv.errorTitle = str(spec["error"]), "Not allowed"
    if spec.get("prompt"):
        dv.prompt, dv.showInputMessage = str(spec["prompt"]), True
    ws.add_data_validation(dv)
    dv.add(spec["range"].replace("$", "").upper())


def add_conditional(ws: Any, spec: Any, where: str, problems: list[str]) -> None:
    from openpyxl.formatting.rule import CellIsRule, ColorScaleRule, FormulaRule
    from openpyxl.styles import Font, PatternFill

    if not isinstance(spec, dict) or bounds(spec.get("range"), where, problems) is None:
        return
    fill = font = None
    if spec.get("fill") is not None:
        colour = parse_color(spec["fill"])
        if not colour:
            problems.append(f"{where}: fill is a hex colour like \"C6EFCE\"")
            return
        fill = PatternFill(fill_type="solid", start_color=colour, end_color=colour)
    if spec.get("font_color") is not None or spec.get("bold"):
        colour = parse_color(spec.get("font_color")) if spec.get("font_color") is not None else None
        if spec.get("font_color") is not None and not colour:
            problems.append(f"{where}: font_color is a hex colour like \"9C0006\"")
            return
        font = Font(color=colour, bold=bool(spec.get("bold")) or None)
    if "scale" in spec:
        colours = [parse_color(c) for c in spec["scale"]] if isinstance(spec["scale"], list) else []
        if len(colours) not in (2, 3) or not all(colours):
            problems.append(f"{where}: scale is two or three hex colours, lowest first")
            return
        if len(colours) == 2:
            rule = ColorScaleRule(start_type="min", start_color=colours[0], end_type="max", end_color=colours[1])
        else:
            rule = ColorScaleRule(start_type="min", start_color=colours[0], mid_type="percentile", mid_value=50,
                                  mid_color=colours[1], end_type="max", end_color=colours[2])
    elif "formula" in spec:
        if not isinstance(spec["formula"], str) or not spec["formula"].strip():
            problems.append(f"{where}: formula is a test like \"$D2>1000\", written for the range's first row")
            return
        rule = FormulaRule(formula=[spec["formula"].lstrip("=")], fill=fill, font=font)
    elif "when" in spec:
        op = OPERATORS.get(str(spec["when"]))
        value = spec.get("value")
        values = value if isinstance(value, list) else [value]
        if op is None:
            problems.append(f"{where}: when is one of {', '.join(OPERATORS)}")
            return
        if (op == "between") != (len(values) == 2) or any(v is None or isinstance(v, (dict, list)) for v in values):
            problems.append(f"{where}: value is a number or text ([low, high] for between)")
            return
        texts = [str(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else '"' + str(v).replace('"', '""') + '"'
                 for v in values]
        rule = CellIsRule(operator=op, formula=texts, fill=fill, font=font)
    else:
        problems.append(f"{where}: give when (with value), scale or formula")
        return
    if "scale" not in spec and fill is None and font is None:
        problems.append(f"{where}: say how to mark the cells: fill, font_color or bold")
        return
    ws.conditional_formatting.add(spec["range"].replace("$", "").upper(), rule)


def build(spec: dict[str, Any], base: str) -> tuple[Any, list[dict[str, Any]], list[tuple[str, str, str]]]:
    from openpyxl import Workbook
    from openpyxl.styles import Border, Font, Protection, Side
    from openpyxl.utils import column_index_from_string, coordinate_to_tuple, get_column_letter
    from openpyxl.workbook.defined_name import DefinedName
    from openpyxl.worksheet.properties import PageSetupProperties
    from openpyxl.worksheet.table import Table, TableStyleInfo

    problems: list[str] = []
    sheets = spec.get("sheets")
    if not isinstance(sheets, list) or not sheets:
        raise Fail('the spec needs a "sheets" list with at least one sheet')
    wb = Workbook()
    wb.remove(wb.active)
    seen: set[str] = set()
    table_names: set[str] = set()
    summary: list[dict[str, Any]] = []
    formulas: list[tuple[str, str, str]] = []
    pending: list[tuple[Any, dict[str, Any], str]] = []
    for i, sheet in enumerate(sheets):
        where = f"sheet {i + 1}"
        if not isinstance(sheet, dict):
            problems.append(f"{where}: a sheet is an object with a name")
            continue
        unknown = sorted(set(sheet) - set(SHEET_KEYS))
        if unknown:
            problems.append(f"{where}: unknown key {', '.join(unknown)} (a sheet takes {', '.join(SHEET_KEYS)})")
        name = sheet.get("name", f"Sheet{i + 1}")
        why = sheet_name_problem(name)
        if why or str(name).casefold() in seen:
            problems.append(f"{where}: {why or f'two sheets are named {name!r}'}")
            continue
        seen.add(str(name).casefold())
        ws = wb.create_sheet(str(name))
        where = f"sheet {name!r}"
        pending.append((ws, sheet, where))

    for ws, sheet, where in pending:
        rows = sheet.get("rows", [])
        start = sheet.get("start", "A1")
        if not isinstance(start, str) or not CELL_ONLY.fullmatch(start):
            problems.append(f"{where}: start is a cell like A1")
            start = "A1"
        r0, c0 = coordinate_to_tuple(start.replace("$", "").upper())
        if not isinstance(rows, list) or not all(isinstance(r, list) for r in rows):
            problems.append(f"{where}: rows is a list of rows, each a list of cells")
            rows = []
        if r0 + len(rows) - 1 > MAX_ROW or c0 + max((len(r) for r in rows), default=0) - 1 > MAX_COL:
            problems.append(f"{where}: the rows go past the sheet's last row or column")
            rows = []
        for ri, row in enumerate(rows):
            for ci, value in enumerate(row):
                cell = ws.cell(row=r0 + ri, column=c0 + ci)
                put_value(cell, value, f"{where} {cell.coordinate}", problems)
                if cell.data_type == "f":
                    formulas.append((ws.title, cell.coordinate, str(cell.value)))
        cells = sheet.get("cells", {})
        if not isinstance(cells, dict):
            problems.append(f"{where}: cells maps addresses to cells, like {{\"F1\": \"Total\"}}")
            cells = {}
        for coord, value in cells.items():
            if not CELL_ONLY.fullmatch(str(coord)):
                problems.append(f"{where}: {coord!r} isn't a cell address like F1")
                continue
            cell = ws[str(coord).replace("$", "").upper()]
            put_value(cell, value, f"{where} {coord}", problems)
            if cell.data_type == "f":
                formulas.append((ws.title, cell.coordinate, str(cell.value)))
        formats = sheet.get("formats", {})
        for rng, style in (formats.items() if isinstance(formats, dict) else []):
            box = bounds(rng, f"{where} formats", problems)
            if box is None or not isinstance(style, dict) or set(style) - set(STYLE_KEYS):
                if box is not None:
                    problems.append(f"{where} formats {rng}: a format takes {', '.join(STYLE_KEYS)}")
                continue
            for r in range(box[1], box[3] + 1):
                for c in range(box[0], box[2] + 1):
                    apply_style(ws.cell(row=r, column=c), style, f"{where} formats {rng}", problems)
        if not isinstance(formats, dict):
            problems.append(f"{where}: formats maps ranges to styles")

        merges = sheet.get("merge", [])
        merged_boxes = []
        for rng in merges if isinstance(merges, list) else []:
            box = bounds(rng, f"{where} merge", problems)
            if box and box[:2] != box[2:]:
                merged_boxes.append(box)
                ws.merge_cells(rng.replace("$", "").upper())
        table_boxes = []
        for k, t in enumerate(sheet.get("tables", []) or []):
            tw = f"{where} table {k + 1}"
            if not isinstance(t, dict):
                problems.append(f"{tw}: a table is an object with name and range")
                continue
            box = bounds(t.get("range"), tw, problems)
            name = t.get("name")
            if not isinstance(name, str) or not TABLE_NAME.fullmatch(name) or CELLISH.fullmatch(name) or len(name) > 255:
                problems.append(f"{tw}: {name!r} can't be a table name: start with a letter or _, no spaces, and not "
                                "like a cell address")
                continue
            if name.casefold() in table_names:
                problems.append(f"{tw}: two tables are named {name!r}")
                continue
            if box is None:
                continue
            if box[1] == box[3]:
                problems.append(f"{tw}: a table needs its header row and at least one row under it")
                continue
            if any(overlaps(box, b) for b in table_boxes + merged_boxes):
                problems.append(f"{tw}: overlaps another table or merged cells")
                continue
            headers = [ws.cell(row=box[1], column=c).value for c in range(box[0], box[2] + 1)]
            if not all(isinstance(h, str) and h.strip() for h in headers) or len({h.casefold() for h in headers}) != len(headers):
                problems.append(f"{tw}: the first row of {t['range']} must be headings: text, none empty, none repeated")
                continue
            table = Table(displayName=name, ref=t["range"].replace("$", "").upper())
            table.tableStyleInfo = TableStyleInfo(name=str(t.get("style", "TableStyleMedium2")), showRowStripes=bool(t.get("striped", True)))
            ws.add_table(table)
            table_names.add(name.casefold())
            table_boxes.append(box)

        header_box = None
        if sheet.get("header") and rows:
            header_box = (c0, r0, c0 + max(len(r) for r in rows) - 1, r0 + len(rows) - 1)
            if not any(overlaps(header_box, b) for b in table_boxes):  # a table styles its own header
                for c in range(header_box[0], header_box[2] + 1):
                    cell = ws.cell(row=r0, column=c)
                    cell.font = Font(bold=True)
                    cell.border = Border(bottom=Side(style="thin"))
        freeze = sheet.get("freeze")
        if freeze is None and header_box and len(rows) > 1:
            freeze = f"A{r0 + 1}"
        if freeze:
            if CELL_ONLY.fullmatch(str(freeze)):
                ws.freeze_panes = str(freeze).replace("$", "").upper()
            else:
                problems.append(f"{where}: freeze is the first cell that scrolls, like A2")
        flt = sheet.get("filter")
        if flt is None and header_box and len(rows) > 1 and not any(overlaps(header_box, b) for b in table_boxes):
            flt = f"{get_column_letter(header_box[0])}{header_box[1]}:{get_column_letter(header_box[2])}{header_box[3]}"
        if flt:
            box = bounds(flt, f"{where} filter", problems)
            if box and any(overlaps(box, b) for b in table_boxes):
                problems.append(f"{where}: the filter overlaps a table, which has its own")
            elif box:
                ws.auto_filter.ref = str(flt).replace("$", "").upper()

        for k, v in enumerate(sheet.get("validations", []) or []):
            add_validation(ws, v, f"{where} validation {k + 1}", problems)
        for k, cf in enumerate(sheet.get("conditional", []) or []):
            add_conditional(ws, cf, f"{where} conditional {k + 1}", problems)
        for k, ch in enumerate(sheet.get("charts", []) or []):
            add_chart(ws, ch, f"{where} chart {k + 1}", problems)

        widths = sheet.get("widths", "auto")
        if widths == "auto":
            used: dict[int, int] = {}  # column -> the widest thing in it, roughly in characters
            for cell in ws._cells.values():
                v = cell.value
                if v is None or type(cell).__name__ == "MergedCell":
                    continue
                if cell.data_type == "f":
                    size = 12  # a result's width isn't known until something calculates it
                elif isinstance(v, dt.datetime):
                    size = 16
                elif isinstance(v, dt.date):
                    size = 10
                elif isinstance(v, (int, float)) and not isinstance(v, bool):
                    size = len(f"{v:,.2f}")
                else:
                    size = max((len(line) for line in str(v).splitlines()), default=0)
                used[cell.column] = max(used.get(cell.column, 0), size)
            for col, size in used.items():
                ws.column_dimensions[get_column_letter(col)].width = min(max(size + 2, 8), 60)
        elif isinstance(widths, dict):
            for col, w in widths.items():
                if not re.fullmatch(r"[A-Za-z]{1,3}", str(col)) or column_index_from_string(str(col).upper()) > MAX_COL:
                    problems.append(f"{where} widths: {col!r} isn't a column letter")
                elif not isinstance(w, (int, float)) or isinstance(w, bool) or not 0 < w <= 255:
                    problems.append(f"{where} widths: a column width is a number above 0, at most 255")
                else:
                    ws.column_dimensions[str(col).upper()].width = w
        else:
            problems.append(f"{where}: widths is \"auto\" or a map like {{\"A\": 18}}")

        setup = sheet.get("print")
        if isinstance(setup, dict):
            if setup.get("landscape"):
                ws.page_setup.orientation = "landscape"
            if setup.get("paper"):
                sizes = {"a4": ws.PAPERSIZE_A4, "a3": ws.PAPERSIZE_A3, "letter": ws.PAPERSIZE_LETTER, "legal": ws.PAPERSIZE_LEGAL}
                if str(setup["paper"]).lower() in sizes:
                    ws.page_setup.paperSize = sizes[str(setup["paper"]).lower()]
                else:
                    problems.append(f"{where} print: paper is A4, A3, letter or legal")
            if setup.get("fit_width"):
                ws.sheet_properties.pageSetUpPr = PageSetupProperties(fitToPage=True)
                ws.page_setup.fitToWidth, ws.page_setup.fitToHeight = 1, 0
            if setup.get("title_rows"):
                if re.fullmatch(r"\$?\d+:\$?\d+", str(setup["title_rows"])):
                    ws.print_title_rows = str(setup["title_rows"]).replace("$", "")
                else:
                    problems.append(f"{where} print: title_rows is rows like 1:1")
            if setup.get("area"):
                if bounds(setup["area"], f"{where} print area", problems):
                    ws.print_area = str(setup["area"]).replace("$", "").upper()
        elif setup is not None:
            problems.append(f"{where}: print is an object")

        protect = sheet.get("protect")
        if protect:
            options = protect if isinstance(protect, dict) else {}
            password = read_password(options, base, f"{where} protect", problems)
            ws.protection.sheet = True
            if password:
                ws.protection.password = password
            for rng in options.get("unlocked", []) or []:
                box = bounds(rng, f"{where} protect unlocked", problems)
                if box:
                    for r in range(box[1], box[3] + 1):
                        for c in range(box[0], box[2] + 1):
                            ws.cell(row=r, column=c).protection = Protection(locked=False)
        if sheet.get("tab_color"):
            colour = parse_color(sheet["tab_color"])
            if colour:
                ws.sheet_properties.tabColor = colour
            else:
                problems.append(f"{where}: tab_color is a hex colour like \"1F4E79\"")
        if sheet.get("hidden"):
            ws.sheet_state = "hidden"
        summary.append({"name": ws.title, "range": ws.dimensions, "tables": len(ws.tables), "charts": len(ws._charts),
                        "validations": len(ws.data_validations.dataValidation),
                        "conditional_formats": len(ws.conditional_formatting), "merged": len(ws.merged_cells.ranges)})

    if pending and all(ws.sheet_state == "hidden" for ws, _, _ in pending):
        problems.append("every sheet is hidden: Excel needs at least one it can show")
    names = spec.get("names", {})
    for name, ref in (names.items() if isinstance(names, dict) else []):
        if not isinstance(name, str) or not TABLE_NAME.fullmatch(name) or CELLISH.fullmatch(name):
            problems.append(f"names: {name!r} can't be a name: start with a letter or _, no spaces, not like A1")
        elif not isinstance(ref, str) or not ref.strip():
            problems.append(f"names: {name} needs what it refers to, like Inputs!$B$3")
        else:
            wb.defined_names[name] = DefinedName(name, attr_text=ref.strip().lstrip("="))
            formulas.append(("(names)", name, "=" + ref.strip().lstrip("=")))
    props = spec.get("properties", {})
    for key in ("title", "subject", "creator", "keywords"):
        if isinstance(props, dict) and props.get(key):
            setattr(wb.properties, key, str(props[key]))
    if problems:
        shown = "; ".join(problems[:15]) + (f"; and {len(problems) - 15} more" if len(problems) > 15 else "")
        raise Fail(f"nothing written: the spec has {len(problems)} problem{'s' if len(problems) > 1 else ''}: {shown}")
    return wb, summary, formulas


def create(args: argparse.Namespace) -> int:
    spec = load_json(args.spec)
    if not isinstance(spec, dict):
        raise Fail('the spec is a JSON object with a "sheets" list')
    if os.path.splitext(args.out)[1].lower() != ".xlsx":
        raise Fail(f"-o should end in .xlsx: {args.out}")
    check_output(args.out, [args.spec])
    wb, summary, formulas = build(spec, os.path.dirname(os.path.abspath(args.spec)))
    issues = formula_problems(wb, formulas)
    save_book(wb, args.out)
    cell_formulas = sum(1 for sheet, _, _ in formulas if sheet != "(names)")
    result: dict[str, Any] = {"out": args.out, "sheets": summary, "formulas": cell_formulas}
    if cell_formulas:
        result["note"] = ("openpyxl doesn't calculate: the file has no results until a spreadsheet program opens it. "
                          "Check it with soffice.py recalc")
    if issues:
        result["formula_problems"] = issues
    emit(result)
    return 1 if issues else 0


def main(argv: list[str] | None = None) -> int:
    utf8_output()
    parser = Parser(prog="xlsx_create.py", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter,
                    epilog="example:\n  python xlsx_create.py xlsx-work/spec.json -o report.xlsx")
    parser.add_argument("spec", help="the JSON spec")
    parser.add_argument("-o", "--out", required=True, help="the .xlsx to write")
    args = parser.parse_args(argv)

    def job() -> int:
        need_openpyxl()
        return create(args)

    return run_job("xlsx_create.py", job)


if __name__ == "__main__":
    sys.exit(main())
