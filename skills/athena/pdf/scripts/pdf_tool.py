#!/usr/bin/env python3
"""Look inside PDFs and change them: info, text, tables, merge, pick, split, rotate, stamp, encrypt, decrypt,
meta, attach, attachments, images, render, compress.

Packages: pypdf 6 or newer (every command); pdfplumber (text and tables; text falls back to pypdf without it);
cryptography (AES encryption, and opening AES-encrypted files); reportlab (stamp); Pillow (images, render,
compress --jpeg-quality); pypdfium2 (render; Poppler's pdftoppm on PATH works instead).

Pages are numbered from 1 everywhere: "1-3,7,10-" means pages 1 to 3, page 7, and page 10 to the end; leaving out
--pages means every page.
Commands that write a PDF need -o and won't write over one of their inputs unless given --overwrite.
Results are printed on stdout as JSON. Exit codes: 0 done; 2 the command couldn't do its job, and one line on stderr
says why.
"""

from __future__ import annotations

import argparse
import codecs
import csv
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


# ---------------------------------------------------------------- names for files saved from inside a PDF


WINDOWS_DEVICES = re.compile(r"(con|prn|aux|nul|com\d|lpt\d)(\..*)?", re.I)


def safe_name(name: str, fallback: str) -> str:
    """A file name taken from inside a PDF, made safe to save on any system: no folders, no characters Windows
    refuses, not a Windows device name such as CON or NUL.txt."""
    base = os.path.basename(name.replace("\\", "/")).strip()
    base = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", base).strip(" .")
    stem, ext = os.path.splitext(base)
    base = stem[:150] + ext[:20]  # names inside a PDF can be longer than a file system allows
    if WINDOWS_DEVICES.fullmatch(base):
        base = "_" + base
    return base or fallback


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


# ---------------------------------------------------------------- info


def cmd_info(args: argparse.Namespace) -> None:
    password = read_password(args)
    reader = open_pdf(args.file, password)
    pages = []
    for n, page in enumerate(reader.pages, 1):
        try:
            chars = len("".join((page.extract_text() or "").split()))
        except Exception:
            chars = None
        try:
            images = len(page.images)
        except Exception:
            images = None
        box = page.mediabox
        pages.append({
            "page": n,
            "width_pt": round(float(box.width), 2),
            "height_pt": round(float(box.height), 2),
            "rotation": int(page.rotation or 0) % 360,
            "text_chars": chars,
            "images": images,
        })
    no_text = [p["page"] for p in pages if p["text_chars"] == 0]
    scanned = [p["page"] for p in pages if p["text_chars"] == 0 and (p["images"] or 0) > 0]
    meta = {}
    for key, value in (reader.metadata or {}).items():
        meta[str(key).lstrip("/")] = str(value)
    root = reader.trailer["/Root"]
    acro = root.get("/AcroForm")
    acro = acro.get_object() if acro is not None else None
    try:
        fields = reader.get_fields() or {}
    except Exception:
        fields = {}
    result: dict[str, Any] = {
        "file": args.file,
        "pdf_version": str(reader.pdf_header).replace("%PDF-", ""),
        "pages": len(pages),
        "encrypted": bool(reader.is_encrypted),
        "metadata": meta,
        "has_xmp_metadata": "/Metadata" in root,
        "form": {"fields": len([f for f in fields.values() if "/FT" in f]), "xfa": bool(acro is not None and "/XFA" in acro)},
        "attachments": list(reader.attachments.keys()),
        "no_text_pages": no_text,
        "scanned_pages": scanned,
        "page_details": pages,
    }
    if reader.is_encrypted:
        perms = reader.user_access_permissions
        result["permissions"] = {k: v for k, v in perms.to_dict().items()} if perms is not None else None
        result["opened_without_password"] = not password
    if no_text:
        result["note"] = ("pages with no text layer are images (scans or photos), not empty pages: "
                          "render them and read the image, or OCR them")
    emit(result)


# ---------------------------------------------------------------- text and tables


