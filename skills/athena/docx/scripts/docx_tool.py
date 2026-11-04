#!/usr/bin/env python3
"""Look inside Word documents and change them: info, text, images, check, edit, fill, revisions, comments.

Packages: python-docx 1.2 or newer, which brings lxml (python -m pip install python-docx). check needs only lxml.

Works on .docx files, and on .docm, .dotx and .dotm. Paragraphs, tables, rows and cells are numbered from 1, in the
order `text` lists them: the body's paragraphs outside tables, and the body's tables (not tables inside tables).
Commands that change a document need -o, won't write over their input unless given --overwrite, and write nothing
when they find a problem (fill and revisions write anyway with --partial). Results are printed on stdout as JSON.
Exit codes: 0 done; 1 the command ran and found problems, which the JSON lists (text not found, tokens with no value,
changes it can't resolve, an unhealthy file); 2 it couldn't do the job, and one line on stderr says why.
"""

from __future__ import annotations

import argparse
import codecs
import copy
import importlib
import json
import locale
import os
import posixpath
import re
import sys
import tempfile
import zipfile
from collections import Counter
from datetime import datetime, timezone
from typing import Any, Callable, Iterator, NoReturn
from urllib.parse import unquote


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


# ---------------------------------------------------------------- WordprocessingML


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


P, R, T, TBL, TR, TC = qn("w:p"), qn("w:r"), qn("w:t"), qn("w:tbl"), qn("w:tr"), qn("w:tc")
PPR, RPR, PSTYLE, SECTPR = qn("w:pPr"), qn("w:rPr"), qn("w:pStyle"), qn("w:sectPr")
SDT, SDTPR, SDTCONTENT, CUSTOMXML = qn("w:sdt"), qn("w:sdtPr"), qn("w:sdtContent"), qn("w:customXml")
INS, DEL, MOVEFROM, MOVETO = qn("w:ins"), qn("w:del"), qn("w:moveFrom"), qn("w:moveTo")
DELTEXT, INSTR, DELINSTR = qn("w:delText"), qn("w:instrText"), qn("w:delInstrText")
TAB, PTAB, BR, CR = qn("w:tab"), qn("w:ptab"), qn("w:br"), qn("w:cr")
TXBX, ALT, CHOICE, FALLBACK = qn("w:txbxContent"), qn("mc:AlternateContent"), qn("mc:Choice"), qn("mc:Fallback")
FLDCHAR, FLDSIMPLE = qn("w:fldChar"), qn("w:fldSimple")
C_START, C_END, C_REF = qn("w:commentRangeStart"), qn("w:commentRangeEnd"), qn("w:commentReference")
B_START, B_END = qn("w:bookmarkStart"), qn("w:bookmarkEnd")
W_ID, W_AUTHOR, W_DATE, W_VAL = qn("w:id"), qn("w:author"), qn("w:date"), qn("w:val")
SPACE = qn("xml:space")
MARKERS = {C_START, C_END, B_START, B_END}
# Paragraph-level things with no text of their own, which text can run across.
TRANSPARENT = {qn(f"w:{x}") for x in (
    "pPr", "rPr", "sdtPr", "sdtEndPr", "customXmlPr", "smartTagPr", "del", "moveFrom", "instrText", "delText",
    "delInstrText", "lastRenderedPageBreak", "bookmarkStart", "bookmarkEnd", "commentRangeStart", "commentRangeEnd",
    "proofErr", "permStart", "permEnd", "moveFromRangeStart", "moveFromRangeEnd", "moveToRangeStart",
    "moveToRangeEnd", "fldData", "annotationRef")}

def para_items(p: Any) -> list[tuple[Any, str]]:
    """What a paragraph shows, in order: its w:t elements, and in between the tabs, breaks, pictures, fields and
    notes that text can't run across. Deleted text, field codes and text boxes (read separately) are left out, and
    so is the fallback copy of anything stored twice."""
    items: list[tuple[Any, str]] = []

    def run(r: Any) -> None:
        for c in r:
            tag = c.tag
            if not isinstance(tag, str) or tag in TRANSPARENT or tag == C_REF:  # a comment's mark isn't text
                continue
            if tag == T:
                items.append((c, c.text or ""))
            elif tag in (TAB, PTAB):
                items.append((None, "\t"))
            elif tag in (BR, CR):
                items.append((None, "\n"))
            elif tag == qn("w:noBreakHyphen"):
                items.append((None, "‑"))
            elif tag in (qn("w:footnoteReference"), qn("w:endnoteReference")):
                items.append((None, f"[{c.get(W_ID)}]"))
            else:  # pictures, fields, symbols
                items.append((None, ""))

    def walk(el: Any) -> None:
        for c in el:
            tag = c.tag
            if not isinstance(tag, str) or tag in TRANSPARENT or tag == P:
                continue
            if tag == R:
                run(c)
            elif tag == ALT:
                choice = c.find(CHOICE)
                if choice is not None:
                    walk(choice)
            elif tag in (qn("m:oMath"), qn("m:oMathPara")):
                items.append((None, "".join(t.text or "" for t in c.iter(qn("m:t")))))
            else:
                walk(c)

    walk(p)
    return items


class Para:
    """A paragraph's text, for searching: `search` has one NUL for each thing text can't run across."""

    def __init__(self, p: Any) -> None:
        self.p = p
        self.items = para_items(p)
        self.search = "".join(t if el is not None else "\0" for el, t in self.items)
        self.visible = "".join(t for _, t in self.items)

    def has_content(self) -> bool:
        return any(el is None or t for el, t in self.items)

    def spans(self, a: int, b: int) -> list[tuple[int, int, int]]:
        """(item, start, end) for each w:t that the characters a to b of `search` fall in."""
        out, pos = [], 0
        for i, (el, t) in enumerate(self.items):
            n = len(t) if el is not None else 1
            if el is not None and n and pos < b and pos + n > a:
                out.append((i, max(a, pos) - pos, min(b, pos + n) - pos))
            pos += n
        return out


def under(el: Any, tag: str, stop: Any = None) -> bool:
    for a in el.iterancestors():
        if a is stop:
            return False
        if a.tag == tag:
            return True
    return False


def own_paragraphs(el: Any) -> list[Any]:
    """Paragraphs in el, without those in text boxes or in the fallback copy of something stored twice."""
    return [p for p in el.iter(P) if not under(p, TXBX, el) and not under(p, FALLBACK, el)]


def para_text(p: Any) -> str:
    return Para(p).visible


def text_boxes(root: Any) -> list[str]:
    out = []
    for box in root.iter(TXBX):
        if not under(box, FALLBACK):
            text = "\n".join(para_text(p) for p in box.iter(P) if not under(p, TXBX, box))
            if text.strip():
                out.append(text)
    return out


def body_blocks(body: Any) -> list[tuple[str, Any]]:
    """('p', paragraph) and ('t', table) in the body's order, looking inside content controls."""
    out: list[tuple[str, Any]] = []

    def walk(el: Any) -> None:
        for c in el:
            if c.tag == P:
                out.append(("p", c))
            elif c.tag == TBL:
                out.append(("t", c))
            elif c.tag == SDT:
                content = c.find(SDTCONTENT)
                if content is not None:
                    walk(content)
            elif c.tag == CUSTOMXML:
                walk(c)

    walk(body)
    return out


def children_of(el: Any, tag: str) -> list[Any]:
    """Direct children with this tag, looking inside content controls (rows and cells can be wrapped in them)."""
    out = []
    for c in el:
        if c.tag == tag:
            out.append(c)
        elif c.tag == SDT and c.find(SDTCONTENT) is not None:
            out.extend(children_of(c.find(SDTCONTENT), tag))
        elif c.tag == CUSTOMXML:
            out.extend(children_of(c, tag))
    return out


def cell_text(tc: Any) -> str:
    return "\n".join(para_text(p) for p in own_paragraphs(tc))


def table_rows(tbl: Any) -> list[list[str]]:
    return [[cell_text(tc) for tc in children_of(tr, TC)] for tr in children_of(tbl, TR)]


class Story:
    def __init__(self, name: str, kind: str, root: Any) -> None:
        self.name, self.kind, self.root = name, kind, root


def stories(doc: Any, comments: bool = False) -> list[Story]:
    """The body, then headers, footers, footnotes and endnotes (and the comments, if asked)."""
    found = [Story("body", "body", doc.element)]
    others = []
    for part in doc.part.package.iter_parts():
        ct = part.content_type
        if not ct.startswith(CT_PREFIX) or not hasattr(part, "element"):
            continue
        kind = ct[len(CT_PREFIX):].split("+")[0]
        if kind in ("header", "footer", "footnotes", "endnotes") or (comments and kind == "comments"):
            name = posixpath.splitext(posixpath.basename(str(part.partname)))[0]
            others.append(Story(name, kind, part.element))
    order = {"header": 0, "footer": 1, "footnotes": 2, "endnotes": 3, "comments": 4}
    others.sort(key=lambda s: (order[s.kind], len(s.name), s.name))
    return found + others


def find_part(doc: Any, suffix: str) -> Any:
    for part in doc.part.package.iter_parts():
        if part.content_type == CT_PREFIX + suffix and hasattr(part, "element"):
            return part
    return None


def style_names(doc: Any) -> tuple[dict[str, str], str]:
    """styleId -> the name Word shows, and the name of the default paragraph style."""
    from docx.styles import BabelFish

    names, default = {}, "Normal"
    for s in doc.styles.element.iter(qn("w:style")):
        name_el = s.find(qn("w:name"))
        name = BabelFish.internal2ui(name_el.get(W_VAL)) if name_el is not None else s.get(qn("w:styleId"))
        names[s.get(qn("w:styleId"))] = name
        if s.get(qn("w:type")) == "paragraph" and s.get(qn("w:default")) in ("1", "true", "on"):
            default = name
    return names, default


def para_style(p: Any, names: dict[str, str], default: str) -> str:
    ppr = p.find(PPR)
    ps = ppr.find(PSTYLE) if ppr is not None else None
    if ps is None:
        return default
    return names.get(ps.get(W_VAL), ps.get(W_VAL))


def preserve(t: Any) -> None:
    t.set(SPACE, "preserve")


def make(like: Any, tag: str, attrs: dict[str, str] | None = None) -> Any:
    """A new element in the same document as `like`, so python-docx's element classes apply to it."""
    el = like.makeelement(tag, {})
    for k, v in (attrs or {}).items():
        el.set(k, v)
    return el


def new_run(like: Any, rpr: Any, text: str) -> Any:
    r = make(like, R)
    if rpr is not None:
        r.append(copy.deepcopy(rpr))
    t = make(like, T)
    t.text = text
    preserve(t)
    r.append(t)
    expand_breaks(t)
    return r


def expand_breaks(t: Any) -> None:
    """Turn line breaks and tabs inside a w:t's text into Word's own break and tab elements."""
    text = t.text or ""
    if "\n" not in text and "\t" not in text:
        return
    pieces = re.split(r"(\r\n|\n|\t)", text)
    t.text = pieces[0]
    anchor = t
    for piece in pieces[1:]:
        if piece in ("\n", "\r\n"):
            el = make(t, BR)
        elif piece == "\t":
            el = make(t, TAB)
        elif piece:
            el = make(t, T)
            el.text = piece
            preserve(el)
        else:
            continue
        anchor.addnext(el)
        anchor = el
    if not t.text:
        t.getparent().remove(t)


