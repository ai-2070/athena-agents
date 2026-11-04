#!/usr/bin/env python3
"""Make a PowerPoint deck, or change one, from a JSON plan of steps: new, edit.

    python pptx_deck.py new plan.json -o deck.pptx                         a deck on a plain 16:9 or 4:3 design
    python pptx_deck.py new plan.json -o deck.pptx --template brand.potx   slides from a template's layouts
    python pptx_deck.py edit deck.pptx plan.json -o deck-v2.pptx           change a deck, or fill one in

Packages: python-pptx 1.0 or newer (it brings lxml, Pillow and XlsxWriter).

The plan is a UTF-8 JSON file; paths in it are relative to its folder:
  {"size": "16:9",                      new without --template: "16:9" (default), "4:3" or [width, height] in inches
   "properties": {"title": "...", "author": "...", "subject": "...", "keywords": "..."},
   "steps": [{"do": "add", ...}, ...]}  run in order; a bare list of steps works too

Slide numbers in a step count from 1 and mean the deck as it stands when that step runs. "slides" takes a list like
"1-3,7,10-" (default: every slide). "shape" is a shape's id (a number) or its name, as pptx_tool.py outline lists them.
Positions and sizes are inches, or text such as "2.5cm", "30mm", "72pt".

Steps:
  add           a slide from a layout: "layout" (name or number, as pptx_tool.py info lists them), "master" (when
                names repeat), "title", "subtitle", "body" (the first body or content placeholder), "placeholders"
                ({"<idx>": content}), "shapes" ([shape, ...]), "notes", "hidden", "at" (its number afterwards; default
                the end), "keep_empty" (keep placeholders left empty; default false: they are deleted)
  text          "slide", "shape", "text": the shape's text, keeping its look; "cell": [row, column] for a table cell
  table         "slide", "shape", "rows": every cell of a table, keeping its look; rows are added or removed at the
                end, the number of columns stays
  replace       "find", "with", "slides", "notes" (default true), "layouts" (masters and layouts too; default false),
                "match_case" (default true). Finds text split across runs; never across a line break
  fill          "values": {"client": "Globex"} puts each value in place of {{client}}; "slides", "notes", "layouts"
  notes         "slide" (or "slides": the same text on each), "text" ("" empties them), "append" (default false)
  chart         "slide", "shape" (needed when the slide has several charts), then either the whole data:
                "categories" and "series" ({"name": [values]}; for x-y charts {"name": [[x, y], ...]}), or changes:
                "set" ({"name": [values]} or {"name": {"category": value}}), "add" ({"name": [values]}),
                "remove" (["name"]), "rename" ({"old category": "new"}); and "title" ("" removes it), "colors"
                ({"name": "#hex"}). An added series takes the theme's next colour
  picture       "slide", "shape", "path", "alt": a new picture in a picture's frame (cropped to fill it, centred),
                or in an empty placeholder
  add_shapes    "slide", "shapes": [shape, ...]
  delete_shape  "slide", "shape"
  delete        "slides"
  move          "slides" (one, or a run kept in order), "to": the number the first of them has afterwards
  duplicate     "slide", "to" (default: right after it). Refuses slides with charts, SmartArt or embedded files
  hide          "slides", "hidden" (default true; false shows them again)
  footer        "slides", "text", "number" (true or false), "date" (text): copies the layout's footer, slide number
                and date placeholders onto the slides; "" or false takes them off

Content (title, subtitle, body, placeholders, text, notes, a text shape): a string ("\\n" starts a paragraph); or a list
of paragraphs, each a string ("\\n" breaks the line) or {"text": ..., "level": 0-8, "bold", "italic", "underline",
"size" (points), "color" ("#1F4E79"), "font", "link" (https:// or mailto:), "align" (left, center, right, justify)},
or {"runs": [{"text": ..., "bold": true, ...}, ...], "level": ...}. A placeholder also takes {"picture": "photo.jpg",
"alt": "..."}, {"chart": chart} or {"table": table}. Text keeps the layout's or the shape's look unless a paragraph
says otherwise.

Shapes: {"type": "text", "x", "y", "w", "h", "text", "size", "bold", "italic", "color", "font", "align"};
{"type": "picture", "path", "x", "y", "w" and/or "h" (fits inside, keeping its proportions), "alt"};
{"type": "chart", "chart": chart, "x", "y", "w", "h"}; {"type": "table", "table": table, "x", "y", "w", "h" (optional)};
{"type": "box", "shape": "rectangle" | "rounded" | "oval", "fill": "#hex" | "none", "line": "#hex" | "none", "x", "y",
"w", "h", "text", "size", "bold", "italic", "color", "font", "align"}. Any shape takes "name".
Chart: {"type": "column", "categories": [...], "series": {"name": [numbers or null]}, "title", "number_format" ("0%",
"#,##0"), "legend" ("bottom", "right", "top", "left" or false), "labels" (true shows the values), "font_size",
"colors" (["#hex", ...]: one per series, or per slice for pie and doughnut)}. Types: column, column_stacked,
column_stacked_100, bar, bar_stacked, bar_stacked_100, line, line_markers, pie, doughnut, area, area_stacked, scatter.
Table: {"rows": [[...], ...], "header": true, "widths": [3, 1, 1] (shares of the width), "font_size"}.

The result is printed on stdout as JSON. Exit codes: 0 done; 1 the deck was written but a step found problems (a find
that matched nothing, {{tokens}} with no value, a layout without a footer placeholder), listed in "problems"; 2 it
couldn't do the job, one line on stderr says why, and nothing was written. It won't write over its input or a file
the plan uses unless given --overwrite.
"""

from __future__ import annotations

import argparse
import codecs
import copy
import datetime
import importlib
import io
import json
import locale
import logging
import os
import random
import re
import sys
import tempfile
import zipfile
from typing import Any, Callable, Iterator, NoReturn


# ---------------------------------------------------------------- shared helpers
# pptx_tool.py and pptx_deck.py each stand alone, so the helpers they share are copies, kept identical (the tests
# check): change one, change both.


def utf8_output() -> None:
    # A Windows pipe is cp1252 unless the script says otherwise; slide text and file names often aren't.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
        except (AttributeError, ValueError):
            pass


class Fail(Exception):
    """A problem to report in one line and exit 2."""


def need(module: str, package: str, purpose: str = "") -> Any:
    try:
        mod = importlib.import_module(module)
    except ImportError:
        why = f" {purpose}" if purpose else ""
        raise Fail(f"needs the Python package {package}{why}: python -m pip install {package}") from None
    if module == "pptx" and int(str(getattr(mod, "__version__", "0")).split(".")[0]) < 1:
        raise Fail(f"needs python-pptx 1.0 or newer (this is {mod.__version__}): python -m pip install --upgrade python-pptx")
    return mod


# What a result also says, gathered while the command runs: an input read in an encoding other than UTF-8, and
# warnings the libraries logged.
NOTES: dict[str, Any] = {}


def emit(data: dict[str, Any]) -> None:
    """Print the result on stdout as JSON, with the notes gathered on the way."""
    for key, value in NOTES.items():
        data.setdefault(key, value)
    print(json.dumps(data, ensure_ascii=False, indent=2))


class LibraryWarnings(logging.Handler):
    """Puts what the libraries and Python's warnings log into the result, and keeps it off stderr, which carries only
    the one line saying why a command failed."""

    def __init__(self) -> None:
        super().__init__(logging.WARNING)

    def emit(self, record: logging.LogRecord) -> None:
        message = " ".join(record.getMessage().split())
        found = NOTES.setdefault("library_warnings", [])
        if message not in found:
            found.append(message)


class Parser(argparse.ArgumentParser):
    """argparse, reporting a mistake in the command line in one line with exit code 2, like any other failure."""

    def error(self, message: str) -> NoReturn:
        self.exit(2, f"{self.prog}: {message} (see --help)\n")


def run_job(prog: str, job: Callable[[], int]) -> int:
    """Run a command, and turn whatever stops it into one line on stderr and exit code 2, never a traceback. The job
    returns 0, or 1 when it ran and found problems (which its printed result lists)."""
    logging.getLogger().addHandler(LibraryWarnings())
    logging.captureWarnings(True)
    try:
        return job()
    except Fail as e:
        why = str(e)
    except OSError as e:  # a file open in PowerPoint on Windows, a full disk, a folder where a file should go
        where = e.filename2 or e.filename  # for a move into place, the second name is the output
        why = f"{e.strerror or e}" + (f": {where}" if where else "")
        if isinstance(e, PermissionError):
            why += " (if the file is open in PowerPoint, close it and try again)"
    except Exception as e:  # a damaged file can fail deep inside a library
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


def same_file(a: str, b: str) -> bool:
    if os.path.exists(a) and os.path.exists(b):
        return os.path.samefile(a, b)
    return os.path.normcase(os.path.realpath(a)) == os.path.normcase(os.path.realpath(b))


def write_atomic(out: str, write: Callable[[Any], None]) -> None:
    """Write to a temporary file beside the output, then move it into place, so a failure leaves no half file."""
    folder = os.path.dirname(os.path.abspath(out))
    script = os.path.splitext(os.path.basename(__file__))[0]
    fd, tmp = tempfile.mkstemp(prefix=f".{script}-", suffix=".part", dir=folder)
    try:
        with os.fdopen(fd, "wb") as fh:
            write(fh)
        mask = os.umask(0)
        os.umask(mask)
        os.chmod(tmp, 0o666 & ~mask)  # a temporary file is private to its owner; the result gets the usual rights
        os.replace(tmp, out)
    except BaseException:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise


# The main part's content type says what kind of PowerPoint file it is. python-pptx opens only presentations, so a
# template or a slide show is read with its content type changed to the presentation one (saved, it is a .pptx).
MAIN_TYPES = {
    "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml": "pptx",
    "application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml": "pptm",
    "application/vnd.openxmlformats-officedocument.presentationml.template.main+xml": "potx",
    "application/vnd.ms-powerpoint.template.macroEnabled.main+xml": "potm",
    "application/vnd.openxmlformats-officedocument.presentationml.slideshow.main+xml": "ppsx",
    "application/vnd.ms-powerpoint.slideshow.macroEnabled.main+xml": "ppsm",
}
MACRO_KINDS = ("pptm", "potm", "ppsm")


