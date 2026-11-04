#!/usr/bin/env python3
"""Look inside Excel workbooks and change them without breaking them: info, read, diff, to-csv, from-csv, edit,
restructure.

Packages: openpyxl 3.1 or newer (every command); Pillow to keep the pictures in a workbook that is changed (openpyxl
drops them without it, so edit and restructure refuse such a workbook until it's installed).

Workbooks are .xlsx, .xlsm (macros kept), .xltx or .xltm. openpyxl never calculates: a formula's result is whatever
a spreadsheet program saved with the file, and a file saved by openpyxl has none until something recalculates it
(soffice.py recalc does). Commands that write need -o, a path that is never the input: to change the user's own file,
copy it to a backup first and write from the backup to the original name.

Results are printed on stdout as JSON. Exit codes: 0 done; 1 the command ran and found problems, listed in the JSON
(formulas a restructure couldn't move, things the save dropped, a function Excel won't know, CSV rows of the wrong
length, formulas with no saved result); 2 it couldn't do the job, and one line on stderr says why.
"""

from __future__ import annotations

import argparse
import codecs
import csv
import datetime as dt
import importlib
import importlib.util
import io
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


# ---------------------------------------------------------------- opening workbooks

# Workbooks loaded with their macros: openpyxl keeps those in an in-memory zip that must be closed before Python
# exits, or closing it during shutdown prints a traceback.
MACRO_BOOKS: list[Any] = []


def open_book(path: str, *, edit: bool = False, data_only: bool = False, read_only: bool = False) -> Any:
    """Load a workbook. For editing: rich text kept, macros kept for .xlsm, and Pillow required when it has pictures."""
    openpyxl = need_openpyxl()
    if not os.path.isfile(path):
        raise Fail(f"no such file: {path}")
    ext = os.path.splitext(path)[1].lower()
    with open(path, "rb") as fh:
        head = fh.read(8)
    if ext in (".csv", ".tsv", ".txt"):
        raise Fail(f"{path} is a text file, not a workbook: from-csv makes a workbook of it")
    if head.startswith(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"):
        raise Fail(f"{path} is either password-protected or an old .xls file, and openpyxl opens neither: convert an "
                   ".xls with soffice.py convert <file> --to xlsx; for a password, ask the user for an unprotected copy")
    if not head.startswith(b"PK"):
        raise Fail(f"{path} isn't an Excel workbook (.xlsx, .xlsm, .xltx or .xltm)")
    if ext in (".ods", ".xlsb"):
        raise Fail(f"openpyxl doesn't read {ext} files: convert {path} to .xlsx first (soffice.py convert <file> --to xlsx)")
    if ext not in BOOK_TYPES:
        raise Fail(f"{path} should end in .xlsx, .xlsm, .xltx or .xltm")
    if edit and importlib.util.find_spec("PIL") is None:
        with zipfile.ZipFile(path) as z:
            if any(n.startswith("xl/media/") for n in z.namelist()):
                raise Fail(f"{path} has pictures, which openpyxl drops when Pillow isn't installed: "
                           "python -m pip install pillow")
    try:
        wb = openpyxl.load_workbook(path, read_only=read_only, keep_vba=edit and ext in MACRO_TYPES,
                                    data_only=data_only, keep_links=True, rich_text=edit)
        if getattr(wb, "vba_archive", None) is not None:
            MACRO_BOOKS.append(wb)
        return wb
    except OSError:
        raise
    except Exception as e:  # openpyxl raises several kinds for damaged files
        raise Fail(f"{path} is damaged, or not a workbook openpyxl can read ({type(e).__name__}: {e})") from None


def pick_sheet(wb: Any, name: str | None) -> Any:
    """The sheet called name (any case), or the only sheet when there's one and no name was given."""
    if name is None:
        if len(wb.sheetnames) == 1:
            return wb.worksheets[0]
        raise Fail(f"the workbook has {len(wb.sheetnames)} sheets: name one with --sheet ({', '.join(wb.sheetnames)})")
    for title in wb.sheetnames:
        if title.casefold() == name.casefold():
            return wb[title]
    raise Fail(f"no sheet named {name!r}: the sheets are {', '.join(wb.sheetnames)}")


def plain(value: Any) -> Any:
    """A cell value as JSON can carry it: dates as ISO text, formulas as their text."""
    if isinstance(value, dt.datetime):
        return value.date().isoformat() if value.time() == dt.time(0) else value.isoformat(sep=" ")
    if isinstance(value, (dt.date, dt.time)):
        return value.isoformat()
    if isinstance(value, dt.timedelta):
        return str(value)
    if isinstance(value, float) and not math.isfinite(value):
        return str(value)
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    text = getattr(value, "text", None)  # an array formula
    return text if isinstance(text, str) else str(value)


def is_formula(cell: Any) -> bool:
    return cell.data_type == "f" or type(cell.value).__name__ in ("ArrayFormula", "DataTableFormula")


def formula_text(cell: Any) -> str:
    v = cell.value
    if type(v).__name__ == "ArrayFormula":
        return v.text
    if type(v).__name__ == "DataTableFormula":
        return "=TABLE(...)"
    return str(v)


def cells_of(ws: Any, bounds: tuple[int, int, int, int] | None = None) -> dict[tuple[int, int], Any]:
    """(row, column) -> cell for the cells of a read-only sheet that hold something."""
    ws.reset_dimensions()  # some programs write a wrong used range; read every row instead of trusting it
    kwargs = {}
    if bounds:
        kwargs = {"min_col": bounds[0], "min_row": bounds[1], "max_col": bounds[2], "max_row": bounds[3]}
    found = {}
    for row in ws.iter_rows(**kwargs):
        for cell in row:
            if getattr(cell, "row", None) is not None and cell.value is not None:
                found[(cell.row, cell.column)] = cell
    return found


def parse_range(text: str) -> tuple[int, int, int, int]:
    from openpyxl.utils import range_boundaries

    try:
        b = range_boundaries(text.replace("$", "").upper())
    except (ValueError, TypeError):
        raise Fail(f"can't read the range {text!r}: write it like A1:F40") from None
    if None in b:
        raise Fail(f"give a range with both corners, like A1:F40, not {text!r}")
    return b  # type: ignore[return-value]


# ---------------------------------------------------------------- info


def cmd_info(args: argparse.Namespace) -> int:
    from openpyxl.utils import get_column_letter

    wb = open_book(args.book, edit=True)
    values = open_book(args.book, data_only=True)
    total = missing = 0
    sheets = []
    for ws in wb.worksheets:
        vs = values[ws.title]
        formulas = without = 0
        errors = []
        for (r, c), cell in ws._cells.items():
            if is_formula(cell):
                formulas += 1
                if vs.cell(r, c).value is None:
                    without += 1
            saved = vs._cells.get((r, c))
            if saved is not None and saved.data_type == "e" and len(errors) < 20:
                errors.append({"cell": cell.coordinate, "error": saved.value})
        total += formulas
        missing += without
        tables = [{"name": t.displayName, "range": t.ref, "columns": [c.name for c in t.tableColumns]}
                  for t in ws.tables.values()]
        hidden_rows = sum(1 for d in ws.row_dimensions.values() if d.hidden)
        hidden_cols = sum((d.max or d.min) - d.min + 1 for d in ws.column_dimensions.values() if d.hidden and d.min)
        sheets.append({
            "name": ws.title,
            "state": ws.sheet_state,
            "used_range": ws.dimensions,
            "rows": ws.max_row,
            "columns": ws.max_column,
            "last_column": get_column_letter(ws.max_column),
            "formulas": formulas,
            "formulas_without_saved_result": without,
            "saved_errors": errors,
            "merged": [str(r) for r in ws.merged_cells.ranges][:30],
            "tables": tables,
            "charts": len(ws._charts),
            "pictures": len(ws._images),
            "notes": sum(1 for c in ws._cells.values() if c.comment),
            "validations": len(ws.data_validations.dataValidation),
            "conditional_formats": len(ws.conditional_formatting),
            "pivot_tables": len(getattr(ws, "_pivots", [])),
            "freeze": ws.freeze_panes,
            "filter": ws.auto_filter.ref,
            "hidden_rows": hidden_rows,
            "hidden_columns": hidden_cols,
            "protected": bool(ws.protection.sheet),
        })
    names = [{"name": n, "refers_to": d.attr_text, "scope": "workbook"} for n, d in wb.defined_names.items()]
    for ws in wb.worksheets:
        names += [{"name": n, "refers_to": d.attr_text, "scope": ws.title} for n, d in ws.defined_names.items()]
    buf = io.BytesIO()
    wb.template = os.path.splitext(args.book)[1].lower() in (".xltx", ".xltm")
    wb.save(buf)
    if total == 0:
        results = "no formulas"
    elif missing == 0:
        results = "saved"
    elif missing == total:
        results = "missing"
    else:
        results = "partly saved"
    result: dict[str, Any] = {
        "file": args.book,
        "format": os.path.splitext(args.book)[1].lower().lstrip("."),
        "macros": getattr(wb, "vba_archive", None) is not None,
        "sheets": sheets,
        "names": names,
        "external_links": len(getattr(wb, "_external_links", [])),
        "workbook_protected": bool(wb.security and wb.security.lockStructure),
        "formulas": total,
        "results": results,
        "would_lose_on_save": lost_parts(args.book, buf),
    }
    if results in ("missing", "partly saved"):
        result["note"] = ("formulas without a saved result read as empty: the file was last saved by a program that "
                          "doesn't calculate. Recalculate a copy (soffice.py recalc) before reading values")
    emit(result)
    return 0


# ---------------------------------------------------------------- read


def cmd_read(args: argparse.Namespace) -> int:
    from openpyxl.utils import get_column_letter

    if args.max_rows < 1:
        raise Fail("--max-rows is a number of rows, from 1 up")
    bounds = parse_range(args.range) if args.range else None
    fwb = open_book(args.book, read_only=True)
    vwb = open_book(args.book, read_only=True, data_only=True)
    try:
        names = [pick_sheet(fwb, args.sheet).title] if args.sheet else fwb.sheetnames
        out = []
        for name in names:
            fcells = cells_of(fwb[name], bounds)
            vcells = cells_of(vwb[name], bounds)
            keys = set(fcells) | set(vcells)
            entry: dict[str, Any] = {"name": name}
            if not keys:
                entry.update({"range": None, "rows": []})
                out.append(entry)
                continue
            if bounds:
                c1, r1, c2, r2 = bounds
            else:
                r1, c1 = 1, 1
                r2, c2 = max(k[0] for k in keys), max(k[1] for k in keys)
            shown_to = min(r2, r1 + args.max_rows - 1)
            rows = []
            missing = 0
            for (r, c), cell in fcells.items():
                if is_formula(cell) and (r, c) not in vcells:
                    missing += 1
            for r in range(r1, shown_to + 1):
                row = []
                for c in range(c1, c2 + 1):
                    f = fcells.get((r, c))
                    v = vcells.get((r, c))
                    value = plain(v.value) if v is not None else None
                    if f is not None and is_formula(f) and args.show != "values":
                        value = formula_text(f) if args.show == "formulas" else {"formula": formula_text(f), "value": value}
                    row.append(value)
                if any(x is not None for x in row):
                    rows.append({"row": r, "values": row})
            entry.update({
                "range": f"{get_column_letter(c1)}{r1}:{get_column_letter(c2)}{r2}",
                "columns": [get_column_letter(c) for c in range(c1, c2 + 1)],
                "rows": rows,
                "truncated": shown_to < r2,
            })
            if shown_to < r2:
                entry["note"] = f"showing rows {r1} to {shown_to} of {r2}: use --range or --max-rows for more"
            if missing:
                entry["formulas_without_saved_result"] = missing
            out.append(entry)
    finally:
        fwb.close()
        vwb.close()
    result: dict[str, Any] = {"file": args.book, "show": args.show, "sheets": out}
    if any(s.get("formulas_without_saved_result") for s in out) and args.show != "formulas":
        result["note"] = ("some formulas have no saved result and read as null: recalculate a copy "
                          "(soffice.py recalc) and read that")
    emit(result)
    return 0


# ---------------------------------------------------------------- diff


def cmd_diff(args: argparse.Namespace) -> int:
    if args.limit < 0:
        raise Fail("--limit is 0 or more")
    books = [open_book(p, read_only=True, data_only=args.values) for p in (args.before, args.after)]
    try:
        a, b = books
        only_before = [s for s in a.sheetnames if s not in b.sheetnames]
        only_after = [s for s in b.sheetnames if s not in a.sheetnames]
        changes = []
        count = 0
        for name in [s for s in a.sheetnames if s in b.sheetnames]:
            ca, cb = cells_of(a[name]), cells_of(b[name])
            for key in sorted(set(ca) | set(cb)):
                va = ca.get(key)
                vb = cb.get(key)
                xa = (formula_text(va) if is_formula(va) else plain(va.value)) if va is not None else None
                xb = (formula_text(vb) if is_formula(vb) else plain(vb.value)) if vb is not None else None
                if xa != xb:
                    count += 1
                    if len(changes) < args.limit:
                        coord = (va or vb).coordinate
                        changes.append({"sheet": name, "cell": coord, "before": xa, "after": xb})
    finally:
        for wb in books:
            wb.close()
    same = count == 0 and not only_before and not only_after
    emit({"before": args.before, "after": args.after, "compared": "saved results" if args.values else "formulas and values",
          "same": same, "sheets_only_before": only_before, "sheets_only_after": only_after,
          "changed_cells": count, "changes": changes})
    return 0


# ---------------------------------------------------------------- to-csv

DELIMITERS = {",": ",", ";": ";", "tab": "\t", "\\t": "\t", "|": "|"}


def csv_number(value: float | int, decimal_comma: bool) -> str:
    if isinstance(value, float):
        text = str(int(value)) if value.is_integer() and abs(value) < 1e15 else format(value, ".15g")
    else:
        text = str(value)
    return text.replace(".", ",") if decimal_comma else text


def csv_value(value: Any, decimal_comma: bool) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, (int, float)):
        return csv_number(value, decimal_comma)
    if isinstance(value, dt.datetime):
        return value.date().isoformat() if value.time() == dt.time(0) else value.isoformat(sep=" ", timespec="seconds")
    if isinstance(value, (dt.date, dt.time)):
        return value.isoformat()
    if isinstance(value, dt.timedelta):
        seconds = int(value.total_seconds())
        return f"{seconds // 3600}:{seconds % 3600 // 60:02d}:{seconds % 60:02d}"
    return str(value)