def cmd_text(args: argparse.Namespace) -> None:
    password = read_password(args)
    reader = open_pdf(args.file, password)
    wanted = parse_pages(args.pages, len(reader.pages))
    engine = args.engine
    if engine == "auto":
        try:
            importlib.import_module("pdfplumber")
            engine = "pdfplumber"
        except ImportError:
            engine = "pypdf"
    texts: list[tuple[int, str]] = []
    if engine == "pdfplumber":
        pdfplumber = need("pdfplumber", "pdfplumber", "for --engine pdfplumber")
        with pdfplumber.open(args.file, password=password or None) as pdf:
            for n in wanted:
                page = pdf.pages[n - 1]
                texts.append((n, page.extract_text(layout=args.layout) or ""))
    else:
        for n in wanted:
            mode = "layout" if args.layout else "plain"
            texts.append((n, reader.pages[n - 1].extract_text(extraction_mode=mode) or ""))
    rows = [{"page": n, "chars": len("".join(t.split())), "text": t} for n, t in texts]
    result: dict[str, Any] = {"file": args.file, "engine": engine, "no_text_pages": [r["page"] for r in rows if r["chars"] == 0]}
    if args.out:
        check_output(args.out, [args.file], args.overwrite)
        body = "".join(f"--- page {n} ---\n{t.rstrip()}\n\n" for n, t in texts)
        write_atomic(args.out, lambda fh: fh.write(body.encode("utf-8")))
        result["out"] = args.out
        result["pages"] = [{"page": r["page"], "chars": r["chars"]} for r in rows]
    else:
        result["pages"] = rows
    emit(result)


def cmd_tables(args: argparse.Namespace) -> None:
    pdfplumber = need("pdfplumber", "pdfplumber", "to find tables")
    password = read_password(args)
    count = len(open_pdf(args.file, password).pages)
    wanted = parse_pages(args.pages, count)
    settings = {"vertical_strategy": args.strategy, "horizontal_strategy": args.strategy}
    tables = []
    stem = os.path.splitext(os.path.basename(args.file))[0]
    if args.csv_dir:
        os.makedirs(args.csv_dir, exist_ok=True)
    with pdfplumber.open(args.file, password=password or None) as pdf:
        for n in wanted:
            for i, raw in enumerate(pdf.pages[n - 1].extract_tables(table_settings=settings), 1):
                rows = [["" if cell is None else str(cell) for cell in row] for row in raw]
                entry: dict[str, Any] = {"page": n, "table": i, "rows": rows}
                if args.csv_dir:
                    path = os.path.join(args.csv_dir, f"{stem}_p{n}_t{i}.csv")
                    sheet = io.StringIO()
                    csv.writer(sheet).writerows(rows)
                    # utf-8-sig: Excel on Windows reads accented letters right only with the byte-order mark
                    write_atomic(path, lambda fh, s=sheet.getvalue(): fh.write(s.encode("utf-8-sig")))
                    entry["csv"] = path
                tables.append(entry)
    result: dict[str, Any] = {"file": args.file, "strategy": args.strategy, "tables": tables}
    if not tables:
        result["note"] = ("no tables found: try --strategy text for tables without ruled lines, "
                          "or check the page has a text layer (pdf_tool.py info)")
    emit(result)


# ---------------------------------------------------------------- page operations


def cmd_merge(args: argparse.Namespace) -> None:
    pypdf = need("pypdf", "pypdf")
    check_output(args.out, args.files, args.overwrite)
    password = read_password(args)
    writer = pypdf.PdfWriter()
    inputs = []
    with_fields = 0
    for path in args.files:
        reader = open_pdf(path, password)
        first = len(writer.pages) + 1
        title = os.path.splitext(os.path.basename(path))[0] if args.bookmarks else None
        writer.append(reader, outline_item=title)
        if reader.get_fields():
            with_fields += 1
        inputs.append({"file": path, "pages": len(reader.pages), "first_page": first})
    save(writer, args.out)
    result: dict[str, Any] = {"out": args.out, "pages": len(writer.pages), "inputs": inputs}
    if with_fields > 1:
        result["warning"] = "several inputs have form fields: fields with the same name are filled together from now on"
    emit(result)


def cmd_pick(args: argparse.Namespace) -> None:
    pypdf = need("pypdf", "pypdf")
    check_output(args.out, [args.file], args.overwrite)
    reader = open_pdf(args.file, read_password(args))
    count = len(reader.pages)
    if args.drop:
        dropped = set(parse_pages(args.drop, count))
        order = [n for n in range(1, count + 1) if n not in dropped]
    else:
        order = parse_pages(args.pages, count)
    if not order:
        raise Fail("that leaves no pages")
    writer = pypdf.PdfWriter()
    writer.append(reader, pages=[n - 1 for n in order])
    save(writer, args.out)
    emit({"out": args.out, "pages": len(order), "from_pages": order})