def open_deck(path: str) -> tuple[Any, str]:
    """(python-pptx Presentation, kind such as "pptx" or "potx") for a PowerPoint file, or a one-line reason."""
    pptx = need("pptx", "python-pptx")
    if not os.path.isfile(path):
        raise Fail(f"no such file: {path}")
    with open(path, "rb") as fh:
        data = fh.read()
    if data[:4] == b"\xd0\xcf\x11\xe0":  # an OLE compound file: a password-protected deck, or an old binary .ppt
        if "EncryptedPackage".encode("utf-16-le") in data:
            raise Fail(f"{path} is password-protected: ask the user for a copy saved without a password")
        raise Fail(f"{path} is an old binary PowerPoint file (.ppt): convert it first with "
                   f"python soffice.py convert \"{os.path.basename(path)}\" --to pptx -o <new name>.pptx")
    try:
        package = zipfile.ZipFile(io.BytesIO(data))
        types = package.read("[Content_Types].xml").decode("utf-8", "replace")
    except (zipfile.BadZipFile, KeyError):
        raise Fail(f"{path} isn't a PowerPoint file (it isn't an Office package)") from None
    found = re.search(r'PartName="/ppt/presentation\.xml"\s+ContentType="([^"]+)"', types) or \
        re.search(r'ContentType="([^"]+)"\s+PartName="/ppt/presentation\.xml"', types)
    kind = MAIN_TYPES.get(found.group(1)) if found else None
    if kind is None:
        raise Fail(f"{path} isn't a PowerPoint presentation (Word and Excel files have their own skills)")
    if kind not in ("pptx", "pptm"):
        want = "application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml" if kind in MACRO_KINDS else \
            "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"
        patched = io.BytesIO()
        with zipfile.ZipFile(patched, "w", zipfile.ZIP_DEFLATED) as out:
            for item in package.infolist():
                body = package.read(item.filename)
                if item.filename == "[Content_Types].xml":
                    body = types.replace(found.group(1), want).encode("utf-8")
                out.writestr(item, body)
        patched.seek(0)
        source: Any = patched
    else:
        source = io.BytesIO(data)
    try:
        return pptx.Presentation(source), kind
    except Exception as e:  # python-pptx raises several kinds for damaged packages
        raise Fail(f"{path} can't be read as a deck ({type(e).__name__}: {e})") from None


def parse_slides(spec: Any, count: int) -> list[int]:
    """'1-3,7,10-' -> [1, 2, 3, 7, 10, ..., count]; a number or a list of numbers works too. Slides count from 1,
    '-3' is slides 1 to 3, and a range written high-low runs backwards. No list means every slide."""
    if spec is None or (isinstance(spec, str) and not spec.strip()):
        return list(range(1, count + 1))
    if isinstance(spec, bool):
        raise Fail(f"can't read the slide list {spec!r}: write it like 1-3,7,10-")
    if isinstance(spec, int):
        spec = str(spec)
    if isinstance(spec, list):
        if not all(isinstance(n, int) and not isinstance(n, bool) for n in spec):
            raise Fail(f"can't read the slide list {spec!r}: a list holds slide numbers, like [1, 3]")
        spec = ",".join(str(n) for n in spec)
    if not isinstance(spec, str):
        raise Fail(f"can't read the slide list {spec!r}: write it like 1-3,7,10-")
    slides: list[int] = []
    for part in spec.replace(" ", "").split(","):
        if not part:
            continue
        m = re.fullmatch(r"(\d*)-(\d*)|(\d+)", part)
        if not m or part == "-":
            raise Fail(f"can't read the slide list {spec!r}: write it like 1-3,7,10-")
        if m.group(3):
            start = end = int(m.group(3))
        else:
            start = int(m.group(1)) if m.group(1) else 1
            end = int(m.group(2)) if m.group(2) else count
        for n in (start, end):
            if n < 1:
                raise Fail("slides are numbered from 1")
            if n > count:
                raise Fail(f"slide {n} is past the end: the deck has {count} slide{'s' if count != 1 else ''}")
        step = 1 if end >= start else -1
        slides.extend(range(start, end + step, step))
    if not slides:
        raise Fail(f"can't read the slide list {spec!r}: write it like 1-3,7,10-")
    return slides


EMU_PER_INCH = 914400
NS = {
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "mc": "http://schemas.openxmlformats.org/markup-compatibility/2006",
    "dgm": "http://schemas.openxmlformats.org/drawingml/2006/diagram",
}
TOKEN = re.compile(r"\{\{\s*([^{}]+?)\s*\}\}")


def q(tag: str) -> str:
    """'a:p' -> '{namespace}p'."""
    prefix, name = tag.split(":")
    return f"{{{NS[prefix]}}}{name}"


def iter_shapes(shapes: Any, group: str = "", tf: tuple[float, float, float, float] = (0.0, 1.0, 0.0, 1.0)) -> Iterator[tuple[Any, Any, str]]:
    """(shape, (x, y, w, h) on the slide in EMU or None, name of the group it's in) for each shape, groups opened.
    A shape in a group has its position in the group's own units; tf maps them onto the slide."""
    ax, bx, ay, by = tf
    for shape in shapes:
        try:
            x, y, w, h = shape.left, shape.top, shape.width, shape.height
            box = None if None in (x, y, w, h) else (ax + bx * x, ay + by * y, bx * w, by * h)
        except Exception:
            box = None
        yield shape, box, group
        if shape._element.tag == q("p:grpSp"):
            xfrm = shape._element.find(f"{q('p:grpSpPr')}/{q('a:xfrm')}")
            inner = tf
            if xfrm is not None:
                off, ext = xfrm.find(q("a:off")), xfrm.find(q("a:ext"))
                choff, chext = xfrm.find(q("a:chOff")), xfrm.find(q("a:chExt"))
                if None not in (off, ext, choff, chext):
                    kx = int(ext.get("cx")) / int(chext.get("cx")) if int(chext.get("cx")) else 1.0
                    ky = int(ext.get("cy")) / int(chext.get("cy")) if int(chext.get("cy")) else 1.0
                    inner = (ax + bx * (int(off.get("x")) - kx * int(choff.get("x"))), bx * kx,
                             ay + by * (int(off.get("y")) - ky * int(choff.get("y"))), by * ky)
            yield from iter_shapes(shape.shapes, shape.name if not group else f"{group} > {shape.name}", inner)


# ---------------------------------------------------------------- reading the plan


def load_json(path: str) -> Any:
    try:
        with open(path, "rb") as fh:
            return json.loads(decode(fh.read(), path))
    except FileNotFoundError:
        raise Fail(f"no such file: {path}") from None
    except json.JSONDecodeError as e:
        raise Fail(f"{path} isn't valid JSON: {e}") from None


class Plan:
    """The plan file, with the folder its paths are relative to."""

    def __init__(self, path: str) -> None:
        data = load_json(path)
        if isinstance(data, list):
            data = {"steps": data}
        if not isinstance(data, dict) or not isinstance(data.get("steps", []), list):
            raise Fail('the plan is a JSON object with a "steps" list (or the list on its own)')
        unknown = sorted(set(data) - {"size", "properties", "steps"})
        if unknown:
            raise Fail(f"the plan has {', '.join(unknown)}, which it doesn't use: it takes size, properties and steps")
        self.data = data
        self.base = os.path.dirname(os.path.abspath(path))
        self.steps: list[Any] = data.get("steps", [])

    def path(self, value: Any, where: str) -> str:
        if not isinstance(value, str) or not value:
            raise Fail(f"{where}: give a file path")
        full = value if os.path.isabs(value) else os.path.join(self.base, value)
        if not os.path.isfile(full):
            raise Fail(f"{where}: no file at {full}")
        return full

    def files(self) -> list[str]:
        """Every file the plan uses, so the output can't overwrite one."""
        found: list[str] = []

        def walk(value: Any) -> None:
            if isinstance(value, dict):
                for key, inner in value.items():
                    if key in ("path", "picture") and isinstance(inner, str):
                        found.append(inner if os.path.isabs(inner) else os.path.join(self.base, inner))
                    else:
                        walk(inner)
            elif isinstance(value, list):
                for inner in value:
                    walk(inner)

        walk(self.steps)
        return found


STEP_KEYS = {
    "add": {"layout", "master", "title", "subtitle", "body", "placeholders", "shapes", "notes", "hidden", "at", "keep_empty"},
    "text": {"slide", "shape", "text", "cell"},
    "table": {"slide", "shape", "rows"},
    "replace": {"find", "with", "slides", "notes", "layouts", "match_case"},
    "fill": {"values", "slides", "notes", "layouts"},
    "notes": {"slide", "slides", "text", "append"},
    "chart": {"slide", "shape", "categories", "series", "set", "add", "remove", "rename", "title", "colors"},
    "picture": {"slide", "shape", "path", "alt"},
    "add_shapes": {"slide", "shapes"},
    "delete_shape": {"slide", "shape"},
    "delete": {"slides"},
    "move": {"slides", "to"},
    "duplicate": {"slide", "to"},
    "hide": {"slides", "hidden"},
    "footer": {"slides", "text", "number", "date"},
}


def number(value: Any, where: str, low: float | None = None, high: float | None = None) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise Fail(f"{where}: give a number, not {value!r}")
    if (low is not None and value < low) or (high is not None and value > high):
        span = f"from {low:g}" + (f" to {high:g}" if high is not None else " up")
        raise Fail(f"{where}: {value!r} is out of range ({span})")
    return float(value)


def whole(value: Any, where: str, low: int = 1) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise Fail(f"{where}: give a whole number, not {value!r}")
    if value < low:
        raise Fail(f"{where}: {value} is below {low}")
    return value


UNITS = {"in": 914400, "cm": 360000, "mm": 36000, "pt": 12700, "": 914400}


def length(value: Any, where: str, positive: bool = False) -> int:
    """A position or size in EMU, from inches or text like '2.5cm'."""
    if isinstance(value, str):
        m = re.fullmatch(r"\s*(-?\d+(?:\.\d+)?)\s*(in|cm|mm|pt)?\s*", value)
        if not m:
            raise Fail(f"{where}: can't read {value!r} as a length: write inches (2.5) or text like \"6cm\", \"30mm\", \"72pt\"")
        emu = float(m.group(1)) * UNITS[m.group(2) or ""]
    else:
        emu = number(value, where) * UNITS["in"]
    if positive and emu <= 0:
        raise Fail(f"{where}: a size is above 0")
    if abs(emu) > 56 * UNITS["in"]:  # PowerPoint's largest slide is 56 inches across
        raise Fail(f"{where}: {value!r} is larger than any slide")
    return int(round(emu))


def color(value: Any, where: str) -> Any:
    from pptx.dml.color import RGBColor

    if not isinstance(value, str) or not re.fullmatch(r"#?[0-9A-Fa-f]{6}", value):
        raise Fail(f"{where}: a colour is written like \"#1F4E79\", not {value!r}")
    return RGBColor.from_string(value.lstrip("#").upper())


# ---------------------------------------------------------------- finding slides and shapes


def slide_at(prs: Any, value: Any, where: str) -> Any:
    count = len(prs.slides)
    n = whole(value, f"{where}: slide")
    if n > count:
        raise Fail(f"{where}: slide {n} is past the end: the deck has {count} slide{'s' if count != 1 else ''}")
    return prs.slides[n - 1]


def shape_on(slide: Any, ref: Any, where: str) -> Any:
    if ref is None:
        raise Fail(f'{where}: say which shape with "shape": its id or name, as pptx_tool.py outline lists them')
    found = []
    for shape, _, _ in iter_shapes(slide.shapes):
        if (isinstance(ref, int) and not isinstance(ref, bool) and shape.shape_id == ref) or (isinstance(ref, str) and shape.name == ref):
            found.append(shape)
    if not found:
        raise Fail(f"{where}: no shape {ref!r} on the slide; pptx_tool.py outline lists them with their ids")
    if len(found) > 1:
        raise Fail(f"{where}: {len(found)} shapes are called {ref!r} (ids {', '.join(str(s.shape_id) for s in found)}): give the id")
    return found[0]


def ph_type(shape: Any) -> str | None:
    if not getattr(shape, "is_placeholder", False):
        return None
    try:
        return shape.placeholder_format.type.name
    except Exception:
        return "OBJECT"