def cmd_to_csv(args: argparse.Namespace) -> int:
    try:
        codecs.lookup(args.encoding)
    except LookupError:
        raise Fail(f"unknown encoding {args.encoding!r}: use utf-8, utf-8-sig (for Excel) or a code page like cp1252") from None
    if not args.out.lower().endswith((".csv", ".txt", ".tsv")):
        raise Fail(f"-o should end in .csv: {args.out}")
    check_output(args.out, [args.book])
    delimiter = DELIMITERS[args.delimiter]
    decimal_comma = args.decimal == "comma"
    if decimal_comma and delimiter == ",":
        NOTES.setdefault("warnings", []).append("decimal commas in a comma-separated file: every number gets quotes")
    fwb = open_book(args.book, read_only=True)
    vwb = open_book(args.book, read_only=True, data_only=True)
    try:
        ws_name = pick_sheet(fwb, args.sheet).title if args.sheet or len(fwb.sheetnames) == 1 else fwb.active.title
        fcells = cells_of(fwb[ws_name])
        vcells = cells_of(vwb[ws_name])
        others = [s for s in fwb.sheetnames if s != ws_name]
    finally:
        fwb.close()
        vwb.close()
    keys = set(fcells) | set(vcells)
    rows_n = max((k[0] for k in keys), default=0)
    cols_n = max((k[1] for k in keys), default=0)
    missing = [fcells[k].coordinate for k in fcells if is_formula(fcells[k]) and k not in vcells]
    buf = io.StringIO()
    writer = csv.writer(buf, delimiter=delimiter, lineterminator="\r\n")
    grid = []
    for r in range(1, rows_n + 1):
        row = [csv_value(vcells[(r, c)].value if (r, c) in vcells else None, decimal_comma) for c in range(1, cols_n + 1)]
        grid.append(row)
        writer.writerow(row)
    text = buf.getvalue()
    try:
        data = text.encode(args.encoding)
    except UnicodeEncodeError:
        for r, row in enumerate(grid, 1):
            for c, value in enumerate(row, 1):
                try:
                    value.encode(args.encoding)
                except UnicodeEncodeError as e:
                    from openpyxl.utils import get_column_letter

                    bad = value[e.start:e.end]
                    raise Fail(f"{get_column_letter(c)}{r} has {bad!r}, which {args.encoding} can't hold: use "
                               "--encoding utf-8-sig (Excel reads it) or utf-8") from None
        raise
    write_atomic(args.out, lambda fh: fh.write(data))
    result: dict[str, Any] = {"out": args.out, "sheet": ws_name, "rows": rows_n, "columns": cols_n,
                              "delimiter": args.delimiter, "decimal": args.decimal, "encoding": args.encoding}
    if others:
        result["other_sheets"] = others
    if missing:
        result["formulas_without_saved_result"] = {"count": len(missing), "cells": missing[:20]}
        result["problem"] = ("these formulas have no saved result, so their cells are empty in the CSV: "
                             "recalculate a copy with soffice.py recalc and export that")
        emit(result)
        return 1
    emit(result)
    return 0


# ---------------------------------------------------------------- from-csv


def csv_text(path: str, encoding: str) -> tuple[str, str]:
    """The text of a CSV file and the name of the encoding it was read in."""
    try:
        with open(path, "rb") as fh:
            raw = fh.read()
    except FileNotFoundError:
        raise Fail(f"no such file: {path}") from None
    if encoding != "auto":
        try:
            return raw.decode(encoding).lstrip("\ufeff"), encoding
        except LookupError:
            raise Fail(f"unknown encoding {encoding!r}") from None
        except UnicodeDecodeError as e:
            raise Fail(f"{path} isn't {encoding} (byte {e.start}): try --encoding auto") from None
    if raw[:2] in (codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE):
        used = "utf-16"
    elif raw[:3] == codecs.BOM_UTF8:
        used = "utf-8 with BOM"
    else:
        try:
            raw.decode("utf-8")
            used = "utf-8"
        except UnicodeDecodeError:
            ansi = locale.getpreferredencoding(False)
            used = "cp1252" if codecs.lookup(ansi).name == "utf-8" else codecs.lookup(ansi).name
    return decode(raw, path), used


def sniff(text: str) -> tuple[str, bool]:
    """The delimiter a CSV uses, and whether its first line was Excel's sep= hint (which then isn't data)."""
    first = text.split("\n", 1)[0].strip().strip('"')
    if first.lower().startswith("sep=") and len(first) == 5:
        return first[4], True
    sample = "\n".join(text.splitlines()[:50])
    best, best_score = ",", (-1.0, 0)
    for d in (",", ";", "\t", "|"):
        try:
            widths = [len(r) for r in csv.reader(io.StringIO(sample), delimiter=d) if r]
        except csv.Error:
            continue
        if not widths:
            continue
        width, freq = Counter(widths).most_common(1)[0]
        if width < 2:
            continue
        score = (freq / len(widths), width)
        if score > best_score:
            best, best_score = d, score
    return best, False