def drop_if_empty(t: Any) -> None:
    """Remove a w:t left empty, and its run if nothing else is left in it."""
    r = t.getparent()
    if r is None or t.text:
        return
    r.remove(t)
    if r.tag == R and all(c.tag == RPR for c in r) and r.getparent() is not None:
        r.getparent().remove(r)


def replace_spans(para: Para, edits: list[tuple[int, int, str]]) -> None:
    """Replace the characters a to b of para.search with the new text, for each (a, b, new), keeping the formatting
    of the run each match starts in. Spans are worked out before any change and applied from the end backwards, so
    an earlier one is never moved by a later one."""
    plans = [(para.spans(a, b), new) for a, b, new in sorted(edits)]
    touched = []
    for parts, new in reversed(plans):
        if not parts:
            continue
        i0, s0, e0 = parts[0]
        first = para.items[i0][0]
        text = first.text or ""
        if len(parts) == 1:
            first.text = text[:s0] + new + text[e0:]
        else:
            first.text = text[:s0] + new
            for i, _, _ in parts[1:-1]:
                para.items[i][0].text = ""
            il, _, el = parts[-1]
            last = para.items[il][0]
            last.text = (last.text or "")[el:]
            touched.append(last)
        touched.append(first)
        touched.extend(para.items[i][0] for i, _, _ in parts[1:-1])
    for t in dict.fromkeys(touched):
        preserve(t)
        if t.getparent() is not None:
            expand_breaks(t)
        if t.getparent() is not None:
            drop_if_empty(t)


def split_t(t: Any, k: int) -> Any:
    """Split a w:t after k characters; the new w:t, holding the rest, follows it in the same run."""
    rest = make(t, T)
    rest.text = (t.text or "")[k:]
    t.text = (t.text or "")[:k]
    preserve(t)
    preserve(rest)
    t.addnext(rest)
    return rest


def split_run(child: Any, before: bool) -> None:
    """Move what comes before (or after) child in its run into a run of its own with the same formatting."""
    r = child.getparent()
    kids = [c for c in r if c.tag != RPR]
    i = kids.index(child)
    moving = kids[:i] if before else kids[i + 1:]
    if not moving:
        return
    other = make(r, R, dict(r.attrib))
    rpr = r.find(RPR)
    if rpr is not None:
        other.append(copy.deepcopy(rpr))
    for c in moving:
        other.append(c)
    if before:
        r.addprevious(other)
    else:
        r.addnext(other)


def isolate(para: Para, a: int, b: int) -> list[Any]:
    """Split w:t elements and runs so that characters a to b are whole runs; returns those runs in order."""
    parts = para.spans(a, b)
    i0, s0, _ = parts[0]
    il, _, el = parts[-1]
    first, last = para.items[i0][0], para.items[il][0]
    if first is last:
        if el < len(first.text or ""):
            split_t(first, el)
        if s0:
            first = last = split_t(first, s0)
    else:
        if el < len(last.text or ""):
            split_t(last, el)
        if s0:
            first = split_t(first, s0)
    split_run(first, before=True)
    split_run(last, before=False)
    runs = [first.getparent()]
    for i, _, _ in parts[1:]:
        r = para.items[i][0].getparent()
        if r is not runs[-1]:
            runs.append(r)
    if last.getparent() is not runs[-1]:
        runs.append(last.getparent())
    return runs


def merge_runs(root: Any) -> int:
    """Join neighbouring runs that look the same, so text Word split up (spelling marks, editing sessions) can be
    found and replaced as one. Changes nothing anyone sees. Returns how many runs were joined."""
    plain = {RPR, T, TAB, CR, qn("w:noBreakHyphen"), qn("w:softHyphen"), qn("w:lastRenderedPageBreak")}

    def mergeable(r: Any) -> bool:
        return all(c.tag in plain or (c.tag == BR and c.get(qn("w:type")) in (None, "textWrapping")) for c in r)

    def key(r: Any) -> bytes:
        from lxml import etree

        rpr = r.find(RPR)
        return etree.tostring(rpr) if rpr is not None else b""

    for err in list(root.iter(qn("w:proofErr"))):
        err.getparent().remove(err)
    merged = 0
    parents = {r.getparent() for r in root.iter(R)}
    for parent in parents:
        prev = None
        for child in list(parent):
            if child.tag == R and mergeable(child):
                if prev is not None and key(prev) == key(child):
                    for c in list(child):
                        if c.tag != RPR:
                            prev.append(c)
                    parent.remove(child)
                    merged += 1
                    continue
                prev = child
            else:
                prev = None
    for r in root.iter(R):
        ts = list(r)
        for x, y in zip(ts, ts[1:]):
            if x.tag == T and y.tag == T and y.getparent() is r and x.getparent() is r:
                y.text = (x.text or "") + (y.text or "")
                preserve(y)
                r.remove(x)
    return merged


def edit_paragraphs(doc: Any) -> Iterator[tuple[Story, Any, bool]]:
    """(story, paragraph, counts) for every paragraph whose text can be edited; counts is False for the fallback
    copy of a text box, which is changed too but not counted twice."""
    for story in stories(doc):
        for p in list(story.root.iter(P)):
            yield story, p, not under(p, FALLBACK)


class Locator:
    """Says where an element is: 'paragraph 3' or 'table 2' in the body, or the part's name."""

    def __init__(self, doc: Any) -> None:
        self.where: dict[Any, str] = {}
        p_n = t_n = 0
        for kind, el in body_blocks(doc.element.body):
            if kind == "p":
                p_n += 1
                self.where[el] = f"paragraph {p_n}"
            else:
                t_n += 1
                self.where[el] = f"table {t_n}"
        self.story_of: dict[Any, str] = {s.root: s.name for s in stories(doc, comments=True)}

    def __call__(self, el: Any) -> str:
        for a in [el, *el.iterancestors()]:
            if a in self.where:
                return self.where[a]
            if a in self.story_of:
                return self.story_of[a] if self.story_of[a] != "body" else "body"
        return "body"


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class Tracker:
    """Gives tracked changes an author, a date and ids no other mark in the document uses."""

    def __init__(self, doc: Any, author: str) -> None:
        top = 0
        for s in stories(doc, comments=True):
            for el in s.root.iter():
                v = el.get(W_ID) if isinstance(el.tag, str) else None
                if v and v.lstrip("-").isdigit():
                    top = max(top, int(v))
        self.next, self.author, self.date = top + 1, author, now_iso()

    def mark(self, like: Any, tag: str) -> Any:
        el = make(like, tag, {W_ID: str(self.next), W_AUTHOR: self.author, W_DATE: self.date})
        self.next += 1
        return el


def to_deleted(el: Any) -> None:
    for t in list(el.iter(T)):
        t.tag = DELTEXT
    for t in list(el.iter(INSTR)):
        t.tag = DELINSTR


def mark_paragraph(p: Any, tag: str, tracker: Tracker) -> None:
    """Record that a paragraph's mark was inserted or deleted (w:pPr/w:rPr/w:ins or w:del)."""
    ppr = p.find(PPR)
    if ppr is None:
        ppr = make(p, PPR)
        p.insert(0, ppr)
    rpr = ppr.find(RPR)
    if rpr is None:
        rpr = make(p, RPR)
        after = [c for c in ppr if c.tag in (SECTPR, qn("w:pPrChange"))]
        if after:
            after[0].addprevious(rpr)
        else:
            ppr.append(rpr)
    rpr.insert(0, tracker.mark(p, tag))


def delete_runs_tracked(p: Any, tracker: Tracker) -> int:
    """Wrap every run of the paragraph that isn't already deleted in w:del, grouping neighbours."""
    groups: list[list[Any]] = []
    for r in [r for r in p.iter(R) if not under(r, TXBX, p)]:
        if under(r, DEL, p) or under(r, MOVEFROM, p):
            continue
        if groups and groups[-1][-1].getnext() is r:
            groups[-1].append(r)
        else:
            groups.append([r])
    for group in groups:
        d = tracker.mark(p, DEL)
        group[0].addprevious(d)
        for r in group:
            d.append(r)
        to_deleted(d)
    return len(groups)


def relocate_markers(el: Any, into: Any | None) -> None:
    """Before el is removed, move comment anchors and bookmarks out of it into the paragraph `into`, so no comment
    is left without its place in the text."""
    if into is None:
        return
    moving = [m for m in el.iter(*MARKERS)]
    moving += [ref.getparent() for ref in el.iter(C_REF) if ref.getparent().tag == R]
    ppr = into.find(PPR)
    at = 1 if ppr is not None else 0
    for m in moving:
        into.insert(at, m)
        at += 1


def sibling_paragraph(p: Any, forward: bool) -> Any | None:
    sib = p.getnext() if forward else p.getprevious()
    while sib is not None and sib.tag != P:
        if sib.tag in (TBL, SDT):
            return None
        sib = sib.getnext() if forward else sib.getprevious()
    return sib


def removable(p: Any) -> bool:
    """Whether an empty paragraph can go: a table cell keeps at least one, and Word needs one after a table that
    ends the document."""
    parent = p.getparent()
    if parent.tag == TC and len([c for c in parent if c.tag == P]) == 1:
        return False
    after = p.getnext()
    while after is not None and after.tag in MARKERS:
        after = after.getnext()
    if parent.tag == qn("w:body") and (after is None or after.tag == SECTPR):
        before = p.getprevious()
        return before is None or before.tag != TBL
    return True


def copy_look(p: Any) -> tuple[Any, Any]:
    """The paragraph settings and first run formatting of p, without its tracked-change records or section break."""
    ppr = copy.deepcopy(p.find(PPR)) if p.find(PPR) is not None else None
    if ppr is not None:
        for c in list(ppr):
            if c.tag in (SECTPR, qn("w:pPrChange")):
                ppr.remove(c)
        rpr = ppr.find(RPR)
        if rpr is not None:
            for c in list(rpr):
                if c.tag in (INS, DEL, MOVEFROM, MOVETO, qn("w:rPrChange")):
                    rpr.remove(c)
    run_rpr = None
    for r in p.iter(R):
        if r.find(T) is not None and r.find(RPR) is not None:
            run_rpr = copy.deepcopy(r.find(RPR))
            for c in list(run_rpr):
                if c.tag == qn("w:rPrChange"):
                    run_rpr.remove(c)
            break
    return ppr, run_rpr


# ---------------------------------------------------------------- info, text, images


def field_kinds(root: Any) -> Counter:
    kinds: Counter = Counter()
    codes = [el.get(qn("w:instr")) or "" for el in root.iter(FLDSIMPLE)]
    for p in root.iter(P):
        code, inside = "", False
        for el in p.iter(FLDCHAR, INSTR):
            if el.tag == FLDCHAR:
                kind = el.get(qn("w:fldCharType"))
                if kind == "begin":
                    code, inside = "", True
                elif kind in ("separate", "end") and inside:
                    codes.append(code)
                    inside = False
            elif inside:
                code += el.text or ""
    for code in codes:
        word = code.strip().split(" ")[0].upper() if code.strip() else ""
        if word:
            kinds[word] += 1
    return kinds