def renumber(prs: Any) -> None:
    """Name slide parts slide1.xml, slide2.xml... in order: python-pptx names a new slide after the count, which can
    clash with an existing name once slides have been deleted."""
    prs.part.rename_slide_parts([sld.rId for sld in prs.slides._sldIdLst])


def used_rids(part: Any) -> set[str]:
    return {v for el in part._element.iter() for k, v in el.attrib.items() if k.startswith(f"{{{NS['r']}}}")}


def drop_unused(part: Any, rids: set[str]) -> None:
    """Remove relationships nothing in the part points to any more (a replaced picture, a deleted chart)."""
    left = used_rids(part)
    for rid in rids:
        if rid not in left and rid in part.rels:
            part.rels.pop(rid)


# ---------------------------------------------------------------- sections


P14 = "http://schemas.microsoft.com/office/powerpoint/2010/main"


def section_forget(prs: Any, sid: str) -> None:
    for el in [e for e in prs.part._element.iter(f"{{{P14}}}sldId") if e.get("id") == sid]:
        el.getparent().remove(el)


def section_place(prs: Any, sid: str, after: str | None) -> None:
    """Keep the deck's sections (if it has any) in step with the slide order: the slide joins the section of the
    slide before it, or the first section."""
    from lxml import etree

    found = list(prs.part._element.iter(f"{{{P14}}}section"))
    if not found:
        return
    section_forget(prs, sid)
    new = etree.Element(f"{{{P14}}}sldId", id=sid)
    if after is not None:
        for el in prs.part._element.iter(f"{{{P14}}}sldId"):
            if el.get("id") == after:
                el.addnext(new)
                return
    lst = found[0].find(f"{{{P14}}}sldIdLst")
    if lst is None:
        lst = etree.SubElement(found[0], f"{{{P14}}}sldIdLst")
    lst.insert(0, new)


def place_in_sections(prs: Any, sld: Any) -> None:
    prev = sld.getprevious()
    section_place(prs, sld.get("id"), prev.get("id") if prev is not None else None)


# ---------------------------------------------------------------- writing text


PARA_KEYS = {"text", "runs", "level", "bold", "italic", "underline", "size", "color", "font", "link", "align"}
RUN_KEYS = {"text", "bold", "italic", "underline", "size", "color", "font", "link"}
NON_VISUAL = {"lang", "altLang", "dirty", "err", "smtClean", "smtId", "noProof", "bmk"}


def paragraphs(value: Any, where: str, defaults: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    """Content as a list of {"runs": [...], "level", "align"}; defaults are formatting a whole shape asks for."""
    if value is None:
        value = ""
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        value = str(value)
    if isinstance(value, str):
        items: list[Any] = value.replace("\r\n", "\n").split("\n")
    elif isinstance(value, list):
        items = value
    else:
        raise Fail(f"{where}: text is a string or a list of paragraphs")
    out = []
    for i, item in enumerate(items, 1):
        at = f"{where}, paragraph {i}"
        if isinstance(item, (int, float)) and not isinstance(item, bool):
            item = str(item)
        if isinstance(item, str):
            item = {"text": item}
        if not isinstance(item, dict):
            raise Fail(f"{at}: a paragraph is a string or an object with \"text\" or \"runs\"")
        unknown = sorted(set(item) - PARA_KEYS)
        if unknown:
            raise Fail(f"{at}: doesn't take {', '.join(unknown)}; a paragraph takes {', '.join(sorted(PARA_KEYS))}")
        style = {k: v for k, v in (defaults or {}).items() if k in RUN_KEYS}
        style.update({k: v for k, v in item.items() if k in RUN_KEYS and k != "text"})
        if "runs" in item:
            if not isinstance(item["runs"], list) or not item["runs"]:
                raise Fail(f"{at}: \"runs\" is a list of {{\"text\": ...}} objects")
            runs = []
            for run in item["runs"]:
                if isinstance(run, str):
                    run = {"text": run}
                if not isinstance(run, dict) or set(run) - RUN_KEYS:
                    raise Fail(f"{at}: a run is {{\"text\": ...}} with any of {', '.join(sorted(RUN_KEYS - {'text'}))}")
                runs.append({**style, **run})
        else:
            runs = [{**style, "text": item.get("text", "")}]
        para: dict[str, Any] = {"runs": runs}
        if "level" in item:
            para["level"] = whole(item["level"], f"{at}: level", 0)
            if para["level"] > 8:
                raise Fail(f"{at}: level runs from 0 to 8")
        align = item.get("align", (defaults or {}).get("align"))
        if align is not None:
            if align not in ("left", "center", "right", "justify"):
                raise Fail(f"{at}: align is left, center, right or justify")
            para["align"] = align
        out.append(para)
    return out


def apply_style(run: Any, spec: dict[str, Any], where: str) -> None:
    from pptx.util import Pt

    font = run.font
    for key in ("bold", "italic", "underline"):
        if key in spec:
            if not isinstance(spec[key], bool):
                raise Fail(f"{where}: {key} is true or false")
            setattr(font, key, spec[key])
    if "size" in spec:
        font.size = Pt(number(spec["size"], f"{where}: size", 1, 4000))
    if "color" in spec:
        font.color.rgb = color(spec["color"], f"{where}: color")
    if "font" in spec:
        if not isinstance(spec["font"], str) or not spec["font"].strip():
            raise Fail(f"{where}: font is a font's name, like \"Arial\"")
        font.name = spec["font"]
    if "link" in spec:
        link = spec["link"]
        if not isinstance(link, str) or not re.match(r"(https?://|mailto:)", link, re.I):
            raise Fail(f"{where}: a link starts with https://, http:// or mailto:")
        run.hyperlink.address = link


def clean_rpr(rpr: Any) -> Any:
    """A copy of a run's formatting without spell-check marks, to give a new run the look of an old one."""
    rpr = copy.deepcopy(rpr)
    for key in ("err", "dirty", "smtClean", "smtId"):
        rpr.attrib.pop(key, None)
    for link in rpr.findall(q("a:hlinkClick")) + rpr.findall(q("a:hlinkMouseOver")):
        rpr.remove(link)
    return rpr


def write_text(frame: Any, items: list[dict[str, Any]], where: str, append: bool = False) -> None:
    """Put paragraphs into a python-pptx text frame. Each new paragraph copies the look (bullets, indent, font) of the
    old paragraph in its place, or of the first old one at its level, or of the last one."""
    from pptx.enum.text import PP_ALIGN
    from pptx.text.text import _Paragraph

    body = frame._txBody
    old = body.findall(q("a:p"))
    by_level: dict[int, Any] = {}
    for p in old:
        ppr = p.find(q("a:pPr"))
        by_level.setdefault(int(ppr.get("lvl", "0")) if ppr is not None else 0, p)
    if not append:
        for p in old:
            body.remove(p)
    aligns = {"left": PP_ALIGN.LEFT, "center": PP_ALIGN.CENTER, "right": PP_ALIGN.RIGHT, "justify": PP_ALIGN.JUSTIFY}
    for i, item in enumerate(items):
        if append:
            template = old[-1] if old else None
        elif "level" in item and item["level"] in by_level:
            template = by_level[item["level"]]
        else:
            template = old[i] if i < len(old) else (old[-1] if old else None)
        if template is not None:
            p = copy.deepcopy(template)
            for child in list(p):
                if child.tag not in (q("a:pPr"), q("a:endParaRPr")):
                    p.remove(child)
            body.append(p)
            first = template.find(f"{q('a:r')}/{q('a:rPr')}")
            if first is None and template.find(q("a:endParaRPr")) is not None:
                first = copy.deepcopy(template.find(q("a:endParaRPr")))
                first.tag = q("a:rPr")
            base = clean_rpr(first) if first is not None else None
        else:
            p = body.add_p()
            base = None
        para = _Paragraph(p, frame)
        if "level" in item:
            para.level = item["level"]
        if "align" in item:
            para.alignment = aligns[item["align"]]
        for k, spec in enumerate(item["runs"], 1):
            text = spec.get("text", "")
            if isinstance(text, (int, float)) and not isinstance(text, bool):
                text = str(text)
            if not isinstance(text, str):
                raise Fail(f"{where}: text is a string")
            for n, line in enumerate(text.replace("\r\n", "\n").replace("\v", "\n").split("\n")):
                if n:
                    para.add_line_break()
                run = para.add_run()
                if base is not None:
                    run._r.insert(0, copy.deepcopy(base))
                run.text = line
                apply_style(run, spec, f"{where}, run {k}")


# ---------------------------------------------------------------- charts, tables, pictures


CHART_TYPES = {
    "column": "COLUMN_CLUSTERED", "column_stacked": "COLUMN_STACKED", "column_stacked_100": "COLUMN_STACKED_100",
    "bar": "BAR_CLUSTERED", "bar_stacked": "BAR_STACKED", "bar_stacked_100": "BAR_STACKED_100",
    "line": "LINE", "line_markers": "LINE_MARKERS", "pie": "PIE", "doughnut": "DOUGHNUT",
    "area": "AREA", "area_stacked": "AREA_STACKED", "scatter": "XY_SCATTER",
}
CHART_KEYS = {"type", "categories", "series", "title", "number_format", "legend", "labels", "font_size", "colors"}


def values_list(value: Any, count: int, where: str) -> list[float | None]:
    if not isinstance(value, list):
        raise Fail(f"{where}: values are a list of numbers (null for none)")
    if len(value) != count:
        raise Fail(f"{where}: {len(value)} values for {count} categories")
    out: list[float | None] = []
    for v in value:
        if v is None:
            out.append(None)
        elif isinstance(v, bool) or not isinstance(v, (int, float)):
            raise Fail(f"{where}: {v!r} isn't a number (write numbers without quotes, null for none)")
        else:
            out.append(v)
    return out


def category_data(categories: Any, series: Any, where: str, number_format: str | None = None) -> Any:
    from pptx.chart.data import CategoryChartData

    if not isinstance(categories, list) or not categories:
        raise Fail(f"{where}: \"categories\" is a list of labels")
    if not isinstance(series, dict) or not series:
        raise Fail(f"{where}: \"series\" is an object like {{\"Sales\": [1, 2, 3]}}")
    data = CategoryChartData(number_format=number_format or "General")
    data.categories = [c if isinstance(c, (int, float)) and not isinstance(c, bool) else str(c) for c in categories]
    for name, values in series.items():
        data.add_series(str(name), values_list(values, len(categories), f"{where}: series {name!r}"))
    return data


def xy_data(series: Any, where: str, number_format: str | None = None) -> Any:
    from pptx.chart.data import XyChartData

    if not isinstance(series, dict) or not series:
        raise Fail(f"{where}: \"series\" is an object like {{\"Plant A\": [[1.5, 20], [2, 24]]}}")
    data = XyChartData(number_format=number_format or "General")
    for name, points in series.items():
        s = data.add_series(str(name))
        if not isinstance(points, list) or not points:
            raise Fail(f"{where}: series {name!r} is a list of [x, y] points")
        for point in points:
            if not (isinstance(point, list) and len(point) == 2 and all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in point)):
                raise Fail(f"{where}: series {name!r} has {point!r}, which isn't an [x, y] pair of numbers")
            s.add_data_point(point[0], point[1])
    return data