def number_re(dec: str, group: str) -> re.Pattern[str]:
    d, g = re.escape(dec), re.escape(group)
    return re.compile(rf"(?P<sign>[+-]?)(?:(?P<int>\d{{1,3}}(?:{g}\d{{3}})+|\d+)(?:{d}(?P<frac>\d+))?|{d}(?P<frac2>\d+))"
                      rf"(?P<exp>[eE][+-]?\d+)?(?P<pct>%?)")


NUMBER = {"point": number_re(".", ","), "comma": number_re(",", ".")}
ISO_DATE = re.compile(r"\d{4}-\d{2}-\d{2}")
ISO_DATETIME = re.compile(r"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{3}|\.\d{6})?)?")
LOCAL_DATE = re.compile(r"(\d{1,2})[./-](\d{1,2})[./-](\d{2}|\d{4})(?: (\d{1,2}):(\d{2})(?::(\d{2}))?)?")


def guess_decimal(rows: list[list[str]], delimiter: str) -> str:
    if delimiter == ",":
        return "point"
    comma = point = 0
    for row in rows[1:200]:
        for v in row:
            v = v.strip()
            if re.fullmatch(r"[+-]?\d+,\d+%?|[+-]?\d{1,3}(\.\d{3})+,\d+%?", v):
                comma += 1
            elif re.fullmatch(r"[+-]?\d+\.\d+%?|[+-]?\d{1,3}(,\d{3})+\.\d+%?", v):
                point += 1
    if comma and not point:
        return "comma"
    if point and not comma:
        return "point"
    return "comma" if delimiter == ";" else "point"  # Excel writes ; where the decimal mark is a comma


def convert(text: str, decimal: str, dates: str) -> tuple[Any, str | None, str]:
    """(value, number format, kind) for one CSV field; kind says what it became or why it stayed text."""
    s = text.strip()
    if s == "":
        return None, None, "empty"
    if s.upper() in ("TRUE", "FALSE"):
        return s.upper() == "TRUE", None, "boolean"
    m = NUMBER[decimal].fullmatch(s)
    if m:
        whole = (m.group("int") or "").replace("." if decimal == "comma" else ",", "")
        frac = m.group("frac") or m.group("frac2") or ""
        grouped = whole != (m.group("int") or "")
        if len(whole) > 1 and whole.startswith("0") and not grouped:
            return text, None, "leading_zeros"
        if not frac and not m.group("exp") and len(whole.lstrip("0")) > 15:
            return text, None, "over_15_digits"
        if frac or m.group("exp") or m.group("pct"):
            value: Any = float(f"{m.group('sign')}{whole or '0'}.{frac or '0'}{m.group('exp') or ''}")
        else:
            value = int(m.group("sign") + whole)
        decimals = "." + "0" * len(frac) if frac else ""
        if m.group("pct"):
            return value / 100, f"0{decimals}%", "number"
        return value, (f"#,##0{decimals}" if grouped else None), "number"
    if ISO_DATE.fullmatch(s):
        try:
            return dt.date.fromisoformat(s), "yyyy-mm-dd", "date"
        except ValueError:
            return text, None, "text"
    if ISO_DATETIME.fullmatch(s):
        try:
            value = dt.datetime.fromisoformat(s)
        except ValueError:
            return text, None, "text"
        return value, "yyyy-mm-dd hh:mm" + (":ss" if s.count(":") > 1 else ""), "date"
    m = LOCAL_DATE.fullmatch(s)
    if m:
        if dates == "iso" or len(m.group(3)) == 2:
            return text, None, "ambiguous_dates"
        a, b, year = int(m.group(1)), int(m.group(2)), int(m.group(3))
        day, month = (a, b) if dates == "dmy" else (b, a)
        try:
            if m.group(4):
                value = dt.datetime(year, month, day, int(m.group(4)), int(m.group(5)), int(m.group(6) or 0))
                return value, "yyyy-mm-dd hh:mm" + (":ss" if m.group(6) else ""), "date"
            return dt.date(year, month, day), "yyyy-mm-dd", "date"
        except ValueError:
            return text, None, "ambiguous_dates"
    return text, None, "text"


def unique_sheet_name(stem: str, taken: set[str]) -> str:
    base = re.sub(r"[\\/?*\[\]:]", "_", stem).strip("'") or "Sheet"
    base = base[:31]
    if base.casefold() == "history":
        base = "History_"
    name, n = base, 1
    while name.casefold() in taken:
        n += 1
        suffix = f" ({n})"
        name = base[:31 - len(suffix)] + suffix
    taken.add(name.casefold())
    return name


def cmd_from_csv(args: argparse.Namespace) -> int:
    from openpyxl import Workbook
    from openpyxl.styles import Border, Font, Side
    from openpyxl.utils import column_index_from_string, get_column_letter

    if args.sheet_name and len(args.csv) > 1:
        raise Fail("--sheet-name is for one CSV; with several, each sheet is named after its file")
    if args.sheet_name and sheet_name_problem(args.sheet_name):
        raise Fail(str(sheet_name_problem(args.sheet_name)))
    if os.path.splitext(args.out)[1].lower() != ".xlsx":
        raise Fail(f"-o should end in .xlsx: {args.out}")
    check_output(args.out, args.csv)
    wb = Workbook()
    wb.remove(wb.active)
    taken: set[str] = set()
    reports = []
    problems_found = False
    for path in args.csv:
        text, used = csv_text(path, args.encoding)
        if args.delimiter == "auto":
            delimiter, hinted = sniff(text)
        else:
            delimiter, hinted = DELIMITERS[args.delimiter], False
        if hinted:
            text = text.split("\n", 1)[1] if "\n" in text else ""
        try:
            rows = list(csv.reader(io.StringIO(text), delimiter=delimiter))
        except csv.Error as e:
            raise Fail(f"can't read {path} as CSV: {e}") from None
        while rows and not any(v.strip() for v in rows[-1]):
            rows.pop()
        width = max((len(r) for r in rows), default=0)
        if len(rows) > MAX_ROW or width > MAX_COL:
            raise Fail(f"{path} has {len(rows)} rows and {width} columns; a sheet holds at most {MAX_ROW} rows "
                       f"and {MAX_COL} columns")
        decimal = guess_decimal(rows, delimiter) if args.decimal == "auto" else args.decimal
        header = [h.strip() for h in rows[0]] if rows and not args.no_header else []
        text_cols: set[int] = set()
        for item in [x.strip() for x in (args.text_columns or "").split(",") if x.strip()]:
            matches = [i + 1 for i, h in enumerate(header) if h.casefold() == item.casefold()]
            if matches:
                text_cols.update(matches)
            elif re.fullmatch(r"[A-Za-z]{1,3}", item):
                text_cols.add(column_index_from_string(item.upper()))
            else:
                raise Fail(f"--text-columns: {path} has no column {item!r} (give a header or a letter like C)")
        name = args.sheet_name or unique_sheet_name(os.path.splitext(os.path.basename(path))[0], taken)
        ws = wb.create_sheet(name)
        kinds: Counter = Counter()
        kept: dict[str, list[str]] = {}
        formula_like = control = 0
        ragged = []
        for r, row in enumerate(rows, 1):
            if header and len(row) != len(rows[0]) and any(v.strip() for v in row):
                ragged.append(r)
            for c, raw in enumerate(row, 1):
                if ILLEGAL.search(raw):
                    raw = ILLEGAL.sub("", raw)
                    control += 1
                if len(raw) > MAX_TEXT:
                    raise Fail(f"{path} row {r} column {c} has {len(raw)} characters; an Excel cell holds at most {MAX_TEXT}")
                if (header and r == 1) or args.no_types or c in text_cols:
                    value, fmt, kind = (raw if raw != "" else None), None, ("empty" if raw == "" else "text")
                else:
                    value, fmt, kind = convert(raw, decimal, args.dates)
                kinds[kind] += 1
                if kind in ("leading_zeros", "over_15_digits", "ambiguous_dates") and len(kept.setdefault(kind, [])) < 5:
                    kept[kind].append(f"{get_column_letter(c)}{r}: {raw}")
                if value is None:
                    continue
                cell = ws.cell(row=r, column=c, value=value)
                if isinstance(value, str) and value.startswith("="):
                    cell.data_type = "s"  # text from a file stays text: never let it become a live formula
                    formula_like += 1
                if fmt:
                    cell.number_format = fmt
        if header:
            for c in range(1, len(rows[0]) + 1):
                cell = ws.cell(row=1, column=c)
                cell.font = Font(bold=True)
                cell.border = Border(bottom=Side(style="thin"))
            if len(rows) > 1:
                ws.freeze_panes = "A2"
                ws.auto_filter.ref = f"A1:{get_column_letter(max(width, 1))}{len(rows)}"
        for c in range(1, width + 1):
            longest = max((len(r[c - 1]) for r in rows[:1000] if len(r) >= c), default=0)
            ws.column_dimensions[get_column_letter(c)].width = min(max(longest + 2, 8), 60)
        report: dict[str, Any] = {
            "sheet": name, "from": path, "encoding": used,
            "delimiter": {"\t": "tab"}.get(delimiter, delimiter) + (" (from the sep= line)" if hinted else ""),
            "decimal": decimal + (" (guessed)" if args.decimal == "auto" and delimiter != "," else ""),
            "rows": len(rows), "columns": width,
            "numbers": kinds["number"], "dates": kinds["date"], "booleans": kinds["boolean"],
            "text": kinds["text"] + kinds["leading_zeros"] + kinds["over_15_digits"] + kinds["ambiguous_dates"],
        }
        if kept.get("leading_zeros"):
            report["kept_as_text_leading_zeros"] = {"count": kinds["leading_zeros"], "examples": kept["leading_zeros"]}
        if kept.get("over_15_digits"):
            report["kept_as_text_over_15_digits"] = {"count": kinds["over_15_digits"], "examples": kept["over_15_digits"]}
        if kept.get("ambiguous_dates"):
            report["dates_left_as_text"] = {"count": kinds["ambiguous_dates"], "examples": kept["ambiguous_dates"],
                                            "how": "--dates dmy or --dates mdy converts them, once you know the order"}
        if text_cols:
            report["text_columns"] = [get_column_letter(c) for c in sorted(text_cols)]
        if formula_like:
            report["text_starting_with_equals"] = formula_like
        if control:
            report["control_characters_removed"] = control
        if ragged:
            problems_found = True
            report["ragged_rows"] = {"count": len(ragged), "rows": ragged[:20],
                                     "problem": "these rows have a different number of fields than the header: "
                                                "check the delimiter and the decimal mark"}
        reports.append(report)
    write_atomic(args.out, wb.save)
    emit({"out": args.out, "sheets": reports})
    return 1 if problems_found else 0


