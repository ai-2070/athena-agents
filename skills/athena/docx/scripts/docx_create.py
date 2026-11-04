#!/usr/bin/env python3
"""Make a Word document (.docx) from a JSON spec: a report, letter, memo or handout, on a blank page or on a template.

Packages: python-docx 1.2 or newer, which brings lxml (python -m pip install python-docx).

The spec (UTF-8 JSON; image and template paths are relative to the spec's folder):

  {
    "template": "letterhead.dotx",      # optional .docx/.dotx to start from: its styles, page setup, headers and
    "keep_body": false,                 #   footers; its body text is removed unless keep_body is true
    "page_size": "A4",                  # "A4", "letter", "legal", "A3", "A5" or [width_mm, height_mm] (default A4,
    "landscape": false,                 #   or the template's own)
    "margins_mm": 25.4,                 # one number, or {"top": 20, "bottom": 20, "left": 25, "right": 25}
    "font": "Calibri", "font_size": 11, # the Normal style's font and size in points
    "title": "Quarterly report", "author": "Finance", "subject": "", "keywords": "",
    "header": "Acme Ltd", "footer": "Confidential",
    "page_numbers": true,               # "Page N of M" in the footer, or a pattern like "{PAGE} / {NUMPAGES}"
    "styles": [{"name": "Note", "base": "Normal", "font": "Arial", "size": 9, "bold": false, "italic": true,
                "color": "555555", "space_before": 0, "space_after": 6, "align": "left"}],
    "blocks": [
      {"type": "heading", "text": "Summary", "level": 1},       # level 0 is the Title style, 1 to 9 headings
      {"type": "paragraph", "text": "Sales rose 4%.\\nA second line.", "style": "Normal", "align": "justify"},
      {"type": "paragraph", "runs": [{"text": "Bold", "bold": true}, {"text": " and "},
                                     {"text": "a link", "link": "https://example.com"}]},
      {"type": "bullets", "items": ["One", {"text": "A point under it", "level": 2}]},
      {"type": "numbered", "items": ["First", "Second"]},      # every list starts again at 1
      {"type": "table", "rows": [["Region", "Units"], ["North", "1,250"]], "header": true,
       "style": "Table Grid", "widths_mm": [60, 30], "align": ["left", "right"]},
      {"type": "image", "path": "chart.png", "width_mm": 120, "caption": "Figure 1: Units by region"},
      {"type": "toc", "levels": 3, "title": "Contents"},
      {"type": "page_break"}
    ]
  }

Runs take text and any of: bold, italic, underline, strike, superscript, subscript (true/false), color ("C00000"),
size (points), font, link (an http, https or mailto address). In a table, cells that are numbers are aligned right
unless "align" says otherwise, and with "header": true the first row is bold and repeats on every page.
Styles a template lacks (headings, Title, Table Grid, Caption, Quote...) are copied in from python-docx's own.

A table of contents and page numbers are fields: Word and LibreOffice work out page numbers as they lay the pages
out, but the contents list stays a placeholder line until someone updates fields (Word asks when the file opens;
LibreOffice: Tools > Update > Update All), and LibreOffice's PDF conversion prints the placeholder.

The result is printed on stdout as JSON. Exit codes: 0 done; 1 the spec has problems, all listed in the JSON, and
nothing was written; 2 it couldn't make the document, and one line on stderr says why. It won't write over the spec,
the template or an image it uses unless given --overwrite.
"""

from __future__ import annotations

import argparse
import codecs
import copy
import importlib
import json
import locale
import os
import re
import sys
import tempfile
from typing import Any, Callable, NoReturn


# ---------------------------------------------------------------- shared helpers
# docx_tool.py and docx_create.py each stand alone, so the helpers they share are copies, kept identical (the tests
# check): change one, change it in both.


def utf8_output() -> None:
    # A Windows pipe is cp1252 unless the script says otherwise; document text and file names often aren't.
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
    if module == "docx":
        version = tuple(int(x) for x in re.findall(r"\d+", str(getattr(mod, "__version__", "0")))[:2])
        if version < (1, 2):
            raise Fail(f"needs python-docx 1.2 or newer (this is {mod.__version__}): "
                       "python -m pip install --upgrade python-docx")
    return mod


# What a result also says, gathered while the command runs: an input read in an encoding other than UTF-8, say.
NOTES: dict[str, Any] = {}