def new_chart(spec: Any, where: str) -> tuple[Any, Any]:
    """(chart type, chart data) for a chart spec."""
    from pptx.enum.chart import XL_CHART_TYPE

    if not isinstance(spec, dict):
        raise Fail(f"{where}: a chart is an object with type, categories and series")
    unknown = sorted(set(spec) - CHART_KEYS)
    if unknown:
        raise Fail(f"{where}: a chart doesn't take {', '.join(unknown)}; it takes {', '.join(sorted(CHART_KEYS))}")
    kind = spec.get("type", "column")
    if kind not in CHART_TYPES:
        raise Fail(f"{where}: chart type {kind!r} isn't one of {', '.join(CHART_TYPES)}")
    fmt = spec.get("number_format")
    if fmt is not None and not isinstance(fmt, str):
        raise Fail(f"{where}: number_format is text like \"0%\" or \"#,##0\"")
    if kind == "scatter":
        data = xy_data(spec.get("series"), where, fmt)
    else:
        data = category_data(spec.get("categories"), spec.get("series"), where, fmt)
    return getattr(XL_CHART_TYPE, CHART_TYPES[kind]), data


def style_chart(chart: Any, spec: dict[str, Any], where: str) -> None:
    from pptx.enum.chart import XL_LEGEND_POSITION
    from pptx.util import Pt

    kind = spec.get("type", "column")
    series = list(chart.plots[0].series) if chart.plots else []
    if spec.get("title"):
        chart.has_title = True
        chart.chart_title.text_frame.text = str(spec["title"])
    else:
        chart.has_title = False  # otherwise PowerPoint titles a one-series chart with the series name
    legend = spec.get("legend", "bottom" if len(spec.get("series") or {}) > 1 or kind in ("pie", "doughnut") else False)
    if legend:
        positions = {"bottom": XL_LEGEND_POSITION.BOTTOM, "right": XL_LEGEND_POSITION.RIGHT,
                     "top": XL_LEGEND_POSITION.TOP, "left": XL_LEGEND_POSITION.LEFT}
        if legend not in positions:
            raise Fail(f"{where}: legend is bottom, right, top, left or false")
        chart.has_legend = True
        chart.legend.position = positions[legend]
        chart.legend.include_in_layout = False
    else:
        chart.has_legend = False
    if spec.get("labels"):
        plot = chart.plots[0]
        plot.has_data_labels = True
        if spec.get("number_format"):
            plot.data_labels.number_format = spec["number_format"]
            plot.data_labels.number_format_is_linked = False
    if "font_size" in spec:
        chart.font.size = Pt(number(spec["font_size"], f"{where}: font_size", 1, 400))
    colors = spec.get("colors")
    if colors is not None:
        if not isinstance(colors, list):
            raise Fail(f"{where}: colors is a list like [\"#1F4E79\", \"#C55A11\"]")
        rgb = [color(c, f"{where}: colors") for c in colors]
        if kind in ("pie", "doughnut") and series:
            for point, c in zip(series[0].points, rgb):
                point.format.fill.solid()
                point.format.fill.fore_color.rgb = c
        else:
            for s, c in zip(series, rgb):
                if kind.startswith(("line", "scatter")):
                    s.format.line.color.rgb = c
                else:
                    s.format.fill.solid()
                    s.format.fill.fore_color.rgb = c


TABLE_KEYS = {"rows", "header", "widths", "font_size"}
NUMBERISH = re.compile(r"^[\s(+\-−$€£¥]*\d[\d.,\s]*%?\)?\s*$")


def table_spec(spec: Any, where: str) -> tuple[list[list[Any]], int]:
    if not isinstance(spec, dict) or set(spec) - TABLE_KEYS:
        raise Fail(f"{where}: a table is {{\"rows\": [[...], ...]}} with any of header, widths, font_size")
    rows = spec.get("rows")
    if not isinstance(rows, list) or not rows or not all(isinstance(r, list) for r in rows):
        raise Fail(f"{where}: \"rows\" is a list of rows, each a list of cells")
    cols = max(len(r) for r in rows)
    if cols == 0:
        raise Fail(f"{where}: the rows have no cells")
    return rows, cols


def fill_table(frame: Any, spec: dict[str, Any], where: str) -> None:
    from pptx.enum.text import PP_ALIGN

    rows, cols = table_spec(spec, where)
    table = frame.table
    table.first_row = bool(spec.get("header", True))
    widths = spec.get("widths")
    if widths is not None:
        if not isinstance(widths, list) or len(widths) != cols:
            raise Fail(f"{where}: \"widths\" needs one number per column ({cols})")
        shares = [number(w, f"{where}: widths", 0) for w in widths]
        if sum(shares) <= 0:
            raise Fail(f"{where}: \"widths\" are shares of the width, like [3, 1]: not all 0")
        total = frame.width
        for i, share in enumerate(shares):
            table.columns[i].width = int(total * share / sum(shares))
    defaults = {"size": spec["font_size"]} if "font_size" in spec else {}
    for r, row in enumerate(rows):
        for c in range(cols):
            value = row[c] if c < len(row) else ""
            text = "" if value is None else value
            items = paragraphs(text, f"{where}: row {r + 1}, column {c + 1}", defaults)
            write_text(table.cell(r, c).text_frame, items, f"{where}: row {r + 1}")
            if isinstance(text, (int, float)) or (isinstance(text, str) and NUMBERISH.match(text) and not (r == 0 and table.first_row)):
                for p in table.cell(r, c).text_frame.paragraphs:
                    p.alignment = PP_ALIGN.RIGHT


def picture_size(path: str, where: str) -> tuple[int, int]:
    from pptx.parts.image import Image

    try:
        image = Image.from_file(path)
        image.content_type  # noqa: B018 (raises for a kind of picture PowerPoint can't hold)
        return image.size
    except Exception:
        raise Fail(f"{where}: can't use {path} as a picture: PowerPoint takes PNG, JPEG, GIF, BMP or TIFF (convert others first)") from None


def fit(size: tuple[int, int], box: tuple[int, int, int, int]) -> tuple[int, int, int, int]:
    """The largest box with the picture's proportions that fits inside box, centred in it."""
    (iw, ih), (x, y, w, h) = size, box
    scale = min(w / iw, h / ih)
    pw, ph = int(iw * scale), int(ih * scale)
    return x + (w - pw) // 2, y + (h - ph) // 2, pw, ph


def set_alt(element: Any, alt: Any, where: str) -> None:
    if alt is None:
        return
    if not isinstance(alt, str):
        raise Fail(f"{where}: alt is the picture's description, as text")
    cnv = element.find(f".//{q('p:cNvPr')}")
    if cnv is not None:
        cnv.set("descr", alt)


def keep_place(slide: Any, old: Any, new: Any) -> None:
    """Put a new shape where an old one was in the stacking order, and take the old one out."""
    tree = slide.shapes._spTree
    index = list(tree).index(old)
    tree.remove(new)
    tree.insert(index, new)
    tree.remove(old)


# ---------------------------------------------------------------- shapes


SHAPE_KEYS = {
    "text": {"type", "name", "x", "y", "w", "h", "text", "size", "bold", "italic", "color", "font", "align"},
    "picture": {"type", "name", "x", "y", "w", "h", "path", "alt"},
    "chart": {"type", "name", "x", "y", "w", "h", "chart"},
    "table": {"type", "name", "x", "y", "w", "h", "table"},
    "box": {"type", "name", "x", "y", "w", "h", "shape", "fill", "line", "text", "size", "bold", "italic", "color", "font", "align"},
}


def add_shape(slide: Any, spec: Any, plan: Plan, where: str) -> Any:
    from pptx.enum.shapes import MSO_SHAPE
    from pptx.enum.text import MSO_ANCHOR

    if not isinstance(spec, dict) or spec.get("type") not in SHAPE_KEYS:
        raise Fail(f"{where}: a shape is an object whose type is {', '.join(SHAPE_KEYS)}")
    kind = spec["type"]
    unknown = sorted(set(spec) - SHAPE_KEYS[kind])
    if unknown:
        raise Fail(f"{where}: a {kind} shape doesn't take {', '.join(unknown)}; it takes {', '.join(sorted(SHAPE_KEYS[kind]))}")
    for key in ("x", "y"):
        if key not in spec:
            raise Fail(f"{where}: needs \"x\" and \"y\" (inches from the slide's top-left corner)")
    x, y = length(spec["x"], f"{where}: x"), length(spec["y"], f"{where}: y")
    w = length(spec["w"], f"{where}: w", True) if "w" in spec else None
    h = length(spec["h"], f"{where}: h", True) if "h" in spec else None
    style = {k: spec[k] for k in ("size", "bold", "italic", "color", "font", "align") if k in spec}
    shapes = slide.shapes
    if kind == "picture":
        path = plan.path(spec.get("path"), f"{where}: path")
        size = picture_size(path, where)
        if w is None and h is None:
            raise Fail(f"{where}: give the picture \"w\" or \"h\" (or both: it fits inside them)")
        if w is not None and h is not None:
            box = fit(size, (x, y, w, h))
        elif w is not None:
            box = (x, y, w, int(w * size[1] / size[0]))
        else:
            assert h is not None
            box = (x, y, int(h * size[0] / size[1]), h)
        shape = shapes.add_picture(path, *box)
        set_alt(shape._element, spec.get("alt"), where)
    elif kind == "table":
        rows, cols = table_spec(spec.get("table"), where)
        if w is None:
            raise Fail(f"{where}: a table needs \"w\"")
        shape = shapes.add_table(len(rows), cols, x, y, w, h or int(len(rows) * 0.4 * UNITS["in"]))
        fill_table(shape, spec["table"], where)
    else:
        if w is None or h is None:
            raise Fail(f"{where}: a {kind} shape needs \"w\" and \"h\"")
        if kind == "chart":
            chart_type, data = new_chart(spec.get("chart"), where)
            shape = shapes.add_chart(chart_type, x, y, w, h, data)
            style_chart(shape.chart, spec["chart"], where)
        elif kind == "text":
            shape = shapes.add_textbox(x, y, w, h)
            shape.text_frame.word_wrap = True
            write_text(shape.text_frame, paragraphs(spec.get("text", ""), where, style), where)
        else:
            forms = {"rectangle": MSO_SHAPE.RECTANGLE, "rounded": MSO_SHAPE.ROUNDED_RECTANGLE, "oval": MSO_SHAPE.OVAL}
            form = spec.get("shape", "rectangle")
            if form not in forms:
                raise Fail(f"{where}: shape is rectangle, rounded or oval")
            shape = shapes.add_shape(forms[form], x, y, w, h)
            if "fill" in spec:
                if spec["fill"] == "none":
                    shape.fill.background()
                else:
                    shape.fill.solid()
                    shape.fill.fore_color.rgb = color(spec["fill"], f"{where}: fill")
            if "line" in spec:
                if spec["line"] == "none":
                    shape.line.fill.background()
                else:
                    shape.line.color.rgb = color(spec["line"], f"{where}: line")
            if "text" in spec:
                shape.text_frame.word_wrap = True
                shape.text_frame.vertical_anchor = MSO_ANCHOR.MIDDLE
                write_text(shape.text_frame, paragraphs(spec["text"], where, style), where)
    if "name" in spec:
        if not isinstance(spec["name"], str) or not spec["name"].strip():
            raise Fail(f"{where}: name is text")
        shape.name = spec["name"]
    return shape


