#!/usr/bin/env python3
"""Look inside PowerPoint decks and check them: info, outline, check, images, render.

Packages: python-pptx 1.0 or newer (it brings lxml and Pillow); pypdfium2 for render. render also needs LibreOffice
and soffice.py, which sits beside this script.

Slides are numbered from 1 everywhere: "1-3,7,10-" means slides 1 to 3, slide 7, and slide 10 to the end; leaving out
--slides means every slide. Positions and sizes are in inches. Opens .pptx, .pptm, .potx and .ppsx files; an old
binary .ppt has to be converted first (python soffice.py convert old.ppt --to pptx -o old.pptx).

Results are printed on stdout as JSON. Exit codes: 0 done; 1 check found problems (listed in the JSON); 2 the command
couldn't do its job, and one line on stderr says why.
"""

from __future__ import annotations

import argparse
import codecs
import hashlib
import importlib
import io
import json
import locale
import logging
import os
import re
import shutil
import signal
import struct
import subprocess
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


# ---------------------------------------------------------------- what's on a slide


GRAPHIC_KINDS = {
    "http://schemas.openxmlformats.org/drawingml/2006/chart": "chart",
    "http://schemas.openxmlformats.org/drawingml/2006/table": "table",
    "http://schemas.openxmlformats.org/drawingml/2006/diagram": "smartart",
    "http://schemas.openxmlformats.org/presentationml/2006/ole": "embedded object",
}
FOOTER_TYPES = ("DATE", "FOOTER", "SLIDE_NUMBER", "HEADER")
TITLE_TYPES = ("TITLE", "CENTER_TITLE", "VERTICAL_TITLE")


def inches(emu: float) -> float:
    return round(emu / EMU_PER_INCH, 2)


def box_in(box: Any) -> list[float] | None:
    return None if box is None else [inches(v) for v in box]


def ph_type(shape: Any) -> str | None:
    if not getattr(shape, "is_placeholder", False):
        return None
    try:
        return shape.placeholder_format.type.name
    except Exception:
        return "OBJECT"


def kind_of(shape: Any) -> str:
    el = shape._element
    tag = el.tag
    if tag == q("p:grpSp"):
        return "group"
    if tag == q("p:cxnSp"):
        return "line"
    if tag == q("p:contentPart"):
        return "ink"
    if tag == q("p:pic"):
        nv = el.find(f"{q('p:nvPicPr')}/{q('p:nvPr')}")
        if nv is not None and (nv.find(q("a:videoFile")) is not None or nv.find(q("a:audioFile")) is not None
                               or nv.find(f"{q('p:extLst')}") is not None and b"media" in _xml(nv)):
            return "media"
        return "picture"
    if tag == q("p:graphicFrame"):
        data = el.find(f"{q('a:graphic')}/{q('a:graphicData')}")
        uri = data.get("uri", "") if data is not None else ""
        return GRAPHIC_KINDS.get(uri, "chart (newer kind)" if "chartex" in uri else "other")
    if tag == q("p:sp"):
        if getattr(shape, "is_placeholder", False):
            return "title" if ph_type(shape) in TITLE_TYPES else "placeholder"
        nv = el.find(f"{q('p:nvSpPr')}/{q('p:cNvSpPr')}")
        return "text" if nv is not None and nv.get("txBox") == "1" else "shape"
    return "other"


def _xml(el: Any) -> bytes:
    from lxml import etree

    return etree.tostring(el)


def paragraphs_text(txbody: Any) -> str:
    """The text of a txBody, paragraphs on their own lines, line breaks inside a paragraph as spaces."""
    lines = []
    for p in txbody.iter(q("a:p")):
        parts = []
        for child in p:
            if child.tag in (q("a:r"), q("a:fld")):
                t = child.find(q("a:t"))
                parts.append(t.text or "" if t is not None else "")
            elif child.tag == q("a:br"):
                parts.append(" ")
        lines.append("".join(parts))
    return "\n".join(lines).strip("\n")


def table_rows(shape: Any) -> list[list[str]]:
    rows = []
    for tr in shape._element.iter(q("a:tr")):
        rows.append([paragraphs_text(tc.find(q("a:txBody"))) if tc.find(q("a:txBody")) is not None else ""
                     for tc in tr.iter(q("a:tc"))])
    return rows