# ---------------------------------------------------------------- references: moving them and renaming sheets

CELL_RE = re.compile(r"(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})")
COL_RE = re.compile(r"(\$?)([A-Za-z]{1,3})")
ROW_RE = re.compile(r"(\$?)(\d{1,7})")
PREFIX_RE = re.compile(r"^(\[[^\]]*\])?('(?:[^']|'')+'|[^'!]+)!")


def quote_sheet(name: str) -> str:
    plain_name = re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.]*", name)
    looks_like_ref = re.fullmatch(r"[A-Za-z]{1,3}\d+|[RrCc]\d*|[Rr]\d*[Cc]\d*", name)
    return name if plain_name and not looks_like_ref else "'" + name.replace("'", "''") + "'"


def split_operand(text: str) -> tuple[str, str | None, bool, str]:
    """'My Sheet'!$A$1:$B$2 -> (prefix with the !, sheet name or None, another workbook?, the area after it)."""
    m = PREFIX_RE.match(text)
    if not m:
        return "", None, False, text
    raw = m.group(2)
    name = raw[1:-1].replace("''", "'") if raw.startswith("'") else raw
    return m.group(0), name, bool(m.group(1)) or "[" in name, text[m.end():]


def endpoint(text: str) -> tuple[str, list[Any]] | None:
    """An end of an A1 area: ('cell', [col$, col, row$, row]), ('col', [col$, col]) or ('row', [row$, row])."""
    from openpyxl.utils import column_index_from_string

    m = CELL_RE.fullmatch(text)
    if m:
        col, row = column_index_from_string(m.group(2).upper()), int(m.group(4))
        if col <= MAX_COL and 1 <= row <= MAX_ROW:
            return "cell", [m.group(1), col, m.group(3), row]
        return None
    m = COL_RE.fullmatch(text)
    if m:
        col = column_index_from_string(m.group(2).upper())
        return ("col", [m.group(1), col]) if col <= MAX_COL else None
    m = ROW_RE.fullmatch(text)
    if m and 1 <= int(m.group(2)) <= MAX_ROW:
        return "row", [m.group(1), int(m.group(2))]
    return None


def render_end(kind: str, parts: list[Any]) -> str:
    from openpyxl.utils import get_column_letter

    if kind == "cell":
        return f"{parts[0]}{get_column_letter(parts[1])}{parts[2]}{parts[3]}"
    if kind == "col":
        return f"{parts[0]}{get_column_letter(parts[1])}"
    return f"{parts[0]}{parts[1]}"


def rewrite_formula(text: str, change: Callable[[str], str | None]) -> tuple[str, bool]:
    """Apply change() to every reference in a formula (text starting with =). Returns the new text and whether the
    formula could be read at all; text inside quotes, function names and table references are never touched."""
    from openpyxl.formula.tokenizer import Tokenizer, TokenizerError

    try:
        tok = Tokenizer(text)
    except TokenizerError:
        return text, False
    changed = False
    for t in tok.items:
        if t.type == "OPERAND" and t.subtype == "RANGE":
            new = change(t.value)
            if new is not None and new != t.value:
                t.value = new
                changed = True
    return (tok.render() if changed else text), True


class Shift:
    """One insert or delete of whole rows or columns on one sheet, and what it does to references."""

    def __init__(self, wb: Any, sheet: str, axis: str, at: int, count: int, delete: bool) -> None:
        self.sheet, self.axis, self.at, self.count, self.delete = sheet, axis, at, count, delete
        self.order = [s.casefold() for s in wb.sheetnames]
        self.limit = MAX_ROW if axis == "rows" else MAX_COL
        self.flags: set[str] = set()  # what the last formula held that couldn't be moved

    def point(self, v: int) -> int | None:
        if self.delete:
            if v < self.at:
                return v
            return v - self.count if v >= self.at + self.count else None
        v2 = v + self.count if v >= self.at else v
        return v2 if v2 <= self.limit else None

    def span(self, a: int, b: int) -> tuple[int, int] | None:
        if self.delete:
            na = a if a < self.at else (a - self.count if a >= self.at + self.count else self.at)
            nb = b if b < self.at else (b - self.count if b >= self.at + self.count else self.at - 1)
            return None if na > nb else (na, nb)
        na = a + self.count if a >= self.at else a
        nb = min(b + self.count if b >= self.at else b, self.limit)
        return None if na > self.limit else (na, nb)

    def touches(self, sheet: str | None) -> bool:
        return sheet is not None and sheet.casefold() == self.sheet.casefold()

    def operand(self, text: str, home: str | None) -> str | None:
        """A reference after the change; None when it isn't one this change moves."""
        prefix, sheet, external, area = split_operand(text)
        if external:
            return None
        if sheet and ":" in sheet:  # a 3-D reference, Sheet1:Sheet3!A1
            ends = [s.casefold() for s in sheet.split(":", 1)]
            if all(e in self.order for e in ends):
                lo, hi = sorted(self.order.index(e) for e in ends)
                if lo <= self.order.index(self.sheet.casefold()) <= hi:
                    self.flags.add("3d")
            return None
        if not self.touches(sheet if prefix else home):
            return None
        pieces = area.split(":")
        if len(pieces) > 2:
            return None
        second_prefix = ""
        if len(pieces) == 2 and "!" in pieces[1]:
            second_prefix, sheet2, _, pieces[1] = split_operand(pieces[1])
            if not self.touches(sheet2):
                return None
        ends = [endpoint(p) for p in pieces]
        if None in ends or len({e[0] for e in ends}) != 1:  # type: ignore[index]
            return None
        kind = ends[0][0]  # type: ignore[index]
        if len(ends) == 1 and kind != "cell":
            return None  # a lone column or row is a name, not a reference
        moves = (kind != "col") if self.axis == "rows" else (kind != "row")
        if not moves:
            return None
        idx = 3 if (kind == "cell" and self.axis == "rows") else 1
        if len(ends) == 1:
            new = self.point(ends[0][1][idx])  # type: ignore[index]
            if new is None:
                self.flags.add("ref_error")
                return "#REF!"  # bare: LibreOffice reads Sheet!#REF! as an unknown name
            parts = list(ends[0][1])  # type: ignore[index]
            parts[idx] = new
            return prefix + render_end(kind, parts)
        a, b = ends[0][1], ends[1][1]  # type: ignore[index]
        lo, hi = sorted((a[idx], b[idx]))
        span = self.span(lo, hi)
        if span is None:
            self.flags.add("ref_error")
            return "#REF!"
        a, b = list(a), list(b)
        if a[idx] <= b[idx]:
            a[idx], b[idx] = span
        else:
            b[idx], a[idx] = span
        return f"{prefix}{render_end(kind, a)}:{second_prefix}{render_end(kind, b)}"

    def formula(self, text: str, home: str | None) -> tuple[str, set[str]]:
        self.flags = set()
        new, readable = rewrite_formula(text, lambda op: self.operand(op, home))
        flags = set(self.flags)
        if not readable:
            flags.add("unreadable")
        if re.search(r"\bINDIRECT\s*\(", text, re.I):
            flags.add("indirect")
        return new, flags

    def area(self, ref: str) -> str | None:
        """A plain range on the changed sheet (B2:D9, B2) after the change; None when all of it was deleted."""
        from openpyxl.utils import get_column_letter, range_boundaries

        c1, r1, c2, r2 = range_boundaries(ref)
        if self.axis == "rows":
            if r1 is None:
                return ref
            span = self.span(r1, r2)
            if span is None:
                return None
            r1, r2 = span
        else:
            if c1 is None:
                return ref
            span = self.span(c1, c2)
            if span is None:
                return None
            c1, c2 = span
        if c1 is None:
            return f"{r1}:{r2}"
        if r1 is None:
            return f"{get_column_letter(c1)}:{get_column_letter(c2)}"
        start, end = f"{get_column_letter(c1)}{r1}", f"{get_column_letter(c2)}{r2}"
        return start if start == end and ":" not in ref else f"{start}:{end}"

    def frozen(self, n: int) -> int:
        """How many rows (or columns) stay frozen, when the first n were."""
        if not self.delete:
            return n + self.count if self.at <= n else n
        gone = max(0, min(self.at + self.count - 1, n) - self.at + 1)
        return n - gone


def chart_refs(chart: Any) -> list[Any]:
    """The cell references inside a chart (series values, categories, names, titles): objects with an .f."""
    from openpyxl.chart.data_source import MultiLevelStrRef, NumRef, StrRef

    found: list[Any] = []
    seen: set[int] = set()

    def walk(obj: Any) -> None:
        if obj is None or id(obj) in seen or isinstance(obj, (str, int, float, bool)):
            return
        seen.add(id(obj))
        if isinstance(obj, (NumRef, StrRef, MultiLevelStrRef)):
            if obj.f:
                found.append(obj)
            return
        if isinstance(obj, (list, tuple)):
            for item in obj:
                walk(item)
            return
        if type(obj).__module__.startswith("openpyxl.chart"):  # stay inside the chart's own objects
            for value in list(vars(obj).values()):
                walk(value)

    walk(chart)
    return found


