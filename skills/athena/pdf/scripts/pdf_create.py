#!/usr/bin/env python3
"""Make a PDF document (a report, a letter, a handout) from a JSON spec, with reportlab.

Packages: reportlab; Pillow for PNG images.

The spec (UTF-8 JSON; image paths are relative to the spec's folder):

  {
    "title": "Quarterly report", "author": "Finance", "subject": "", "keywords": "",
    "page_size": "A4",                 # "A4", "letter", "legal", "A3", "A5" or [width, height] in points
    "landscape": false,
    "margin": 56.7,                    # points (72 to the inch); default 2 cm
    "font": "C:/Windows/Fonts/arial.ttf", "bold_font": "...", "italic_font": "...",   # optional .ttf files
    "font_size": 10.5,
    "header": "Acme Ltd", "footer": "Confidential", "page_numbers": true,
    "blocks": [
      {"type": "heading", "text": "Summary", "level": 1},              # level 1, 2 or 3
      {"type": "paragraph", "text": "Sales rose 4% in R&D <beta>."},  # plain text; \\n breaks a line
      {"type": "paragraph", "text": "<b>Bold</b> and <i>italic</i>", "markup": true},
      {"type": "bullets", "items": ["One", "Two"], "numbered": false},
      {"type": "table", "rows": [["Region", "Units"], ["North", "1,250"]], "header": true, "widths": [3, 1]},
      {"type": "image", "path": "chart.png", "width": 360, "caption": "Figure 1"},
      {"type": "spacer", "height": 12},
      {"type": "rule"},
      {"type": "pagebreak"}
    ]
  }

Text is drawn as written: & and < are escaped. "markup": true on a block instead passes reportlab's inline tags
(<b>, <i>, <u>, <font color="#c00">, <a href="...">) through, and then a bare & must be written &amp;.
The built-in fonts draw Western European letters only; for anything else set "font" to a .ttf that has them.

The result is printed on stdout as JSON. Exit codes: 0 done; 2 it couldn't make the PDF, and one line on stderr says
why. It won't write over the spec or an image it uses unless given --overwrite.
"""

from __future__ import annotations

import argparse
import codecs
import importlib
import json
import locale
import logging
import os
import re
import sys
import tempfile
from typing import Any, Callable, NoReturn
from xml.sax.saxutils import escape


# ---------------------------------------------------------------- shared helpers
# pdf_tool.py, pdf_forms.py and pdf_create.py each stand alone, so the helpers they share are copies, kept identical
# (the tests check): change one, change it in all of them.


def utf8_output() -> None:
    # A Windows pipe is cp1252 unless the script says otherwise; PDF text, field values and file names often aren't.
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
    if module == "pypdf" and int(str(getattr(mod, "__version__", "0")).split(".")[0]) < 6:
        raise Fail(f"needs pypdf 6 or newer (this is {mod.__version__}): python -m pip install --upgrade pypdf")
    return mod


# What a result also says, gathered while the command runs: an input read in an encoding other than UTF-8, warnings
# the PDF libraries logged, and that a copy made from a password-protected file isn't protected itself.
NOTES: dict[str, Any] = {}


def emit(data: dict[str, Any]) -> None:
    """Print the result on stdout as JSON, with the notes gathered on the way."""
    for key, value in NOTES.items():
        data.setdefault(key, value)
    print(json.dumps(data, ensure_ascii=False, indent=2))


class LibraryWarnings(logging.Handler):
    """Puts what pypdf, pdfplumber and Python's warnings log (a damaged file they repaired, say) into the result, and
    keeps it off stderr, which carries only the one line saying why a command failed."""

    def __init__(self) -> None:
        super().__init__(logging.WARNING)

    def emit(self, record: logging.LogRecord) -> None:
        message = " ".join(record.getMessage().split())
        if "not supported by font encoding" in message:
            return  # pdf_forms.py fill names each field whose font lacks letters, in plainer words
        found = NOTES.setdefault("library_warnings", [])
        if message not in found:
            found.append(message)


