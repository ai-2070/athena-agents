#!/usr/bin/env python3
"""Find LibreOffice and run it headless: convert a file, or recalculate a workbook and list its error cells.

    python soffice.py find
    python soffice.py convert report.docx --to pdf -o report.pdf
    python soffice.py recalc model.xlsx -o model-calc.xlsx

Needs only the standard library; `recalc` also needs openpyxl (pip install openpyxl).

Every run uses a throwaway LibreOffice profile (so a LibreOffice the user has open doesn't block it), set to
recalculate every formula on load, inside a scratch folder next to the output that is removed afterwards. The input
is copied into that folder first, so it is never written to or locked.

Stdout carries only the result, as JSON. Exit codes: 0 done (for recalc: no error cells); 1 recalc ran and found
error cells, listed in the JSON; 2 it couldn't do the job, with one line on stderr saying why (no LibreOffice, and how
to install it; a locked file; a conversion that wrote nothing, with what LibreOffice said).
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import NoReturn

INSTALL = (
    "Windows: winget install -e --id TheDocumentFoundation.LibreOffice; macOS: brew install --cask libreoffice; "
    "Linux: sudo apt install libreoffice or sudo dnf install libreoffice; any system: https://www.libreoffice.org/download/"
)

# Excel's error values, as a recalculated .xlsx stores them
ERRORS = ("#NULL!", "#DIV/0!", "#VALUE!", "#REF!", "#NAME?", "#NUM!", "#N/A", "#GETTING_DATA", "#SPILL!", "#CALC!", "#FIELD!", "#BLOCKED!", "#CONNECT!", "#BUSY!", "#UNKNOWN!")

HINTS = {
    "#NAME?": "a misspelt function or name, or a function added after Excel 2007 written without its _xlfn. prefix",
    "#VALUE!": "text where a number belongs; in LibreOffice also a circular reference while iterative calculation is off",
    "#REF!": "a reference to a deleted, moved or out-of-range cell",
    "#DIV/0!": "a division by zero or by an empty cell",
    "#N/A": "a lookup that found nothing",
    "#NUM!": "an impossible number, such as an IRR that doesn't converge",
    "#NULL!": "a space between two ranges where a comma or colon was meant",
}

# Make LibreOffice recalculate spreadsheets on load instead of trusting the values saved in the file.
PROFILE_SETTINGS = """<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<item oor:path="/org.openoffice.Office.Calc/Formula/Load"><prop oor:name="OOXMLRecalcMode" oor:op="fuse"><value>0</value></prop></item>
<item oor:path="/org.openoffice.Office.Calc/Formula/Load"><prop oor:name="ODFRecalcMode" oor:op="fuse"><value>0</value></prop></item>
</oor:items>
"""


class Failure(Exception):
    """The job can't be done: main prints the message as one line on stderr and exits 2."""


def emit(data: dict, code: int) -> NoReturn:
    print(json.dumps(data, indent=2, ensure_ascii=False))
    sys.exit(code)


def fail(command: str, message: str) -> NoReturn:
    print(f"soffice.py {command}: {' '.join(message.split())}", file=sys.stderr)
    sys.exit(2)


def registered_install() -> list[str]:
    """soffice.exe in the folder LibreOffice's Windows installer records (it may be on another drive)."""
    try:
        import winreg
    except ImportError:
        return []
    found = []
    for hive in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
        for key in (r"SOFTWARE\LibreOffice\UNO\InstallPath", r"SOFTWARE\WOW6432Node\LibreOffice\UNO\InstallPath"):
            try:
                with winreg.OpenKey(hive, key) as k:
                    folder = winreg.QueryValueEx(k, "")[0]
            except OSError:
                continue
            if isinstance(folder, str) and folder:
                found.append(os.path.join(folder, "soffice.exe"))
    return found


def known_locations() -> list[str]:
    """Where installers usually put soffice on this OS."""
    if sys.platform == "win32":
        bases = [os.environ.get(k) for k in ("ProgramFiles", "ProgramW6432", "ProgramFiles(x86)")]
        bases += [r"C:\Program Files", r"C:\Program Files (x86)"]
        found: list[str] = registered_install()
        for base in dict.fromkeys(b for b in bases if b):
            found.append(os.path.join(base, "LibreOffice", "program", "soffice.exe"))
            found += sorted(glob.glob(os.path.join(base, "LibreOffice*", "program", "soffice.exe")), reverse=True)
        return list(dict.fromkeys(found))
    if sys.platform == "darwin":
        app = "LibreOffice.app/Contents/MacOS/soffice"
        return [f"/Applications/{app}", os.path.expanduser(f"~/Applications/{app}")]
    return [
        "/usr/bin/soffice",
        "/usr/bin/libreoffice",
        "/usr/local/bin/soffice",
        "/usr/lib/libreoffice/program/soffice",
        "/usr/lib64/libreoffice/program/soffice",
        *sorted(glob.glob("/opt/libreoffice*/program/soffice"), reverse=True),
        "/snap/bin/libreoffice",
    ]