def shapes_list(value: Any, where: str) -> list[Any]:
    if not isinstance(value, list):
        raise Fail(f"{where}: \"shapes\" is a list of shapes")
    return value


# ---------------------------------------------------------------- placeholders


BODY_TYPES = ("BODY", "OBJECT", "VERTICAL_BODY", "VERTICAL_OBJECT")
PICTURE_TYPES = ("PICTURE", "BITMAP")


def put_content(slide: Any, ph: Any, content: Any, plan: Plan, where: str) -> None:
    """Fill a placeholder on a new slide with text, a picture, a chart or a table."""
    from pptx.shapes.placeholder import ChartPlaceholder, TablePlaceholder

    kind = ph_type(ph) or "OBJECT"
    if isinstance(content, dict) and set(content) & {"picture", "chart", "table"}:
        if "picture" in content:
            if set(content) - {"picture", "alt"}:
                raise Fail(f"{where}: a picture is {{\"picture\": \"file\", \"alt\": \"...\"}}")
            path = plan.path(content["picture"], f"{where}: picture")
            size = picture_size(path, where)
            if kind in PICTURE_TYPES:
                done = ph.insert_picture(path)  # cropped to fill the placeholder, as PowerPoint does
                set_alt(done._element, content.get("alt"), where)
            else:
                box = fit(size, (ph.left, ph.top, ph.width, ph.height))
                pic = slide.shapes.add_picture(path, *box)
                set_alt(pic._element, content.get("alt"), where)
                keep_place(slide, ph._element, pic._element)
        elif "chart" in content:
            if set(content) != {"chart"}:
                raise Fail(f"{where}: a chart is {{\"chart\": {{...}}}}")
            chart_type, data = new_chart(content["chart"], where)
            if kind in ("CHART", "OBJECT"):
                frame = ChartPlaceholder(ph._element, ph._parent).insert_chart(chart_type, data)
            else:
                frame = slide.shapes.add_chart(chart_type, ph.left, ph.top, ph.width, ph.height, data)
                keep_place(slide, ph._element, frame._element)
            style_chart(frame.chart, content["chart"], where)
        else:
            if set(content) != {"table"}:
                raise Fail(f"{where}: a table is {{\"table\": {{\"rows\": [...]}}}}")
            rows, cols = table_spec(content["table"], where)
            if kind in ("TABLE", "OBJECT"):
                frame = TablePlaceholder(ph._element, ph._parent).insert_table(len(rows), cols)
            else:
                frame = slide.shapes.add_table(len(rows), cols, ph.left, ph.top, ph.width, int(len(rows) * 0.4 * UNITS["in"]))
                keep_place(slide, ph._element, frame._element)
            fill_table(frame, content["table"], where)
        return
    if kind in PICTURE_TYPES + ("CHART", "TABLE") or not ph.has_text_frame:
        raise Fail(f"{where}: placeholder {ph.placeholder_format.idx} is for a {kind.lower()}: give {{\"{'picture' if kind in PICTURE_TYPES else kind.lower()}\": ...}}")
    write_text(ph.text_frame, paragraphs(content, where), where)


def find_layout(prs: Any, ref: Any, master: Any, where: str) -> Any:
    masters = list(prs.slide_masters)
    pool = []
    for m, sm in enumerate(masters, 1):
        for layout in sm.slide_layouts:
            pool.append((m, layout))
    names = ", ".join(f"{i}. {layout.name}" for i, (_, layout) in enumerate(pool, 1))
    if isinstance(ref, int) and not isinstance(ref, bool):
        if not 1 <= ref <= len(pool):
            raise Fail(f"{where}: there is no layout {ref}; the layouts are {names}")
        return pool[ref - 1][1]
    if not isinstance(ref, str):
        raise Fail(f"{where}: \"layout\" is a layout's name or number; the layouts are {names}")
    found = [(m, layout) for m, layout in pool if layout.name.strip().lower() == ref.strip().lower()]
    if master is not None:
        found = [(m, layout) for m, layout in found if m == whole(master, f"{where}: master")]
    if not found:
        raise Fail(f"{where}: no layout called {ref!r}; the layouts are {names}")
    return found[0][1]


def step_add(prs: Any, step: dict[str, Any], plan: Plan, where: str) -> dict[str, Any]:
    if "layout" not in step:
        raise Fail(f"{where}: say which layout the slide uses (pptx_tool.py info lists them)")
    layout = find_layout(prs, step["layout"], step.get("master"), where)
    renumber(prs)
    slide = prs.slides.add_slide(layout)
    sld = prs.slides._sldIdLst[-1]
    place_in_sections(prs, sld)
    filled: set[int] = set()
    placeholders = {ph.placeholder_format.idx: ph for ph in slide.placeholders}

    def role(name: str, types: tuple[str, ...]) -> Any:
        for idx in sorted(placeholders):
            if ph_type(placeholders[idx]) in types and idx not in filled:
                return placeholders[idx]
        listing = ", ".join(f"{i} ({ph_type(p)})" for i, p in sorted(placeholders.items())) or "none"
        raise Fail(f"{where}: layout {layout.name!r} has no {name} placeholder; its placeholders are {listing}")

    jobs: list[tuple[Any, Any, str]] = []
    for key, types in (("title", ("TITLE", "CENTER_TITLE", "VERTICAL_TITLE")), ("subtitle", ("SUBTITLE",)), ("body", BODY_TYPES)):
        if key in step:
            ph = role(key, types)
            filled.add(ph.placeholder_format.idx)
            jobs.append((ph, step[key], f"{where}: {key}"))
    extra = step.get("placeholders", {})
    if not isinstance(extra, dict):
        raise Fail(f"{where}: \"placeholders\" is an object like {{\"13\": \"text\"}}, keyed by idx")
    for key, content in extra.items():
        try:
            idx = int(key)
        except ValueError:
            raise Fail(f"{where}: placeholders are keyed by their idx number, not {key!r}") from None
        if idx not in placeholders:
            listing = ", ".join(f"{i} ({ph_type(p)})" for i, p in sorted(placeholders.items())) or "none"
            raise Fail(f"{where}: layout {layout.name!r} has no placeholder {idx}; its placeholders are {listing}")
        if idx in filled:
            raise Fail(f"{where}: placeholder {idx} is filled twice")
        filled.add(idx)
        jobs.append((placeholders[idx], content, f"{where}: placeholder {idx}"))
    for ph, content, at in jobs:
        put_content(slide, ph, content, plan, at)
    for i, spec in enumerate(shapes_list(step.get("shapes", []), where), 1):
        add_shape(slide, spec, plan, f"{where}: shape {i}")
    if "notes" in step:
        write_notes(slide, step["notes"], False, where)
    removed = 0
    if not step.get("keep_empty", False):
        for idx, ph in placeholders.items():
            if idx not in filled and ph._element.getparent() is not None:
                ph._element.getparent().remove(ph._element)
                removed += 1
    if step.get("hidden"):
        slide._element.set("show", "0")
    position = len(prs.slides)
    if "at" in step:
        position = move_slides(prs, [len(prs.slides)], whole(step["at"], f"{where}: at"), where)
    result = {"slide": position, "layout": layout.name}
    if removed:
        result["empty_placeholders_removed"] = removed
    return result


# ---------------------------------------------------------------- slide order


def delete_slides(prs: Any, numbers: list[int]) -> None:
    lst = prs.slides._sldIdLst
    items = list(lst)
    for n in sorted(set(numbers)):
        sld = items[n - 1]
        rid, sid = sld.rId, sld.get("id")
        for show in [e for e in prs.part._element.iter(q("p:sld")) if e.get(q("r:id")) == rid]:
            show.getparent().remove(show)  # a custom show that listed the slide
        lst.remove(sld)
        section_forget(prs, sid)
        prs.part.drop_rel(rid)


def move_slides(prs: Any, numbers: list[int], to: int, where: str) -> int:
    lst = prs.slides._sldIdLst
    items = list(lst)
    if len(set(numbers)) != len(numbers):
        raise Fail(f"{where}: a slide is named twice")
    block = [items[n - 1] for n in numbers]
    if not 1 <= to <= len(items) - len(block) + 1:
        raise Fail(f"{where}: \"to\" runs from 1 to {len(items) - len(block) + 1} for {len(block)} slide{'s' if len(block) > 1 else ''}")
    for el in block:
        lst.remove(el)
    for i, el in enumerate(block):
        lst.insert(to - 1 + i, el)
    for el in block:
        place_in_sections(prs, el)
    return to


def duplicate_slide(prs: Any, n: int, to: int | None, where: str) -> int:
    from pptx.opc.constants import RELATIONSHIP_TYPE as RT

    source = prs.slides[n - 1]
    copied = (RT.IMAGE, RT.MEDIA, RT.VIDEO, RT.AUDIO, RT.HYPERLINK)
    skipped = (RT.SLIDE_LAYOUT, RT.NOTES_SLIDE, RT.COMMENTS, "http://schemas.microsoft.com/office/2018/10/relationships/comments")
    blocked = sorted({rel.reltype.rsplit("/", 1)[-1] for rel in source.part.rels.values() if rel.reltype not in copied + skipped})
    if blocked:
        raise Fail(f"{where}: slide {n} holds {', '.join(blocked)}, which a copy would share with the original and "
                   "break; build the slide again with an add step instead")
    renumber(prs)
    # not prs.slides.add_slide: it reads the new slide's shapes, and python-pptx would keep them after the copy
    rid, new = prs.part.add_slide(source.slide_layout)
    prs.slides._sldIdLst.add_sldId(rid)
    for child in list(new._element):
        new._element.remove(child)
    for child in source._element:
        new._element.append(copy.deepcopy(child))
    for key, value in source._element.attrib.items():
        new._element.set(key, value)
    mapping = {}
    for rid, rel in source.part.rels.items():
        if rel.reltype in skipped:
            continue
        mapping[rid] = new.part.relate_to(rel.target_ref if rel.is_external else rel.target_part, rel.reltype, rel.is_external)
    prefix = f"{{{NS['r']}}}"
    for el in new._element.iter():
        for key, value in list(el.attrib.items()):
            if key.startswith(prefix) and value in mapping:
                el.set(key, mapping[value])
    for el in new._element.iter(f"{{{P14}}}creationId"):
        el.set("val", str(random.randint(1, 2**32 - 1)))  # PowerPoint tells slides apart by it
    if source.has_notes_slide and source.notes_slide.notes_text_frame is not None:
        target = new.notes_slide.notes_text_frame
        if target is not None:
            body = target._txBody
            for p in body.findall(q("a:p")):
                body.remove(p)
            for p in source.notes_slide.notes_text_frame._txBody.findall(q("a:p")):
                p = copy.deepcopy(p)
                for link in list(p.iter(q("a:hlinkClick"))):
                    link.getparent().remove(link)
                body.append(p)
    lst = prs.slides._sldIdLst
    sld = lst[-1]
    lst.remove(sld)
    position = n + 1 if to is None else to
    if not 1 <= position <= len(lst) + 1:
        raise Fail(f"{where}: \"to\" runs from 1 to {len(lst) + 1}")
    lst.insert(position - 1, sld)
    place_in_sections(prs, sld)
    return position


