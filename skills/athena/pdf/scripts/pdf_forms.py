#!/usr/bin/env python3
"""Fill, flatten and build PDF forms: fields, fill, flatten, layout, check, build.

Packages: pypdf 6 or newer (fields, fill, flatten, and reading any PDF); pdfplumber (layout); reportlab (build); Pillow (check --overlay);
pypdfium2 to draw a PDF page under the overlay (Poppler's pdftoppm on PATH works instead).

  fields   list a form's fields: exact names, types, values, the values each accepts, pages and boxes
  fill     fill fields from a JSON file of {"name": value}, then read the file back to prove it
  flatten  turn filled fields into ordinary page content, so the values can't change and show everywhere
  layout   the words, boxes and lines printed on a page, in PDF points: for forms that have no fields
  check    check a form spec (the JSON that build uses) and draw its boxes over the page as a PNG
  build    make a fillable form from a spec: a new one, or fields laid over an existing PDF with --on

Coordinates are PDF points (72 to the inch) from the page's bottom-left corner; boxes are [x0, y0, x1, y1].
Pages are numbered from 1 ("1-3,7,10-"; leaving out --pages means every page). Commands that write a PDF need -o and
won't write over an input without --overwrite.

Results are printed on stdout as JSON. Exit codes: 0 done; 1 it ran and found problems, which the JSON lists (fill
read back a value that differs, check found errors, build was stopped by its check or left a field out); 2 it
couldn't do the job, and one line on stderr says why.
"""

from __future__ import annotations

import argparse
import codecs
import difflib
import importlib
import io
import json
import locale
import logging
import os
import re
import shutil
import subprocess
import sys
import tempfile
from typing import Any, Callable, Iterator, NoReturn


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


def read_text(path: str, what: str) -> str:
    try:
        with open(path, "rb") as fh:
            return decode(fh.read(), path)
    except OSError as e:
        raise Fail(f"can't read {what} {path}: {e.strerror}") from None


def load_json(path: str) -> Any:
    try:
        with open(path, "rb") as fh:
            return json.loads(decode(fh.read(), path))
    except FileNotFoundError:
        raise Fail(f"no such file: {path}") from None
    except json.JSONDecodeError as e:
        raise Fail(f"{path} isn't valid JSON: {e}") from None


def read_password(args: argparse.Namespace, name: str = "password") -> str | None:
    """--<name>, or the first line of --<name>-file, which keeps a real password out of the command line."""
    value = getattr(args, name, None)
    path = getattr(args, f"{name}_file", None)
    if path:
        lines = read_text(path, "the password file").splitlines()
        return lines[0] if lines else ""
    return value


# Inputs that were password-protected: a PDF written from one isn't protected itself, and the result says so.
OPENED_LOCKED: list[str] = []


def open_pdf(path: str, password: str | None = None) -> Any:
    pypdf = need("pypdf", "pypdf")
    if not os.path.isfile(path):
        raise Fail(f"no such file: {path}")
    try:
        reader = pypdf.PdfReader(path)
    except Exception as e:  # pypdf raises several kinds for damaged files
        raise Fail(f"{path} isn't a PDF pypdf can read ({e})") from None
    if reader.is_encrypted:
        try:
            opened = reader.decrypt(password or "")
        except pypdf.errors.DependencyError:
            raise Fail("this PDF uses AES encryption, which needs the cryptography package: "
                       "python -m pip install cryptography") from None
        if not opened:
            if password:
                raise Fail(f"wrong password for {path}")
            raise Fail(f"{path} needs a password to open: pass --password or --password-file")
        OPENED_LOCKED.append(path)
    return reader


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


def save(writer: Any, out: str) -> None:
    """Write a pypdf writer's PDF to out."""
    pypdf = need("pypdf", "pypdf")
    try:
        write_atomic(out, writer.write)
    except pypdf.errors.DependencyError:
        raise Fail("AES encryption needs the cryptography package: python -m pip install cryptography") from None
    if OPENED_LOCKED:
        NOTES["unprotected_copy"] = ("the input was password-protected and this output isn't: "
                                     "encrypt it again (pdf_tool.py encrypt) if it should be")


def parse_pages(spec: str | None, count: int) -> list[int]:
    """'1-3,7,10-' -> [1, 2, 3, 7, 10, ..., count]. Pages count from 1, '-3' is pages 1 to 3, and a range written
    high-low runs backwards. No list means every page; a list that names none, such as '-', is refused."""
    if spec is None or not spec.strip():
        return list(range(1, count + 1))
    pages: list[int] = []
    for part in spec.replace(" ", "").split(","):
        if not part:
            continue
        m = re.fullmatch(r"(\d*)-(\d*)|(\d+)", part)
        if not m or part == "-":
            raise Fail(f"can't read the page list {spec!r}: write it like 1-3,7,10-")
        if m.group(3):
            start = end = int(m.group(3))
        else:
            start = int(m.group(1)) if m.group(1) else 1
            end = int(m.group(2)) if m.group(2) else count
        for n in (start, end):
            if n < 1:
                raise Fail("pages are numbered from 1")
            if n > count:
                raise Fail(f"page {n} is past the end: the PDF has {count} page{'s' if count != 1 else ''}")
        step = 1 if end >= start else -1
        pages.extend(range(start, end + step, step))
    if not pages:
        raise Fail(f"can't read the page list {spec!r}: write it like 1-3,7,10-")
    return pages


def cp1252_ok(ch: str) -> bool:
    """Whether the built-in Helvetica can draw the letter: it has the Windows-1252 (Western European) ones."""
    try:
        ch.encode("cp1252")
        return True
    except UnicodeEncodeError:
        return False


PAGE_TIMEOUT = 120  # seconds for pdftoppm to draw one page; the dashboard's shell gives a whole command 300


def render_pages(path: str, pages: list[int], dpi: int, password: str | None = None) -> Iterator[tuple[int, str, Any]]:
    """(page, renderer, Pillow image) for each page asked for, with form fields drawn as filled in: drawn by
    pypdfium2, or by Poppler's pdftoppm when pypdfium2 isn't installed."""
    image_mod = need("PIL.Image", "pillow", "to draw pages")
    try:
        pdfium = importlib.import_module("pypdfium2")
    except ImportError:
        pdfium = None
    if pdfium is not None:
        doc = pdfium.PdfDocument(path, password=password or None)
        try:
            doc.init_forms()
            for n in pages:
                yield n, "pypdfium2", doc[n - 1].render(scale=dpi / 72, may_draw_forms=True).to_pil().convert("RGB")
        finally:
            doc.close()
        return
    tool = shutil.which("pdftoppm")
    if not tool:
        raise Fail("drawing pages needs pypdfium2 (python -m pip install pypdfium2) or Poppler's pdftoppm on PATH")
    with tempfile.TemporaryDirectory() as tmp:
        for n in pages:
            prefix = os.path.join(tmp, f"p{n}")
            cmd = [tool, "-png", "-r", str(dpi), "-f", str(n), "-l", str(n), "-singlefile"]
            if password:
                cmd += ["-upw", password]
            try:
                proc = subprocess.run(cmd + [path, prefix], capture_output=True, text=True, errors="replace",
                                      timeout=PAGE_TIMEOUT)
            except subprocess.TimeoutExpired:
                raise Fail(f"pdftoppm took more than {PAGE_TIMEOUT} seconds on page {n}: try a lower --dpi") from None
            if proc.returncode != 0:
                raise Fail(f"pdftoppm failed on page {n}: {proc.stderr.strip()}")
            with image_mod.open(prefix + ".png") as im:
                yield n, "pdftoppm", im.convert("RGB")