def cmd_split(args: argparse.Namespace) -> None:
    pypdf = need("pypdf", "pypdf")
    reader = open_pdf(args.file, read_password(args))
    count = len(reader.pages)
    groups: list[list[int]] = []
    if args.ranges:
        for part in args.ranges.replace(" ", "").split(","):
            if part:
                groups.append(parse_pages(part, count))
    elif args.every is not None:
        if args.every < 1:
            raise Fail("--every needs a number of pages from 1 up")
        groups = [list(range(s, min(s + args.every, count + 1))) for s in range(1, count + 1, args.every)]
    else:
        groups = [[n] for n in range(1, count + 1)]
    labels = [f"{g[0]}" if len(g) == 1 else f"{g[0]}-{g[-1]}" for g in groups]
    twice = sorted({lab for lab in labels if labels.count(lab) > 1})
    if twice:
        raise Fail(f"--ranges names pages {twice[0]} twice, and the second part would replace the first")
    os.makedirs(args.out_dir, exist_ok=True)
    stem = os.path.splitext(os.path.basename(args.file))[0]
    files = []
    for group, label in zip(groups, labels):
        out = os.path.join(args.out_dir, f"{stem}_p{label}.pdf")
        check_output(out, [args.file], args.overwrite)
        writer = pypdf.PdfWriter()
        writer.append(reader, pages=[n - 1 for n in group])
        save(writer, out)
        files.append({"file": out, "pages": group})
    emit({"file": args.file, "out_dir": args.out_dir, "files": files})


def cmd_rotate(args: argparse.Namespace) -> None:
    pypdf = need("pypdf", "pypdf")
    if args.degrees % 90:
        raise Fail("--degrees must be a multiple of 90 (90, 180, 270, or -90)")
    check_output(args.out, [args.file], args.overwrite)
    reader = open_pdf(args.file, read_password(args))
    writer = pypdf.PdfWriter(clone_from=reader)
    wanted = parse_pages(args.pages, len(writer.pages))
    for n in sorted(set(wanted)):
        writer.pages[n - 1].rotate(args.degrees)
    save(writer, args.out)
    emit({"out": args.out, "rotated_pages": sorted(set(wanted)),
          "rotation_now": {str(n): int(writer.pages[n - 1].rotation) % 360 for n in sorted(set(wanted))}})


# ---------------------------------------------------------------- stamp


def hex_color(value: str) -> tuple[float, float, float]:
    m = re.fullmatch(r"#?([0-9a-fA-F]{6})", value.strip())
    if not m:
        raise Fail(f"colours are written like #808080, not {value!r}")
    h = m.group(1)
    return tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))  # type: ignore[return-value]


def stamp_font(text: str, font_path: str | None) -> str:
    """Register --font if given and make sure it can draw every letter of the text."""
    if not font_path:
        missing = sorted({ch for ch in text if not ch.isspace() and not cp1252_ok(ch)})
        if missing:
            raise Fail("the built-in Helvetica can't draw " + " ".join(missing)
                       + ": pass --font with a TrueType (.ttf) font that has these letters")
        return "Helvetica"
    pdfmetrics = need("reportlab.pdfbase.pdfmetrics", "reportlab")
    ttfonts = need("reportlab.pdfbase.ttfonts", "reportlab")
    try:
        font = ttfonts.TTFont("StampFont", font_path)
    except Exception as e:
        raise Fail(f"can't use the font {font_path}: {e}") from None
    have = font.face.charToGlyph
    missing = sorted({ch for ch in text if not ch.isspace() and ord(ch) not in have})
    if missing:
        raise Fail(f"{os.path.basename(font_path)} has no " + " ".join(missing) + ": pick a font that has them")
    pdfmetrics.registerFont(font)
    return "StampFont"


def make_overlay(width: float, height: float, args: argparse.Namespace, font: str | None) -> Any:
    canvas_mod = need("reportlab.pdfgen.canvas", "reportlab", "to draw stamps")
    pypdf = need("pypdf", "pypdf")
    buf = io.BytesIO()
    c = canvas_mod.Canvas(buf, pagesize=(width, height))
    c.setFillAlpha(args.opacity)
    c.setStrokeAlpha(args.opacity)
    centred = args.x is None and args.y is None
    x = width / 2 if args.x is None else args.x
    y = height / 2 if args.y is None else args.y
    c.translate(x, y)
    c.rotate(args.angle)
    if args.text is not None:
        assert font is not None
        c.setFillColorRGB(*hex_color(args.color))
        c.setFont(font, args.size)
        if centred:
            # centre the line on the page: half its width left, and down by about a third of the size
            c.drawCentredString(0, -args.size / 3, args.text)
        else:
            c.drawString(0, 0, args.text)
    else:
        reader_mod = need("reportlab.lib.utils", "reportlab")
        need("PIL", "pillow", "to read the image")
        img = reader_mod.ImageReader(args.image)
        iw, ih = img.getSize()
        w = args.width if args.width is not None else min(float(iw), width / 3)
        h = w * ih / iw
        dx, dy = (-w / 2, -h / 2) if centred else (0, 0)
        c.drawImage(img, dx, dy, width=w, height=h, mask="auto")
    c.showPage()
    c.save()
    buf.seek(0)
    return pypdf.PdfReader(buf).pages[0]