def controls(root: Any) -> list[dict[str, Any]]:
    out = []
    for sdt in root.iter(SDT):
        pr = sdt.find(SDTPR)
        if pr is None:
            continue
        tag, alias = pr.find(qn("w:tag")), pr.find(qn("w:alias"))
        kind = "text"
        for name, label in (("w14:checkbox", "checkbox"), ("w:dropDownList", "dropdown"), ("w:comboBox", "combobox"),
                            ("w:date", "date"), ("w:picture", "picture"), ("w:docPartObj", "building block"),
                            ("w:group", "group"), ("w:richText", "rich text")):
            if pr.find(qn(name)) is not None:
                kind = label
        content = sdt.find(SDTCONTENT)
        out.append({"tag": tag.get(W_VAL) if tag is not None else None,
                    "title": alias.get(W_VAL) if alias is not None else None, "kind": kind,
                    "text": " ".join(para_text(p) for p in content.iter(P)) if content is not None and content.find(P) is not None
                    else (Para(content).visible if content is not None else ""),
                    "placeholder": pr.find(qn("w:showingPlcHdr")) is not None})
    return out


TOKEN = re.compile(r"\{\{\s*([^{}\0]+?)\s*\}\}")


def cmd_info(args: argparse.Namespace) -> None:
    doc = open_docx(args.file)
    names, default = style_names(doc)
    blocks = body_blocks(doc.element.body)
    paras = [el for kind, el in blocks if kind == "p"]
    headings, styles_used, words, tokens = [], Counter(), 0, Counter()
    for n, p in enumerate(paras, 1):
        style = para_style(p, names, default)
        styles_used[style] += 1
        text = para_text(p)
        if style.startswith("Heading") or style == "Title":
            headings.append({"paragraph": n, "style": style, "text": text})
    all_stories = stories(doc)
    fields: Counter = Counter()
    for s in all_stories:
        fields.update(field_kinds(s.root))
        for p in own_paragraphs(s.root):
            para = Para(p)
            words += len(para.visible.split())
            tokens.update(m.group(1).strip() for m in TOKEN.finditer(para.search))
    sections = []
    for i, sec in enumerate(doc.sections, 1):
        sections.append({"section": i, "page_mm": [round(sec.page_width.mm, 1), round(sec.page_height.mm, 1)] if sec.page_width else None,
                         "orientation": "landscape" if sec.page_width and sec.page_height and sec.page_width > sec.page_height else "portrait",
                         "margins_mm": {k: round(getattr(sec, f"{k}_margin").mm, 1) for k in ("top", "bottom", "left", "right")
                                        if getattr(sec, f"{k}_margin") is not None}})
    settings = doc.settings.element
    protection = settings.find(qn("w:documentProtection"))
    changes = list_revisions(doc)
    cp = doc.core_properties
    comments_part = find_part(doc, "comments+xml")
    result: dict[str, Any] = {
        "file": args.file,
        "kind": next(ext for ext, ct in MAIN_TYPES.items() if ct == doc.part.content_type),
        "paragraphs": len(paras), "tables": sum(1 for kind, _ in blocks if kind == "t"),
        "words": words, "sections": sections,
        "headings": headings, "styles_used": dict(styles_used.most_common()),
        "images": sum(1 for part in doc.part.package.iter_parts() if "/media/" in str(part.partname)),
        "text_boxes": sum(len(text_boxes(s.root)) for s in all_stories),
        "content_controls": [c for s in all_stories for c in controls(s.root)],
        "fields": dict(fields),
        "template_tokens": sorted(tokens),
        "comments": len(comments_part.element.findall(qn("w:comment"))) if comments_part is not None else 0,
        "tracked_changes": dict(Counter(c["kind"] for c in changes)),
        "track_changes_on": settings.find(qn("w:trackRevisions")) is not None
        and settings.find(qn("w:trackRevisions")).get(W_VAL) not in ("0", "false", "off"),
        "metadata": {k: v for k, v in {
            "title": cp.title, "subject": cp.subject, "author": cp.author, "last_modified_by": cp.last_modified_by,
            "created": cp.created.isoformat() if cp.created else None,
            "modified": cp.modified.isoformat() if cp.modified else None}.items() if v},
    }
    if protection is not None:
        result["protection"] = {"restricts_to": protection.get(qn("w:edit")),
                                "enforced": protection.get(qn("w:enforcement")) in ("1", "true", "on")}
    if any(k in fields for k in ("TOC", "PAGE", "NUMPAGES", "SECTIONPAGES")):
        result["field_note"] = ("TOC entries and page numbers are worked out by Word or LibreOffice when they lay the "
                                "document out; the file holds only what was shown when it was last saved")
    emit(result)


def cmd_text(args: argparse.Namespace) -> None:
    doc = open_docx(args.file)
    names, default = style_names(doc)
    blocks, p_n, t_n = [], 0, 0
    for kind, el in body_blocks(doc.element.body):
        if kind == "p":
            p_n += 1
            block: dict[str, Any] = {"paragraph": p_n, "style": para_style(el, names, default), "text": para_text(el)}
            ppr = el.find(PPR)
            num = ppr.find(qn("w:numPr")) if ppr is not None else None
            if num is not None:
                lvl = num.find(qn("w:ilvl"))
                block["list_level"] = int(lvl.get(W_VAL)) + 1 if lvl is not None else 1
            blocks.append(block)
        else:
            t_n += 1
            blocks.append({"table": t_n, "rows": table_rows(el)})
    extra: dict[str, list[dict[str, Any]]] = {"headers": [], "footers": [], "footnotes": [], "endnotes": []}
    boxes = text_boxes(doc.element.body)
    for s in stories(doc)[1:]:
        boxes += text_boxes(s.root)
        if s.kind in ("header", "footer"):
            text = "\n".join(para_text(p) for p in own_paragraphs(s.root)).strip()
            if text:
                extra[s.kind + "s"].append({"part": s.name, "text": text})
        else:
            for note in s.root:
                if note.get(qn("w:type")) in ("separator", "continuationSeparator", "continuationNotice"):
                    continue
                text = "\n".join(para_text(p) for p in own_paragraphs(note)).strip()
                if text:
                    extra[s.kind].append({"id": note.get(W_ID), "text": text})
    view = None
    if list_revisions(doc):
        view = "the document has tracked changes; this text shows them accepted (insertions in, deletions out)"
    if args.out:
        check_output(args.out, [args.file], args.overwrite)
        lines = []
        for b in blocks:
            if "paragraph" in b:
                lines.append(b["text"])
            else:
                lines.append(f"[table {b['table']}]")
                lines += ["\t".join(c.replace("\n", " / ") for c in row) for row in b["rows"]]
                lines.append(f"[end of table {b['table']}]")
        for key, label in (("headers", "header"), ("footers", "footer"), ("footnotes", "footnote"), ("endnotes", "endnote")):
            for e in extra[key]:
                lines.append(f"[{label} {e.get('part') or e.get('id')}] {e['text']}")
        lines += [f"[text box] {b}" for b in boxes]
        data = ("\n".join(lines) + "\n").encode("utf-8")
        write_atomic(args.out, lambda fh: fh.write(data))
        result = {"out": args.out, "paragraphs": p_n, "tables": t_n, "characters": len(data.decode("utf-8"))}
    else:
        result = {"file": args.file, "paragraphs": p_n, "tables": t_n, "blocks": blocks,
                  **{k: v for k, v in extra.items() if v}}
        if boxes:
            result["text_boxes"] = boxes
    if view:
        result["view"] = view
    emit(result)


WINDOWS_RESERVED = {"con", "prn", "aux", "nul", *(f"com{i}" for i in range(1, 10)), *(f"lpt{i}" for i in range(1, 10))}


def safe_name(name: str, taken: set[str], folder: str) -> str:
    """A file name from inside a document, made safe: no folders, no Windows device names, never an existing file."""
    base = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", os.path.basename(name)).strip(" .") or "image"
    stem, ext = os.path.splitext(base)
    if stem.split(".")[0].lower() in WINDOWS_RESERVED:
        stem = "_" + stem
    candidate, n = stem + ext, 1
    while candidate.lower() in taken or os.path.exists(os.path.join(folder, candidate)):
        n += 1
        candidate = f"{stem}-{n}{ext}"
    taken.add(candidate.lower())
    return candidate


def cmd_images(args: argparse.Namespace) -> None:
    open_docx(args.file)  # says clearly when it isn't a Word file
    if os.path.isfile(args.out_dir):
        raise Fail(f"--out-dir {args.out_dir} is a file, not a folder")
    os.makedirs(args.out_dir, exist_ok=True)
    saved, taken = [], set()
    with zipfile.ZipFile(args.file) as z:
        for info in z.infolist():
            if "/media/" not in "/" + info.filename or info.is_dir():
                continue
            name = safe_name(info.filename, taken, args.out_dir)
            data = z.read(info)
            write_atomic(os.path.join(args.out_dir, name), lambda fh, d=data: fh.write(d))
            saved.append({"from": info.filename, "saved_as": os.path.join(args.out_dir, name), "bytes": len(data)})
    emit({"file": args.file, "out_dir": args.out_dir, "images": saved, "count": len(saved)})


# ---------------------------------------------------------------- check


IMAGE_MAGIC = (b"\x89PNG", b"\xff\xd8\xff", b"GIF8", b"BM", b"II*\x00", b"MM\x00*", b"\x01\x00\x00\x00",
               b"\xd7\xcd\xc6\x9a", b"\x01\x00\x09\x00", b"<svg", b"<?xml", b"RIFF")
KNOWN_STYLES = {"CommentReference", "CommentText", "Hyperlink", "PlaceholderText"}  # Word knows these without a definition