def anchor_cell(anchor: Any) -> str | None:
    from openpyxl.utils import get_column_letter

    if isinstance(anchor, str):
        return anchor
    start = getattr(anchor, "_from", None)
    if start is None:
        return None
    return f"{get_column_letter(start.col + 1)}{start.row + 1}"


def each_formula_holder(wb: Any) -> list[tuple[str, Any, str, Any]]:
    """Every formula-like text in the workbook outside cells: (home sheet, object, attribute, where it is)."""
    holders = []
    for ws in wb.worksheets:
        for dv in ws.data_validations.dataValidation:
            for attr in ("formula1", "formula2"):
                if getattr(dv, attr):
                    holders.append((ws.title, dv, attr, f"data validation on {ws.title}!{dv.sqref}"))
        for cf in ws.conditional_formatting:
            for rule in cf.rules:
                for i in range(len(rule.formula or [])):
                    holders.append((ws.title, rule.formula, i, f"conditional format on {ws.title}!{cf.sqref}"))
        for t in ws.tables.values():
            for col in t.tableColumns:
                for attr in ("calculatedColumnFormula", "totalsRowFormula"):
                    tf = getattr(col, attr)
                    if tf is not None and tf.attr_text:
                        holders.append((ws.title, tf, "attr_text", f"table {t.displayName} column {col.name}"))
        for cell in ws._cells.values():
            link = getattr(cell, "_hyperlink", None)
            if link is not None and link.location:
                holders.append((ws.title, link, "location", f"link in {ws.title}!{cell.coordinate}"))
    return holders


def get_text(obj: Any, attr: Any) -> str:
    return obj[attr] if isinstance(attr, int) else getattr(obj, attr)


def set_text(obj: Any, attr: Any, value: str) -> None:
    if isinstance(attr, int):
        obj[attr] = value
    else:
        setattr(obj, attr, value)


def all_names(wb: Any) -> list[tuple[str, Any]]:
    found = [(n, d) for n, d in wb.defined_names.items()]
    for ws in wb.worksheets:
        found += [(f"{ws.title}!{n}", d) for n, d in ws.defined_names.items()]
    return found


# ---------------------------------------------------------------- restructure


def shift_filter_columns(flt: Any, old_min: int, new_min: int, s: Shift) -> None:
    """Keep an autofilter's per-column settings on their columns after columns move inside it."""
    if s.axis != "cols" or flt is None or not flt.filterColumn:
        return
    kept = []
    for fc in flt.filterColumn:
        new = s.point(old_min + fc.colId)
        if new is not None:
            fc.colId = new - new_min
            kept.append(fc)
    flt.filterColumn = kept


def shift_sort(state: Any, s: Shift) -> Any:
    if state is None or not state.ref:
        return state
    new = s.area(str(state.ref))
    if new is None:
        return None
    state.ref = new
    kept = []
    for cond in state.sortCondition or []:
        r = s.area(str(cond.ref))
        if r is not None:
            cond.ref = r
            kept.append(cond)
    state.sortCondition = kept
    return state


def plan_tables(ws: Any, s: Shift) -> None:
    """Refuse a change that would leave a table Excel can't open: its header row deleted, or no rows left."""
    from openpyxl.utils import range_boundaries

    for t in ws.tables.values():
        c1, r1, c2, r2 = range_boundaries(t.ref)
        header = 0 if t.headerRowCount == 0 else 1
        totals = t.totalsRowCount or 0
        lo, hi = (r1, r2) if s.axis == "rows" else (c1, c2)
        span = s.span(lo, hi)
        if span is None or not s.delete or s.axis != "rows":
            continue
        if header and s.at <= r1 < s.at + s.count:
            raise Fail(f"this would delete the header row of table {t.displayName} ({t.ref}) but not the whole table: "
                       "delete rows below its header, or all of its rows")
        if span[1] - span[0] + 1 - header - totals < 1:
            raise Fail(f"this would leave table {t.displayName} ({t.ref}) with no rows: delete all of it, or leave a row")


def move_tables(ws: Any, s: Shift, rep: dict[str, Any]) -> None:
    from openpyxl.utils import get_column_letter, range_boundaries
    from openpyxl.worksheet.table import TableColumn

    for t in list(ws.tables.values()):
        old = t.ref
        c1, r1, c2, r2 = range_boundaries(old)
        new = s.area(old)
        if new is None:
            del ws.tables[t.displayName]
            rep["tables"].append({"table": t.displayName, "from": old, "to": None, "note": "all of it was deleted"})
            continue
        nc1, nr1, nc2, nr2 = range_boundaries(new)
        if s.axis == "cols":
            columns = list(t.tableColumns)
            if s.delete:
                gone = {i for i in range(len(columns)) if s.at <= c1 + i < s.at + s.count}
                columns = [col for i, col in enumerate(columns) if i not in gone]
            elif c1 < s.at <= c2:
                pos = s.at - c1
                taken = {col.name.casefold() for col in columns}
                next_id = max((col.id for col in columns), default=0) + 1
                header_row = nr1 if t.headerRowCount != 0 else None
                for k in range(s.count):
                    n = 1
                    while f"Column{n}".casefold() in taken:
                        n += 1
                    name = f"Column{n}"
                    taken.add(name.casefold())
                    columns.insert(pos + k, TableColumn(id=next_id + k, name=name))
                    if header_row:
                        ws.cell(row=header_row, column=s.at + k, value=name)
            t.tableColumns = columns
            if t.autoFilter is not None:
                shift_filter_columns(t.autoFilter, c1, nc1, s)
        t.ref = new
        if t.autoFilter is not None:
            t.autoFilter.ref = f"{get_column_letter(nc1)}{nr1}:{get_column_letter(nc2)}{nr2 - (t.totalsRowCount or 0)}"
        t.sortState = shift_sort(t.sortState, s)
        if new != old:
            rep["tables"].append({"table": t.displayName, "from": old, "to": new})


def move_dimensions(ws: Any, s: Shift) -> None:
    from openpyxl.utils import get_column_letter

    if s.axis == "rows":
        dims = list(ws.row_dimensions.items())
        ws.row_dimensions.clear()
        for idx, dim in dims:
            new = s.point(int(idx))
            if new is not None:
                dim.index = new
                ws.row_dimensions[new] = dim
        breaks = ws.row_breaks
    else:
        dims = list(ws.column_dimensions.values())
        ws.column_dimensions.clear()
        for dim in dims:
            dim.reindex()
            span = s.span(dim.min, dim.max)
            if span is None:
                continue
            dim.min, dim.max = span
            dim.index = get_column_letter(span[0])
            ws.column_dimensions[dim.index] = dim
        breaks = ws.col_breaks
    kept = []
    for brk in breaks.brk:
        new = s.point(brk.id) if brk.id else None
        if new is not None:
            brk.id = new
            kept.append(brk)
    breaks.brk = kept