def as_shown(page: Any, pypdf: Any) -> tuple[float, float, Any]:
    """The page's width and height as a viewer shows it (its crop box, turned by /Rotate), and the transformation
    from those upright coordinates to the page's own. Stamps are drawn upright and then moved onto the page, so a
    scan turned with /Rotate gets its watermark the right way up."""
    box = page.cropbox
    left, bottom, w, h = float(box.left), float(box.bottom), float(box.width), float(box.height)
    rotation = int(page.rotation or 0) % 360
    # (x, y) as shown -> (a*x + c*y + e, b*x + d*y + f) on the page; a viewer turns the page clockwise by /Rotate
    a, b, c, d, e, f = {90: (0, 1, -1, 0, left + w, bottom), 180: (-1, 0, 0, -1, left + w, bottom + h),
                        270: (0, -1, 1, 0, left, bottom + h)}.get(rotation, (1, 0, 0, 1, left, bottom))
    shown = (h, w) if rotation in (90, 270) else (w, h)
    return shown[0], shown[1], pypdf.Transformation((a, b, c, d, e, f))


def cmd_stamp(args: argparse.Namespace) -> None:
    pypdf = need("pypdf", "pypdf")
    sources = [s for s in (args.text, args.image, args.pdf) if s is not None]
    if len(sources) != 1:
        raise Fail("give exactly one of --text, --image or --pdf")
    if not 0 <= args.opacity <= 1:
        raise Fail("--opacity runs from 0 (invisible) to 1 (solid)")
    if args.size <= 0:
        raise Fail("--size is a font size in points, above 0")
    if args.width is not None and args.width <= 0:
        raise Fail("--width is the image's width in points, above 0")
    inputs = [args.file] + [p for p in (args.image, args.pdf) if p]
    for p in inputs[1:]:
        if not os.path.isfile(p):
            raise Fail(f"no such file: {p}")
    check_output(args.out, inputs, args.overwrite)
    reader = open_pdf(args.file, read_password(args))
    writer = pypdf.PdfWriter(clone_from=reader)
    wanted = sorted(set(parse_pages(args.pages, len(writer.pages))))
    font = stamp_font(args.text, args.font) if args.text is not None else None
    stamp_page = open_pdf(args.pdf).pages[0] if args.pdf else None
    overlays: dict[tuple[float, float], Any] = {}
    for n in wanted:
        page = writer.pages[n - 1]
        width, height, to_page = as_shown(page, pypdf)
        if stamp_page is not None:
            tx = pypdf.Transformation().translate(args.x or 0, args.y or 0).transform(to_page)
            page.merge_transformed_page(stamp_page, tx, over=not args.under)
            continue
        size = (width, height)
        if size not in overlays:
            overlays[size] = make_overlay(width, height, args, font)
        page.merge_transformed_page(overlays[size], to_page, over=not args.under)
    save(writer, args.out)
    result: dict[str, Any] = {"out": args.out, "stamped_pages": wanted, "under": bool(args.under)}
    if args.text is not None:
        result["note"] = "the stamp is real text: it shows up in copied and extracted text"
    emit(result)


# ---------------------------------------------------------------- passwords


PERMISSIONS = {
    "print": "print",
    "print-high": "print_to_representation",
    "modify": "modify",
    "copy": "extract",
    "annotate": "add_or_modify",
    "fill-forms": "fill_form_fields",
    "accessibility": "extract_text_and_graphics",
    "assemble": "assemble_doc",
}


def cmd_encrypt(args: argparse.Namespace) -> None:
    pypdf = need("pypdf", "pypdf")
    need("cryptography", "cryptography", "for AES-256 encryption")
    user = read_password(args, "user_password")
    owner = read_password(args, "owner_password")
    if not user and not owner:
        raise Fail("give --user-password (needed to open the file) and/or --owner-password (needed to lift restrictions)")
    check_output(args.out, [args.file], args.overwrite)
    reader = open_pdf(args.file, read_password(args))
    writer = pypdf.PdfWriter(clone_from=reader)
    perms_cls = pypdf.constants.UserAccessPermissions
    if args.allow is None:
        perms = perms_cls.all()
        allowed = sorted(PERMISSIONS)
    else:
        allowed = [a.strip() for a in args.allow.split(",") if a.strip()]
        unknown = [a for a in allowed if a not in PERMISSIONS]
        if unknown:
            raise Fail(f"unknown permission {unknown[0]!r}: choose from {', '.join(sorted(PERMISSIONS))}")
        perms = perms_cls.from_dict({PERMISSIONS[a]: True for a in allowed})
    writer.encrypt(user_password=user or "", owner_password=owner or user, permissions_flag=perms, algorithm="AES-256")
    save(writer, args.out)
    NOTES.pop("unprotected_copy", None)
    result: dict[str, Any] = {
        "out": args.out,
        "algorithm": "AES-256",
        "needs_password_to_open": bool(user),
        "allowed": allowed,
        "note": "restrictions are requests that honest viewers follow; only the open (user) password keeps people out",
    }
    if args.allow is not None and (not owner or owner == user):
        result["warning"] = "with no separate owner password, anyone who can open the file can lift the restrictions"
    emit(result)