def find_soffice(override: str | None) -> tuple[str, str]:
    """(path, how it was found). --soffice wins, then the SOFFICE variable, then PATH, then the usual folders."""
    for value, how in ((override, "--soffice"), (os.environ.get("SOFFICE"), "SOFFICE")):
        if value:
            path = shutil.which(value) or (value if os.path.isfile(value) else None)
            if not path:
                raise Failure(f"{how} points to {value}, which isn't a program here")
            return path, how
    for name in ("soffice", "libreoffice"):
        path = shutil.which(name)
        if path:
            return path, "PATH"
    looked = known_locations()
    for path in looked:
        if os.path.isfile(path):
            return path, "usual install folder"
    raise Failure(
        "LibreOffice isn't installed, or isn't on PATH or in the usual install folders; if it's somewhere else, pass "
        f"--soffice <path> or set SOFFICE. Installing it is the user's call, so ask them first: {INSTALL}"
    )


def kill_tree(proc: subprocess.Popen) -> None:
    if sys.platform == "win32":
        # /T takes soffice.bin, which soffice.exe starts, with it
        try:
            subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True, timeout=30)
        except (OSError, subprocess.TimeoutExpired):
            proc.kill()
    else:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            proc.kill()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        pass


def same_file(a: Path, b: Path) -> bool:
    if a.exists() and b.exists():
        return os.path.samefile(a, b)
    return os.path.normcase(str(a.resolve())) == os.path.normcase(str(b.resolve()))


def remove_scratch(work: Path) -> None:
    # on Windows a just-killed soffice.bin can hold its profile files for a moment
    for _ in range(5):
        shutil.rmtree(work, ignore_errors=True)
        if not work.exists():
            return
        time.sleep(1)


def run_convert(soffice: str, src: Path, to: str, out: Path, timeout: float) -> tuple[float, list[str]]:
    """Convert src with LibreOffice into out. Returns the seconds it took and any other files LibreOffice wrote."""
    if not src.is_file():
        raise Failure(f"no such file: {src}")
    if same_file(src, out):
        raise Failure("the output would overwrite the input: give -o a different path")
    if out.is_dir():
        raise Failure(f"-o names a folder, not a file: {out}")
    ext = to.split(":", 1)[0].lower()
    to = ext + to[len(ext):]  # LibreOffice knows "pdf" but not "PDF"
    if out.suffix.lower() != f".{ext}":
        raise Failure(f"-o should end in .{ext} to match --to {to}")
    out.parent.mkdir(parents=True, exist_ok=True)

    work = Path(tempfile.mkdtemp(prefix=".soffice-", dir=out.parent))
    try:
        (work / "profile" / "user").mkdir(parents=True)
        (work / "profile" / "user" / "registrymodifications.xcu").write_text(PROFILE_SETTINGS, encoding="utf-8")
        (work / "in").mkdir()
        (work / "out").mkdir()
        copy = work / "in" / src.name
        shutil.copy2(src, copy)
        cmd = [
            soffice,
            f"-env:UserInstallation={(work / 'profile').resolve().as_uri()}",
            "--headless", "--norestore", "--nologo", "--nodefault", "--nolockcheck",
            "--convert-to", to,
            "--outdir", str(work / "out"),
            str(copy),
        ]
        started = time.monotonic()
        extra = {"start_new_session": True} if sys.platform != "win32" else {}
        proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=os.environ.copy(), **extra)
        try:
            stdout, stderr = proc.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            kill_tree(proc)
            raise Failure(f"LibreOffice didn't finish within {timeout:g} seconds (a damaged file, or a dialog it can't show); try --timeout or open the file by hand")
        produced = work / "out" / f"{copy.stem}.{ext}"
        # allow a moment for the file to land after the launcher exits
        settle = min(time.monotonic() + 5, started + timeout)
        while not produced.exists() and time.monotonic() < settle:
            time.sleep(0.25)
        if not produced.exists():
            said = " ".join((stdout + stderr).decode("utf-8", errors="replace").split())
            raise Failure(f"LibreOffice produced no file (it exited {proc.returncode}); it said: {said[-500:] or 'nothing'}")
        os.replace(produced, out)  # same folder tree, so this replaces an older output in one step
        others = sorted(p.name for p in (work / "out").iterdir())
        return round(time.monotonic() - started, 1), others
    finally:
        remove_scratch(work)


def need_openpyxl() -> None:
    try:
        import openpyxl  # noqa: F401
    except ImportError:
        raise Failure("recalc needs openpyxl to read the result: python -m pip install openpyxl") from None