def emit(data: dict[str, Any]) -> None:
    """Print the result on stdout as JSON, with the notes gathered on the way."""
    for key, value in NOTES.items():
        data.setdefault(key, value)
    print(json.dumps(data, ensure_ascii=False, indent=2))


class Parser(argparse.ArgumentParser):
    """argparse, reporting a mistake in the command line in one line with exit code 2, like any other failure."""

    def error(self, message: str) -> NoReturn:
        self.exit(2, f"{self.prog}: {message} (see --help)\n")


def run_job(prog: str, job: Callable[[], int | None]) -> int:
    """Run a command and return its exit code, turning whatever stops it into one line on stderr and exit code 2,
    never a traceback. A command that ran and found problems prints its result and returns 1."""
    try:
        return job() or 0
    except Fail as e:
        why = str(e)
    except OSError as e:  # a file open in Word on Windows, a full disk, a folder where a file should go
        where = e.filename2 or e.filename  # for a move into place, the second name is the output
        why = f"{e.strerror or e}" + (f": {where}" if where else "")
        if isinstance(e, PermissionError):
            why += " (if the file is open in Word, close it and try again)"
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
    except IsADirectoryError:
        raise Fail(f"{path} is a folder, not a JSON file") from None
    except json.JSONDecodeError as e:
        raise Fail(f"{path} isn't valid JSON: {e}") from None


def read_text(path: str, what: str) -> str:
    try:
        with open(path, "rb") as fh:
            return decode(fh.read(), path)
    except OSError as e:
        raise Fail(f"can't read {what} {path}: {e.strerror}") from None


def same_file(a: str, b: str) -> bool:
    if os.path.exists(a) and os.path.exists(b):
        return os.path.samefile(a, b)
    return os.path.normcase(os.path.realpath(a)) == os.path.normcase(os.path.realpath(b))


def check_output(out: str, inputs: list[str], overwrite: bool) -> None:
    if os.path.isdir(out):
        raise Fail(f"the output {out} is a folder: give a file name")
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


# The main part's content type says what kind of Word file it is; Word refuses a file whose extension disagrees.
MAIN_TYPES = {
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
    ".dotx": "application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml",
    ".docm": "application/vnd.ms-word.document.macroEnabled.main+xml",
    ".dotm": "application/vnd.ms-word.template.macroEnabledTemplate.main+xml",
}


CT_PREFIX = "application/vnd.openxmlformats-officedocument.wordprocessingml."


# Parts python-docx 1.2 keeps as raw bytes; read as XML they can be changed like the rest.
EXTRA_XML_PARTS = ("footnotes+xml", "endnotes+xml", "commentsExtended+xml", "commentsIds+xml",
                   "commentsExtensible+xml")


def open_docx(path: str) -> Any:
    """The python-docx Document for a .docx, .docm, .dotx or .dotm file."""
    need("docx", "python-docx")
    from docx.opc.part import PartFactory, XmlPart
    from docx.package import Package
    from docx.parts.document import DocumentPart

    if not os.path.exists(path):
        raise Fail(f"no such file: {path}")
    if os.path.isdir(path):
        raise Fail(f"{path} is a folder, not a Word document")
    with open(path, "rb") as fh:
        head = fh.read(8)
    if head.startswith(b"\xd0\xcf\x11\xe0"):
        raise Fail(f"{path} is an old-style .doc file or a password-protected Word file, not a .docx: convert a .doc "
                   "with soffice.py convert --to docx; a password has to come off in Word first")
    if not head.startswith(b"PK"):
        raise Fail(f"{path} isn't a Word document: a .docx is a zip file and this one isn't (damaged, or another "
                   "kind of file with a .docx name)")
    for suffix in EXTRA_XML_PARTS:
        PartFactory.part_type_for.setdefault(CT_PREFIX + suffix, XmlPart)
    for main in MAIN_TYPES.values():  # python-docx itself reads only .docx
        PartFactory.part_type_for.setdefault(main, DocumentPart)
    try:
        part = Package.open(path).main_document_part
    except Exception as e:  # a damaged zip or XML part raises several kinds
        raise Fail(f"{path} is damaged or isn't a Word document ({type(e).__name__}: {e}); "
                   "docx_tool.py check says more") from None
    if part.content_type not in MAIN_TYPES.values():
        raise Fail(f"{path} isn't a Word document (its main part is {part.content_type})")
    return part.document