def chart_info(shape: Any) -> dict[str, Any]:
    chart = shape.chart
    info: dict[str, Any] = {}
    try:
        info["type"] = chart.chart_type.name
    except Exception:
        info["type"] = "unknown"
    try:
        if chart.has_title and chart.chart_title.has_text_frame:
            info["title"] = chart.chart_title.text_frame.text
    except Exception:
        pass
    plots = list(chart.plots)
    xy = info["type"].startswith(("XY_", "BUBBLE"))
    if plots and not xy:
        cats = plots[0].categories
        info["categories"] = [str(c) for c in cats]
        if cats.depth > 1:
            info["category_levels"] = cats.depth
    series = []
    c = "{http://schemas.openxmlformats.org/drawingml/2006/chart}"
    for plot in plots:
        for s in plot.series:
            entry: dict[str, Any] = {"name": s.name}
            try:
                if xy:  # python-pptx reads only the y values of an x-y series; the x values are beside them
                    xs = {int(pt.get("idx")): pt.findtext(f"{c}v") for pt in s._element.iterfind(f"{c}xVal//{c}pt")}
                    entry["points"] = [[float(xs[i]) if xs.get(i) is not None else None, y] for i, y in enumerate(s.values)]
                else:
                    entry["values"] = list(s.values)
            except Exception:
                entry["values"] = None
            series.append(entry)
    info["series"] = series
    if xy:
        info["edit"] = "whole data only (x-y points)" if info["type"].startswith("XY_") else "no (bubble chart)"
    elif info.get("category_levels"):
        info["edit"] = "whole data only (categories in levels)"
    else:
        info["edit"] = "values, series, categories, title"
    return info


def smartart_text(slide: Any, shape: Any) -> list[str]:
    from lxml import etree

    rel = shape._element.find(f".//{q('dgm:relIds')}")
    rid = rel.get(q("r:dm")) if rel is not None else None
    if not rid:
        return []
    try:
        root = etree.fromstring(slide.part.related_part(rid).blob, etree.XMLParser(resolve_entities=False, no_network=True))
    except Exception:
        return []
    out = []
    for pt in root.iter(q("dgm:pt")):
        t = pt.find(q("dgm:t"))
        if t is not None:
            text = paragraphs_text(t)
            if text.strip():
                out.append(text)
    return out


def newer_content(slide: Any) -> list[dict[str, Any]]:
    """Content python-pptx skips: what PowerPoint wraps for newer features (waterfall charts, 3D models, zooms)."""
    found = []
    for alt in slide.shapes._spTree.iter(q("mc:AlternateContent")):
        texts = [t.text for t in alt.iter(q("a:t")) if t.text and t.text.strip()]
        entry: dict[str, Any] = {"kind": "newer content (a waterfall chart, 3D model, zoom...)", "editable": False}
        if texts:
            entry["text"] = " ".join(texts)
        found.append(entry)
    return found


def slide_title(slide: Any) -> str:
    for shape in slide.placeholders:
        if ph_type(shape) in TITLE_TYPES and shape.has_text_frame:
            return shape.text_frame.text.strip()
    return ""


def notes_text(slide: Any) -> str:
    if not slide.has_notes_slide:
        return ""
    frame = slide.notes_slide.notes_text_frame
    return frame.text.strip() if frame is not None else ""


def slide_record(prs: Any, n: int, slide: Any) -> dict[str, Any]:
    shapes = []
    words = 0
    for shape, box, group in iter_shapes(slide.shapes):
        kind = kind_of(shape)
        entry: dict[str, Any] = {"id": shape.shape_id, "name": shape.name, "kind": kind}
        if group:
            entry["in_group"] = group
        ptype = ph_type(shape)
        if ptype:
            entry["placeholder"] = {"idx": shape.placeholder_format.idx, "type": ptype}
        entry["box_in"] = box_in(box)
        if shape._element.tag == q("p:sp") and shape.has_text_frame:
            text = paragraphs_text(shape._element.find(q("p:txBody")))
            entry["text"] = text
            words += len(text.split())
            fit = shape._element.find(f".//{q('a:normAutofit')}")
            if fit is not None and fit.get("fontScale"):
                entry["shrunk_to_percent"] = round(int(fit.get("fontScale")) / 1000)
            sizes = [int(r.get("sz")) / 100 for r in shape._element.iter(q("a:rPr")) if r.get("sz")]
            if sizes:
                entry["smallest_set_size_pt"] = min(sizes)
        elif kind == "table":
            entry["rows"] = table_rows(shape)
            words += sum(len(c.split()) for row in entry["rows"] for c in row)
        elif kind == "chart":
            try:
                entry["chart"] = chart_info(shape)
            except Exception as e:
                entry["chart"] = {"error": f"can't read this chart ({type(e).__name__})"}
        elif kind == "smartart":
            entry["text"] = smartart_text(slide, shape)
            entry["note"] = "SmartArt: pptx_deck.py replace changes its words; anything else is edited in PowerPoint"
        elif kind in ("picture", "media"):
            cnv = shape._element.find(f".//{q('p:cNvPr')}")
            entry["alt"] = (cnv.get("descr") or "") if cnv is not None else ""
            try:
                image = shape.image
                entry["image"] = {"type": image.ext, "pixels": list(image.size), "bytes": len(image.blob)}
            except Exception:
                entry["image"] = None  # a linked picture, or a placeholder still waiting for one
        shapes.append(entry)
    shapes += newer_content(slide)
    record: dict[str, Any] = {
        "slide": n,
        "id": slide.slide_id,
        "layout": slide.slide_layout.name,
        "title": slide_title(slide),
        "hidden": slide._element.get("show") == "0",
        "words": words,
        "shapes": shapes,
        "notes": notes_text(slide),
    }
    return record