def restructure(wb: Any, ws: Any, s: Shift) -> dict[str, Any]:
    from openpyxl.formatting.formatting import ConditionalFormatting, ConditionalFormattingList
    from openpyxl.utils import get_column_letter, range_boundaries
    from openpyxl.worksheet.cell_range import MultiCellRange

    rep: dict[str, Any] = {"formulas": [], "merges": [], "tables": [], "names": [], "validations": [],
                           "conditional_formats": [], "other": [], "ref_errors": [], "not_shifted": []}
    flagged: dict[str, list[str]] = {"indirect": [], "3d": [], "unreadable": [], "data_table": []}
    if s.delete:
        rep["cells_deleted"] = sum(1 for (r, c), cell in ws._cells.items()
                                   if cell.value is not None and s.at <= (r if s.axis == "rows" else c) < s.at + s.count)
    else:
        last = max((r if s.axis == "rows" else c for (r, c), cell in ws._cells.items() if cell.value is not None), default=0)
        if last >= s.at and last + s.count > s.limit:
            raise Fail(f"this would push cells past the sheet's last {'row' if s.axis == 'rows' else 'column'}: "
                       "delete what's at the end first")
    plan_tables(ws, s)

    merges = [str(r) for r in ws.merged_cells.ranges]
    for m in merges:
        ws.unmerge_cells(m)
    if s.axis == "rows":
        (ws.delete_rows if s.delete else ws.insert_rows)(s.at, s.count)
    else:
        (ws.delete_cols if s.delete else ws.insert_cols)(s.at, s.count)
    for cell in ws._cells.values():
        link = getattr(cell, "_hyperlink", None)
        if link is not None:
            link.ref = cell.coordinate  # openpyxl leaves the old address on a moved cell's link

    changed = 0
    for sheet in wb.worksheets:
        for cell in list(sheet._cells.values()):
            value = cell.value
            kind = type(value).__name__
            where = f"{sheet.title}!{cell.coordinate}"
            if kind == "DataTableFormula":
                if sheet is ws:
                    flagged["data_table"].append(where)
                continue
            if kind == "ArrayFormula":
                text = value.text
            elif cell.data_type == "f" and isinstance(value, str):
                text = value
            else:
                continue
            new, flags = s.formula(text, sheet.title)
            for f in flags:
                if f in flagged:
                    flagged[f].append(where)
            if kind == "ArrayFormula" and sheet is ws:
                ref = s.area(value.ref)
                if ref:
                    value.ref = ref
            if new != text:
                changed += 1
                if len(rep["formulas"]) < 100:
                    rep["formulas"].append({"cell": where, "from": text, "to": new})
                if "ref_error" in flags:
                    rep["ref_errors"].append({"cell": where, "formula": new})
                if kind == "ArrayFormula":
                    value.text = new
                else:
                    cell.value = new
    rep["formulas_changed"] = changed

    for home, obj, attr, where in each_formula_holder(wb):
        text = get_text(obj, attr)
        lead = "" if text.startswith("=") else "="
        new, flags = s.formula(lead + text, home)
        new = new[len(lead):]
        if new != text:
            set_text(obj, attr, new)
            rep["other"].append({"where": where, "from": text, "to": new})
            if "ref_error" in flags:
                rep["ref_errors"].append({"where": where, "formula": new})

    for name, d in all_names(wb):
        text = d.attr_text or ""
        new, flags = s.formula("=" + text, None)
        new = new[1:]
        if new != text:
            d.attr_text = new
            rep["names"].append({"name": name, "from": text, "to": new})
            if "ref_error" in flags:
                rep["ref_errors"].append({"name": name, "refers_to": new})

    for m in merges:
        new = s.area(m)
        if new is None or ":" not in new:
            rep["merges"].append({"from": m, "to": None})
            continue
        ws.merge_cells(new)
        if new != m:
            rep["merges"].append({"from": m, "to": new})

    for dv in ws.data_validations.dataValidation:
        old = str(dv.sqref)
        new = str(MultiCellRange(" ".join(p for p in (s.area(str(r)) for r in dv.sqref.sorted()) if p)))
        if new != old:
            rep["validations"].append({"from": old, "to": new or None})
            dv.sqref = MultiCellRange(new)
    ws.data_validations.dataValidation = [dv for dv in ws.data_validations.dataValidation if str(dv.sqref)]

    formats = ConditionalFormattingList()
    for cf in ws.conditional_formatting:
        old = str(cf.sqref)
        new = str(MultiCellRange(" ".join(p for p in (s.area(str(r)) for r in cf.sqref.sorted()) if p)))
        if new != old:
            rep["conditional_formats"].append({"from": old, "to": new or None})
        if not new:
            continue
        target = ConditionalFormatting(sqref=new)
        for rule in cf.rules:
            formats.add(target, rule)
    ws.conditional_formatting = formats

    flt = ws.auto_filter
    if flt.ref:
        old = str(flt.ref)
        c1 = range_boundaries(old)[0]
        new = s.area(old)
        if new:
            shift_filter_columns(flt, c1, range_boundaries(new)[0], s)
        flt.sortState = shift_sort(flt.sortState, s)
        if new != old:
            flt.ref = new
            rep["filter"] = {"from": old, "to": new}

    move_tables(ws, s, rep)

    if ws.freeze_panes:
        old = ws.freeze_panes
        c, r = range_boundaries(old)[:2]
        if s.axis == "rows":
            r = s.frozen(r - 1) + 1
        else:
            c = s.frozen(c - 1) + 1
        new = None if (r, c) == (1, 1) else f"{get_column_letter(c)}{r}"
        if new != old:
            ws.freeze_panes = new
            rep["freeze"] = {"from": old, "to": new}

    if ws._print_area:
        old_parts = [str(r) for r in ws._print_area]
        parts = [p for p in (s.area(r) for r in old_parts) if p]
        if parts != old_parts:
            ws.print_area = parts or None
            rep["print_area"] = {"from": old_parts, "to": parts or None}
    titles = ws._print_rows if s.axis == "rows" else ws._print_cols
    if titles is not None:
        old = str(titles)
        a, b = old.replace("$", "").split(":")
        if s.axis == "rows":
            span = s.span(int(a), int(b))
            if span is None:
                ws._print_rows = None
            else:
                ws.print_title_rows = f"{span[0]}:{span[1]}"
            new_titles = ws.print_title_rows
        else:
            from openpyxl.utils import column_index_from_string

            span = s.span(column_index_from_string(a), column_index_from_string(b))
            if span is None:
                ws._print_cols = None
            else:
                ws.print_title_cols = f"{get_column_letter(span[0])}:{get_column_letter(span[1])}"
            new_titles = ws.print_title_cols
        if new_titles != old:
            rep["print_titles"] = {"from": old, "to": new_titles}

    move_dimensions(ws, s)

    for sheet in wb.worksheets:
        for chart in sheet._charts:
            refs = [r.f for r in chart_refs(chart)]
            moved = []
            for f in refs:
                new, _ = s.formula("=" + f, None)
                if new[1:] != f:
                    moved.append({"now": f, "should_be": new[1:]})
            at = anchor_cell(chart.anchor)
            position = None
            if sheet is ws and at:
                c, r = range_boundaries(at)[:2]
                if (r if s.axis == "rows" else c) >= s.at:
                    position = at
            if moved or position:
                entry: dict[str, Any] = {"what": "chart", "sheet": sheet.title, "at": at}
                if moved:
                    entry["data"] = moved
                if position:
                    entry["position"] = "still anchored at the old cell"
                rep["not_shifted"].append(entry)
    for image in ws._images:
        at = anchor_cell(image.anchor)
        if at:
            c, r = range_boundaries(at)[:2]
            if (r if s.axis == "rows" else c) >= s.at:
                rep["not_shifted"].append({"what": "picture", "sheet": ws.title, "at": at,
                                           "position": "still anchored at the old cell"})
    pivots = [(sheet.title, getattr(p, "name", "")) for sheet in wb.worksheets for p in getattr(sheet, "_pivots", [])]
    if pivots:
        rep["not_shifted"].append({"what": "pivot tables (their source ranges and places aren't checked)",
                                   "pivots": [f"{t}: {n}" for t, n in pivots]})
    labels = {
        "indirect": "formulas that build references from text (INDIRECT): the text isn't changed",
        "3d": "3-D references that span several sheets",
        "unreadable": "formulas the script couldn't read, left as they were",
        "data_table": "Excel data tables (What-If Analysis)",
    }
    for key, cells in flagged.items():
        if cells:
            rep["not_shifted"].append({"what": labels[key], "cells": sorted(set(cells))[:30]})
    return rep


def parse_index(text: str, axis: str) -> int:
    from openpyxl.utils import column_index_from_string

    text = text.strip()
    if axis == "cols" and re.fullmatch(r"[A-Za-z]{1,3}", text):
        n = column_index_from_string(text.upper())
    elif re.fullmatch(r"\d+", text):
        n = int(text)
    else:
        raise Fail(f"{text!r} isn't a {'row number' if axis == 'rows' else 'column letter or number'}")
    limit = MAX_ROW if axis == "rows" else MAX_COL
    if not 1 <= n <= limit:
        raise Fail(f"{'rows' if axis == 'rows' else 'columns'} go from 1 to {limit}, not {n}")
    return n


def cmd_restructure(args: argparse.Namespace) -> int:
    from openpyxl.utils import get_column_letter

    if args.count < 1:
        raise Fail("--count is how many rows or columns, from 1 up")
    for flag, axis, delete in (("insert_rows", "rows", False), ("delete_rows", "rows", True),
                               ("insert_cols", "cols", False), ("delete_cols", "cols", True)):
        if getattr(args, flag) is not None:
            raw = getattr(args, flag)
            break
    at = parse_index(raw, axis)
    limit = MAX_ROW if axis == "rows" else MAX_COL
    if at + args.count - 1 > limit:
        raise Fail(f"there are only {limit} {'rows' if axis == 'rows' else 'columns'}")
    check_output(args.out, [args.book])
    wb = open_book(args.book, edit=True)
    ws = pick_sheet(wb, args.sheet)
    s = Shift(wb, ws.title, axis, at, args.count, delete)
    rep = restructure(wb, ws, s)
    lost = save_book(wb, args.out, args.book)
    unit = ("row" if axis == "rows" else "column") + ("s" if args.count > 1 else "")
    where = str(at) if axis == "rows" else get_column_letter(at)
    did = f"deleted {args.count} {unit} from {where}" if delete else f"inserted {args.count} {unit} before {where}"
    result: dict[str, Any] = {"out": args.out, "sheet": ws.title, "did": did}
    result.update({k: v for k, v in rep.items() if v not in ([], None)})
    result["formulas_changed"] = rep["formulas_changed"]
    if lost:
        result["lost_on_save"] = lost
    problems = bool(rep["ref_errors"] or rep["not_shifted"] or lost)
    if problems:
        result["problem"] = ("check ref_errors, not_shifted and lost_on_save: each needs a fix by hand or a word "
                             "to the user (references/restructuring.md says how)")
    emit(result)
    return 1 if problems else 0


# ---------------------------------------------------------------- edit


def rename_operand(text: str, old: str, new: str) -> str | None:
    prefix, sheet, external, area = split_operand(text)
    if not prefix or external or sheet is None:
        return None
    names = sheet.split(":")
    if not any(n.casefold() == old.casefold() for n in names):
        return None
    renamed = ":".join(new if n.casefold() == old.casefold() else n for n in names)
    quoted = quote_sheet(renamed) if ":" not in renamed else (
        renamed if all(quote_sheet(n) == n for n in renamed.split(":")) else "'" + renamed.replace("'", "''") + "'")
    rest = area
    if ":" in area and "!" in area:  # Data!A1:Data!A5
        first, second = area.split(":", 1)
        p2, s2, _, a2 = split_operand(second)
        if s2 is not None and s2.casefold() == old.casefold():
            rest = f"{first}:{quote_sheet(new)}!{a2}"
    return f"{quoted}!{rest}"