def cmd_decrypt(args: argparse.Namespace) -> None:
    pypdf = need("pypdf", "pypdf")
    check_output(args.out, [args.file], args.overwrite)
    password = read_password(args)
    reader = open_pdf(args.file, password)
    if not reader.is_encrypted:
        raise Fail(f"{args.file} isn't encrypted")
    if not password and not args.lift_restrictions:
        raise Fail("this file opens without a password; its author only restricted what viewers may do (printing, "
                   "copying...). Lift that only for a file the user has the right to change: then add --lift-restrictions")
    writer = pypdf.PdfWriter(clone_from=reader)
    save(writer, args.out)
    NOTES.pop("unprotected_copy", None)
    emit({"out": args.out, "encrypted": False, "pages": len(writer.pages)})


# ---------------------------------------------------------------- metadata and attachments


def cmd_meta(args: argparse.Namespace) -> None:
    pypdf = need("pypdf", "pypdf")
    changes = {k: v for k, v in (("/Title", args.title), ("/Author", args.author), ("/Subject", args.subject),
                                 ("/Keywords", args.keywords)) if v is not None}
    if not changes and not args.clear:
        raise Fail("nothing to change: give --title, --author, --subject, --keywords and/or --clear")
    check_output(args.out, [args.file], args.overwrite)
    reader = open_pdf(args.file, read_password(args))
    writer = pypdf.PdfWriter(clone_from=reader)
    removed_xmp = False
    if args.clear:
        writer.metadata = None
        if "/Metadata" in writer.root_object:
            del writer.root_object["/Metadata"]
            removed_xmp = True
    if changes:
        writer.add_metadata(changes)
    save(writer, args.out)
    after = open_pdf(args.out, None)
    result: dict[str, Any] = {"out": args.out, "metadata": {str(k).lstrip("/"): str(v) for k, v in (after.metadata or {}).items()}}
    if args.clear:
        result["removed_xmp"] = removed_xmp
    elif "/Metadata" in writer.root_object:
        result["note"] = "this file also has XMP metadata, which some viewers show instead; --clear removes it"
    emit(result)


def cmd_attach(args: argparse.Namespace) -> None:
    pypdf = need("pypdf", "pypdf")
    for path in args.add:
        if not os.path.isfile(path):
            raise Fail(f"no such file: {path}")
    check_output(args.out, [args.file] + args.add, args.overwrite)
    reader = open_pdf(args.file, read_password(args))
    writer = pypdf.PdfWriter(clone_from=reader)
    for path in args.add:
        with open(path, "rb") as fh:
            writer.add_attachment(os.path.basename(path), fh.read())
    save(writer, args.out)
    emit({"out": args.out, "attachments": list(open_pdf(args.out).attachments.keys())})


def cmd_attachments(args: argparse.Namespace) -> None:
    reader = open_pdf(args.file, read_password(args))
    found = reader.attachments
    result: dict[str, Any] = {"file": args.file, "attachments": [{"name": k, "copies": len(v)} for k, v in found.items()]}
    if args.out_dir:
        os.makedirs(args.out_dir, exist_ok=True)
        # The names come from the PDF, so they never replace a file: one that exists already (the PDF itself,
        # say) or another attachment's gets a _2, _3... name instead.
        saved, taken = [], set()
        for i, (name, blobs) in enumerate(found.items(), 1):
            for data in blobs:
                path = free_path(args.out_dir, safe_name(name, f"attachment{i}"), taken)
                write_atomic(path, lambda fh, d=data: fh.write(d))
                saved.append({"name": name, "file": path})
        result["saved"] = saved
    emit(result)


# ---------------------------------------------------------------- images