def cmd_check(args: argparse.Namespace) -> int:
    need("lxml", "lxml")
    from lxml import etree

    path = args.file
    if not os.path.isfile(path):
        raise Fail(f"no such file: {path}")
    problems: list[dict[str, str]] = []

    def problem(level: str, part: str, what: str) -> None:
        problems.append({"level": level, "part": part, "problem": what})

    def finish() -> int:
        errors = sum(p["level"] == "error" for p in problems)
        emit({"file": path, "ok": errors == 0, "errors": errors, "warnings": len(problems) - errors,
              "problems": problems,
              "note": "a health check of the package, not validation against Word's schema: Word can still refuse a "
                      "file that passes, and a file with warnings usually opens"})
        return 1 if errors else 0

    with open(path, "rb") as fh:
        head = fh.read(8)
    if head.startswith(b"\xd0\xcf\x11\xe0"):
        raise Fail(f"{path} is an old-style .doc file or a password-protected Word file: check reads only .docx")
    try:
        z = zipfile.ZipFile(path)
        bad = z.testzip()
    except (zipfile.BadZipFile, EOFError) as e:
        problem("error", "(zip)", f"not a readable zip file ({e}): the file is damaged, cut short, or not a Word document")
        return finish()
    with z:
        if bad:
            problem("error", bad, "this part is damaged inside the zip (its checksum is wrong)")
        names = {n.lower(): n for n in z.namelist() if not n.endswith("/")}
        parser = etree.XMLParser(resolve_entities=False, no_network=True)
        trees: dict[str, Any] = {}
        for low, name in names.items():
            if low.endswith((".xml", ".rels")) and name != bad:
                try:
                    trees[low] = etree.fromstring(z.read(name), parser)
                except etree.XMLSyntaxError as e:
                    problem("error", name, f"broken XML: {e}")
        if "[content_types].xml" not in names:
            problem("error", "[Content_Types].xml", "missing: Word can't tell what any part is")
            return finish()
        ct = trees.get("[content_types].xml")
        defaults, overrides = {}, {}
        if ct is not None:
            for el in ct:
                tag = etree.QName(el).localname
                if tag == "Default":
                    defaults[(el.get("Extension") or "").lower()] = el.get("ContentType")
                elif tag == "Override":
                    overrides[(el.get("PartName") or "").lstrip("/").lower()] = el.get("ContentType")
        for low, name in names.items():
            if low == "[content_types].xml":
                continue
            base = posixpath.basename(low)
            if low not in overrides and (base.rsplit(".", 1)[-1] if "." in base else "") not in defaults:
                problem("error", name, "has no content type in [Content_Types].xml, so Word can't read it")
        for part in overrides:
            if part not in names:
                problem("warning", part, "[Content_Types].xml names a part that isn't in the file")
        # relationships, and the ids that point into them
        rel_ids: dict[str, dict[str, str]] = {}
        main = None
        for low, tree in trees.items():
            if not low.endswith(".rels"):
                continue
            folder, file = posixpath.split(low)
            source = posixpath.join(posixpath.dirname(folder), file[:-5]) if file != ".rels" else ""
            base = posixpath.dirname(source)
            ids = rel_ids.setdefault(source, {})
            for rel in tree:
                target, rtype = rel.get("Target") or "", rel.get("Type") or ""
                ids[rel.get("Id") or ""] = target
                if rel.get("TargetMode") == "External":
                    continue
                full = unquote(target.lstrip("/") if target.startswith("/") else posixpath.normpath(posixpath.join(base, target)))
                if rtype.endswith("/officeDocument"):
                    main = full.lower()
                if full.lower() not in names:
                    problem("error", names.get(low, low), f"relationship {rel.get('Id')} points to {full}, which isn't in the file")
        if main is None or main not in names:
            problem("error", "_rels/.rels", "doesn't lead to a main document part")
        elif overrides.get(main) not in MAIN_TYPES.values():
            problem("error", names[main], f"the main part's content type isn't a Word document's ({overrides.get(main)})")
        r_ns = NS["r"]
        for low, tree in trees.items():
            if low.endswith(".rels") or low not in names:
                continue
            ids = rel_ids.get(low, {})
            for el in tree.iter():
                if not isinstance(el.tag, str):
                    continue
                for attr, value in el.attrib.items():
                    if attr.startswith(f"{{{r_ns}}}") and value and value not in ids:
                        problem("error", names[low], f"{etree.QName(el).localname} refers to relationship {value}, which doesn't exist")
        for low, name in names.items():
            if "/media/" in "/" + low:
                data = z.read(name) if name != bad else b""
                if not data:
                    problem("error", name, "an empty picture file")
                elif not data.startswith(IMAGE_MAGIC):
                    problem("warning", name, "doesn't look like a picture format Word knows")
        # styles, numbering and comments the text refers to
        story_types = set(MAIN_TYPES.values()) | {f"{CT_PREFIX}{k}+xml" for k in ("header", "footer", "footnotes", "endnotes")}
        story_trees = {low: tree for low, tree in trees.items() if overrides.get(low) in story_types}
        styles = next((t for low, t in trees.items() if (overrides.get(low) or "").endswith("styles+xml")), None)
        style_ids = {s.get(qn("w:styleId")) for s in styles.iter(qn("w:style"))} if styles is not None else set()
        numbering = next((t for low, t in trees.items() if (overrides.get(low) or "").endswith("numbering+xml")), None)
        num_ids = {n.get(qn("w:numId")) for n in numbering.iter(qn("w:num"))} if numbering is not None else set()
        comments = next((t for low, t in trees.items() if (overrides.get(low) or "") == CT_PREFIX + "comments+xml"), None)
        comment_ids = {c.get(W_ID) for c in comments.iter(qn("w:comment"))} if comments is not None else set()
        missing_styles: Counter = Counter()
        refs, starts, ends = set(), set(), set()
        for low, tree in story_trees.items():
            for tag in ("w:pStyle", "w:rStyle", "w:tblStyle"):
                for el in tree.iter(qn(tag)):
                    v = el.get(W_VAL)
                    if v and v not in style_ids and v not in KNOWN_STYLES:
                        missing_styles[v] += 1
            for el in tree.iter(qn("w:numId")):
                if el.get(W_VAL) not in (None, "0") and el.get(W_VAL) not in num_ids:
                    problem("warning", names[low], f"list numbering {el.get(W_VAL)} isn't defined in numbering.xml")
            refs |= {el.get(W_ID) for el in tree.iter(C_REF)}
            starts |= {el.get(W_ID) for el in tree.iter(C_START)}
            ends |= {el.get(W_ID) for el in tree.iter(C_END)}
        for style, n in missing_styles.items():
            problem("warning", "word/styles.xml", f"style {style} is used {n} times but not defined; Word shows that text in the default style")
        for cid in sorted(refs - comment_ids, key=str):
            problem("error", "word/comments.xml", f"the text refers to comment {cid}, which doesn't exist")
        for cid in sorted((starts ^ ends), key=str):
            problem("warning", "word/document.xml", f"comment {cid} has a start mark without an end mark, or the other way round")
        for cid in sorted(comment_ids - refs - starts, key=str):
            problem("warning", "word/comments.xml", f"comment {cid} isn't anchored anywhere in the text")
    if not any(p["level"] == "error" for p in problems):
        try:
            importlib.import_module("docx")
        except ImportError:
            NOTES["not_checked"] = "python-docx isn't installed, so check didn't also try opening the file with it"
        else:
            try:
                open_docx(path)
            except Fail as e:
                problem("error", "(package)", str(e))
    return finish()


# ---------------------------------------------------------------- edit


def find_matches(para: Para, find: str, match_case: bool, whole_word: bool) -> list[tuple[int, int]]:
    pattern = re.escape(find)
    if whole_word:
        pattern = rf"(?<!\w){pattern}(?!\w)"
    return [(m.start(), m.end()) for m in re.finditer(pattern, para.search, 0 if match_case else re.IGNORECASE)]


FOLD = str.maketrans({"‘": "'", "’": "'", "“": '"', "”": '"', " ": " ", "–": "-",
                      "—": "-", "‑": "-"})


def near_miss(doc: Any, find: str) -> str | None:
    """Text close to `find` that the document does have: other quotes, dashes or spaces, other case, or a tab or
    line break in the middle."""
    want = " ".join(find.translate(FOLD).lower().split())
    for _, p, _ in edit_paragraphs(doc):
        visible = Para(p).visible
        folded = visible.translate(FOLD).lower()
        squashed = " ".join(folded.split())
        if want in squashed:
            i = folded.find(want)
            return visible[i:i + len(find) + 5] if i >= 0 else visible[:80]
    return None


