#!/usr/bin/env python3
"""Audit a financial model workbook (DCF, LBO, three-statement, comps, merger) against the skill's conventions.

    python check_model.py model-calc.xlsx
    python check_model.py model.xlsx --structure-only        # before recalculating: layout and colours only

Needs openpyxl 3.1 or newer (pip install openpyxl). Run it on the copy `soffice.py recalc` wrote: openpyxl saves
formulas without results, so error values and the Checks sheet can only be read once something has calculated the file.

Fails on:
  error_values            a cell whose result is #REF!, #DIV/0!, #NAME? and the like
  checks_sheet            no Checks sheet, no TRUE/FALSE results on it, or a result that isn't TRUE
  numbers_in_formulas     a number typed into a formula (=B5*1.05) other than the allowed conventions
  typed_value_not_input   a typed number or date whose font isn't the input colour (a pasted result, or an
                          input nobody can spot)
  formula_styled_as_input a formula in the input colour (someone will type over it)
  input_without_source    an input with no comment saying where it came from
  not_calculated          the file has formulas but no results yet (skip with --structure-only)
Warns on:
  source_without_date     a source comment with no year or date in it
  link_not_green          a formula that only fetches a cell from another sheet, not in the link colour

Fonts coloured from the theme palette can't be read as RGB here, so they count as neither input nor link.
Stdout carries only the audit, as JSON. Exit 0 when nothing fails; 1 when something does (the JSON's "failures" say
what and where, "how_to_fix" what to do); 2 when it can't audit at all (no such file, not a workbook, a locked file,
openpyxl missing or older than 3.1), with one line on stderr saying why.
"""

from __future__ import annotations

import argparse
import datetime
import json
import re
import sys
from pathlib import Path
from typing import NoReturn

ALLOWED = (0, 0.5, 1, 2, 4, 12, 100, 360, 365, 1000, 1000000)

# numbers that are a whole argument of these functions pick a row, a quartile, a rounding place or a guess
STRUCTURAL = {
    "INDEX", "MATCH", "XMATCH", "VLOOKUP", "HLOOKUP", "XLOOKUP", "OFFSET", "QUARTILE", "QUARTILE.INC", "QUARTILE.EXC",
    "PERCENTILE", "PERCENTILE.INC", "PERCENTILE.EXC", "LARGE", "SMALL", "RANK", "RANK.EQ", "ROUND", "ROUNDUP",
    "ROUNDDOWN", "EOMONTH", "EDATE", "YEARFRAC", "IRR", "XIRR", "RATE", "SUBTOTAL", "AGGREGATE", "TEXT", "LEFT",
    "RIGHT", "MID",
}

ERRORS = ("#NULL!", "#DIV/0!", "#VALUE!", "#REF!", "#NAME?", "#NUM!", "#N/A", "#GETTING_DATA", "#SPILL!", "#CALC!")

FIXES = {
    "error_values": "trace each error to its first cause; cells further down usually clear with it",
    "checks_sheet": "keep a Checks sheet of labelled TRUE/FALSE ties; a FALSE one means the model doesn't tie: find the break, don't loosen the check",
    "numbers_in_formulas": "move the number into a labelled input cell (input colour, with a source) and refer to it",
    "typed_value_not_input": "if it's a result, write the formula instead; if it's an input, colour it and give it a source",
    "formula_styled_as_input": "give formulas the formula colour (black), or the link colour when they only fetch another sheet",
    "input_without_source": "add a comment: where the number came from and when (document, page or URL, date)",
    "not_calculated": "run: python soffice.py recalc <model.xlsx> -o <model-calc.xlsx>, then check that copy",
}

YEAR = re.compile(r"\b(?:19|20)\d{2}\b")


def rgb_of(font: object) -> str | None:
    """The font colour as six hex digits, or None for the default, theme and unreadable colours."""
    color = getattr(font, "color", None)
    if color is None:
        return None
    kind = getattr(color, "type", None)
    if kind == "rgb" and isinstance(color.rgb, str):
        return color.rgb[-6:].upper()
    if kind == "indexed" and isinstance(color.indexed, int):
        from openpyxl.styles.colors import COLOR_INDEX

        if 0 <= color.indexed < len(COLOR_INDEX):
            return COLOR_INDEX[color.indexed][-6:].upper()
    return None


def formula_text(value: object) -> str | None:
    if isinstance(value, str) and value.startswith("="):
        return value
    text = getattr(value, "text", None)  # an array formula
    return text if isinstance(text, str) and text.startswith("=") else None