# ---------------------------------------------------------------- fonts


METRIC_TWINS = {
    # fonts LibreOffice draws in place of Microsoft ones, with the same letter widths, so lines break the same way
    "calibri": "Carlito", "cambria": "Caladea", "arial": "Liberation Sans", "times new roman": "Liberation Serif",
    "courier new": "Liberation Mono", "arial narrow": "Liberation Sans Narrow",
}


def font_dirs() -> list[str]:
    home = os.path.expanduser("~")
    if sys.platform == "win32":
        windir = os.environ.get("WINDIR", r"C:\Windows")
        local = os.environ.get("LOCALAPPDATA", os.path.join(home, "AppData", "Local"))
        return [os.path.join(windir, "Fonts"), os.path.join(local, "Microsoft", "Windows", "Fonts")]
    if sys.platform == "darwin":
        return ["/System/Library/Fonts", "/Library/Fonts", os.path.join(home, "Library", "Fonts")]
    return ["/usr/share/fonts", "/usr/local/share/fonts", os.path.join(home, ".local", "share", "fonts"), os.path.join(home, ".fonts")]


def font_families(path: str) -> set[str]:
    """Family and full names in a .ttf, .otf or .ttc file (from its name table), lower-case."""
    names: set[str] = set()
    with open(path, "rb") as fh:
        head = fh.read(12)
        starts = [0]
        if head[:4] == b"ttcf" and len(head) == 12:
            count = min(struct.unpack(">I", head[8:12])[0], 64)
            starts = list(struct.unpack(f">{count}I", fh.read(4 * count)))
        for start in starts:
            fh.seek(start)
            top = fh.read(12)
            if len(top) < 12 or top[:4] not in (b"\x00\x01\x00\x00", b"OTTO", b"true"):
                continue
            tables = struct.unpack(">H", top[4:6])[0]
            records = fh.read(16 * tables)
            for i in range(len(records) // 16):
                tag, _, offset, length = struct.unpack(">4sIII", records[16 * i:16 * i + 16])
                if tag != b"name":
                    continue
                fh.seek(offset)
                data = fh.read(length)
                if len(data) < 6:
                    break
                _, count, strings = struct.unpack(">HHH", data[:6])
                for j in range(count):
                    rec = data[6 + 12 * j:18 + 12 * j]
                    if len(rec) < 12:
                        break
                    platform, encoding, _, name_id, size, at = struct.unpack(">HHHHHH", rec)
                    if name_id not in (1, 4, 16):  # family, full name, typographic family
                        continue
                    raw = data[strings + at:strings + at + size]
                    if platform in (0, 3):
                        names.add(raw.decode("utf-16-be", "replace").strip().lower())
                    elif platform == 1 and encoding == 0:
                        names.add(raw.decode("mac_roman", "replace").strip().lower())
                break
    return names


def installed_fonts(folders: list[str] | None = None) -> set[str]:
    """Names of the fonts in these folders (default: the system's font folders)."""
    found: set[str] = set()
    for folder in font_dirs() if folders is None else folders:
        for root, _, files in os.walk(folder):
            for name in files:
                if name.lower().endswith((".ttf", ".otf", ".ttc", ".otc")):
                    try:
                        found |= font_families(os.path.join(root, name))
                    except (OSError, struct.error):
                        pass
    return found


def theme_fonts(prs: Any) -> dict[str, str]:
    """{'heading': 'Calibri Light', 'body': 'Calibri'} from the first master's theme."""
    from lxml import etree

    out: dict[str, str] = {}
    for master in prs.slide_masters:
        for rel in master.part.rels.values():
            if rel.reltype.endswith("/theme") and not rel.is_external:
                root = etree.fromstring(rel.target_part.blob, etree.XMLParser(resolve_entities=False, no_network=True))
                for role, tag in (("heading", "a:majorFont"), ("body", "a:minorFont")):
                    latin = root.find(f".//{q(tag)}/{q('a:latin')}")
                    if latin is not None and latin.get("typeface"):
                        out.setdefault(role, latin.get("typeface"))
        break
    return out


def theme_colors(prs: Any) -> dict[str, str]:
    """The first master's theme colours as hex: the dark and light pairs, the six accents (which charts and new shapes
    use in turn) and the link colours."""
    from lxml import etree

    out: dict[str, str] = {}
    for master in prs.slide_masters:
        for rel in master.part.rels.values():
            if rel.reltype.endswith("/theme") and not rel.is_external:
                root = etree.fromstring(rel.target_part.blob, etree.XMLParser(resolve_entities=False, no_network=True))
                scheme = root.find(f".//{q('a:clrScheme')}")
                for slot in scheme if scheme is not None else []:
                    if not isinstance(slot.tag, str):
                        continue
                    for value in slot:
                        hex_ = value.get("val") if value.tag == q("a:srgbClr") else value.get("lastClr")
                        if hex_:
                            out[etree.QName(slot).localname] = f"#{hex_.upper()}"
        break
    return out


def deck_fonts(prs: Any) -> dict[str, dict[str, Any]]:
    """Every font the deck's text is set in: the theme's, and those set on text in slides, layouts and masters.
    East Asian and complex-script fonts count only on runs that hold such letters."""
    fonts: dict[str, dict[str, Any]] = {}
    for role, name in theme_fonts(prs).items():
        fonts.setdefault(name, {"font": name, "where": []})["where"].append(f"theme {role}")

    def scan(root: Any, where: str) -> None:
        for run in root.iter(q("a:r")):
            rpr = run.find(q("a:rPr"))
            if rpr is None:
                continue
            t = run.find(q("a:t"))
            text = (t.text or "") if t is not None else ""
            wide = any(ord(c) >= 0x370 for c in text)
            for tag in ("a:latin", "a:ea", "a:cs"):
                el = rpr.find(q(tag))
                face = el.get("typeface", "") if el is not None else ""
                if not face or face.startswith("+") or (tag != "a:latin" and not wide):
                    continue
                entry = fonts.setdefault(face, {"font": face, "where": []})
                if where not in entry["where"]:
                    entry["where"].append(where)

    for n, slide in enumerate(prs.slides, 1):
        scan(slide._element, f"slide {n}")
    for m, master in enumerate(prs.slide_masters, 1):
        scan(master._element, f"master {m}")
        for layout in master.slide_layouts:
            scan(layout._element, f"layout {layout.name}")
    return fonts


def font_report(prs: Any) -> list[dict[str, Any]]:
    """The deck's fonts, whether each is installed here, and the same-width font LibreOffice uses for a missing one."""
    have = installed_fonts()
    out = []
    for name, entry in deck_fonts(prs).items():
        entry["installed"] = name.lower() in have
        if not entry["installed"] and name.lower() in METRIC_TWINS:
            entry["twin"] = METRIC_TWINS[name.lower()]
        out.append(entry)
    return out


# ---------------------------------------------------------------- info


def sections(prs: Any) -> list[dict[str, Any]]:
    numbers = {sid.get("id"): n for n, sid in enumerate(prs.slides._sldIdLst, 1)}
    out = []
    for section in prs.part._element.iter("{http://schemas.microsoft.com/office/powerpoint/2010/main}section"):
        ids = [el.get("id") for el in section.iter("{http://schemas.microsoft.com/office/powerpoint/2010/main}sldId")]
        out.append({"name": section.get("name", ""), "slides": [numbers[i] for i in ids if i in numbers]})
    return out


def ratio(w: int, h: int) -> str:
    for name, (a, b) in (("16:9", (16, 9)), ("4:3", (4, 3)), ("16:10", (16, 10))):
        if abs(w / h - a / b) < 0.01:
            return name
    return f"{inches(w)} x {inches(h)} in"


def layouts(prs: Any) -> list[dict[str, Any]]:
    used: dict[int, list[int]] = {}
    for n, slide in enumerate(prs.slides, 1):
        used.setdefault(id(slide.slide_layout.part), []).append(n)
    out = []
    number = 0
    for m, master in enumerate(prs.slide_masters, 1):
        for layout in master.slide_layouts:
            number += 1
            phs = []
            for ph in layout.placeholders:
                fmt = ph.placeholder_format
                phs.append({"idx": fmt.idx, "type": fmt.type.name if fmt.type is not None else "OBJECT",
                            "name": ph.name, "box_in": box_in((ph.left, ph.top, ph.width, ph.height)) if ph.width is not None else None})
            out.append({"layout": number, "name": layout.name, "master": m, "used_by_slides": used.get(id(layout.part), []),
                        "placeholders": phs})
    return out


def layout_text(prs: Any) -> list[dict[str, str]]:
    """Text on masters and layouts outside placeholders (a 'Confidential' line, a company name): it shows on slides
    but isn't on them, so editing the slides doesn't change it."""
    out = []
    for m, master in enumerate(prs.slide_masters, 1):
        places = [(f"master {m}", master)] + [(f"layout {layout.name}", layout) for layout in master.slide_layouts]
        for where, owner in places:
            for shape, _, _ in iter_shapes(owner.shapes):
                if getattr(shape, "is_placeholder", False) or shape._element.tag != q("p:sp") or not shape.has_text_frame:
                    continue
                text = shape.text_frame.text.strip()
                if text:
                    out.append({"where": where, "shape": shape.name, "text": text})
    return out


def cmd_info(args: argparse.Namespace) -> int:
    prs, kind = open_deck(args.file)
    hidden = [n for n, s in enumerate(prs.slides, 1) if s._element.get("show") == "0"]
    w, h = prs.slide_width, prs.slide_height
    result: dict[str, Any] = {
        "file": args.file,
        "kind": kind,
        "macros": kind in MACRO_KINDS,
        "slides": len(prs.slides),
        "hidden_slides": hidden,
        "size": {"width_in": inches(w), "height_in": inches(h), "shape": ratio(w, h)},
        "layouts": layouts(prs),
        "fonts": font_report(prs),
        "theme_colors": theme_colors(prs),
        "sections": sections(prs),
        "text_on_layouts": layout_text(prs),
    }
    props = prs.core_properties
    result["properties"] = {"title": props.title, "author": props.author, "subject": props.subject}
    if kind not in ("pptx", "pptm"):
        result["note"] = f"a .{kind} file: what the scripts save from it is a .{'pptm' if kind in MACRO_KINDS else 'pptx'} presentation"
    emit(result)
    return 0


# ---------------------------------------------------------------- outline


def cmd_outline(args: argparse.Namespace) -> int:
    prs, _ = open_deck(args.file)
    slides = list(prs.slides)
    wanted = parse_slides(args.slides, len(slides))
    records = [slide_record(prs, n, slides[n - 1]) for n in wanted]
    result: dict[str, Any] = {"file": args.file, "slide_count": len(slides),
                              "size_in": [inches(prs.slide_width), inches(prs.slide_height)]}
    if args.out:
        if same_file(args.out, args.file):
            raise Fail(f"won't write over the deck {args.file}: give --out another name")
        os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
        body = json.dumps({**result, "slides": records}, ensure_ascii=False, indent=2).encode("utf-8")
        write_atomic(args.out, lambda fh: fh.write(body))
        result["out"] = args.out
        result["slides"] = [{"slide": r["slide"], "title": r["title"], "layout": r["layout"], "words": r["words"]} for r in records]
    else:
        result["slides"] = records
    emit(result)
    return 0


# ---------------------------------------------------------------- check


def check_slide(prs: Any, n: int, slide: Any) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    problems: list[dict[str, Any]] = []
    notes: list[dict[str, Any]] = []
    sw, sh = prs.slide_width, prs.slide_height
    if not slide_title(slide):
        notes.append({"slide": n, "note": "no slide title (screen readers and the slide list use it)"})
    for shape, box, _ in iter_shapes(slide.shapes):
        name = f"{shape.name} (id {shape.shape_id})"
        el = shape._element
        has_text = el.tag == q("p:sp") and shape.has_text_frame
        text = paragraphs_text(el.find(q("p:txBody"))) if has_text else ""
        ptype = ph_type(shape)
        if ptype and el.tag == q("p:sp") and not text.strip() and ptype not in FOOTER_TYPES:
            problems.append({"slide": n, "shape": name, "problem": "empty placeholder: PowerPoint shows a 'click to add' prompt in it; fill it or delete it"})
        for token in TOKEN.findall(text):
            problems.append({"slide": n, "shape": name, "problem": f"unfilled {{{{{token}}}}}"})
        if el.tag == q("p:graphicFrame") and kind_of(shape) == "table":
            for row in table_rows(shape):
                for cell in row:
                    for token in TOKEN.findall(cell):
                        problems.append({"slide": n, "shape": name, "problem": f"unfilled {{{{{token}}}}} in the table"})
        if box is not None:
            x, y, w, h = box
            outside = x < 0 or y < 0 or x + w > sw or y + h > sh
            gone = x >= sw or y >= sh or x + w <= 0 or y + h <= 0
            if gone:
                problems.append({"slide": n, "shape": name, "problem": "entirely off the slide"})
            elif outside and text.strip():
                problems.append({"slide": n, "shape": name, "problem": "text box reaches past the slide edge"})
            elif outside:
                notes.append({"slide": n, "shape": name, "note": "reaches past the slide edge (fine for a picture that bleeds off on purpose)"})
        if has_text:
            fit = el.find(f".//{q('a:normAutofit')}")
            if fit is not None and fit.get("fontScale") and int(fit.get("fontScale")) < 100000:
                notes.append({"slide": n, "shape": name, "note": f"PowerPoint shrank this text to {round(int(fit.get('fontScale')) / 1000)}% to fit: likely too much text for the box"})
        if kind_of(shape) == "picture":
            cnv = el.find(f".//{q('p:cNvPr')}")
            decorative = cnv is not None and b"decorative" in _xml(cnv) and b'val="1"' in _xml(cnv)
            if cnv is not None and not (cnv.get("descr") or "").strip() and not decorative:
                notes.append({"slide": n, "shape": name, "note": "picture without alt text"})
    for token in TOKEN.findall(notes_text(slide)):
        problems.append({"slide": n, "shape": "speaker notes", "problem": f"unfilled {{{{{token}}}}}"})
    if slide._element.get("show") == "0":
        notes.append({"slide": n, "note": "hidden: not shown in the slide show"})
    return problems, notes


def cmd_check(args: argparse.Namespace) -> int:
    prs, _ = open_deck(args.file)
    slides = list(prs.slides)
    wanted = parse_slides(args.slides, len(slides))
    problems: list[dict[str, Any]] = []
    notes: list[dict[str, Any]] = []
    for n in wanted:
        p, nt = check_slide(prs, n, slides[n - 1])
        problems += p
        notes += nt
    for f in font_report(prs):
        if not f["installed"]:
            twin = f"; LibreOffice draws it with {f['twin']}, which has the same letter widths, when it has that font" if f.get("twin") else ""
            notes.append({"font": f["font"], "note": f"not installed here: PowerPoint on this computer and the renders use a substitute{twin}"})
    emit({"file": args.file, "slides_checked": len(wanted), "ok": not problems, "problems": problems, "notes": notes})
    return 1 if problems else 0


# ---------------------------------------------------------------- images


def free_path(folder: str, name: str, taken: set[str]) -> str:
    """folder/name, or folder/name_2 and so on when that file exists already or another name in this run took it
    (compared without case, as Windows and macOS do)."""
    stem, ext = os.path.splitext(name)
    candidate, n = name, 1
    while candidate.lower() in taken or os.path.lexists(os.path.join(folder, candidate)):
        n += 1
        candidate = f"{stem}_{n}{ext}"
    taken.add(candidate.lower())
    return os.path.join(folder, candidate)


def cmd_images(args: argparse.Namespace) -> int:
    prs, _ = open_deck(args.file)
    slides = list(prs.slides)
    wanted = parse_slides(args.slides, len(slides))
    os.makedirs(args.out_dir, exist_ok=True)
    saved: dict[str, dict[str, Any]] = {}
    taken: set[str] = set()
    for n in wanted:
        for k, (shape, _, _) in enumerate(iter_shapes(slides[n - 1].shapes), 1):
            if shape._element.tag != q("p:pic"):
                continue
            try:
                image = shape.image
            except Exception:
                continue  # linked, or a picture placeholder with nothing in it
            digest = hashlib.sha1(image.blob).hexdigest()
            if digest in saved:
                if n not in saved[digest]["slides"]:
                    saved[digest]["slides"].append(n)
                continue
            ext = re.sub(r"[^a-z0-9]", "", str(image.ext).lower()) or "bin"
            path = free_path(args.out_dir, f"slide{n}_{shape.shape_id}.{ext}", taken)
            write_atomic(path, lambda fh, b=image.blob: fh.write(b))
            saved[digest] = {"file": path, "slides": [n], "shape": shape.name, "pixels": list(image.size)}
    emit({"file": args.file, "images": list(saved.values())})
    return 0


# ---------------------------------------------------------------- render


HIDDEN_TOO = 'pdf:impress_pdf_Export:{"ExportHiddenSlides":{"type":"boolean","value":"true"}}'


def libreoffice_font_dirs(soffice: str) -> list[str]:
    """The fonts LibreOffice brings with it (Carlito, Liberation...), beside its program folder."""
    program = os.path.dirname(os.path.realpath(soffice))
    return [d for d in (os.path.join(program, "..", "share", "fonts"), os.path.join(program, "..", "Resources", "fonts"))
            if os.path.isdir(d)]


def run_soffice(args: argparse.Namespace, to: str, pdf: str) -> tuple[int, str, str]:
    helper = os.path.join(os.path.dirname(os.path.abspath(__file__)), "soffice.py")
    if not os.path.isfile(helper):
        raise Fail(f"render needs soffice.py beside this script ({helper})")
    cmd = [sys.executable, helper, "convert", args.file, "--to", to, "-o", pdf, "--timeout", str(args.timeout)]
    if args.soffice:
        cmd += ["--soffice", args.soffice]
    extra = {"start_new_session": True} if sys.platform != "win32" else {}
    proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **extra)
    try:
        out, err = proc.communicate(timeout=args.timeout + 60)
    except subprocess.TimeoutExpired:
        if sys.platform == "win32":
            subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True, timeout=30)
        else:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                proc.kill()
        proc.wait(timeout=10)
        raise Fail(f"LibreOffice didn't finish within {args.timeout:g} seconds; try a larger --timeout") from None
    return proc.returncode, out.decode("utf-8", "replace"), err.decode("utf-8", "replace")