def cmd_edit(args: argparse.Namespace) -> int:
    ops = load_json(args.ops)
    if isinstance(ops, dict) and isinstance(ops.get("ops"), list):
        ops = ops["ops"]
    if not isinstance(ops, list) or not ops:
        raise Fail(f"{args.ops} should hold a JSON list of operations, like [{{\"op\": \"replace\", \"find\": \"old\", \"replace\": \"new\"}}]")
    check_output(args.out, [args.file], args.overwrite)
    doc = open_docx(args.file)
    names, _ = style_names(doc)
    by_name = {v: k for k, v in names.items()}
    tracker = Tracker(doc, args.author) if args.track else None
    merged = sum(merge_runs(s.root) for s in stories(doc))
    blocks = body_blocks(doc.element.body)
    paras = [el for kind, el in blocks if kind == "p"]
    tables = [el for kind, el in blocks if kind == "t"]
    problems: list[dict[str, Any]] = []
    done: list[dict[str, Any]] = []
    placed: dict[Any, Any] = {}  # the last paragraph inserted next to each paragraph, to keep several in order

    def number(op: dict[str, Any], key: str, top: int, what: str) -> int | None:
        v = op.get(key)
        if isinstance(v, bool) or not isinstance(v, int) or not 1 <= v <= top:
            raise ValueError(f"{key} must be a {what} number from 1 to {top}, not {v!r}")
        return v

    def style_id(name: Any) -> str:
        if not isinstance(name, str) or not name:
            raise ValueError("style must be a style's name, like \"Heading 2\"")
        sid = by_name.get(name) or next((k for k, v in names.items() if v.lower() == name.lower()), None)
        if sid is None:
            para_styles = sorted(v for k, v in names.items() if k in {s.get(qn("w:styleId")) for s in doc.styles.element.iter(qn("w:style")) if s.get(qn("w:type")) == "paragraph"})
            raise ValueError(f"no style {name!r} in this document; its paragraph styles are: {', '.join(para_styles)}")
        return sid

    def set_style(p: Any, sid: str) -> None:
        ppr = p.find(PPR)
        if ppr is None:
            ppr = make(p, PPR)
            p.insert(0, ppr)
        if tracker is not None:
            old = make(p, PPR)
            for c in ppr:
                if c.tag not in (RPR, SECTPR, qn("w:pPrChange")):
                    old.append(copy.deepcopy(c))
            change = tracker.mark(p, qn("w:pPrChange"))
            change.append(old)
            for c in list(ppr):
                if c.tag == qn("w:pPrChange"):
                    ppr.remove(c)
            ppr.append(change)
        ps = ppr.find(PSTYLE)
        if ps is None:
            ps = make(p, PSTYLE)
            ppr.insert(0, ps)
        ps.set(W_VAL, sid)

    for n, op in enumerate(ops, 1):
        if not isinstance(op, dict) or op.get("op") not in ("replace", "insert", "delete", "style", "cell"):
            problems.append({"op": n, "problem": "each operation is an object whose \"op\" is replace, insert, delete, style or cell"})
            continue
        kind = op["op"]
        try:
            if kind == "replace":
                find, new = op.get("find"), op.get("replace", "")
                if not isinstance(find, str) or not find or "\0" in find:
                    raise ValueError("find must be the text to look for")
                if not isinstance(new, str):
                    raise ValueError("replace must be text (\"\" to remove)")
                if "\t" in find or "\n" in find:
                    raise ValueError("find can't hold a tab or line break: text is matched within the stretches between them")
                expect = op.get("expect")
                if expect is not None and (isinstance(expect, bool) or not isinstance(expect, int) or expect < 0):
                    raise ValueError("expect must be a whole number of matches")
                count, skipped = 0, []
                for story, p, counts in edit_paragraphs(doc):
                    para = Para(p)
                    matches = find_matches(para, find, op.get("match_case", True) is not False, bool(op.get("whole_word")))
                    if not matches:
                        continue
                    if tracker is None:
                        replace_spans(para, [(a, b, new) for a, b in matches])
                    else:
                        for a, b in reversed(matches):
                            if not track_replace(para, a, b, new, tracker):
                                skipped.append(f"{story.name}: {para.visible[max(0, a - 20):b + 20]!r}")
                    count += len(matches) if counts else 0
                entry = {"op": n, "replace": find, "with": new, "matches": count}
                if skipped:
                    problems.append({"op": n, "problem": "with --track, a match that runs across a link, a field or an earlier tracked change can't be recorded: "
                                     "replace it in Word, or without --track", "where": skipped})
                if count == 0:
                    hint = near_miss(doc, find)
                    problems.append({"op": n, "problem": f"{find!r} isn't in the document",
                                     **({"did_you_mean": hint} if hint else {})})
                elif expect is not None and count != expect:
                    problems.append({"op": n, "problem": f"expected {expect} matches of {find!r}, found {count}"})
                done.append(entry)
            elif kind == "insert":
                if ("after" in op) == ("before" in op):
                    raise ValueError("insert needs either after or before (a paragraph number)")
                key = "after" if "after" in op else "before"
                anchor = paras[number(op, key, len(paras), "paragraph") - 1]
                text = op.get("text", "")
                if not isinstance(text, str):
                    raise ValueError("text must be text")
                ppr, rpr = copy_look(anchor)
                p = make(anchor, P)
                if op.get("style") is not None:
                    ppr = make(anchor, PPR)
                    rpr = None
                    ps = make(anchor, PSTYLE, {W_VAL: style_id(op["style"])})
                    ppr.append(ps)
                if ppr is not None:
                    p.append(ppr)
                if text:
                    r = new_run(anchor, rpr, text)
                    if tracker is not None:
                        ins = tracker.mark(anchor, INS)
                        ins.append(r)
                        p.append(ins)
                    else:
                        p.append(r)
                if tracker is not None:
                    mark_paragraph(p, INS, tracker)
                if key == "after":
                    (placed.get(anchor) or anchor).addnext(p)
                    placed[anchor] = p
                else:
                    anchor.addprevious(p)
                done.append({"op": n, "inserted": key + f" paragraph {op[key]}", "text": text})
            elif kind == "delete":
                i = number(op, "paragraph", len(paras), "paragraph")
                p = paras[i - 1]
                if p.find(PPR) is not None and p.find(PPR).find(SECTPR) is not None:
                    raise ValueError(f"paragraph {i} ends a section (it holds that section's page settings); deleting it would merge two sections")
                if tracker is not None:
                    delete_runs_tracked(p, tracker)
                    mark_paragraph(p, DEL, tracker)
                elif removable(p):
                    relocate_markers(p, sibling_paragraph(p, True) or sibling_paragraph(p, False))
                    p.getparent().remove(p)
                else:
                    clear_paragraph(p)  # Word needs a paragraph after a table that ends the document
                done.append({"op": n, "deleted": f"paragraph {i}"})
            elif kind == "style":
                i = number(op, "paragraph", len(paras), "paragraph")
                set_style(paras[i - 1], style_id(op.get("style")))
                done.append({"op": n, "styled": f"paragraph {i}", "style": op["style"]})
            elif kind == "cell":
                ti = number(op, "table", len(tables), "table")
                rows = children_of(tables[ti - 1], TR)
                ri = number(op, "row", len(rows), "row")
                cells = children_of(rows[ri - 1], TC)
                ci = number(op, "col", len(cells), "cell")
                text = op.get("text", "")
                if not isinstance(text, (str, int, float)) or isinstance(text, bool):
                    raise ValueError("text must be text")
                set_cell(cells[ci - 1], str(text), tracker)
                done.append({"op": n, "cell": [ti, ri, ci], "text": str(text)})
        except ValueError as e:
            problems.append({"op": n, "problem": str(e)})
    result: dict[str, Any] = {"file": args.file, "out": args.out, "done": done, "runs_joined": merged}
    if problems:
        emit({**result, "out": None, "written": False, "problems": problems})
        return 1
    save_docx(doc, args.out)
    result["written"] = True
    if tracker is not None:
        result["tracked_as"] = args.author
    else:
        if list_revisions(doc):
            result["note"] = "the document has tracked changes from before; these edits aren't tracked"
        tr = doc.settings.element.find(qn("w:trackRevisions"))
        if tr is not None and tr.get(W_VAL) not in ("0", "false", "off"):
            result["track_changes_on"] = ("Track Changes is on in this document, but these edits weren't recorded as "
                                          "tracked changes: use --track to record them")
    emit(result)
    return 0


def track_replace(para: Para, a: int, b: int, new: str, tracker: Tracker) -> bool:
    """Record a replacement as a tracked deletion and insertion. False when the matched runs don't sit side by
    side in one place (across a link, a field or an earlier tracked change)."""
    runs = isolate(para, a, b)
    parent = runs[0].getparent()
    if any(r.getparent() is not parent for r in runs):
        return False
    seq, el = [], runs[0]
    allowed = {R, *MARKERS, qn("w:proofErr"), qn("w:permStart"), qn("w:permEnd")}
    while el is not None:
        if el.tag not in allowed:
            return False
        seq.append(el)
        if el is runs[-1]:
            break
        el = el.getnext()
    rpr = runs[0].find(RPR)
    d = tracker.mark(runs[0], DEL)
    runs[0].addprevious(d)
    for x in seq:
        d.append(x)
    to_deleted(d)
    if new:
        ins = tracker.mark(d, INS)
        ins.append(new_run(d, rpr, new))
        d.addnext(ins)
    return True


def clear_paragraph(p: Any) -> None:
    """Remove a paragraph's content, keeping its settings, comment anchors and bookmarks."""
    for c in list(p):
        if c.tag == PPR or c.tag in MARKERS or (c.tag == R and c.find(C_REF) is not None):
            continue
        relocate_markers(c, p)
        if c.getparent() is p:
            p.remove(c)


def set_cell(tc: Any, text: str, tracker: Tracker | None) -> None:
    """Put text in a table cell, in the look of its first run, keeping the cell's own settings."""
    paras = [c for c in tc if c.tag == P]
    if not paras:
        paras = [make(tc, P)]
        tc.append(paras[0])
    first = paras[0]
    _, rpr = copy_look(first)
    if rpr is None and first.find(PPR) is not None and first.find(PPR).find(RPR) is not None:
        rpr = copy.deepcopy(first.find(PPR).find(RPR))  # an empty paragraph's mark holds the look typed text gets
        for c in list(rpr):
            if c.tag in (INS, DEL, MOVEFROM, MOVETO, qn("w:rPrChange")):
                rpr.remove(c)
    if tracker is not None:
        for p in paras:
            delete_runs_tracked(p, tracker)
        for p in paras[1:]:
            mark_paragraph(p, DEL, tracker)
        if text:
            ins = tracker.mark(first, INS)
            ins.append(new_run(first, rpr, text))
            first.append(ins)
        return
    for p in paras[1:]:
        relocate_markers(p, first)
        tc.remove(p)
    clear_paragraph(first)
    if text:
        first.append(new_run(first, rpr, text))


# ---------------------------------------------------------------- fill


def value_text(v: Any) -> str:
    if v is None:
        return ""
    if isinstance(v, bool):
        return "Yes" if v else "No"
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v)


def fill_control(sdt: Any, value: Any) -> str | None:
    """Fill one content control; returns a problem, or None."""
    pr, content = sdt.find(SDTPR), sdt.find(SDTCONTENT)
    if content is None:
        return "has no content to fill"
    box = pr.find(qn("w14:checkbox"))
    if box is not None:
        truthy = {"true", "yes", "1", "x", "on", "checked"}
        falsy = {"false", "no", "0", "", "off", "unchecked"}
        text = str(value).strip().lower() if not isinstance(value, bool) else ("true" if value else "false")
        if text not in truthy | falsy:
            return f"is a checkbox: give true or false, not {value!r}"
        on = text in truthy
        checked = box.find(qn("w14:checked"))
        if checked is None:
            checked = make(box, qn("w14:checked"))
            box.insert(0, checked)
        checked.set(qn("w14:val"), "1" if on else "0")
        state = box.find(qn("w14:checkedState" if on else "w14:uncheckedState"))
        symbol = chr(int(state.get(qn("w14:val")), 16)) if state is not None else ("☒" if on else "☐")
        ts = list(content.iter(T))
        if ts:
            ts[0].text = symbol
            for t in ts[1:]:
                t.text = ""
                drop_if_empty(t)
        return None
    text = value_text(value)
    choices = pr.find(qn("w:dropDownList"))
    if choices is None:
        choices = pr.find(qn("w:comboBox"))
        free = True
    else:
        free = False
    if choices is not None:
        items = {(i.get(qn("w:displayText")) or i.get(qn("w:value")) or ""): i for i in choices.iter(qn("w:listItem"))}
        values = {(i.get(qn("w:value")) or ""): (i.get(qn("w:displayText")) or i.get(qn("w:value")) or "") for i in choices.iter(qn("w:listItem"))}
        if text in values:
            text = values[text]
        elif text not in items and not free:
            return f"is a dropdown: give one of {sorted(items)}, not {text!r}"
    if pr.find(qn("w:picture")) is not None:
        return "is a picture control, which this script can't fill"
    placeholder = pr.find(qn("w:showingPlcHdr"))
    if placeholder is not None:
        pr.remove(placeholder)
    for r in content.iter(R):
        rpr = r.find(RPR)
        style = rpr.find(qn("w:rStyle")) if rpr is not None else None
        if style is not None and style.get(W_VAL) == "PlaceholderText":
            rpr.remove(style)
    paras = [p for p in content if p.tag == P]
    for p in paras[1:]:
        content.remove(p)
    where = paras[0] if paras else content
    ts = [t for t in where.iter(T)]
    if ts:
        ts[0].text = text
        preserve(ts[0])
        for t in ts[1:]:
            t.text = ""
        for t in ts:
            if t.getparent() is not None:
                expand_breaks(t)
        for t in ts[1:]:
            drop_if_empty(t)
    else:
        runs = list(where.iter(R))
        rpr = runs[0].find(RPR) if runs else None
        where.append(new_run(where, rpr, text))
    return None


MERGEFIELD = re.compile(r'^\s*MERGEFIELD\s+(?:"([^"]+)"|(\S+))', re.IGNORECASE)