def save_docx(doc: Any, out: str) -> None:
    """Save atomically, with the main part's type matching the output's extension (a .dotx template saved as .docx
    becomes a document; macros only go into .docm and .dotm)."""
    ext = os.path.splitext(out)[1].lower()
    if ext not in MAIN_TYPES:
        raise Fail(f"the output must end in .docx (or .docm, .dotx, .dotm), not {ext or 'nothing'}: {out}")
    part = doc.part
    has_macros = "macroEnabled" in part.content_type
    if has_macros and ext in (".docx", ".dotx"):
        raise Fail("this file has macros: keep them by writing .docm (or .dotm); removing them is a job for Word")
    if not has_macros and ext in (".docm", ".dotm"):
        raise Fail("this file has no macros: write .docx (or .dotx)")
    part._content_type = MAIN_TYPES[ext]  # python-docx has no public setter; the attribute is stable since 0.8
    write_atomic(out, doc.save)


NS = {
    "w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "w14": "http://schemas.microsoft.com/office/word/2010/wordml",
    "w15": "http://schemas.microsoft.com/office/word/2012/wordml",
    "w16cid": "http://schemas.microsoft.com/office/word/2016/wordml/cid",
    "w16cex": "http://schemas.microsoft.com/office/word/2018/wordml/cex",
    "mc": "http://schemas.openxmlformats.org/markup-compatibility/2006",
    "m": "http://schemas.openxmlformats.org/officeDocument/2006/math",
    "xml": "http://www.w3.org/XML/1998/namespace",
}


def qn(name: str) -> str:
    prefix, local = name.split(":")
    return f"{{{NS[prefix]}}}{local}"


# ---------------------------------------------------------------- the document


BLOCK_TYPES = ("heading", "paragraph", "bullets", "numbered", "table", "image", "toc", "page_break")
PAGE_SIZES = {"a4": (210, 297), "letter": (215.9, 279.4), "legal": (215.9, 355.6), "a3": (297, 420), "a5": (148, 210)}
ALIGNS = ("left", "center", "right", "justify")
NUMBER = re.compile(r"^[\s(+\-−$€£¥]*\d[\d.,\s ]*%?\)?\s*$")
HEX = re.compile(r"^#?[0-9A-Fa-f]{6}$")
RUN_FLAGS = ("bold", "italic", "underline", "strike", "superscript", "subscript")
LINK_COLOR = "0563C1"  # the blue Word gives links
BULLETS = ("•", "◦", "▪")
NUMBER_FORMATS = (("decimal", "{}."), ("lowerLetter", "{}."), ("lowerRoman", "{}."))
# settings.xml is a fixed sequence; updateFields comes before these
AFTER_UPDATE_FIELDS = {"hdrShapeDefaults", "footnotePr", "endnotePr", "compat", "docVars", "rsids", "mathPr",
                       "attachedSchema", "themeFontLang", "clrSchemeMapping", "doNotIncludeSubdocsInStats",
                       "doNotAutoCompressPictures", "forceUpgrade", "captions", "readModeInkLockDown", "smartTagType",
                       "schemaLibrary", "shapeDefaults", "doNotEmbedSmartTags", "decimalSymbol", "listSeparator"}


def number(value: Any, what: str, low: float = 0, allow_zero: bool = False) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{what} must be a number, not {value!r}")
    if value < low or (value == low and not allow_zero):
        raise ValueError(f"{what} must be more than {low:g}, not {value!r}")
    return float(value)


def text_of(value: Any, what: str) -> str:
    if isinstance(value, bool) or not isinstance(value, (str, int, float)):
        raise ValueError(f"{what} must be text, not {value!r}")
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