def cmd_images(args: argparse.Namespace) -> None:
    need("PIL", "pillow", "to decode images")
    reader = open_pdf(args.file, read_password(args))
    wanted = parse_pages(args.pages, len(reader.pages))
    os.makedirs(args.out_dir, exist_ok=True)
    saved, skipped = [], []
    for n in wanted:
        try:
            images = list(reader.pages[n - 1].images)
        except Exception as e:
            skipped.append({"page": n, "reason": str(e)})
            continue
        for k, img in enumerate(images, 1):
            ext = os.path.splitext(img.name)[1].lower()
            if ext not in (".png", ".jpg", ".jpeg", ".jp2", ".tif", ".tiff", ".bmp", ".gif"):
                ext = ".png"
            path = os.path.join(args.out_dir, f"p{n}_{k}{ext}")
            try:
                write_atomic(path, lambda fh, d=img.data: fh.write(d))
                width, height = img.image.size if img.image is not None else (None, None)
            except Exception as e:
                skipped.append({"page": n, "image": k, "reason": str(e)})
                continue
            saved.append({"page": n, "file": path, "width_px": width, "height_px": height})
    emit({"file": args.file, "images": saved, "skipped": skipped})


def cmd_render(args: argparse.Namespace) -> None:
    if args.dpi < 1:
        raise Fail("--dpi is a number of pixels per inch, from 1 up (150 to look at a page, 300 for OCR)")
    password = read_password(args)
    reader = open_pdf(args.file, password)
    wanted = parse_pages(args.pages, len(reader.pages))
    stem = os.path.splitext(os.path.basename(args.file))[0]
    os.makedirs(args.out_dir, exist_ok=True)
    renderer, files = "", []
    for n, renderer, image in render_pages(args.file, wanted, args.dpi, password):
        out = os.path.join(args.out_dir, f"{stem}_p{n}.png")
        write_atomic(out, lambda fh, im=image: im.save(fh, format="PNG"))
        files.append({"page": n, "file": out, "width_px": image.width, "height_px": image.height})
    emit({"file": args.file, "renderer": renderer, "dpi": args.dpi,
          "pixels_per_point": round(args.dpi / 72, 4), "files": files})


# ---------------------------------------------------------------- compress


def cmd_compress(args: argparse.Namespace) -> None:
    pypdf = need("pypdf", "pypdf")
    check_output(args.out, [args.file], args.overwrite)
    reader = open_pdf(args.file, read_password(args))
    writer = pypdf.PdfWriter(clone_from=reader)
    recompressed, kept = 0, 0
    if args.jpeg_quality is not None:
        if not 1 <= args.jpeg_quality <= 95:
            raise Fail("--jpeg-quality runs from 1 to 95")
        need("PIL", "pillow", "to recompress images")
        done: set[int] = set()
        for page in writer.pages:
            for img in page.images:
                ref = img.indirect_reference
                if ref is not None:
                    if ref.idnum in done:
                        continue  # a picture used on several pages is one object: re-save it once
                    done.add(ref.idnum)
                try:
                    if img.image is None or img.image.mode not in ("RGB", "L"):
                        kept += 1  # transparency, palettes and black-and-white scans get worse as JPEG
                        continue
                    jpeg = io.BytesIO()
                    img.image.save(jpeg, format="JPEG", quality=args.jpeg_quality)
                    # the stream's stored (still encoded) bytes; pypdf keeps them as _data and has no public name
                    now = len(getattr(ref.get_object(), "_data", b"") or b"") if ref is not None else 0
                    if now and jpeg.tell() >= now:
                        kept += 1  # already smaller than this quality makes it
                        continue
                    img.replace(img.image, quality=args.jpeg_quality)
                    recompressed += 1
                except Exception:
                    kept += 1
    for page in writer.pages:
        page.compress_content_streams()
    writer.compress_identical_objects()  # drops duplicate and unreferenced objects
    save(writer, args.out)
    before, after = os.path.getsize(args.file), os.path.getsize(args.out)
    result: dict[str, Any] = {"out": args.out, "bytes_before": before, "bytes_after": after,
                              "saved_percent": round(100 * (before - after) / before, 1) if before else 0}
    if args.jpeg_quality is not None:
        result["images_recompressed"] = recompressed
        result["images_left_alone"] = kept
    if after >= before:
        result["note"] = "no smaller: most of this file is probably images; see references/archival-and-security.md"
    emit(result)


# ---------------------------------------------------------------- command line