def fill_merge_fields(root: Any, values: dict[str, Any], found: Counter, filled: Counter, missing: set[str]) -> None:
    """Replace mail-merge fields («Name») with the values, as plain text in the field's look."""
    for fs in list(root.iter(FLDSIMPLE)):
        m = MERGEFIELD.match(fs.get(qn("w:instr")) or "")
        if not m:
            continue
        key = m.group(1) or m.group(2)
        found[key] += 1
        if key not in values:
            missing.add(key)
            continue
        runs = list(fs.iter(R))
        fs.addprevious(new_run(fs, runs[0].find(RPR) if runs else None, value_text(values[key])))
        fs.getparent().remove(fs)
        filled[key] += 1
    for begin in [el for el in root.iter(FLDCHAR) if el.get(qn("w:fldCharType")) == "begin"]:
        start = begin.getparent()
        if start is None or start.tag != R or start.getparent() is None:
            continue
        seq, code, depth, result_rpr, el = [start], "", 0, None, start.getnext()
        state = "code"
        while el is not None:
            seq.append(el)
            chars = list(el.iter(FLDCHAR)) if el.tag == R else []
            kinds = [c.get(qn("w:fldCharType")) for c in chars]
            if "begin" in kinds:
                depth += 1
            if el.tag == R and state == "code" and depth == 0:
                code += "".join(i.text or "" for i in el.iter(INSTR))
            if el.tag == R and state == "result" and result_rpr is None and el.find(T) is not None:
                result_rpr = el.find(RPR)
            if "separate" in kinds and depth == 0:
                state = "result"
            if "end" in kinds:
                if depth == 0:
                    break
                depth -= 1
            el = el.getnext()
        if el is None:
            continue  # the field runs on past this paragraph: left alone
        m = MERGEFIELD.match(code)
        if not m:
            continue
        key = m.group(1) or m.group(2)
        found[key] += 1
        if key not in values:
            missing.add(key)
            continue
        start.addprevious(new_run(start, result_rpr if result_rpr is not None else start.find(RPR), value_text(values[key])))
        for x in seq:
            x.getparent().remove(x)
        filled[key] += 1


def cmd_fill(args: argparse.Namespace) -> int:
    values = load_json(args.values)
    if not isinstance(values, dict):
        raise Fail(f"{args.values} should hold a JSON object of values, like {{\"client\": \"Acme Ltd\"}}")
    bad = [k for k, v in values.items() if isinstance(v, (list, dict))]
    if bad:
        raise Fail(f"values are text, numbers or true/false; these aren't: {', '.join(bad)}")
    check_output(args.out, [args.file, args.values], args.overwrite)
    doc = open_docx(args.file)
    found: Counter = Counter()
    filled: Counter = Counter()
    missing: set[str] = set()
    problems: list[dict[str, str]] = []
    for s in stories(doc):
        merge_runs(s.root)
        for sdt in list(s.root.iter(SDT)):
            pr = sdt.find(SDTPR)
            if pr is None or sdt.getparent() is None:
                continue
            keys = [el.get(W_VAL) for el in (pr.find(qn("w:tag")), pr.find(qn("w:alias"))) if el is not None and el.get(W_VAL)]
            if not keys or pr.find(qn("w:docPartObj")) is not None or pr.find(qn("w:group")) is not None:
                continue
            key = next((k for k in keys if k in values), keys[0])
            found[key] += 1
            if key not in values:
                missing.add(key)
                continue
            trouble = fill_control(sdt, values[key])
            if trouble:
                problems.append({"control": key, "problem": trouble})
            else:
                filled[key] += 1
        fill_merge_fields(s.root, values, found, filled, missing)
    for _, p, counts in edit_paragraphs(doc):
        para = Para(p)
        edits = []
        for m in TOKEN.finditer(para.search):
            key = m.group(1).strip()
            if counts:
                found[key] += 1
            if key in values:
                edits.append((m.start(), m.end(), value_text(values[key])))
                if counts:
                    filled[key] += 1
            elif counts:
                missing.add(key)
        if edits:
            replace_spans(para, edits)
    odd = []
    for _, p, counts in edit_paragraphs(doc):
        text = Para(p).visible
        if counts and ("{{" in text or "}}" in text) and not TOKEN.search(Para(p).search):
            odd.append(text[:120])
    result: dict[str, Any] = {"file": args.file, "filled": dict(filled),
                              "missing": sorted(missing), "unused": sorted(k for k in values if k not in found)}
    if odd:  # a warning, not a stop: documents can hold braces for other reasons
        result["odd_braces"] = {"note": "braces that don't make a whole {{token}}: a token split by a tab, line break "
                                        "or picture, or a brace missing", "paragraphs": odd}
    if problems or (missing and not args.partial):
        if missing and not args.partial:
            result["missing_note"] = "these have no value: add them to the values file, or use --partial to leave them as they are"
        emit({**result, "out": None, "written": False, "problems": problems})
        return 1
    save_docx(doc, args.out)
    # read the new file back: every filled token must be gone
    left = Counter()
    for _, p, counts in edit_paragraphs(open_docx(args.out)):
        if counts:
            left.update(m.group(1).strip() for m in TOKEN.finditer(Para(p).search))
    still = sorted(k for k in left if k in filled)
    result.update({"out": args.out, "written": True, "tokens_left": dict(left)})
    if still:
        result["problems"] = [{"problem": "these tokens are still in the saved file", "tokens": still}]
        emit(result)
        return 1
    emit(result)
    return 0


# ---------------------------------------------------------------- tracked changes

FORMAT_CHANGES = {qn("w:rPrChange"): "format", qn("w:pPrChange"): "paragraph_format"}
LAYOUT_CHANGES = {qn(f"w:{x}") for x in ("sectPrChange", "tblPrChange", "trPrChange", "tcPrChange", "tblGridChange",
                                         "tblPrExChange", "numberingChange")}
CELL_CHANGES = {qn("w:cellIns"), qn("w:cellDel"), qn("w:cellMerge")}
MOVE_RANGES = {qn(f"w:{x}") for x in ("moveFromRangeStart", "moveFromRangeEnd", "moveToRangeStart", "moveToRangeEnd")}


def revision_kind(el: Any) -> str | None:
    tag, parent = el.tag, el.getparent()
    ptag = parent.tag if parent is not None else None
    if tag in (INS, DEL):
        if ptag == RPR:
            return "paragraph_insert" if tag == INS else "paragraph_delete"
        if ptag == qn("w:trPr"):
            return "row_insert" if tag == INS else "row_delete"
        return "insert" if tag == INS else "delete"
    if tag in (MOVEFROM, MOVETO):
        if ptag == RPR:
            return "paragraph_move"
        return "move_from" if tag == MOVEFROM else "move_to"
    if tag in FORMAT_CHANGES:
        return FORMAT_CHANGES[tag]
    if tag in LAYOUT_CHANGES:
        return "layout_format"
    if tag in CELL_CHANGES:
        return "cell"
    return None


def iter_revisions(doc: Any) -> Iterator[tuple[Story, Any, str]]:
    for s in stories(doc, comments=True):
        for el in s.root.iter():
            if isinstance(el.tag, str):
                kind = revision_kind(el)
                if kind:
                    yield s, el, kind


def list_revisions(doc: Any) -> list[dict[str, Any]]:
    where = Locator(doc)
    out = []
    for s, el, kind in iter_revisions(doc):
        text = "".join(t.text or "" for t in el.iter(T, DELTEXT)) if kind in ("insert", "delete", "move_from", "move_to") else ""
        if kind in ("paragraph_insert", "paragraph_delete", "row_insert", "row_delete"):
            target = el.getparent().getparent().getparent()  # the paragraph or the row
            text = (para_text(target) if target.tag == P else " | ".join(cell_text(tc) for tc in children_of(target, TC)))[:200]
        out.append({"id": el.get(W_ID), "kind": kind, "author": el.get(W_AUTHOR), "date": el.get(W_DATE),
                    "text": text, "where": where(el), "part": s.name})
    return out


def unwrap(el: Any) -> None:
    parent = el.getparent()
    for c in list(el):
        el.addprevious(c)
    parent.remove(el)


def drop(el: Any) -> None:
    """Remove a tracked-change wrapper and what it holds, moving any comment anchors and bookmarks out first."""
    for m in [m for m in el.iter(*MARKERS)] + [ref.getparent() for ref in el.iter(C_REF) if ref.getparent() is not None and ref.getparent().tag == R]:
        el.addprevious(m)
    el.getparent().remove(el)


def restore_rpr(change: Any) -> None:
    """Reject a formatting change: put back the run (or paragraph mark) formatting stored in w:rPrChange."""
    rpr = change.getparent()
    old = change.find(RPR)
    keep = [c for c in rpr if c.tag in (INS, DEL, MOVEFROM, MOVETO)]
    for c in list(rpr):
        rpr.remove(c)
    for c in keep:
        rpr.append(c)
    if old is not None:
        for c in list(old):
            rpr.append(c)


def restore_ppr(change: Any) -> None:
    ppr = change.getparent()
    old = change.find(PPR)
    keep = [c for c in ppr if c.tag in (RPR, SECTPR)]
    for c in list(ppr):
        ppr.remove(c)
    if old is not None:
        for c in list(old):
            ppr.append(c)
    for c in keep:
        ppr.append(c)


def resolve(doc: Any, accept: bool, chosen: Callable[[Any], bool], with_moves: bool) -> tuple[Counter, list[dict[str, Any]]]:
    """Accept or reject the chosen tracked changes. Returns what was done by kind, and what was left (with why)."""
    done: Counter = Counter()
    left: list[dict[str, Any]] = []
    where = Locator(doc)

    def leave(el: Any, kind: str, why: str) -> None:
        left.append({"id": el.get(W_ID), "kind": kind, "author": el.get(W_AUTHOR), "where": where(el), "why": why})

    for s in stories(doc, comments=True):
        root = s.root
        # 1. text inserted, deleted or moved
        for el in list(root.iter(INS, DEL, MOVEFROM, MOVETO)):
            kind = revision_kind(el)
            if kind not in ("insert", "delete", "move_from", "move_to") or el.getparent() is None or not chosen(el):
                continue
            if kind.startswith("move") and not with_moves:
                leave(el, kind, "a move has two halves: accept or reject all changes at once (no --ids or --author), or do it in Word")
                continue
            keep = (el.tag in (INS, MOVETO)) == accept
            if keep:
                if el.tag in (DEL, MOVEFROM):
                    for t in list(el.iter(DELTEXT)):
                        t.tag = T
                    for t in list(el.iter(DELINSTR)):
                        t.tag = INSTR
                unwrap(el)
            else:
                drop(el)
            done[kind] += 1
        if with_moves:
            for el in list(root.iter(*MOVE_RANGES)):
                el.getparent().remove(el)
        # 2. table rows
        for el in list(root.iter(INS, DEL)):
            kind = revision_kind(el)
            if kind not in ("row_insert", "row_delete") or not chosen(el):
                continue
            row = el.getparent().getparent()
            if (kind == "row_insert") != accept:
                table = row.getparent()
                table.remove(row)
                if table.tag == TBL and table.find(TR) is None:
                    table.getparent().remove(table)
            else:
                el.getparent().remove(el)
            done[kind] += 1
        # 3. paragraph marks: a paragraph inserted or deleted as a whole
        for el in list(root.iter(INS, DEL, MOVEFROM, MOVETO)):
            kind = revision_kind(el)
            if kind not in ("paragraph_insert", "paragraph_delete", "paragraph_move") or el.getparent() is None or not chosen(el):
                continue
            if kind == "paragraph_move":
                if with_moves:
                    el.getparent().remove(el)
                    done[kind] += 1
                else:
                    leave(el, kind, "a move has two halves: accept or reject all changes at once, or do it in Word")
                continue
            p = el.getparent().getparent().getparent()
            joins = (kind == "paragraph_delete") == accept
            if not joins:
                el.getparent().remove(el)
                done[kind] += 1
                continue
            nxt = sibling_paragraph(p, True)
            if p.find(PPR) is not None and p.find(PPR).find(SECTPR) is not None:
                leave(el, kind, "this paragraph ends a section; joining it to the next one is for Word")
            elif not Para(p).has_content():
                if removable(p):
                    relocate_markers(p, nxt if nxt is not None else sibling_paragraph(p, False))
                    p.getparent().remove(p)
                else:
                    el.getparent().remove(el)
                done[kind] += 1
            elif nxt is not None and not Para(nxt).has_content() and (nxt.find(PPR) is None or nxt.find(PPR).find(SECTPR) is None):
                relocate_markers(nxt, p)
                nxt.getparent().remove(nxt)
                el.getparent().remove(el)
                done[kind] += 1
            elif nxt is None:
                el.getparent().remove(el)  # nothing to join with: the end of a cell or story, or a table next
                done[kind] += 1
            else:
                leave(el, kind, "two paragraphs that both keep text would be joined into one; Word decides which one's "
                                "formatting wins, so finish this in Word")
        # 4. formatting
        for el in list(root.iter(*FORMAT_CHANGES, *LAYOUT_CHANGES, *CELL_CHANGES)):
            kind = revision_kind(el)
            if not kind or el.getparent() is None or not chosen(el):
                continue
            if kind == "cell":
                leave(el, kind, "inserted, deleted or merged table cells: finish these in Word")
            elif accept:
                el.getparent().remove(el)
                done[kind] += 1
            elif kind == "format":
                restore_rpr(el)
                done[kind] += 1
            elif kind == "paragraph_format":
                restore_ppr(el)
                done[kind] += 1
            else:
                leave(el, kind, "rejecting a change to page, table or numbering settings: do this in Word")
    return done, left