class Parser(argparse.ArgumentParser):
    """argparse, reporting a mistake in the command line in one line with exit code 2, like any other failure."""

    def error(self, message: str) -> NoReturn:
        self.exit(2, f"{self.prog}: {message} (see --help)\n")


def run_job(prog: str, job: Callable[[], None]) -> int:
    """Run a command, and turn whatever stops it into one line on stderr and exit code 2, never a traceback. A
    command that ran and found problems prints its result and exits 1 itself."""
    logging.getLogger().addHandler(LibraryWarnings())
    logging.captureWarnings(True)
    try:
        job()
        return 0
    except Fail as e:
        why = str(e)
    except OSError as e:  # a file open in another program on Windows, a full disk, a folder where a file should go
        where = e.filename2 or e.filename  # for a move into place, the second name is the output
        why = f"{e.strerror or e}" + (f": {where}" if where else "")
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


def check_output(out: str, inputs: list[str], overwrite: bool) -> None:
    for src in inputs:
        if same_file(out, src) and not overwrite:
            raise Fail(f"won't write over the input {src}: give another output path, or add --overwrite to replace it")
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


def cp1252_ok(ch: str) -> bool:
    """Whether the built-in Helvetica can draw the letter: it has the Windows-1252 (Western European) ones."""
    try:
        ch.encode("cp1252")
        return True
    except UnicodeEncodeError:
        return False


# ---------------------------------------------------------------- the document


BLOCK_TYPES = ("heading", "paragraph", "bullets", "table", "image", "spacer", "rule", "pagebreak")
NUMBER = re.compile(r"^[\s(+\-\u2212$\u20ac\u00a3\u00a5]*\d[\d.,\s]*%?\)?\s*$")
TAG = re.compile(r"<[^>]*>")


def block_texts(block: dict[str, Any]) -> list[str]:
    kind = block.get("type")
    if kind in ("heading", "paragraph"):
        return [str(block.get("text", ""))]
    if kind == "bullets":
        return [str(i) for i in block.get("items", [])]
    if kind == "table":
        return [str(c) for row in block.get("rows", []) for c in row]
    if kind == "image":
        return [str(block.get("caption", ""))]
    return []


class Fonts:
    """The font names to draw with, and a check that they have every letter the spec uses."""

    def __init__(self, spec: dict[str, Any], base: str) -> None:
        self.regular, self.bold, self.italic = "Helvetica", "Helvetica-Bold", "Helvetica-Oblique"
        self.glyphs: set[int] | None = None  # None: the built-in fonts (Windows-1252 letters)
        self.font_name = ""
        if spec.get("font"):
            pdfmetrics = need("reportlab.pdfbase.pdfmetrics", "reportlab")
            ttfonts = need("reportlab.pdfbase.ttfonts", "reportlab")
            names = []
            for key, alias in (("font", "DocFont"), ("bold_font", "DocFont-Bold"), ("italic_font", "DocFont-Italic")):
                path = spec.get(key) or spec["font"]
                path = path if os.path.isabs(path) else os.path.join(base, path)
                try:
                    font = ttfonts.TTFont(alias, path)
                except Exception as e:
                    raise Fail(f"can't use the font {path} ({e}): pick a TrueType .ttf file") from None
                pdfmetrics.registerFont(font)
                names.append(alias)
                if key == "font":
                    self.glyphs = set(font.face.charToGlyph)
                    self.font_name = os.path.basename(path)
            self.regular, self.bold, self.italic = names
            pdfmetrics.registerFontFamily("DocFont", normal=names[0], bold=names[1], italic=names[2], boldItalic=names[1])

    def missing(self, text: str) -> list[str]:
        text = TAG.sub("", text)
        out = set()
        for ch in text:
            if ch.isspace():
                continue
            if self.glyphs is None:
                if not cp1252_ok(ch):
                    out.add(ch)
            elif ord(ch) not in self.glyphs:
                out.add(ch)
        return sorted(out)

    def check(self, spec: dict[str, Any]) -> None:
        places = [("the header", str(spec.get("header", ""))), ("the footer", str(spec.get("footer", "")))]
        for i, block in enumerate(spec.get("blocks", []), 1):
            places += [(f"block {i} ({block.get('type')})", t) for t in block_texts(block)]
        for where, text in places:
            gone = self.missing(text)
            if gone:
                letters = " ".join(gone[:12])
                if self.glyphs is None:
                    raise Fail(f"{where} has letters the built-in fonts can't draw: {letters}. "
                               'Set "font" in the spec to a TrueType (.ttf) font that has them')
                raise Fail(f"{where} has letters {self.font_name} doesn't have: {letters}. Pick a font that has them")