# ---------------------------------------------------------------- replacing text


def look(run: Any) -> str:
    """How a run looks, leaving out marks that don't change it (language, spell-check), to merge runs that PowerPoint
    split for no visible reason."""
    from lxml import etree

    rpr = run.find(q("a:rPr"))
    if rpr is None:
        return ""
    attrs = sorted((k, v) for k, v in rpr.attrib.items() if k not in NON_VISUAL)
    return repr(attrs) + "".join(etree.tostring(c).decode() for c in rpr)


def run_text(run: Any) -> str:
    t = run.find(q("a:t"))
    return (t.text or "") if t is not None else ""


def set_run_text(run: Any, text: str) -> None:
    from lxml import etree

    t = run.find(q("a:t"))
    if t is None:
        t = etree.SubElement(run, q("a:t"))
    t.text = text


def replace_in_paragraph(p: Any, pattern: Any, repl: Callable[[Any], str | None]) -> tuple[int, bool]:
    """Replace matches of pattern in a paragraph's runs, also when PowerPoint split the text across runs. Returns
    (replacements, whether one spanned runs that look different: the new text then takes the first run's look)."""
    segments: list[list[Any]] = [[]]
    for child in p:
        if child.tag == q("a:r"):
            segments[-1].append(child)
        elif segments[-1]:
            segments.append([])  # a line break or a field ends the stretch a match can span
    count, mixed = 0, False
    for seg in segments:
        if not seg:
            continue
        joined = "".join(run_text(r) for r in seg)
        spans = [(m.start(), m.end(), new) for m in pattern.finditer(joined) if m.end() > m.start() for new in [repl(m)] if new is not None]
        if not spans:
            continue
        merged = [seg[0]]
        for run in seg[1:]:
            if look(run) == look(merged[-1]):
                set_run_text(merged[-1], run_text(merged[-1]) + run_text(run))
                p.remove(run)
            else:
                merged.append(run)
        starts, at = [], 0
        for run in merged:
            starts.append(at)
            at += len(run_text(run))
        emptied = set()
        for s, e, new in reversed(spans):
            i = max(k for k in range(len(merged)) if starts[k] <= s)  # the run the match starts in
            j = max(k for k in range(len(merged)) if starts[k] < e)  # and the one it ends in
            if i == j:
                t = run_text(merged[i])
                set_run_text(merged[i], t[:s - starts[i]] + new + t[e - starts[i]:])
            else:
                mixed = True
                t = run_text(merged[i])
                set_run_text(merged[i], t[:s - starts[i]] + new)
                for k in range(i + 1, j):
                    set_run_text(merged[k], "")
                    emptied.add(k)
                t = run_text(merged[j])
                set_run_text(merged[j], t[e - starts[j]:])
                if not run_text(merged[j]):
                    emptied.add(j)
            count += 1
        for k in sorted(emptied, reverse=True):
            p.remove(merged[k])
    return count, mixed


def text_places(prs: Any, slides: list[int], notes: bool, layouts: bool) -> Iterator[tuple[str, int | None, Any, Callable[[Any], None] | None]]:
    """(where, slide number, XML root, how to store it) for every place text can be: slides (with groups and tables),
    their charts, SmartArt and notes, and masters and layouts when asked."""
    from lxml import etree

    all_slides = list(prs.slides)
    for n in slides:
        slide = all_slides[n - 1]
        yield "slides", n, slide._element, None
        for rel in slide.part.rels.values():
            if rel.is_external:
                continue
            kind = rel.reltype.rsplit("/", 1)[-1]
            if kind == "chart":
                yield "charts", n, rel.target_part._element, None
            elif kind in ("diagramData", "diagramDrawing"):
                part = rel.target_part
                root = etree.fromstring(part.blob, etree.XMLParser(resolve_entities=False, no_network=True))

                def store(root: Any, part: Any = part) -> None:
                    part.blob = etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)

                yield "smartart", n, root, store
        if notes and slide.has_notes_slide:
            yield "notes", n, slide.notes_slide._element, None
    if layouts:
        for master in prs.slide_masters:
            yield "layouts", None, master._element, None
            for layout in master.slide_layouts:
                yield "layouts", None, layout._element, None


def run_replace(prs: Any, pattern: Any, repl: Callable[[Any], str | None], slides: list[int], notes: bool, layouts: bool) -> dict[str, Any]:
    counts: dict[str, int] = {}
    changed: set[int] = set()
    mixed: set[int] = set()
    for place, n, root, store in text_places(prs, slides, notes, layouts):
        total = 0
        for p in list(root.iter(q("a:p"))):
            c, m = replace_in_paragraph(p, pattern, repl)
            total += c
            if m and n is not None:
                mixed.add(n)
        if total:
            counts[place] = counts.get(place, 0) + total
            if n is not None:
                changed.add(n)
            if store is not None:
                store(root)
    result: dict[str, Any] = {"replaced": sum(counts.values()), "by_place": counts, "slides_changed": sorted(changed)}
    if mixed:
        result["look_check"] = {"slides": sorted(mixed), "why": "a match spanned differently formatted text and took the look of its first part: render these slides"}
    return result


def bool_opt(step: dict[str, Any], key: str, default: bool, where: str) -> bool:
    value = step.get(key, default)
    if not isinstance(value, bool):
        raise Fail(f"{where}: {key} is true or false")
    return value


def step_replace(prs: Any, step: dict[str, Any], where: str, problems: list[str]) -> dict[str, Any]:
    find, new = step.get("find"), step.get("with")
    if not isinstance(find, str) or not find:
        raise Fail(f"{where}: \"find\" is the text to look for")
    if not isinstance(new, str):
        raise Fail(f"{where}: \"with\" is the new text (\"\" removes the found text)")
    if "\n" in new or "\v" in new:
        raise Fail(f"{where}: a replacement can't hold a line break; use a text step for the shape instead")
    case = bool_opt(step, "match_case", True, where)
    notes, layouts = bool_opt(step, "notes", True, where), bool_opt(step, "layouts", False, where)
    pattern = re.compile(re.escape(find), 0 if case else re.IGNORECASE)
    slides = parse_slides(step.get("slides"), len(prs.slides))
    result = run_replace(prs, pattern, lambda m: new, slides, notes, layouts)
    elsewhere = 0
    if not layouts:  # text on a master shows on every slide but isn't on them: the usual reason an old name stays
        elsewhere = sum(len(pattern.findall("".join(run_text(r) for r in p.iter(q("a:r")))))
                        for _, _, root, _ in text_places(prs, [], False, True) for p in root.iter(q("a:p")))
        if elsewhere:
            result["left_on_layouts"] = f'{elsewhere} on the masters or layouts, not changed: add "layouts": true to change them'
    if not result["replaced"]:
        hint = ' (it is on the masters or layouts: add "layouts": true)' if elsewhere else ""
        problems.append(f"{where}: found no {find!r}{hint}")
    return result


def step_fill(prs: Any, step: dict[str, Any], where: str, problems: list[str]) -> dict[str, Any]:
    values = step.get("values")
    if not isinstance(values, dict) or not values:
        raise Fail(f"{where}: \"values\" is an object like {{\"client\": \"Globex\"}}")
    text = {}
    for key, value in values.items():
        if isinstance(value, bool) or not isinstance(value, (str, int, float)):
            raise Fail(f"{where}: the value for {key!r} is text or a number")
        text[key.strip()] = str(value)
        if "\n" in text[key.strip()]:
            raise Fail(f"{where}: the value for {key!r} holds a line break; use a text step for that shape instead")
    used: set[str] = set()
    left: set[str] = set()

    def repl(m: Any) -> str | None:
        name = m.group(1).strip()
        if name in text:
            used.add(name)
            return text[name]
        left.add(name)
        return None

    slides = parse_slides(step.get("slides"), len(prs.slides))
    result = run_replace(prs, TOKEN, repl, slides, bool_opt(step, "notes", True, where), bool_opt(step, "layouts", False, where))
    result["filled"] = sorted(used)
    if left:
        result["no_value"] = sorted(left)
        problems.append(f"{where}: no value for {', '.join('{{' + t + '}}' for t in sorted(left))}")
    unused = sorted(set(text) - used)
    if unused:
        result["not_found"] = unused
        problems.append(f"{where}: no {{{{token}}}} in the deck for {', '.join(unused)}")
    return result


# ---------------------------------------------------------------- the other steps


def write_notes(slide: Any, text: Any, append: bool, where: str) -> None:
    if text in ("", None, []) and not slide.has_notes_slide:
        return  # nothing to empty, and no notes page to make
    frame = slide.notes_slide.notes_text_frame
    if frame is None:
        raise Fail(f"{where}: this deck's notes page has no place for notes text")
    has_text = bool(frame.text.strip())
    write_text(frame, paragraphs(text, f"{where}: notes"), f"{where}: notes", append=append and has_text)


def step_text(prs: Any, step: dict[str, Any], where: str) -> dict[str, Any]:
    slide = slide_at(prs, step.get("slide"), where)
    shape = shape_on(slide, step.get("shape"), where)
    if "text" not in step:
        raise Fail(f"{where}: \"text\" is the new text")
    if "cell" in step:
        cell = step["cell"]
        if not getattr(shape, "has_table", False):
            raise Fail(f"{where}: {shape.name} isn't a table")
        if not (isinstance(cell, list) and len(cell) == 2):
            raise Fail(f"{where}: \"cell\" is [row, column], counted from 1")
        r, c = whole(cell[0], f"{where}: row"), whole(cell[1], f"{where}: column")
        table = shape.table
        if r > len(table.rows) or c > len(table.columns):
            raise Fail(f"{where}: the table has {len(table.rows)} rows and {len(table.columns)} columns")
        write_text(table.cell(r - 1, c - 1).text_frame, paragraphs(step["text"], where), where)
        return {"slide": slide_number(prs, slide), "shape": shape.name, "cell": [r, c]}
    if shape._element.tag != q("p:sp") or not shape.has_text_frame:
        raise Fail(f"{where}: {shape.name} holds no text (for a table cell add \"cell\": [row, column])")
    write_text(shape.text_frame, paragraphs(step["text"], where), where)
    return {"slide": slide_number(prs, slide), "shape": shape.name}


def slide_number(prs: Any, slide: Any) -> int:
    return list(prs.slides).index(slide) + 1


def step_table(prs: Any, step: dict[str, Any], where: str) -> dict[str, Any]:
    slide = slide_at(prs, step.get("slide"), where)
    shape = shape_on(slide, step.get("shape"), where)
    if not getattr(shape, "has_table", False):
        raise Fail(f"{where}: {shape.name} isn't a table")
    rows = step.get("rows")
    if not isinstance(rows, list) or not rows or not all(isinstance(r, list) for r in rows):
        raise Fail(f"{where}: \"rows\" is a list of rows, each a list of cells")
    table = shape.table
    cols = len(table.columns)
    if any(len(r) > cols for r in rows):
        raise Fail(f"{where}: the table has {cols} columns; a row here has more (add columns in PowerPoint, or build a new table)")
    tbl = table._tbl
    trs = tbl.findall(q("a:tr"))
    while len(trs) < len(rows):
        new = copy.deepcopy(trs[-1])
        trs[-1].addnext(new)
        trs.append(new)
    while len(trs) > len(rows):
        tbl.remove(trs.pop())
    for r, row in enumerate(rows):
        for c in range(cols):
            value = row[c] if c < len(row) else ""
            write_text(table.cell(r, c).text_frame, paragraphs("" if value is None else value, f"{where}: row {r + 1}"), f"{where}: row {r + 1}")
    shape.height = sum(int(tr.get("h", "0")) for tr in trs) or shape.height
    return {"slide": slide_number(prs, slide), "shape": shape.name, "rows": len(rows)}