def build_parser() -> argparse.ArgumentParser:
    p = Parser(prog="pdf_tool.py", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="command", metavar="COMMAND")

    pw = argparse.ArgumentParser(add_help=False)
    pw.add_argument("--password", help="password for an encrypted input")
    pw.add_argument("--password-file", help="read the input's password from the first line of this file")
    out = argparse.ArgumentParser(add_help=False)
    out.add_argument("-o", "--out", required=True, help="the PDF to write")
    out.add_argument("--overwrite", action="store_true", help="allow the output to replace an input file")

    def add(name: str, func: Callable[[argparse.Namespace], None], help_text: str, parents: list[argparse.ArgumentParser], example: str) -> argparse.ArgumentParser:
        sp = sub.add_parser(name, parents=parents, help=help_text, description=help_text,
                            epilog=f"example:\n  {example}", formatter_class=argparse.RawDescriptionHelpFormatter)
        sp.set_defaults(func=func)
        return sp

    sp = add("info", cmd_info, "Pages, sizes, rotation, encryption, metadata, form fields, attachments, and which pages have no text layer.",
             [pw], "python pdf_tool.py info report.pdf")
    sp.add_argument("file")

    sp = add("text", cmd_text, "Text of each page, as JSON (or into a text file with --out).", [pw],
             "python pdf_tool.py text report.pdf --pages 2-4 --out report.txt")
    sp.add_argument("file")
    sp.add_argument("--pages", help="pages to read, like 1-3,7 (default: all)")
    sp.add_argument("--engine", choices=["auto", "pdfplumber", "pypdf"], default="auto",
                    help="pdfplumber keeps spacing better; pypdf is faster (default: pdfplumber if installed)")
    sp.add_argument("--layout", action="store_true", help="keep the page's columns and indents with spaces")
    sp.add_argument("--out", help="write the text here (UTF-8, a '--- page N ---' line before each page) and print only a summary")
    sp.add_argument("--overwrite", action="store_true", help="allow --out to replace the input")

    sp = add("tables", cmd_tables, "Tables found on the pages, as rows of cells (pdfplumber).", [pw],
             "python pdf_tool.py tables report.pdf --pages 3 --csv-dir tables")
    sp.add_argument("file")
    sp.add_argument("--pages", help="pages to search, like 1-3,7 (default: all)")
    sp.add_argument("--strategy", choices=["lines", "lines_strict", "text"], default="lines",
                    help="'lines' follows ruled lines; 'text' lines up words for tables without lines")
    sp.add_argument("--csv-dir", help="also save each table as a CSV file in this folder")

    sp = add("merge", cmd_merge, "Join PDFs into one, in the order given.", [pw, out],
             "python pdf_tool.py merge cover.pdf report.pdf appendix.pdf -o full.pdf --bookmarks")
    sp.add_argument("files", nargs="+")
    sp.add_argument("--bookmarks", action="store_true", help="add a bookmark at the start of each file, named after it")

    sp = add("pick", cmd_pick, "A new PDF of chosen pages, in the order given (repeats allowed), or all but some.", [pw, out],
             "python pdf_tool.py pick report.pdf --pages 3,1-2 -o reordered.pdf")
    sp.add_argument("file")
    group = sp.add_mutually_exclusive_group(required=True)
    group.add_argument("--pages", help="pages to keep, in order, like 3,1-2 or 10-1 for reversed")
    group.add_argument("--drop", help="pages to leave out, like 2,5-6")

    sp = add("split", cmd_split, "Split into several PDFs: one per page (default), per range, or every N pages.", [pw],
             "python pdf_tool.py split book.pdf --ranges 1-10,11-20,21- --out-dir parts")
    sp.add_argument("file")
    sp.add_argument("--out-dir", required=True, help="folder for the parts (named <name>_p<pages>.pdf)")
    g = sp.add_mutually_exclusive_group()
    g.add_argument("--ranges", help="one file per range, like 1-3,4-9,10-")
    g.add_argument("--every", type=int, help="one file per N pages")
    sp.add_argument("--overwrite", action="store_true", help="allow a part to replace the input")

    sp = add("rotate", cmd_rotate, "Turn pages by a multiple of 90 degrees (clockwise; negative turns back).", [pw, out],
             "python pdf_tool.py rotate scan.pdf --degrees 90 --pages 2,4 -o upright.pdf")
    sp.add_argument("file")
    sp.add_argument("--degrees", type=int, required=True)
    sp.add_argument("--pages", help="pages to turn (default: all)")

    sp = add("stamp", cmd_stamp, "Put text, an image or another PDF's first page on pages: watermarks, labels, letterheads, signatures as images.",
             [pw, out], 'python pdf_tool.py stamp report.pdf --text DRAFT --size 72 --angle 45 --opacity 0.25 -o draft.pdf')
    sp.add_argument("file")
    sp.add_argument("--text", help="text to draw")
    sp.add_argument("--image", help="PNG or JPEG to place")
    sp.add_argument("--pdf", help="a PDF whose first page goes on each page (letterhead, ready-made watermark)")
    sp.add_argument("--pages", help="pages to stamp (default: all)")
    sp.add_argument("--x", type=float, help="points from the left edge of the page, as a viewer shows it, to the stamp's lower-left corner (default: centred)")
    sp.add_argument("--y", type=float, help="points from the bottom edge of the page, as a viewer shows it, to the stamp's lower-left corner (default: centred)")
    sp.add_argument("--size", type=float, default=24, help="font size in points (default 24)")
    sp.add_argument("--color", default="#808080", help="text colour like #cc0000 (default #808080)")
    sp.add_argument("--opacity", type=float, default=1.0, help="0 to 1 (default 1)")
    sp.add_argument("--angle", type=float, default=0, help="degrees anticlockwise (default 0)")
    sp.add_argument("--font", help="a .ttf font, for letters the built-in Helvetica doesn't have")
    sp.add_argument("--width", type=float, help="image width in points; height keeps the proportions")
    sp.add_argument("--under", action="store_true", help="put the stamp under the page's content instead of over it")

    sp = add("encrypt", cmd_encrypt, "Password-protect a PDF with AES-256.", [pw, out],
             "python pdf_tool.py encrypt report.pdf --user-password-file pw.txt -o locked.pdf")
    sp.add_argument("file")
    sp.add_argument("--user-password", help="password needed to open the file")
    sp.add_argument("--user-password-file", help="read the open password from the first line of this file")
    sp.add_argument("--owner-password", help="password needed to lift restrictions (default: the user password)")
    sp.add_argument("--owner-password-file", help="read the owner password from the first line of this file")
    sp.add_argument("--allow", help="what viewers may do, comma-separated: " + ", ".join(sorted(PERMISSIONS)) + " (default: everything)")

    sp = add("decrypt", cmd_decrypt, "Save an unlocked copy of a PDF whose password you have.", [pw, out],
             "python pdf_tool.py decrypt locked.pdf --password-file pw.txt -o open.pdf")
    sp.add_argument("file")
    sp.add_argument("--lift-restrictions", action="store_true",
                    help="for a file that opens without a password but restricts printing or copying: the user confirmed they may change it")

    sp = add("meta", cmd_meta, "Set or clear the title, author, subject and keywords.", [pw, out],
             'python pdf_tool.py meta report.pdf --title "Q3 report" --author "Finance team" -o out.pdf')
    sp.add_argument("file")
    sp.add_argument("--title")
    sp.add_argument("--author")
    sp.add_argument("--subject")
    sp.add_argument("--keywords")
    sp.add_argument("--clear", action="store_true", help="remove all existing metadata first, XMP included")

    sp = add("attach", cmd_attach, "Embed files in a PDF (they travel inside it).", [pw, out],
             "python pdf_tool.py attach invoice.pdf --add data.csv -o invoice-with-data.pdf")
    sp.add_argument("file")
    sp.add_argument("--add", nargs="+", required=True, help="files to embed")

    sp = add("attachments", cmd_attachments, "List the files embedded in a PDF, and save them with --out-dir.", [pw],
             "python pdf_tool.py attachments invoice.pdf --out-dir attached")
    sp.add_argument("file")
    sp.add_argument("--out-dir", help="save the embedded files here")

    sp = add("images", cmd_images, "Save the pictures embedded in pages, at their own resolution.", [pw],
             "python pdf_tool.py images brochure.pdf --pages 1-2 --out-dir pictures")
    sp.add_argument("file")
    sp.add_argument("--out-dir", required=True)
    sp.add_argument("--pages", help="pages to take images from (default: all)")

    sp = add("render", cmd_render, "Draw pages as PNG images, to look at them or to OCR them.", [pw],
             "python pdf_tool.py render form.pdf --pages 1 --dpi 100 --out-dir looks")
    sp.add_argument("file")
    sp.add_argument("--out-dir", required=True, help="folder for <name>_p<N>.png")
    sp.add_argument("--pages", help="pages to draw (default: all)")
    sp.add_argument("--dpi", type=int, default=150, help="pixels per inch (default 150; 300 for OCR)")

    sp = add("compress", cmd_compress, "Make a PDF smaller without changing how it looks (or with --jpeg-quality, re-save photos as JPEG).",
             [pw, out], "python pdf_tool.py compress big.pdf -o smaller.pdf --jpeg-quality 75")
    sp.add_argument("file")
    sp.add_argument("--jpeg-quality", type=int, help="1 to 95: re-save colour and grey photos as JPEG at this quality (lossy)")
    return p


def main(argv: list[str] | None = None) -> int:
    utf8_output()
    parser = build_parser()
    args = parser.parse_args(argv)
    if not getattr(args, "func", None):
        parser.error("needs a command, such as info")
    return run_job(f"pdf_tool.py {args.command}", lambda: args.func(args))


if __name__ == "__main__":
    sys.exit(main())