class Builder:
    def __init__(self, spec: dict[str, Any], base: str) -> None:
        docx = need("docx", "python-docx")
        self.spec, self.base = spec, base
        self.fields: set[str] = set()
        self.counts = {"paragraphs": 0, "tables": 0, "images": 0, "lists": 0}
        self._defaults: Any = None
        template = spec.get("template")
        if template:
            self.doc = open_docx(os.path.join(base, str(template)))
            if not spec.get("keep_body"):
                body = self.doc.element.body
                for child in list(body):
                    if child.tag != qn("w:sectPr"):
                        body.remove(child)
        else:
            self.doc = docx.Document()

    # -- styles

    def defaults(self) -> Any:
        if self._defaults is None:
            import docx

            self._defaults = docx.Document()
        return self._defaults

    def style(self, name: str, kind: str = "paragraph") -> Any:
        """The named style, copied in from python-docx's own template when this document lacks it (templates made
        in Word define only the styles they use)."""
        from docx.enum.style import WD_STYLE_TYPE

        want = {"paragraph": WD_STYLE_TYPE.PARAGRAPH, "table": WD_STYLE_TYPE.TABLE, "character": WD_STYLE_TYPE.CHARACTER}[kind]
        styles = self.doc.styles
        try:
            found = styles[name]
        except KeyError:
            try:
                source = self.defaults().styles[name]
            except KeyError:
                raise ValueError(f"no {kind} style named {name!r} in the document or the built-in set") from None
            have = {s.style_id for s in styles}
            chain, s = [], source
            while s is not None and s.style_id not in have:
                chain.append(s)
                linked = s.element.find(qn("w:link"))
                if linked is not None and linked.get(qn("w:val")) not in have:
                    match = [x for x in self.defaults().styles if x.style_id == linked.get(qn("w:val"))]
                    chain += match
                s = s.base_style
            for s in chain:
                if s.style_id not in {x.style_id for x in styles}:
                    styles.element.append(copy.deepcopy(s.element))
            found = styles[name]
        if found.type != want:
            raise ValueError(f"{name!r} is a {str(found.type).split('.')[-1].split(' ')[0].lower()} style, not a {kind} style")
        return found

    def add_styles(self) -> list[str]:
        from docx.enum.style import WD_STYLE_TYPE
        from docx.shared import Pt

        problems = []
        for n, s in enumerate(self.spec.get("styles") or [], 1):
            try:
                if not isinstance(s, dict) or not isinstance(s.get("name"), str) or not s["name"].strip():
                    raise ValueError("each style needs a name")
                try:
                    style = self.doc.styles[s["name"]]
                except KeyError:
                    style = self.doc.styles.add_style(s["name"], WD_STYLE_TYPE.PARAGRAPH)
                    style.base_style = self.style(str(s.get("base") or "Normal"))
                    style.quick_style = True
                self.font(style.font, s, f"style {s['name']!r}")
                pf = style.paragraph_format
                for key in ("space_before", "space_after"):
                    if s.get(key) is not None:
                        setattr(pf, key, Pt(number(s[key], key, allow_zero=True)))
                if s.get("align"):
                    pf.alignment = self.align(s["align"])
            except ValueError as e:
                problems.append(f"styles item {n}: {e}")
        return problems

    def font(self, font: Any, opts: dict[str, Any], what: str) -> None:
        from docx.shared import Pt, RGBColor

        for flag in RUN_FLAGS:
            if flag in opts and opts[flag] is not None:
                if not isinstance(opts[flag], bool):
                    raise ValueError(f"{what}: {flag} is true or false")
                setattr(font, "strike" if flag == "strike" else flag, opts[flag])
        if opts.get("size") is not None:
            font.size = Pt(number(opts["size"], f"{what}: size"))
        if opts.get("color"):
            if not isinstance(opts["color"], str) or not HEX.match(opts["color"]):
                raise ValueError(f"{what}: color is six hex digits like \"1F4E79\", not {opts['color']!r}")
            font.color.rgb = RGBColor.from_string(opts["color"].lstrip("#").upper())
        if opts.get("font"):
            self.font_name(font, text_of(opts["font"], f"{what}: font"))

    @staticmethod
    def font_name(font: Any, name: str) -> None:
        font.name = name  # Latin text; the next two cover East Asian and complex scripts (Arabic, Hebrew, Thai)
        rpr = font._element.get_or_add_rPr()
        rfonts = rpr.get_or_add_rFonts()
        rfonts.set(qn("w:eastAsia"), name)
        rfonts.set(qn("w:cs"), name)

    @staticmethod
    def align(value: Any) -> Any:
        from docx.enum.text import WD_ALIGN_PARAGRAPH

        if value not in ALIGNS:
            raise ValueError(f"align is one of {', '.join(ALIGNS)}, not {value!r}")
        return getattr(WD_ALIGN_PARAGRAPH, value.upper())

    # -- page

    def page(self) -> None:
        from docx.enum.section import WD_ORIENT
        from docx.shared import Mm, Pt

        spec = self.spec
        size = spec.get("page_size")
        if size is None and not spec.get("template"):
            size = "A4"
        if size is not None:
            if isinstance(size, str) and size.lower() in PAGE_SIZES:
                w, h = PAGE_SIZES[size.lower()]
            elif isinstance(size, list) and len(size) == 2:
                w, h = (number(v, "page_size") for v in size)
            else:
                raise ValueError(f"page_size is A4, letter, legal, A3, A5 or [width_mm, height_mm], not {size!r}")
        margins = spec.get("margins_mm", None if spec.get("template") else 25.4)  # Word's "Normal" margins
        if isinstance(margins, (int, float)) and not isinstance(margins, bool):
            margins = {k: margins for k in ("top", "bottom", "left", "right")}
        if margins is not None and not isinstance(margins, dict):
            raise ValueError("margins_mm is a number or {\"top\": .., \"bottom\": .., \"left\": .., \"right\": ..}")
        landscape = spec.get("landscape")
        for section in self.doc.sections:
            if size is not None:
                section.page_width, section.page_height = Mm(w), Mm(h)
            if landscape is not None:
                long_side, short_side = max(section.page_width, section.page_height), min(section.page_width, section.page_height)
                section.orientation = WD_ORIENT.LANDSCAPE if landscape else WD_ORIENT.PORTRAIT
                section.page_width, section.page_height = (long_side, short_side) if landscape else (short_side, long_side)
            for side, value in (margins or {}).items():
                if side not in ("top", "bottom", "left", "right"):
                    raise ValueError(f"margins_mm has top, bottom, left and right, not {side!r}")
                setattr(section, f"{side}_margin", Mm(number(value, f"margins_mm {side}", allow_zero=True)))
        normal = self.doc.styles["Normal"]
        if spec.get("font"):
            self.font_name(normal.font, text_of(spec["font"], "font"))
        if spec.get("font_size") is not None:
            normal.font.size = Pt(number(spec["font_size"], "font_size"))
        cp = self.doc.core_properties
        for key in ("title", "author", "subject", "keywords"):
            if spec.get(key) is not None:
                setattr(cp, key, text_of(spec[key], key))

    def header_footer(self) -> None:
        from docx.enum.text import WD_ALIGN_PARAGRAPH

        spec = self.spec
        section = self.doc.sections[0]
        for key in ("header", "footer"):
            if spec.get(key) is None:
                continue
            part = getattr(section, key)
            part.is_linked_to_previous = False
            paras = part.paragraphs
            for p in paras[1:]:
                p._p.getparent().remove(p._p)
            paras[0].text = text_of(spec[key], key)
        pattern = spec.get("page_numbers")
        if pattern:
            if pattern is True:
                pattern = "Page {PAGE} of {NUMPAGES}"
            if not isinstance(pattern, str) or "{PAGE}" not in pattern:
                raise ValueError("page_numbers is true, or a pattern with {PAGE} (and optionally {NUMPAGES})")
            footer = section.footer
            footer.is_linked_to_previous = False
            p = footer.paragraphs[0] if not footer.paragraphs[0].text and spec.get("footer") is None else footer.add_paragraph()
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            for piece in re.split(r"(\{PAGE\}|\{NUMPAGES\})", pattern):
                if piece in ("{PAGE}", "{NUMPAGES}"):
                    self.field(p, piece.strip("{}"), "1")
                elif piece:
                    p.add_run(piece)

    def field(self, p: Any, code: str, shown: str) -> None:
        """A Word field: what's between begin and separate is the code, then what shows until it's updated."""
        from docx.oxml import OxmlElement

        def run_with(el: Any) -> None:
            r = OxmlElement("w:r")
            r.append(el)
            p._p.append(r)

        def char(kind: str) -> Any:
            el = OxmlElement("w:fldChar")
            el.set(qn("w:fldCharType"), kind)
            return el

        run_with(char("begin"))
        instr = OxmlElement("w:instrText")
        instr.set(qn("xml:space"), "preserve")
        instr.text = f" {code} "
        run_with(instr)
        run_with(char("separate"))
        p.add_run(shown)
        run_with(char("end"))
        self.fields.add(code.split()[0])

    # -- blocks

    def runs(self, p: Any, block: dict[str, Any], what: str) -> None:
        from docx.opc.constants import RELATIONSHIP_TYPE as RT
        from docx.oxml import OxmlElement
        from docx.shared import RGBColor

        if "runs" in block:
            runs = block["runs"]
            if not isinstance(runs, list) or not all(isinstance(r, dict) for r in runs):
                raise ValueError(f"{what}: runs is a list of objects like {{\"text\": \"Bold\", \"bold\": true}}")
        else:
            runs = [{"text": block.get("text", "")}]
        for i, opts in enumerate(runs, 1):
            text = text_of(opts.get("text", ""), f"{what} run {i}: text")
            run = p.add_run(text)
            self.font(run.font, opts, f"{what} run {i}")
            link = opts.get("link")
            if link:
                if not isinstance(link, str) or not re.match(r"^(https?://|mailto:)\S+$", link):
                    raise ValueError(f"{what} run {i}: link is an http, https or mailto address, not {link!r}")
                rid = p.part.relate_to(link, RT.HYPERLINK, is_external=True)
                if opts.get("color") is None:
                    run.font.color.rgb = RGBColor.from_string(LINK_COLOR)
                if opts.get("underline") is None:
                    run.font.underline = True
                h = OxmlElement("w:hyperlink")
                h.set(qn("r:id"), rid)
                run._r.addprevious(h)
                h.append(run._r)

    def paragraph(self, block: dict[str, Any], what: str, style: str | None = None) -> Any:
        p = self.doc.add_paragraph()
        name = style or block.get("style")
        if name:
            p.style = self.style(text_of(name, f"{what}: style"))
        if block.get("align"):
            p.alignment = self.align(block["align"])
        self.runs(p, block, what)
        self.counts["paragraphs"] += 1
        return p

    def new_list(self, numbered: bool) -> str:
        """A list definition of its own, so every list starts at 1 and its levels indent and restart as in Word."""
        from docx.oxml import parse_xml

        numbering = self.doc.part.numbering_part.element
        abstract_id = 1 + max([int(a.get(qn("w:abstractNumId"))) for a in numbering.findall(qn("w:abstractNum"))] or [-1])
        num_id = 1 + max([int(n.get(qn("w:numId"))) for n in numbering.findall(qn("w:num"))] or [0])
        levels = []
        for i in range(9):
            if numbered:
                fmt, text = NUMBER_FORMATS[i % 3]
                text = text.format(f"%{i + 1}")
            else:
                fmt, text = "bullet", BULLETS[i % 3]
            levels.append(f'<w:lvl w:ilvl="{i}"><w:start w:val="1"/><w:numFmt w:val="{fmt}"/><w:lvlText w:val="{text}"/>'
                          f'<w:lvlJc w:val="left"/><w:pPr><w:ind w:left="{720 * (i + 1)}" w:hanging="360"/></w:pPr></w:lvl>')
        w = NS["w"]
        abstract = parse_xml(f'<w:abstractNum xmlns:w="{w}" w:abstractNumId="{abstract_id}">'
                             f'<w:multiLevelType w:val="hybridMultilevel"/>{"".join(levels)}</w:abstractNum>')
        num = parse_xml(f'<w:num xmlns:w="{w}" w:numId="{num_id}"><w:abstractNumId w:val="{abstract_id}"/></w:num>')
        first_num = numbering.find(qn("w:num"))
        if first_num is not None:
            first_num.addprevious(abstract)  # every abstractNum comes before the first num
        else:
            numbering.append(abstract)
        numbering.append(num)
        return str(num_id)

    def list_block(self, block: dict[str, Any], what: str, numbered: bool) -> None:
        items = block.get("items")
        if not isinstance(items, list) or not items:
            raise ValueError(f"{what}: items is a list of text (or {{\"text\": .., \"level\": 2}})")
        num_id = self.new_list(numbered)
        style = self.style("List Paragraph")
        for i, item in enumerate(items, 1):
            if isinstance(item, dict):
                level = item.get("level", 1)
                if isinstance(level, bool) or not isinstance(level, int) or not 1 <= level <= 9:
                    raise ValueError(f"{what} item {i}: level is 1 to 9")
                opts = item
            else:
                level, opts = 1, {"text": text_of(item, f"{what} item {i}")}
            p = self.paragraph(opts, f"{what} item {i}", style=style.name)
            num_pr = p._p.get_or_add_pPr().get_or_add_numPr()
            num_pr.get_or_add_ilvl().val = level - 1
            num_pr.get_or_add_numId().val = int(num_id)
        self.counts["lists"] += 1

    def table(self, block: dict[str, Any], what: str) -> None:
        from docx.enum.text import WD_ALIGN_PARAGRAPH
        from docx.oxml import OxmlElement
        from docx.shared import Mm

        rows = block.get("rows")
        if not isinstance(rows, list) or not rows or not all(isinstance(r, list) for r in rows):
            raise ValueError(f"{what}: rows is a list of rows, each a list of cells")
        cols = max(len(r) for r in rows)
        if cols == 0:
            raise ValueError(f"{what}: the rows have no cells")
        widths, aligns = block.get("widths_mm"), block.get("align")
        if widths is not None and (not isinstance(widths, list) or len(widths) != cols):
            raise ValueError(f"{what}: widths_mm needs one width per column ({cols})")
        if aligns is not None and (not isinstance(aligns, list) or len(aligns) != cols or any(a not in ALIGNS for a in aligns)):
            raise ValueError(f"{what}: align needs one of {', '.join(ALIGNS)} per column ({cols})")
        header = block.get("header", True)
        table = self.doc.add_table(rows=len(rows), cols=cols)
        style_name = block.get("style", "Table Grid")
        if style_name:
            table.style = self.style(text_of(style_name, f"{what}: style"), "table")
        for i, row in enumerate(rows):
            for j in range(cols):
                value = row[j] if j < len(row) else ""
                text = "" if value is None else text_of(value, f"{what} row {i + 1} cell {j + 1}")
                cell = table.cell(i, j)
                p = cell.paragraphs[0]
                run = p.add_run(text)
                if header and i == 0:
                    run.bold = True
                if aligns is not None:
                    p.alignment = getattr(WD_ALIGN_PARAGRAPH, aligns[j].upper())
                elif not (header and i == 0) and NUMBER.match(text):
                    p.alignment = WD_ALIGN_PARAGRAPH.RIGHT
        if header:
            tr_pr = table.rows[0]._tr.get_or_add_trPr()
            tr_pr.append(OxmlElement("w:tblHeader"))
        if widths is not None:
            table.autofit = False
            for j, w in enumerate(widths):
                width = Mm(number(w, f"{what}: widths_mm"))
                table.columns[j].width = width  # the grid, which LibreOffice goes by; Word goes by the cells
                for cell in table.columns[j].cells:
                    cell.width = width
        self.counts["tables"] += 1

    def image(self, block: dict[str, Any], what: str) -> None:
        from docx.image.exceptions import UnrecognizedImageError
        from docx.shared import Mm

        path = block.get("path")
        if not isinstance(path, str) or not path:
            raise ValueError(f"{what}: path is the picture file")
        full = os.path.join(self.base, path)
        if not os.path.isfile(full):
            raise ValueError(f"{what}: no such picture {full}")
        width = Mm(number(block["width_mm"], f"{what}: width_mm")) if block.get("width_mm") is not None else None
        try:
            self.doc.add_picture(full, width=width)
        except UnrecognizedImageError:
            raise ValueError(f"{what}: {path} isn't a picture Word takes here (PNG, JPEG, GIF, BMP or TIFF)") from None
        pic = self.doc.paragraphs[-1]
        pic.alignment = self.align(block.get("align", "center"))
        if block.get("caption"):
            cap = self.doc.add_paragraph(text_of(block["caption"], f"{what}: caption"), style=self.style("Caption"))
            cap.alignment = pic.alignment
        self.counts["images"] += 1

    def toc(self, block: dict[str, Any], what: str) -> None:
        levels = block.get("levels", 3)
        if isinstance(levels, bool) or not isinstance(levels, int) or not 1 <= levels <= 9:
            raise ValueError(f"{what}: levels is 1 to 9")
        if block.get("title"):
            self.doc.add_paragraph(text_of(block["title"], f"{what}: title"), style=self.style("TOC Heading"))
        p = self.doc.add_paragraph()
        self.field(p, f'TOC \\o "1-{levels}" \\h \\z \\u', "[Table of contents: update fields to fill it in]")
        self.update_fields_on_open()

    def update_fields_on_open(self) -> None:
        """Ask Word to update fields when the file opens, which fills in the table of contents."""
        from docx.oxml import OxmlElement

        settings = self.doc.settings.element
        if settings.find(qn("w:updateFields")) is not None:
            return
        el = OxmlElement("w:updateFields")
        el.set(qn("w:val"), "true")
        later = [c for c in settings if isinstance(c.tag, str) and c.tag.split("}")[-1] in AFTER_UPDATE_FIELDS]
        if later:
            later[0].addprevious(el)
        else:
            settings.append(el)

    def build(self) -> list[str]:
        problems = self.add_styles()
        for step in (self.page, self.header_footer):
            try:
                step()
            except ValueError as e:
                problems.append(str(e))
        blocks = self.spec.get("blocks")
        if not isinstance(blocks, list) or not blocks:
            return problems + ["blocks is a list of blocks, like [{\"type\": \"paragraph\", \"text\": \"Hello\"}]"]
        for n, block in enumerate(blocks, 1):
            what = f"block {n}"
            try:
                if not isinstance(block, dict) or block.get("type") not in BLOCK_TYPES:
                    raise ValueError(f"{what}: type is one of {', '.join(BLOCK_TYPES)}")
                kind = block["type"]
                what = f"block {n} ({kind})"
                if kind == "heading":
                    level = block.get("level", 1)
                    if isinstance(level, bool) or not isinstance(level, int) or not 0 <= level <= 9:
                        raise ValueError(f"{what}: level is 0 (the Title style) to 9")
                    self.paragraph(block, what, style="Title" if level == 0 else f"Heading {level}")
                elif kind == "paragraph":
                    self.paragraph(block, what)
                elif kind in ("bullets", "numbered"):
                    self.list_block(block, what, kind == "numbered")
                elif kind == "table":
                    self.table(block, what)
                elif kind == "image":
                    self.image(block, what)
                elif kind == "toc":
                    self.toc(block, what)
                else:
                    from docx.enum.text import WD_BREAK

                    self.doc.add_paragraph().add_run().add_break(WD_BREAK.PAGE)
            except ValueError as e:
                problems.append(str(e) if str(e).startswith("block") else f"{what}: {e}")
        return problems