def step_chart(prs: Any, step: dict[str, Any], where: str) -> dict[str, Any]:
    slide = slide_at(prs, step.get("slide"), where)
    if "shape" in step:
        shape = shape_on(slide, step["shape"], where)
        if not getattr(shape, "has_chart", False):
            raise Fail(f"{where}: {shape.name} isn't a chart (or is a newer kind, such as a waterfall, these scripts can't change)")
    else:
        charts = [s for s, _, _ in iter_shapes(slide.shapes) if getattr(s, "has_chart", False)]
        if len(charts) != 1:
            raise Fail(f"{where}: the slide has {len(charts)} charts: say which with \"shape\"")
        shape = charts[0]
    chart = shape.chart
    try:
        kind = chart.chart_type.name
    except Exception:
        kind = "unknown"
    whole_data = "categories" in step or "series" in step
    changes = [k for k in ("set", "add", "remove", "rename") if k in step]
    if whole_data and changes:
        raise Fail(f"{where}: give either the whole data (categories and series) or changes ({', '.join(changes)}), not both")
    C = "{http://schemas.openxmlformats.org/drawingml/2006/chart}"
    first = chart.plots[0].series[0]._element if chart.plots and len(chart.plots[0].series) else None
    fmt_el = first.find(f"{C}val//{C}formatCode") if first is not None else None
    fmt = fmt_el.text if fmt_el is not None else None
    if kind.startswith("BUBBLE"):
        raise Fail(f"{where}: bubble charts can't be changed by these scripts; change the chart in PowerPoint")
    if whole_data:
        if kind.startswith("XY_"):
            data = xy_data(step.get("series"), where, fmt)
        else:
            data = category_data(step.get("categories"), step.get("series"), where, fmt)
        chart.replace_data(data)
    elif changes:
        if kind.startswith("XY_"):
            raise Fail(f"{where}: an x-y chart takes its whole data at once: give \"series\" with every point")
        data = changed_data(chart, step, where)
        chart.replace_data(data)
        added = set(step.get("add", {}))
        for s in (s for p in chart.plots for s in p.series):
            if s.name in added:
                fill = s._element.find(f"{C}spPr")
                if fill is not None:  # python-pptx copies the last series' colours; let the theme pick a new one
                    s._element.remove(fill)
    colors = step.get("colors", {})
    if not isinstance(colors, dict):
        raise Fail(f"{where}: \"colors\" is an object like {{\"East\": \"#548235\"}}")
    by_name = {s.name: s for p in chart.plots for s in p.series}
    for name, value in colors.items():
        if name not in by_name:
            raise Fail(f"{where}: no series {name!r} to colour; the series are {', '.join(map(repr, by_name))}")
        rgb = color(value, f"{where}: colors")
        if kind.startswith(("LINE", "XY_", "RADAR")):
            by_name[name].format.line.color.rgb = rgb
        else:
            by_name[name].format.fill.solid()
            by_name[name].format.fill.fore_color.rgb = rgb
    if "title" in step:
        title = step["title"]
        if title in (None, ""):
            chart.has_title = False
        elif isinstance(title, str):
            chart.has_title = True
            chart.chart_title.text_frame.text = title
        else:
            raise Fail(f"{where}: title is text (\"\" removes it)")
    return {"slide": slide_number(prs, slide), "shape": shape.name, "series": [s.name for p in chart.plots for s in p.series]}


def changed_data(chart: Any, step: dict[str, Any], where: str) -> Any:
    """The chart's data read back, changed as asked: python-pptx can only replace a chart's data whole."""
    from pptx.chart.data import CategoryChartData

    C = "{http://schemas.openxmlformats.org/drawingml/2006/chart}"
    cats = chart.plots[0].categories
    if cats.depth > 1:
        raise Fail(f"{where}: this chart's categories are in {cats.depth} levels; give its whole data instead")
    shown = [str(c) for c in cats]  # the labels as pptx_tool.py outline lists them, to match names against
    labels: list[Any] = list(shown)
    cat_el = chart.plots[0]._element.find(f"{C}ser/{C}cat")
    numeric = cat_el is not None and cat_el.find(f"{C}numRef") is not None
    cat_fmt = None
    if numeric:  # numbers or dates: kept as numbers with their format, so a date axis stays one
        fc = cat_el.find(f".//{C}formatCode")
        cat_fmt = fc.text if fc is not None else None
        try:
            labels = [float(c) for c in shown]
        except ValueError:
            numeric = False
    series: list[list[Any]] = []  # [name, values, number format, element]
    for plot in chart.plots:
        for s in plot.series:
            fc = s._element.find(f"{C}val//{C}formatCode")
            series.append([s.name, list(s.values), fc.text if fc is not None else None, s._element])
    names = [s[0] for s in series]
    remove = step.get("remove", [])
    if not isinstance(remove, list):
        raise Fail(f"{where}: \"remove\" is a list of series names")
    for name in remove:
        if name not in names:
            raise Fail(f"{where}: no series {name!r}; the series are {', '.join(map(repr, names))}")
        entry = series[names.index(name)]
        plot_el = entry[3].getparent()
        if len(plot_el.findall(f"{C}ser")) == 1 and len(chart.plots) > 1:
            raise Fail(f"{where}: {name!r} is the only series of one of this chart's parts; change the chart in PowerPoint")
        plot_el.remove(entry[3])  # its own formatting goes with it, so the others keep theirs
        series.remove(entry)
        names = [s[0] for s in series]
    renames = step.get("rename", {})
    if not isinstance(renames, dict):
        raise Fail(f"{where}: \"rename\" is an object like {{\"Q1\": \"Q1 2026\"}}")
    if renames and numeric:
        raise Fail(f"{where}: this chart's categories are numbers or dates; give its whole data to change them")
    for old, new in renames.items():
        if old not in shown:
            raise Fail(f"{where}: no category {old!r}; the categories are {', '.join(map(repr, shown))}")
        if not isinstance(new, str) or not new:
            raise Fail(f"{where}: a category's new name is text")
        labels[shown.index(old)] = new
    sets = step.get("set", {})
    if not isinstance(sets, dict):
        raise Fail(f"{where}: \"set\" is an object like {{\"Sales\": [1, 2, 3]}} or {{\"Sales\": {{\"Q2\": 15}}}}")
    for name, values in sets.items():
        if name not in names:
            raise Fail(f"{where}: no series {name!r}; the series are {', '.join(map(repr, names))}")
        entry = series[names.index(name)]
        if isinstance(values, dict):
            current = list(entry[1])
            for cat, value in values.items():
                if cat not in shown:
                    raise Fail(f"{where}: no category {cat!r}; the categories are {', '.join(map(repr, shown))}")
                current[shown.index(cat)] = values_list([value], 1, f"{where}: {name!r}")[0]
            entry[1] = current
        else:
            entry[1] = values_list(values, len(labels), f"{where}: series {name!r}")
    adds = step.get("add", {})
    if not isinstance(adds, dict):
        raise Fail(f"{where}: \"add\" is an object like {{\"East\": [1, 2, 3]}}")
    for name, values in adds.items():
        if name in names:
            raise Fail(f"{where}: there is already a series {name!r}; use \"set\"")
        series.append([name, values_list(values, len(labels), f"{where}: series {name!r}"), None, None])
        names.append(name)
    data = CategoryChartData()
    data.categories = labels
    if numeric and cat_fmt:
        data.categories.number_format = cat_fmt
    default_fmt = next((s[2] for s in series if s[2]), None)
    for name, values, fmt, _ in series:
        data.add_series(name, values, number_format=fmt or default_fmt)
    return data


def step_picture(prs: Any, step: dict[str, Any], plan: Plan, where: str) -> dict[str, Any]:
    slide = slide_at(prs, step.get("slide"), where)
    shape = shape_on(slide, step.get("shape"), where)
    path = plan.path(step.get("path"), f"{where}: path")
    size = picture_size(path, where)
    el = shape._element
    if el.tag == q("p:pic"):
        blip = el.find(f".//{q('a:blip')}")
        old = blip.get(q("r:embed")) if blip is not None else None
        if blip is None or old is None:
            raise Fail(f"{where}: {shape.name} is a linked picture or a video; replace it in PowerPoint")
        _, rid = slide.part.get_or_add_image_part(path)
        blip.set(q("r:embed"), rid)
        el.crop_to_fit(size, (shape.width, shape.height))
        drop_unused(slide.part, {old})
        set_alt(el, step.get("alt"), where)
        return {"slide": slide_number(prs, slide), "shape": shape.name, "fit": "cropped to fill the frame"}
    if getattr(shape, "is_placeholder", False) and el.tag == q("p:sp"):
        name = shape.name  # the placeholder object is spent once the picture takes its place
        put_content(slide, shape, {"picture": step["path"], **({"alt": step["alt"]} if "alt" in step else {})}, plan, where)
        return {"slide": slide_number(prs, slide), "shape": name, "fit": "placed in the empty placeholder"}
    raise Fail(f"{where}: {shape.name} isn't a picture or an empty placeholder")


def step_delete_shape(prs: Any, step: dict[str, Any], where: str) -> dict[str, Any]:
    slide = slide_at(prs, step.get("slide"), where)
    shape = shape_on(slide, step.get("shape"), where)
    el = shape._element
    rids = {v for e in el.iter() for k, v in e.attrib.items() if k.startswith(f"{{{NS['r']}}}")}
    el.getparent().remove(el)
    drop_unused(slide.part, rids)
    return {"slide": slide_number(prs, slide), "deleted": shape.name}


def step_footer(prs: Any, step: dict[str, Any], where: str, problems: list[str]) -> dict[str, Any]:
    from pptx.enum.shapes import PP_PLACEHOLDER

    kinds = {"text": PP_PLACEHOLDER.FOOTER, "number": PP_PLACEHOLDER.SLIDE_NUMBER, "date": PP_PLACEHOLDER.DATE}
    asked = {k: step[k] for k in kinds if k in step}
    if not asked:
        raise Fail(f"{where}: give \"text\", \"number\" or \"date\"")
    if "number" in asked and not isinstance(asked["number"], bool):
        raise Fail(f"{where}: number is true or false")
    slides = list(prs.slides)
    missing: dict[str, list[int]] = {}
    for n in parse_slides(step.get("slides"), len(slides)):
        slide = slides[n - 1]
        for key, value in asked.items():
            have = [ph for ph in slide.placeholders if ph.placeholder_format.type == kinds[key]]
            if value is False or value == "" or value is None:
                for ph in have:
                    ph._element.getparent().remove(ph._element)
                continue
            if not have:
                source = next((ph for ph in slide.slide_layout.placeholders if ph.placeholder_format.type == kinds[key]), None)
                if source is None:
                    missing.setdefault(key, []).append(n)
                    continue
                el = copy.deepcopy(source._element)
                el.find(f".//{q('p:cNvPr')}").set("id", str(slide.shapes._next_shape_id))
                slide.shapes._spTree.append(el)
                have = [ph for ph in slide.placeholders if ph.placeholder_format.type == kinds[key]]
            if key in ("text", "date"):
                if not isinstance(value, str):
                    raise Fail(f"{where}: {key} is text (\"\" takes it off)")
                for ph in have:
                    write_text(ph.text_frame, paragraphs(value, where), where)
    for key, numbers in missing.items():
        what = {"text": "footer", "number": "slide number", "date": "date"}[key]
        problems.append(f"{where}: the layouts of slides {', '.join(map(str, numbers))} have no {what} placeholder; add a text shape there if it's needed")
    return {"slides": len(parse_slides(step.get("slides"), len(slides)))}