def add_password(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--password", help="password for an encrypted input")
    parser.add_argument("--password-file", help="read the input's password from the first line of this file")


# ---------------------------------------------------------------- reading fields

FF_READ_ONLY, FF_REQUIRED = 1, 1 << 1
FF_MULTILINE, FF_NO_TOGGLE_OFF, FF_RADIO, FF_PUSH = 1 << 12, 1 << 14, 1 << 15, 1 << 16
FF_COMBO, FF_EDIT, FF_MULTI_SELECT, FF_COMB = 1 << 17, 1 << 18, 1 << 21, 1 << 24
F_HIDDEN, F_PRINT = 1 << 1, 1 << 2  # annotation flags (PDF 32000-1, 12.5.3)


def inherited(node: Any, key: str) -> Any:
    seen = 0
    while node is not None and seen < 50:
        node = node.get_object()
        if key in node:
            return node[key]
        node = node.get("/Parent")
        seen += 1
    return None


def qualified_name(node: Any) -> str:
    parts = []
    seen = 0
    while node is not None and seen < 50:
        node = node.get_object()
        if "/T" in node:
            parts.append(str(node["/T"]))
        node = node.get("/Parent")
        seen += 1
    return ".".join(reversed(parts))


def terminal_fields(doc: Any) -> Iterator[tuple[str, Any]]:
    """Each field that holds a value (not a parent that only groups others), with its full dotted name."""
    acro = doc.root_object.get("/AcroForm")
    if acro is None:
        return
    stack = list(acro.get_object().get("/Fields", []))
    seen: set[int] = set()
    while stack:
        ref = stack.pop(0)
        node = ref.get_object()
        if id(node) in seen:
            continue
        seen.add(id(node))
        kids = [k.get_object() for k in node.get("/Kids", [])]
        named_kids = [k for k in kids if "/T" in k]
        if named_kids:
            stack = [k for k in node["/Kids"] if "/T" in k.get_object()] + stack
            continue
        yield qualified_name(node), node


def field_kind(node: Any) -> str:
    ft = inherited(node, "/FT")
    flags = int(inherited(node, "/Ff") or 0)
    if ft == "/Tx":
        return "text"
    if ft == "/Btn":
        if flags & FF_PUSH:
            return "button"
        return "radio" if flags & FF_RADIO else "checkbox"
    if ft == "/Ch":
        return "dropdown" if flags & FF_COMBO else "listbox"
    if ft == "/Sig":
        return "signature"
    return "unknown"


def widgets_of(node: Any) -> list[Any]:
    kids = node.get("/Kids")
    if kids:
        return [k.get_object() for k in kids]
    return [node]


def on_states(widget: Any) -> list[str]:
    ap = widget.get("/AP")
    if ap is None:
        return []
    normal = ap.get_object().get("/N")
    if normal is None:
        return []
    normal = normal.get_object()
    if not hasattr(normal, "keys") or "/Subtype" in normal or hasattr(normal, "get_data"):
        return []
    return [str(k) for k in normal.keys() if str(k) != "/Off"]


def button_labels(node: Any, widgets: list[Any]) -> dict[str, str]:
    """What each on-state of a checkbox or radio group stands for, when the field lists it in /Opt: one entry per
    button, in order. Forms that do this often name the states only /0, /1..., which say nothing on their own."""
    opt = inherited(node, "/Opt")
    if not isinstance(opt, list) or len(opt) != len(widgets):
        return {}
    labels: dict[str, str] = {}
    for widget, entry in zip(widgets, opt):
        entry = entry.get_object() if hasattr(entry, "get_object") else entry
        for state in on_states(widget):
            labels.setdefault(state, str(entry))
    return labels


def choice_options(node: Any) -> list[dict[str, str]]:
    out = []
    for opt in inherited(node, "/Opt") or []:
        opt = opt.get_object() if hasattr(opt, "get_object") else opt
        if isinstance(opt, list) and len(opt) >= 2:
            out.append({"value": str(opt[0]), "label": str(opt[1])})
        else:
            out.append({"value": str(opt), "label": str(opt)})
    return out


def field_font(doc: Any, node: Any) -> tuple[Any, float | None]:
    """The font a text field draws with (from the form's resources) and its size, from the field's /DA."""
    da = inherited(node, "/DA")
    acro = doc.root_object.get("/AcroForm")
    acro = acro.get_object() if acro is not None else {}
    da = str(da if da is not None else acro.get("/DA", ""))
    m = re.search(r"/([^\s/]+)\s+([\d.]+)\s+Tf", da)
    fonts = acro.get("/DR", {}).get_object().get("/Font", {}) if "/DR" in acro else {}
    font = fonts.get_object().get("/" + m.group(1)) if m and fonts else None
    return (font.get_object() if font is not None else None), (float(m.group(2)) if m else None)


def unicode_font(doc: Any, node: Any) -> bool:
    """Whether the field draws with a composite (Type0) font, the only kind that reaches past 256 letters. Fields
    usually name a simple font such as Helvetica, which covers Western European letters only."""
    font, _ = field_font(doc, node)
    return font is not None and font.get("/Subtype") == "/Type0"


def cut_off(doc: Any, node: Any, value: str) -> str | None:
    """Why a text value won't show whole in its box, or None. pypdf draws a field with a fixed font size as it is,
    without wrapping, so a longer value shows only its start, in the field and in a flattened copy. Measured with
    reportlab's metrics for the standard font nearest the field's; None when it can't tell."""
    flags = int(inherited(node, "/Ff") or 0)
    font, size = field_font(doc, node)
    if not size or flags & FF_COMB:
        return None  # automatic size: pypdf shrinks the value (and wraps it, multiline) to fit
    try:
        pdfmetrics = importlib.import_module("reportlab.pdfbase.pdfmetrics")
    except ImportError:
        return None
    base = str(font.get("/BaseFont", "")) if font is not None else ""
    family = "Courier" if "Courier" in base else "Times" if "Times" in base else "Helvetica"
    bold = "Bold" in base
    name = {"Times": "Times-Bold" if bold else "Times-Roman"}.get(family, family + ("-Bold" if bold else ""))
    widget = widgets_of(node)[0]
    box = rect(widget)
    style = widget.get("/BS")
    border = float(style.get_object().get("/W", 1)) if style is not None else 1.0
    room = box[2] - box[0] - 4 * max(border, 1)  # pypdf's text area inside the border
    lines = value.splitlines() or [""]
    multiline = bool(flags & FF_MULTILINE)
    if not multiline and len(lines) > 1:
        return "on several lines, and this field shows one"
    if max(pdfmetrics.stringWidth(line, name, size) for line in lines) > room:
        return f"wider than its box at {size:g} pt"
    # pypdf spaces lines by the font's bounding-box height: 1156, 1116 and 1055 thousandths of the size for
    # Helvetica, Times and Courier (Adobe's core-font metrics)
    leading = {"Helvetica": 1.156, "Times": 1.116, "Courier": 1.055}[family] * size
    if multiline and len(lines) * leading > box[3] - box[1]:
        return f"more lines than its box holds at {size:g} pt"
    return None


def plain(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, list):
        return [str(v) for v in value]
    return str(value)


def page_map(doc: Any) -> dict[int, int]:
    """id of each widget dictionary -> its 1-based page."""
    where: dict[int, int] = {}
    for n, page in enumerate(doc.pages, 1):
        for ref in page.get("/Annots", []) or []:
            annot = ref.get_object()
            if annot.get("/Subtype") == "/Widget":
                where[id(annot)] = n
    return where


def rect(widget: Any) -> list[float]:
    r = [float(v) for v in widget.get("/Rect", [0, 0, 0, 0])]
    return [round(min(r[0], r[2]), 2), round(min(r[1], r[3]), 2), round(max(r[0], r[2]), 2), round(max(r[1], r[3]), 2)]


def describe(doc: Any) -> list[dict[str, Any]]:
    pages = page_map(doc)
    out = []
    for name, node in terminal_fields(doc):
        kind = field_kind(node)
        flags = int(inherited(node, "/Ff") or 0)
        widgets = widgets_of(node)
        entry: dict[str, Any] = {
            "name": name,
            "type": kind,
            "value": plain(inherited(node, "/V")),
            "pages": sorted({pages[id(w)] for w in widgets if id(w) in pages}),
            "rect": rect(widgets[0]) if widgets else None,
        }
        labels = button_labels(node, widgets) if kind in ("checkbox", "radio") else {}
        if kind == "checkbox":
            states = sorted({s for w in widgets for s in on_states(w)})
            entry["on_value"] = states[0] if len(states) == 1 else states
        elif kind == "radio":
            entry["options"] = []
            entry["widgets"] = []
            for w in widgets:
                for s in on_states(w):
                    if s not in entry["options"]:
                        entry["options"].append(s)
                    button = {"option": s, "page": pages.get(id(w)), "rect": rect(w)}
                    if s in labels:
                        button["label"] = labels[s]
                    entry["widgets"].append(button)
        elif kind in ("dropdown", "listbox"):
            entry["options"] = choice_options(node)
            entry["editable"] = bool(flags & FF_EDIT)
            entry["multi_select"] = bool(flags & FF_MULTI_SELECT)
        elif kind == "text":
            entry["multiline"] = bool(flags & FF_MULTILINE)
            max_len = inherited(node, "/MaxLen")
            entry["max_length"] = int(max_len) if max_len is not None else None
        if labels:
            entry["labels"] = labels
        entry["required"] = bool(flags & FF_REQUIRED)
        entry["read_only"] = bool(flags & FF_READ_ONLY)
        tip = inherited(node, "/TU")
        if tip:
            entry["tooltip"] = str(tip)
        if kind == "signature":
            entry["signed"] = inherited(node, "/V") is not None
            entry["value"] = None
        out.append(entry)
    return out


def form_flags(doc: Any) -> dict[str, Any]:
    acro = doc.root_object.get("/AcroForm")
    acro = acro.get_object() if acro is not None else {}
    return {"xfa": "/XFA" in acro, "need_appearances": bool(acro.get("/NeedAppearances", False))}


def cmd_fields(args: argparse.Namespace) -> None:
    reader = open_pdf(args.file, read_password(args))
    fields = describe(reader)
    result: dict[str, Any] = {"file": args.file, "count": len(fields), **form_flags(reader), "fields": fields}
    if result["xfa"]:
        result["warning"] = ("this is an XFA form (made in Adobe's form designer): Acrobat may show its own XFA data "
                             "instead of these fields; fill it in Acrobat or ask for a version without XFA")
    if not fields:
        result["note"] = ("no fillable fields: the form is printed on the page; see pdf_forms.py layout "
                          "and references/forms.md (forms without fields)")
    emit(result)


# ---------------------------------------------------------------- filling


def normalise(field: dict[str, Any], value: Any) -> tuple[Any, list[str]]:
    """The value pypdf should write, or problems explaining why the value doesn't fit the field."""
    kind, name = field["type"], field["name"]
    if kind == "text":
        if isinstance(value, bool) or isinstance(value, (dict, list)):
            return None, [f"{name}: a text field takes a string"]
        return ("" if value is None else str(value)), []
    if kind == "checkbox":
        on = field.get("on_value")
        on_list = [s for s in (on if isinstance(on, list) else [on]) if s] or ["/Yes"]
        if value is True:
            return on_list[0], []
        if value in (False, None) or str(value).lstrip("/").lower() == "off":
            return "/Off", []
        wanted = "/" + str(value).lstrip("/")
        for state in on_list:
            if state and state.lower() == wanted.lower():
                return state, []
        return None, [f"{name}: a checkbox takes true, false or {' / '.join(map(str, on_list))}, not {value!r}"]
    if kind == "radio":
        if value in (None, False) or str(value).lstrip("/").lower() == "off":
            return "/Off", []
        options, labels = field.get("options", []), field.get("labels", {})
        text = str(value)
        wanted = "/" + text.lstrip("/")
        found = [s for s in options if s == wanted] or [s for s in options if s.lower() == wanted.lower()]
        if not text.startswith("/"):  # a label from /Opt; with the slash it's only ever a state's name
            found += [s for s, label in labels.items() if label.lower() == text.lower() and s not in found]
        if len(found) == 1:
            return found[0], []
        if found:
            return None, [f"{name}: {value!r} could be {' or '.join(found)}: write the one you mean with its slash"]
        shown = ", ".join(f"{s} ({labels[s]})" if s in labels else s for s in options)
        return None, [f"{name}: choose one of {shown}, not {value!r}"]
    if kind in ("dropdown", "listbox"):
        values = value if isinstance(value, list) else [value]
        if len(values) > 1 and not field.get("multi_select"):
            return None, [f"{name}: takes one choice"]
        picked = []
        for v in values:
            v = "" if v is None else str(v)
            match = next((o["value"] for o in field["options"] if v in (o["value"], o["label"])), None)
            if match is None and not field.get("editable"):
                return None, [f"{name}: choose one of {', '.join(o['value'] for o in field['options'])}, not {v!r}"]
            picked.append(match if match is not None else v)
        return (picked if isinstance(value, list) else picked[0]), []
    return None, [f"{name}: a {kind} field can't be filled here"]


def same_value(a: Any, b: Any) -> bool:
    if isinstance(a, list) or isinstance(b, list):
        return sorted(map(str, a if isinstance(a, list) else [a])) == sorted(map(str, b if isinstance(b, list) else [b]))
    return str(a or "") == str(b or "")


def set_button_states(writer: Any, wanted: dict[str, str]) -> None:
    """Store a checkbox or radio choice as the PDF format wants it: a name on the field, and each widget showing
    its own on-state or /Off. (pypdf writes the field's value as a string.)"""
    pypdf = need("pypdf", "pypdf")
    name_obj = pypdf.generic.NameObject
    for name, node in terminal_fields(writer):
        if name not in wanted:
            continue
        value = wanted[name]
        node[name_obj("/V")] = name_obj(value)
        for w in widgets_of(node):
            states = on_states(w)
            if not states:
                continue
            w[name_obj("/AS")] = name_obj(value if value in states else "/Off")
            if w is not node and "/V" in w:
                del w["/V"]


def cmd_fill(args: argparse.Namespace) -> None:
    pypdf = need("pypdf", "pypdf")
    values = load_json(args.values)
    if not isinstance(values, dict):
        raise Fail('the values file is a JSON object: {"field name": value, ...}')
    check_output(args.out, [args.file, args.values], args.overwrite)
    reader = open_pdf(args.file, read_password(args))
    fields = {f["name"]: f for f in describe(reader)}
    nodes = dict(terminal_fields(reader))
    if not fields:
        raise Fail(f"{args.file} has no fillable fields: see pdf_forms.py layout and references/forms.md")
    problems, warnings = [], []
    text_values: dict[str, Any] = {}
    button_values: dict[str, str] = {}
    for name, value in values.items():
        field = fields.get(name)
        if field is None:
            close = difflib.get_close_matches(name, list(fields), n=3)
            problems.append(f"no field named {name!r}" + (f"; did you mean {', '.join(map(repr, close))}?" if close else ""))
            continue
        fixed, errs = normalise(field, value)
        problems += errs
        if errs:
            continue
        if field["read_only"]:
            warnings.append(f"{name} is read-only: filled anyway, but viewers won't let people change it")
        if field["type"] in ("checkbox", "radio"):
            button_values[name] = fixed
        else:
            text_values[name] = fixed
            limit = field.get("max_length")
            if limit and isinstance(fixed, str) and len(fixed) > limit:
                warnings.append(f"{name} allows {limit} characters; this value has {len(fixed)}")
            texts = fixed if isinstance(fixed, list) else [fixed]
            if isinstance(fixed, str) and field["type"] == "text":
                try:
                    why = cut_off(reader, nodes[name], fixed)
                except (AttributeError, KeyError, TypeError, ValueError):
                    why = None  # an odd field; the read-back and a rendered page still show the result
                if why:
                    tip = " or break it into lines with \\n" if field.get("multiline") and "wider" in why else ""
                    warnings.append(f"{name}: the value is {why}, so the field and a flattened copy show only part "
                                    f"of it. Shorten it{tip}, or tell the user")
            odd = sorted({ch for t in texts for ch in str(t) if not ch.isspace() and not has_glyph(ch, None)})
            if odd and not unicode_font(reader, nodes[name]):
                warnings.append(f"{name}: the field's font has no {' '.join(odd[:10])}. The value is stored correctly, "
                                "but viewers may show gaps or '?', and a flattened copy shows '?'")
    if problems:
        raise Fail("nothing written: " + "; ".join(problems))
    writer = pypdf.PdfWriter(clone_from=reader)
    if text_values:
        writer.update_page_form_field_values(None, text_values, auto_regenerate=True)
    set_button_states(writer, button_values)
    writer.set_need_appearances_writer(True)
    flattened = 0
    if args.flatten:
        flattened = flatten_writer(writer, regenerate=False)
    save(writer, args.out)
    result: dict[str, Any] = {"out": args.out, "filled": len(values), "flattened": bool(args.flatten)}
    if args.flatten:
        result["widgets_flattened"] = flattened
        text = " ".join(page.extract_text() or "" for page in open_pdf(args.out).pages)
        result["values_on_page"] = {k: (str(v) in text) for k, v in text_values.items() if isinstance(v, str) and v.strip()}
    else:
        after = {f["name"]: f for f in describe(open_pdf(args.out))}
        wanted = {**text_values, **button_values}
        mismatches = [{"name": k, "wanted": v, "found": after.get(k, {}).get("value")} for k, v in wanted.items()
                      if not same_value(after.get(k, {}).get("value"), v)]
        result["read_back"] = {k: after[k]["value"] for k in wanted if k in after}
        result["mismatches"] = mismatches
    result["warnings"] = warnings
    emit(result)
    if result.get("mismatches"):
        raise SystemExit(1)


# ---------------------------------------------------------------- flattening


def flatten_writer(writer: Any, regenerate: bool) -> int:
    """Draw every visible widget's appearance into its page, then remove the fields. Returns widgets drawn.

    Done here rather than with pypdf's flatten=True, which (in pypdf 6) leaves the widgets in place and draws
    every button of a radio group with the first button's appearance, so all of them look chosen.
    """
    pypdf = need("pypdf", "pypdf")
    gen = pypdf.generic
    if regenerate:
        # redraw text and choice fields from their values; buttons keep their own drawings
        current = {}
        for name, node in terminal_fields(writer):
            if field_kind(node) in ("text", "dropdown", "listbox"):
                v = inherited(node, "/V")
                if v is not None:
                    current[name] = [str(x) for x in v] if isinstance(v, list) else str(v)
        if current:
            writer.update_page_form_field_values(None, current, auto_regenerate=None)
        buttons = {name: str(inherited(node, "/V") or "/Off") for name, node in terminal_fields(writer)
                   if field_kind(node) in ("checkbox", "radio")}
        set_button_states(writer, buttons)
    drawn = 0
    for page in writer.pages:
        annots = page.get("/Annots")
        if not annots:
            continue
        resources = page.get("/Resources")
        if resources is None:
            page[gen.NameObject("/Resources")] = gen.DictionaryObject()
            resources = page["/Resources"]
        resources = resources.get_object()
        if "/XObject" not in resources:
            resources[gen.NameObject("/XObject")] = gen.DictionaryObject()
        xobjects = resources["/XObject"].get_object()
        commands = []
        keep = gen.ArrayObject()
        for ref in annots.get_object():
            annot = ref.get_object()
            if annot.get("/Subtype") != "/Widget":
                keep.append(ref)
                continue
            flags = int(annot.get("/F", 0))
            if flags & F_HIDDEN:
                continue
            if not flags & F_PRINT and field_kind(annot) == "button":
                continue  # an on-screen control such as "Print form" or "Clear", not part of the document
            
            ap = annot.get("/AP")
            normal = ap.get_object().raw_get("/N") if ap is not None and "/N" in ap.get_object() else None
            if normal is None:
                continue
            target = normal.get_object()
            if not hasattr(target, "get_data"):  # a dictionary of states: pick the one showing
                state = annot.get("/AS")
                if state is None or state not in target:
                    continue
                normal = target.raw_get(state)
                target = normal.get_object()
            matrix = place_matrix(target, rect(annot))
            if matrix is None:
                continue
            if not isinstance(normal, gen.IndirectObject):
                normal = writer._add_object(target)
            drawn += 1
            name = f"/AthenaFlat{drawn}"
            while gen.NameObject(name) in xobjects:
                name += "x"
            xobjects[gen.NameObject(name)] = normal
            commands.append("q {} cm {} Do Q".format(" ".join(f"{v:.4f}" for v in matrix), name))
        if commands:
            contents = page.get_contents()
            old = contents.get_data() if contents is not None else b""
            stream = gen.ContentStream(None, writer)
            stream.set_data(b"q\n" + old + b"\nQ\n" + "\n".join(commands).encode("latin-1") + b"\n")
            page.replace_contents(stream)
        if keep:
            page[gen.NameObject("/Annots")] = keep
        elif "/Annots" in page:
            del page["/Annots"]
    root = writer.root_object
    if "/AcroForm" in root:
        del root["/AcroForm"]
    return drawn


def place_matrix(stream: Any, box: list[float]) -> tuple[float, ...] | None:
    """The matrix that fits an appearance (its /BBox through its /Matrix) onto the widget's box, as PDF 32000-1
    12.5.5 describes for drawing appearance streams."""
    bbox = [float(v) for v in stream.get("/BBox", [0, 0, 0, 0])]
    a, b, c, d, e, f = [float(v) for v in stream.get("/Matrix", [1, 0, 0, 1, 0, 0])]
    xs, ys = [], []
    for x, y in ((bbox[0], bbox[1]), (bbox[2], bbox[1]), (bbox[0], bbox[3]), (bbox[2], bbox[3])):
        xs.append(a * x + c * y + e)
        ys.append(b * x + d * y + f)
    width, height = max(xs) - min(xs), max(ys) - min(ys)
    if width <= 0 or height <= 0 or box[2] <= box[0] or box[3] <= box[1]:
        return None
    sx, sy = (box[2] - box[0]) / width, (box[3] - box[1]) / height
    return (sx, 0.0, 0.0, sy, box[0] - min(xs) * sx, box[1] - min(ys) * sy)


def cmd_flatten(args: argparse.Namespace) -> None:
    pypdf = need("pypdf", "pypdf")
    check_output(args.out, [args.file], args.overwrite)
    reader = open_pdf(args.file, read_password(args))
    fields = describe(reader)
    if not fields:
        raise Fail(f"{args.file} has no form fields to flatten")
    flags = form_flags(reader)
    warnings = []
    if any(f["type"] == "signature" and f.get("signed") for f in fields):
        warnings.append("this PDF is signed: flattening changes it, so the signature no longer verifies")
    if flags["xfa"]:
        warnings.append("XFA form: what Acrobat showed may differ from these fields")
    writer = pypdf.PdfWriter(clone_from=reader)
    missing_ap = any(not w.get("/AP") for _, node in terminal_fields(writer) for w in widgets_of(node))
    regenerate = args.redraw or flags["need_appearances"] or missing_ap
    drawn = flatten_writer(writer, regenerate=regenerate)
    save(writer, args.out)
    after = open_pdf(args.out)
    emit({"out": args.out, "widgets_flattened": drawn, "fields_left": len(describe(after)),
          "redrawn_from_values": bool(regenerate), "warnings": warnings})


# ---------------------------------------------------------------- layout of a printed form


def cmd_layout(args: argparse.Namespace) -> None:
    pdfplumber = need("pdfplumber", "pdfplumber", "to read a page's layout")
    reader = open_pdf(args.file, read_password(args))
    wanted = parse_pages(args.pages, len(reader.pages))
    pages = []
    with pdfplumber.open(args.file, password=read_password(args) or None) as pdf:
        for n in wanted:
            page = pdf.pages[n - 1]
            height = float(page.height)

            def box(obj: dict[str, Any]) -> list[float]:
                return [round(float(obj["x0"]), 1), round(height - float(obj["bottom"]), 1),
                        round(float(obj["x1"]), 1), round(height - float(obj["top"]), 1)]

            lines = [{"text": ln["text"], "box": box(ln)} for ln in page.extract_text_lines(return_chars=False)]
            rects = [{"box": box(r)} for r in page.rects if float(r["width"]) >= 4 and float(r["height"]) >= 4]
            rules = [{"box": box(ln)} for ln in page.lines
                     if abs(float(ln["top"]) - float(ln["bottom"])) < 1 and float(ln["x1"]) - float(ln["x0"]) >= 20]
            marks = [{"box": box(cv)} for cv in page.curves if 4 <= float(cv["width"]) <= 30 and 4 <= float(cv["height"]) <= 30]
            entry: dict[str, Any] = {"page": n, "width_pt": round(float(page.width), 2), "height_pt": round(height, 2),
                                     "text_lines": lines, "boxes": rects, "rules": rules, "small_curves": marks}
            rotation = int(reader.pages[n - 1].rotation or 0) % 360
            if rotation:
                entry["warning"] = f"this page is turned {rotation} degrees: coordinates may not match what you see"
            if not lines:
                entry["note"] = "no text layer: render the page and measure from the image (references/forms.md)"
            pages.append(entry)
    emit({"file": args.file, "units": "PDF points from the bottom-left corner; boxes are [x0, y0, x1, y1]", "pages": pages})


# ---------------------------------------------------------------- form specs: check and build

FIELD_TYPES = ("text", "checkbox", "radio", "dropdown")
LABEL_GAP = 4.0


def spec_pages(spec: dict[str, Any], background: Any | None) -> list[tuple[float, float]]:
    if background is not None:
        return [(float(p.mediabox.width), float(p.mediabox.height)) for p in background.pages]
    pagesizes = need("reportlab.lib.pagesizes", "reportlab")
    value = spec.get("page_size", "A4")
    if isinstance(value, list) and len(value) == 2:
        size = (float(value[0]), float(value[1]))
    else:
        named = {"a4": pagesizes.A4, "letter": pagesizes.letter, "legal": pagesizes.legal}
        if str(value).lower() not in named:
            raise Fail(f"unknown page_size {value!r}: use A4, letter, legal or [width, height] in points")
        size = named[str(value).lower()]
    used = [int(f.get("page", 1)) for f in spec.get("fields", []) if isinstance(f, dict)]
    used += [int(t.get("page", 1)) for t in spec.get("texts", []) if isinstance(t, dict)]
    count = max([int(spec.get("pages", 1))] + used)
    return [size] * count


def text_width(text: str, size: float, font: str) -> float:
    pdfmetrics = need("reportlab.pdfbase.pdfmetrics", "reportlab")
    return float(pdfmetrics.stringWidth(text, font, size))


def label_box(text: str, box: list[float], side: str, size: float, font: str, top: bool = False) -> list[float]:
    w = text_width(text, size, font)
    if side == "above":
        return [box[0], box[3] + 2, box[0] + w, box[3] + 2 + size * 1.2]
    # beside the first line of a tall (multiline) box, else beside its middle
    middle = box[3] - size * 0.9 if top else (box[1] + box[3]) / 2
    y0, y1 = middle - size * 0.6, middle + size * 0.6
    if side == "right":
        return [box[2] + LABEL_GAP, y0, box[2] + LABEL_GAP + w, y1]
    return [box[0] - LABEL_GAP - w, y0, box[0] - LABEL_GAP, y1]


def good_box(value: Any) -> bool:
    return (isinstance(value, list) and len(value) == 4 and all(isinstance(v, (int, float)) for v in value)
            and value[0] < value[2] and value[1] < value[3])


def overlap(a: list[float], b: list[float]) -> bool:
    return a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]