def page_size(spec: dict[str, Any]) -> tuple[float, float]:
    pagesizes = need("reportlab.lib.pagesizes", "reportlab")
    value = spec.get("page_size", "A4")
    if isinstance(value, list) and len(value) == 2:
        size = (float(value[0]), float(value[1]))
    else:
        named = {"a4": pagesizes.A4, "letter": pagesizes.letter, "legal": pagesizes.legal, "a3": pagesizes.A3, "a5": pagesizes.A5}
        if str(value).lower() not in named:
            raise Fail(f"unknown page_size {value!r}: use A4, letter, legal, A3, A5 or [width, height] in points")
        size = named[str(value).lower()]
    return pagesizes.landscape(size) if spec.get("landscape") else size


def para_text(text: Any, markup: bool) -> str:
    text = str(text)
    if not markup:
        text = escape(text)
    return text.replace("\r\n", "\n").replace("\n", "<br/>")


def build(spec: dict[str, Any], base: str, out: str) -> int:
    platypus = need("reportlab.platypus", "reportlab", "to make PDFs")
    styles_mod = need("reportlab.lib.styles", "reportlab")
    colors = need("reportlab.lib.colors", "reportlab")
    enums = need("reportlab.lib.enums", "reportlab")
    canvas_mod = need("reportlab.pdfgen.canvas", "reportlab")
    units = need("reportlab.lib.units", "reportlab")

    blocks = spec.get("blocks")
    if not isinstance(blocks, list) or not blocks:
        raise Fail('the spec needs a "blocks" list')
    for i, block in enumerate(blocks, 1):
        if not isinstance(block, dict) or block.get("type") not in BLOCK_TYPES:
            kind = block.get("type") if isinstance(block, dict) else block
            raise Fail(f"block {i} has type {kind!r}: use one of {', '.join(BLOCK_TYPES)}")

    fonts = Fonts(spec, base)
    fonts.check(spec)
    size = float(spec.get("font_size", 10.5))
    margin = float(spec.get("margin", 2 * units.cm))
    pagesize = page_size(spec)
    if size <= 0:
        raise Fail("font_size is a number of points above 0")
    if margin < 0 or 2 * margin >= min(pagesize):
        raise Fail(f"a margin of {margin:g} pt leaves no room on a {pagesize[0]:g} x {pagesize[1]:g} pt page")

    sheet = styles_mod.getSampleStyleSheet()
    body = styles_mod.ParagraphStyle("Body", parent=sheet["BodyText"], fontName=fonts.regular, fontSize=size,
                                     leading=size * 1.4, spaceAfter=size * 0.6)
    heads = {
        level: styles_mod.ParagraphStyle(f"H{level}", parent=sheet[f"Heading{level}"], fontName=fonts.bold,
                                         fontSize=size * scale, leading=size * scale * 1.25,
                                         spaceBefore=size * (1.2 if level == 1 else 0.9), spaceAfter=size * 0.5)
        for level, scale in ((1, 1.9), (2, 1.45), (3, 1.2))
    }
    caption = styles_mod.ParagraphStyle("Caption", parent=body, fontName=fonts.italic, fontSize=size * 0.9,
                                        alignment=enums.TA_CENTER, textColor=colors.HexColor("#555555"))
    cell = styles_mod.ParagraphStyle("Cell", parent=body, spaceAfter=0, leading=size * 1.25)
    cell_right = styles_mod.ParagraphStyle("CellRight", parent=cell, alignment=enums.TA_RIGHT)
    cell_head = styles_mod.ParagraphStyle("CellHead", parent=cell, fontName=fonts.bold)
    aligns = {"left": enums.TA_LEFT, "center": enums.TA_CENTER, "right": enums.TA_RIGHT, "justify": enums.TA_JUSTIFY}

    frame_width = pagesize[0] - 2 * margin
    frame_height = pagesize[1] - 2 * margin - 12  # reportlab's frame keeps 6 pt of padding at the top and bottom
    story: list[Any] = []

    def paragraph(text: str, style: Any, where: str) -> Any:
        try:
            return platypus.Paragraph(text, style)
        except Exception as e:
            raise Fail(f"{where}: reportlab couldn't read the text ({e}); with \"markup\": true, check the tags and write & as &amp;") from None

    for i, block in enumerate(blocks, 1):
        kind = block["type"]
        where = f"block {i} ({kind})"
        markup = bool(block.get("markup", False))
        if kind == "heading":
            level = int(block.get("level", 1))
            if level not in heads:
                raise Fail(f"{where}: level is 1, 2 or 3")
            story.append(paragraph(para_text(block.get("text", ""), markup), heads[level], where))
        elif kind == "paragraph":
            style = body
            if block.get("align"):
                if block["align"] not in aligns:
                    raise Fail(f"{where}: align is left, center, right or justify")
                style = styles_mod.ParagraphStyle(f"P{i}", parent=body, alignment=aligns[block["align"]])
            story.append(paragraph(para_text(block.get("text", ""), markup), style, where))
        elif kind == "bullets":
            items = block.get("items") or []
            if not isinstance(items, list) or not items:
                raise Fail(f"{where}: needs an \"items\" list")
            flow = [platypus.ListItem(paragraph(para_text(t, markup), body, where)) for t in items]
            kwargs = {"bulletType": "1"} if block.get("numbered") else {"bulletType": "bullet", "start": "\u2022"}
            story.append(platypus.ListFlowable(flow, leftIndent=size * 1.6, bulletFontName=fonts.regular,
                                               bulletFontSize=size, **kwargs))
        elif kind == "table":
            rows = block.get("rows") or []
            if not rows or not all(isinstance(r, list) for r in rows):
                raise Fail(f"{where}: \"rows\" is a list of rows, each a list of cells")
            ncols = max(len(r) for r in rows)
            if ncols == 0:
                raise Fail(f"{where}: the rows have no cells")
            header = bool(block.get("header", True))
            data = []
            for r, row in enumerate(rows):
                cells = list(row) + [""] * (ncols - len(row))
                out_row = []
                for value in cells:
                    text = "" if value is None else str(value)
                    style = cell_head if header and r == 0 else (cell_right if NUMBER.match(text) else cell)
                    out_row.append(paragraph(para_text(text, markup), style, where))
                data.append(out_row)
            widths = block.get("widths")
            if widths:
                if len(widths) != ncols:
                    raise Fail(f"{where}: \"widths\" needs one number per column ({ncols})")
                total = float(sum(widths))
                if total <= 0 or min(float(w) for w in widths) < 0:
                    raise Fail(f"{where}: \"widths\" are shares of the width, like [3, 1]: none below 0, not all 0")
                col_widths = [frame_width * float(w) / total for w in widths]
            else:
                col_widths = [frame_width / ncols] * ncols
            table = platypus.Table(data, colWidths=col_widths, repeatRows=1 if header else 0)
            style_cmds = [
                ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#b0b0b0")),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("TOPPADDING", (0, 0), (-1, -1), 3),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ]
            if header:
                style_cmds.append(("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#efefef")))
            table.setStyle(platypus.TableStyle(style_cmds))
            story += [table, platypus.Spacer(1, size * 0.8)]
        elif kind == "image":
            path = str(block.get("path", ""))
            full = path if os.path.isabs(path) else os.path.join(base, path)
            if not os.path.isfile(full):
                raise Fail(f"{where}: no image at {full}")
            utils = need("reportlab.lib.utils", "reportlab")
            try:
                iw, ih = utils.ImageReader(full).getSize()
            except Exception as e:
                raise Fail(f"{where}: can't read {full} ({e}); PNG needs Pillow: python -m pip install pillow") from None
            width = min(float(block.get("width", iw)), frame_width)
            height = width * ih / iw
            if height > frame_height:  # a tall picture (a phone screenshot) shrinks to fit the page
                width, height = frame_height * iw / ih, frame_height
            story.append(platypus.Image(full, width=width, height=height))
            if block.get("caption"):
                story.append(paragraph(para_text(block["caption"], markup), caption, where))
            story.append(platypus.Spacer(1, size * 0.6))
        elif kind == "spacer":
            story.append(platypus.Spacer(1, float(block.get("height", size))))
        elif kind == "rule":
            story.append(platypus.HRFlowable(width="100%", thickness=0.5, color=colors.HexColor("#b0b0b0"),
                                             spaceBefore=size * 0.4, spaceAfter=size * 0.8))
        elif kind == "pagebreak":
            story.append(platypus.PageBreak())

    header_text = str(spec.get("header", ""))
    footer_text = str(spec.get("footer", ""))
    numbers = bool(spec.get("page_numbers", True))
    small = size * 0.85

    class PagedCanvas(canvas_mod.Canvas):
        """Holds every page until the end, so each can say 'N / total'."""

        def __init__(self, *a: Any, **k: Any) -> None:
            super().__init__(*a, **k)
            self._pages: list[dict[str, Any]] = []

        def showPage(self) -> None:  # noqa: N802 (reportlab's name)
            self._pages.append(dict(self.__dict__))
            self._startPage()

        def save(self) -> None:
            total = len(self._pages)
            for state in self._pages:
                self.__dict__.update(state)
                self.setFont(fonts.regular, small)
                self.setFillColor(colors.HexColor("#666666"))
                w, h = pagesize
                if header_text:
                    self.drawString(margin, h - margin / 2, header_text)
                if footer_text:
                    self.drawString(margin, margin / 2, footer_text)
                if numbers:
                    self.drawRightString(w - margin, margin / 2, f"{self._pageNumber} / {total}")
                super().showPage()
            super().save()

    pages = 0

    def write(fh: Any) -> None:
        nonlocal pages
        doc = platypus.SimpleDocTemplate(
            fh, pagesize=pagesize, leftMargin=margin, rightMargin=margin, topMargin=margin, bottomMargin=margin,
            title=str(spec.get("title", "")), author=str(spec.get("author", "")), subject=str(spec.get("subject", "")),
            keywords=str(spec.get("keywords", "")), creator="AthenaAgents pdf_create.py",
        )
        try:
            doc.build(story, canvasmaker=PagedCanvas)
        except (Fail, OSError):
            raise
        except Exception as e:
            raise Fail(f"reportlab couldn't lay out the document: {e}") from None
        pages = int(doc.page)

    write_atomic(out, write)
    return pages