def cmd_render(args: argparse.Namespace) -> int:
    if not 100 <= args.width <= 8000:
        raise Fail("--width is the picture width in pixels, from 100 to 8000")
    if not args.timeout > 0:
        raise Fail("--timeout is a number of seconds above 0")
    pdfium = need("pypdfium2", "pypdfium2", "to turn the slides into pictures")
    prs, _ = open_deck(args.file)
    slides = list(prs.slides)
    total = len(slides)
    if total == 0:
        raise Fail(f"{args.file} has no slides to draw")
    wanted = parse_slides(args.slides, total)
    hidden = [n for n, s in enumerate(slides, 1) if s._element.get("show") == "0"]
    if os.path.exists(args.out_dir) and not os.path.isdir(args.out_dir):
        raise Fail(f"--out-dir names a file, not a folder: {args.out_dir}")
    os.makedirs(args.out_dir, exist_ok=True)
    work = tempfile.mkdtemp(prefix=".pptx_tool-", dir=args.out_dir)
    try:
        pdf = os.path.join(work, "slides.pdf")
        code, out, err = run_soffice(args, HIDDEN_TOO if hidden else "pdf", pdf)
        if code != 0 and hidden:  # an older LibreOffice that doesn't take the option: draw the shown slides only
            code, out, err = run_soffice(args, "pdf", pdf)
        if code != 0:
            line = (err.strip().splitlines() or ["soffice.py failed without saying why"])[-1]
            raise Fail(line.split(": ", 1)[1] if line.startswith("soffice.py ") and ": " in line else line)
        soffice = json.loads(out).get("soffice", "") if out.strip().startswith("{") else ""
        doc = pdfium.PdfDocument(pdf)
        try:
            pages = len(doc)
            if pages == total:
                page_of = {n: n for n in range(1, total + 1)}
                not_drawn: list[int] = []
            elif pages == total - len(hidden):
                shown = [n for n in range(1, total + 1) if n not in hidden]
                page_of = {n: i for i, n in enumerate(shown, 1)}
                not_drawn = hidden
            else:
                raise Fail(f"LibreOffice drew {pages} pages for {total} slides, so pages can't be matched to slides")
            stem = os.path.splitext(os.path.basename(args.file))[0]
            digits = len(str(total))
            fmt = "JPEG" if args.format == "jpg" else "PNG"
            files = []
            for n in wanted:
                if n not in page_of:
                    continue
                page = doc[page_of[n] - 1]
                try:
                    image = page.render(scale=args.width / page.get_width()).to_pil().convert("RGB")
                finally:
                    page.close()
                path = os.path.join(args.out_dir, f"{stem}_slide{n:0{digits}d}.{args.format}")
                write_atomic(path, lambda fh, im=image: im.save(fh, format=fmt, **({"quality": 90} if fmt == "JPEG" else {})))
                files.append({"slide": n, "file": path, "width_px": image.width, "height_px": image.height})
        finally:
            doc.close()
    finally:
        shutil.rmtree(work, ignore_errors=True)
    result: dict[str, Any] = {"file": args.file, "drawn_by": "LibreOffice, pages split with pypdfium2", "files": files}
    skipped = [n for n in wanted if n in not_drawn]
    if skipped:
        result["not_drawn"] = skipped
        result["note"] = "this LibreOffice leaves hidden slides out; show them for a moment to look at them"
    # what LibreOffice can draw with: the system's fonts and its own (a Linux package may keep Carlito with the system's)
    bundled = installed_fonts() | (installed_fonts(libreoffice_font_dirs(soffice)) if soffice else set())
    substituted = []
    for f in font_report(prs):
        if f["installed"] or f["font"].lower() in bundled:
            continue
        if f.get("twin") and f["twin"].lower() in bundled:
            substituted.append({"font": f["font"], "drawn_with": f["twin"], "same_widths": True})
        else:
            substituted.append({"font": f["font"], "drawn_with": "a substitute LibreOffice picked", "same_widths": False})
    if substituted:
        result["fonts_substituted"] = substituted
        if any(not s["same_widths"] for s in substituted):
            result["font_note"] = ("text in a substitute font has other widths: line breaks and overflow in these "
                                   "pictures may differ from what PowerPoint shows with the real font")
    emit(result)
    return 0