def parse_ids(text: str | None) -> set[str] | None:
    if text is None:
        return None
    ids = {x.strip() for x in text.split(",") if x.strip()}
    if not ids or not all(x.lstrip("-").isdigit() for x in ids):
        raise Fail(f"--ids takes numbers separated by commas, like 3,7,12, not {text!r}")
    return ids


def cmd_revisions(args: argparse.Namespace) -> int:
    if args.action == "list":
        doc = open_docx(args.file)
        changes = list_revisions(doc)
        handled = {"insert", "delete", "move_from", "move_to", "row_insert", "row_delete", "paragraph_insert",
                   "paragraph_delete", "paragraph_move", "format", "paragraph_format"}
        emit({"file": args.file, "count": len(changes), "by_kind": dict(Counter(c["kind"] for c in changes)),
              "authors": sorted({c["author"] for c in changes if c["author"]}),
              "not_handled_here": sorted({c["kind"] for c in changes} - handled - {"layout_format"}),
              "changes": changes})
        return 0
    check_output(args.out, [args.file], args.overwrite)
    doc = open_docx(args.file)
    ids = parse_ids(args.ids)
    known = {c["id"] for c in list_revisions(doc)}
    if ids is not None and ids - known:
        raise Fail(f"no tracked change with id {', '.join(sorted(ids - known, key=int))}; revisions list shows the ids")

    def chosen(el: Any) -> bool:
        return (ids is None or el.get(W_ID) in ids) and (args.author is None or el.get(W_AUTHOR) == args.author)

    if args.author is not None and not any(chosen(el) for _, el, _ in iter_revisions(doc)):
        authors = sorted({el.get(W_AUTHOR) for _, el, _ in iter_revisions(doc) if el.get(W_AUTHOR)})
        raise Fail(f"no tracked changes by {args.author!r}; the authors are: {', '.join(authors) or 'none'}")
    accept = args.action == "accept"
    done, left = resolve(doc, accept, chosen, with_moves=ids is None and args.author is None)
    result: dict[str, Any] = {"file": args.file, "action": args.action, "done": dict(done), "left": left}
    if left and not args.partial:
        emit({**result, "out": None, "written": False,
              "note": "nothing was written: some changes can't be resolved here. Use --partial to write a copy with "
                      "the rest resolved, then finish those in Word"})
        return 1
    save_docx(doc, args.out)
    remaining = [c for c in list_revisions(open_docx(args.out))]
    result.update({"out": args.out, "written": True, "changes_left_in_file": len(remaining)})
    emit(result)
    return 1 if left else 0


# ---------------------------------------------------------------- comments


def comment_threads(doc: Any) -> dict[str, dict[str, Any]]:
    """For each comment id: its paragraph ids, whether it's resolved, and which comment it answers (Word keeps
    these in commentsExtended.xml, keyed by the comment's paragraph ids)."""
    part = find_part(doc, "comments+xml")
    if part is None:
        return {}
    ext = find_part(doc, "commentsExtended+xml")
    by_para: dict[str, Any] = {}
    if ext is not None:
        for e in ext.element.iter(qn("w15:commentEx")):
            by_para[e.get(qn("w15:paraId"))] = e
    info: dict[str, dict[str, Any]] = {}
    para_owner: dict[str, str] = {}
    for c in part.element.findall(qn("w:comment")):
        pids = [p.get(qn("w14:paraId")) for p in c.iter(P) if p.get(qn("w14:paraId"))]
        for pid in pids:
            para_owner[pid] = c.get(W_ID)
        ex = next((by_para[p] for p in reversed(pids) if p in by_para), None)
        info[c.get(W_ID)] = {"paras": pids, "ex": ex}
    for cid, i in info.items():
        ex = i["ex"]
        i["resolved"] = ex is not None and ex.get(qn("w15:done")) in ("1", "true", "on")
        i["reply_to"] = para_owner.get(ex.get(qn("w15:paraIdParent"))) if ex is not None else None
    return info


def comment_anchors(doc: Any) -> dict[str, dict[str, str]]:
    """The text each comment is anchored to, and where."""
    where = Locator(doc)
    out: dict[str, dict[str, str]] = {}
    for s in stories(doc):
        open_ids: list[str] = []
        for p in own_paragraphs(s.root):
            seen_text = False
            for el in p.iter(C_START, C_END, C_REF, T):
                if el.tag == C_START:
                    open_ids.append(el.get(W_ID))
                    out.setdefault(el.get(W_ID), {"text": "", "where": where(el)})
                elif el.tag == C_END:
                    if el.get(W_ID) in open_ids:
                        open_ids.remove(el.get(W_ID))
                elif el.tag == C_REF:
                    out.setdefault(el.get(W_ID), {"text": "", "where": where(el)})
                elif not under(el, DEL, p) and not under(el, MOVEFROM, p) and not under(el, TXBX, p):
                    for cid in open_ids:
                        out[cid]["text"] += el.text or ""
                    seen_text = True
            if seen_text or open_ids:
                for cid in open_ids:
                    out[cid]["text"] += "\n"
    for v in out.values():
        v["text"] = v["text"].strip("\n")
    return out


def list_comments(doc: Any) -> list[dict[str, Any]]:
    part = find_part(doc, "comments+xml")
    if part is None:
        return []
    threads, anchors = comment_threads(doc), comment_anchors(doc)
    out = []
    for c in part.element.findall(qn("w:comment")):
        cid = c.get(W_ID)
        entry: dict[str, Any] = {"id": int(cid) if cid and cid.lstrip("-").isdigit() else cid,
                                 "author": c.get(W_AUTHOR), "initials": c.get(qn("w:initials")),
                                 "date": c.get(W_DATE), "text": "\n".join(para_text(p) for p in c.iter(P)).strip(),
                                 "anchored_to": anchors.get(cid, {}).get("text", ""),
                                 "where": anchors.get(cid, {}).get("where")}
        t = threads.get(cid, {})
        if t.get("resolved"):
            entry["resolved"] = True
        if t.get("reply_to") is not None:
            entry["reply_to"] = int(t["reply_to"]) if t["reply_to"].lstrip("-").isdigit() else t["reply_to"]
        out.append(entry)
    return out


def initials_of(author: str) -> str:
    return "".join(w[0] for w in author.split() if w)[:4].upper()


def cmd_comments(args: argparse.Namespace) -> int:
    if args.action == "list":
        doc = open_docx(args.file)
        found = list_comments(doc)
        emit({"file": args.file, "count": len(found), "comments": found})
        return 0
    check_output(args.out, [args.file] + ([args.from_file] if getattr(args, "from_file", None) else []), args.overwrite)
    doc = open_docx(args.file)
    if args.action == "delete":
        return delete_comments(doc, args)
    # add
    if args.from_file:
        if args.at or args.text or args.text_file:
            raise Fail("give either --from, or --at with --text or --text-file, not both")
        wanted = load_json(args.from_file)
        if isinstance(wanted, dict):
            wanted = [wanted]
        if not isinstance(wanted, list) or not wanted or not all(isinstance(w, dict) for w in wanted):
            raise Fail(f"{args.from_file} should hold a JSON list like [{{\"at\": \"words in the text\", \"text\": \"the comment\"}}]")
    else:
        if not args.at or not (args.text or args.text_file):
            raise Fail("add needs --at (the words to comment on) and --text or --text-file (the comment), or --from a JSON file")
        body = args.text if args.text else read_text(args.text_file, "the comment file").strip()
        wanted = [{"at": args.at, "text": body, "occurrence": args.occurrence}]
    paras = own_paragraphs(doc.element.body)
    plan, problems = [], []
    for n, w in enumerate(wanted, 1):
        at, text = w.get("at"), w.get("text")
        occ = w.get("occurrence", 1)
        if not isinstance(at, str) or not at or "\0" in at or "\n" in at or "\t" in at:
            problems.append({"comment": n, "problem": "at must be words from one paragraph of the text (no tabs or line breaks)"})
            continue
        if not isinstance(text, str) or not text.strip():
            problems.append({"comment": n, "problem": "text (the comment itself) is missing"})
            continue
        if isinstance(occ, bool) or not isinstance(occ, int) or occ < 1:
            problems.append({"comment": n, "problem": f"occurrence must be 1 or more, not {occ!r}"})
            continue
        hits = [(p, a, b) for p in paras for a, b in find_matches(Para(p), at, True, False)]
        if len(hits) < occ:
            hint = near_miss(doc, at)
            problems.append({"comment": n, "at": at, "problem": f"found {len(hits)} times, so there's no occurrence {occ}" if hits else "not in the body of the document",
                             **({"did_you_mean": hint} if hint and not hits else {})})
            continue
        author = w.get("author") if isinstance(w.get("author"), str) and w.get("author") else args.author
        plan.append({"n": n, "at": at, "text": text, "occurrence": occ, "matches": len(hits), "author": author})
    if problems:
        emit({"file": args.file, "out": None, "written": False, "problems": problems})
        return 1
    from docx.text.run import Run

    added = []
    for item in plan:
        hits = [(p, a, b) for p in own_paragraphs(doc.element.body) for a, b in find_matches(Para(p), item["at"], True, False)]
        p, a, b = hits[item["occurrence"] - 1]
        runs = isolate(Para(p), a, b)
        comment = doc.add_comment([Run(runs[0], None), Run(runs[-1], None)], text=item["text"].strip(),
                                  author=item["author"], initials=initials_of(item["author"]))
        added.append({"id": comment.comment_id, "at": item["at"], "occurrence": item["occurrence"],
                      "matches": item["matches"], "author": item["author"]})
    save_docx(doc, args.out)
    back = {c["id"]: c for c in list_comments(open_docx(args.out))}
    wrong = [a for a in added if back.get(a["id"], {}).get("anchored_to") != a["at"]]
    result = {"file": args.file, "out": args.out, "written": True, "added": added, "comments_now": len(back)}
    if wrong:
        result["problems"] = [{"problem": "these comments don't read back anchored to their words", "ids": [a["id"] for a in wrong]}]
        emit(result)
        return 1
    emit(result)
    return 0