def run_steps(prs: Any, plan: Plan) -> tuple[list[dict[str, Any]], list[str]]:
    done: list[dict[str, Any]] = []
    problems: list[str] = []
    for i, step in enumerate(plan.steps, 1):
        if not isinstance(step, dict) or step.get("do") not in STEP_KEYS:
            what = step.get("do") if isinstance(step, dict) else step
            raise Fail(f"step {i}: {what!r} isn't a step; \"do\" is one of {', '.join(STEP_KEYS)}")
        kind = step["do"]
        where = f"step {i} ({kind})"
        unknown = sorted(set(step) - STEP_KEYS[kind] - {"do"})
        if unknown:
            raise Fail(f"{where}: doesn't take {', '.join(unknown)}; it takes {', '.join(sorted(STEP_KEYS[kind]))}")
        count = len(prs.slides)
        if kind == "add":
            result = step_add(prs, step, plan, where)
        elif kind == "text":
            result = step_text(prs, step, where)
        elif kind == "table":
            result = step_table(prs, step, where)
        elif kind == "replace":
            result = step_replace(prs, step, where, problems)
        elif kind == "fill":
            result = step_fill(prs, step, where, problems)
        elif kind == "notes":
            if "text" not in step:
                raise Fail(f"{where}: \"text\" is the notes' text (\"\" empties them)")
            if ("slide" in step) == ("slides" in step):
                raise Fail(f"{where}: give \"slide\" (one) or \"slides\" (several get the same text)")
            numbers = [whole(step["slide"], f"{where}: slide")] if "slide" in step else parse_slides(step["slides"], count)
            append = bool_opt(step, "append", False, where)
            for n in numbers:
                write_notes(slide_at(prs, n, where), step["text"], append, where)
            result = {"slides": numbers}
        elif kind == "chart":
            result = step_chart(prs, step, where)
        elif kind == "picture":
            result = step_picture(prs, step, plan, where)
        elif kind == "add_shapes":
            slide = slide_at(prs, step.get("slide"), where)
            added = [add_shape(slide, spec, plan, f"{where}: shape {k}").name for k, spec in enumerate(shapes_list(step.get("shapes"), where), 1)]
            result = {"slide": step["slide"], "added": added}
        elif kind == "delete_shape":
            result = step_delete_shape(prs, step, where)
        elif kind == "delete":
            if step.get("slides") in (None, ""):
                raise Fail(f"{where}: say which slides with \"slides\"")
            numbers = parse_slides(step["slides"], count)
            delete_slides(prs, numbers)
            result = {"deleted": sorted(set(numbers))}
        elif kind == "move":
            if step.get("slides") in (None, "") or "to" not in step:
                raise Fail(f"{where}: give \"slides\" and \"to\"")
            numbers = parse_slides(step["slides"], count)
            result = {"moved": numbers, "now_at": move_slides(prs, numbers, whole(step["to"], f"{where}: to"), where)}
        elif kind == "duplicate":
            n = whole(step.get("slide"), f"{where}: slide")
            slide_at(prs, n, where)
            to = whole(step["to"], f"{where}: to") if "to" in step else None
            result = {"copied": n, "copy_is_slide": duplicate_slide(prs, n, to, where)}
        elif kind == "hide":
            numbers = parse_slides(step.get("slides"), count)
            hidden = bool_opt(step, "hidden", True, where)
            for n in numbers:
                el = prs.slides[n - 1]._element
                if hidden:
                    el.set("show", "0")
                else:
                    el.attrib.pop("show", None)
            result = {"slides": numbers, "hidden": hidden}
        else:
            result = step_footer(prs, step, where, problems)
        done.append({"step": i, "do": kind, **result})
    return done, problems


# ---------------------------------------------------------------- new decks


SIZES = {"16:9": (12192000, 6858000), "4:3": (9144000, 6858000)}


def scale_designs(prs: Any, kx: float, ky: float) -> None:
    """Stretch the masters' and layouts' shapes to a new slide size (python-pptx's blank deck is drawn for 4:3)."""
    frames = (f"{q('p:spPr')}/{q('a:xfrm')}", f"{q('p:grpSpPr')}/{q('a:xfrm')}", q("p:xfrm"))
    owners = []
    for master in prs.slide_masters:
        owners.append(master)
        owners.extend(master.slide_layouts)
    for owner in owners:
        for shape in owner.shapes._spTree.iter_shape_elms():
            for path in frames:
                xfrm = shape.find(path)
                if xfrm is None:
                    continue
                for tag, kx_, ky_ in (("a:off", "x", "y"), ("a:ext", "cx", "cy")):
                    el = xfrm.find(q(tag))
                    if el is not None:
                        el.set(kx_, str(int(round(int(el.get(kx_)) * kx))))
                        el.set(ky_, str(int(round(int(el.get(ky_)) * ky))))


def start_deck(plan: Plan, template: str | None) -> tuple[Any, str]:
    pptx = need("pptx", "python-pptx")
    size = plan.data.get("size")
    if template:
        if size is not None:
            raise Fail("a template keeps its own slide size: take \"size\" out of the plan")
        prs, kind = open_deck(template)
        delete_slides(prs, list(range(1, len(prs.slides) + 1)))
        for lst in list(prs.part._element.iter(f"{{{P14}}}sectionLst")):
            ext = lst.getparent()
            ext.getparent().remove(ext)  # the template's sections held its sample slides
        return prs, kind
    prs = pptx.Presentation()
    if size is None:
        size = "16:9"
    if isinstance(size, str) and size in SIZES:
        w, h = SIZES[size]
    elif isinstance(size, list) and len(size) == 2:
        w, h = length(size[0], "size", True), length(size[1], "size", True)
        if not (UNITS["in"] <= w and UNITS["in"] <= h):
            raise Fail("size: a slide is at least 1 inch each way")
    else:
        raise Fail('size is "16:9", "4:3" or [width, height] in inches')
    old_w, old_h = prs.slide_width, prs.slide_height
    prs.slide_width, prs.slide_height = w, h
    scale_designs(prs, w / old_w, h / old_h)
    props = prs.core_properties
    props.last_modified_by, props.comments = "", ""
    now = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None, microsecond=0)
    props.created, props.revision = now, 1
    return prs, "pptx"


def set_properties(prs: Any, plan: Plan) -> None:
    props = plan.data.get("properties", {})
    if not isinstance(props, dict) or set(props) - {"title", "author", "subject", "keywords"}:
        raise Fail('"properties" is an object with any of title, author, subject, keywords')
    core = prs.core_properties
    for key, value in props.items():
        if not isinstance(value, str):
            raise Fail(f"properties: {key} is text")
        setattr(core, key, value)
    core.modified = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None, microsecond=0)


def check_output(out: str, kind: str, inputs: list[str], overwrite: bool) -> None:
    for src in inputs:
        if same_file(out, src) and not overwrite:
            raise Fail(f"won't write over {src}: give another output path, or add --overwrite to replace it")
    want = ".pptm" if kind in MACRO_KINDS else ".pptx"
    if os.path.splitext(out)[1].lower() != want:
        why = "the deck has macros, which only a .pptm keeps" if want == ".pptm" else "it's a PowerPoint presentation"
        raise Fail(f"-o should end in {want}: {why}")
    if os.path.isdir(out):
        raise Fail(f"-o names a folder, not a file: {out}")
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)


def finish(prs: Any, plan: Plan, out: str, extra: dict[str, Any]) -> int:
    set_properties(prs, plan)
    done, problems = run_steps(prs, plan)
    renumber(prs)
    write_atomic(out, prs.save)
    result = {"out": out, "slides": len(prs.slides), **extra, "steps": done, "ok": not problems, "problems": problems}
    emit(result)
    return 1 if problems else 0


def cmd_new(args: argparse.Namespace) -> int:
    plan = Plan(args.plan)
    prs, kind = start_deck(plan, args.template)
    inputs = [args.plan] + ([args.template] if args.template else []) + plan.files()
    check_output(args.out, kind, inputs, args.overwrite)
    extra = {"template": args.template} if args.template else {"size_in": [round(prs.slide_width / EMU_PER_INCH, 2), round(prs.slide_height / EMU_PER_INCH, 2)]}
    return finish(prs, plan, args.out, extra)


def cmd_edit(args: argparse.Namespace) -> int:
    plan = Plan(args.plan)
    if "size" in plan.data:
        raise Fail("\"size\" is only for new decks: an edit keeps the deck's size")
    prs, kind = open_deck(args.deck)
    check_output(args.out, kind, [args.deck, args.plan] + plan.files(), args.overwrite)
    return finish(prs, plan, args.out, {"from": args.deck})


def main(argv: list[str] | None = None) -> int:
    utf8_output()
    parser = Parser(prog="pptx_deck.py", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", metavar="COMMAND")
    sp = sub.add_parser("new", help="make a new deck from a plan", description="Make a new deck from a plan, on a plain design or a template's layouts.",
                        epilog="example:\n  python pptx_deck.py new plan.json -o deck.pptx --template brand.potx",
                        formatter_class=argparse.RawDescriptionHelpFormatter)
    sp.add_argument("plan", help="the JSON plan (see pptx_deck.py --help)")
    sp.add_argument("-o", "--out", required=True, help="the deck to write (.pptx)")
    sp.add_argument("--template", help="a .potx or .pptx whose design and layouts the slides use (its own slides are left out)")
    sp.add_argument("--overwrite", action="store_true", help="allow the output to replace the template or a file the plan uses")
    sp.set_defaults(func=cmd_new)
    sp = sub.add_parser("edit", help="change a deck by a plan, into a new file", description="Change a deck by a plan; the result goes to a new file.",
                        epilog="example:\n  python pptx_deck.py edit deck.pptx changes.json -o deck-v2.pptx",
                        formatter_class=argparse.RawDescriptionHelpFormatter)
    sp.add_argument("deck", help="the deck to change (.pptx, .pptm, .potx, .ppsx)")
    sp.add_argument("plan", help="the JSON plan (see pptx_deck.py --help)")
    sp.add_argument("-o", "--out", required=True, help="the deck to write (.pptx, or .pptm for a deck with macros)")
    sp.add_argument("--overwrite", action="store_true", help="allow the output to replace the deck itself (make a backup first)")
    sp.set_defaults(func=cmd_edit)
    args = parser.parse_args(argv)
    if not getattr(args, "func", None):
        parser.error("needs a command, new or edit")
    return run_job(f"pptx_deck.py {args.command}", lambda: args.func(args))


if __name__ == "__main__":
    sys.exit(main())