def create(args: argparse.Namespace) -> None:
    spec = load_json(args.spec)
    if not isinstance(spec, dict):
        raise Fail("the spec is a JSON object with a \"blocks\" list")
    base = os.path.dirname(os.path.abspath(args.spec))
    blocks = spec.get("blocks") if isinstance(spec.get("blocks"), list) else []
    images = [os.path.join(base, str(b.get("path", ""))) for b in blocks if isinstance(b, dict) and b.get("type") == "image"]
    check_output(args.out, [args.spec] + images, args.overwrite)
    try:
        pages = build(spec, base, args.out)
    except (TypeError, ValueError, KeyError, AttributeError) as e:
        raise Fail(f"a value in the spec has the wrong kind ({e}): sizes are numbers, rows are lists of cells") from None
    emit({"out": args.out, "pages": pages, "blocks": len(spec["blocks"]), "title": spec.get("title", "")})


def main(argv: list[str] | None = None) -> int:
    utf8_output()
    parser = Parser(prog="pdf_create.py", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter,
                    epilog="example:\n  python pdf_create.py report.json -o report.pdf")
    parser.add_argument("spec", help="the JSON spec")
    parser.add_argument("-o", "--out", required=True, help="the PDF to write")
    parser.add_argument("--overwrite", action="store_true", help="allow the output to replace the spec or an image it uses")
    args = parser.parse_args(argv)
    return run_job("pdf_create.py", lambda: create(args))


if __name__ == "__main__":
    sys.exit(main())