def typed_numbers(formula: str, allowed: set[float]) -> list[str]:
    """Numbers typed into a formula, except allowed ones and whole arguments of structural functions."""
    from openpyxl.formula import Tokenizer

    try:
        tokens = [t for t in Tokenizer(formula).items if t.type != "WHITE-SPACE"]
    except Exception:
        return []
    found, stack = [], []
    for i, tok in enumerate(tokens):
        if tok.type == "FUNC" and tok.subtype == "OPEN":
            name = tok.value[:-1].upper()
            for prefix in ("_XLFN.", "_XLWS."):
                name = name[len(prefix):] if name.startswith(prefix) else name
            stack.append(name)
        elif tok.type == "FUNC" and tok.subtype == "CLOSE":
            if stack:
                stack.pop()
        elif tok.type == "OPERAND" and tok.subtype == "NUMBER":
            try:
                number = float(tok.value)
            except ValueError:
                continue
            percent = i + 1 < len(tokens) and tokens[i + 1].type == "OPERATOR-POSTFIX" and tokens[i + 1].value == "%"
            if percent:
                number /= 100
            # a sign belongs to the argument: ROUND(x,-3) rounds to thousands, EDATE(d,-6) goes back six months
            before = i - 2 if i > 1 and tokens[i - 1].type == "OPERATOR-PREFIX" else i - 1
            whole_arg = (
                before >= 0 and i + 1 < len(tokens)
                and (tokens[before].type, tokens[before].subtype) in {("FUNC", "OPEN"), ("SEP", "ARG")}
                and (tokens[i + 1].type, tokens[i + 1].subtype) in {("FUNC", "CLOSE"), ("SEP", "ARG")}
            )
            if whole_arg and stack and stack[-1] in STRUCTURAL:
                continue
            if number in allowed:
                continue
            found.append(tok.value + ("%" if percent else ""))
    return found


def cross_sheet_link(formula: str, sheet: str, names: dict[str, str]) -> bool:
    """True when the formula only fetches one cell or range from another sheet (directly or by a defined name)."""
    from openpyxl.formula import Tokenizer

    try:
        tokens = [t for t in Tokenizer(formula).items if t.type != "WHITE-SPACE"]
    except Exception:
        return False
    if len(tokens) != 1 or tokens[0].type != "OPERAND" or tokens[0].subtype != "RANGE":
        return False
    ref = tokens[0].value
    if "!" in ref:
        return ref.rsplit("!", 1)[0].strip("'").replace("''", "'") != sheet
    target = names.get(ref.upper())
    return target is not None and target != sheet


class Report:
    def __init__(self, limit: int) -> None:
        self.limit = limit
        self.failures: dict[str, dict] = {}
        self.warnings: dict[str, dict] = {}

    def add(self, kind: str, where: str, detail: object, warning: bool = False) -> None:
        bucket = self.warnings if warning else self.failures
        entry = bucket.setdefault(kind, {"count": 0, "cells": []})
        entry["count"] += 1
        if len(entry["cells"]) < self.limit:
            entry["cells"].append({"cell": where, "detail": detail})


def audit(path: Path, args: argparse.Namespace) -> dict:
    from openpyxl import load_workbook

    formulas = load_workbook(path)
    values = None if args.structure_only else load_workbook(path, data_only=True)
    allowed = {float(x) for x in ALLOWED} | {float(x) for x in args.allow}
    inputs = {c.upper()[-6:] for c in args.input_color}
    links = {c.upper()[-6:] for c in args.link_color}
    skip = {s.lower() for s in args.ignore_sheet}
    names: dict[str, str] = {}
    for name, dn in formulas.defined_names.items():
        for sheet, _ in dn.destinations:
            names[name.upper()] = sheet
            break

    report = Report(args.limit)
    counts = {"formulas": 0, "with_results": 0, "typed_values": 0, "inputs": 0, "checks_true": 0}

    for ws in formulas.worksheets:
        if ws.title.lower() in skip:
            continue
        vs = values[ws.title] if values is not None else None
        for row in ws.iter_rows():
            for cell in row:
                raw = cell.value
                if raw is None:
                    continue
                where = f"{ws.title}!{cell.coordinate}"
                color = rgb_of(cell.font)
                formula = formula_text(raw)
                result = vs[cell.coordinate] if vs is not None else None
                if formula is not None or cell.data_type == "f":
                    counts["formulas"] += 1
                    if result is not None and result.value is not None:
                        counts["with_results"] += 1
                    if formula is None:
                        continue  # a data table: nothing to read
                    numbers = typed_numbers(formula, allowed)
                    if numbers:
                        report.add("numbers_in_formulas", where, {"formula": formula, "numbers": numbers})
                    if color in inputs:
                        report.add("formula_styled_as_input", where, formula)
                    elif cross_sheet_link(formula, ws.title, names) and color not in links:
                        report.add("link_not_green", where, formula, warning=True)
                elif isinstance(raw, (int, float, datetime.date, datetime.time)) and not isinstance(raw, bool):
                    counts["typed_values"] += 1
                    shown = raw.isoformat() if isinstance(raw, (datetime.date, datetime.time)) else raw
                    if color not in inputs:
                        report.add("typed_value_not_input", where, shown)
                        continue
                    counts["inputs"] += 1
                    note = cell.comment.text.strip() if cell.comment and cell.comment.text else ""
                    if not note:
                        report.add("input_without_source", where, shown)
                    elif not YEAR.search(note):
                        report.add("source_without_date", where, note[:120], warning=True)
                if result is not None and (result.data_type == "e" or (isinstance(result.value, str) and result.value in ERRORS)):
                    report.add("error_values", where, {"error": result.value, "formula": formula})

    skipped = []
    calculated = None
    if values is None:
        skipped = ["error_values", "checks_sheet (results)"]
    else:
        calculated = counts["formulas"] == 0 or counts["with_results"] > 0
        if not calculated:
            report.add("not_calculated", path.name, f"{counts['formulas']} formulas and no results")

    sheet = next((ws for ws in formulas.worksheets if ws.title.lower() == args.checks_sheet.lower()), None)
    if sheet is None:
        report.add("checks_sheet", args.checks_sheet, f"no sheet named {args.checks_sheet}")
    elif values is not None and calculated:
        found = 0
        for row in values[sheet.title].iter_rows():
            for cell in row:
                if formula_text(sheet[cell.coordinate].value) is None:
                    continue
                if cell.value is True:
                    found += 1
                    counts["checks_true"] += 1
                elif cell.value is False or cell.data_type == "e":
                    found += 1
                    label = next((c.value for c in sheet[cell.row] if isinstance(c.value, str) and not c.value.startswith("=")), None)
                    report.add("checks_sheet", f"{sheet.title}!{cell.coordinate}", {"result": cell.value, "label": label, "formula": sheet[cell.coordinate].value})
        if found == 0:
            report.add("checks_sheet", sheet.title, "no formula on it gives TRUE or FALSE")

    out = {
        "file": str(path),
        "ok": not report.failures,
        "calculated": calculated,
        "counts": counts,
        "failures": report.failures,
        "warnings": report.warnings,
    }
    if report.failures:
        out["how_to_fix"] = {k: FIXES[k] for k in report.failures if k in FIXES}
    if skipped:
        out["skipped"] = skipped
    return out