def plan(spec: dict[str, Any], sizes: list[tuple[float, float]], font: str, glyphs: set[int] | None) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Every box the form will draw (fields, buttons, labels, texts), and the problems found in the spec."""
    problems: list[dict[str, Any]] = []
    shapes: list[dict[str, Any]] = []
    base_size = float(spec.get("font_size", 10))

    def problem(where: str, level: str, message: str) -> None:
        problems.append({"where": where, "level": level, "message": message})

    def letters_ok(where: str, text: str) -> None:
        bad = sorted({ch for ch in text if not ch.isspace() and not has_glyph(ch, glyphs)})
        if bad:
            problem(where, "error", "the label font can't draw " + " ".join(bad[:10])
                    + ('; set "font" in the spec to a .ttf that has them' if glyphs is None else ""))

    def add_label(where: str, page: int, text: str, box: list[float], side: str, size: float, top: bool = False) -> None:
        letters_ok(where, text)
        shapes.append({"kind": "label", "where": where, "page": page, "box": label_box(text, box, side, size, font, top),
                       "text": text, "size": size})

    fields = spec.get("fields")
    if not isinstance(fields, list):
        problem("spec", "error", 'needs a "fields" list')
        fields = []
    names: dict[str, str] = {}
    for i, f in enumerate(fields, 1):
        where = f"field {i}"
        if not isinstance(f, dict):
            problem(where, "error", "is not an object")
            continue
        name, kind = str(f.get("name", "")).strip(), f.get("type")
        where = f"field {i} ({name or 'no name'})"
        if not name:
            problem(where, "error", 'needs a "name"')
        elif name in names:
            problem(where, "error", f"the name {name!r} is used twice")
        names[name] = str(kind)
        if kind not in FIELD_TYPES:
            problem(where, "error", f"type is one of {', '.join(FIELD_TYPES)}")
            continue
        page = int(f.get("page", 1))
        if not 1 <= page <= len(sizes):
            problem(where, "error", f"page {page} doesn't exist (pages run 1 to {len(sizes)})")
            continue
        size = float(f.get("font_size", base_size))
        boxes: list[tuple[str, list[float], str]] = []
        if kind == "radio":
            options = f.get("options")
            if not isinstance(options, list) or len(options) < 2:
                problem(where, "error", "a radio group needs at least two options, each with a value and a box")
                continue
            values = []
            for j, opt in enumerate(options, 1):
                if not isinstance(opt, dict) or not str(opt.get("value", "")).strip() or not good_box(opt.get("box")):
                    problem(where, "error", f"option {j} needs a value and a box [x0, y0, x1, y1] with x0 < x1 and y0 < y1")
                    continue
                values.append(str(opt["value"]))
                boxes.append((f"{name}={opt['value']}", [float(v) for v in opt["box"]], "button"))
                if opt.get("label"):
                    add_label(where, page, str(opt["label"]), [float(v) for v in opt["box"]], opt.get("label_side", "right"), size)
            if len(set(values)) != len(values):
                problem(where, "error", "two options share a value")
            if f.get("value") is not None and str(f["value"]) not in values:
                problem(where, "error", f"value {f['value']!r} isn't one of the options")
        else:
            if not good_box(f.get("box")):
                problem(where, "error", "needs a box [x0, y0, x1, y1] with x0 < x1 and y0 < y1")
                continue
            boxes.append((name, [float(v) for v in f["box"]], kind))
            if kind == "dropdown":
                opts = f.get("options")
                if not isinstance(opts, list) or not opts:
                    problem(where, "error", "a dropdown needs an options list")
                elif f.get("value") not in (None, "") and str(f["value"]) not in [str(o) for o in opts] and not f.get("editable"):
                    problem(where, "error", f"value {f['value']!r} isn't one of the options")
        for label, b, shape_kind in boxes:
            w, h = b[2] - b[0], b[3] - b[1]
            if kind in ("text", "dropdown") and h < size + 2:
                problem(where, "warning", f"is {h:g} pt tall: {size:g} pt text needs about {size + 4:g}")
            if kind in ("checkbox", "radio") and min(w, h) < 8:
                problem(where, "warning", f"a {min(w, h):g} pt box is hard to click and to see")
            shapes.append({"kind": "field", "where": where, "page": page, "box": b, "text": label})
        if f.get("label") and kind != "radio" and boxes:
            side = f.get("label_side", "right" if kind == "checkbox" else "left")
            if side not in ("left", "right", "above"):
                problem(where, "error", "label_side is left, right or above")
            else:
                add_label(where, page, str(f["label"]), boxes[0][1], side, size, top=bool(f.get("multiline")))
        elif f.get("label") and kind == "radio" and boxes:
            add_label(where, page, str(f["label"]), boxes[0][1], f.get("label_side", "left"), size)
    for i, t in enumerate(spec.get("texts", []) or [], 1):
        where = f"text {i}"
        if not isinstance(t, dict) or not isinstance(t.get("at"), list) or len(t["at"]) != 2 or not str(t.get("text", "")):
            problem(where, "error", 'needs "text" and "at": [x, y] (the start of the baseline)')
            continue
        page = int(t.get("page", 1))
        if not 1 <= page <= len(sizes):
            problem(where, "error", f"page {page} doesn't exist")
            continue
        size = float(t.get("size", base_size))
        x, y = float(t["at"][0]), float(t["at"][1])
        letters_ok(where, str(t["text"]))
        shapes.append({"kind": "text", "where": where, "page": page, "text": str(t["text"]), "size": size,
                       "box": [x, y - size * 0.25, x + text_width(str(t["text"]), size, font), y + size * 0.8]})
    for s in shapes:
        w, h = sizes[s["page"] - 1]
        b = s["box"]
        if b[0] < 0 or b[1] < 0 or b[2] > w or b[3] > h:
            problem(s["where"], "error", f"{'its ' + s['kind'] if s['kind'] != 'field' else 'the box'} {fmt(b)} runs off the page (0 0 {w:g} {h:g})")
    for i, a in enumerate(shapes):
        for b in shapes[i + 1:]:
            if a["page"] != b["page"] or not overlap(a["box"], b["box"]):
                continue
            if a["kind"] == "field" and b["kind"] == "field":
                problem(b["where"], "error", f"its box overlaps {a['text']!r}")
            elif "field" in (a["kind"], b["kind"]):
                problem(b["where"], "warning", f"its {b['kind']} overlaps {a['text']!r}" if b["kind"] != "field"
                        else f"its box overlaps the {a['kind']} {a['text']!r}")
            else:
                problem(b["where"], "warning", f"its {b['kind']} overlaps {a['text']!r}")
    return shapes, problems


def fmt(box: list[float]) -> str:
    return "[" + ", ".join(f"{v:g}" for v in box) + "]"


def has_glyph(ch: str, glyphs: set[int] | None) -> bool:
    return ord(ch) in glyphs if glyphs is not None else cp1252_ok(ch)


def label_font(spec: dict[str, Any], base: str) -> tuple[str, set[int] | None]:
    if not spec.get("font"):
        return "Helvetica", None
    pdfmetrics = need("reportlab.pdfbase.pdfmetrics", "reportlab")
    ttfonts = need("reportlab.pdfbase.ttfonts", "reportlab")
    path = spec["font"] if os.path.isabs(spec["font"]) else os.path.join(base, spec["font"])
    try:
        font = ttfonts.TTFont("FormLabels", path)
    except Exception as e:
        raise Fail(f"can't use the font {path} ({e}): pick a TrueType .ttf file") from None
    pdfmetrics.registerFont(font)
    return "FormLabels", set(font.face.charToGlyph)


def draw_overlay(shapes: list[dict[str, Any]], problems: list[dict[str, Any]], sizes: list[tuple[float, float]],
                 out: str, background: str | None, dpi: int, grid: float | None) -> dict[str, Any]:
    image_mod = need("PIL.Image", "pillow", "to draw the overlay")
    draw_mod = need("PIL.ImageDraw", "pillow")
    font_mod = need("PIL.ImageFont", "pillow")
    scale = dpi / 72
    font = font_mod.load_default()
    bad = {p["where"] for p in problems if p["level"] == "error"}
    used_pages = sorted({s["page"] for s in shapes}) or list(range(1, len(sizes) + 1))
    files, notes = [], []
    pictures: dict[int, Any] = {}
    if background:
        try:
            pictures = {n: image for n, _, image in render_pages(background, used_pages, dpi)}
        except Fail as e:
            notes.append(f"drew on blank pages: {e}")
    stem, ext = os.path.splitext(out)
    for n in used_pages:
        w, h = sizes[n - 1]
        image = pictures.get(n)
        if image is None:
            image = image_mod.new("RGB", (max(1, round(w * scale)), max(1, round(h * scale))), "white")
        draw = draw_mod.Draw(image)

        def px(x: float, y: float) -> tuple[float, float]:
            return x * scale, (h - y) * scale

        if grid:
            step = float(grid)
            x = 0.0
            while x <= w:
                draw.line([px(x, 0), px(x, h)], fill=(200, 200, 200), width=1)
                draw.text((x * scale + 2, 2), f"{x:g}", fill=(120, 120, 120), font=font)
                x += step
            y = 0.0
            while y <= h:
                draw.line([px(0, y), px(w, y)], fill=(200, 200, 200), width=1)
                draw.text((2, (h - y) * scale + 2), f"{y:g}", fill=(120, 120, 120), font=font)
                y += step
        for s in shapes:
            if s["page"] != n:
                continue
            b = s["box"]
            (x0, y1), (x1, y0) = px(b[0], b[1]), px(b[2], b[3])
            colour = (220, 30, 30) if s["kind"] == "field" else (30, 90, 220)
            width = 3 if s["where"] in bad else 1
            draw.rectangle([x0, y0, x1, y1], outline=colour, width=width)
            if s["kind"] == "field":
                draw.text((x0 + 2, y0 + 1), s["text"], fill=colour, font=font)
        path = out if len(used_pages) == 1 else f"{stem}_p{n}{ext or '.png'}"
        write_atomic(path, lambda fh, im=image: im.save(fh, format="PNG"))
        files.append({"page": n, "file": path, "width_px": image.width, "height_px": image.height})
    return {"files": files, "legend": "red: field boxes (thick when that field has an error); blue: labels and texts; grey: grid in points",
            "notes": sorted(set(notes))}


def run_check(spec_path: str, background_path: str | None) -> tuple[dict[str, Any], list[dict[str, Any]], list[tuple[float, float]], Any]:
    spec = load_json(spec_path)
    if not isinstance(spec, dict):
        raise Fail('a form spec is a JSON object with a "fields" list')
    background = open_pdf(background_path) if background_path else None
    try:
        sizes = spec_pages(spec, background)
        font, glyphs = label_font(spec, os.path.dirname(os.path.abspath(spec_path)))
        shapes, problems = plan(spec, sizes, font, glyphs)
    except (TypeError, ValueError, KeyError) as e:
        raise Fail(f"a value in the spec has the wrong kind ({e}): pages and sizes are numbers, "
                   "boxes are [x0, y0, x1, y1], options are lists") from None
    if background is not None:
        for n, page in enumerate(background.pages, 1):
            if int(page.rotation or 0) % 360:
                problems.append({"where": f"page {n}", "level": "error",
                                 "message": "the page underneath is turned (/Rotate), so boxes would land in the wrong place"})
            box = page.mediabox
            if float(box.left) or float(box.bottom):
                problems.append({"where": f"page {n}", "level": "error",
                                 "message": f"the page underneath starts at ({float(box.left):g}, {float(box.bottom):g}), not "
                                            "(0, 0), so the built form would shift the printed page against the boxes"})
    report = {
        "ok": not any(p["level"] == "error" for p in problems),
        "errors": sum(p["level"] == "error" for p in problems),
        "warnings": sum(p["level"] == "warning" for p in problems),
        "pages": [{"page": i, "width_pt": round(w, 2), "height_pt": round(h, 2)} for i, (w, h) in enumerate(sizes, 1)],
        "fields": len([s for s in shapes if s["kind"] == "field"]),
        "problems": problems,
    }
    return report, shapes, sizes, (spec, font, background)


def cmd_check(args: argparse.Namespace) -> None:
    if args.dpi < 1:
        raise Fail("--dpi is a number of pixels per inch, from 1 up")
    if args.grid is not None and args.grid <= 0:
        raise Fail("--grid is a step in points, above 0 (50 is a good start)")
    report, shapes, sizes, _ = run_check(args.spec, args.pdf)
    if args.overlay:
        check_output(args.overlay, [args.spec] + ([args.pdf] if args.pdf else []), False)
        report["overlay"] = draw_overlay(shapes, report["problems"], sizes, args.overlay, args.pdf, args.dpi, args.grid)
    emit(report)
    if not report["ok"]:
        raise SystemExit(1)


def cmd_build(args: argparse.Namespace) -> None:
    pypdf = need("pypdf", "pypdf")
    canvas_mod = need("reportlab.pdfgen.canvas", "reportlab", "to build forms")
    colors = need("reportlab.lib.colors", "reportlab")
    check_output(args.out, [args.spec] + ([args.on] if args.on else []), args.overwrite)
    report, shapes, sizes, (spec, font, background) = run_check(args.spec, args.on)
    if not report["ok"] and not args.skip_check:
        emit({"built": False, "check": report})
        raise SystemExit(1)
    if background is not None and describe(background):
        raise Fail(f"{args.on} already has fillable fields: fill those instead (pdf_forms.py fields)")
    base_size = float(spec.get("font_size", 10))
    buf = io.BytesIO()
    c = canvas_mod.Canvas(buf, pagesize=sizes[0])
    c.setTitle(str(spec.get("title", "")))
    c.setAuthor(str(spec.get("author", "")))
    c.setCreator("AthenaAgents pdf_forms.py")
    form = c.acroForm
    if background is None:
        look = {"borderColor": colors.HexColor("#808080"), "fillColor": colors.white, "textColor": colors.black, "borderWidth": 1}
    else:
        # the printed form already draws its boxes: keep the fields see-through
        look = {"borderColor": colors.transparent, "fillColor": colors.transparent, "textColor": colors.black, "borderWidth": 0}
    for n, size in enumerate(sizes, 1):
        c.setPageSize(size)
        for s in shapes:
            if s["page"] == n and s["kind"] in ("label", "text"):
                c.setFont(font, s["size"])
                c.setFillColor(colors.black)
                b = s["box"]
                baseline = b[1] + s["size"] * 0.25 if s["kind"] == "text" else (b[1] + b[3]) / 2 - s["size"] * 0.35
                c.drawString(b[0], baseline, s["text"])
        for i, f in enumerate(spec.get("fields", []), 1):
            try:
                if int(f.get("page", 1)) != n:
                    continue
                name, kind = str(f["name"]), f["type"]
                size_pt = float(f.get("font_size", base_size))
                flags = "required" if f.get("required") else ""
                tip = str(f.get("tooltip") or f.get("label") or name)
                if kind == "radio":
                    for opt in f["options"]:
                        x0, y0, x1, y1 = [float(v) for v in opt["box"]]
                        form.radio(name=name, value=str(opt["value"]), selected=str(f.get("value")) == str(opt["value"]),
                                   x=x0, y=y0, size=min(x1 - x0, y1 - y0), buttonStyle="circle", shape="circle",
                                   fieldFlags=("noToggleToOff radio " + flags).strip(), tooltip=tip, **look)
                    continue
                x0, y0, x1, y1 = [float(v) for v in f["box"]]
                if kind == "text":
                    form.textfield(name=name, value="" if f.get("value") is None else str(f["value"]), x=x0, y=y0, width=x1 - x0, height=y1 - y0,
                                   fontName="Helvetica", fontSize=size_pt, maxlen=f.get("max_length"),
                                   fieldFlags=(("multiline " if f.get("multiline") else "") + flags).strip(), tooltip=tip, **look)
                elif kind == "checkbox":
                    form.checkbox(name=name, checked=bool(f.get("checked", False)), x=x0, y=y0, size=min(x1 - x0, y1 - y0),
                                  buttonStyle="check", fieldFlags=flags, tooltip=tip, **look)
                elif kind == "dropdown":
                    opts = [str(o) for o in f["options"]]
                    chosen = str(f.get("value")) if str(f.get("value")) in opts else opts[0]
                    form.choice(name=name, options=opts, value=chosen,
                                x=x0, y=y0, width=x1 - x0, height=y1 - y0, fontName="Helvetica", fontSize=size_pt,
                                fieldFlags=("combo " + ("edit " if f.get("editable") else "") + flags).strip(), tooltip=tip, **look)
            except (AttributeError, IndexError, KeyError, TypeError, ValueError) as e:
                # --skip-check gets past layout problems (overlaps, a box off the page), not a field with parts missing
                raise Fail(f"field {i} can't be built ({type(e).__name__}: {e}): fix the errors check reports") from None
        c.showPage()
    c.save()
    buf.seek(0)
    writer = pypdf.PdfWriter(clone_from=pypdf.PdfReader(buf))
    if background is not None:
        for page, under in zip(writer.pages, background.pages):
            page.merge_page(under, over=False)
        if background.metadata and not spec.get("title"):
            writer.add_metadata({k: str(v) for k, v in background.metadata.items()})
    save(writer, args.out)
    built = {f["name"]: f["type"] for f in describe(open_pdf(args.out))}
    wanted = {str(f["name"]): f["type"] for f in spec.get("fields", [])}
    missing = [k for k in wanted if k not in built]
    emit({"out": args.out, "built": True, "pages": len(sizes), "fields": built, "missing": missing, "check": report})
    if missing:
        raise SystemExit(1)


# ---------------------------------------------------------------- command line


def build_parser() -> argparse.ArgumentParser:
    p = Parser(prog="pdf_forms.py", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="command", metavar="COMMAND")

    def add(name: str, func: Callable[[argparse.Namespace], None], help_text: str, example: str) -> argparse.ArgumentParser:
        sp = sub.add_parser(name, help=help_text, description=help_text, epilog=f"example:\n  {example}",
                            formatter_class=argparse.RawDescriptionHelpFormatter)
        sp.set_defaults(func=func)
        return sp

    sp = add("fields", cmd_fields, "List the form's fields: exact names, types, current values, accepted values, pages and boxes, "
             "and for buttons whose states are only numbered, what each stands for (labels).",
             "python pdf_forms.py fields application.pdf")
    sp.add_argument("file")
    add_password(sp)

    sp = add("fill", cmd_fill, 'Fill fields from a JSON file of {"field name": value}, then read the output back. '
             "Text fields take strings; checkboxes true/false; radio groups one of their options or its label; "
             "dropdowns one of their options. Exits 1 when a value reads back different.",
             "python pdf_forms.py fill application.pdf values.json -o filled.pdf")
    sp.add_argument("file")
    sp.add_argument("values", help='JSON object of field name -> value (UTF-8; UTF-16 and ANSI files are read too)')
    sp.add_argument("-o", "--out", required=True)
    sp.add_argument("--flatten", action="store_true", help="also turn the filled fields into page content")
    add_password(sp)
    sp.add_argument("--overwrite", action="store_true", help="allow the output to replace an input file")

    sp = add("flatten", cmd_flatten, "Draw the fields' current values into the pages and remove the fields.",
             "python pdf_forms.py flatten filled.pdf -o final.pdf")
    sp.add_argument("file")
    sp.add_argument("-o", "--out", required=True)
    sp.add_argument("--redraw", action="store_true", help="redraw text fields from their values first (done anyway when the form asks viewers to)")
    add_password(sp)
    sp.add_argument("--overwrite", action="store_true", help="allow the output to replace the input")

    sp = add("layout", cmd_layout, "The text lines, boxes, underlines and small marks printed on pages, in PDF points: "
             "for placing fields on a form that has none.", "python pdf_forms.py layout paper-form.pdf --pages 1")
    sp.add_argument("file")
    sp.add_argument("--pages", help="pages to read, like 1-2 (default: all)")
    add_password(sp)

    sp = add("check", cmd_check, "Check a form spec (boxes on the page, overlaps, sizes, options) and draw it as a PNG to look at. "
             "Exits 1 when it finds errors.",
             "python pdf_forms.py check form.json --overlay check.png --on paper-form.pdf --grid 50")
    sp.add_argument("spec")
    sp.add_argument("--overlay", help="PNG to draw the boxes into (one per page: name_p2.png and so on)")
    sp.add_argument("--on", "--pdf", dest="pdf", help="draw over this PDF's pages (the one you will build --on) instead of blank pages")
    sp.add_argument("--dpi", type=int, default=100, help="overlay resolution (default 100)")
    sp.add_argument("--grid", type=float, help="draw a grid every N points, labelled, to measure positions")

    sp = add("build", cmd_build, "Make a fillable form from a spec, after checking it. With --on, the fields go over an existing PDF's pages. "
             "Exits 1 when the check finds errors (nothing is written) or a field is missing from the file it wrote.",
             "python pdf_forms.py build form.json -o fillable.pdf --on paper-form.pdf")
    sp.add_argument("spec")
    sp.add_argument("-o", "--out", required=True)
    sp.add_argument("--on", help="an existing PDF (a printed form) to lay the fields over")
    sp.add_argument("--skip-check", action="store_true", help="build even when the check finds errors")
    sp.add_argument("--overwrite", action="store_true", help="allow the output to replace an input file")
    return p


def main(argv: list[str] | None = None) -> int:
    utf8_output()
    parser = build_parser()
    args = parser.parse_args(argv)
    if not getattr(args, "func", None):
        parser.error("needs a command, such as fields")
    return run_job(f"pdf_forms.py {args.command}", lambda: args.func(args))


if __name__ == "__main__":
    sys.exit(main())