def rename_sheet(wb: Any, ws: Any, new: str) -> int:
    """Rename a sheet and every reference to it: formulas, names, validations, conditional formats, table and chart
    references, links. Returns how many texts changed."""
    old = ws.title
    ws.title = new
    count = 0

    def fix(text: str) -> str:
        nonlocal count
        lead = "" if text.startswith("=") else "="
        out, _ = rewrite_formula(lead + text, lambda op: rename_operand(op, old, new))
        out = out[len(lead):]
        if out != text:
            count += 1
        return out

    for sheet in wb.worksheets:
        for cell in sheet._cells.values():
            kind = type(cell.value).__name__
            if kind == "ArrayFormula":
                cell.value.text = fix(cell.value.text)
            elif cell.data_type == "f" and isinstance(cell.value, str):
                cell.value = fix(cell.value)
        for chart in sheet._charts:
            for ref in chart_refs(chart):
                ref.f = fix(ref.f)
    for _, obj, attr, _ in each_formula_holder(wb):
        set_text(obj, attr, fix(get_text(obj, attr)))
    for _, d in all_names(wb):
        if d.attr_text:
            d.attr_text = fix(d.attr_text)
    return count


def last_used_row(ws: Any) -> int:
    return max((r for (r, _), cell in ws._cells.items() if cell.value is not None), default=0)


def find_table(wb: Any, name: str) -> tuple[Any, Any] | None:
    for ws in wb.worksheets:
        for t in ws.tables.values():
            if t.displayName.casefold() == name.casefold():
                return ws, t
    return None


NAME_RE = re.compile(r"(?:[^\W\d]|\\)[\w.\\]*")
CELLISH_RE = re.compile(r"[A-Za-z]{1,3}\d+|[RrCc]|[Rr]\d*[Cc]\d*|[Rr]\d+|[Cc]\d+")


def cmd_edit(args: argparse.Namespace) -> int:
    from openpyxl.utils import get_column_letter, range_boundaries
    from openpyxl.workbook.defined_name import DefinedName

    check_output(args.out, [args.book, args.changes])
    spec = load_json(args.changes)
    changes = spec.get("changes") if isinstance(spec, dict) else spec
    if not isinstance(changes, list) or not changes:
        raise Fail('the changes file is {"changes": [...]}, a list of changes like {"do": "set", ...}')
    wb = open_book(args.book, edit=True)
    problems: list[str] = []
    done: list[dict[str, Any]] = []
    written: list[tuple[Any, str, str]] = []  # (sheet, cell, formula): sheets as objects, since a rename may follow
    numberish: list[tuple[Any, str]] = []
    renamed_refs = 0
    indirect: list[str] = []

    def sheet_for(change: dict[str, Any], where: str) -> Any:
        name = change.get("sheet")
        try:
            return pick_sheet(wb, name if isinstance(name, str) else None)
        except Fail as e:
            problems.append(f"{where}: {e}")
            return None

    def write(ws: Any, coord: str, value: Any, where: str) -> None:
        cell = ws[coord]
        if type(cell).__name__ == "MergedCell":
            owner = next((str(r) for r in ws.merged_cells.ranges if coord in r), "a merged range")
            problems.append(f"{where}: {coord} is inside merged cells {owner}; write to its top-left cell")
            return
        put_value(cell, value, where, problems)
        if cell.data_type == "f" and isinstance(cell.value, str):
            written.append((ws, coord, cell.value))
        raw = value.get("value") if isinstance(value, dict) else value
        if isinstance(raw, str) and NUMBER["point"].fullmatch(raw.strip()):
            numberish.append((ws, coord))
        for t in ws.tables.values():  # a table's header text and its column name must agree
            c1, r1, c2, _ = range_boundaries(t.ref)
            if t.headerRowCount != 0 and cell.row == r1 and c1 <= cell.column <= c2:
                if not isinstance(cell.value, str) or not cell.value.strip():
                    problems.append(f"{where}: {coord} heads a column of table {t.displayName}, so it must be text")
                else:
                    t.tableColumns[cell.column - c1].name = cell.value

    for i, change in enumerate(changes):
        where = f"change {i + 1}"
        if not isinstance(change, dict) or not isinstance(change.get("do"), str):
            problems.append(f'{where}: each change is an object with "do"')
            continue
        do = change["do"]
        if do == "set":
            ws = sheet_for(change, where)
            cells = change.get("cells")
            if ws is None:
                continue
            if not isinstance(cells, dict) or not cells:
                problems.append(f'{where}: "cells" maps cell addresses to values, like {{"B2": 42}}')
                continue
            for coord, value in cells.items():
                if not CELL_RE.fullmatch(str(coord).replace("$", "")):
                    problems.append(f"{where}: {coord!r} isn't a cell address like B2")
                    continue
                write(ws, str(coord).replace("$", "").upper(), value, f"{where} {coord}")
            done.append({"do": "set", "sheet": ws.title, "cells": len(cells)})
        elif do == "append":
            rows = change.get("rows")
            if not isinstance(rows, list) or not rows or not all(isinstance(r, list) for r in rows):
                problems.append(f'{where}: "rows" is a list of rows, each a list of values')
                continue
            if change.get("table"):
                hit = find_table(wb, str(change["table"]))
                if hit is None:
                    problems.append(f"{where}: no table named {change['table']!r}")
                    continue
                ws, t = hit
                c1, r1, c2, r2 = range_boundaries(t.ref)
                if t.totalsRowCount:
                    problems.append(f"{where}: table {t.displayName} has a totals row: insert rows inside it with "
                                    "restructure, then set them")
                    continue
                if any(len(r) > c2 - c1 + 1 for r in rows):
                    problems.append(f"{where}: table {t.displayName} has {c2 - c1 + 1} columns; a row is longer")
                    continue
                below = [ws.cell(row=r, column=c) for r in range(r2 + 1, r2 + 1 + len(rows)) for c in range(c1, c2 + 1)]
                if any(cell.value is not None for cell in below):
                    problems.append(f"{where}: the rows under table {t.displayName} aren't empty")
                    continue
                for k, row in enumerate(rows):
                    for j in range(c2 - c1 + 1):
                        target = ws.cell(row=r2 + 1 + k, column=c1 + j)
                        target._style = copy(ws.cell(row=r2, column=c1 + j)._style)
                        if j < len(row):
                            write(ws, target.coordinate, row[j], f"{where} row {k + 1}")
                new_ref = f"{get_column_letter(c1)}{r1}:{get_column_letter(c2)}{r2 + len(rows)}"
                t.ref = new_ref
                if t.autoFilter is not None:
                    t.autoFilter.ref = new_ref
                done.append({"do": "append", "table": t.displayName, "rows": len(rows), "range": new_ref})
            else:
                ws = sheet_for(change, where)
                if ws is None:
                    continue
                start = last_used_row(ws) + 1
                for k, row in enumerate(rows):
                    for j, value in enumerate(row):
                        write(ws, f"{get_column_letter(j + 1)}{start + k}", value, f"{where} row {k + 1}")
                done.append({"do": "append", "sheet": ws.title, "rows": len(rows), "from_row": start})
        elif do == "format":
            ws = sheet_for(change, where)
            if ws is None:
                continue
            style = {k: v for k, v in change.items() if k in STYLE_KEYS}
            unknown = sorted(set(change) - set(STYLE_KEYS) - {"do", "sheet", "range"})
            if unknown or not style:
                problems.append(f"{where}: format takes a range and {', '.join(STYLE_KEYS)}"
                                + (f" (not {', '.join(unknown)})" if unknown else ""))
                continue
            try:
                c1, r1, c2, r2 = parse_range(str(change.get("range", "")))
            except Fail as e:
                problems.append(f"{where}: {e}")
                continue
            for r in range(r1, r2 + 1):
                for c in range(c1, c2 + 1):
                    cell = ws.cell(row=r, column=c)
                    if type(cell).__name__ != "MergedCell":
                        apply_style(cell, style, where, problems)
            done.append({"do": "format", "sheet": ws.title, "range": change["range"]})
        elif do == "widths":
            ws = sheet_for(change, where)
            widths = change.get("columns")
            if ws is None:
                continue
            if not isinstance(widths, dict) or not widths:
                problems.append(f'{where}: "columns" maps letters to widths, like {{"A": 20}}')
                continue
            for col, width in widths.items():
                if not re.fullmatch(r"[A-Za-z]{1,3}", str(col)):
                    problems.append(f"{where}: {col!r} isn't a column letter")
                elif not isinstance(width, (int, float)) or isinstance(width, bool) or not 0 < width <= 255:
                    problems.append(f"{where}: a column width is a number above 0, at most 255")
                else:
                    ws.column_dimensions[str(col).upper()].width = width
            done.append({"do": "widths", "sheet": ws.title, "columns": len(widths)})
        elif do == "freeze":
            ws = sheet_for(change, where)
            at = change.get("at")
            if ws is None:
                continue
            if at is not None and not CELL_RE.fullmatch(str(at)):
                problems.append(f'{where}: "at" is the first cell that scrolls, like A2 (or null to unfreeze)')
                continue
            ws.freeze_panes = str(at).upper() if at else None
            done.append({"do": "freeze", "sheet": ws.title, "at": ws.freeze_panes})
        elif do == "rename_sheet":
            ws = sheet_for(change, where)
            new = change.get("to")
            if ws is None:
                continue
            why = sheet_name_problem(new)
            if why:
                problems.append(f"{where}: {why}")
                continue
            if any(t.casefold() == str(new).casefold() and t != ws.title for t in wb.sheetnames):
                problems.append(f"{where}: there is already a sheet named {new!r}")
                continue
            old = ws.title
            renamed_refs += rename_sheet(wb, ws, str(new))
            for sheet in wb.worksheets:  # INDIRECT("Old!A1") is text: neither Excel nor this changes it
                for cell in sheet._cells.values():
                    if (cell.data_type == "f" and isinstance(cell.value, str) and old.casefold() in cell.value.casefold()
                            and re.search(r"\bINDIRECT\s*\(", cell.value, re.I)):
                        indirect.append(f"{sheet.title}!{cell.coordinate}")
            done.append({"do": "rename_sheet", "from": old, "to": new})
        elif do == "add_sheet":
            name = change.get("sheet")
            why = sheet_name_problem(name)
            position = change.get("position")
            if why:
                problems.append(f"{where}: {why}")
            elif any(t.casefold() == str(name).casefold() for t in wb.sheetnames):
                problems.append(f"{where}: there is already a sheet named {name!r}")
            elif position is not None and (not isinstance(position, int) or isinstance(position, bool) or position < 1):
                problems.append(f"{where}: position counts sheets from 1")
            else:
                wb.create_sheet(str(name), None if position is None else position - 1)
                done.append({"do": "add_sheet", "sheet": name})
        elif do == "name":
            name, refers = change.get("name"), change.get("refers_to")
            if not isinstance(name, str) or not NAME_RE.fullmatch(name) or CELLISH_RE.fullmatch(name) or len(name) > 255:
                problems.append(f"{where}: {name!r} can't be a name: start with a letter or _, no spaces, and not "
                                "something that looks like a cell such as A1 or R1C1")
                continue
            if not isinstance(refers, str) or not refers.strip():
                problems.append(f'{where}: "refers_to" is a reference like Inputs!$B$3 or a formula')
                continue
            refers = refers.strip().lstrip("=")
            scope = None
            if change.get("sheet"):
                scope = sheet_for(change, where)
                if scope is None:
                    continue
            holder = scope.defined_names if scope is not None else wb.defined_names
            holder[name] = DefinedName(name, attr_text=refers)
            written.append((scope if scope is not None else "(names)", name, "=" + refers))
            done.append({"do": "name", "name": name, "refers_to": refers})
        else:
            problems.append(f"{where}: unknown change {do!r}: use set, append, format, widths, freeze, "
                            "rename_sheet, add_sheet or name")
    if problems:
        shown = "; ".join(problems[:12]) + (f"; and {len(problems) - 12} more" if len(problems) > 12 else "")
        raise Fail(f"nothing written: {len(problems)} problem{'s' if len(problems) > 1 else ''} in "
                   f"{args.changes}: {shown}")
    formula_issues = formula_problems(wb, [(getattr(w, "title", w), c, f) for w, c, f in written])
    lost = save_book(wb, args.out, args.book)
    result: dict[str, Any] = {"out": args.out, "changes": done}
    if renamed_refs:
        result["references_renamed"] = renamed_refs
    if numberish:
        result["text_that_looks_like_numbers"] = {
            "cells": [f"{w.title}!{c}" for w, c in numberish[:20]], "note": "written as text because the value was in quotes; write 42, not \"42\", "
                                             "for a number"}
    if formula_issues:
        result["formula_problems"] = formula_issues
    if indirect:
        result["not_updated"] = {"what": "INDIRECT formulas that name the old sheet in text", "cells": indirect[:30]}
    if lost:
        result["lost_on_save"] = lost
    emit(result)
    return 1 if (formula_issues or indirect or lost) else 0