def scan_errors(path: Path, limit: int) -> dict:
    from openpyxl import load_workbook

    try:
        values = load_workbook(path, data_only=True)
        formulas = load_workbook(path)
    except Exception as e:  # openpyxl raises several kinds for files it can't parse
        raise Failure(f"LibreOffice wrote {path}, but openpyxl can't read it to look for errors: {e or type(e).__name__}") from None
    count, errors, tables = 0, [], []
    for ws in formulas.worksheets:
        vs = values[ws.title]
        for row in ws.iter_rows():
            for cell in row:
                text = cell.value
                is_formula = cell.data_type == "f" or (isinstance(text, str) and text.startswith("="))
                count += is_formula
                if isinstance(text, str) and text.upper().startswith(("=TABLE(", "=MULTIPLE.OPERATIONS(")):
                    tables.append(f"{ws.title}!{cell.coordinate}")
                value = vs[cell.coordinate].value
                if vs[cell.coordinate].data_type == "e" or (isinstance(value, str) and value in ERRORS):
                    errors.append({"sheet": ws.title, "cell": cell.coordinate, "error": str(value), "formula": text if isinstance(text, str) else None})
    found = sorted({e["error"] for e in errors})
    report: dict = {"formulas": count, "error_count": len(errors), "errors": errors[:limit]}
    if found:
        report["hints"] = {e: HINTS[e] for e in found if e in HINTS}
    if tables:
        # LibreOffice reads an Excel data table (What-If Analysis) but doesn't calculate it, and saves it broken
        report["warnings"] = [f"{len(tables)} cells from Excel data tables, starting at {tables[0]}: LibreOffice doesn't calculate them, so this copy's values there are wrong or empty"]
    return report


def above_zero(text: str) -> float:
    value = float(text)
    if not value > 0:
        raise argparse.ArgumentTypeError(f"must be more than 0, not {text}")
    return value


def zero_or_more(text: str) -> int:
    value = int(text)
    if value < 0:
        raise argparse.ArgumentTypeError(f"must be 0 or more, not {text}")
    return value


def main() -> None:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")

    where = "path to soffice (otherwise the SOFFICE variable, PATH, then the usual install folders)"
    parser = argparse.ArgumentParser(
        description="Find LibreOffice and run it headless. Prints the result as JSON. Exit 0 done; 1 recalc found error "
        "cells (listed in the JSON); 2 couldn't do it (one line on stderr says why)."
    )
    parser.add_argument("--soffice", help=where)
    # --soffice also works after the command; SUPPRESS keeps an absent one from hiding the one given before it
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--soffice", default=argparse.SUPPRESS, help=where)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("find", parents=[common], help="print where soffice is")
    conv = sub.add_parser("convert", parents=[common], help="convert a document with LibreOffice")
    conv.add_argument("input", type=Path)
    conv.add_argument("--to", required=True, help="target format: an extension such as pdf, docx, xlsx, png, or ext:FilterName")
    conv.add_argument("-o", "--out", "--output", dest="output", required=True, type=Path, help="the file to write (never the input)")
    conv.add_argument("--timeout", type=above_zero, default=180, help="seconds before giving up (default 180)")
    rec = sub.add_parser("recalc", parents=[common], help="recalculate a workbook, save a copy with values, list error cells")
    rec.add_argument("input", type=Path, help="a workbook LibreOffice can open (.xlsx, .xlsm, .xls, .ods)")
    rec.add_argument("-o", "--out", "--output", dest="output", required=True, type=Path, help="the .xlsx to write (never the input)")
    rec.add_argument("--timeout", type=above_zero, default=180, help="seconds before giving up (default 180)")
    rec.add_argument("--limit", type=zero_or_more, default=100, help="list at most this many error cells (default 100; all are counted)")
    args = parser.parse_args()

    try:
        soffice, how = find_soffice(args.soffice)
        if args.command == "find":
            emit({"ok": True, "soffice": soffice, "found_by": how}, 0)
        if args.command == "convert":
            seconds, others = run_convert(soffice, args.input, args.to, args.output, args.timeout)
            result = {"ok": True, "input": str(args.input), "output": str(args.output), "seconds": seconds, "soffice": soffice}
            if others:
                result["not_kept"] = others
                result["note"] = "LibreOffice also wrote these files (pictures for HTML, say); only the output was kept"
            emit(result, 0)
        if args.output.suffix.lower() != ".xlsx":
            raise Failure("recalc writes .xlsx: give -o a path ending in .xlsx")
        need_openpyxl()
        seconds, _ = run_convert(soffice, args.input, "xlsx", args.output, args.timeout)
        report = scan_errors(args.output, args.limit)
        clean = report["error_count"] == 0
        emit({"ok": clean, "input": str(args.input), "output": str(args.output), **report, "seconds": seconds, "soffice": soffice}, 0 if clean else 1)
    except Failure as e:
        fail(args.command, str(e))
    except OSError as e:  # a locked, read-only or missing file or folder
        where = e.filename2 or e.filename  # for the move into place, the second name is the output
        hint = " If the file is open in another program (Excel locks it on Windows), close it and try again." if isinstance(e, PermissionError) else ""
        fail(args.command, f"{e.strerror or e}" + (f": {where}" if where else "") + f".{hint}")


if __name__ == "__main__":
    main()