# ---------------------------------------------------------------- command line


def build_parser() -> argparse.ArgumentParser:
    p = Parser(prog="pptx_tool.py", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="command", metavar="COMMAND")

    def add(name: str, func: Callable[[argparse.Namespace], int], help_text: str, example: str) -> argparse.ArgumentParser:
        sp = sub.add_parser(name, help=help_text, description=help_text, epilog=f"example:\n  {example}",
                            formatter_class=argparse.RawDescriptionHelpFormatter)
        sp.set_defaults(func=func)
        sp.add_argument("file", help="the deck (.pptx, .pptm, .potx, .ppsx)")
        return sp

    add("info", cmd_info, "Slide size and count, hidden slides, every layout with its placeholders (idx, type, box), "
        "the fonts the text uses and whether they're installed, the theme's colours, sections, and text on masters "
        "and layouts.",
        "python pptx_tool.py info brand-template.potx")

    sp = add("outline", cmd_outline, "What each slide holds: layout, title, every shape (id, name, kind, box, text; "
             "groups opened), tables, chart data, pictures and alt text, speaker notes, word count.",
             "python pptx_tool.py outline deck.pptx --slides 2-4")
    sp.add_argument("--slides", help="slides to read, like 1-3,7 (default: all)")
    sp.add_argument("--out", help="write the whole outline to this JSON file and print only a summary per slide")

    sp = add("check", cmd_check, "Mechanical problems: empty placeholders, unfilled {{tokens}}, text past the slide "
             "edge, shapes off the slide (exit 1 when any); and notes: shrunk text, missing titles and alt text, "
             "fonts not installed, hidden slides.", "python pptx_tool.py check deck.pptx")
    sp.add_argument("--slides", help="slides to check, like 1-3,7 (default: all)")

    sp = add("images", cmd_images, "Save the pictures in the slides, each once, at their own resolution.",
             "python pptx_tool.py images deck.pptx --out-dir pictures")
    sp.add_argument("--out-dir", required=True, help="folder for slide<N>_<shape id>.<ext>")
    sp.add_argument("--slides", help="slides to take pictures from (default: all)")

    sp = add("render", cmd_render, "Draw slides as pictures with LibreOffice (through soffice.py beside this script) "
             "and pypdfium2: to look at them, or to export them.",
             "python pptx_tool.py render deck.pptx --out-dir looks --slides 2,5")
    sp.add_argument("--out-dir", required=True, help="folder for <deck name>_slide<N>.png")
    sp.add_argument("--slides", help="slides to draw (default: all)")
    sp.add_argument("--width", type=int, default=1280, help="picture width in pixels, 100 to 8000 (default 1280)")
    sp.add_argument("--format", choices=["png", "jpg"], default="png", help="png (default) or jpg")
    sp.add_argument("--soffice", help="path to LibreOffice's soffice (otherwise found the way soffice.py finds it)")
    sp.add_argument("--timeout", type=float, default=180, help="seconds LibreOffice may take (default 180)")
    return p


def main(argv: list[str] | None = None) -> int:
    utf8_output()
    parser = build_parser()
    args = parser.parse_args(argv)
    if not getattr(args, "func", None):
        parser.error("needs a command, such as info")
    return run_job(f"pptx_tool.py {args.command}", lambda: args.func(args))


if __name__ == "__main__":
    sys.exit(main())