def colour(text: str) -> str:
    value = text.strip().lstrip("#").upper()
    if not re.fullmatch(r"(?:[0-9A-F]{2})?[0-9A-F]{6}", value):
        raise argparse.ArgumentTypeError(f"write a colour as six hex digits, like 0000FF, not {text}")
    return value


def zero_or_more(text: str) -> int:
    value = int(text)
    if value < 0:
        raise argparse.ArgumentTypeError(f"must be 0 or more, not {text}")
    return value


def fail(message: str) -> NoReturn:
    print(f"check_model.py: {' '.join(message.split())}", file=sys.stderr)
    sys.exit(2)


def main() -> None:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(
        description="Audit a financial model workbook: error cells, the Checks sheet, numbers typed into formulas, "
        "input colours and source comments. Prints the audit as JSON. Exit 0 nothing fails; 1 something fails (listed "
        "in the JSON); 2 can't audit the file (one line on stderr says why).",
        epilog="Allowed numbers inside formulas by default: " + ", ".join(str(x) for x in ALLOWED),
    )
    parser.add_argument("workbook", type=Path, help="the .xlsx or .xlsm, ideally the copy soffice.py recalc wrote")
    parser.add_argument("--checks-sheet", default="Checks", help="the sheet of TRUE/FALSE checks (default Checks)")
    parser.add_argument("--input-color", action="append", default=[], type=colour, help="RGB hex of the input font (default 0000FF; repeat for more)")
    parser.add_argument("--link-color", action="append", default=[], type=colour, help="RGB hex of the cross-sheet link font (default 008000; repeat for more)")
    parser.add_argument("--allow", action="append", default=[], type=float, help="another number allowed inside formulas (repeatable)")
    parser.add_argument("--ignore-sheet", action="append", default=[], help="a sheet to leave out, such as raw pasted data (repeatable)")
    parser.add_argument("--structure-only", action="store_true", help="don't read results: for a file nothing has calculated yet")
    parser.add_argument("--limit", type=zero_or_more, default=25, help="list at most this many cells per finding (default 25; all are counted)")
    args = parser.parse_args()
    args.input_color = args.input_color or ["0000FF"]
    args.link_color = args.link_color or ["008000"]

    try:
        import openpyxl
    except ImportError:
        fail("needs openpyxl 3.1 or newer: python -m pip install openpyxl")
    if tuple(int(p) for p in re.findall(r"\d+", openpyxl.__version__)[:2]) < (3, 1):
        # 3.1 changed how defined names are read
        fail(f"needs openpyxl 3.1 or newer (this is {openpyxl.__version__}): python -m pip install --upgrade openpyxl")
    if args.workbook.is_dir():
        fail(f"{args.workbook} is a folder, not a workbook")
    if not args.workbook.is_file():
        fail(f"no such file: {args.workbook}")
    try:
        result = audit(args.workbook, args)
    except PermissionError:
        fail(f"couldn't open {args.workbook}: permission denied. If it's open in another program (Excel locks it on "
             "Windows), close it and try again.")
    except Exception as e:  # a damaged or non-Excel file
        fail(f"couldn't read {args.workbook}: {e or type(e).__name__}")
    print(json.dumps(result, indent=2, ensure_ascii=False, default=str))
    sys.exit(0 if result["ok"] else 1)


if __name__ == "__main__":
    main()