def create(args: argparse.Namespace) -> int:
    spec = load_json(args.spec)
    if not isinstance(spec, dict):
        raise Fail("the spec is a JSON object with a \"blocks\" list")
    base = os.path.dirname(os.path.abspath(args.spec))
    blocks = spec.get("blocks") if isinstance(spec.get("blocks"), list) else []
    inputs = [args.spec] + [os.path.join(base, str(b.get("path", ""))) for b in blocks
                            if isinstance(b, dict) and b.get("type") == "image" and b.get("path")]
    if spec.get("template"):
        inputs.append(os.path.join(base, str(spec["template"])))
    check_output(args.out, inputs, args.overwrite)
    builder = Builder(spec, base)
    problems = builder.build()
    if problems:
        emit({"out": None, "written": False, "problems": problems})
        return 1
    save_docx(builder.doc, args.out)
    back = open_docx(args.out)
    result: dict[str, Any] = {"out": args.out, "written": True, **builder.counts,
                              "paragraphs_in_file": len(back.paragraphs), "fields": sorted(builder.fields)}
    if builder.fields & {"TOC"}:
        result["note"] = ("the table of contents is a placeholder line until fields are updated: Word offers to when "
                          "the file opens; in LibreOffice use Tools > Update > Update All. A PDF made by LibreOffice "
                          "without that shows the placeholder")
    emit(result)
    return 0


def main(argv: list[str] | None = None) -> int:
    utf8_output()
    parser = Parser(prog="docx_create.py", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter,
                    epilog="example:\n  python docx_create.py docx-work/report.json -o report.docx")
    parser.add_argument("spec", help="the JSON spec")
    parser.add_argument("-o", "--out", required=True, help="the .docx to write (.dotx for a template)")
    parser.add_argument("--overwrite", action="store_true", help="allow the output to replace the spec, template or an image it uses")
    args = parser.parse_args(argv)
    return run_job("docx_create.py", lambda: create(args))


if __name__ == "__main__":
    sys.exit(main())