# ---------------------------------------------------------------- command line


def build_parser() -> argparse.ArgumentParser:
    p = Parser(prog="xlsx_tool.py", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="command", metavar="COMMAND")

    def add(name: str, func: Callable[[argparse.Namespace], int], help_text: str, example: str) -> argparse.ArgumentParser:
        sp = sub.add_parser(name, help=help_text, description=help_text, epilog=f"example:\n  {example}",
                            formatter_class=argparse.RawDescriptionHelpFormatter)
        sp.set_defaults(func=func)
        return sp

    sp = add("info", cmd_info, "What a workbook holds: sheets, used ranges, formulas and whether they have saved "
             "results, tables, names, charts, pictures, merged cells, validations, protection, macros, and what "
             "openpyxl would leave out if it saved the file.", "python xlsx_tool.py info budget.xlsx")
    sp.add_argument("book")

    sp = add("read", cmd_read, "Cell values as JSON rows: saved results (default), formula text, or both.",
             "python xlsx_tool.py read budget.xlsx --sheet Summary --range A1:F40 --show both")
    sp.add_argument("book")
    sp.add_argument("--sheet", help="one sheet (default: every sheet)")
    sp.add_argument("--range", help="only these cells, like A1:F40")
    sp.add_argument("--show", choices=["values", "formulas", "both"], default="values",
                    help="values: saved results; formulas: a formula's text; both: formula and saved result")
    sp.add_argument("--max-rows", type=int, default=200, help="rows to show per sheet (default 200)")

    sp = add("diff", cmd_diff, "Every cell that differs between two workbooks (formulas compared as text).",
             "python xlsx_tool.py diff budget-backup.xlsx budget.xlsx")
    sp.add_argument("before")
    sp.add_argument("after")
    sp.add_argument("--values", action="store_true", help="compare saved results instead of formulas")
    sp.add_argument("--limit", type=int, default=200, help="list at most this many changed cells (default 200; all are counted)")

    sp = add("to-csv", cmd_to_csv, "One sheet's saved values as a CSV file.",
             "python xlsx_tool.py to-csv budget.xlsx --sheet Summary -o summary.csv --encoding utf-8-sig")
    sp.add_argument("book")
    sp.add_argument("-o", "--out", required=True, help="the .csv to write")
    sp.add_argument("--sheet", help="which sheet (default: the one that was open when the file was saved)")
    sp.add_argument("--delimiter", choices=[",", ";", "tab", "|"], default=",", metavar="SEP",
                    help="field separator: , (default), ; tab or | (quote ; and | on the command line)")
    sp.add_argument("--decimal", choices=["point", "comma"], default="point", help="decimal mark for numbers (default point)")
    sp.add_argument("--encoding", default="utf-8",
                    help="utf-8 (default), utf-8-sig (UTF-8 that Excel opens correctly), or a code page like cp1252")

    sp = add("from-csv", cmd_from_csv, "A workbook from one or more CSV files, one sheet each, with numbers, dates "
             "and true/false turned into real values and IDs kept as text.",
             "python xlsx_tool.py from-csv sales.csv -o sales.xlsx --delimiter \";\" --decimal comma --text-columns \"ID,Phone\"")
    sp.add_argument("csv", nargs="+")
    sp.add_argument("-o", "--out", required=True, help="the .xlsx to write")
    sp.add_argument("--delimiter", choices=["auto", ",", ";", "tab", "|"], default="auto", metavar="SEP",
                    help="field separator: auto (default: worked out from the file, or its sep= line), , ; tab or | "
                         "(quote ; and | on the command line)")
    sp.add_argument("--decimal", choices=["auto", "point", "comma"], default="auto",
                    help="decimal mark (default: point for comma-separated files, otherwise guessed from the numbers)")
    sp.add_argument("--encoding", default="auto",
                    help="auto (default: UTF-16 or UTF-8 by their marks, else this computer's ANSI code page) or a name like cp1251")
    sp.add_argument("--dates", choices=["iso", "dmy", "mdy"], default="iso",
                    help="iso (default) turns only 2026-01-31 into dates; dmy or mdy also 31/01/2026 or 01/31/2026")
    sp.add_argument("--text-columns", metavar="COLUMNS",
                    help="columns to keep as text, by header or letter, in quotes: \"ID,Phone\" or \"A,C\"")
    sp.add_argument("--no-types", action="store_true", help="keep every field as text")
    sp.add_argument("--no-header", action="store_true", help="the first row is data: no bold header, freeze or filter")
    sp.add_argument("--sheet-name", help="name of the sheet (one CSV only; default: the file's name)")

    sp = add("edit", cmd_edit, "Apply a JSON list of changes (set, append, format, widths, freeze, rename_sheet, "
             "add_sheet, name) and save a new workbook. references/create-spec.md describes the changes file.",
             "python xlsx_tool.py edit budget-backup.xlsx --changes xlsx-work/changes.json -o budget.xlsx")
    sp.add_argument("book")
    sp.add_argument("--changes", required=True, help="the JSON file of changes")
    sp.add_argument("-o", "--out", required=True, help="the workbook to write (never the input)")

    sp = add("restructure", cmd_restructure, "Insert or delete whole rows or columns, and move every formula, name, "
             "merged range, table, validation, conditional format, filter, print area and frozen pane that points at "
             "them, on every sheet. Charts and pictures aren't moved: the result lists them.",
             "python xlsx_tool.py restructure budget.xlsx --sheet Data --insert-rows 5 --count 2 -o xlsx-work/step1.xlsx")
    sp.add_argument("book")
    op = sp.add_mutually_exclusive_group(required=True)
    op.add_argument("--insert-rows", metavar="ROW", help="insert before this row")
    op.add_argument("--delete-rows", metavar="ROW", help="delete starting at this row")
    op.add_argument("--insert-cols", metavar="COL", help="insert before this column (a letter or a number)")
    op.add_argument("--delete-cols", metavar="COL", help="delete starting at this column")
    sp.add_argument("--count", type=int, default=1, help="how many rows or columns (default 1)")
    sp.add_argument("--sheet", help="the sheet to change (needed when there's more than one)")
    sp.add_argument("-o", "--out", required=True, help="the workbook to write (never the input)")
    return p


def main(argv: list[str] | None = None) -> int:
    utf8_output()
    parser = build_parser()
    args = parser.parse_args(argv)
    if not getattr(args, "func", None):
        parser.error("needs a command, such as info")

    def job() -> int:
        need_openpyxl()  # before any command imports from it, so a missing package is one plain line
        return int(args.func(args))

    try:
        return run_job(f"xlsx_tool.py {args.command}", job)
    finally:
        for wb in MACRO_BOOKS:
            try:
                wb.vba_archive.close()
            except Exception:
                pass


if __name__ == "__main__":
    sys.exit(main())