def delete_comments(doc: Any, args: argparse.Namespace) -> int:
    part = find_part(doc, "comments+xml")
    existing = {c.get(W_ID): c for c in part.element.findall(qn("w:comment"))} if part is not None else {}
    if args.all:
        ids = set(existing)
    else:
        ids = parse_ids(args.ids)
        if ids is None:
            raise Fail("delete needs --ids (like 0,3) or --all")
        unknown = ids - set(existing)
        if unknown:
            raise Fail(f"no comment with id {', '.join(sorted(unknown, key=int))}; comments list shows the ids")
    threads = comment_threads(doc)
    grew = True
    while grew:  # a reply goes with the comment it answers, as in Word
        more = {cid for cid, t in threads.items() if t.get("reply_to") in ids} - ids
        grew = bool(more)
        ids |= more
    paras = {pid for cid in ids for pid in threads.get(cid, {}).get("paras", [])}
    for cid in ids:
        if cid in existing:
            part.element.remove(existing[cid])
    for s in stories(doc):
        for el in list(s.root.iter(C_START, C_END, C_REF)):
            if el.get(W_ID) not in ids:
                continue
            holder = el.getparent()
            holder.remove(el)
            if el.tag == C_REF and holder.tag == R and all(c.tag == RPR for c in holder):
                holder.getparent().remove(holder)
    durable = set()
    ids_part = find_part(doc, "commentsIds+xml")
    if ids_part is not None:
        for e in list(ids_part.element.iter(qn("w16cid:commentId"))):
            if e.get(qn("w16cid:paraId")) in paras:
                durable.add(e.get(qn("w16cid:durableId")))
                e.getparent().remove(e)
    ext = find_part(doc, "commentsExtended+xml")
    if ext is not None:
        for e in list(ext.element.iter(qn("w15:commentEx"))):
            if e.get(qn("w15:paraId")) in paras:
                e.getparent().remove(e)
    cex = find_part(doc, "commentsExtensible+xml")
    if cex is not None:
        for e in list(cex.element.iter(qn("w16cex:commentExtensible"))):
            if e.get(qn("w16cex:durableId")) in durable:
                e.getparent().remove(e)
    save_docx(doc, args.out)
    left = list_comments(open_docx(args.out))
    emit({"file": args.file, "out": args.out, "written": True,
          "deleted": sorted((int(i) if i.lstrip("-").isdigit() else i for i in ids), key=str), "comments_left": len(left)})
    return 0


# ---------------------------------------------------------------- command line


def build_parser() -> argparse.ArgumentParser:
    p = Parser(prog="docx_tool.py", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="command", metavar="COMMAND")
    out = argparse.ArgumentParser(add_help=False)
    out.add_argument("-o", "--out", required=True, help="the document to write (.docx, or .docm/.dotx/.dotm to match)")
    out.add_argument("--overwrite", action="store_true", help="allow the output to replace the input")

    def add(parent: Any, name: str, func: Callable[[argparse.Namespace], Any], help_text: str,
            parents: list[argparse.ArgumentParser], example: str) -> argparse.ArgumentParser:
        sp = parent.add_parser(name, parents=parents, help=help_text, description=help_text,
                               epilog=f"example:\n  {example}", formatter_class=argparse.RawDescriptionHelpFormatter)
        sp.set_defaults(func=func)
        return sp

    sp = add(sub, "info", cmd_info, "Paragraph, table, word and picture counts, headings, styles, page setup, fields, "
             "content controls, {{tokens}}, comments, tracked changes, protection and metadata.", [],
             "python docx_tool.py info report.docx")
    sp.add_argument("file")

    sp = add(sub, "text", cmd_text, "The text in order, paragraphs (with their style) and tables (as rows of cells), "
             "then headers, footers, footnotes, endnotes and text boxes, as JSON (or into a text file with --out).", [],
             "python docx_tool.py text report.docx --out docx-work/report.txt")
    sp.add_argument("file")
    sp.add_argument("--out", help="write plain text here (UTF-8) and print only a summary")
    sp.add_argument("--overwrite", action="store_true", help="allow --out to replace the input")

    sp = add(sub, "images", cmd_images, "Save the pictures stored in the document into a folder (never over existing files).",
             [], "python docx_tool.py images report.docx --out-dir docx-work/pictures")
    sp.add_argument("file")
    sp.add_argument("--out-dir", required=True, help="the folder to save them in")

    sp = add(sub, "check", cmd_check, "Health check of the package: the zip, broken XML, content types, links between "
             "parts, pictures, and styles, lists and comments the text refers to. Exit 1 when it finds errors. Not "
             "validation against Word's schema.", [], "python docx_tool.py check report.docx")
    sp.add_argument("file")

    sp = add(sub, "edit", cmd_edit, "Apply a list of changes from a JSON file: replace text (across runs, keeping its "
             "formatting), insert, delete or restyle paragraphs, set table cells. With --track they're recorded as "
             "tracked changes. On any problem nothing is written.", [out],
             "python docx_tool.py edit contract.docx --ops docx-work/ops.json -o contract-edited.docx --track --author \"Sam Lee\"")
    sp.add_argument("file")
    sp.add_argument("--ops", required=True, help="JSON list of operations (see the skill, or below)")
    sp.add_argument("--track", action="store_true", help="record the changes as tracked changes")
    sp.add_argument("--author", default="Reviewer", help="name tracked changes carry (default Reviewer)")
    sp.epilog += ('\n\noperations:\n'
                  '  {"op": "replace", "find": "Acme Ltd", "replace": "Beta GmbH", "expect": 3, "match_case": true, "whole_word": false}\n'
                  '  {"op": "insert", "after": 4, "text": "New paragraph", "style": "Normal"}   (or "before"; no style copies the neighbour\'s look)\n'
                  '  {"op": "delete", "paragraph": 7}\n'
                  '  {"op": "style", "paragraph": 2, "style": "Heading 2"}\n'
                  '  {"op": "cell", "table": 1, "row": 2, "col": 3, "text": "1,250"}\n'
                  'Numbers are as text lists them, counted before any change. replace works in the body, tables,\n'
                  'headers, footers, footnotes and text boxes; a match can\'t run across a tab, line break, picture or field.')

    sp = add(sub, "fill", cmd_fill, "Fill a template from a JSON object of values: {{token}} placeholders (also split "
             "across runs), content controls (by tag or title) and mail-merge fields (by name). Anything left without "
             "a value stops it, unless --partial.", [out],
             "python docx_tool.py fill letter-template.docx docx-work/values.json -o letter.docx")
    sp.add_argument("file")
    sp.add_argument("values", help="JSON object: {\"name\": \"value\"}; checkboxes take true or false")
    sp.add_argument("--partial", action="store_true", help="write the file even when some have no value, leaving them as they are")

    sp = add(sub, "revisions", lambda a: None, "Tracked changes: list them, or accept or reject them (all, by id, or by author).",
             [], "python docx_tool.py revisions accept draft.docx -o clean.docx")
    rsub = sp.add_subparsers(dest="action", metavar="ACTION")
    rp = add(rsub, "list", cmd_revisions, "Every tracked change: id, kind, author, date, its text and where it is.", [],
             "python docx_tool.py revisions list draft.docx")
    rp.add_argument("file")
    for action in ("accept", "reject"):
        rp = add(rsub, action, cmd_revisions, f"{action.capitalize()} tracked changes and write a new file. What it "
                 "can't resolve stops it, unless --partial.", [out],
                 f"python docx_tool.py revisions {action} draft.docx -o draft-{action}ed.docx --author \"Ana Ruiz\"")
        rp.add_argument("file")
        rp.add_argument("--ids", help="only these changes, like 3,7,12 (from revisions list)")
        rp.add_argument("--author", help="only this author's changes")
        rp.add_argument("--partial", action="store_true", help="write the file even if some chosen changes are left")

    sp = add(sub, "comments", lambda a: None, "Comments: list them, add them anchored to words in the text, or delete them.",
             [], "python docx_tool.py comments list draft.docx")
    csub = sp.add_subparsers(dest="action", metavar="ACTION")
    cp = add(csub, "list", cmd_comments, "Every comment: id, author, date, text, the words it's anchored to, where, "
             "and whether it's resolved or a reply.", [], "python docx_tool.py comments list draft.docx")
    cp.add_argument("file")
    cp = add(csub, "add", cmd_comments, "Add comments anchored to words in the body. On any phrase not found nothing is written.",
             [out], "python docx_tool.py comments add draft.docx --from docx-work/comments.json -o draft-commented.docx --author \"Sam Lee\"")
    cp.add_argument("file")
    cp.add_argument("--at", help="the words to comment on (from one paragraph)")
    cp.add_argument("--text", help="the comment")
    cp.add_argument("--text-file", help="read the comment from this file")
    cp.add_argument("--occurrence", type=positive, default=1, help="which match of --at to use, from 1 (default 1)")
    cp.add_argument("--from", dest="from_file", help='JSON list: [{"at": "...", "text": "...", "occurrence": 1, "author": "..."}]')
    cp.add_argument("--author", default="Reviewer", help="name the comments carry (default Reviewer)")
    cp = add(csub, "delete", cmd_comments, "Delete comments (and their replies) and their marks; the text stays.", [out],
             "python docx_tool.py comments delete draft.docx --ids 0,3 -o draft-clean.docx")
    cp.add_argument("file")
    g = cp.add_mutually_exclusive_group(required=True)
    g.add_argument("--ids", help="comment ids, like 0,3 (from comments list)")
    g.add_argument("--all", action="store_true", help="every comment")
    return p


def positive(text: str) -> int:
    try:
        value = int(text)
    except ValueError:
        raise argparse.ArgumentTypeError(f"must be a whole number, not {text!r}") from None
    if value < 1:
        raise argparse.ArgumentTypeError(f"must be 1 or more, not {text}")
    return value


def main(argv: list[str] | None = None) -> int:
    utf8_output()
    parser = build_parser()
    args = parser.parse_args(argv)
    if not getattr(args, "command", None):
        parser.error("needs a command, such as info")
    if args.command in ("revisions", "comments") and not getattr(args, "action", None):
        parser.error(f"{args.command} needs an action: list, " + ("accept or reject" if args.command == "revisions" else "add or delete"))
    name = f"docx_tool.py {args.command}" + (f" {args.action}" if getattr(args, "action", None) else "")
    return run_job(name, lambda: args.func(args))


if __name__ == "__main__":
    sys.exit(main())
